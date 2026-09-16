import fs from 'fs'
import path from 'path'
import { Account } from '../interface/Account'
import { TaskHandoffEnvelope } from '../contracts/ExecutionContract'
import {
    AccountReadinessResult,
    SessionState
} from './AccountReadinessTypes'

export interface ExistingRuntimeEvidence {
    sessionValid?: boolean
    sessionExpired?: boolean
    recentFailureCount?: number
    isBlocked?: boolean
    isRateLimited?: boolean
    rateLimitExpiresAt?: string
    lastObservedAt?: string
    source?: 'bridge' | 'local-scan'
    evidenceSequence?: number
}

export interface EvaluatorOptions {
    sessionBasePath?: string
}

export interface EvaluateContextOptions {
    staleThresholdHours?: number
    nowMs?: number
}

export class AccountReadinessEvaluator {
    private readonly sessionBasePath: string

    constructor(options?: EvaluatorOptions) {
        this.sessionBasePath = options?.sessionBasePath
            ? path.resolve(options.sessionBasePath)
            : path.join(process.cwd(), 'browser', 'sessions')
    }

    /**
     * Evaluates technical readiness of an account using only local metadata.
     * Guarantees:
     * - ZERO network requests.
     * - ZERO cookie file reading.
     * - Session file existence produces strictly 'present-unverified'.
     */
    public evaluate(
        account: Account | { id?: string; accountId?: string; email?: string; displayLabel?: string },
        tasks: Array<TaskHandoffEnvelope | any> = [],
        evidence?: ExistingRuntimeEvidence,
        contextOptions?: EvaluateContextOptions
    ): AccountReadinessResult {
        const accountId =
            (account as any).accountId ||
            (account as any).id ||
            (account as any).email ||
            ''
        const displayAccount =
            (account as any).displayLabel ||
            (account as any).email ||
            accountId ||
            'unknown'

        const reasons: string[] = []
        let sessionState: SessionState = 'unknown'
        const recentFailureCount = evidence?.recentFailureCount ?? 0
        const lastObservedAt = evidence?.lastObservedAt || new Date().toISOString()
        const nowMs = contextOptions?.nowMs ?? Date.now()
        const staleHours = contextOptions?.staleThresholdHours ?? 48

        // =========================================================================
        // PRIORITY 1: Identity & Configuration Check
        // =========================================================================
        if (!accountId) {
            reasons.push('Incomplete account credentials in configuration')
            return {
                accountId: 'unknown',
                displayAccount: 'unknown',
                status: 'not-ready',
                reasons,
                sessionState: 'unknown',
                lastObservedAt,
                nextAction: 'Configure valid explicit UUID in configuration',
                recentFailureCount
            }
        }

        // =========================================================================
        // PRIORITY 2: Permanent Restriction Check
        // =========================================================================
        if (evidence?.isBlocked === true || recentFailureCount >= 5) {
            reasons.push(
                `Account locked, permanently restricted, or exceeded failure threshold (${recentFailureCount} failures)`
            )
            return {
                accountId,
                displayAccount,
                status: 'blocked',
                reasons,
                sessionState: evidence?.sessionValid ? 'valid-from-server' : 'unknown',
                lastObservedAt,
                nextAction: 'Inspect local error diagnostics or official portal before retrying',
                recentFailureCount
            }
        }

        // =========================================================================
        // PRIORITY 3: Transient Rate-Limit / Cooldown Check
        // =========================================================================
        if (evidence?.isRateLimited === true) {
            const expiry = evidence.rateLimitExpiresAt ? Date.parse(evidence.rateLimitExpiresAt) : NaN
            const isActive = isNaN(expiry) || expiry > nowMs
            if (isActive) {
                reasons.push(
                    `Account temporarily rate-limited; cooldown active until ${evidence.rateLimitExpiresAt || 'expiry'}`
                )
                return {
                    accountId,
                    displayAccount,
                    status: 'rate-limited',
                    reasons,
                    sessionState: evidence?.sessionValid ? 'valid-from-server' : 'unknown',
                    lastObservedAt,
                    nextAction: 'Wait for temporary rate-limit cooldown expiry',
                    recentFailureCount
                }
            }
        }

        // =========================================================================
        // PRIORITY 4: Server Evidence Check (When server observation exists)
        // =========================================================================
        const hasServerEvidence =
            evidence?.sessionValid !== undefined ||
            evidence?.sessionExpired !== undefined ||
            evidence?.source === 'bridge'

        if (hasServerEvidence) {
            // 4A: Check Staleness
            const observedMs = Date.parse(lastObservedAt)
            const isStale = !isNaN(observedMs) && nowMs - observedMs > staleHours * 3600 * 1000

            if (isStale) {
                sessionState = evidence?.sessionValid
                    ? 'valid-from-existing-runtime-evidence'
                    : 'expired'
                reasons.push(`Server observation is older than ${staleHours} hours (stale evidence)`)
                return {
                    accountId,
                    displayAccount,
                    status: 'stale-evidence',
                    reasons,
                    sessionState,
                    lastObservedAt,
                    nextAction: 'Run Main observation pass to refresh account snapshot',
                    recentFailureCount
                }
            }

            // 4B: Session Expired
            if (evidence?.sessionExpired === true) {
                sessionState = 'expired'
                reasons.push('Session marked expired during runtime pass or server observation')
                return {
                    accountId,
                    displayAccount,
                    status: 'auth-required',
                    reasons,
                    sessionState,
                    lastObservedAt,
                    nextAction: 'Authenticate account manually in official client or browser',
                    recentFailureCount
                }
            }

            // 4C: Session Valid -> Evaluate Task Dimension
            if (evidence?.sessionValid === true) {
                sessionState = 'valid-from-existing-runtime-evidence'
                reasons.push('Session confirmed valid via existing runtime observation')

                let hasManualReview = false
                let hasAwaitingVerification = false
                let hasHandoff = false
                let advertisedPointsRemaining = 0

                for (const t of tasks) {
                    const maybePoints = t.advertisedPoints
                    if (typeof maybePoints === 'number' && maybePoints > 0) {
                        advertisedPointsRemaining += maybePoints
                    }

                    if (t.lifecycleState === 'open' || t.lifecycleState === 'available' || t.lifecycleState === 'in-progress') {
                        if (
                            t.reason === 'interactive-dom-required' ||
                            t.reason === 'official-client-required' ||
                            t.capability === 'requires-interactive-client'
                        ) {
                            hasManualReview = true
                        }
                    } else if (t.lifecycleState === 'action-reported' && t.verificationState === 'unverified') {
                        hasAwaitingVerification = true
                    }

                    if (t.outcome === 'requires-handoff') {
                        hasHandoff = true
                    }
                    if (
                        t.reason === 'interactive-dom-required' ||
                        t.reason === 'official-client-required' ||
                        t.capability === 'requires-interactive-client'
                    ) {
                        hasManualReview = true
                    }
                }

                if (hasManualReview) {
                    reasons.push('Observed activities require interactive client or manual review')
                    return {
                        accountId,
                        displayAccount,
                        status: 'manual-review-required',
                        reasons,
                        sessionState,
                        advertisedPointsRemaining: advertisedPointsRemaining > 0 ? advertisedPointsRemaining : undefined,
                        lastObservedAt,
                        nextAction: 'Perform manual interaction in official client or browser',
                        recentFailureCount
                    }
                }

                if (hasAwaitingVerification) {
                    reasons.push('Operator reported manual action completed; awaiting server verification pass')
                    return {
                        accountId,
                        displayAccount,
                        status: 'awaiting-verification',
                        reasons,
                        sessionState,
                        advertisedPointsRemaining: advertisedPointsRemaining > 0 ? advertisedPointsRemaining : undefined,
                        lastObservedAt,
                        nextAction: 'Wait for next Main observation pass to verify completion',
                        recentFailureCount
                    }
                }

                if (hasHandoff) {
                    reasons.push('Tasks cataloged and technically ready for handoff')
                    return {
                        accountId,
                        displayAccount,
                        status: 'technically-ready-for-handoff',
                        reasons,
                        sessionState,
                        advertisedPointsRemaining: advertisedPointsRemaining > 0 ? advertisedPointsRemaining : undefined,
                        lastObservedAt,
                        nextAction: 'Export or hand off tasks to Main execution engine',
                        recentFailureCount
                    }
                }

                reasons.push(
                    tasks.length > 0
                        ? 'Technical readiness confirmed; all observed tasks are resolved or dismissed'
                        : 'Technical readiness confirmed via server observation'
                )
                return {
                    accountId,
                    displayAccount,
                    status: 'technically-ready-for-handoff',
                    reasons,
                    sessionState,
                    advertisedPointsRemaining: advertisedPointsRemaining > 0 ? advertisedPointsRemaining : undefined,
                    lastObservedAt,
                    nextAction: 'Ready for handoff',
                    recentFailureCount
                }
            }
        }

        // =========================================================================
        // PRIORITY 5: Local Artifact Fallback (Zero Server Evidence)
        // =========================================================================
        const emailOrLabel = (account as any).email || accountId
        const accountSessionDir = path.join(this.sessionBasePath, emailOrLabel)
        const desktopSessionFile = path.join(accountSessionDir, 'session_desktop.json')
        const mobileSessionFile = path.join(accountSessionDir, 'session_mobile.json')

        const hasDesktopSession = fs.existsSync(desktopSessionFile)
        const hasMobileSession = fs.existsSync(mobileSessionFile)

        if (hasDesktopSession || hasMobileSession) {
            sessionState = 'present-unverified'
            reasons.push('Local session artifact located on disk (unverified)')
            return {
                accountId,
                displayAccount,
                status: 'present-unverified',
                reasons,
                sessionState,
                lastObservedAt,
                nextAction: 'Run Main observation pass to verify local session',
                recentFailureCount
            }
        }

        // No session artifact on disk and zero server evidence -> UNKNOWN
        sessionState = 'missing'
        reasons.push('No saved session artifacts found on disk and zero server observations recorded')
        return {
            accountId,
            displayAccount,
            status: 'unknown',
            reasons,
            sessionState,
            lastObservedAt,
            nextAction: 'Awaiting initial observation pass',
            recentFailureCount
        }
    }
}
