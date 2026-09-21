import crypto from 'crypto'
import { ReadinessSnapshotStore } from '../../dashboard/ReadinessSnapshotStore'
import { MonitoringStatusDto, MonitoringResultSummaryDto } from '../../dashboard/DashboardTypes'
import { AccountReadinessResult } from '../../readiness/AccountReadinessTypes'

export interface StagedAccountReadiness {
    readiness: AccountReadinessResult
    tasks: any[]
    evidenceMeta?: {
        lastObservedAt: string
        isStale: boolean
    }
}

export interface CheckExecutionResult {
    accountsChecked: number
    errorCount: number
    stagedAccounts?: StagedAccountReadiness[]
}

export interface ObserverCoordinatorOptions {
    checkIntervalMs?: number
    checkTimeoutMs?: number
    stalenessIntervalMs?: number
    snapshotStore: ReadinessSnapshotStore
    executeCheck: (signal: AbortSignal) => Promise<CheckExecutionResult>
    onApplyStagedResults: (staged: StagedAccountReadiness[]) => void
    onCheckStaleness?: () => Promise<void>
    onDegraded?: (reason: string) => void
    logFn?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class ObserverCoordinator {
    private readonly checkIntervalMs: number
    private readonly checkTimeoutMs: number
    private readonly stalenessIntervalMs: number
    private readonly snapshotStore: ReadinessSnapshotStore
    private readonly executeCheck: (signal: AbortSignal) => Promise<CheckExecutionResult>
    private readonly onApplyStagedResults: (staged: StagedAccountReadiness[]) => void
    private readonly onCheckStaleness?: () => Promise<void>
    private readonly onDegraded?: (reason: string) => void
    private readonly logFn?: (level: 'info' | 'warn' | 'error', message: string) => void

    private monitoringState: 'running' | 'paused' = 'running'
    private checkingState: 'idle' | 'checking' | 'failed' = 'idle'
    private pendingPause = false
    private activeCheckId: string | null = null
    private activeAbortController: AbortController | null = null

    private underlyingJobRunning = false
    private lastCheckedAt?: string
    private lastSuccessfulCheckAt?: string
    private nextCheckAt?: string
    private lastResultSummary?: MonitoringResultSummaryDto

    private scheduleTimer?: NodeJS.Timeout
    private stalenessTimer?: NodeJS.Timeout
    private isStopped = false
    private isDegraded = false

    constructor(options: ObserverCoordinatorOptions) {
        this.checkIntervalMs = options.checkIntervalMs ?? 60000
        this.checkTimeoutMs = options.checkTimeoutMs ?? 15000
        this.stalenessIntervalMs = options.stalenessIntervalMs ?? 60000
        this.snapshotStore = options.snapshotStore
        this.executeCheck = options.executeCheck
        this.onApplyStagedResults = options.onApplyStagedResults
        this.onCheckStaleness = options.onCheckStaleness
        this.onDegraded = options.onDegraded
        this.logFn = options.logFn
    }

    private log(level: 'info' | 'warn' | 'error', message: string): void {
        if (this.logFn) {
            this.logFn(level, `[COORDINATOR] ${message}`)
        }
    }

    public getStatus(): MonitoringStatusDto {
        return {
            monitoringState: this.monitoringState,
            checkingState: this.checkingState,
            pendingPause: this.pendingPause,
            activeCheckId: this.activeCheckId || undefined,
            lastCheckedAt: this.lastCheckedAt,
            lastSuccessfulCheckAt: this.lastSuccessfulCheckAt,
            nextCheckAt: this.nextCheckAt,
            lastResultSummary: this.lastResultSummary ? { ...this.lastResultSummary } : undefined
        }
    }

    public isDegradedMode(): boolean {
        return this.isDegraded
    }

    private publishStatus(): void {
        this.snapshotStore.setMonitoringStatus(this.getStatus())
    }

    public start(): void {
        if (this.isStopped) return

        this.monitoringState = 'running'
        this.checkingState = 'idle'
        this.pendingPause = false

        // Schedule first periodic check after interval
        this.scheduleNextCheck()

        // Setup background staleness tracker (runs regardless of monitoring state)
        if (this.onCheckStaleness) {
            this.stalenessTimer = setInterval(() => {
                void this.runStalenessCheck()
            }, this.stalenessIntervalMs)
        }

        this.publishStatus()
        this.log(
            'info',
            `Coordinator started. Check interval: ${this.checkIntervalMs}ms, Timeout: ${this.checkTimeoutMs}ms`
        )
    }

    private async runStalenessCheck(): Promise<void> {
        if (this.isStopped || !this.onCheckStaleness) return
        try {
            await this.onCheckStaleness()
        } catch (err: any) {
            this.log('warn', `Staleness check error: ${err.message}`)
        }
    }

    private scheduleNextCheck(): void {
        if (this.isStopped || this.monitoringState !== 'running' || this.pendingPause) {
            this.nextCheckAt = undefined
            return
        }

        if (this.scheduleTimer) {
            clearTimeout(this.scheduleTimer)
            this.scheduleTimer = undefined
        }

        const scheduledTime = Date.now() + this.checkIntervalMs
        this.nextCheckAt = new Date(scheduledTime).toISOString()

        this.scheduleTimer = setTimeout(() => {
            this.scheduleTimer = undefined
            void this.triggerCheck('scheduled')
        }, this.checkIntervalMs)
    }

    /**
     * Triggers a local evidence recheck.
     * Returns immediately with checkId and state (conforming to HTTP 202 response).
     * Coalesces concurrent calls to the active check without unbounded queueing.
     */
    public triggerCheck(reason: 'manual' | 'scheduled' | 'bridge' = 'manual'): {
        checkId: string
        checkingState: 'idle' | 'checking' | 'failed'
        alreadyRunning: boolean
    } {
        if (this.isStopped) {
            throw new Error('ObserverCoordinator is stopped')
        }

        // 1. If underlying job is still executing from a prior run
        if (this.underlyingJobRunning) {
            if (this.activeCheckId) {
                // Coalesce: return active check details
                return {
                    checkId: this.activeCheckId,
                    checkingState: this.checkingState,
                    alreadyRunning: true
                }
            } else {
                // Previous check timed out, but underlying job is still running!
                // Hold back and transition to degraded state
                this.isDegraded = true
                const warnMsg = 'Pemeriksaan berikutnya ditahan karena pekerjaan lokal sebelumnya belum berhenti.'
                this.log('warn', warnMsg)
                if (this.onDegraded) {
                    this.onDegraded(warnMsg)
                }
                throw new Error(warnMsg)
            }
        }

        // 2. Clear any pending scheduled timer
        if (this.scheduleTimer) {
            clearTimeout(this.scheduleTimer)
            this.scheduleTimer = undefined
        }
        this.nextCheckAt = undefined

        // 3. Initiate new check
        const checkId = `chk-${crypto.randomUUID().slice(0, 8)}`
        this.activeCheckId = checkId
        this.checkingState = 'checking'
        this.underlyingJobRunning = true

        const abortController = new AbortController()
        this.activeAbortController = abortController

        this.publishStatus()
        this.log('info', `Started check [${checkId}] (reason: ${reason})`)

        // 4. Run asynchronously in background without blocking caller
        void this.runCheckExecution(checkId, abortController)

        return {
            checkId,
            checkingState: 'checking',
            alreadyRunning: false
        }
    }

    private async runCheckExecution(checkId: string, abortController: AbortController): Promise<void> {
        const startedAtMs = Date.now()
        let timedOut = false
        let timerHandle: NodeJS.Timeout | undefined

        // Create timeout promise
        const timeoutPromise = new Promise<never>((_, reject) => {
            timerHandle = setTimeout(() => {
                timedOut = true
                abortController.abort()
                reject(new Error(`Pemeriksaan lokal melebihi batas waktu ${this.checkTimeoutMs}ms`))
            }, this.checkTimeoutMs)
        })

        try {
            // Race the check execution with bounded timeout
            const result = await Promise.race([this.executeCheck(abortController.signal), timeoutPromise])

            if (timerHandle) clearTimeout(timerHandle)

            // Verify check validity (Rule 2: CheckId and abort status verification)
            if (this.activeCheckId === checkId && !abortController.signal.aborted && !timedOut) {
                // Apply staged results safely
                if (result.stagedAccounts && result.stagedAccounts.length > 0) {
                    this.onApplyStagedResults(result.stagedAccounts)
                }

                const durationMs = Date.now() - startedAtMs
                const nowIso = new Date().toISOString()
                this.lastCheckedAt = nowIso
                this.lastSuccessfulCheckAt = nowIso
                this.checkingState = 'idle'
                this.lastResultSummary = {
                    accountsChecked: result.accountsChecked,
                    durationMs,
                    errorCount: result.errorCount
                }
                this.log(
                    'info',
                    `Check [${checkId}] completed successfully in ${durationMs}ms (${result.accountsChecked} accounts evaluated)`
                )
            } else {
                this.log('warn', `Check [${checkId}] was cancelled or superseded; staged results discarded`)
            }
        } catch (err: any) {
            if (timerHandle) clearTimeout(timerHandle)

            const durationMs = Date.now() - startedAtMs
            this.checkingState = 'failed'
            this.lastCheckedAt = new Date().toISOString()
            this.lastResultSummary = {
                accountsChecked: 0,
                durationMs,
                errorCount: 1,
                errorMessage: err.message
            }
            this.log('error', `Check [${checkId}] failed: ${err.message}`)
        } finally {
            this.underlyingJobRunning = false
            this.activeCheckId = null
            this.activeAbortController = null

            // Handle pending pause request (Rule 1)
            if (this.pendingPause) {
                this.monitoringState = 'paused'
                this.pendingPause = false
                this.nextCheckAt = undefined
                this.log('info', 'Monitoring paused after active check completion')
            } else if (this.monitoringState === 'running') {
                // Chain next periodic check strictly AFTER previous finishes
                this.scheduleNextCheck()
            }

            this.publishStatus()
        }
    }

    /**
     * Pauses monitoring.
     * If check is in progress, enters pendingPause so active check finishes cleanly within deadline.
     */
    public pause(): MonitoringStatusDto {
        if (this.isStopped) return this.getStatus()

        if (this.scheduleTimer) {
            clearTimeout(this.scheduleTimer)
            this.scheduleTimer = undefined
        }
        this.nextCheckAt = undefined

        if (this.checkingState === 'checking') {
            this.pendingPause = true
            this.log('info', 'Pause requested during active check; will pause upon check completion')
        } else {
            this.monitoringState = 'paused'
            this.pendingPause = false
            this.log('info', 'Monitoring paused')
        }

        this.publishStatus()
        return this.getStatus()
    }

    /**
     * Resumes monitoring.
     * Idempotent: if already running, does not create duplicate timers.
     */
    public resume(): MonitoringStatusDto {
        if (this.isStopped) return this.getStatus()

        if (this.monitoringState === 'running' && !this.pendingPause) {
            // Idempotent no-op
            return this.getStatus()
        }

        this.monitoringState = 'running'
        this.pendingPause = false

        if (this.checkingState === 'idle') {
            this.scheduleNextCheck()
        }

        this.log('info', 'Monitoring resumed')
        this.publishStatus()
        return this.getStatus()
    }

    /**
     * Stops the coordinator and clears all timers and active abort controllers.
     */
    public async stop(): Promise<void> {
        this.isStopped = true

        if (this.scheduleTimer) {
            clearTimeout(this.scheduleTimer)
            this.scheduleTimer = undefined
        }
        if (this.stalenessTimer) {
            clearInterval(this.stalenessTimer)
            this.stalenessTimer = undefined
        }

        if (this.activeAbortController) {
            this.activeAbortController.abort()
            this.activeAbortController = null
        }

        this.monitoringState = 'paused'
        this.checkingState = 'idle'
        this.pendingPause = false
        this.activeCheckId = null
        this.underlyingJobRunning = false
        this.nextCheckAt = undefined

        this.publishStatus()
        this.log('info', 'Coordinator stopped')
    }
}
