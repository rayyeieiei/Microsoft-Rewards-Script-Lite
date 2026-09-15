import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import cluster from 'cluster'
import { z } from 'zod'
import {
    AccountObservationEnvelope,
    validateAccountObservationEnvelope
} from '../contracts/AccountObservationContract'
import { retryAtomicRename } from '../util/FileUtils'

export interface BridgeImportCursor {
    schemaVersion: 1
    latestSequenceByAccountRef: Record<string, number>
    recentlyProcessedObservationIds: string[]
    updatedAt: string
}

export const BridgeImportCursorSchema = z
    .object({
        schemaVersion: z.literal(1),
        latestSequenceByAccountRef: z.record(z.string(), z.number().int().nonnegative()),
        recentlyProcessedObservationIds: z.array(z.string()),
        updatedAt: z.string().datetime({ offset: true })
    })
    .strict()

export interface BridgeRejectionDiagnostic {
    timestamp: string
    claimedFilename: string
    byteSize: number
    checksumSha256: string
    rejectionReason: string
}

export interface ObservationImporterOptions {
    bridgeDirectory: string
    maximumFileBytes?: number
    maxIncomingFiles?: number
    maxBridgeDirectoryBytes?: number
    processedRetentionHours?: number
    rejectionMetadataRetentionHours?: number
    claimingStaleMs?: number
    allowInWorkerForTesting?: boolean
}

export class ObservationImporter {
    private readonly bridgeDirectory: string
    private readonly incomingDir: string
    private readonly processedDir: string
    private readonly rejectedDir: string
    private readonly diagnosticsDir: string
    private readonly cursorPath: string

    private readonly maximumFileBytes: number
    private readonly maxIncomingFiles: number
    private readonly maxBridgeDirectoryBytes: number
    private readonly processedRetentionHours: number
    private readonly rejectionMetadataRetentionHours: number
    private readonly claimingStaleMs: number

    private cursor: BridgeImportCursor | null = null
    private isScanning = false
    private pollTimer: NodeJS.Timeout | null = null

    constructor(options: ObservationImporterOptions) {
        if (cluster.isWorker && !options.allowInWorkerForTesting) {
            throw new Error('[SECURITY] ObservationImporter must only run in the cluster primary process')
        }

        this.bridgeDirectory = path.resolve(options.bridgeDirectory)
        this.incomingDir = path.join(this.bridgeDirectory, 'incoming')
        this.processedDir = path.join(this.bridgeDirectory, 'processed')
        this.rejectedDir = path.join(this.bridgeDirectory, 'rejected')
        this.diagnosticsDir = path.join(this.bridgeDirectory, 'diagnostics')
        this.cursorPath = path.join(this.bridgeDirectory, 'bridge_cursor.json')

        this.maximumFileBytes = options.maximumFileBytes ?? 512 * 1024 // 512 KB
        this.maxIncomingFiles = options.maxIncomingFiles ?? 1000
        this.maxBridgeDirectoryBytes = options.maxBridgeDirectoryBytes ?? 50 * 1024 * 1024 // 50 MB
        this.processedRetentionHours = options.processedRetentionHours ?? 24
        this.rejectionMetadataRetentionHours = options.rejectionMetadataRetentionHours ?? 72
        this.claimingStaleMs = options.claimingStaleMs ?? 60000 // 60s
    }

    public async init(): Promise<void> {
        await fs.promises.mkdir(this.bridgeDirectory, { recursive: true })
        await fs.promises.mkdir(this.incomingDir, { recursive: true })
        await fs.promises.mkdir(this.processedDir, { recursive: true })
        await fs.promises.mkdir(this.rejectedDir, { recursive: true })
        await fs.promises.mkdir(this.diagnosticsDir, { recursive: true })

        await this.loadOrCreateCursor()
        await this.reclaimStaleClaims()
        await this.cleanupRetention()
    }

    public getCursor(): BridgeImportCursor {
        if (!this.cursor) {
            throw new Error('ObservationImporter is not initialized. Call init() first.')
        }
        return JSON.parse(JSON.stringify(this.cursor))
    }

    private async loadOrCreateCursor(): Promise<void> {
        if (!fs.existsSync(this.cursorPath)) {
            this.cursor = {
                schemaVersion: 1,
                latestSequenceByAccountRef: {},
                recentlyProcessedObservationIds: [],
                updatedAt: new Date().toISOString()
            }
            await this.saveCursor()
            return
        }

        try {
            const raw = await fs.promises.readFile(this.cursorPath, 'utf8')
            const parsed = JSON.parse(raw)
            this.cursor = BridgeImportCursorSchema.parse(parsed)
        } catch (err: any) {
            const corruptedPath = path.join(
                this.bridgeDirectory,
                `bridge_cursor.corrupted.${Date.now()}.json`
            )
            try {
                await fs.promises.rename(this.cursorPath, corruptedPath)
            } catch {}
            throw new Error(
                `[IMPORT-SECURITY] Bridge cursor corrupted and quarantined at ${corruptedPath}: ${err.message}`
            )
        }
    }

