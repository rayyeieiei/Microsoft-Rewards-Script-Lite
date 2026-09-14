import http from 'http'
import fs from 'fs'
import path from 'path'
import { URL } from 'url'
import { ReadinessSnapshotStore } from './ReadinessSnapshotStore'
import { sanitizeLogMessage } from '../util/Redaction'
import { DashboardSnapshotDto } from './DashboardTypes'

export interface LiteDashboardConfig {
    enabled: boolean
    host: '127.0.0.1'
    port: number
    maxSseClients: number
    sseHeartbeatMs: number
}

export interface DashboardServerOptions {
    config: LiteDashboardConfig
    store: ReadinessSnapshotStore
    publicDir?: string
    logFn?: (level: 'info' | 'warn' | 'error', message: string) => void
}

interface SseClient {
    id: string
    res: http.ServerResponse
    heartbeatTimer: NodeJS.Timeout
}

export class DashboardServer {
    private readonly config: LiteDashboardConfig
    private readonly store: ReadinessSnapshotStore
    private readonly publicDir: string
    private readonly logFn?: (level: 'info' | 'warn' | 'error', message: string) => void

    private server?: http.Server
    private sseClients = new Map<string, SseClient>()
    private storeUnsubscribe?: () => void
    private isRunning = false

    constructor(options: DashboardServerOptions) {
        this.config = options.config
        this.store = options.store
        this.logFn = options.logFn

        // Injected publicDir (Amendment 8)
        if (options.publicDir) {
            this.publicDir = path.resolve(options.publicDir)
        } else {
            // Default discovery across development and production
            const candidatePaths = [
                path.join(__dirname, 'public'),
                path.join(__dirname, '../../src/dashboard/public'),
                path.join(process.cwd(), 'src/dashboard/public'),
                path.join(process.cwd(), 'dist/dashboard/public')
            ]
            let resolved = candidatePaths[0]!
            for (const p of candidatePaths) {
                if (fs.existsSync(p)) {
                    resolved = p
                    break
                }
            }
            this.publicDir = path.resolve(resolved)
        }
    }

    private log(level: 'info' | 'warn' | 'error', msg: string): void {
        const sanitized = sanitizeLogMessage(msg)
        if (this.logFn) {
            this.logFn(level, sanitized)
        } else {
            if (level === 'error') console.error(sanitized)
            else if (level === 'warn') console.warn(sanitized)
            else console.log(sanitized)
        }
    }

    private normalizeIp(ip?: string): string {
        if (!ip) return ''
        if (ip === '::1' || ip === '::ffff:127.0.0.1') return '127.0.0.1'
        return ip
    }

    private isLoopbackAddress(ip?: string): boolean {
        const normalized = this.normalizeIp(ip)
        return normalized === '127.0.0.1'
    }

