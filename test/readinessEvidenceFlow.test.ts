import assert from 'assert'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import http from 'http'
import { ObserverRuntime } from '../src/runtime/observer/ObserverRuntime'
import { ObserverConfig } from '../src/runtime/observer/ObserverConfig'
import { ObserverPaths } from '../src/runtime/observer/ObserverPaths'
import {
    AccountObservationEnvelope,
    computeStableAccountRef
} from '../src/contracts/AccountObservationContract'

function makeGetRequest(
    port: number,
    pathUrl: string,
    headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: pathUrl,
                method: 'GET',
                headers: {
                    Host: `127.0.0.1:${port}`,
                    ...headers
                }
            },
            res => {
                let data = ''
                res.setEncoding('utf8')
                res.on('data', chunk => {
                    data += chunk
                })
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode || 0, body: data, headers: res.headers })
                })
            }
        )
        req.on('error', reject)
        req.end()
    })
}

export async function runReadinessEvidenceFlowTests(): Promise<void> {
    console.log('🧪 Starting Readiness Evidence Flow & Bridge Diagnostics Acceptance Test Suite...')

    const baseTestDir = path.join(__dirname, 'temp_evidence_flow_test_' + Date.now())
    await fs.promises.mkdir(baseTestDir, { recursive: true })

    try {
        // =========================================================================
        // SCENARIO 1: Ground Truth Unknown & Present-Unverified (Zero Server Evidence)
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario1')
            const storageDir = path.join(testDir, 'data')
            const sessionsDir = path.join(testDir, 'sessions')
            await fs.promises.mkdir(storageDir, { recursive: true })
            await fs.promises.mkdir(sessionsDir, { recursive: true })

            // Create 2 accounts with local session files on disk
            const acc1Dir = path.join(sessionsDir, 'user1@test.com')
            const acc2Dir = path.join(sessionsDir, 'user2@test.com')
            await fs.promises.mkdir(acc1Dir, { recursive: true })
            await fs.promises.mkdir(acc2Dir, { recursive: true })
            await fs.promises.writeFile(path.join(acc1Dir, 'session_desktop.json'), JSON.stringify({ cookies: [] }), 'utf8')
            await fs.promises.writeFile(path.join(acc2Dir, 'session_desktop.json'), JSON.stringify({ cookies: [] }), 'utf8')

            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([
                    { email: 'user1@test.com', password: 'p1' },
                    { email: 'user2@test.com', password: 'p2' }
                ]),
                'utf8'
            )

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                sessionBasePath: sessionsDir,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41601,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: false,
                    bridgeDirectory: path.join(testDir, 'bridge')
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // Trigger manual recheck 3 times
            for (let i = 0; i < 3; i++) {
                runtime.getCoordinator().triggerCheck('manual')
                await new Promise(resolve => setTimeout(resolve, 50))
            }

            const snapshot = runtime.getSnapshotStore().getSnapshot()
            assert.strictEqual(snapshot.accounts.length, 2, 'Should load 2 accounts')

            for (const acc of snapshot.accounts) {
                assert.strictEqual(acc.status, 'unknown', 'Status must be unknown')
                assert.strictEqual(acc.sessionState, 'present-unverified', 'Session must be present-unverified')
                assert.strictEqual(acc.evidenceState, 'none', 'Evidence state must be none')
                assert.strictEqual(acc.evidenceObservedAt, undefined, 'evidenceObservedAt must be undefined')
                assert.ok(
                    acc.reasons.some(r => r.includes('Data sesi lokal ditemukan; validitas login belum diverifikasi')),
                    'Reasons must state local session found but unverified'
                )
                assert.strictEqual(
                    acc.nextAction,
                    'Penghasil bukti observasi belum terhubung',
                    'NextAction must state producer not connected'
                )
                assert.ok(!acc.nextAction.includes('Run Main observation pass'), 'Must not give false CLI command')
                assert.ok(!acc.nextAction.includes('Authenticate'), 'Must not prematurely demand authentication')
            }

            await runtime.stop()
            console.log('  ✅ Scenario 1 Passed: Ground truth baseline unknown & present-unverified confirmed')
        }

        // =========================================================================
        // SCENARIO 2: Deterministic 1:1 Account Matching Updates to Technically Ready
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario2')
            const storageDir = path.join(testDir, 'data')
            const bridgeDir = path.join(testDir, 'bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            const keyFile = path.join(testDir, 'reference_key.bin')
            await fs.promises.mkdir(storageDir, { recursive: true })
            await fs.promises.mkdir(incomingDir, { recursive: true })

            // 32-byte reference key
            const rawKey = crypto.randomBytes(32)
            await fs.promises.writeFile(keyFile, rawKey)

            const targetEmail = 'bob.ready@example.com'
            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([{ email: targetEmail, password: 'secretpassword123' }]),
                'utf8'
            )

            // Calculate exact HMAC accountRef for the normalized email
            const expectedAccountRef = computeStableAccountRef(rawKey, targetEmail)

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                bridgeReferenceKeyPath: keyFile,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41602,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 500
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // Construct valid envelope
            const emittedAt = new Date().toISOString()
            const envelope: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef: expectedAccountRef,
                displayAccount: 'bob***@example.com',
                emittedAt,
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: []
            }

            await fs.promises.writeFile(
                path.join(incomingDir, 'obs_bob.json'),
                JSON.stringify(envelope, null, 2),
                'utf8'
            )

            // Allow polling cycle to import and trigger check
            await new Promise(resolve => setTimeout(resolve, 700))

            const snapshot = runtime.getSnapshotStore().getSnapshot()
            assert.strictEqual(snapshot.accounts.length, 1)
            const acc = snapshot.accounts[0]!

            assert.strictEqual(acc.status, 'technically-ready-for-handoff', 'Account should transition to technically-ready-for-handoff')
            assert.strictEqual(acc.evidenceState, 'present', 'EvidenceState should be present')
            assert.strictEqual(acc.evidenceObservedAt, emittedAt, 'evidenceObservedAt should match envelope timestamp')
            assert.strictEqual(acc.sessionState, 'valid-from-existing-runtime-evidence')

            await runtime.stop()
            console.log('  ✅ Scenario 2 Passed: Deterministic 1:1 HMAC matching updates account to ready')
        }

        // =========================================================================
        // SCENARIO 3: Identity Isolation / Collision Resistance
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario3')
            const storageDir = path.join(testDir, 'data')
            const bridgeDir = path.join(testDir, 'bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            const keyFile = path.join(testDir, 'reference_key.bin')
            await fs.promises.mkdir(storageDir, { recursive: true })
            await fs.promises.mkdir(incomingDir, { recursive: true })

            const rawKey = crypto.randomBytes(32)
            await fs.promises.writeFile(keyFile, rawKey)

            // Two accounts that share identical redacted mask
            const email1 = 'johndoe1@example.com'
            const email2 = 'johndoe2@example.com'
            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([
                    { email: email1, password: 'p1' },
                    { email: email2, password: 'p2' }
                ]),
                'utf8'
            )

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                bridgeReferenceKeyPath: keyFile,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41603,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 500
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // Provide evidence ONLY for account 1
            const accountRef1 = computeStableAccountRef(rawKey, email1)
            const envelope: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef: accountRef1,
                displayAccount: 'johndoe1***@example.com',
                emittedAt: new Date().toISOString(),
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: []
            }

            await fs.promises.writeFile(
                path.join(incomingDir, 'obs_account1.json'),
                JSON.stringify(envelope, null, 2),
                'utf8'
            )

            await new Promise(resolve => setTimeout(resolve, 700))

            const snapshot = runtime.getSnapshotStore().getSnapshot()
            assert.strictEqual(snapshot.accounts.length, 2)

            // Account 1 should be ready
            const readyAccounts = snapshot.accounts.filter(a => a.status === 'technically-ready-for-handoff')
            const unknownAccounts = snapshot.accounts.filter(a => a.status === 'unknown')

            assert.strictEqual(readyAccounts.length, 1, 'Only account 1 should be technically ready')
            assert.strictEqual(unknownAccounts.length, 1, 'Account 2 must remain unknown')

            assert.strictEqual(readyAccounts[0]!.evidenceState, 'present')
            assert.strictEqual(unknownAccounts[0]!.evidenceState, 'none')

            await runtime.stop()
            console.log('  ✅ Scenario 3 Passed: Identity isolation & collision resistance confirmed')
        }

        // =========================================================================
        // SCENARIO 4: Unmatched accountRef Rejection and Quarantine
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario4')
            const storageDir = path.join(testDir, 'data')
            const bridgeDir = path.join(testDir, 'bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            const rejectedDir = path.join(bridgeDir, 'rejected')
            const keyFile = path.join(testDir, 'reference_key.bin')
            await fs.promises.mkdir(storageDir, { recursive: true })
            await fs.promises.mkdir(incomingDir, { recursive: true })

            const rawKey = crypto.randomBytes(32)
            await fs.promises.writeFile(keyFile, rawKey)

            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([{ email: 'carol@example.com', password: 'p1' }]),
                'utf8'
            )

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                bridgeReferenceKeyPath: keyFile,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41604,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 500
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // Envelope with unknown accountRef
            const unknownRef = computeStableAccountRef(rawKey, 'stranger@example.com')
            const envelope: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef: unknownRef,
                displayAccount: 'stranger***@example.com',
                emittedAt: new Date().toISOString(),
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: []
            }

            await fs.promises.writeFile(
                path.join(incomingDir, 'obs_stranger.json'),
                JSON.stringify(envelope, null, 2),
                'utf8'
            )

            await new Promise(resolve => setTimeout(resolve, 700))

            // Check bridge rejected directory
            const rejectedFiles = await fs.promises.readdir(rejectedDir)
            assert.ok(rejectedFiles.length >= 1, 'Unmatched envelope must be quarantined to bridge/rejected/')

            // Check bridge diagnostics
            const snapshot = runtime.getSnapshotStore().getSnapshot()
            assert.ok(snapshot.bridgeDiagnostics, 'bridgeDiagnostics must exist')
            assert.ok(snapshot.bridgeDiagnostics!.rejectedCount >= 1, 'rejectedCount must be incremented')
            assert.ok(
                snapshot.bridgeDiagnostics!.lastDiagnosticMessage?.includes('Unmatched accountRef'),
                'Diagnostic message must record unmatched accountRef'
            )

            // Check loaded account status: must NOT be modified to auth-required or blocked
            const carol = snapshot.accounts[0]!
            assert.strictEqual(carol.status, 'unknown', 'Carol status must remain untouched as unknown')
            assert.strictEqual(carol.evidenceState, 'none', 'Carol evidenceState must remain none')

            await runtime.stop()
            console.log('  ✅ Scenario 4 Passed: Unmatched accountRef quarantined and loaded account isolated')
        }

        // =========================================================================
        // SCENARIO 5: Clock-Skew Anomaly Rejection
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario5')
            const storageDir = path.join(testDir, 'data')
            const bridgeDir = path.join(testDir, 'bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            const rejectedDir = path.join(bridgeDir, 'rejected')
            const keyFile = path.join(testDir, 'reference_key.bin')
            await fs.promises.mkdir(storageDir, { recursive: true })
            await fs.promises.mkdir(incomingDir, { recursive: true })

            const rawKey = crypto.randomBytes(32)
            await fs.promises.writeFile(keyFile, rawKey)

            const email = 'dave@example.com'
            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([{ email, password: 'p1' }]),
                'utf8'
            )

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                bridgeReferenceKeyPath: keyFile,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41605,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 500
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // Envelope with emittedAt 15 minutes into the future
            const futureDate = new Date(Date.now() + 15 * 60 * 1000).toISOString()
            const accountRef = computeStableAccountRef(rawKey, email)
            const envelope: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef,
                displayAccount: 'dave***@example.com',
                emittedAt: futureDate,
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: []
            }

            await fs.promises.writeFile(
                path.join(incomingDir, 'obs_future.json'),
                JSON.stringify(envelope, null, 2),
                'utf8'
            )

            await new Promise(resolve => setTimeout(resolve, 700))

            const rejectedFiles = await fs.promises.readdir(rejectedDir)
            assert.ok(rejectedFiles.length >= 1, 'Future envelope must be quarantined to bridge/rejected/')

            const snapshot = runtime.getSnapshotStore().getSnapshot()
            assert.ok(
                snapshot.bridgeDiagnostics?.lastDiagnosticMessage?.includes('Clock skew anomaly'),
                'Must report clock skew anomaly'
            )
            assert.strictEqual(snapshot.accounts[0]!.status, 'unknown', 'Account status must remain untouched')
            assert.strictEqual(snapshot.accounts[0]!.evidenceState, 'none')

            await runtime.stop()
            console.log('  ✅ Scenario 5 Passed: Clock-skew anomaly quarantined without altering account state')
        }

        // =========================================================================
        // SCENARIO 6: Staleness Transition Based on observedAt
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario6')
            const storageDir = path.join(testDir, 'data')
            const bridgeDir = path.join(testDir, 'bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            const keyFile = path.join(testDir, 'reference_key.bin')
            await fs.promises.mkdir(storageDir, { recursive: true })
            await fs.promises.mkdir(incomingDir, { recursive: true })

            const rawKey = crypto.randomBytes(32)
            await fs.promises.writeFile(keyFile, rawKey)

            const email = 'eve@example.com'
            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([{ email, password: 'p1' }]),
                'utf8'
            )

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                bridgeReferenceKeyPath: keyFile,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41606,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 500
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // Envelope observed 52 hours ago (older than 48-hour threshold)
            const pastTimestamp = new Date(Date.now() - 52 * 3600 * 1000).toISOString()
            const accountRef = computeStableAccountRef(rawKey, email)
            const envelope: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef,
                displayAccount: 'eve***@example.com',
                emittedAt: pastTimestamp,
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: []
            }

            await fs.promises.writeFile(
                path.join(incomingDir, 'obs_stale.json'),
                JSON.stringify(envelope, null, 2),
                'utf8'
            )

            await new Promise(resolve => setTimeout(resolve, 700))

            const snapshot = runtime.getSnapshotStore().getSnapshot()
            const acc = snapshot.accounts[0]!

            assert.strictEqual(acc.status, 'stale-evidence', 'Status must be stale-evidence')
            assert.strictEqual(acc.evidenceState, 'stale', 'Evidence state must be stale')
            assert.ok(
                acc.reasons.some(r => r.includes('stale evidence')),
                'Reasons must record stale evidence'
            )
            assert.strictEqual(
                acc.nextAction,
                'Segarkan bukti akun melalui observasi terbaru',
                'NextAction must guide user to refresh evidence'
            )

            await runtime.stop()
            console.log('  ✅ Scenario 6 Passed: Staleness transition correctly triggered by observedAt')
        }

        // =========================================================================
        // SCENARIO 7: Background Staleness Sweep While Paused
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario7')
            const storageDir = path.join(testDir, 'data')
            const bridgeDir = path.join(testDir, 'bridge')
            const incomingDir = path.join(bridgeDir, 'incoming')
            const keyFile = path.join(testDir, 'reference_key.bin')
            await fs.promises.mkdir(storageDir, { recursive: true })
            await fs.promises.mkdir(incomingDir, { recursive: true })

            const rawKey = crypto.randomBytes(32)
            await fs.promises.writeFile(keyFile, rawKey)

            const email = 'frank@example.com'
            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([{ email, password: 'p1' }]),
                'utf8'
            )

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                bridgeReferenceKeyPath: keyFile,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41607,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir,
                    pollIntervalMs: 500
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // 1. Ingest fresh valid evidence
            const freshTime = new Date().toISOString()
            const accountRef = computeStableAccountRef(rawKey, email)
            const envelope: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef,
                displayAccount: 'frank***@example.com',
                emittedAt: freshTime,
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: []
            }

            await fs.promises.writeFile(
                path.join(incomingDir, 'obs_frank.json'),
                JSON.stringify(envelope, null, 2),
                'utf8'
            )

            await new Promise(resolve => setTimeout(resolve, 700))

            const snapInitial = runtime.getSnapshotStore().getSnapshot()
            assert.strictEqual(snapInitial.accounts[0]!.status, 'technically-ready-for-handoff')
            assert.strictEqual(snapInitial.accounts[0]!.evidenceState, 'present')

            // 2. Pause monitoring
            runtime.getCoordinator().pause()
            const snapPaused = runtime.getSnapshotStore().getSnapshot()
            assert.strictEqual(snapPaused.monitoring.monitoringState, 'paused')

            // 3. Age the evidence record to 55 hours ago in the store to simulate time passage
            const agedTimestamp = new Date(Date.now() - 55 * 3600 * 1000).toISOString()
            const rec = (runtime as any).accountEvidenceStore.getEvidence(email)
            assert.ok(rec, 'Evidence record must exist')
            rec.lastObservedAt = agedTimestamp
            await (runtime as any).accountEvidenceStore.save()

            // 4. Fire background staleness sweep
            await runtime.executeStalenessSweep()

            // 5. Verify account is now stale and coordinator is STILL paused
            const snapAfterSweep = runtime.getSnapshotStore().getSnapshot()
            assert.strictEqual(
                snapAfterSweep.accounts[0]!.status,
                'stale-evidence',
                'Account must transition to stale-evidence after sweep'
            )
            assert.strictEqual(snapAfterSweep.accounts[0]!.evidenceState, 'stale')
            assert.strictEqual(
                snapAfterSweep.monitoring.monitoringState,
                'paused',
                'Monitoring state must remain paused after staleness sweep'
            )

            await runtime.stop()
            console.log('  ✅ Scenario 7 Passed: Background staleness sweep evaluates while monitoring is paused')
        }

        // =========================================================================
        // SCENARIO 8: Bridge Intake Through Coordinator & Concurrency Discipline
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario8')
            const storageDir = path.join(testDir, 'data')
            await fs.promises.mkdir(storageDir, { recursive: true })

            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([{ email: 'grace@example.com', password: 'p1' }]),
                'utf8'
            )

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                dashboard: {
                    enabled: false,
                    host: '127.0.0.1',
                    port: 41608,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                staleEvidenceThresholdHours: 48,
                checkIntervalMs: 60000,
                checkTimeoutMs: 10000,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            const coordinator = runtime.getCoordinator()

            // First check triggered with 'bridge' reason
            const result1 = coordinator.triggerCheck('bridge')
            assert.ok(result1.checkId.startsWith('chk-'), 'Must return check ID')
            assert.strictEqual(result1.alreadyRunning, false, 'First check is newly launched')

            // Trigger second check concurrently while first is in-flight
            const result2 = coordinator.triggerCheck('bridge')
            assert.strictEqual(result2.checkId, result1.checkId, 'Concurrent call coalesces into active check ID')
            assert.strictEqual(result2.alreadyRunning, true, 'Indicates check is already running')

            await runtime.stop()
            console.log('  ✅ Scenario 8 Passed: Bridge intake routes through coordinator with concurrency discipline')
        }

        // =========================================================================
        // SCENARIO 9: Platform-Safe Reference Key Loader
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario9')
            await fs.promises.mkdir(testDir, { recursive: true })

            // 1. Valid 32-byte key file
            const validKeyFile = path.join(testDir, 'valid_key.bin')
            const keyBytes = crypto.randomBytes(32)
            await fs.promises.writeFile(validKeyFile, keyBytes)
            const loadedKey = ObserverPaths.loadBridgeReferenceKey(validKeyFile)
            assert.ok(Buffer.isBuffer(loadedKey), 'Loaded key must be a Buffer')
            assert.strictEqual(loadedKey!.length, 32, 'Key length must be 32 bytes')

            // 2. Non-existent file path -> fails fast with [CONFIG-SECURITY]
            assert.throws(
                () => ObserverPaths.loadBridgeReferenceKey(path.join(testDir, 'does_not_exist.bin')),
                (err: any) => err.message.includes('[CONFIG-SECURITY]') && err.message.includes('does not exist'),
                'Missing key file must fail fast'
            )

            // 3. Directory path -> fails fast with [CONFIG-SECURITY]
            const dirKey = path.join(testDir, 'key_dir')
            await fs.promises.mkdir(dirKey, { recursive: true })
            assert.throws(
                () => ObserverPaths.loadBridgeReferenceKey(dirKey),
                (err: any) => err.message.includes('[CONFIG-SECURITY]') && err.message.includes('is a directory'),
                'Directory path passed as key file must fail fast'
            )

            // 4. Short key file (< 32 bytes) -> fails fast with minimum requirement
            const shortKeyFile = path.join(testDir, 'short_key.bin')
            await fs.promises.writeFile(shortKeyFile, Buffer.from('short-16-bytes!'))
            assert.throws(
                () => ObserverPaths.loadBridgeReferenceKey(shortKeyFile),
                (err: any) => err.message.includes('[CONFIG-SECURITY]') && err.message.includes('minimum 32 bytes required'),
                'Key shorter than 32 bytes must fail fast'
            )

            // 5. Undefined key path -> returns null cleanly without creating or generating random keys
            const nullKey = ObserverPaths.loadBridgeReferenceKey(undefined)
            assert.strictEqual(nullKey, null, 'Undefined keyPath must return null')

            console.log('  ✅ Scenario 9 Passed: Platform-safe reference key loader fail-fast guarantees confirmed')
        }

        // =========================================================================
        // SCENARIO 10: UI & DTO Privacy & Sanitization
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'scenario10')
            const storageDir = path.join(testDir, 'data')
            const bridgeDir = path.join(testDir, 'bridge')
            await fs.promises.mkdir(storageDir, { recursive: true })
            await fs.promises.mkdir(bridgeDir, { recursive: true })

            const accountsFile = path.join(testDir, 'accounts.json')
            await fs.promises.writeFile(
                accountsFile,
                JSON.stringify([
                    { email: 'supersecret_admin@bank.com', password: 'extremely_sensitive_pass_123' }
                ]),
                'utf8'
            )

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: accountsFile,
                storageDirectory: storageDir,
                dashboard: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: 41610,
                    maxSseClients: 5,
                    sseHeartbeatMs: 15000
                },
                observationBridge: {
                    enabled: true,
                    bridgeDirectory: bridgeDir
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // Fetch snapshot via HTTP API
            const res = await makeGetRequest(41610, '/api/status')
            assert.strictEqual(res.statusCode, 200)
            const snapshot = JSON.parse(res.body)

            // 1. activeDirectory must NOT leak drive letters or full OS path
            const activeDir = snapshot.bridgeDiagnostics?.activeDirectory
            assert.ok(activeDir, 'activeDirectory must be present')
            assert.ok(!activeDir.includes(':'), 'activeDirectory must not leak drive letters')
            assert.ok(!activeDir.includes('Users'), 'activeDirectory must not leak OS user directories')

            // 2. Account DTO must expose evidenceState
            assert.strictEqual(snapshot.accounts[0].evidenceState, 'none')

            // 3. Zero credential leakage anywhere in entire response payload
            assert.ok(
                !res.body.includes('extremely_sensitive_pass_123'),
                'Raw passwords must never appear in snapshot DTO'
            )
            assert.ok(
                !res.body.includes('supersecret_admin@bank.com'),
                'Raw unmasked email must not appear in snapshot DTO'
            )

            // 4. Verify static dashboard frontend code contains zero innerHTML
            const appJsPath = path.join(__dirname, '../src/dashboard/public/app.js')
            const appJsContent = await fs.promises.readFile(appJsPath, 'utf8')
            assert.strictEqual(
                appJsContent.includes('innerHTML'),
                false,
                'app.js must strictly forbid innerHTML for XSS safety'
            )

            const htmlPath = path.join(__dirname, '../src/dashboard/public/index.html')
            const htmlContent = await fs.promises.readFile(htmlPath, 'utf8')
            assert.ok(
                htmlContent.includes('Bukti Observasi'),
                'index.html must include the Bukti Observasi table header'
            )

            await runtime.stop()
            console.log('  ✅ Scenario 10 Passed: UI & DTO privacy, relative paths, and zero innerHTML verified')
        }

        console.log('\n🎉 ALL 10 READINESS EVIDENCE FLOW ACCEPTANCE TESTS PASSED SUCCESSFULLY!')
    } finally {
        // Clean up temporary test files
        try {
            await fs.promises.rm(baseTestDir, { recursive: true, force: true })
        } catch {
            // Ignore cleanup failure
        }
    }
}
