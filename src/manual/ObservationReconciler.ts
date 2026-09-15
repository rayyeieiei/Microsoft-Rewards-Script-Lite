import crypto from 'crypto'
import { AccountObservationEnvelope } from '../contracts/AccountObservationContract'
import { ManualActionRecord } from './ManualActionTypes'
import { ManualActionStore } from './ManualActionStore'

export interface ReconcileResult {
    created: number
    updated: number
    verifiedComplete: number
}

export class ObservationReconciler {
    private readonly store: ManualActionStore

    constructor(store: ManualActionStore) {
        this.store = store
    }

    public async reconcile(envelope: AccountObservationEnvelope): Promise<ReconcileResult> {
        let created = 0
        let updated = 0
        let verifiedComplete = 0

        const recordsToUpsert: ManualActionRecord[] = []
        const now = new Date().toISOString()
        const nowMs = Date.now()

        for (const task of envelope.tasks) {
            const existing = this.store.findByTaskRef(envelope.accountRef, task.taskRef)

            const isExpired = task.expiresAt
                ? new Date(task.expiresAt).getTime() < nowMs
                : false

            if (existing) {
                let hasChanges = false

                // 1. Completion verification (Amendment 8)
                if (task.state === 'complete') {
                    if (existing.verificationState !== 'verified-complete') {
                        existing.verificationState = 'verified-complete'
                        existing.verifiedAt = envelope.emittedAt
                        verifiedComplete++
                        hasChanges = true
                    }
                } else if (task.state === 'incomplete') {
                    // Task is incomplete in Main observation
                    // If user previously reported action, verificationState remains unverified!
                    if (existing.lifecycleState === 'action-reported') {
                        existing.verificationState = 'unverified'
                    }
                }

                // 2. Update metadata & progress
                if (existing.advertisedPoints !== task.advertisedPoints) {
                    existing.advertisedPoints = task.advertisedPoints
                    hasChanges = true
                }
                if (existing.progressCurrent !== task.progressCurrent) {
                    existing.progressCurrent = task.progressCurrent
                    hasChanges = true
                }
                if (existing.progressMaximum !== task.progressMaximum) {
                    existing.progressMaximum = task.progressMaximum
                    hasChanges = true
                }
                if (existing.title !== task.title) {
                    existing.title = task.title
                    hasChanges = true
                }
                if (existing.reason !== task.reason) {
                    existing.reason = task.reason
                    hasChanges = true
                }
                if (existing.observedAt !== task.observedAt) {
                    existing.observedAt = task.observedAt
                    hasChanges = true
                }
                if (existing.expiresAt !== task.expiresAt) {
                    existing.expiresAt = task.expiresAt
                    hasChanges = true
                }

                // 3. Expiration lifecycle transition
                if (isExpired && existing.lifecycleState !== 'expired') {
                    existing.lifecycleState = 'expired'
                    hasChanges = true
                }

                if (hasChanges) {
                    existing.revision++
                    existing.updatedAt = now
                    recordsToUpsert.push(existing)
                    updated++
                }
            } else {
                // New task observed
                if (task.state === 'incomplete') {
                    const newRecord: ManualActionRecord = {
                        recordId: crypto.randomUUID(),
                        accountRef: envelope.accountRef,
                        displayAccount: envelope.displayAccount,
                        taskRef: task.taskRef,
                        title: task.title,
                        taskKind: task.taskKind,
                        reason: task.reason,
                        advertisedPoints: task.advertisedPoints,
                        progressCurrent: task.progressCurrent,
                        progressMaximum: task.progressMaximum,
                        lifecycleState: isExpired ? 'expired' : 'available',
                        verificationState: 'unverified',
                        revision: 1,
                        createdAt: envelope.emittedAt,
                        updatedAt: now,
                        observedAt: task.observedAt,
                        expiresAt: task.expiresAt
                    }
                    recordsToUpsert.push(newRecord)
                    created++
                }
            }
        }

        if (recordsToUpsert.length > 0) {
            await this.store.batchUpsertRecords(recordsToUpsert)
        }

        return { created, updated, verifiedComplete }
    }
}
