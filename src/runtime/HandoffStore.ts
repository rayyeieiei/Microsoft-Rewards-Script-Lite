import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import cluster from 'cluster'
import {
    EXECUTION_CONTRACT_VERSION,
    TaskHandoffEnvelope,
    validateTaskHandoffEnvelope,
    isTerminalOutcome,
    canTransitionOutcome
} from '../contracts/ExecutionContract'
import { redactAccountKey, sanitizeLogMessage } from '../util/Redaction'

export interface HandoffStoreData {
    schemaVersion: typeof EXECUTION_CONTRACT_VERSION
    updatedAt: string
    records: TaskHandoffEnvelope[]
}

export interface SafeHandoffPublicDto {
    recordId: string
    correlationId: string
    displayAccount: string
    taskId: string
    taskKind: string
    capability: string
    outcome: string
    reason: string
    observedAt: string
    expiresAt?: string
    source: 'lite' | 'main'
    diagnosticCode?: string
}

export interface HandoffStoreOptions {
    storagePath: string
    maxRecords?: number
    maxFileSizeBytes?: number
}

export class HandoffStore {
    private readonly storagePath: string
    private readonly maxRecords: number
    private readonly maxFileSizeBytes: number
    private writeMutex: Promise<void> = Promise.resolve()
    private recordsMap = new Map<string, TaskHandoffEnvelope>()
    private isLoaded = false

    constructor(options: HandoffStoreOptions) {
        this.storagePath = path.resolve(options.storagePath)
        this.maxRecords = options.maxRecords ?? 5000
        this.maxFileSizeBytes = options.maxFileSizeBytes ?? 10 * 1024 * 1024 // 10MB
    }

    private makeKey(record: TaskHandoffEnvelope): string {
        return `${record.account.accountId}::${record.taskId}::${record.source}::${record.contractVersion}`
    }

