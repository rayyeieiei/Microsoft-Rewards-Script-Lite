import crypto from 'crypto'
import { AccountReadinessResult } from '../readiness/AccountReadinessTypes'
import { TaskHandoffEnvelope } from '../contracts/ExecutionContract'
import {
    AccountReadinessPublicDto,
    DashboardSnapshotDto,
    DataSourceStatusDto,
    MonitoringStatusDto,
    BridgeDiagnosticsDto
} from './DashboardTypes'
import { ReadinessDashboardAdapter } from './ReadinessDashboardAdapter'

export interface ReadinessSnapshotStoreOptions {
    maxTimelineEntries: number
    now: () => number
    sessionSecret?: string
    runtimeStartTime?: number
    runtimeId?: string
    initialRuntimeStatus?: 'starting' | 'running' | 'degraded' | 'stopping'
}

export class ReadinessSnapshotStore {
    private readonly maxTimelineEntries: number
    private readonly now: () => number
    private readonly adapter: ReadinessDashboardAdapter
    private readonly runtimeStartTime: number
    private readonly runtimeId: string

    private revision = 0
    private runtimeStatus: 'starting' | 'running' | 'degraded' | 'stopping' = 'running'
    private dataSourceStatus: DataSourceStatusDto = {
        status: 'loading',
        sourceFile: 'accounts.json',
        environmentMode: 'normal',
        acceptedCount: 0,
        rejectedCount: 0,
        rejectionReasons: []
    }
    private monitoringStatus: MonitoringStatusDto = {
        monitoringState: 'running',
        checkingState: 'idle'
    }
    private bridgeDiagnostics?: BridgeDiagnosticsDto

    private accountDtos = new Map<string, AccountReadinessPublicDto>() // publicRef -> DTO
    private accountIdToPublicRef = new Map<string, string>() // internal accountId -> publicRef
    private listeners = new Set<(snapshot: DashboardSnapshotDto) => void>()
    private isDisposed = false
    private broadcastPending = false
    private broadcastTimer?: NodeJS.Timeout

    constructor(options: ReadinessSnapshotStoreOptions) {
        this.maxTimelineEntries = options.maxTimelineEntries || 50
        this.now = options.now || (() => Date.now())
        this.adapter = new ReadinessDashboardAdapter(options.sessionSecret)
        this.runtimeStartTime = options.runtimeStartTime || this.now()
        this.runtimeId = options.runtimeId || crypto.randomUUID()
        if (options.initialRuntimeStatus) {
            this.runtimeStatus = options.initialRuntimeStatus
        }
    }

    public getAdapter(): ReadinessDashboardAdapter {
        return this.adapter
    }

    public getRuntimeId(): string {
        return this.runtimeId
    }

    public getRevision(): number {
        return this.revision
    }

    public setRuntimeStatus(status: 'starting' | 'running' | 'degraded' | 'stopping'): void {
        if (this.isDisposed) return
        this.runtimeStatus = status
        this.revision++
        this.scheduleBroadcast()
    }

    public setDataSourceStatus(status: DataSourceStatusDto): void {
        if (this.isDisposed) return
        this.dataSourceStatus = {
            status: status.status,
            sourceFile: status.sourceFile,
            environmentMode: status.environmentMode,
            lastLoadedAt: status.lastLoadedAt,
            acceptedCount: status.acceptedCount,
            rejectedCount: status.rejectedCount,
            rejections: status.rejections ? status.rejections.map(r => ({ ...r })) : undefined,
            rejectionReasons: [...(status.rejectionReasons || [])],
            error: status.error ? { ...status.error } : undefined
        }
        this.revision++
        this.scheduleBroadcast()
    }

    public setMonitoringStatus(status: Partial<MonitoringStatusDto>): void {
        if (this.isDisposed) return
        this.monitoringStatus = {
            ...this.monitoringStatus,
            ...status
        }
        this.revision++
        this.scheduleBroadcast()
    }

