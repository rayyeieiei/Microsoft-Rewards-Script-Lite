export type DashboardAccountStatus =
    | 'unknown'
    | 'not-ready'
    | 'auth-required'
    | 'manual-review-required'
    | 'technically-ready-for-handoff'
    | 'blocked'

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

export interface AccountReadinessPublicDto {
    publicRef: string
    displayAccount: string
    status: DashboardAccountStatus
    reasons: string[]
    sessionState: DashboardSessionState
    pendingTaskCount: number
    advertisedPointsRemaining?: number
    lastObservedAt: string
    nextAction: string
    recentFailureCount: number
    tasks: DashboardTaskDto[]
    disclaimer: 'Technical readiness only; not a safety or enforcement prediction'
}

export interface DashboardSnapshotDto {
    summary: DashboardSummaryDto
    accounts: AccountReadinessPublicDto[]
    generatedAt: string
    runtime: {
        status: 'starting' | 'running' | 'degraded' | 'stopping'
        uptimeSeconds: number
        observerOnly: true
    }
}
