import assert from 'assert'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { ObserverRuntime } from '../src/runtime/observer/ObserverRuntime'
import { ObserverCoordinator } from '../src/runtime/observer/ObserverCoordinator'
import { ReadinessSnapshotStore } from '../src/dashboard/ReadinessSnapshotStore'
import { AccountReadinessEvaluator } from '../src/readiness/AccountReadinessEvaluator'
import { ObserverConfig } from '../src/runtime/observer/ObserverConfig'

function makePostRequest(
    port: number,
    pathUrl: string,
    payload: any,
    headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const bodyStr = typeof payload === 'string' ? payload : JSON.stringify(payload)
        const reqHeaders: http.OutgoingHttpHeaders = {
            Host: `127.0.0.1:${port}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(bodyStr),
            ...headers
        }

        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: pathUrl,
                method: 'POST',
                headers: reqHeaders
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
        req.write(bodyStr)
        req.end()
    })
}

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

export async function runObserverControlTests(): Promise<void> {
    console.log('🧪 Starting ObserverControl & Operational Acceptance Test Suite...')

    const baseTestDir = path.join(__dirname, 'temp_control_test_' + Date.now())
    await fs.promises.mkdir(baseTestDir, { recursive: true })

    try {
        // =========================================================================
        // TEST 1: Recheck calls local evaluator and updates snapshot store
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'test1')
            await fs.promises.mkdir(testDir, { recursive: true })

            const accounts = [
                { id: '11111111-1111-4111-8111-111111111111', email: 'acc1@test.com', password: 'p1' },
                { id: '22222222-2222-4222-8222-222222222222', email: 'acc2@test.com', password: 'p2' }
            ]
            await fs.promises.writeFile(path.join(testDir, 'accounts.json'), JSON.stringify(accounts, null, 2))

            const port = 41501
            const config: ObserverConfig = {
                contractVersion: 1,
                storageDirectory: path.join(testDir, 'data'),
                sessionBasePath: path.join(testDir, 'sessions'),
                dashboard: {
                    enabled: true,
                    host: '127.0.0.1',
                    port,
                    maxSseClients: 5,
                    sseHeartbeatMs: 5000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000,
                checkIntervalMs: 60000,
                checkTimeoutMs: 10000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // 1. Get CSRF token
            const sessionRes = await makeGetRequest(port, '/api/session')
            assert.strictEqual(sessionRes.statusCode, 200)
            const csrfToken = JSON.parse(sessionRes.body).csrfToken

            // 2. Trigger recheck via POST /api/control
            const recheckRes = await makePostRequest(
                port,
                '/api/control',
                { action: 'recheck' },
                { 'X-CSRF-Token': csrfToken }
            )
            assert.strictEqual(recheckRes.statusCode, 202, 'Should immediately return 202 Accepted')
            const recheckBody = JSON.parse(recheckRes.body)
            assert.strictEqual(recheckBody.success, true)
            assert.strictEqual(recheckBody.action, 'recheck')
            assert.ok(recheckBody.checkId.startsWith('chk-'))

            // 3. Wait briefly for async execution to complete
            await new Promise(r => setTimeout(r, 200))

            // 4. Verify snapshot reflects completion
            const statusRes = await makeGetRequest(port, '/api/status')
            assert.strictEqual(statusRes.statusCode, 200)
            const snapshot = JSON.parse(statusRes.body)

            assert.strictEqual(snapshot.monitoring.checkingState, 'idle')
            assert.ok(snapshot.monitoring.lastCheckedAt)
            assert.ok(snapshot.monitoring.lastSuccessfulCheckAt)
            assert.strictEqual(snapshot.monitoring.lastResultSummary.accountsChecked, 2)
            assert.strictEqual(snapshot.monitoring.lastResultSummary.errorCount, 0)

            await runtime.stop('test-done')
            console.log('  ✅ Test 1 Passed: Recheck immediately returns 202 and completes local evaluation')
        }

        // =========================================================================
        // TEST 2: Coalescing concurrent clicks and scheduled checks into single run
        // =========================================================================
        {
            let executionCallCount = 0
            const mockStore = new ReadinessSnapshotStore({ maxTimelineEntries: 10, now: () => Date.now() })

            const coordinator = new ObserverCoordinator({
                checkIntervalMs: 60000,
                checkTimeoutMs: 5000,
                snapshotStore: mockStore,
                executeCheck: async () => {
                    executionCallCount++
                    await new Promise(r => setTimeout(r, 100))
                    return { accountsChecked: 1, errorCount: 0 }
                },
                onApplyStagedResults: () => {}
            })

            coordinator.start()

            // Trigger two checks simultaneously
            const call1 = coordinator.triggerCheck('manual')
            const call2 = coordinator.triggerCheck('manual')

            assert.strictEqual(call1.alreadyRunning, false)
            assert.strictEqual(call2.alreadyRunning, true, 'Second call should report alreadyRunning: true')
            assert.strictEqual(call1.checkId, call2.checkId, 'Both calls should share the same checkId')

            // Wait for completion
            await new Promise(r => setTimeout(r, 150))
            assert.strictEqual(executionCallCount, 1, 'Only exactly 1 underlying execution must run')

            await coordinator.stop()
            mockStore.dispose()
            console.log('  ✅ Test 2 Passed: Concurrent checks coalesced into a single active check')
        }

        // =========================================================================
        // TEST 3: Pause stops future scheduled checks
        // =========================================================================
        {
            let checkTriggerCount = 0
            const mockStore = new ReadinessSnapshotStore({ maxTimelineEntries: 10, now: () => Date.now() })

            const coordinator = new ObserverCoordinator({
                checkIntervalMs: 100, // short 100ms interval
                checkTimeoutMs: 5000,
                snapshotStore: mockStore,
                executeCheck: async () => {
                    checkTriggerCount++
                    return { accountsChecked: 1, errorCount: 0 }
                },
                onApplyStagedResults: () => {}
            })

            coordinator.start()
            const initialStatus = coordinator.getStatus()
            assert.strictEqual(initialStatus.monitoringState, 'running')
            assert.ok(initialStatus.nextCheckAt, 'Should have nextCheckAt scheduled')

            // Pause monitoring
            const pausedStatus = coordinator.pause()
            assert.strictEqual(pausedStatus.monitoringState, 'paused')
            assert.strictEqual(pausedStatus.nextCheckAt, undefined, 'nextCheckAt should be cleared on pause')

            // Wait 250ms (longer than 100ms interval)
            await new Promise(r => setTimeout(r, 250))
            assert.strictEqual(checkTriggerCount, 0, 'No periodic checks should execute while paused')

            await coordinator.stop()
            mockStore.dispose()
            console.log('  ✅ Test 3 Passed: Pause stops scheduled checks and clears nextCheckAt')
        }

        // =========================================================================
        // TEST 4: Manual recheck while paused does not re-enable periodic scheduler
        // =========================================================================
        {
            let checkCount = 0
            const mockStore = new ReadinessSnapshotStore({ maxTimelineEntries: 10, now: () => Date.now() })

            const coordinator = new ObserverCoordinator({
                checkIntervalMs: 100,
                checkTimeoutMs: 5000,
                snapshotStore: mockStore,
                executeCheck: async () => {
                    checkCount++
                    return { accountsChecked: 1, errorCount: 0 }
                },
                onApplyStagedResults: () => {}
            })

            coordinator.start()
            coordinator.pause()
            assert.strictEqual(coordinator.getStatus().monitoringState, 'paused')

            // Trigger manual recheck while paused
            const res = coordinator.triggerCheck('manual')
            assert.strictEqual(res.checkingState, 'checking')

            await new Promise(r => setTimeout(r, 50))

            const afterCheckStatus = coordinator.getStatus()
            assert.strictEqual(afterCheckStatus.monitoringState, 'paused', 'State must stay paused')
            assert.strictEqual(afterCheckStatus.nextCheckAt, undefined, 'nextCheckAt must remain undefined')
            assert.strictEqual(checkCount, 1)

            // Wait another 200ms
            await new Promise(r => setTimeout(r, 200))
            assert.strictEqual(checkCount, 1, 'Scheduler must not run periodic checks')

            await coordinator.stop()
            mockStore.dispose()
            console.log('  ✅ Test 4 Passed: Manual recheck while paused does not restart scheduler')
        }

        // =========================================================================
        // TEST 5: Repeated resume calls are idempotent
        // =========================================================================
        {
            const mockStore = new ReadinessSnapshotStore({ maxTimelineEntries: 10, now: () => Date.now() })

            const coordinator = new ObserverCoordinator({
                checkIntervalMs: 10000,
                checkTimeoutMs: 5000,
                snapshotStore: mockStore,
                executeCheck: async () => ({ accountsChecked: 1, errorCount: 0 }),
                onApplyStagedResults: () => {}
            })

            coordinator.start()
            coordinator.pause()

            const s1 = coordinator.resume()
            const s2 = coordinator.resume()
            const s3 = coordinator.resume()

            assert.strictEqual(s1.monitoringState, 'running')
            assert.strictEqual(s2.monitoringState, 'running')
            assert.strictEqual(s3.monitoringState, 'running')
            assert.strictEqual(s1.nextCheckAt, s2.nextCheckAt, 'nextCheckAt must not drift or duplicate')

            await coordinator.stop()
            mockStore.dispose()
            console.log('  ✅ Test 5 Passed: Repeated resume calls are idempotent and maintain single scheduler')
        }

        // =========================================================================
        // TEST 6: Pause during checking sets pendingPause, finishes check, then pauses
        // =========================================================================
        {
            const mockStore = new ReadinessSnapshotStore({ maxTimelineEntries: 10, now: () => Date.now() })

            const coordinator = new ObserverCoordinator({
                checkIntervalMs: 10000,
                checkTimeoutMs: 5000,
                snapshotStore: mockStore,
                executeCheck: async () => {
                    await new Promise(r => setTimeout(r, 120))
                    return { accountsChecked: 3, errorCount: 0 }
                },
                onApplyStagedResults: () => {}
            })

            coordinator.start()
            coordinator.triggerCheck('manual')

            // Request pause while check is actively running
            const pauseRes = coordinator.pause()
            assert.strictEqual(pauseRes.pendingPause, true)
            assert.strictEqual(pauseRes.monitoringState, 'running')
            assert.strictEqual(pauseRes.checkingState, 'checking')

            // Wait for active check to complete
            await new Promise(r => setTimeout(r, 160))

            const finalStatus = coordinator.getStatus()
            assert.strictEqual(finalStatus.monitoringState, 'paused')
            assert.strictEqual(finalStatus.pendingPause, false)
            assert.strictEqual(finalStatus.checkingState, 'idle')
            assert.strictEqual(finalStatus.lastResultSummary?.accountsChecked, 3)

            await coordinator.stop()
            mockStore.dispose()
            console.log('  ✅ Test 6 Passed: Pending pause completes active check before transitioning to paused')
        }

        // =========================================================================
        // TEST 7: Timeout marks failed, and late-finishing writes are REJECTED
        // =========================================================================
        {
            let appliedStagedCount = 0
            let underlyingJobFinished = false
            const mockStore = new ReadinessSnapshotStore({ maxTimelineEntries: 10, now: () => Date.now() })

            const coordinator = new ObserverCoordinator({
                checkIntervalMs: 10000,
                checkTimeoutMs: 100, // 100ms timeout
                snapshotStore: mockStore,
                executeCheck: async signal => {
                    // Simulates job that takes 250ms (exceeding 100ms timeout)
                    await new Promise(r => setTimeout(r, 250))
                    underlyingJobFinished = true
                    return {
                        accountsChecked: 5,
                        errorCount: 0,
                        stagedAccounts: [
                            {
                                readiness: {
                                    accountId: 'acc-late',
                                    displayAccount: 'Late Acc',
                                    status: 'technically-ready'
                                } as any,
                                tasks: []
                            }
                        ]
                    }
                },
                onApplyStagedResults: () => {
                    appliedStagedCount++
                }
            })

            coordinator.start()
            coordinator.triggerCheck('manual')

            // Wait 130ms for timeout to fire
            await new Promise(r => setTimeout(r, 130))

            const timedOutStatus = coordinator.getStatus()
            assert.strictEqual(timedOutStatus.checkingState, 'failed')
            assert.ok(timedOutStatus.lastResultSummary?.errorMessage?.includes('melebihi batas waktu'))

            // Wait another 160ms for underlying slow job to finish
            await new Promise(r => setTimeout(r, 160))
            assert.strictEqual(underlyingJobFinished, true, 'Underlying job should have finished')
            assert.strictEqual(appliedStagedCount, 0, 'Late staged results must be rejected and NOT applied')

            await coordinator.stop()
            mockStore.dispose()
            console.log('  ✅ Test 7 Passed: Timeout handled fail-closed and late staged results rejected')
        }

        // =========================================================================
        // TEST 8: Staleness calculation is based on wall-clock time and not frozen by pause
        // =========================================================================
        {
            const evaluator = new AccountReadinessEvaluator()
            const oldTimestamp = new Date(Date.now() - 50 * 3600 * 1000).toISOString() // 50 hours ago

            const readiness = evaluator.evaluate(
                { accountId: '00000000-0000-0000-0000-000000000001', email: 'user@test.com' },
                [],
                {
                    sessionValid: true,
                    lastObservedAt: oldTimestamp,
                    source: 'bridge'
                },
                { staleThresholdHours: 48, nowMs: Date.now() }
            )

            assert.strictEqual(readiness.status, 'stale-evidence')
            assert.strictEqual(readiness.nextAction, 'Segarkan bukti akun melalui observasi terbaru')
            assert.strictEqual(
                readiness.lastObservedAt,
                oldTimestamp,
                'lastObservedAt must not be modified to Date.now()'
            )
            console.log(
                '  ✅ Test 8 Passed: Evidence age preserved and transitions to stale-evidence based on wall-clock time'
            )
        }

        // =========================================================================
        // TEST 9: Comprehensive Control API Security
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'test9')
            await fs.promises.mkdir(testDir, { recursive: true })

            const port = 41509
            const config: ObserverConfig = {
                contractVersion: 1,
                storageDirectory: path.join(testDir, 'data'),
                sessionBasePath: path.join(testDir, 'sessions'),
                dashboard: {
                    enabled: true,
                    host: '127.0.0.1',
                    port,
                    maxSseClients: 5,
                    sseHeartbeatMs: 5000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000,
                checkIntervalMs: 60000,
                checkTimeoutMs: 10000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // 9A: Missing CSRF token -> 403 Forbidden
            const noCsrfRes = await makePostRequest(port, '/api/control', { action: 'pause' })
            assert.strictEqual(noCsrfRes.statusCode, 403, 'Should reject missing CSRF token with 403')

            // 9B: Invalid CSRF token -> 403 Forbidden
            const badCsrfRes = await makePostRequest(
                port,
                '/api/control',
                { action: 'pause' },
                { 'X-CSRF-Token': 'invalid-token-12345' }
            )
            assert.strictEqual(badCsrfRes.statusCode, 403, 'Should reject invalid CSRF token with 403')

            // Get valid CSRF token
            const sessionRes = await makeGetRequest(port, '/api/session')
            const validToken = JSON.parse(sessionRes.body).csrfToken

            // 9C: GET on control endpoint -> 405 Method Not Allowed
            const getControlRes = await makeGetRequest(port, '/api/control')
            assert.strictEqual(getControlRes.statusCode, 405, 'Should reject GET with 405')

            // 9D: Invalid Host header -> 400 Bad Request
            const badHostRes = await makePostRequest(
                port,
                '/api/control',
                { action: 'pause' },
                { Host: 'evil.attacker.com', 'X-CSRF-Token': validToken }
            )
            assert.strictEqual(badHostRes.statusCode, 400, 'Should reject invalid Host with 400')

            // 9E: Cross-origin request -> 403 Forbidden
            const badOriginRes = await makePostRequest(
                port,
                '/api/control',
                { action: 'pause' },
                { Origin: 'http://malicious.com', 'X-CSRF-Token': validToken }
            )
            assert.strictEqual(badOriginRes.statusCode, 403, 'Should reject untrusted Origin with 403')

            // 9F: Body too large (>4KB) -> 413 Payload Too Large
            const largeBody = { action: 'pause', junk: 'x'.repeat(5000) }
            const tooLargeRes = await makePostRequest(port, '/api/control', largeBody, { 'X-CSRF-Token': validToken })
            assert.strictEqual(tooLargeRes.statusCode, 413, 'Should reject body > 4KB with 413')

            // 9G: Invalid/unknown action -> 400 Bad Request (strict Zod schema rejection)
            const unknownActionRes = await makePostRequest(
                port,
                '/api/control',
                { action: 'exec_arbitrary_code' },
                { 'X-CSRF-Token': validToken }
            )
            assert.strictEqual(unknownActionRes.statusCode, 400, 'Should reject unknown action with 400')

            // 9H: Rate limiting (flood requests) -> 429 Too Many Requests
            const floodPromises = []
            for (let i = 0; i < 7; i++) {
                floodPromises.push(
                    makePostRequest(port, '/api/control', { action: 'pause' }, { 'X-CSRF-Token': validToken })
                )
            }
            const floodResults = await Promise.all(floodPromises)
            const has429 = floodResults.some(r => r.statusCode === 429)
            assert.strictEqual(has429, true, 'Rate limiter should return 429 when flooded')

            await runtime.stop('test-done')
            console.log(
                '  ✅ Test 9 Passed: Security validations (CSRF, Origin, Host, Payload Size, Action allowlist, Rate limiting) confirmed'
            )
        }

        // =========================================================================
        // TEST 10: Clean shutdown clears coordinator timers and aborts in-flight work
        // =========================================================================
        {
            const testDir = path.join(baseTestDir, 'test10')
            await fs.promises.mkdir(testDir, { recursive: true })

            const port = 41510
            const config: ObserverConfig = {
                contractVersion: 1,
                storageDirectory: path.join(testDir, 'data'),
                sessionBasePath: path.join(testDir, 'sessions'),
                dashboard: {
                    enabled: true,
                    host: '127.0.0.1',
                    port,
                    maxSseClients: 5,
                    sseHeartbeatMs: 5000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000,
                checkIntervalMs: 1000,
                checkTimeoutMs: 10000
            }

            const runtime = new ObserverRuntime({ config, configDir: testDir })
            await runtime.start()

            // Trigger recheck
            runtime.getCoordinator().triggerCheck('manual')
            assert.strictEqual(runtime.getCoordinator().getStatus().checkingState, 'checking')

            // Stop runtime
            await runtime.stop('test-shutdown')
            assert.strictEqual(runtime.getState(), 'stopped')
            assert.strictEqual(runtime.getCoordinator().getStatus().checkingState, 'idle')

            console.log('  ✅ Test 10 Passed: Clean shutdown clears all timers and aborts in-flight work')
        }

        console.log('\n🎉 ALL 10 OBSERVER CONTROL ACCEPTANCE TESTS PASSED SUCCESSFULLY!\n')
    } finally {
        try {
            await fs.promises.rm(baseTestDir, { recursive: true, force: true })
        } catch {}
    }
}
