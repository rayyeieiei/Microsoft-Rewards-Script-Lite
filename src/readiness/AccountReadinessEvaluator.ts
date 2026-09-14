import fs from 'fs'
import path from 'path'
import { Account } from '../interface/Account'
import { TaskHandoffEnvelope } from '../contracts/ExecutionContract'
import {
    AccountReadinessResult,
    AccountReadinessStatus,
    SessionState
} from './AccountReadinessTypes'

export interface ExistingRuntimeEvidence {
    sessionValid?: boolean
    sessionExpired?: boolean
    recentFailureCount?: number
    isBlocked?: boolean
    lastObservedAt?: string
}

export interface EvaluatorOptions {
    sessionBasePath?: string
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
        account: Account,
        tasks: TaskHandoffEnvelope[] = [],
        evidence?: ExistingRuntimeEvidence
    ): AccountReadinessResult {
        const accountId = account.id || account.email
        const displayAccount = account.email
        const reasons: string[] = []
        let status: AccountReadinessStatus = 'unknown'
        let sessionState: SessionState = 'unknown'
        let nextAction = 'Awaiting initial observation pass'
        const recentFailureCount = evidence?.recentFailureCount ?? 0
        const lastObservedAt = evidence?.lastObservedAt || new Date().toISOString()

        // 1. Credentials Check
        if (!account.email || !account.password) {
            reasons.push('Incomplete account credentials in configuration')
            status = 'not-ready'
            nextAction = 'Configure complete email and password in accounts.json'
        }

        // 2. Session Presence Check (Zero cookie file read)
        if (evidence?.sessionValid === true) {
            sessionState = 'valid-from-existing-runtime-evidence'
            reasons.push('Session confirmed valid via existing runtime observation')
        } else if (evidence?.sessionExpired === true) {
            sessionState = 'expired'
            reasons.push('Session marked expired during runtime pass')
            status = 'auth-required'
            nextAction = 'Authenticate account manually in browser session'
        } else {
            // Check session file presence on disk without opening it
            const accountSessionDir = path.join(this.sessionBasePath, account.email)
            const desktopSessionFile = path.join(accountSessionDir, 'session_desktop.json')
            const mobileSessionFile = path.join(accountSessionDir, 'session_mobile.json')

            const hasDesktopSession = fs.existsSync(desktopSessionFile)
            const hasMobileSession = fs.existsSync(mobileSessionFile)

            if (hasDesktopSession || hasMobileSession) {
                // Strict requirement: File presence ONLY yields present-unverified
                sessionState = 'present-unverified'
                reasons.push('Local session artifact located on disk (unverified)')
            } else {
                sessionState = 'missing'
                reasons.push('No saved session artifacts found on disk')
                if (status !== 'not-ready') {
                    status = 'auth-required'
                    nextAction = 'Log in to account to create local session'
                }
            }
        }

        // 3. Blocked / Rate-limited Check
        if (evidence?.isBlocked === true || recentFailureCount >= 5) {
            status = 'blocked'
            reasons.push(`Account locked, rate-limited, or exceeded failure threshold (${recentFailureCount} failures)`)
            nextAction = 'Inspect local error diagnostics before retrying'
        }

        // 4. Tasks Analysis
        let advertisedPointsRemaining = 0
        let hasManualReviewTask = false
        let hasHandoffTask = false

        for (const task of tasks) {
            if (task.outcome === 'requires-handoff') {
                hasHandoffTask = true
            }
            if (
                task.reason === 'interactive-dom-required' ||
                task.reason === 'official-client-required' ||
                task.capability === 'requires-interactive-client'
            ) {
                hasManualReviewTask = true
            }
            // Add any advertised points if available in task (informational only)
            const maybePoints = (task as any).advertisedPoints
            if (typeof maybePoints === 'number' && maybePoints > 0) {
                advertisedPointsRemaining += maybePoints
            }
        }

        // 5. Final Status Resolution
        if (status !== 'blocked' && status !== 'not-ready') {
            if (sessionState === 'expired' || sessionState === 'missing') {
                status = 'auth-required'
                nextAction = 'Authenticate account manually in browser session'
            } else if (hasManualReviewTask) {
                status = 'manual-review-required'
                reasons.push('Observed activities require interactive client or manual review')
                nextAction = 'Perform manual interaction in official client or browser'
            } else if (hasHandoffTask) {
                status = 'technically-ready-for-handoff'
                reasons.push('Tasks cataloged and technically ready for handoff')
                nextAction = 'Export or hand off tasks to Main execution engine'
            } else if (sessionState === 'present-unverified' || sessionState === 'valid-from-existing-runtime-evidence') {
                if (tasks.length > 0) {
                    status = 'technically-ready-for-handoff'
                    nextAction = 'Ready for handoff'
                } else {
                    status = 'unknown'
                    nextAction = 'Awaiting task discovery'
                }
            }
        }

        return {
            accountId,
            displayAccount,
            status,
            reasons,
            sessionState,
            advertisedPointsRemaining: advertisedPointsRemaining > 0 ? advertisedPointsRemaining : undefined,
            lastObservedAt,
            nextAction,
            recentFailureCount
        }
    }
}