    private applySecurityHeaders(res: http.ServerResponse): void {
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none';"
        )
        res.setHeader('X-Content-Type-Options', 'nosniff')
        res.setHeader('Referrer-Policy', 'no-referrer')
        res.setHeader('Cache-Control', 'no-store')
        res.setHeader('X-Frame-Options', 'DENY')
    }

    private validateHost(req: http.IncomingMessage): boolean {
        const host = req.headers['host'] || ''
        const allowedHosts = [
            'localhost',
            '127.0.0.1',
            `localhost:${this.config.port}`,
            `127.0.0.1:${this.config.port}`
        ]
        return allowedHosts.includes(host.trim().toLowerCase())
    }

    private validateOrigin(req: http.IncomingMessage): { valid: boolean; origin?: string } {
        const originHeader = req.headers['origin']
        if (!originHeader) {
            // No origin header: valid for loopback client navigation
            return { valid: true }
        }

        const allowedOrigins = [
            `http://127.0.0.1:${this.config.port}`,
            `http://localhost:${this.config.port}`
        ]

        if (allowedOrigins.includes(originHeader.trim().toLowerCase())) {
            return { valid: true, origin: originHeader.trim() }
        }

        return { valid: false }
    }

    public getPort(): number {
        const addr = this.server?.address()
        if (addr && typeof addr === 'object') {
            return addr.port
        }
        return this.config.port
    }

    public isServerRunning(): boolean {
        return this.isRunning
    }

    public async start(): Promise<void> {
        if (this.isRunning) return

        this.server = http.createServer((req, res) => {
            this.handleRequest(req, res)
        })

        this.server.requestTimeout = 5000
        this.server.headersTimeout = 6000

        // Reject non-loopback socket connections at the socket level
        this.server.on('connection', socket => {
            if (!this.isLoopbackAddress(socket.remoteAddress)) {
                this.log('warn', `[SECURITY] Rejected non-loopback connection from ${socket.remoteAddress}`)
                socket.destroy()
            }
        })

        // Subscribe to store snapshots for SSE broadcasting
        this.storeUnsubscribe = this.store.subscribe(snapshot => {
            this.broadcastSnapshot(snapshot)
        })

        return new Promise<void>((resolve, reject) => {
            if (!this.server) return resolve()

            this.server.once('error', (err: any) => {
                if (err.code === 'EADDRINUSE') {
                    this.log('error', `[DASHBOARD-PORT] Port ${this.config.port} is already in use. Dashboard disabled on this run.`)
                    this.isRunning = false
                    resolve() // Do not crash cluster, proceed gracefully
                } else {
                    reject(err)
                }
            })

            this.server.listen(this.config.port, this.config.host, () => {
                this.isRunning = true
                this.log('info', `[DASHBOARD-START] Local technical readiness dashboard listening at http://${this.config.host}:${this.config.port}`)
                resolve()
            })
        })
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        this.applySecurityHeaders(res)

        // 1. Loopback validation
        if (!this.isLoopbackAddress(req.socket.remoteAddress)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Forbidden: Non-loopback client')
            return
        }

        // 2. Host validation
        if (!this.validateHost(req)) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Bad Request: Invalid Host header')
            return
        }

        // 3. Origin & Cross-Origin validation
        const originCheck = this.validateOrigin(req)
        if (!originCheck.valid) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Forbidden: Cross-origin request rejected')
            return
        }
        if (originCheck.origin) {
            res.setHeader('Access-Control-Allow-Origin', originCheck.origin)
            res.setHeader('Vary', 'Origin')
        }

        // 4. Method validation (only GET is allowed)
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Method Not Allowed')
            return
        }

        const parsedUrl = new URL(req.url || '/', `http://${this.config.host}:${this.config.port}`)
        const pathname = parsedUrl.pathname

        // 5. Route dispatch
        if (pathname === '/' || pathname === '/index.html') {
            this.serveStaticFile('index.html', 'text/html; charset=utf-8', res)
        } else if (pathname === '/assets/styles.css') {
            this.serveStaticFile('styles.css', 'text/css; charset=utf-8', res)
        } else if (pathname === '/assets/app.js') {
            this.serveStaticFile('app.js', 'application/javascript; charset=utf-8', res)
        } else if (pathname === '/api/status') {
            const snapshot = this.store.getSnapshot()
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(snapshot))
        } else if (pathname === '/api/accounts') {
            const snapshot = this.store.getSnapshot()
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify(snapshot.accounts))
        } else if (pathname.startsWith('/api/accounts/')) {
            const publicRef = pathname.replace('/api/accounts/', '').trim()
            const account = this.store.getAccount(publicRef)
            if (!account) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'Account not found' }))
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify(account))
            }
        } else if (pathname === '/api/events') {
            this.handleSseConnection(req, res)
        } else if (pathname === '/api/diagnostics/export') {
            this.handleDiagnosticsExport(res)
        } else if (pathname === '/health') {
            const snapshot = this.store.getSnapshot()
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ status: 'ok', uptimeSeconds: snapshot.runtime.uptimeSeconds }))
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Not Found')
        }
    }

    private serveStaticFile(filename: string, contentType: string, res: http.ServerResponse): void {
        const safeName = path.basename(filename)
        const targetPath = path.join(this.publicDir, safeName)

        // Strict path traversal and symlink rejection
        if (!targetPath.startsWith(this.publicDir)) {
            res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Forbidden: Path traversal detected')
            return
        }

        if (!fs.existsSync(targetPath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Not Found')
            return
        }

        try {
            const lstat = fs.lstatSync(targetPath)
            if (lstat.isSymbolicLink()) {
                res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('Forbidden: Symbolic link rejected')
                return
            }

            const content = fs.readFileSync(targetPath)
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': content.length
            })
            res.end(content)
        } catch {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Internal Server Error')
        }
    }

    private handleSseConnection(req: http.IncomingMessage, res: http.ServerResponse): void {
        // Enforce max SSE client capacity
        if (this.sseClients.size >= this.config.maxSseClients) {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Service Unavailable: Max SSE client limit reached')
            return
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        })

        const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

        // Send heartbeat comment every configured interval
        const heartbeatTimer = setInterval(() => {
            if (res.writableEnded || res.destroyed) {
                this.removeSseClient(clientId)
                return
            }
            try {
                res.write(': ping\n\n')
            } catch {
                this.removeSseClient(clientId)
            }
        }, this.config.sseHeartbeatMs)

        const client: SseClient = {
            id: clientId,
            res,
            heartbeatTimer
        }
        this.sseClients.set(clientId, client)

        // Send initial snapshot immediately
        const initialSnapshot = this.store.getSnapshot()
        res.write(`event: snapshot\ndata: ${JSON.stringify(initialSnapshot)}\n\n`)

        req.on('close', () => {
            this.removeSseClient(clientId)
        })

        req.on('error', () => {
            this.removeSseClient(clientId)
        })
    }

    private removeSseClient(clientId: string): void {
        const client = this.sseClients.get(clientId)
        if (client) {
            clearInterval(client.heartbeatTimer)
            if (!client.res.writableEnded) {
                try {
                    client.res.end()
                } catch {}
            }
            this.sseClients.delete(clientId)
        }
    }

    private broadcastSnapshot(snapshot: DashboardSnapshotDto): void {
        const serialized = JSON.stringify(snapshot)

        // Size cap check (Amendment 5: max 2MB serialized snapshot)
        if (Buffer.byteLength(serialized, 'utf-8') > 2 * 1024 * 1024) {
            this.log('warn', '[DASHBOARD-SSE] Snapshot size exceeds 2MB limit; skipping broadcast')
            return
        }

        const message = `event: snapshot\ndata: ${serialized}\n\n`

        for (const [clientId, client] of this.sseClients) {
            try {
                // Backpressure check: if buffer is congested, disconnect slow client (Amendment 5)
                if (client.res.writableLength > 65536) {
                    this.log('warn', `[DASHBOARD-SSE] Disconnecting slow client ${clientId}`)
                    this.removeSseClient(clientId)
                    continue
                }

                const canWrite = client.res.write(message)
                if (!canWrite) {
                    this.log('warn', `[DASHBOARD-SSE] Slow client buffer congested for ${clientId}`)
                }
            } catch {
                this.removeSseClient(clientId)
            }
        }
    }

    private handleDiagnosticsExport(res: http.ServerResponse): void {
        const snapshot = this.store.getSnapshot()
        const exportData = {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            runtime: snapshot.runtime,
            summary: snapshot.summary,
            accounts: snapshot.accounts,
            diagnostics: {
                disclaimer: 'Sanitized technical diagnostics only; zero credentials, IPs, or session tokens included',
                activeSseClients: this.sseClients.size,
                maxSseClients: this.config.maxSseClients
            }
        }

        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="lite-diagnostics.json"',
            'Cache-Control': 'no-store'
        })
        res.end(JSON.stringify(exportData, null, 2))
    }

    public async stop(): Promise<void> {
        if (!this.isRunning && !this.server) return

        this.isRunning = false

        if (this.storeUnsubscribe) {
            this.storeUnsubscribe()
            this.storeUnsubscribe = undefined
        }

        // Close and clean up all SSE clients
        for (const [, client] of this.sseClients) {
            clearInterval(client.heartbeatTimer)
            try {
                client.res.end()
            } catch {}
        }
        this.sseClients.clear()

        // Close server with bounded timeout
        return new Promise<void>(resolve => {
            if (!this.server) return resolve()

            const timeoutTimer = setTimeout(() => {
                this.log('warn', '[DASHBOARD-STOP] Server close timed out; forcing socket destruction')
                resolve()
            }, 2000)

            this.server.close(() => {
                clearTimeout(timeoutTimer)
                this.log('info', '[DASHBOARD-STOP] Dashboard server stopped cleanly')
                resolve()
            })
        })
    }
}
