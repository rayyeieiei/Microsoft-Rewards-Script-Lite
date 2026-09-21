import crypto from 'crypto'
import { AccountReadinessResult } from '../readiness/AccountReadinessTypes'
import { TaskHandoffEnvelope } from '../contracts/ExecutionContract'
import { redactAccountKey } from '../util/Redaction'
import {
    AccountReadinessPublicDto,
    DashboardSnapshotDto,
    DashboardSummaryDto,
    DashboardTaskDto,
    DataSourceStatusDto,
    MonitoringStatusDto,
    BridgeDiagnosticsDto,
    EvidenceState
} from './DashboardTypes'

export class ReadinessDashboardAdapter {
    private readonly sessionSecret: string
    private readonly refMap = new Map<string, string>() // accountId -> publicRef
    private readonly reverseRefMap = new Map<string, string>() // publicRef -> accountId

    constructor(sessionSecret?: string) {
        // Master creates sessionSecret once; can be passed in or created here
        this.sessionSecret = sessionSecret || crypto.randomBytes(32).toString('hex')
    }

    public getSessionSecret(): string {
        return this.sessionSecret
    }

    /**
     * Generates a collision-resistant, deterministic publicRef (min 24 hex chars)
     * using HMAC-SHA256 with the sessionSecret.
     */
    public getOrCreatePublicRef(internalAccountId: string): string {
        const cached = this.refMap.get(internalAccountId)
        if (cached) return cached

        let sliceLen = 24
        const hmac = crypto.createHmac('sha256', this.sessionSecret).update(internalAccountId).digest('hex')
        let candidate = hmac.slice(0, sliceLen)

        // Collision detection: if candidate is already assigned to a DIFFERENT accountId, lengthen slice
        while (this.reverseRefMap.has(candidate) && this.reverseRefMap.get(candidate) !== internalAccountId) {
            sliceLen += 8
            if (sliceLen > hmac.length) {
                // If entire 64 chars collide (virtually impossible), append salt
                candidate = crypto
                    .createHmac('sha256', this.sessionSecret)
                    .update(`${internalAccountId}::${sliceLen}`)
                    .digest('hex')
                    .slice(0, 32)
                break
            }
            candidate = hmac.slice(0, sliceLen)
        }

        this.refMap.set(internalAccountId, candidate)
        this.reverseRefMap.set(candidate, internalAccountId)
        return candidate
    }

    /**
     * Converts a single account's readiness and task handoffs to a public DTO.
     */
    public toAccountPublicDto(
        readiness: AccountReadinessResult,
        tasks: TaskHandoffEnvelope[] = [],
        evidenceMeta?: { lastObservedAt?: string; isStale?: boolean }
    ): AccountReadinessPublicDto {
        const publicRef = this.getOrCreatePublicRef(readiness.accountId)
        const displayAccount = redactAccountKey(readiness.displayAccount)

        let evidenceState: EvidenceState = 'none'
        let evidenceObservedAt: string | undefined = undefined

        if (evidenceMeta?.lastObservedAt) {
            evidenceObservedAt = evidenceMeta.lastObservedAt
            evidenceState = evidenceMeta.isStale ? 'stale' : 'present'
        } else if (readiness.status === 'stale-evidence') {
            evidenceState = 'stale'
            evidenceObservedAt = readiness.lastObservedAt
        } else if (readiness.sessionState === 'valid-from-server' || readiness.sessionState === 'expired-from-server') {
            evidenceState = 'present'
            evidenceObservedAt = readiness.lastObservedAt
        }

        // Convert and sort tasks by observedAt descending
        const taskDtos: DashboardTaskDto[] = tasks
            .map(t => {
                const taskRef = crypto
                    .createHash('sha256')
                    .update(`${t.taskId}::${t.correlationId}`)
                    .digest('hex')
                    .slice(0, 16)

                const maybePoints = (t as any).advertisedPoints
                const advertisedPoints = typeof maybePoints === 'number' && maybePoints > 0 ? maybePoints : undefined

                return {
                    taskRef,
                    title: (t as any).title || `${t.taskKind} Task`,
                    taskKind: t.taskKind,
                    outcome: t.outcome,
                    reason: t.reason,
                    advertisedPoints,
                    observedAt: t.observedAt,
                    expiresAt: t.expiresAt
                }
            })
            .sort((a, b) => {
                const timeA = Date.parse(a.observedAt) || 0
                const timeB = Date.parse(b.observedAt) || 0
                return timeB - timeA
            })

        return {
            publicRef,
            displayAccount,
            status: readiness.status,
            reasons: [...readiness.reasons],
            sessionState: readiness.sessionState,
            evidenceState,
            evidenceObservedAt,
            pendingTaskCount: taskDtos.length,
            advertisedPointsRemaining: readiness.advertisedPointsRemaining,
            lastObservedAt: readiness.lastObservedAt,
            nextAction: readiness.nextAction,
            recentFailureCount: readiness.recentFailureCount,
            tasks: taskDtos,
            disclaimer: 'Technical readiness only; not a safety or enforcement prediction'
        }
    }

