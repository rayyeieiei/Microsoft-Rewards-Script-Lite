import crypto from 'crypto'
import { z } from 'zod'

export const ACCOUNT_OBSERVATION_VERSION = 1 as const

export type ObservationSessionState =
    | 'missing'
    | 'present-unverified'
    | 'expired'
    | 'interactive-required'
    | 'valid-from-existing-runtime-evidence'
    | 'unknown'

export type ObservedTaskState =
    | 'incomplete'
    | 'complete'
    | 'locked'
    | 'unsupported'
    | 'unknown'

export type ObservationReason =
    | 'manual-action-required'
    | 'official-client-required'
    | 'interactive-dom-required'
    | 'server-locked'
    | 'unsupported'
    | 'not-observed'
    | 'unknown'

export interface ObservedTask {
    taskRef: string
    title: string
    taskKind: string
    state: ObservedTaskState
    reason: ObservationReason
    advertisedPoints?: number
    progressCurrent?: number
    progressMaximum?: number
    observedAt: string
    expiresAt?: string
}

export interface AccountObservationEnvelope {
    contractVersion: typeof ACCOUNT_OBSERVATION_VERSION
    observationId: string
    sequence: number
    source: 'main'
    accountRef: string
    displayAccount: string
    emittedAt: string
    sessionState: ObservationSessionState
    tasks: ObservedTask[]
}

// --------------------------------------------------------------------------
// Strict Zod Schemas
// --------------------------------------------------------------------------

export const ObservationSessionStateSchema = z.enum([
    'missing',
    'present-unverified',
    'expired',
    'interactive-required',
    'valid-from-existing-runtime-evidence',
    'unknown'
])

export const ObservedTaskStateSchema = z.enum([
    'incomplete',
    'complete',
    'locked',
    'unsupported',
    'unknown'
])

export const ObservationReasonSchema = z.enum([
    'manual-action-required',
    'official-client-required',
    'interactive-dom-required',
    'server-locked',
    'unsupported',
    'not-observed',
    'unknown'
])

export const ObservedTaskSchema = z
    .object({
        taskRef: z.string().min(8).max(64).regex(/^[a-f0-9]+$/i, 'taskRef must be a valid hex string'),
        title: z.string().min(1).max(120),
        taskKind: z.string().min(1).max(50),
        state: ObservedTaskStateSchema,
        reason: ObservationReasonSchema,
        advertisedPoints: z.number().int().nonnegative().max(100000).optional(),
        progressCurrent: z.number().int().nonnegative().max(100000).optional(),
        progressMaximum: z.number().int().nonnegative().max(100000).optional(),
        observedAt: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }).optional()
    })
    .strict()
    .refine(
        data => {
            if (data.progressCurrent !== undefined && data.progressMaximum !== undefined) {
                return data.progressCurrent <= data.progressMaximum
            }
            return true
        },
        { message: 'progressCurrent cannot exceed progressMaximum' }
    )

export const AccountObservationEnvelopeSchema = z
    .object({
        contractVersion: z.literal(ACCOUNT_OBSERVATION_VERSION),
        observationId: z.string().uuid(),
        sequence: z.number().int().positive(),
        source: z.literal('main'),
        accountRef: z.string().min(8).max(64).regex(/^[a-f0-9]+$/i, 'accountRef must be a valid hex string'),
        displayAccount: z.string().min(1).max(100),
        emittedAt: z.string().datetime({ offset: true }),
        sessionState: ObservationSessionStateSchema,
        tasks: z.array(ObservedTaskSchema).max(150)
    })
    .strict()
    .refine(
        data => {
            const seen = new Set<string>()
            for (const task of data.tasks) {
                if (seen.has(task.taskRef)) return false
                seen.add(task.taskRef)
            }
            return true
        },
        { message: 'Duplicate taskRef values are forbidden within a single envelope' }
    )

// --------------------------------------------------------------------------
// Recursive Sensitive Key Ban
// --------------------------------------------------------------------------

export const FORBIDDEN_OBSERVATION_KEYS = [
    'authorization',
    'cookie',
    'set-cookie',
    'token',
    'accesstoken',
    'refreshtoken',
    'requesttoken',
    'oauthcode',
    'password',
    'secret',
    'headers',
    'requestbody',
    'responsebody',
    'destinationurl',
    'url',
    'ip',
    'fingerprint',
    'proxy',
    'gainedpoints',
    'earnedpoints',
    'collectedpoints',
    'balancedelta'
] as const

export function containsForbiddenObservationKeys(obj: unknown, seen = new WeakSet()): boolean {
    if (!obj || typeof obj !== 'object') return false
    if (seen.has(obj as object)) return false
    seen.add(obj as object)

    if (Array.isArray(obj)) {
        for (const item of obj) {
            if (containsForbiddenObservationKeys(item, seen)) return true
        }
        return false
    }

    for (const [key, value] of Object.entries(obj)) {
        const normalized = key.trim().toLowerCase()
        if (FORBIDDEN_OBSERVATION_KEYS.some(forbidden => normalized === forbidden)) {
            return true
        }
        if (containsForbiddenObservationKeys(value, seen)) {
            return true
        }
    }
    return false
}

export function validateAccountObservationEnvelope(data: unknown): AccountObservationEnvelope {
    if (containsForbiddenObservationKeys(data)) {
        throw new Error('[SECURITY] AccountObservationEnvelope contains forbidden sensitive keys')
    }
    const result = AccountObservationEnvelopeSchema.safeParse(data)
    if (!result.success) {
        throw new Error(`[VALIDATION] Invalid AccountObservationEnvelope: ${result.error.message}`)
    }
    return result.data
}

// --------------------------------------------------------------------------
// Explicit Reference Derivation Helpers (Amendments 2 & 3)
// --------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function validateExplicitAccountUuid(accountId: unknown): string {
    if (typeof accountId !== 'string' || !UUID_REGEX.test(accountId.trim())) {
        throw new Error(`[IDENTITY-SECURITY] Account ID must be an explicit valid UUID. Received: '${accountId}'`)
    }
    return accountId.trim().toLowerCase()
}

export function computeStableAccountRef(referenceKey: Buffer | string, accountId: string): string {
    const validUuid = validateExplicitAccountUuid(accountId)
    return crypto
        .createHmac('sha256', referenceKey)
        .update(validUuid)
        .digest('hex')
        .slice(0, 32)
}

export function computeStableTaskRef(
    referenceKey: Buffer | string,
    accountId: string,
    taskKind: string,
    stableSourceId: string
): string {
    const validUuid = validateExplicitAccountUuid(accountId)
    const normalizedKind = taskKind.trim().toLowerCase()
    const normalizedSourceId = (stableSourceId || '').trim()

    if (!normalizedSourceId) {
        throw new Error('[TASK-REF-SECURITY] stableSourceId is required to generate a stable taskRef')
    }

    const payload = `${validUuid}::${normalizedKind}::${normalizedSourceId}`
    return crypto
        .createHmac('sha256', referenceKey)
        .update(payload)
        .digest('hex')
        .slice(0, 32)
}