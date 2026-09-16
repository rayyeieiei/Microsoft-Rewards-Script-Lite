import crypto from 'crypto'
import { ObserverConfig, ObserverIdentity } from './ObserverConfig'
import { ObserverPaths } from './ObserverPaths'
import { ObserverLock } from './ObserverLock'
import { AccountEvidenceStore, AccountEvidenceRecord } from './AccountEvidenceStore'
import { ManualActionStore } from '../../manual/ManualActionStore'
import { ObservationImporter } from '../../manual/ObservationImporter'
import { ObservationReconciler } from '../../manual/ObservationReconciler'
import { AccountReadinessEvaluator, ExistingRuntimeEvidence } from '../../readiness/AccountReadinessEvaluator'
import { ReadinessSnapshotStore } from '../../dashboard/ReadinessSnapshotStore'
import { DashboardServer } from '../../dashboard/DashboardServer'
import { AccountObservationEnvelope } from '../../contracts/AccountObservationContract'

export type ObserverLifecycleState = 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'

export interface ObserverRuntimeOptions {
    config: ObserverConfig
    identities: ObserverIdentity[]
    logFn?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class ObserverRuntime {
    private readonly config: ObserverConfig
    private readonly identities: ObserverIdentity[]
    private readonly logFn?: (level: 'info' | 'warn' | 'error', message: string) => void

    private state: ObserverLifecycleState = 'stopped'
    private lock: ObserverLock
    private manualActionStore: ManualActionStore
    private accountEvidenceStore: AccountEvidenceStore
    private readinessEvaluator: AccountReadinessEvaluator
    private snapshotStore: ReadinessSnapshotStore
    private dashboardServer?: DashboardServer
    private importer?: ObservationImporter
    private reconciler?: ObservationReconciler

    private stalenessTimer?: NodeJS.Timeout
    private pollTimer?: NodeJS.Timeout
    private stopPromise?: Promise<void>
    private isPolling = false

    constructor(options: ObserverRuntimeOptions) {
        this.config = options.config
        this.identities = options.identities
        this.logFn = options.logFn

        const storageDir = ObserverPaths.resolveStorageDir(this.config.storageDirectory)
        this.lock = new ObserverLock(storageDir)

        this.manualActionStore = new ManualActionStore({
            storePath: ObserverPaths.resolveManualActionStorePath(storageDir),
            allowInWorkerForTesting: true
        })

        this.accountEvidenceStore = new AccountEvidenceStore({
            storePath: ObserverPaths.resolveAccountEvidenceStorePath(storageDir)
        })

        this.readinessEvaluator = new AccountReadinessEvaluator({
            sessionBasePath: ObserverPaths.resolveSessionBasePath(this.config.sessionBasePath)
        })

        const sessionSecret = crypto.randomBytes(32).toString('hex')
        this.snapshotStore = new ReadinessSnapshotStore({
            maxTimelineEntries: 50,
            now: () => Date.now(),
            sessionSecret
        })
    }

    private log(level: 'info' | 'warn' | 'error', message: string): void {
        if (this.logFn) {
            this.logFn(level, message)
        } else {
            if (level === 'error') console.error(`[OBSERVER] ${message}`)
            else if (level === 'warn') console.warn(`[OBSERVER] ${message}`)
            else console.log(`[OBSERVER] ${message}`)
        }
    }

    public getState(): ObserverLifecycleState {
        return this.state
    }

    public getLock(): ObserverLock {
        return this.lock
    }

    public getSnapshotStore(): ReadinessSnapshotStore {
        return this.snapshotStore
    }

    public getManualActionStore(): ManualActionStore {
        return this.manualActionStore
    }

    public getAccountEvidenceStore(): AccountEvidenceStore {
        return this.accountEvidenceStore
    }

    public getDashboardServer(): DashboardServer | undefined {
        return this.dashboardServer
    }

    public getImporter(): ObservationImporter | undefined {
        return this.importer
    }

    /**
     * Starts the observer runtime.
     * Guaranteed fail-fast on lock collision or corrupted stores.
     * Startup errors cleanly rollback and release acquired resources.
     */
    public async start(): Promise<void> {
        if (this.state !== 'stopped') {
            throw new Error(`Cannot start ObserverRuntime: current state is '${this.state}'`)
        }

        this.state = 'starting'
        this.log('info', 'Starting Lite Local Observer Runtime...')

        try {
            // 1. Acquire exclusive single-writer lock
            await this.lock.acquire()
            this.log('info', `Acquired single-writer lock (Instance: ${this.lock.getInstanceId()})`)

            // 2. Initialize persistent stores
            await this.manualActionStore.init()
            await this.accountEvidenceStore.init()

            // 3. Populate initial readiness for all configured identities
            await this.recalculateAllReadiness()

            // 4. Start dashboard server if enabled
            if (this.config.dashboard.enabled) {
                this.dashboardServer = new DashboardServer({
                    config: this.config.dashboard,
                    store: this.snapshotStore,
                    manualActionStore: this.manualActionStore,
                    logFn: (lvl, msg) => this.log(lvl, `[DASHBOARD] ${msg}`)
                })
                await this.dashboardServer.start()
                this.log('info', `Dashboard server listening at http://${this.config.dashboard.host}:${this.config.dashboard.port}`)
            }

            // 5. Start bridge importer if enabled
            if (this.config.observationBridge?.enabled) {
                const bridgeDir = ObserverPaths.resolveBridgeDir(this.config.observationBridge.bridgeDirectory)
                this.importer = new ObservationImporter({
                    bridgeDirectory: bridgeDir,
                    maximumFileBytes: this.config.observationBridge.maximumFileBytes,
                    maxIncomingFiles: this.config.observationBridge.maxIncomingFiles,
                    maxBridgeDirectoryBytes: this.config.observationBridge.maxBridgeDirectoryBytes,
                    processedRetentionHours: this.config.observationBridge.processedRetentionHours,
                    rejectionMetadataRetentionHours: this.config.observationBridge.rejectionMetadataRetentionHours,
                    claimingStaleMs: this.config.observationBridge.claimingStaleMs,
                    allowInWorkerForTesting: true
                })

                await this.importer.init()
                this.reconciler = new ObservationReconciler(this.manualActionStore)
                this.log('info', `Observation bridge intake active on: ${bridgeDir}`)

                this.startBridgePolling(this.config.observationBridge.pollIntervalMs ?? 5000)
            }

            // 6. Setup 60s periodic staleness watcher
            this.stalenessTimer = setInterval(() => {
                void this.recalculateAllReadiness()
            }, 60000)

            this.state = 'running'
            this.log('info', 'Lite Local Observer Runtime is RUNNING')
        } catch (err: any) {
            this.state = 'failed'
            this.log('error', `Startup failed: ${err.message}. Cleaning up allocated resources...`)
            await this.cleanupResources()
            throw err
        }
    }

    private startBridgePolling(intervalMs: number): void {
        const poll = async () => {
            if (this.state !== 'running' || this.isPolling || !this.importer || !this.reconciler) return
            this.isPolling = true

            try {
                const envelopes = await this.importer.scanAndImport()
                if (envelopes.length > 0) {
                    this.log('info', `Imported ${envelopes.length} observation envelope(s) via bridge`)
                    for (const env of envelopes) {
                        await this.processImportedEnvelope(env)
                    }
                    await this.recalculateAllReadiness()
                }
            } catch (err: any) {
                this.log('warn', `Bridge polling error: ${err.message}`)
            } finally {
                this.isPolling = false
            }
        }

        this.pollTimer = setInterval(() => {
            void poll()
        }, intervalMs)
    }

    public async processImportedEnvelope(envelope: AccountObservationEnvelope): Promise<void> {
        if (!this.reconciler) return

        // 1. Reconcile tasks into ManualActionStore
        await this.reconciler.reconcile(envelope)

        // 2. Reconcile account evidence into AccountEvidenceStore
        const matchedIdentity = this.identities.find(
            id => id.accountId === envelope.accountRef || id.displayLabel === envelope.displayAccount
        )
        const accountId = matchedIdentity ? matchedIdentity.accountId : envelope.accountRef

        let sessionState: 'valid-from-server' | 'expired-from-server' | 'present-unverified' | 'unknown' = 'unknown'
        if (envelope.sessionState === 'valid-from-existing-runtime-evidence') {
            sessionState = 'valid-from-server'
        } else if (envelope.sessionState === 'expired') {
            sessionState = 'expired-from-server'
        } else if (envelope.sessionState === 'present-unverified') {
            sessionState = 'present-unverified'
        }

        const evidenceRecord: AccountEvidenceRecord = {
            accountId,
            accountRef: envelope.accountRef,
            displayAccount: envelope.displayAccount,
            sessionState,
            restrictionState: 'none',
            lastObservedAt: envelope.emittedAt,
            lastReceivedAt: new Date().toISOString(),
            source: 'bridge',
            evidenceSequence: envelope.sequence
        }

        await this.accountEvidenceStore.upsertEvidence(evidenceRecord)
    }

    /**
     * Recalculates readiness for all identities and updates snapshot store.
     */
    public async recalculateAllReadiness(): Promise<void> {
        const nowMs = Date.now()

        for (const identity of this.identities) {
            const evidenceRec =
                this.accountEvidenceStore.getEvidence(identity.accountId) ||
                this.accountEvidenceStore.findEvidenceByAccountRef(identity.accountId)

            let runtimeEvidence: ExistingRuntimeEvidence | undefined
            if (evidenceRec) {
                runtimeEvidence = {
                    sessionValid: evidenceRec.sessionState === 'valid-from-server',
                    sessionExpired: evidenceRec.sessionState === 'expired-from-server',
                    isBlocked: evidenceRec.restrictionState === 'blocked',
                    isRateLimited: evidenceRec.restrictionState === 'rate-limited',
                    rateLimitExpiresAt: evidenceRec.rateLimitExpiresAt,
                    lastObservedAt: evidenceRec.lastObservedAt,
                    source: evidenceRec.source,
                    evidenceSequence: evidenceRec.evidenceSequence
                }
            }

            // Query tasks for this account from ManualActionStore
            const taskQuery = this.manualActionStore.query({ accountRef: identity.accountId, limit: 50 })
            const tasks = taskQuery.records

            const readiness = this.readinessEvaluator.evaluate(
                identity,
                tasks as any,
                runtimeEvidence,
                {
                    staleThresholdHours: this.config.staleEvidenceThresholdHours,
                    nowMs
                }
            )

            this.snapshotStore.updateAccount(readiness, tasks as any)
        }
    }

    /**
     * Stops the runtime cleanly with bounded timeout.
     * Idempotent: repeated calls wait on the same shutdown promise.
     */
    public async stop(reason = 'operator-shutdown'): Promise<void> {
        if (this.state === 'stopped') {
            return
        }

        if (this.stopPromise) {
            return this.stopPromise
        }

        this.state = 'stopping'
        this.log('info', `Stopping ObserverRuntime (${reason})...`)

        this.stopPromise = (async () => {
            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error(`Shutdown timed out after ${this.config.shutdownTimeoutMs}ms`)),
                    this.config.shutdownTimeoutMs
                )
            )

            try {
                await Promise.race([this.cleanupResources(), timeoutPromise])
                this.state = 'stopped'
                this.log('info', 'ObserverRuntime STOPPED successfully')
            } catch (err: any) {
                this.state = 'failed'
                this.log('error', `Shutdown failed or timed out: ${err.message}`)
                // Ensure lock is released even if timeout occurs
                await this.lock.release()
                throw err
            } finally {
                this.stopPromise = undefined
            }
        })()

        return this.stopPromise
    }

    private async cleanupResources(): Promise<void> {
        // 1. Clear timers
        if (this.stalenessTimer) {
            clearInterval(this.stalenessTimer)
            this.stalenessTimer = undefined
        }
        if (this.pollTimer) {
            clearInterval(this.pollTimer)
            this.pollTimer = undefined
        }

        // 2. Stop bridge intake
        if (this.importer) {
            this.importer.stop()
        }

        // 3. Stop dashboard server
        if (this.dashboardServer) {
            await this.dashboardServer.stop()
            this.dashboardServer = undefined
        }

        // 4. Flush persistent stores
        try {
            await this.manualActionStore.save()
            await this.accountEvidenceStore.save()
        } catch (err: any) {
            this.log('warn', `Failed to flush stores during shutdown: ${err.message}`)
        }

        // 5. Dispose snapshot store
        this.snapshotStore.dispose()

        // 6. Release lock as the final step
        await this.lock.release()
    }
}
