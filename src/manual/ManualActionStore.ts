import fs from 'fs'
import path from 'path'
import cluster from 'cluster'
import {
    ManualActionRecord,
    ManualActionStoreData,
    ManualActionStoreSchema,
    ManualActionMutationPayload,
    ManualActionQueryParams,
    ConflictError
} from './ManualActionTypes'
import { retryAtomicRename } from '../util/FileUtils'

export interface ManualActionStoreOptions {
    storePath: string
    allowInWorkerForTesting?: boolean
}

export class ManualActionStore {
    private readonly storePath: string
    private readonly backupPath: string
    private readonly records = new Map<string, ManualActionRecord>()
    private isInitialized = false

    constructor(options: ManualActionStoreOptions | string) {
        const resolvedOptions = typeof options === 'string' ? { storePath: options } : options

        if (cluster.isWorker && !resolvedOptions.allowInWorkerForTesting) {
            throw new Error('[SECURITY] ManualActionStore must only run in the cluster primary process')
        }

        this.storePath = path.resolve(resolvedOptions.storePath)
        this.backupPath = `${this.storePath}.bak`
    }

    public isReady(): boolean {
        return this.isInitialized
    }

    public async init(): Promise<void> {
        await fs.promises.mkdir(path.dirname(this.storePath), { recursive: true })

        if (!fs.existsSync(this.storePath)) {
            // Check if backup exists to restore from
            if (fs.existsSync(this.backupPath)) {
                try {
                    const bakRaw = await fs.promises.readFile(this.backupPath, 'utf8')
                    const bakParsed = JSON.parse(bakRaw)
                    const validated = ManualActionStoreSchema.parse(bakParsed)
                    this.loadFromData(validated)
                    await this.save()
                    this.isInitialized = true
                    return
                } catch {}
            }

            // Fresh store
            this.records.clear()
            await this.save()
            this.isInitialized = true
            return
        }

        try {
            const raw = await fs.promises.readFile(this.storePath, 'utf8')
            const parsed = JSON.parse(raw)
            const validated = ManualActionStoreSchema.parse(parsed)
            this.loadFromData(validated)
            this.isInitialized = true
        } catch (err: any) {
            // Store file corrupted! Quarantine corrupted file (Amendment 11)
            const corruptedPath = path.join(path.dirname(this.storePath), `manual_actions.corrupted.${Date.now()}.json`)
            try {
                await fs.promises.rename(this.storePath, corruptedPath)
            } catch {}

            // Check if valid backup exists
            let restoredFromBackup = false
            if (fs.existsSync(this.backupPath)) {
                try {
                    const bakRaw = await fs.promises.readFile(this.backupPath, 'utf8')
                    const bakParsed = JSON.parse(bakRaw)
                    const validated = ManualActionStoreSchema.parse(bakParsed)
                    this.loadFromData(validated)
                    restoredFromBackup = true
                    await this.save()
                    this.isInitialized = true
                } catch {}
            }

            if (!restoredFromBackup) {
                // Fail-closed! Never overwrite corrupted store with empty records
                throw new Error(
                    `[STORE-SECURITY] ManualActionStore corrupted and quarantined at ${corruptedPath}. No valid backup available: ${err.message}`
                )
            }
        }
    }

    private loadFromData(data: ManualActionStoreData): void {
        this.records.clear()
        for (const record of Object.values(data.records)) {
            this.records.set(record.recordId, record)
        }
    }

    public async save(): Promise<void> {
        // Pre-save backup: preserve previous valid store file as .bak (Amendment 11)
        if (fs.existsSync(this.storePath)) {
            try {
                await fs.promises.copyFile(this.storePath, this.backupPath)
            } catch {}
        }

        const data: ManualActionStoreData = {
            schemaVersion: 1,
            records: Object.fromEntries(this.records.entries()),
            updatedAt: new Date().toISOString()
        }

        const tempPath = `${this.storePath}.tmp.${process.pid}.${Date.now()}`
        await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf8')
        await retryAtomicRename(tempPath, this.storePath)
    }

    public getRecord(recordId: string): ManualActionRecord | undefined {
        const record = this.records.get(recordId)
        return record ? JSON.parse(JSON.stringify(record)) : undefined
    }

    public findByTaskRef(accountRef: string, taskRef: string): ManualActionRecord | undefined {
        for (const record of this.records.values()) {
            if (record.accountRef === accountRef && record.taskRef === taskRef) {
                return JSON.parse(JSON.stringify(record))
            }
        }
        return undefined
    }

    public getAllRecords(): ManualActionRecord[] {
        return Array.from(this.records.values()).map(r => JSON.parse(JSON.stringify(r)))
    }

