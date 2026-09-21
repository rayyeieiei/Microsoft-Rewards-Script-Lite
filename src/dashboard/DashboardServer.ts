import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { URL } from 'url'
import { z } from 'zod'
import { ReadinessSnapshotStore } from './ReadinessSnapshotStore'
import { sanitizeLogMessage } from '../util/Redaction'
import { DashboardSnapshotDto } from './DashboardTypes'
import { ManualActionStore } from '../manual/ManualActionStore'
import { ManualActionRecord, ManualActionMutationPayloadSchema, ConflictError } from '../manual/ManualActionTypes'
import { ObserverCoordinator } from '../runtime/observer/ObserverCoordinator'

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
    manualActionStore?: ManualActionStore
    coordinator?: ObserverCoordinator
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
    private readonly manualActionStore?: ManualActionStore
    private readonly coordinator?: ObserverCoordinator
    private readonly publicDir: string
    private readonly logFn?: (level: 'info' | 'warn' | 'error', message: string) => void

    private server?: http.Server
    private sseClients = new Map<string, SseClient>()
    private csrfSessions = new Map<string, number>()
    private controlRequestTimestamps = new Map<string, number[]>()
    private storeUnsubscribe?: () => void
    private isRunning = false

    constructor(options: DashboardServerOptions) {
        this.config = options.config
        this.store = options.store
        this.manualActionStore = options.manualActionStore
        this.coordinator = options.coordinator
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

        const allowedOrigins = [`http://127.0.0.1:${this.config.port}`, `http://localhost:${this.config.port}`]

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
                    this.log(
                        'error',
                        `[DASHBOARD-PORT] Port ${this.config.port} is already in use. Dashboard disabled on this run.`
                    )
                    this.isRunning = false
                    resolve() // Do not crash cluster, proceed gracefully
                } else {
                    reject(err)
                }
            })

            this.server.listen(this.config.port, this.config.host, () => {
                this.isRunning = true
                this.log(
                    'info',
                    `[DASHBOARD-START] Local technical readiness dashboard listening at http://${this.config.host}:${this.config.port}`
                )
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

        // 4. OPTIONS preflight handling
        if (req.method === 'OPTIONS') {
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token')
            res.writeHead(204)
            res.end()
            return
        }

        const parsedUrl = new URL(req.url || '/', `http://${this.config.host}:${this.config.port}`)
        const pathname = parsedUrl.pathname

        // 5. Route dispatch
        // A. Mutating manual action endpoints (Amendment 10)
        const mutationMatch = pathname.match(/^\/api\/manual-actions\/([0-9a-f-]+)\/(report|dismiss|reopen)$/i)
        if (mutationMatch) {
            if (req.method !== 'POST') {
                res.setHeader('Allow', 'POST')
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('Method Not Allowed')
                return
            }
            this.handleManualActionMutation(req, res, pathname, mutationMatch[1]!, mutationMatch[2]!.toLowerCase())
            return
        }

        // B. Query manual action endpoint (Amendment 7: Read-Only Query Semantics)
        if (pathname === '/api/manual-actions') {
            if (req.method !== 'GET') {
                res.setHeader('Allow', 'GET')
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('Method Not Allowed')
                return
            }
            this.handleManualActionQuery(res, parsedUrl)
            return
        }

        // C. Dedicated CSRF session endpoint (Amendment 9)
        if (pathname === '/api/session') {
            if (req.method !== 'GET') {
                res.setHeader('Allow', 'GET')
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('Method Not Allowed')
                return
            }
            this.handleCsrfSession(res)
            return
        }

        // D. Operational control endpoints (Amendment - Operational Controls)
        const controlMatch = pathname.match(/^\/api\/control(?:\/(recheck|pause|resume))?$/i)
        if (controlMatch) {
            if (req.method !== 'POST') {
                res.setHeader('Allow', 'POST')
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
                res.end('Method Not Allowed')
                return
            }
            const explicitAction = controlMatch[1] ? controlMatch[1].toLowerCase() : undefined
            this.handleControlOperation(req, res, explicitAction)
            return
        }

        // E. Existing GET-only endpoints
        if (req.method !== 'GET') {
            res.setHeader('Allow', 'GET')
            res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('Method Not Allowed')
            return
        }

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

    private handleCsrfSession(res: http.ServerResponse): void {
        const token = crypto.randomBytes(32).toString('hex')
        const expiresAt = Date.now() + 3600 * 1000 // 1 hour
        this.csrfSessions.set(token, expiresAt)

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(
            JSON.stringify({
                csrfToken: token,
                expiresAt: new Date(expiresAt).toISOString()
            })
        )
    }

    private validateCsrfToken(req: http.IncomingMessage, res: http.ServerResponse): boolean {
        const rawHeader = req.headers['x-csrf-token']
        if (typeof rawHeader !== 'string' || !rawHeader.trim()) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'Forbidden: Missing x-csrf-token header' }))
            return false
        }

        const token = rawHeader.trim()
        const tokenBuf = Buffer.from(token)
        const now = Date.now()

        let matchedToken: string | null = null
        for (const [storedToken, expiresAt] of this.csrfSessions.entries()) {
            if (now > expiresAt) {
                this.csrfSessions.delete(storedToken)
                continue
            }
            const storedBuf = Buffer.from(storedToken)
            if (tokenBuf.length === storedBuf.length && crypto.timingSafeEqual(tokenBuf, storedBuf)) {
                matchedToken = storedToken
                break
            }
        }

        if (!matchedToken) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'Forbidden: Invalid or expired CSRF token' }))
            return false
        }

        return true
    }

    private async parseJsonBody(req: http.IncomingMessage, maxBytes = 16384): Promise<unknown> {
        return new Promise((resolve, reject) => {
            let body = ''
            let received = 0
            let rejected = false

            const onData = (chunk: Buffer | string) => {
                if (rejected) return
                received += Buffer.byteLength(chunk)
                if (received > maxBytes) {
                    rejected = true
                    req.removeListener('data', onData)
                    req.resume()
                    reject(new Error('Payload Too Large'))
                    return
                }
                body += chunk.toString()
            }

            req.on('data', onData)
            req.on('end', () => {
                if (rejected) return
                try {
                    resolve(JSON.parse(body || '{}'))
                } catch (err: any) {
                    reject(new Error(`Invalid JSON syntax: ${err.message}`))
                }
            })
            req.on('error', err => {
                if (!rejected) reject(err)
            })
        })
    }

    private handleManualActionQuery(res: http.ServerResponse, parsedUrl: URL): void {
        if (!this.manualActionStore) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ records: [], totalMatching: 0 }))
            return
        }

        const accountRef = parsedUrl.searchParams.get('accountRef') || undefined
        const lifecycleState = (parsedUrl.searchParams.get('lifecycleState') as any) || undefined
        const verificationState = (parsedUrl.searchParams.get('verificationState') as any) || undefined
        const search = parsedUrl.searchParams.get('search') || undefined
        const cursor = parsedUrl.searchParams.get('cursor') || undefined
        const limitRaw = parsedUrl.searchParams.get('limit')
        const limit = limitRaw ? parseInt(limitRaw, 10) : 20

        const result = this.manualActionStore.query({
            accountRef,
            lifecycleState,
            verificationState,
            search,
            cursor,
            limit
        })

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result))
    }

    private async handleManualActionMutation(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        _pathname: string,
        recordId: string,
        action: string
    ): Promise<void> {
        if (!this.validateCsrfToken(req, res)) {
            return
        }

        const contentType = req.headers['content-type'] || ''
        if (!contentType.includes('application/json')) {
            res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'Unsupported Media Type: expected application/json' }))
            return
        }

        if (!this.manualActionStore) {
            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'ManualActionStore is not configured' }))
            return
        }

        let payloadJson: unknown
        try {
            payloadJson = await this.parseJsonBody(req, 16384)
        } catch (err: any) {
            if (err.message === 'Payload Too Large') {
                res.setHeader('Connection', 'close')
                res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'Payload Too Large' }))
                return
            }
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: err.message }))
            return
        }

        const parseResult = ManualActionMutationPayloadSchema.safeParse(payloadJson)
        if (!parseResult.success) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: `Validation error: ${parseResult.error.message}` }))
            return
        }

        const payload = parseResult.data

        try {
            let updatedRecord: ManualActionRecord
            if (action === 'report') {
                updatedRecord = await this.manualActionStore.reportAction(recordId, payload)
            } else if (action === 'dismiss') {
                updatedRecord = await this.manualActionStore.dismissAction(recordId, payload)
            } else {
                updatedRecord = await this.manualActionStore.reopenAction(recordId, payload)
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ success: true, record: updatedRecord }))
        } catch (err: any) {
            if (err instanceof ConflictError) {
                res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: err.message, currentRevision: err.currentRevision }))
            } else if (err.message && err.message.includes('not found')) {
                res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: err.message }))
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'Internal server error' }))
            }
        }
    }

    private async handleControlOperation(
        req: http.IncomingMessage,
        res: http.ServerResponse,
        explicitAction?: string
    ): Promise<void> {
        // 1. Rate Limiting check (max 5 requests per second per IP)
        const clientIp = this.normalizeIp(req.socket.remoteAddress) || '127.0.0.1'
        const now = Date.now()
        const history = this.controlRequestTimestamps.get(clientIp) || []
        const recent = history.filter(ts => now - ts < 1000)
        if (recent.length >= 5) {
            res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(
                JSON.stringify({
                    error: 'Too Many Requests: Permintaan kontrol melebihi batas frekuensi (maks 5 request per detik)'
                })
            )
            return
        }
        recent.push(now)
        this.controlRequestTimestamps.set(clientIp, recent)

        // 2. CSRF Token Validation
        if (!this.validateCsrfToken(req, res)) {
            return
        }

        // 3. Coordinator Availability Check
        if (!this.coordinator) {
            res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ error: 'ObserverCoordinator tidak tersedia atau belum dikonfigurasi' }))
            return
        }

        // 4. Resolve and Validate Action
        let action = explicitAction
        if (!action) {
            const contentType = req.headers['content-type'] || ''
            if (!contentType.includes('application/json')) {
                res.writeHead(415, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'Unsupported Media Type: expected application/json' }))
                return
            }

            let payloadJson: unknown
            try {
                payloadJson = await this.parseJsonBody(req, 4096)
            } catch (err: any) {
                if (err.message === 'Payload Too Large') {
                    res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
                    res.end(JSON.stringify({ error: 'Payload Too Large: Maksimal ukuran body adalah 4KB' }))
                    return
                }
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: `Invalid JSON: ${err.message}` }))
                return
            }

            const ControlPayloadSchema = z
                .object({
                    action: z.enum(['recheck', 'pause', 'resume'])
                })
                .strict()

            const parseResult = ControlPayloadSchema.safeParse(payloadJson)
            if (!parseResult.success) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(
                    JSON.stringify({
                        error: `Validasi gagal: ${parseResult.error.issues.map(i => i.message).join(', ')}`
                    })
                )
                return
            }
            action = parseResult.data.action
        } else {
            // Validate explicit action string
            if (!['recheck', 'pause', 'resume'].includes(action)) {
                res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: `Action '${action}' tidak valid. Pilihan: recheck, pause, resume` }))
                return
            }
        }

        // 5. Execute Action via Coordinator
        if (action === 'recheck') {
            try {
                const result = this.coordinator.triggerCheck('manual')
                // Immediate HTTP 202 Accepted response (Rule 4)
                res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(
                    JSON.stringify({
                        success: true,
                        action: 'recheck',
                        checkId: result.checkId,
                        checkingState: result.checkingState,
                        alreadyRunning: result.alreadyRunning,
                        message: result.alreadyRunning
                            ? 'Pemeriksaan sedang aktif; permintaan digabungkan (coalesced).'
                            : 'Pemeriksaan bukti data lokal telah dimulai.'
                    })
                )
            } catch (err: any) {
                res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: err.message }))
            }
            return
        }

        if (action === 'pause') {
            const status = this.coordinator.pause()
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(
                JSON.stringify({
                    success: true,
                    action: 'pause',
                    monitoring: status,
                    message: status.pendingPause
                        ? 'Menjeda setelah pemeriksaan selesai.'
                        : 'Pemantauan berkala berhasil dijeda.'
                })
            )
            return
        }

        if (action === 'resume') {
            const status = this.coordinator.resume()
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(
                JSON.stringify({
                    success: true,
                    action: 'resume',
                    monitoring: status,
                    message: 'Pemantauan berkala berhasil dilanjutkan.'
                })
            )
            return
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
            Connection: 'keep-alive',
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
