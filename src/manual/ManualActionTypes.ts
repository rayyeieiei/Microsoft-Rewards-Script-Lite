import { z } from 'zod'
import {
    ObservationReason,
    ObservationReasonSchema
} from '../contracts/AccountObservationContract'

export type ManualTaskLifecycleState =
    | 'available'
    | 'in-progress'
    | 'action-reported'
    | 'dismissed'
    | 'expired'

export type ManualTaskVerificationState =
    | 'unverified'
    | 'verification-pending'
    | 'verified-complete'
    | 'verification-failed'

export const ManualTaskLifecycleStateSchema = z.enum([
    'available',
    'in-progress',
    'action-reported',
    'dismissed',
    'expired'
])

export const ManualTaskVerificationStateSchema = z.enum([
    'unverified',
    'verification-pending',
    'verified-complete',
    'verification-failed'
])

export interface ManualActionRecord {
    recordId: string
    accountRef: string
    displayAccount: string
    taskRef: string
    title: string
    taskKind: string
    reason: ObservationReason
    advertisedPoints?: number
    progressCurrent?: number
    progressMaximum?: number
    lifecycleState: ManualTaskLifecycleState
    verificationState: ManualTaskVerificationState
    revision: number
    note?: string
    createdAt: string
    updatedAt: string
    observedAt: string
    actionReportedAt?: string
    verifiedAt?: string
    expiresAt?: string
}

export const ManualActionRecordSchema = z
    .object({
        recordId: z.string().uuid(),
        accountRef: z.string().min(8).max(64),
        displayAccount: z.string().min(1).max(100),
        taskRef: z.string().min(8).max(64),
        title: z.string().min(1).max(120),
        taskKind: z.string().min(1).max(50),
        reason: ObservationReasonSchema,
        advertisedPoints: z.number().int().nonnegative().optional(),
        progressCurrent: z.number().int().nonnegative().optional(),
        progressMaximum: z.number().int().nonnegative().optional(),
        lifecycleState: ManualTaskLifecycleStateSchema,
        verificationState: ManualTaskVerificationStateSchema,
        revision: z.number().int().positive(),
        note: z.string().max(200).optional(),
        createdAt: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        observedAt: z.string().datetime({ offset: true }),
        actionReportedAt: z.string().datetime({ offset: true }).optional(),
        verifiedAt: z.string().datetime({ offset: true }).optional(),
        expiresAt: z.string().datetime({ offset: true }).optional()
    })
    .strict()

export interface ManualActionStoreData {
    schemaVersion: 1
    records: Record<string, ManualActionRecord>
    updatedAt: string
}

export const ManualActionStoreSchema = z
    .object({
        schemaVersion: z.literal(1),
        records: z.record(z.string(), ManualActionRecordSchema),
        updatedAt: z.string().datetime({ offset: true })
    })
    .strict()

export interface ManualActionMutationPayload {
    expectedRevision: number
    note?: string
}

export const ManualActionMutationPayloadSchema = z
    .object({
        expectedRevision: z.number().int().positive(),
        note: z.string().max(200).optional()
    })
    .strict()

export interface ManualActionQueryParams {
    accountRef?: string
    lifecycleState?: ManualTaskLifecycleState
    verificationState?: ManualTaskVerificationState
    search?: string
    limit?: number
    cursor?: string
}

export class ConflictError extends Error {
    public readonly currentRevision: number
    constructor(currentRevision: number, message = 'Conflict: record has been modified') {
        super(message)
        this.name = 'ConflictError'
        this.currentRevision = currentRevision
    }
}
