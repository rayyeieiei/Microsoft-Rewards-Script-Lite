import { z } from 'zod'
import { TaskHandoffEnvelope, TaskHandoffEnvelopeSchema, containsForbiddenKeys } from '../contracts/ExecutionContract'

export type AccountReadinessStatus =
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

export type SessionState =
    | 'missing'
    | 'present-unverified'
    | 'expired'
    | 'interactive-required'
    | 'valid-from-existing-runtime-evidence'
    | 'valid-from-server'
    | 'expired-from-server'
    | 'unknown'

export interface AccountReadinessResult {
    accountId: string
    displayAccount: string
    status: AccountReadinessStatus
    reasons: string[]
    sessionState: SessionState
    advertisedPointsRemaining?: number
    lastObservedAt: string
    nextAction: string
    recentFailureCount: number
}

export const AccountReadinessStatusSchema = z.enum([
    'unknown',
    'not-ready',
    'auth-required',
    'manual-review-required',
    'technically-ready-for-handoff',
    'technically-ready',
    'blocked',
    'rate-limited',
    'stale-evidence',
    'awaiting-verification',
    'present-unverified'
])

export const SessionStateSchema = z.enum([
    'missing',
    'present-unverified',
    'expired',
    'interactive-required',
    'valid-from-existing-runtime-evidence',
    'valid-from-server',
    'expired-from-server',
    'unknown'
])

export const AccountReadinessResultSchema = z
    .object({
        accountId: z.string().min(1),
        displayAccount: z.string().min(1),
        status: AccountReadinessStatusSchema,
        reasons: z.array(z.string()),
        sessionState: SessionStateSchema,
        advertisedPointsRemaining: z.number().int().nonnegative().optional(),
        lastObservedAt: z.string().datetime({ offset: true }),
        nextAction: z.string().min(1),
        recentFailureCount: z.number().int().nonnegative()
    })
    .strict()

export interface ReadinessUpdateEvent {
    type: 'readiness-update'
    contractVersion: 1
    accountId: string
    readiness: AccountReadinessResult
    tasks: TaskHandoffEnvelope[]
    emittedAt: string
}

export const ReadinessUpdateEventSchema = z
    .object({
        type: z.literal('readiness-update'),
        contractVersion: z.literal(1),
        accountId: z.string().min(1),
        readiness: AccountReadinessResultSchema,
        tasks: z.array(TaskHandoffEnvelopeSchema),
        emittedAt: z.string().datetime({ offset: true })
    })
    .strict()

export function validateReadinessUpdateEvent(data: unknown): ReadinessUpdateEvent {
    if (!data || typeof data !== 'object') {
        throw new Error('[IPC-SECURITY] ReadinessUpdateEvent must be an object')
    }

    // Size limit check (max 1MB serialized IPC message)
    const json = JSON.stringify(data)
    if (Buffer.byteLength(json, 'utf-8') > 1024 * 1024) {
        throw new Error('[IPC-SECURITY] Oversized IPC message rejected (>1MB)')
    }

    // Recursive forbidden keys rejection
    if (containsForbiddenKeys(data)) {
        throw new Error('[IPC-SECURITY] ReadinessUpdateEvent contains forbidden sensitive properties')
    }

    const parsed = ReadinessUpdateEventSchema.safeParse(data)
    if (!parsed.success) {
        throw new Error(`[IPC-SECURITY] Malformed ReadinessUpdateEvent: ${parsed.error.message}`)
    }

    return parsed.data as ReadinessUpdateEvent
}
