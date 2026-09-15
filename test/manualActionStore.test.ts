import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ManualActionStore } from '../src/manual/ManualActionStore'
import { ObservationReconciler } from '../src/manual/ObservationReconciler'
import { ConflictError } from '../src/manual/ManualActionTypes'
import {
    AccountObservationEnvelope,
    computeStableAccountRef,
    computeStableTaskRef
} from '../src/contracts/AccountObservationContract'

export async function runManualActionStoreTests(): Promise<void> {
    console.log('🧪 Starting ManualActionStore & ObservationReconciler Test Suite (Commit 4)...')

    const baseTestDir = path.join(__dirname, 'temp_manual_store_test_' + Date.now())
    await fs.promises.mkdir(baseTestDir, { recursive: true })

    const sampleUuid = 'b0000000-0000-4000-8000-000000000002'
    const referenceKey = Buffer.from('test_ref_key_32_bytes_long_1234!!')
    const accountRef = computeStableAccountRef(referenceKey, sampleUuid)
    const taskRef1 = computeStableTaskRef(referenceKey, sampleUuid, 'search', 'task-search-01')
    const taskRef2 = computeStableTaskRef(referenceKey, sampleUuid, 'url-reward', 'task-url-02')

    try {
        // Test 1: Two-axis State Machine Transitions & Observation Reconciliation (Amendment 8)
        {
            const storePath = path.join(baseTestDir, 'test1_store', 'manual_actions.json')
            const store = new ManualActionStore({ storePath, allowInWorkerForTesting: true })
            await store.init()
            const reconciler = new ObservationReconciler(store)

            // Step A: Ingest observation with incomplete task
            const envelope1: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef,
                displayAccount: 'bob***@domain.com',
                emittedAt: new Date().toISOString(),
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: [
                    {
                        taskRef: taskRef1,
                        title: 'Complete Search On Bing',
                        taskKind: 'search',
                        state: 'incomplete',
                        reason: 'manual-action-required',
                        advertisedPoints: 50,
                        progressCurrent: 10,
                        progressMaximum: 50,
                        observedAt: new Date().toISOString()
                    }
                ]
            }

            const recResult1 = await reconciler.reconcile(envelope1)
            if (recResult1.created !== 1) {
                throw new Error(`Expected 1 created task, got ${recResult1.created}`)
            }

            const record1 = store.findByTaskRef(accountRef, taskRef1)
            if (!record1) throw new Error('Record not found after reconcile')
            if (record1.lifecycleState !== 'available' || record1.verificationState !== 'unverified') {
                throw new Error(
                    `Initial state mismatch: ${record1.lifecycleState}, ${record1.verificationState}`
                )
            }

            // Step B: User reports action completed
            const reported = await store.reportAction(record1.recordId, {
                expectedRevision: 1,
                note: 'User clicked search on real device'
            })
            if (reported.lifecycleState !== 'action-reported') {
                throw new Error(`Expected lifecycleState action-reported, got ${reported.lifecycleState}`)
            }
            // CRITICAL INVARIANT (Amendment 8): verificationState STAYS unverified!
            if (reported.verificationState !== 'unverified') {
                throw new Error(
                    `CRITICAL: User report altered verificationState to ${reported.verificationState}! Must stay unverified.`
                )
            }
            if (reported.revision !== 2) {
                throw new Error(`Expected revision 2, got ${reported.revision}`)
            }

            // Step C: Second observation arrives, task STILL incomplete in Main
            const envelope2: AccountObservationEnvelope = {
                ...envelope1,
                observationId: crypto.randomUUID(),
                sequence: 2,
                tasks: [
                    {
                        ...envelope1.tasks[0]!,
                        progressCurrent: 20 // partial progress, still incomplete
                    }
                ]
            }
            await reconciler.reconcile(envelope2)

            const afterStillIncomplete = store.getRecord(record1.recordId)!
            if (afterStillIncomplete.verificationState !== 'unverified') {
                throw new Error('Verification state prematurely verified while Main reports incomplete!')
            }
            if (afterStillIncomplete.progressCurrent !== 20) {
                throw new Error('Progress current was not updated')
            }

            // Step D: Third observation arrives, task is now COMPLETE in Main
            const envelope3: AccountObservationEnvelope = {
                ...envelope1,
                observationId: crypto.randomUUID(),
                sequence: 3,
                tasks: [
                    {
                        ...envelope1.tasks[0]!,
                        state: 'complete',
                        progressCurrent: 50
                    }
                ]
            }
            const recResult3 = await reconciler.reconcile(envelope3)
            if (recResult3.verifiedComplete !== 1) {
                throw new Error(`Expected 1 verifiedComplete, got ${recResult3.verifiedComplete}`)
            }

            const afterComplete = store.getRecord(record1.recordId)!
            if (afterComplete.verificationState !== 'verified-complete') {
                throw new Error(
                    `Expected verificationState verified-complete, got ${afterComplete.verificationState}`
                )
            }
            if (!afterComplete.verifiedAt) {
                throw new Error('Expected verifiedAt timestamp to be set')
            }

            console.log('  ✅ Test 1 Passed: Two-axis state machine transitions strictly verified')
        }

        // Test 2: Optimistic Revision Locking & Mutation Conflict (Amendment 10)
        {
            const storePath = path.join(baseTestDir, 'test2_store', 'manual_actions.json')
            const store = new ManualActionStore({ storePath, allowInWorkerForTesting: true })
            await store.init()

            const reconciler = new ObservationReconciler(store)
            await reconciler.reconcile({
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef,
                displayAccount: 'bob***@domain.com',
                emittedAt: new Date().toISOString(),
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: [
                    {
                        taskRef: taskRef2,
                        title: 'Read MSN Article',
                        taskKind: 'url-reward',
                        state: 'incomplete',
                        reason: 'manual-action-required',
                        observedAt: new Date().toISOString()
                    }
                ]
            })

            const record = store.findByTaskRef(accountRef, taskRef2)!
            if (record.revision !== 1) {
                throw new Error(`Expected initial revision 1, got ${record.revision}`)
            }

            // Attempt mutation with stale expectedRevision (expected: 99, actual: 1)
            let conflictCaught = false
            try {
                await store.dismissAction(record.recordId, {
                    expectedRevision: 99
                })
            } catch (err: any) {
                if (err instanceof ConflictError && err.currentRevision === 1) {
                    conflictCaught = true
                }
            }
            if (!conflictCaught) {
                throw new Error('Expected ConflictError with currentRevision on stale expectedRevision')
            }

            // Valid mutation with expectedRevision: 1
            const dismissed = await store.dismissAction(record.recordId, {
                expectedRevision: 1,
                note: 'User dismissed this task'
            })
            if (dismissed.revision !== 2 || dismissed.lifecycleState !== 'dismissed') {
                throw new Error('Valid mutation failed to update revision or state')
            }

            // Reopen with revision 2
            const reopened = await store.reopenAction(record.recordId, {
                expectedRevision: 2
            })
            if (reopened.revision !== 3 || reopened.lifecycleState !== 'available') {
                throw new Error('Reopen failed to advance revision')
            }

            console.log('  ✅ Test 2 Passed: Optimistic revision locking prevents conflicting concurrent writes')
        }

        // Test 3: Read-only Query Semantics, Filtering, Search & Deterministic Pagination (Amendment 7)
        {
            const storePath = path.join(baseTestDir, 'test3_store', 'manual_actions.json')
            const store = new ManualActionStore({ storePath, allowInWorkerForTesting: true })
            await store.init()

            // Seed 5 records
            for (let i = 1; i <= 5; i++) {
                const dummyTaskRef = computeStableTaskRef(referenceKey, sampleUuid, 'search', `task-${i}`)
                await store.upsertRecord({
                    recordId: `00000000-0000-4000-8000-00000000000${i}`,
                    accountRef,
                    displayAccount: 'bob***@domain.com',
                    taskRef: dummyTaskRef,
                    title: i % 2 === 0 ? `Bing Search Task ${i}` : `MSN Article Task ${i}`,
                    taskKind: i % 2 === 0 ? 'search' : 'url-reward',
                    reason: 'manual-action-required',
                    lifecycleState: i === 5 ? 'dismissed' : 'available',
                    verificationState: 'unverified',
                    revision: 1,
                    createdAt: new Date(Date.now() - (10 - i) * 1000).toISOString(),
                    updatedAt: new Date().toISOString(),
                    observedAt: new Date().toISOString()
                })
            }

            // Query with search filter (case-insensitive substring on title only)
            const searchRes = store.query({ search: 'article' })
            if (searchRes.records.length !== 3) {
                throw new Error(`Expected 3 article records, got ${searchRes.records.length}`)
            }
            for (const r of searchRes.records) {
                if (!r.title.toLowerCase().includes('article')) {
                    throw new Error(`Search returned non-matching title: ${r.title}`)
                }
            }

            // Query with lifecycleState filter
            const dismissedRes = store.query({ lifecycleState: 'dismissed' })
            if (dismissedRes.records.length !== 1) {
                throw new Error(`Expected 1 dismissed record, got ${dismissedRes.records.length}`)
            }

            // Pagination with limit: 2 and cursor
            const page1 = store.query({ limit: 2 })
            if (page1.records.length !== 2) {
                throw new Error(`Expected 2 records on page 1, got ${page1.records.length}`)
            }
            if (!page1.nextCursor) {
                throw new Error('Expected nextCursor on page 1')
            }

            const page2 = store.query({ limit: 2, cursor: page1.nextCursor })
            if (page2.records.length !== 2) {
                throw new Error(`Expected 2 records on page 2, got ${page2.records.length}`)
            }
            // Records on page 2 must be distinct from page 1
            const page1Ids = new Set(page1.records.map(r => r.recordId))
            for (const r of page2.records) {
                if (page1Ids.has(r.recordId)) {
                    throw new Error(`Duplicate record across pagination pages: ${r.recordId}`)
                }
            }

            console.log('  ✅ Test 3 Passed: Non-mutating query semantics, filtering, and pagination verified')
        }

        // Test 4: Pre-save Backup & Corrupted Store Recovery (Amendment 11)
        {
            const storeDir = path.join(baseTestDir, 'test4_store')
            const storePath = path.join(storeDir, 'manual_actions.json')
            const backupPath = `${storePath}.bak`

            const store1 = new ManualActionStore({ storePath, allowInWorkerForTesting: true })
            await store1.init()

            const testRecord = {
                recordId: 'c0000000-0000-4000-8000-000000000001',
                accountRef,
                displayAccount: 'bob***@domain.com',
                taskRef: taskRef1,
                title: 'Persistent Task Test',
                taskKind: 'search',
                reason: 'manual-action-required' as const,
                lifecycleState: 'available' as const,
                verificationState: 'unverified' as const,
                revision: 1,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                observedAt: new Date().toISOString()
            }
            await store1.upsertRecord(testRecord)

            // Trigger another save to ensure pre-save backup (.bak) exists
            await store1.save()

            if (!fs.existsSync(backupPath)) {
                throw new Error('Expected pre-save backup file manual_actions.json.bak to exist')
            }

            // Intentionally corrupt the primary store file
            await fs.promises.writeFile(storePath, '{"invalid_json"::::corrupted', 'utf8')

            // Instantiate a new store; it should detect corruption, quarantine corrupted file,
            // and successfully recover from the .bak file
            const store2 = new ManualActionStore({ storePath, allowInWorkerForTesting: true })
            await store2.init()

            const recoveredRecord = store2.getRecord(testRecord.recordId)
            if (!recoveredRecord || recoveredRecord.title !== 'Persistent Task Test') {
                throw new Error('Failed to recover valid record from backup file!')
            }

            // Verify corrupted file was quarantined
            const files = await fs.promises.readdir(storeDir)
            const quarantined = files.find(f => f.startsWith('manual_actions.corrupted.'))
            if (!quarantined) {
                throw new Error('Corrupted store was not quarantined')
            }

            // Corrupt BOTH primary and backup file; store must fail-closed!
            await fs.promises.writeFile(storePath, '{ corrupt 1', 'utf8')
            await fs.promises.writeFile(backupPath, '{ corrupt 2', 'utf8')

            const store3 = new ManualActionStore({ storePath, allowInWorkerForTesting: true })
            let failClosedCaught = false
            try {
                await store3.init()
            } catch (err: any) {
                if (err.message.includes('No valid backup available')) {
                    failClosedCaught = true
                }
            }
            if (!failClosedCaught) {
                throw new Error('Expected store to fail-closed when both primary and backup are corrupt')
            }

            console.log('  ✅ Test 4 Passed: Pre-save backup, quarantine, and fail-closed safety confirmed')
        }

        console.log('🎉 ALL 4 MANUAL ACTION STORE & RECONCILER TESTS PASSED SUCCESSFULLY!\n')
    } finally {
        try {
            await fs.promises.rm(baseTestDir, { recursive: true, force: true })
        } catch {}
    }
}
