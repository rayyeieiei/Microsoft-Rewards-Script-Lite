export type DashboardAccountStatus =
    | 'unknown'
    | 'not-ready'
    | 'auth-required'
    | 'manual-review-required'
    | 'technically-ready-for-handoff'
    | 'technically-ready'
    | 'blocked'
    | 'rate-limited'
    | 'stale-evidence'
    | 'awaiting-verification'
    | 'present-unverified'

export interface DashboardSummaryDto {
    totalAccounts: number
    unknown: number
    notReady: number
    authRequired: number
    manualReviewRequired: number
    technicallyReadyForHandoff: number
    blocked: number
    generatedAt: string
}

export interface DashboardTaskDto {
    taskRef: string
    title: string
    taskKind: string
    outcome: string
    reason: string
    advertisedPoints?: number
    observedAt: string
    expiresAt?: string
}

export type DashboardSessionState =
    | 'valid'
    | 'missing'
    | 'present-unverified'
    | 'expired'
    | 'unknown'
    | 'interactive-required'
    | 'valid-from-existing-runtime-evidence'
    | 'valid-from-server'
    | 'expired-from-server'

export type EvidenceState = 'none' | 'present' | 'stale'

export interface AccountReadinessPublicDto {
    publicRef: string
    displayAccount: string
    status: DashboardAccountStatus
    reasons: string[]
    sessionState: DashboardSessionState
    evidenceState: EvidenceState
    evidenceObservedAt?: string
    pendingTaskCount: number
    advertisedPointsRemaining?: number
    lastObservedAt: string
    nextAction: string
    recentFailureCount: number
    tasks: DashboardTaskDto[]
    disclaimer: 'Technical readiness only; not a safety or enforcement prediction'
}

export interface AccountRejectionPublicDetail {
    identifier?: string
    reason: string
    code: 'duplicate' | 'invalid-format' | 'missing-field' | 'security-violation' | 'unknown'
}

export interface DataSourceStatusDto {
    status: 'loading' | 'loaded' | 'empty' | 'failed'
    sourceFile: string
    environmentMode: 'normal' | 'development'
    lastLoadedAt?: string
    acceptedCount: number
    rejectedCount: number
    rejections?: AccountRejectionPublicDetail[]
    rejectionReasons: string[]
    error?: {
        code:
            | 'file-not-found'
            | 'permission-denied'
            | 'malformed-json'
            | 'security-violation'
            | 'invalid-schema'
            | 'unknown'
        message: string
        remediation: string
    }
}

export interface MonitoringResultSummaryDto {
    accountsChecked: number
    durationMs: number
    errorCount: number
    errorMessage?: string
}

export interface MonitoringStatusDto {
    monitoringState: 'running' | 'paused'
    checkingState: 'idle' | 'checking' | 'failed'
    pendingPause?: boolean
    activeCheckId?: string
    lastCheckedAt?: string
    lastSuccessfulCheckAt?: string
    nextCheckAt?: string
    lastResultSummary?: MonitoringResultSummaryDto
}

export interface BridgeDiagnosticsDto {
    status: 'disabled' | 'active' | 'idle' | 'error'
    activeDirectory: string
    incomingFileCount: number
    processedCount: number
    rejectedCount: number
    lastImportedAt?: string
    lastDiagnosticMessage?: string
}

export interface DashboardSnapshotDto {
    revision: number
    runtimeId: string
    summary: DashboardSummaryDto
    dataSource: DataSourceStatusDto
    monitoring: MonitoringStatusDto
    bridgeDiagnostics?: BridgeDiagnosticsDto
    accounts: AccountReadinessPublicDto[]
    generatedAt: string
    runtime: {
        status: 'starting' | 'running' | 'degraded' | 'stopping'
        uptimeSeconds: number
        observerOnly: true
        modeLabel: 'Observer lokal'
        description: 'Memantau konfigurasi dan status lokal. Tidak menjalankan aktivitas perolehan poin.'
        runtimeStartTime: string
        environmentMode: 'normal' | 'development'
    }
}