    private sanitizeDestinationUrls(envelope: TaskHandoffEnvelope): TaskHandoffEnvelope {
        // Strip query strings from diagnosticCode or any other string field
        const sanitized: TaskHandoffEnvelope = {
            ...envelope,
            account: {
                accountId: envelope.account.accountId,
                displayAccount: redactAccountKey(envelope.account.displayAccount)
            }
        }
        if (sanitized.diagnosticCode) {
            sanitized.diagnosticCode = sanitizeLogMessage(sanitized.diagnosticCode).replace(/\?[^#\s]*/g, '')
        }
        return sanitized
    }

    public async load(): Promise<void> {
        if (this.isLoaded) return

        if (!fs.existsSync(this.storagePath)) {
            this.isLoaded = true
            return
        }

        // Symlink rejection
        const lstat = await fs.promises.lstat(this.storagePath)
        if (lstat.isSymbolicLink()) {
            throw new Error(`[SECURITY] Storage file cannot be a symbolic link: ${this.storagePath}`)
        }

        if (lstat.size > this.maxFileSizeBytes) {
            throw new Error(`[SECURITY] Storage file exceeds max allowable size: ${lstat.size} bytes`)
        }

        const rawContent = await fs.promises.readFile(this.storagePath, 'utf-8')
        let parsed: any
        try {
            parsed = JSON.parse(rawContent)
        } catch {
            throw new Error(`[SECURITY] Corrupted JSON in handoff store: ${this.storagePath}`)
        }

        if (parsed.schemaVersion !== EXECUTION_CONTRACT_VERSION || !Array.isArray(parsed.records)) {
            throw new Error(`[SECURITY] Unsupported or malformed store schemaVersion: ${parsed.schemaVersion}`)
        }

        this.recordsMap.clear()
        for (const record of parsed.records) {
            const validated = validateTaskHandoffEnvelope(record)
            this.recordsMap.set(this.makeKey(validated), validated)
        }

        this.isLoaded = true
    }

    /**
     * Records a handoff envelope.
     * In cluster mode on a worker process, sends via IPC to master.
     * On master process (or single-process), validates and writes to disk.
     */
    public async recordHandoff(envelope: unknown): Promise<TaskHandoffEnvelope> {
        // Strict runtime validation before persistence
        const validated = validateTaskHandoffEnvelope(envelope)
        const sanitized = this.sanitizeDestinationUrls(validated)

        // Cluster Worker Delegation (Architecture A)
        if (cluster.isWorker && process.send) {
            process.send({ type: 'HANDOFF_ENVELOPE', payload: sanitized })
            return sanitized
        }

        // Mutex-serialized write inside master / single process
        return new Promise<TaskHandoffEnvelope>((resolve, reject) => {
            this.writeMutex = this.writeMutex
                .then(async () => {
                    await this.load()
                    const key = this.makeKey(sanitized)
                    const existing = this.recordsMap.get(key)

                    if (existing) {
                        // 1. Terminal state check: terminal records cannot be downgraded
                        if (isTerminalOutcome(existing.outcome) && !isTerminalOutcome(sanitized.outcome)) {
                            // Reject downgrade
                            return
                        }

                        // 2. Monotonic transition check
                        if (!canTransitionOutcome(existing.outcome, sanitized.outcome)) {
                            return
                        }

                        // 3. ObservedAt timestamp check: older evidence cannot overwrite newer
                        const existingTime = Date.parse(existing.observedAt)
                        const newTime = Date.parse(sanitized.observedAt)
                        if (!isNaN(existingTime) && !isNaN(newTime) && newTime < existingTime) {
                            return
                        }
                    }

                    // Enforce max records limit
                    if (!existing && this.recordsMap.size >= this.maxRecords) {
                        // Remove oldest non-terminal record
                        for (const [k, rec] of this.recordsMap) {
                            if (!isTerminalOutcome(rec.outcome)) {
                                this.recordsMap.delete(k)
                                break
                            }
                        }
                    }

                    this.recordsMap.set(key, sanitized)
                    await this.persistAtomic()
                })
                .then(() => resolve(sanitized))
                .catch(reject)
        })
    }

    private async persistAtomic(): Promise<void> {
        const storeDir = path.dirname(this.storagePath)
        if (!fs.existsSync(storeDir)) {
            await fs.promises.mkdir(storeDir, { recursive: true })
        }

        const data: HandoffStoreData = {
            schemaVersion: EXECUTION_CONTRACT_VERSION,
            updatedAt: new Date().toISOString(),
            records: Array.from(this.recordsMap.values())
        }

        const serialized = JSON.stringify(data, null, 2)
        if (Buffer.byteLength(serialized, 'utf-8') > this.maxFileSizeBytes) {
            throw new Error('[SECURITY] Serialized handoff store exceeds maximum size')
        }

        // Temporary file in the same directory using PID + UUID
        const tmpFileName = `${path.basename(this.storagePath)}.tmp.${process.pid}.${crypto.randomUUID()}`
        const tmpFilePath = path.join(storeDir, tmpFileName)

        await fs.promises.writeFile(tmpFilePath, serialized, 'utf-8')
        await fs.promises.rename(tmpFilePath, this.storagePath)
    }

    public async getRecords(): Promise<TaskHandoffEnvelope[]> {
        await this.load()
        return Array.from(this.recordsMap.values())
    }

    public async toPublicDtos(): Promise<SafeHandoffPublicDto[]> {
        await this.load()
        return Array.from(this.recordsMap.values()).map(r => {
            // Opaque public record ID using sha256
            const recordId = crypto
                .createHash('sha256')
                .update(`${r.account.accountId}::${r.taskId}::${r.correlationId}`)
                .digest('hex')
                .slice(0, 16)

            return {
                recordId,
                correlationId: r.correlationId,
                displayAccount: redactAccountKey(r.account.displayAccount),
                taskId: r.taskId,
                taskKind: r.taskKind,
                capability: r.capability,
                outcome: r.outcome,
                reason: r.reason,
                observedAt: r.observedAt,
                expiresAt: r.expiresAt,
                source: r.source,
                diagnosticCode: r.diagnosticCode
            }
        })
    }
}
