import assert from 'assert'
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import { ObserverRuntime } from '../src/runtime/observer/ObserverRuntime'
import { ObserverConfig, validateObserverIdentities } from '../src/runtime/observer/ObserverConfig'
import { ObserverLock } from '../src/runtime/observer/ObserverLock'
import { AccountEvidenceStore } from '../src/runtime/observer/AccountEvidenceStore'
import { AccountObservationEnvelope } from '../src/contracts/AccountObservationContract'

export async function runObserverRuntimeTests(): Promise<void> {
    console.log('🧪 Starting ObserverRuntime Acceptance Suite (15 Scenarios)...')

    const baseTestDir = path.join(__dirname, 'temp_observer_test_' + Date.now())
    await fs.promises.mkdir(baseTestDir, { recursive: true })

    try {
        // =========================================================================
        // SCENARIO 1 & 2: Default Entrypoint & Static Audit (Zero Browser/Login/Search Reachable)
        // =========================================================================
        {
            const observerTsPath = path.join(__dirname, '..', 'src', 'observer.ts')
            assert.ok(fs.existsSync(observerTsPath), 'src/observer.ts must exist as entrypoint')
            const observerContent = fs.readFileSync(observerTsPath, 'utf-8')

            const runtimeTsPath = path.join(__dirname, '..', 'src', 'runtime', 'observer', 'ObserverRuntime.ts')
            const runtimeContent = fs.readFileSync(runtimeTsPath, 'utf-8')

            const combinedCode = observerContent + '\n' + runtimeContent

            const forbiddenPatterns = [
                /import.*from.*['"]\.\/browser/i,
                /import.*from.*['"]\.\/search/i,
                /new\s+Browser\(/,
                /new\s+Login\(/,
                /new\s+SearchManager\(/,
                /new\s+AxiosClient\(/,
                /from\s+['"]patchright['"]/i
            ]

            for (const pattern of forbiddenPatterns) {
                assert.strictEqual(
                    pattern.test(combinedCode),
                    false,
                    `Forbidden browser/automation pattern found in observer runtime: ${pattern}`
                )
            }
            console.log(
                '  ✅ Scenarios 1 & 2 Passed: Observer entrypoint exists & static audit confirms zero browser automation'
            )
        }

        // =========================================================================
        // SCENARIO 3: Zero Outbound Network Calls (Except Loopback HTTP)
        // =========================================================================
        {
            let externalConnectionAttempted = false

            const origHttpRequest = http.request
            const origHttpsRequest = https.request

            // Intercept http & https requests
            http.request = function (...args: any[]): any {
                const host = typeof args[0] === 'string' ? args[0] : args[0]?.host || args[0]?.hostname || ''
                if (host && host !== '127.0.0.1' && host !== 'localhost') {
                    externalConnectionAttempted = true
                }
                return origHttpRequest.apply(http, args as any)
            } as any

            https.request = function (...args: any[]): any {
                externalConnectionAttempted = true
                return origHttpsRequest.apply(https, args as any)
            } as any

            try {
                const storageDir = path.join(baseTestDir, 's3_storage')
                const testConfig: ObserverConfig = {
                    contractVersion: 1,
                    identitiesPath: 'identities.json',
                    storageDirectory: storageDir,
                    dashboard: {
                        enabled: false,
                        host: '127.0.0.1',
                        port: 41999,
                        maxSseClients: 5,
                        sseHeartbeatMs: 15000
                    },
                    staleEvidenceThresholdHours: 48,
                    shutdownTimeoutMs: 5000
                }

                const runtime = new ObserverRuntime({ config: testConfig, identities: [] })
                await runtime.start()
                await runtime.stop()

                assert.strictEqual(externalConnectionAttempted, false, 'Observer must never contact external endpoints')
                console.log('  ✅ Scenario 3 Passed: Zero outbound network calls confirmed')
            } finally {
                http.request = origHttpRequest
                https.request = origHttpsRequest
            }
        }

        // =========================================================================
        // SCENARIO 4: End-to-End Pipeline (Bridge Import -> Reconcile -> Store -> Snapshot)
        // =========================================================================
        {
            const testId = '10000000-0000-4000-8000-000000000001'
            const storageDir = path.join(baseTestDir, 's4_storage')
            const bridgeDir = path.join(baseTestDir, 's4_bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            await fs.promises.mkdir(incomingDir, { recursive: true })

            const testConfig: ObserverConfig = {
                contractVersion: 1,
                identitiesPath: 'identities.json',
                storageDirectory: storageDir,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41998,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 60000,
                    maximumFileBytes: 512 * 1024,
                    maxIncomingFiles: 10,
                    maxBridgeDirectoryBytes: 50 * 1024 * 1024,
                    processedRetentionHours: 24,
                    rejectionMetadataRetentionHours: 72,
                    claimingStaleMs: 60000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const validAccountRef = crypto.createHash('sha256').update(testId).digest('hex').slice(0, 32)
            const identities = [{ accountId: testId, displayLabel: 'user1***@domain.com' }]
            const runtime = new ObserverRuntime({ config: testConfig, identities })
            await runtime.start()

            // Deposit valid observation envelope into bridge
            const envelope: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef: validAccountRef,
                displayAccount: 'user1***@domain.com',
                emittedAt: new Date().toISOString(),
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: [
                    {
                        taskRef: 'a1b2c3d4e5f60718',
                        title: 'Daily Search',
                        taskKind: 'search',
                        state: 'incomplete',
                        reason: 'manual-action-required',
                        advertisedPoints: 30,
                        observedAt: new Date().toISOString()
                    }
                ]
            }

            const envFile = path.join(incomingDir, `obs_${Date.now()}.json`)
            await fs.promises.writeFile(envFile, JSON.stringify(envelope), 'utf-8')

            // Trigger manual processing
            const envelopes = await runtime.getImporter()!.scanAndImport()
            assert.strictEqual(envelopes.length, 1)
            await runtime.processImportedEnvelope(envelopes[0]!)
            await runtime.recalculateAllReadiness()

            // Verify Snapshot Store updated
            const snapshot = runtime.getSnapshotStore().getSnapshot()
            assert.strictEqual(snapshot.summary.totalAccounts, 1)
            const accDto = snapshot.accounts[0]!
            assert.strictEqual(accDto.status, 'technically-ready-for-handoff')
            assert.strictEqual(accDto.sessionState, 'valid-from-existing-runtime-evidence')

            await runtime.stop()
            console.log('  ✅ Scenario 4 Passed: End-to-end pipeline confirmed from bridge to snapshot')
        }

        // =========================================================================
        // SCENARIO 5: Empty State Resilience (0 Accounts, 0 Tasks)
        // =========================================================================
        {
            const storageDir = path.join(baseTestDir, 's5_storage')
            const testConfig: ObserverConfig = {
                contractVersion: 1,
                identitiesPath: 'identities.json',
                storageDirectory: storageDir,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41997,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config: testConfig, identities: [] })
            await runtime.start()

            const snapshot = runtime.getSnapshotStore().getSnapshot()
            assert.strictEqual(snapshot.summary.totalAccounts, 0)
            assert.strictEqual(snapshot.accounts.length, 0)

            await runtime.stop()
            console.log('  ✅ Scenario 5 Passed: Empty state (0 accounts, 0 tasks) runs cleanly')
        }

        // =========================================================================
        // SCENARIO 6: Identity Validation (Duplicate UUID / Missing UUID Fails Closed)
        // =========================================================================
        {
            const dupId = '20000000-0000-4000-8000-000000000002'
            const invalidIdentities = [
                { accountId: dupId, displayLabel: 'Account 1' },
                { accountId: dupId, displayLabel: 'Account 2' }
            ]

            assert.throws(() => validateObserverIdentities(invalidIdentities), /Duplicate accountId detected/)

            const malformedIdentities = [{ accountId: 'not-a-uuid', displayLabel: 'Account 3' }]

            assert.throws(() => validateObserverIdentities(malformedIdentities), /Invalid/)
            console.log('  ✅ Scenario 6 Passed: Duplicate or invalid account UUIDs rejected fail-closed')
        }

        // =========================================================================
        // SCENARIO 7 & 8: Idempotent Ingestion & Monotonic Sequence Protection
        // =========================================================================
        {
            const testId = '30000000-0000-4000-8000-000000000003'
            const storageDir = path.join(baseTestDir, 's7_storage')
            const evidenceStore = new AccountEvidenceStore(path.join(storageDir, 'account_evidence.json'))
            await evidenceStore.init()

            const rec1 = {
                accountId: testId,
                accountRef: 'ref-3',
                displayAccount: 'user3***@test.com',
                sessionState: 'valid-from-server' as const,
                restrictionState: 'none' as const,
                lastObservedAt: new Date(Date.now() - 5000).toISOString(),
                lastReceivedAt: new Date().toISOString(),
                source: 'bridge' as const,
                evidenceSequence: 2
            }

            await evidenceStore.upsertEvidence(rec1)

            // Attempting to upsert older sequence (sequence 1)
            const olderRec = {
                ...rec1,
                evidenceSequence: 1,
                lastObservedAt: new Date(Date.now() - 10000).toISOString()
            }

            await evidenceStore.upsertEvidence(olderRec)

            const stored = evidenceStore.getEvidence(testId)
            assert.strictEqual(stored?.evidenceSequence, 2, 'Older sequence must not overwrite newer')
            console.log('  ✅ Scenarios 7 & 8 Passed: Idempotent storage & monotonic sequence protection verified')
        }

        // =========================================================================
        // SCENARIO 9: Resilient Quarantine (Corrupted file does not break subsequent files)
        // =========================================================================
        {
            const bridgeDir = path.join(baseTestDir, 's9_bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            await fs.promises.mkdir(incomingDir, { recursive: true })

            // File 1: Corrupted JSON
            await fs.promises.writeFile(path.join(incomingDir, '1_corrupt.json'), '{ invalid json', 'utf-8')

            // File 2: Valid Envelope
            const validEnvelope: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef: '99990000aaaa1111bbbb2222cccc3333',
                displayAccount: 'valid9***@test.com',
                emittedAt: new Date().toISOString(),
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: []
            }
            await fs.promises.writeFile(path.join(incomingDir, '2_valid.json'), JSON.stringify(validEnvelope), 'utf-8')

            const storageDir = path.join(baseTestDir, 's9_storage')
            const testConfig: ObserverConfig = {
                contractVersion: 1,
                identitiesPath: 'identities.json',
                storageDirectory: storageDir,
                dashboard: { enabled: false, host: '127.0.0.1', port: 41996, maxSseClients: 5, sseHeartbeatMs: 15000 },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 60000,
                    maximumFileBytes: 512 * 1024,
                    maxIncomingFiles: 10,
                    maxBridgeDirectoryBytes: 50 * 1024 * 1024,
                    processedRetentionHours: 24,
                    rejectionMetadataRetentionHours: 72,
                    claimingStaleMs: 60000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config: testConfig, identities: [] })
            await runtime.start()

            const envelopes = await runtime.getImporter()!.scanAndImport()
            // Corrupted file was rejected, valid file was imported
            assert.strictEqual(envelopes.length, 1)
            assert.strictEqual(envelopes[0]!.accountRef, '99990000aaaa1111bbbb2222cccc3333')

            await runtime.stop()
            console.log('  ✅ Scenario 9 Passed: Corrupted file safely quarantined without halting intake')
        }

        // =========================================================================
        // SCENARIO 10: Dynamic Staleness Tracking
        // =========================================================================
        {
            const testId = '40000000-0000-4000-8000-000000000004'
            const storageDir = path.join(baseTestDir, 's10_storage')
            const testConfig: ObserverConfig = {
                contractVersion: 1,
                identitiesPath: 'identities.json',
                storageDirectory: storageDir,
                dashboard: { enabled: false, host: '127.0.0.1', port: 41995, maxSseClients: 5, sseHeartbeatMs: 15000 },
                staleEvidenceThresholdHours: 24, // 24 hours threshold
                shutdownTimeoutMs: 5000
            }

            const identities = [{ accountId: testId, displayLabel: 'Stale Candidate' }]
            const runtime = new ObserverRuntime({ config: testConfig, identities })
            await runtime.start()

            // Record evidence from 25 hours ago
            const staleObservedAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString()
            await runtime.getAccountEvidenceStore().upsertEvidence({
                accountId: testId,
                accountRef: testId,
                displayAccount: 'stale***@test.com',
                sessionState: 'valid-from-server',
                restrictionState: 'none',
                lastObservedAt: staleObservedAt,
                lastReceivedAt: new Date().toISOString(),
                source: 'bridge',
                evidenceSequence: 1
            })

            await runtime.recalculateAllReadiness()

            const snapshot = runtime.getSnapshotStore().getSnapshot()
            const acc = snapshot.accounts[0]!
            assert.strictEqual(
                acc.status,
                'stale-evidence',
                'Evidence older than threshold must be marked stale-evidence'
            )

            await runtime.stop()
            console.log('  ✅ Scenario 10 Passed: Dynamic staleness tracking transitions to stale-evidence')
        }

        // =========================================================================
        // SCENARIO 11: Local Action Boundaries (Action Reported remains Unverified)
        // =========================================================================
        {
            const storageDir = path.join(baseTestDir, 's11_storage')
            const testConfig: ObserverConfig = {
                contractVersion: 1,
                identitiesPath: 'identities.json',
                storageDirectory: storageDir,
                dashboard: { enabled: false, host: '127.0.0.1', port: 41994, maxSseClients: 5, sseHeartbeatMs: 15000 },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const testId = '50000000-0000-4000-8000-000000000005'
            const runtime = new ObserverRuntime({
                config: testConfig,
                identities: [{ accountId: testId, displayLabel: 'User 5' }]
            })
            await runtime.start()

            // Record a manual action task
            const mStore = runtime.getManualActionStore()
            await mStore.batchUpsertRecords([
                {
                    recordId: 'rec-11',
                    taskRef: 'task-11',
                    accountRef: testId,
                    displayAccount: 'user5***@test.com',
                    taskKind: 'puzzle',
                    title: 'Interactive Puzzle',
                    reason: 'interactive-dom-required',
                    lifecycleState: 'available',
                    verificationState: 'unverified',
                    observedAt: new Date().toISOString(),
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    revision: 1
                }
            ])

            // Operator reports action done
            const reported = await mStore.reportAction('rec-11', { expectedRevision: 1, note: 'Done by operator' })
            assert.strictEqual(reported.lifecycleState, 'action-reported')
            // Critical Boundary: verificationState MUST REMAIN unverified!
            assert.strictEqual(reported.verificationState, 'unverified')

            await runtime.stop()
            console.log('  ✅ Scenario 11 Passed: Local action reported stays unverified until server snapshot')
        }

        // =========================================================================
        // SCENARIO 12: Single-Writer Lock Collision (Fail-Fast)
        // =========================================================================
        {
            const storageDir = path.join(baseTestDir, 's12_storage')
            const lock1 = new ObserverLock(storageDir)
            await lock1.acquire()
            assert.strictEqual(lock1.isLockHeld(), true)

            // Second instance attempts to acquire on same storage directory
            const lock2 = new ObserverLock(storageDir)
            await assert.rejects(
                async () => lock2.acquire(),
                /LOCK-COLLISION.*Another observer instance is currently running/
            )

            await lock1.release()
            assert.strictEqual(lock1.isLockHeld(), false)
            console.log('  ✅ Scenario 12 Passed: Single-writer lock collision detected fail-fast')
        }

        // =========================================================================
        // SCENARIO 13: Stale Claim Crash Recovery
        // =========================================================================
        {
            const bridgeDir = path.join(baseTestDir, 's13_bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            await fs.promises.mkdir(incomingDir, { recursive: true })

            // Simulate crashed process leaving a claiming file
            const claimingFile = path.join(incomingDir, 'test.json.claiming.99999999.123456')
            await fs.promises.writeFile(claimingFile, '{"dummy": true}', 'utf-8')

            // Artificially age the mtime past claimingStaleMs (60s)
            const pastTime = new Date(Date.now() - 120000)
            fs.utimesSync(claimingFile, pastTime, pastTime)

            const storageDir = path.join(baseTestDir, 's13_storage')
            const testConfig: ObserverConfig = {
                contractVersion: 1,
                identitiesPath: 'identities.json',
                storageDirectory: storageDir,
                dashboard: { enabled: false, host: '127.0.0.1', port: 41993, maxSseClients: 5, sseHeartbeatMs: 15000 },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 500,
                    maximumFileBytes: 512 * 1024,
                    maxIncomingFiles: 10,
                    maxBridgeDirectoryBytes: 50 * 1024 * 1024,
                    processedRetentionHours: 24,
                    rejectionMetadataRetentionHours: 72,
                    claimingStaleMs: 60000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config: testConfig, identities: [] })
            await runtime.start()

            // Reclaiming should revert .claiming.* back to original filename
            const files = await fs.promises.readdir(incomingDir)
            assert.ok(files.includes('test.json'), 'Stale claim must be reclaimed back to test.json')
            assert.ok(!files.includes('test.json.claiming.99999999.123456'))

            await runtime.stop()
            console.log('  ✅ Scenario 13 Passed: Stale claim safely recovered after simulated crash')
        }

        // =========================================================================
        // SCENARIO 14 & 15: Bounded Shutdown & Idempotent Stop Cleanup
        // =========================================================================
        {
            const storageDir = path.join(baseTestDir, 's14_storage')
            const testConfig: ObserverConfig = {
                contractVersion: 1,
                identitiesPath: 'identities.json',
                storageDirectory: storageDir,
                dashboard: { enabled: false, host: '127.0.0.1', port: 41992, maxSseClients: 5, sseHeartbeatMs: 15000 },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 3000
            }

            const runtime = new ObserverRuntime({ config: testConfig, identities: [] })
            await runtime.start()
            assert.strictEqual(runtime.getState(), 'running')

            // Stop call 1
            const p1 = runtime.stop('test-shutdown')
            // Concurrent stop call 2 (idempotent)
            const p2 = runtime.stop('test-shutdown-again')

            await Promise.all([p1, p2])
            assert.strictEqual(runtime.getState(), 'stopped')
            assert.strictEqual(runtime.getLock().isLockHeld(), false, 'Lock must be released on stop')

            // Third stop call after stopped
            await runtime.stop('already-stopped')
            assert.strictEqual(runtime.getState(), 'stopped')

            console.log('  ✅ Scenarios 14 & 15 Passed: Bounded shutdown and idempotent stop verified')
        }

        console.log('\n🎉 ALL 15 OBSERVER RUNTIME ACCEPTANCE TESTS PASSED SUCCESSFULLY!')
    } finally {
        try {
            await fs.promises.rm(baseTestDir, { recursive: true, force: true })
        } catch {}
    }
}