    public setBridgeDiagnostics(diagnostics: BridgeDiagnosticsDto): void {
        if (this.isDisposed) return
        this.bridgeDiagnostics = { ...diagnostics }
        this.revision++
        this.scheduleBroadcast()
    }

    public getMonitoringStatus(): MonitoringStatusDto {
        return JSON.parse(JSON.stringify(this.monitoringStatus))
    }

    /**
     * Updates an account's state with readiness result and task handoffs.
     * Enforces bounded timeline entries and defensive immutability.
     */
    public updateAccount(
        readiness: AccountReadinessResult,
        tasks: TaskHandoffEnvelope[] = [],
        evidenceMeta?: { lastObservedAt?: string; isStale?: boolean }
    ): void {
        if (this.isDisposed) return

        // Bound task list to maxTimelineEntries
        const boundedTasks = tasks.slice(0, this.maxTimelineEntries)
        const publicDto = this.adapter.toAccountPublicDto(readiness, boundedTasks, evidenceMeta)

        this.accountIdToPublicRef.set(readiness.accountId, publicDto.publicRef)
        this.accountDtos.set(publicDto.publicRef, publicDto)

        this.revision++
        this.scheduleBroadcast()
    }

    /**
     * Clears all accounts currently in the store (e.g. on manifest reload).
     */
    public clearAccounts(): void {
        if (this.isDisposed) return
        this.accountDtos.clear()
        this.accountIdToPublicRef.clear()
        this.revision++
        this.scheduleBroadcast()
    }

    /**
     * Returns an immutable snapshot with deep defensive copying.
     */
    public getSnapshot(): DashboardSnapshotDto {
        const uptimeSeconds = Math.max(0, Math.floor((this.now() - this.runtimeStartTime) / 1000))
        const snapshot = this.adapter.createSnapshot(
            Array.from(this.accountDtos.values()),
            {
                status: this.runtimeStatus,
                uptimeSeconds,
                observerOnly: true,
                runtimeStartTime: new Date(this.runtimeStartTime).toISOString()
            },
            {
                revision: this.revision,
                runtimeId: this.runtimeId,
                dataSource: this.dataSourceStatus,
                monitoring: this.monitoringStatus,
                bridgeDiagnostics: this.bridgeDiagnostics
            }
        )

        // Defensive copy
        return JSON.parse(JSON.stringify(snapshot))
    }

    /**
     * Returns defensive copy of a single account by publicRef.
     */
    public getAccount(publicRef: string): AccountReadinessPublicDto | null {
        const dto = this.accountDtos.get(publicRef)
        if (!dto) return null
        return JSON.parse(JSON.stringify(dto))
    }

    /**
     * Subscribes a listener to snapshot changes. Returns an unsubscribe function.
     */
    public subscribe(listener: (snapshot: DashboardSnapshotDto) => void): () => void {
        if (this.isDisposed) return () => {}
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    /**
     * Coalesces rapid updates to max 1 broadcast per 250ms (Amendment 5).
     */
    private scheduleBroadcast(): void {
        if (this.broadcastPending || this.isDisposed) return
        this.broadcastPending = true

        this.broadcastTimer = setTimeout(() => {
            this.broadcastPending = false
            if (this.isDisposed) return

            const currentSnapshot = this.getSnapshot()
            for (const listener of this.listeners) {
                try {
                    listener(currentSnapshot)
                } catch {
                    // Ignore individual subscriber errors to protect store
                }
            }
        }, 250)
    }

    /**
     * Disposes the store, clearing all timers and subscriber callbacks.
     */
    public dispose(): void {
        this.isDisposed = true
        if (this.broadcastTimer) {
            clearTimeout(this.broadcastTimer)
            this.broadcastTimer = undefined
        }
        this.listeners.clear()
        this.accountDtos.clear()
        this.accountIdToPublicRef.clear()
    }
}