    private async saveCursor(): Promise<void> {
        if (!this.cursor) return
        const tempPath = path.join(
            this.bridgeDirectory,
            `bridge_cursor.tmp.${process.pid}.${Date.now()}`
        )
        const payload = JSON.stringify(this.cursor, null, 2)
        await fs.promises.writeFile(tempPath, payload, 'utf8')
        await retryAtomicRename(tempPath, this.cursorPath)
    }

    private isProcessAlive(pid: number): boolean {
        if (pid <= 0) return false
        try {
            process.kill(pid, 0)
            return true
        } catch (err: any) {
            return err.code === 'EPERM'
        }
    }

    public async reclaimStaleClaims(): Promise<number> {
        if (!fs.existsSync(this.incomingDir)) return 0

        const entries = await fs.promises.readdir(this.incomingDir)
        let reclaimedCount = 0

        const claimingRegex = /^(.+)\.claiming\.(\d+)(?:\.(\d+))?$/

        for (const entry of entries) {
            const match = entry.match(claimingRegex)
            if (!match || !match[1] || !match[2]) continue

            const originalFilename = match[1]
            const claimingPid = parseInt(match[2], 10)
            const filePath = path.join(this.incomingDir, entry)

            try {
                const stat = await fs.promises.lstat(filePath)
                if (stat.isSymbolicLink()) {
                    await fs.promises.unlink(filePath)
                    continue
                }

                const isAlive = this.isProcessAlive(claimingPid)
                const isStale = Date.now() - stat.mtimeMs > this.claimingStaleMs

                if (!isAlive || isStale) {
                    const originalPath = path.join(this.incomingDir, originalFilename)
                    await retryAtomicRename(filePath, originalPath)
                    reclaimedCount++
                }
            } catch {
                // Ignore transient file lock / race condition during cleanup
            }
        }

        return reclaimedCount
    }

    public async calculateDirectoryBytes(): Promise<number> {
        let total = 0
        const subdirs = [this.incomingDir, this.processedDir, this.rejectedDir, this.diagnosticsDir]

        for (const dir of subdirs) {
            if (!fs.existsSync(dir)) continue
            try {
                const files = await fs.promises.readdir(dir)
                for (const file of files) {
                    try {
                        const stat = await fs.promises.lstat(path.join(dir, file))
                        if (!stat.isSymbolicLink()) {
                            total += stat.size
                        }
                    } catch {}
                }
            } catch {}
        }
        return total
    }

    public async cleanupRetention(): Promise<void> {
        const now = Date.now()

        // 1. Purge processed files
        if (fs.existsSync(this.processedDir)) {
            const maxProcessedAgeMs = this.processedRetentionHours * 3600 * 1000
            try {
                const files = await fs.promises.readdir(this.processedDir)
                for (const file of files) {
                    const filePath = path.join(this.processedDir, file)
                    try {
                        const stat = await fs.promises.lstat(filePath)
                        if (now - stat.mtimeMs > maxProcessedAgeMs) {
                            await fs.promises.unlink(filePath)
                        }
                    } catch {}
                }
            } catch {}
        }

        // 2. Purge diagnostic rejection metadata
        if (fs.existsSync(this.diagnosticsDir)) {
            const maxDiagnosticAgeMs = this.rejectionMetadataRetentionHours * 3600 * 1000
            try {
                const files = await fs.promises.readdir(this.diagnosticsDir)
                for (const file of files) {
                    const filePath = path.join(this.diagnosticsDir, file)
                    try {
                        const stat = await fs.promises.lstat(filePath)
                        if (now - stat.mtimeMs > maxDiagnosticAgeMs) {
                            await fs.promises.unlink(filePath)
                        }
                    } catch {}
                }
            } catch {}
        }
    }

