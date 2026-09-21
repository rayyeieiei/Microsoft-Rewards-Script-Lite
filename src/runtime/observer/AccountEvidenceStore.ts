import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { retryAtomicRename } from '../../util/FileUtils'

export const AccountEvidenceRecordSchema = z
    .object({
        accountId: z.string().min(1),
        accountRef: z.string().min(1),
        displayAccount: z.string().min(1),
        sessionState: z.enum(['unknown', 'present-unverified', 'valid-from-server', 'expired-from-server']),
        restrictionState: z.enum(['none', 'rate-limited', 'blocked']),
        rateLimitExpiresAt: z.string().datetime({ offset: true }).optional(),
        restrictionReason: z.string().optional(),
        lastObservedAt: z.string().datetime({ offset: true }),
        lastReceivedAt: z.string().datetime({ offset: true }),
        source: z.enum(['bridge', 'local-scan']),
        evidenceSequence: z.number().int().nonnegative(),
        diagnosticCode: z.string().optional()
    })
    .strict()

export type AccountEvidenceRecord = z.infer<typeof AccountEvidenceRecordSchema>

export const AccountEvidenceStoreSchema = z
    .object({
        schemaVersion: z.literal(1),
        updatedAt: z.string().datetime({ offset: true }),
        records: z.record(z.string().min(1), AccountEvidenceRecordSchema)
    })
    .strict()

export type AccountEvidenceStoreData = z.infer<typeof AccountEvidenceStoreSchema>

export interface AccountEvidenceStoreOptions {
    storePath: string
    maxFileSizeBytes?: number
}

export class AccountEvidenceStore {
    private readonly storePath: string
    private readonly backupPath: string
    private readonly maxFileSizeBytes: number
    private readonly records = new Map<string, AccountEvidenceRecord>()
    private isInitialized = false

    constructor(options: AccountEvidenceStoreOptions | string) {
        const resolvedPath = typeof options === 'string' ? path.resolve(options) : path.resolve(options.storePath)

        this.storePath = resolvedPath
        this.backupPath = `${this.storePath}.bak`
        this.maxFileSizeBytes =
            typeof options === 'object' && options.maxFileSizeBytes ? options.maxFileSizeBytes : 10 * 1024 * 1024 // 10MB
    }

    public isReady(): boolean {
        return this.isInitialized
    }

    public async init(): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.storePath), { recursive: true })

        if (!fs.existsSync(this.storePath)) {
            if (fs.existsSync(this.backupPath)) {
                try {
                    const bakRaw = await fs.promises.readFile(this.backupPath, 'utf-8')
                    const bakParsed = JSON.parse(bakRaw)
                    const validated = AccountEvidenceStoreSchema.parse(bakParsed)
                    this.loadFromData(validated)
                    await this.save()
                    this.isInitialized = true
                    return
                } catch {}
            }

            this.records.clear()
            await this.save()
            this.isInitialized = true
            return
        }

        try {
            const lstat = await fs.promises.lstat(this.storePath)
            if (lstat.isSymbolicLink()) {
                throw new Error(`[SECURITY] Storage file cannot be a symbolic link: ${this.storePath}`)
            }

            const raw = await fs.promises.readFile(this.storePath, 'utf-8')
            const parsed = JSON.parse(raw)
            const validated = AccountEvidenceStoreSchema.parse(parsed)
            this.loadFromData(validated)
            this.isInitialized = true
        } catch (err: any) {
            const corruptedPath = path.join(
                path.dirname(this.storePath),
                `account_evidence.corrupted.${Date.now()}.json`
            )
            try {
                await fs.promises.rename(this.storePath, corruptedPath)
            } catch {}

            let restoredFromBackup = false
            if (fs.existsSync(this.backupPath)) {
                try {
                    const bakRaw = await fs.promises.readFile(this.backupPath, 'utf-8')
                    const bakParsed = JSON.parse(bakRaw)
                    const validated = AccountEvidenceStoreSchema.parse(bakParsed)
                    this.loadFromData(validated)
                    restoredFromBackup = true
                    await this.save()
                    this.isInitialized = true
                } catch {}
            }

            if (!restoredFromBackup) {
                throw new Error(
                    `[STORE-SECURITY] AccountEvidenceStore corrupted and quarantined at ${corruptedPath}. No valid backup available: ${err.message}`
                )
            }
        }
    }

    private loadFromData(data: AccountEvidenceStoreData): void {
        this.records.clear()
        for (const [accountId, record] of Object.entries(data.records)) {
            this.records.set(accountId, record)
        }
    }

    public async save(): Promise<void> {
        const storeDir = path.dirname(this.storePath)
        await fs.promises.mkdir(storeDir, { recursive: true })

        const recordsObj: Record<string, AccountEvidenceRecord> = {}
        for (const [id, rec] of this.records.entries()) {
            recordsObj[id] = rec
        }

        const data: AccountEvidenceStoreData = {
            schemaVersion: 1,
            updatedAt: new Date().toISOString(),
            records: recordsObj
        }

        const serialized = JSON.stringify(data, null, 2)
        if (Buffer.byteLength(serialized, 'utf-8') > this.maxFileSizeBytes) {
            throw new Error('[SECURITY] AccountEvidenceStore exceeds maximum allowable size')
        }

        if (fs.existsSync(this.storePath)) {
            try {
                await fs.promises.copyFile(this.storePath, this.backupPath)
            } catch {}
        }

        const tmpPath = path.join(storeDir, `${path.basename(this.storePath)}.tmp.${process.pid}.${Date.now()}`)
        await fs.promises.writeFile(tmpPath, serialized, 'utf-8')
        await retryAtomicRename(tmpPath, this.storePath)
    }

    public getEvidence(accountId: string): AccountEvidenceRecord | undefined {
        return this.records.get(accountId)
    }

    public findEvidenceByAccountRef(accountRef: string): AccountEvidenceRecord | undefined {
        for (const record of this.records.values()) {
            if (record.accountRef === accountRef) {
                return record
            }
        }
        return undefined
    }

    public getAllEvidence(): AccountEvidenceRecord[] {
        return Array.from(this.records.values())
    }

    public async upsertEvidence(record: AccountEvidenceRecord): Promise<void> {
        const validated = AccountEvidenceRecordSchema.parse(record)
        const existing = this.records.get(validated.accountId)

        if (existing) {
            // Monotonic sequence check: older sequence from same source cannot overwrite newer
            if (existing.source === validated.source && validated.evidenceSequence < existing.evidenceSequence) {
                return
            }

            // Older observed timestamp check
            const existingTime = Date.parse(existing.lastObservedAt)
            const newTime = Date.parse(validated.lastObservedAt)
            if (!isNaN(existingTime) && !isNaN(newTime) && newTime < existingTime) {
                return
            }
        }

        this.records.set(validated.accountId, validated)
        await this.save()
    }

    public isStale(record: AccountEvidenceRecord, thresholdHours: number, nowMs = Date.now()): boolean {
        const observedTime = Date.parse(record.lastObservedAt)
        if (isNaN(observedTime)) return true
        const ageMs = nowMs - observedTime
        return ageMs > thresholdHours * 3600 * 1000
    }
}
