import { AccountReadinessResult } from '../readiness/AccountReadinessTypes'
import { TaskHandoffEnvelope } from '../contracts/ExecutionContract'
import { AccountReadinessPublicDto, DashboardSnapshotDto } from './DashboardTypes'
import { ReadinessDashboardAdapter } from './ReadinessDashboardAdapter'

export interface ReadinessSnapshotStoreOptions {
    maxTimelineEntries: number
    now: () => number
    sessionSecret?: string
    runtimeStartTime?: number
}

export class ReadinessSnapshotStore {
    private readonly maxTimelineEntries: number
    private readonly now: () => number
    private readonly adapter: ReadinessDashboardAdapter
    private readonly runtimeStartTime: number

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
    }

    public getAdapter(): ReadinessDashboardAdapter {
        return this.adapter
    }

    /**
     * Updates an account's state with readiness result and task handoffs.
     * Enforces bounded timeline entries and defensive immutability.
     */
    public updateAccount(
        readiness: AccountReadinessResult,
        tasks: TaskHandoffEnvelope[] = []
    ): void {
        if (this.isDisposed) return

        // Bound task list to maxTimelineEntries
        const boundedTasks = tasks.slice(0, this.maxTimelineEntries)
        const publicDto = this.adapter.toAccountPublicDto(readiness, boundedTasks)

        this.accountIdToPublicRef.set(readiness.accountId, publicDto.publicRef)
        this.accountDtos.set(publicDto.publicRef, publicDto)

        this.scheduleBroadcast()
    }

    /**
     * Returns an immutable snapshot with deep defensive copying.
     */
    public getSnapshot(): DashboardSnapshotDto {
        const uptimeSeconds = Math.max(0, Math.floor((this.now() - this.runtimeStartTime) / 1000))
        const snapshot = this.adapter.createSnapshot(Array.from(this.accountDtos.values()), {
            status: 'running',
            uptimeSeconds,
            observerOnly: true
        })

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