    public async scanAndImport(): Promise<AccountObservationEnvelope[]> {
        if (!this.cursor) {
            await this.init()
        }

        if (this.isScanning) {
            return []
        }

        this.isScanning = true
        const importedEnvelopes: AccountObservationEnvelope[] = []

        try {
            await this.reclaimStaleClaims()

            // Check directory quota
            const currentDirBytes = await this.calculateDirectoryBytes()
            if (currentDirBytes > this.maxBridgeDirectoryBytes) {
                await this.cleanupRetention()
                const bytesAfterCleanup = await this.calculateDirectoryBytes()
                if (bytesAfterCleanup > this.maxBridgeDirectoryBytes) {
                    return []
                }
            }

            if (!fs.existsSync(this.incomingDir)) {
                return []
            }

            const allFiles = await fs.promises.readdir(this.incomingDir)
            // Filter candidates: must be .json, not currently claiming, not hidden
            const candidates = allFiles
                .filter(f => f.endsWith('.json') && !f.includes('.claiming.'))
                .slice(0, this.maxIncomingFiles)

            for (const filename of candidates) {
                const filePath = path.join(this.incomingDir, filename)

                let stat: fs.Stats
                try {
                    stat = await fs.promises.lstat(filePath)
                } catch {
                    continue // File might have been claimed concurrently
                }

                // Check symlinks
                if (stat.isSymbolicLink()) {
                    await this.recordRejectionAndDelete(
                        filename,
                        filePath,
                        0,
                        '0'.repeat(64),
                        'Symbolic links are strictly forbidden in bridge incoming directory'
                    )
                    continue
                }

                // Check file size
                if (stat.size > this.maximumFileBytes) {
                    await this.recordRejectionAndDelete(
                        filename,
                        filePath,
                        stat.size,
                        'oversized',
                        `File size ${stat.size} exceeds maximum limit of ${this.maximumFileBytes} bytes`
                    )
                    continue
                }

                // Atomic claim
                const claimFilename = `${filename}.claiming.${process.pid}.${Date.now()}`
                const claimPath = path.join(this.incomingDir, claimFilename)

                try {
                    await retryAtomicRename(filePath, claimPath)
                } catch {
                    continue // Already claimed by another pass
                }

                // Process claimed file
                try {
                    const rawBuffer = await fs.promises.readFile(claimPath)
                    const rawString = rawBuffer.toString('utf8')

                    let parsedJson: unknown
                    try {
                        parsedJson = JSON.parse(rawString)
                    } catch (parseErr: any) {
                        throw new Error(`JSON parse failure: ${parseErr.message}`)
                    }

                    const envelope = validateAccountObservationEnvelope(parsedJson)

                    // Sequence monotonicity check
                    const currentLatestSeq = this.cursor!.latestSequenceByAccountRef[envelope.accountRef] ?? 0
                    if (envelope.sequence <= currentLatestSeq) {
                        throw new Error(
                            `Regressed or duplicate sequence ${envelope.sequence} <= current ${currentLatestSeq} for accountRef ${envelope.accountRef}`
                        )
                    }

                    // Observation ID deduplication check
                    if (this.cursor!.recentlyProcessedObservationIds.includes(envelope.observationId)) {
                        throw new Error(`Duplicate observationId already processed: ${envelope.observationId}`)
                    }

                    // Successfully validated! Move to processed/
                    const processedFilename = `obs_${Date.now()}_${envelope.observationId}.json`
                    const processedPath = path.join(this.processedDir, processedFilename)
                    await retryAtomicRename(claimPath, processedPath)

                    // Update cursor
                    this.cursor!.latestSequenceByAccountRef[envelope.accountRef] = envelope.sequence
                    this.cursor!.recentlyProcessedObservationIds.push(envelope.observationId)
                    if (this.cursor!.recentlyProcessedObservationIds.length > 1000) {
                        this.cursor!.recentlyProcessedObservationIds.splice(
                            0,
                            this.cursor!.recentlyProcessedObservationIds.length - 1000
                        )
                    }
                    this.cursor!.updatedAt = new Date().toISOString()
                    await this.saveCursor()

                    importedEnvelopes.push(envelope)
                } catch (validationOrProcessErr: any) {
                    // Record rejection in diagnostics/ and delete the raw payload
                    let byteSize = 0
                    let checksum = 'unknown'
                    try {
                        const errStat = await fs.promises.lstat(claimPath)
                        byteSize = errStat.size
                        const buffer = await fs.promises.readFile(claimPath)
                        checksum = crypto.createHash('sha256').update(buffer).digest('hex')
                    } catch {}

                    await this.recordRejectionAndDelete(
                        claimFilename,
                        claimPath,
                        byteSize,
                        checksum,
                        validationOrProcessErr.message || String(validationOrProcessErr)
                    )
                }
            }
        } finally {
            this.isScanning = false
        }

        return importedEnvelopes
    }

    private async recordRejectionAndDelete(
        claimedFilename: string,
        claimPath: string,
        byteSize: number,
        checksumSha256: string,
        rejectionReason: string
    ): Promise<void> {
        const diagnostic: BridgeRejectionDiagnostic = {
            timestamp: new Date().toISOString(),
            claimedFilename,
            byteSize,
            checksumSha256,
            rejectionReason
        }

        const diagName = `reject_${Date.now()}_${checksumSha256.slice(0, 16)}.json`
        const diagPath = path.join(this.diagnosticsDir, diagName)
        const diagTmp = `${diagPath}.tmp.${process.pid}.${Date.now()}`

        try {
            await fs.promises.writeFile(diagTmp, JSON.stringify(diagnostic, null, 2), 'utf8')
            await retryAtomicRename(diagTmp, diagPath)
        } catch {}

        // Always delete raw invalid/untrusted payload
        try {
            if (fs.existsSync(claimPath)) {
                await fs.promises.unlink(claimPath)
            }
        } catch {}
    }

    public start(pollIntervalMs = 5000): void {
        if (this.pollTimer) return
        this.pollTimer = setInterval(async () => {
            try {
                await this.scanAndImport()
            } catch {}
        }, pollIntervalMs)
    }

    public stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer)
            this.pollTimer = null
        }
    }
}
