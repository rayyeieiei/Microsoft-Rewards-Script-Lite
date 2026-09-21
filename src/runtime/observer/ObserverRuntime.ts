import path from 'path'
import crypto from 'crypto'
import {
    ObserverConfig,
    ObserverIdentity,
    ObserverSourceSelection,
    resolveObserverSourceSelection
} from './ObserverConfig'
import { ObserverPaths } from './ObserverPaths'
import { ObserverLock } from './ObserverLock'
import { AccountLoader } from './AccountLoader'
import { AccountEvidenceStore, AccountEvidenceRecord } from './AccountEvidenceStore'
import { ManualActionStore } from '../../manual/ManualActionStore'
import { ObservationImporter } from '../../manual/ObservationImporter'
import { ObservationReconciler } from '../../manual/ObservationReconciler'
import { AccountReadinessEvaluator, ExistingRuntimeEvidence } from '../../readiness/AccountReadinessEvaluator'
import { ReadinessSnapshotStore } from '../../dashboard/ReadinessSnapshotStore'
import { DashboardServer } from '../../dashboard/DashboardServer'
import { AccountObservationEnvelope, computeStableAccountRef } from '../../contracts/AccountObservationContract'
import { ObserverCoordinator, StagedAccountReadiness, CheckExecutionResult } from './ObserverCoordinator'

export type ObserverLifecycleState = 'starting' | 'running' | 'degraded' | 'stopping' | 'stopped' | 'failed'