    /**
     * Creates an immutable DashboardSnapshotDto with recalculated summary counters,
     * monotonic revision, runtime metadata, and data source loading status.
     */
    public createSnapshot(
        accountDtos: AccountReadinessPublicDto[],
        runtimeInfo: {
            status: 'starting' | 'running' | 'degraded' | 'stopping'
            uptimeSeconds: number
            observerOnly: true
            runtimeStartTime?: string
        },
        meta?: {
            revision?: number
            runtimeId?: string
            dataSource?: DataSourceStatusDto
            monitoring?: MonitoringStatusDto
            bridgeDiagnostics?: BridgeDiagnosticsDto
        }
    ): DashboardSnapshotDto {
        // Deterministic sort by displayAccount
        const sortedAccounts = [...accountDtos].sort((a, b) => a.displayAccount.localeCompare(b.displayAccount))

        // Recalculate summary counters
        let unknown = 0
        let notReady = 0
        let authRequired = 0
        let manualReviewRequired = 0
        let technicallyReadyForHandoff = 0
        let blocked = 0

        for (const acc of sortedAccounts) {
            switch (acc.status) {
                case 'not-ready':
                    notReady++
                    break
                case 'auth-required':
                    authRequired++
                    break
                case 'manual-review-required':
                    manualReviewRequired++
                    break
                case 'technically-ready-for-handoff':
                case 'technically-ready':
                    technicallyReadyForHandoff++
                    break
                case 'blocked':
                case 'rate-limited':
                    blocked++
                    break
                case 'unknown':
                case 'stale-evidence':
                case 'awaiting-verification':
                case 'present-unverified':
                default:
                    unknown++
                    break
            }
        }

        const totalAccounts = sortedAccounts.length
        const summary: DashboardSummaryDto = {
            totalAccounts,
            unknown,
            notReady,
            authRequired,
            manualReviewRequired,
            technicallyReadyForHandoff,
            blocked,
            generatedAt: new Date().toISOString()
        }

        const defaultDataSource: DataSourceStatusDto = {
            status: totalAccounts > 0 ? 'loaded' : 'empty',
            sourceFile: 'accounts.json',
            environmentMode: 'normal',
            acceptedCount: totalAccounts,
            rejectedCount: 0,
            rejectionReasons: []
        }

        const runtimeStartTime =
            runtimeInfo.runtimeStartTime || new Date(Date.now() - runtimeInfo.uptimeSeconds * 1000).toISOString()

        const rawDataSource = meta?.dataSource ?? defaultDataSource
        const activeDataSource: DataSourceStatusDto = {
            status: rawDataSource.status,
            sourceFile: rawDataSource.sourceFile,
            environmentMode: rawDataSource.environmentMode,
            lastLoadedAt: rawDataSource.lastLoadedAt,
            acceptedCount: rawDataSource.acceptedCount,
            rejectedCount: rawDataSource.rejectedCount,
            rejections: rawDataSource.rejections ? rawDataSource.rejections.map(r => ({ ...r })) : undefined,
            rejectionReasons: [...(rawDataSource.rejectionReasons || [])],
            error: rawDataSource.error ? { ...rawDataSource.error } : undefined
        }
        const activeMonitoring: MonitoringStatusDto = meta?.monitoring ?? {
            monitoringState: 'running',
            checkingState: 'idle'
        }

        return {
            revision: meta?.revision ?? 1,
            runtimeId: meta?.runtimeId ?? 'local-observer-runtime',
            summary,
            dataSource: activeDataSource,
            monitoring: activeMonitoring,
            bridgeDiagnostics: meta?.bridgeDiagnostics,
            accounts: sortedAccounts,
            generatedAt: summary.generatedAt,
            runtime: {
                status: runtimeInfo.status,
                uptimeSeconds: runtimeInfo.uptimeSeconds,
                observerOnly: true,
                modeLabel: 'Observer lokal',
                description: 'Memantau konfigurasi dan status lokal. Tidak menjalankan aktivitas perolehan poin.',
                runtimeStartTime,
                environmentMode: activeDataSource.environmentMode || 'normal'
            }
        }
    }
}
