import { z } from 'zod'

export const EXECUTION_CONTRACT_VERSION = 1 as const

export type TaskCapability = 'read-only' | 'requires-interactive-client' | 'unsupported'

export type TaskOutcome =
    | 'observed'
    | 'requires-handoff'
    | 'auth-required'
    | 'retryable-failure'
    | 'permanent-failure'
    | 'unsupported'

export type HandoffReason =
    | 'interactive-dom-required'
    | 'official-client-required'
    | 'authentication-required'
    | 'unsupported-endpoint'
    | 'server-locked'
    | 'schema-unknown'
    | 'network-failure'

export interface SafeAccountReference {
    accountId: string
    displayAccount: string
}

export interface SessionStatus {
    state: 'not-configured' | 'interactive-required' | 'available-in-owning-runtime' | 'expired' | 'invalid'
    expiresAt?: string
}

export interface TaskHandoffEnvelope {
    contractVersion: typeof EXECUTION_CONTRACT_VERSION
    correlationId: string
    account: SafeAccountReference
    taskId: string
    taskKind: string
    capability: TaskCapability
    outcome: TaskOutcome
    reason: HandoffReason
    observedAt: string
    expiresAt?: string
    source: 'lite' | 'main'
    diagnosticCode?: string
}

export const TaskCapabilitySchema = z.enum(['read-only', 'requires-interactive-client', 'unsupported'])

export const TaskOutcomeSchema = z.enum([
    'observed',
    'requires-handoff',
    'auth-required',
    'retryable-failure',
    'permanent-failure',
    'unsupported'
])

export const HandoffReasonSchema = z.enum([
    'interactive-dom-required',
    'official-client-required',
    'authentication-required',
    'unsupported-endpoint',
    'server-locked',
    'schema-unknown',
    'network-failure'
])

export const SafeAccountReferenceSchema = z
    .object({
        accountId: z.string().uuid(),
        displayAccount: z.string().min(1)
    })
    .strict()

export const SessionStatusSchema = z
    .object({
        state: z.enum(['not-configured', 'interactive-required', 'available-in-owning-runtime', 'expired', 'invalid']),
        expiresAt: z.string().datetime({ offset: true }).optional()
    })
    .strict()

export const TaskHandoffEnvelopeSchema = z
    .object({
        contractVersion: z.literal(EXECUTION_CONTRACT_VERSION),
        correlationId: z.string().min(1),
        account: SafeAccountReferenceSchema,
        taskId: z.string().min(1),
        taskKind: z.string().min(1),
        capability: TaskCapabilitySchema,
        outcome: TaskOutcomeSchema,
        reason: HandoffReasonSchema,
        observedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }).optional(),
        source: z.enum(['lite', 'main']),
        diagnosticCode: z.string().optional()
    })
    .strict()

export const FORBIDDEN_KEYS_EXACT = [
    'authorization',
    'cookie',
    'set-cookie',
    'accesstoken',
    'refreshtoken',
    'requesttoken',
    'oauthcode',
    'password',
    'secret',
    'headers',
    'payload',
    'requestbody',
    'responsebody',
    'destinationurl'
] as const

export function containsForbiddenKeys(obj: unknown, seen = new WeakSet()): boolean {
    if (!obj || typeof obj !== 'object') return false
    if (seen.has(obj as object)) return false
    seen.add(obj as object)

    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (containsForbiddenKeys(item, seen)) return true
        }
        return false
    }

    for (const [key, value] of Object.entries(obj)) {
        const normalizedKey = key.trim().toLowerCase()
        if (FORBIDDEN_KEYS_EXACT.some(forbidden => normalizedKey === forbidden)) {
            return true
        }
        if (containsForbiddenKeys(value, seen)) {
            return true
        }
    }
    return false
}

export function validateTaskHandoffEnvelope(data: unknown): TaskHandoffEnvelope {
    if (containsForbiddenKeys(data)) {
        throw new Error('TaskHandoffEnvelope contains forbidden security-sensitive properties')
    }
    const result = TaskHandoffEnvelopeSchema.safeParse(data)
    if (!result.success) {
        throw new Error(`Invalid TaskHandoffEnvelope: ${result.error.message}`)
    }
    return result.data as TaskHandoffEnvelope
}

export const TERMINAL_OUTCOMES: ReadonlySet<TaskOutcome> = new Set(['permanent-failure', 'unsupported'])

export function isTerminalOutcome(outcome: TaskOutcome | string): boolean {
    return TERMINAL_OUTCOMES.has(outcome as TaskOutcome) || outcome === 'expired'
}

const OUTCOME_RANKS: Record<TaskOutcome, number> = {
    observed: 1,
    'requires-handoff': 2,
    'auth-required': 3,
    'retryable-failure': 3,
    'permanent-failure': 4,
    unsupported: 4
}

export function canTransitionOutcome(from: TaskOutcome, to: TaskOutcome): boolean {
    if (isTerminalOutcome(from)) {
        return false // Terminal states cannot transition to anything
    }
    const fromRank = OUTCOME_RANKS[from] ?? 0
    const toRank = OUTCOME_RANKS[to] ?? 0
    return toRank >= fromRank
}
