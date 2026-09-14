import crypto from 'crypto'
import { AccountReadinessResult } from '../readiness/AccountReadinessTypes'
import { TaskHandoffEnvelope } from '../contracts/ExecutionContract'
import { redactAccountKey } from '../util/Redaction'
import {
    AccountReadinessPublicDto,
    DashboardSnapshotDto,
    DashboardSummaryDto,
    DashboardTaskDto
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
        tasks: TaskHandoffEnvelope[] = []
    ): AccountReadinessPublicDto {
        const publicRef = this.getOrCreatePublicRef(readiness.accountId)
        const displayAccount = redactAccountKey(readiness.displayAccount)

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
     * Creates an immutable DashboardSnapshotDto with recalculated summary counters.
     */
    public createSnapshot(
        accountDtos: AccountReadinessPublicDto[],
        runtimeInfo: {
            status: 'starting' | 'running' | 'degraded' | 'stopping'
            uptimeSeconds: number
            observerOnly: true
        }
    ): DashboardSnapshotDto {
        // Deterministic sort by displayAccount
        const sortedAccounts = [...accountDtos].sort((a, b) =>
            a.displayAccount.localeCompare(b.displayAccount)
        )

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
                    technicallyReadyForHandoff++
                    break
                case 'blocked':
                    blocked++
                    break
                case 'unknown':
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

        return {
            summary,
            accounts: sortedAccounts,
            generatedAt: summary.generatedAt,
            runtime: { ...runtimeInfo }
        }
    }
}