export interface ObserverRuntimeOptions {
    config: ObserverConfig
    identities?: ObserverIdentity[]
    configDir?: string
    mode?: 'normal' | 'development'
    sourceSelection?: ObserverSourceSelection
    logFn?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class ObserverRuntime {
    private readonly config: ObserverConfig
    private readonly configDir: string
    private identities: ObserverIdentity[]
    private readonly logFn?: (level: 'info' | 'warn' | 'error', message: string) => void

    private state: ObserverLifecycleState = 'stopped'
    private lock: ObserverLock
    private manualActionStore: ManualActionStore
    private accountEvidenceStore: AccountEvidenceStore
    private readinessEvaluator: AccountReadinessEvaluator
    private snapshotStore: ReadinessSnapshotStore
    private dashboardServer?: DashboardServer
    private coordinator: ObserverCoordinator
    private importer?: ObservationImporter
    private reconciler?: ObservationReconciler
    private bridgeReferenceKey: Buffer | null = null

    private pollTimer?: NodeJS.Timeout
    private readonly sourceSelection: ObserverSourceSelection
    private stopPromise?: Promise<void>
    private isPolling = false
    private explicitIdentitiesProvided = false

    constructor(options: ObserverRuntimeOptions) {
        this.config = options.config
        this.configDir = options.configDir || options.config.configDir || process.cwd()
        this.logFn = options.logFn

        const cliArgs = options.mode ? (options.mode === 'development' ? ['-dev'] : []) : process.argv
        this.sourceSelection =
            options.sourceSelection || resolveObserverSourceSelection(this.config, this.configDir, cliArgs)

        if (options.identities) {
            this.identities = [...options.identities]
            this.explicitIdentitiesProvided = true
        } else {
            this.identities = []
        }

        const storageDir = ObserverPaths.resolveStorageDir(this.config.storageDirectory, this.configDir)
        this.lock = new ObserverLock(storageDir)

        this.manualActionStore = new ManualActionStore({
            storePath: ObserverPaths.resolveManualActionStorePath(storageDir),
            allowInWorkerForTesting: true
        })

        this.accountEvidenceStore = new AccountEvidenceStore({
            storePath: ObserverPaths.resolveAccountEvidenceStorePath(storageDir)
        })

        this.readinessEvaluator = new AccountReadinessEvaluator({
            sessionBasePath: ObserverPaths.resolveSessionBasePath(this.config.sessionBasePath, this.configDir)
        })

        const sessionSecret = crypto.randomBytes(32).toString('hex')
        this.snapshotStore = new ReadinessSnapshotStore({
            maxTimelineEntries: 50,
            now: () => Date.now(),
            sessionSecret
        })

        if (this.explicitIdentitiesProvided) {
            this.snapshotStore.setDataSourceStatus({
                status: this.identities.length > 0 ? 'loaded' : 'empty',
                sourceFile: this.sourceSelection.sourceFile,
                environmentMode: this.sourceSelection.environmentMode,
                acceptedCount: this.identities.length,
                rejectedCount: 0,
                rejectionReasons: []
            })
        }

        this.coordinator = new ObserverCoordinator({
            checkIntervalMs: this.config.checkIntervalMs,
            checkTimeoutMs: this.config.checkTimeoutMs,
            stalenessIntervalMs: 60000,
            snapshotStore: this.snapshotStore,
            executeCheck: async (signal: AbortSignal) => this.executeLocalCheck(signal),
            onApplyStagedResults: staged => {
                for (const item of staged) {
                    this.snapshotStore.updateAccount(item.readiness, item.tasks, item.evidenceMeta)
                }
            },
            onCheckStaleness: async () => {
                await this.executeStalenessSweep()
            },
            onDegraded: reason => {
                this.state = 'degraded'
                this.snapshotStore.setRuntimeStatus('degraded')
                this.log('warn', `Coordinator degraded runtime: ${reason}`)
            },
            logFn: (lvl, msg) => this.log(lvl, msg)
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

    public getIdentities(): ObserverIdentity[] {
        return [...this.identities]
    }

    public getSourceSelection(): ObserverSourceSelection {
        return { ...this.sourceSelection }
    }

    public getCoordinator(): ObserverCoordinator {
        return this.coordinator
    }

    /**
     * Starts the observer runtime.
     * Guaranteed fail-fast on lock collision or corrupted stores.
     * If account data source fails, transitions to degraded mode while keeping dashboard active.
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

            // 3. Load identities unless explicitly provided
            let isDegraded = false
            if (!this.explicitIdentitiesProvided) {
                const loadResult = AccountLoader.load(
                    this.configDir,
                    this.sourceSelection.sourcePath,
                    this.sourceSelection.environmentMode
                )
                this.snapshotStore.setDataSourceStatus(loadResult)

                if (loadResult.status === 'failed') {
                    isDegraded = true
                    this.identities = []
                    this.snapshotStore.setRuntimeStatus('degraded')
                    this.log(
                        'warn',
                        `Data source failed to load: ${loadResult.error?.message}. Running in degraded mode.`
                    )
                } else if (loadResult.status === 'empty') {
                    this.identities = []
                    this.snapshotStore.setRuntimeStatus('running')
                    this.log('info', `Data source is empty (0 accounts configured in ${loadResult.sourceFile}).`)
                } else {
                    this.identities = loadResult.identities
                    this.snapshotStore.setRuntimeStatus('running')
                    this.log(
                        'info',
                        `Successfully loaded ${loadResult.acceptedCount} account(s) from ${loadResult.sourceFile} (${loadResult.rejectedCount} rejected).`
                    )
                }
            }

            // 4. Populate initial readiness for all valid identities
            if (this.identities.length > 0) {
                await this.recalculateAllReadiness()
            }

            // 5. Start dashboard server if enabled (always started even in degraded mode)
            if (this.config.dashboard.enabled) {
                this.dashboardServer = new DashboardServer({
                    config: this.config.dashboard,
                    store: this.snapshotStore,
                    manualActionStore: this.manualActionStore,
                    coordinator: this.coordinator,
                    logFn: (lvl, msg) => this.log(lvl, `[DASHBOARD] ${msg}`)
                })
                await this.dashboardServer.start()
                this.log(
                    'info',
                    `Dashboard server listening at http://${this.config.dashboard.host}:${this.config.dashboard.port}`
                )
            }

            // 6. Load bridge reference key if configured (fail-fast on missing/corrupt key)
            this.bridgeReferenceKey = ObserverPaths.loadBridgeReferenceKey(
                this.config.bridgeReferenceKeyPath,
                this.configDir
            )

            // 7. Start bridge importer if enabled
            if (this.config.observationBridge?.enabled) {
                const bridgeDir = ObserverPaths.resolveBridgeDir(
                    this.config.observationBridge.bridgeDirectory,
                    this.configDir
                )
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

                await this.updateBridgeDiagnostics()
                this.startBridgePolling(this.config.observationBridge.pollIntervalMs ?? 5000)
            } else {
                await this.updateBridgeDiagnostics()
            }

            // 8. Start coordinator (schedules periodic checks and staleness tracking)
            this.coordinator.start()

            this.state = isDegraded ? 'degraded' : 'running'
            this.log('info', `Lite Local Observer Runtime is ${this.state.toUpperCase()}`)
        } catch (err: any) {
            this.state = 'failed'
            this.log('error', `Startup failed: ${err.message}. Cleaning up allocated resources...`)
            await this.cleanupResources()
            throw err
        }
    }

    public async updateBridgeDiagnostics(): Promise<void> {
        if (!this.importer || !this.config.observationBridge?.enabled) {
            this.snapshotStore.setBridgeDiagnostics({
                status: 'disabled',
                activeDirectory: 'bridge',
                incomingFileCount: 0,
                processedCount: 0,
                rejectedCount: 0
            })
            return
        }

        const summary = await this.importer.getDiagnosticsSummary()
        const fullBridgeDir = this.importer.getBridgeDirectory()
        let relativeDir = path.relative(this.configDir, fullBridgeDir).replace(/\\/g, '/')
        if (!relativeDir || relativeDir === '') relativeDir = 'bridge'
        else if (relativeDir.startsWith('..')) relativeDir = path.basename(fullBridgeDir)

        this.snapshotStore.setBridgeDiagnostics({
            status: 'active',
            activeDirectory: relativeDir,
            incomingFileCount: summary.incomingFileCount,
            processedCount: summary.processedCount,
            rejectedCount: summary.rejectedCount,
            lastImportedAt: summary.lastImportedAt,
            lastDiagnosticMessage: summary.lastDiagnosticMessage
        })
    }

    private startBridgePolling(intervalMs: number): void {
        const poll = async () => {
            if (
                (this.state !== 'running' && this.state !== 'degraded') ||
                this.isPolling ||
                !this.importer ||
                !this.reconciler
            )
                return
            this.isPolling = true

            try {
                const envelopes = await this.importer.scanAndImport()
                if (envelopes.length > 0) {
                    this.log('info', `Imported ${envelopes.length} observation envelope(s) via bridge`)
                    for (const env of envelopes) {
                        await this.processImportedEnvelope(env)
                    }
                    this.coordinator.triggerCheck('bridge')
                }
                await this.updateBridgeDiagnostics()
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
        if (!this.reconciler || !this.importer) return

        const nowMs = Date.now()

        // Stage 2: Deterministic 1:1 Identity Matching
        // Match strategies:
        // 1. Exact match on accountId
        // 2. If bridgeReferenceKey configured, HMAC-SHA256(key, accountId) === envelope.accountRef
        // 3. Case-insensitive accountId match (for email accounts)
        const matchedIdentities = this.identities.filter(id => {
            if (id.accountId === envelope.accountRef) return true
            if (this.bridgeReferenceKey) {
                const hmac = computeStableAccountRef(this.bridgeReferenceKey, id.accountId)
                if (hmac === envelope.accountRef) return true
            }
            const sha256Slice = crypto.createHash('sha256').update(id.accountId).digest('hex').slice(0, 32)
            if (sha256Slice === envelope.accountRef) return true
            const sha256Full = crypto.createHash('sha256').update(id.accountId).digest('hex')
            if (sha256Full === envelope.accountRef) return true
            if (id.accountId.toLowerCase() === envelope.accountRef.toLowerCase()) return true
            return false
        })

        if (matchedIdentities.length === 0) {
            const warnMsg = `Unmatched accountRef: ${envelope.accountRef}`
            this.log('warn', `Observation envelope rejected: ${warnMsg}`)
            await this.importer.recordCustomRejection(
                `obs_${nowMs}_${envelope.observationId}.json`,
                JSON.stringify(envelope, null, 2),
                warnMsg
            )
            await this.updateBridgeDiagnostics()
            return
        }

        if (matchedIdentities.length > 1) {
            const warnMsg = `Ambiguous accountRef collision: ${envelope.accountRef} matched ${matchedIdentities.length} accounts`
            this.log('warn', `Observation envelope rejected: ${warnMsg}`)
            await this.importer.recordCustomRejection(
                `obs_${nowMs}_${envelope.observationId}.json`,
                JSON.stringify(envelope, null, 2),
                warnMsg
            )
            await this.updateBridgeDiagnostics()
            return
        }

        const matchedIdentity = matchedIdentities[0]
        if (!matchedIdentity) return

        // Stage 3: Freshness & Clock-Skew Validation
        const emittedMs = Date.parse(envelope.emittedAt)
        if (isNaN(emittedMs) || emittedMs > nowMs + 5 * 60 * 1000) {
            const warnMsg = `Clock skew anomaly: emittedAt ${envelope.emittedAt} is in the future (> 5 min)`
            this.log('warn', `Observation envelope rejected: ${warnMsg}`)
            await this.importer.recordCustomRejection(
                `obs_${nowMs}_${envelope.observationId}.json`,
                JSON.stringify(envelope, null, 2),
                warnMsg
            )
            await this.updateBridgeDiagnostics()
            return
        }

        // Canonical observedAt from newest task <= nowMs + 5min, or emittedAt
        let canonicalObservedAt = envelope.emittedAt
        if (envelope.tasks && envelope.tasks.length > 0) {
            let newestTaskObservedMs = 0
            for (const task of envelope.tasks) {
                const taskObsMs = Date.parse(task.observedAt)
                if (!isNaN(taskObsMs) && taskObsMs <= nowMs + 5 * 60 * 1000 && taskObsMs > newestTaskObservedMs) {
                    newestTaskObservedMs = taskObsMs
                    canonicalObservedAt = task.observedAt
                }
            }
        }

        // Stage 4: Session Observation Extraction
        let sessionState: 'valid-from-server' | 'expired-from-server' | 'present-unverified' | 'unknown' = 'unknown'
        if (envelope.sessionState === 'valid-from-existing-runtime-evidence') {
            sessionState = 'valid-from-server'
        } else if (envelope.sessionState === 'expired') {
            sessionState = 'expired-from-server'
        } else if (envelope.sessionState === 'present-unverified') {
            sessionState = 'present-unverified'
        }

        // 1. Reconcile tasks into ManualActionStore for this specific matched identity
        await this.reconciler.reconcile(envelope, matchedIdentity.accountId)

        // 2. Reconcile account evidence into AccountEvidenceStore
        const evidenceRecord: AccountEvidenceRecord = {
            accountId: matchedIdentity.accountId,
            accountRef: envelope.accountRef,
            displayAccount: matchedIdentity.displayLabel || envelope.displayAccount,
            sessionState,
            restrictionState: 'none',
            lastObservedAt: canonicalObservedAt,
            lastReceivedAt: new Date().toISOString(),
            source: 'bridge',
            evidenceSequence: envelope.sequence
        }

        await this.accountEvidenceStore.upsertEvidence(evidenceRecord)
    }

    /**
     * Executes local check across all loaded identities.
     * Cooperatively respects abort signal between account checks.
     * Evaluates against local stores and disk artifacts with zero network calls.
     */
    public async executeLocalCheck(signal?: AbortSignal): Promise<CheckExecutionResult> {
        let accountsChecked = 0
        let errorCount = 0
        const stagedAccounts: StagedAccountReadiness[] = []
        const nowMs = Date.now()

        for (const identity of this.identities) {
            if (signal?.aborted) {
                throw new Error('Check operation was aborted')
            }

            try {
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

                const readiness = this.readinessEvaluator.evaluate(identity, tasks as any, runtimeEvidence, {
                    staleThresholdHours: this.config.staleEvidenceThresholdHours,
                    nowMs
                })

                const isStale = evidenceRec
                    ? this.accountEvidenceStore.isStale(
                          evidenceRec,
                          this.config.staleEvidenceThresholdHours,
                          nowMs
                      )
                    : false

                stagedAccounts.push({
                    readiness,
                    tasks: tasks as any,
                    evidenceMeta: evidenceRec
                        ? { lastObservedAt: evidenceRec.lastObservedAt, isStale }
                        : undefined
                })
                accountsChecked++
            } catch (err: any) {
                errorCount++
                this.log('warn', `Failed evaluating readiness for account ${identity.accountId}: ${err.message}`)
            }
        }

        return { accountsChecked, errorCount, stagedAccounts }
    }

    /**
     * Performs a background staleness sweep even when monitoring is paused.
     * Ensures evidence age is strictly tracked against real wall-clock time.
     */
    public async executeStalenessSweep(): Promise<void> {
        const nowMs = Date.now()
        for (const identity of this.identities) {
            const evidenceRec =
                this.accountEvidenceStore.getEvidence(identity.accountId) ||
                this.accountEvidenceStore.findEvidenceByAccountRef(identity.accountId)

            if (!evidenceRec) continue

            const runtimeEvidence: ExistingRuntimeEvidence = {
                sessionValid: evidenceRec.sessionState === 'valid-from-server',
                sessionExpired: evidenceRec.sessionState === 'expired-from-server',
                isBlocked: evidenceRec.restrictionState === 'blocked',
                isRateLimited: evidenceRec.restrictionState === 'rate-limited',
                rateLimitExpiresAt: evidenceRec.rateLimitExpiresAt,
                lastObservedAt: evidenceRec.lastObservedAt,
                source: evidenceRec.source,
                evidenceSequence: evidenceRec.evidenceSequence
            }

            const taskQuery = this.manualActionStore.query({ accountRef: identity.accountId, limit: 50 })
            const tasks = taskQuery.records

            const readiness = this.readinessEvaluator.evaluate(identity, tasks as any, runtimeEvidence, {
                staleThresholdHours: this.config.staleEvidenceThresholdHours,
                nowMs
            })

            const isStale = this.accountEvidenceStore.isStale(
                evidenceRec,
                this.config.staleEvidenceThresholdHours,
                nowMs
            )

            this.snapshotStore.updateAccount(readiness, tasks as any, {
                lastObservedAt: evidenceRec.lastObservedAt,
                isStale
            })
        }
    }

    /**
     * Recalculates readiness for all identities and updates snapshot store.
     */
    public async recalculateAllReadiness(): Promise<void> {
        const result = await this.executeLocalCheck()
        if (result.stagedAccounts) {
            for (const item of result.stagedAccounts) {
                this.snapshotStore.updateAccount(item.readiness, item.tasks, item.evidenceMeta)
            }
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
        // 1. Stop coordinator
        await this.coordinator.stop()

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