    public async upsertRecord(record: ManualActionRecord): Promise<void> {
        this.records.set(record.recordId, JSON.parse(JSON.stringify(record)))
        await this.save()
    }

    public async batchUpsertRecords(recordsToUpsert: ManualActionRecord[]): Promise<void> {
        for (const record of recordsToUpsert) {
            this.records.set(record.recordId, JSON.parse(JSON.stringify(record)))
        }
        await this.save()
    }

    public async reportAction(recordId: string, payload: ManualActionMutationPayload): Promise<ManualActionRecord> {
        const record = this.records.get(recordId)
        if (!record) {
            throw new Error(`Record not found: ${recordId}`)
        }

        // Optimistic concurrency check (Amendment 10)
        if (payload.expectedRevision !== record.revision) {
            throw new ConflictError(record.revision)
        }

        const now = new Date().toISOString()
        record.lifecycleState = 'action-reported'
        // Invariant (Amendment 8): User report NEVER marks verificationState as verified-complete!
        // It stays unverified until exact Main snapshot proves completion.
        record.verificationState = 'unverified'
        record.actionReportedAt = now
        record.updatedAt = now
        record.revision++
        if (payload.note !== undefined) {
            record.note = payload.note
        }

        await this.save()
        return JSON.parse(JSON.stringify(record))
    }

    public async dismissAction(recordId: string, payload: ManualActionMutationPayload): Promise<ManualActionRecord> {
        const record = this.records.get(recordId)
        if (!record) {
            throw new Error(`Record not found: ${recordId}`)
        }

        if (payload.expectedRevision !== record.revision) {
            throw new ConflictError(record.revision)
        }

        const now = new Date().toISOString()
        record.lifecycleState = 'dismissed'
        record.updatedAt = now
        record.revision++
        if (payload.note !== undefined) {
            record.note = payload.note
        }

        await this.save()
        return JSON.parse(JSON.stringify(record))
    }

    public async reopenAction(recordId: string, payload: ManualActionMutationPayload): Promise<ManualActionRecord> {
        const record = this.records.get(recordId)
        if (!record) {
            throw new Error(`Record not found: ${recordId}`)
        }

        if (payload.expectedRevision !== record.revision) {
            throw new ConflictError(record.revision)
        }

        const now = new Date().toISOString()
        record.lifecycleState = 'available'
        record.updatedAt = now
        record.revision++
        if (payload.note !== undefined) {
            record.note = payload.note
        }

        await this.save()
        return JSON.parse(JSON.stringify(record))
    }

    /**
     * Read-only query semantics (Amendment 7).
     * Non-mutating: does not trigger scans, reconciliations, or state updates.
     */
    public query(params: ManualActionQueryParams = {}): {
        records: ManualActionRecord[]
        nextCursor?: string
        totalMatching: number
    } {
        let matching = Array.from(this.records.values())

        // Account filter
        if (params.accountRef) {
            matching = matching.filter(r => r.accountRef === params.accountRef)
        }

        // Lifecycle state filter
        if (params.lifecycleState) {
            matching = matching.filter(r => r.lifecycleState === params.lifecycleState)
        }

        // Verification state filter
        if (params.verificationState) {
            matching = matching.filter(r => r.verificationState === params.verificationState)
        }

        // Search filter: case-insensitive substring match against task title ONLY (Amendment 7)
        if (params.search && params.search.trim()) {
            const queryLower = params.search.trim().toLowerCase()
            matching = matching.filter(r => r.title.toLowerCase().includes(queryLower))
        }

        // Deterministic sort: createdAt DESC, recordId ASC
        matching.sort((a, b) => {
            const timeDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
            if (timeDiff !== 0) return timeDiff
            return a.recordId.localeCompare(b.recordId)
        })

        const totalMatching = matching.length

        // Pagination with opaque cursor
        const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
        let startIndex = 0

        if (params.cursor) {
            try {
                const decodedId = Buffer.from(params.cursor, 'base64').toString('utf8')
                const foundIndex = matching.findIndex(r => r.recordId === decodedId)
                if (foundIndex !== -1) {
                    startIndex = foundIndex + 1
                }
            } catch {}
        }

        const pageRecords = matching.slice(startIndex, startIndex + limit)
        let nextCursor: string | undefined = undefined

        if (startIndex + limit < matching.length && pageRecords.length > 0) {
            const lastRecord = pageRecords[pageRecords.length - 1]!
            nextCursor = Buffer.from(lastRecord.recordId).toString('base64')
        }

        return {
            records: pageRecords.map(r => JSON.parse(JSON.stringify(r))),
            nextCursor,
            totalMatching
        }
    }
}
