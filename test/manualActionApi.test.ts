import assert from 'assert'
import http from 'http'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { DashboardServer } from '../src/dashboard/DashboardServer'
import { ReadinessSnapshotStore } from '../src/dashboard/ReadinessSnapshotStore'
import { ManualActionStore } from '../src/manual/ManualActionStore'
import { computeStableAccountRef, computeStableTaskRef } from '../src/contracts/AccountObservationContract'

function makeRequest(
    options: http.RequestOptions,
    postData?: string
): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(options, res => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', chunk => {
                body += chunk
            })
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode || 0,
                    headers: res.headers,
                    body
                })
            })
        })

        req.on('error', reject)

        if (postData) {
            req.write(postData)
        }
        req.end()
    })
}

export async function runManualActionApiTests(): Promise<void> {
    console.log('🧪 Starting ManualActionApi & CSRF Test Suite (Commit 5)...')

    const baseTestDir = path.join(__dirname, 'temp_manual_api_test_' + Date.now())
    await fs.promises.mkdir(baseTestDir, { recursive: true })

    const port = 41350
    const testSecret = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    const storePath = path.join(baseTestDir, 'manual_actions.json')

    const readinessStore = new ReadinessSnapshotStore({
        maxTimelineEntries: 20,
        now: () => Date.now(),
        sessionSecret: testSecret
    })

    const manualActionStore = new ManualActionStore({
        storePath,
        allowInWorkerForTesting: true
    })
    await manualActionStore.init()

    const server = new DashboardServer({
        config: {
            enabled: true,
            host: '127.0.0.1',
            port,
            maxSseClients: 5,
            sseHeartbeatMs: 15000
        },
        store: readinessStore,
        manualActionStore
    })

    await server.start()

    const sampleUuid = 'c0000000-0000-4000-8000-000000000003'
    const referenceKey = Buffer.from('test_ref_key_32_bytes_long_5678!!')
    const accountRef = computeStableAccountRef(referenceKey, sampleUuid)
    const taskRef1 = computeStableTaskRef(referenceKey, sampleUuid, 'search', 'task-search-api-01')

    const record1 = {
        recordId: crypto.randomUUID(),
        accountRef,
        displayAccount: 'charlie***@domain.com',
        taskRef: taskRef1,
        title: 'Search on Bing Mobile',
        taskKind: 'search',
        reason: 'manual-action-required' as const,
        advertisedPoints: 60,
        progressCurrent: 0,
        progressMaximum: 60,
        lifecycleState: 'available' as const,
        verificationState: 'unverified' as const,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        observedAt: new Date().toISOString()
    }
    await manualActionStore.upsertRecord(record1)

    try {
        // Test 1: Dedicated CSRF Session Endpoint (Amendment 9)
        let csrfToken = ''
        {
            const res = await makeRequest({
                hostname: '127.0.0.1',
                port,
                path: '/api/session',
                method: 'GET'
            })
            assert.strictEqual(res.statusCode, 200)
            const body = JSON.parse(res.body)
            assert.ok(body.csrfToken && typeof body.csrfToken === 'string')
            assert.strictEqual(body.csrfToken.length, 64) // 32 bytes hex
            assert.ok(body.expiresAt && !isNaN(Date.parse(body.expiresAt)))
            csrfToken = body.csrfToken
            console.log('  ✅ Test 1 Passed: GET /api/session issues cryptographically strong CSRF token')
        }

        // Test 2: Read-only query endpoint GET /api/manual-actions (Amendment 7)
        {
            const res = await makeRequest({
                hostname: '127.0.0.1',
                port,
                path: '/api/manual-actions',
                method: 'GET'
            })
            assert.strictEqual(res.statusCode, 200)
            const body = JSON.parse(res.body)
            assert.strictEqual(body.totalMatching, 1)
            assert.strictEqual(body.records[0].recordId, record1.recordId)
            assert.strictEqual(body.records[0].title, 'Search on Bing Mobile')

            // Query with filter
            const resFilter = await makeRequest({
                hostname: '127.0.0.1',
                port,
                path: '/api/manual-actions?search=Mobile',
                method: 'GET'
            })
            assert.strictEqual(resFilter.statusCode, 200)
            const filterBody = JSON.parse(resFilter.body)
            assert.strictEqual(filterBody.records.length, 1)

            console.log('  ✅ Test 2 Passed: GET /api/manual-actions returns non-mutating filtered results')
        }

        // Test 3: Mutating without CSRF token returns 403 Forbidden (Amendment 9)
        {
            const resNoToken = await makeRequest(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: `/api/manual-actions/${record1.recordId}/report`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    }
                },
                JSON.stringify({ expectedRevision: 1 })
            )
            assert.strictEqual(resNoToken.statusCode, 403)
            assert.ok(resNoToken.body.includes('Missing x-csrf-token header'))

            // Invalid CSRF token returns 403 Forbidden
            const resBadToken = await makeRequest(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: `/api/manual-actions/${record1.recordId}/report`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': 'bad_invalid_token_12345678901234567890123456789012345678901234'
                    }
                },
                JSON.stringify({ expectedRevision: 1 })
            )
            assert.strictEqual(resBadToken.statusCode, 403)
            assert.ok(resBadToken.body.includes('Invalid or expired CSRF token'))

            console.log('  ✅ Test 3 Passed: Missing or invalid CSRF token rejected with 403 Forbidden')
        }

        // Test 4: Optimistic revision conflict returns 409 Conflict (Amendment 10)
        {
            const resConflict = await makeRequest(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: `/api/manual-actions/${record1.recordId}/report`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    }
                },
                JSON.stringify({ expectedRevision: 99 }) // Stale revision
            )
            assert.strictEqual(resConflict.statusCode, 409)
            const conflictBody = JSON.parse(resConflict.body)
            assert.strictEqual(conflictBody.currentRevision, 1)

            console.log('  ✅ Test 4 Passed: Revision mismatch returns HTTP 409 Conflict with currentRevision')
        }

        // Test 5: Valid report mutation updates lifecycle but keeps verificationState unverified (Amendment 8)
        {
            const resReport = await makeRequest(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: `/api/manual-actions/${record1.recordId}/report`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    }
                },
                JSON.stringify({ expectedRevision: 1, note: 'Done on phone' })
            )
            assert.strictEqual(resReport.statusCode, 200)
            const reportBody = JSON.parse(resReport.body)
            assert.strictEqual(reportBody.success, true)
            assert.strictEqual(reportBody.record.lifecycleState, 'action-reported')
            // CRITICAL INVARIANT: verificationState remains unverified!
            assert.strictEqual(reportBody.record.verificationState, 'unverified')
            assert.strictEqual(reportBody.record.revision, 2)
            assert.strictEqual(reportBody.record.note, 'Done on phone')

            console.log(
                '  ✅ Test 5 Passed: User report advances lifecycle to action-reported while verificationState stays unverified'
            )
        }

        // Test 6: Dismiss and Reopen mutations via API
        {
            // Dismiss with revision 2
            const resDismiss = await makeRequest(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: `/api/manual-actions/${record1.recordId}/dismiss`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    }
                },
                JSON.stringify({ expectedRevision: 2 })
            )
            assert.strictEqual(resDismiss.statusCode, 200)
            const dismissBody = JSON.parse(resDismiss.body)
            assert.strictEqual(dismissBody.record.lifecycleState, 'dismissed')
            assert.strictEqual(dismissBody.record.revision, 3)

            // Reopen with revision 3
            const resReopen = await makeRequest(
                {
                    hostname: '127.0.0.1',
                    port,
                    path: `/api/manual-actions/${record1.recordId}/reopen`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-CSRF-Token': csrfToken
                    }
                },
                JSON.stringify({ expectedRevision: 3 })
            )
            assert.strictEqual(resReopen.statusCode, 200)
            const reopenBody = JSON.parse(resReopen.body)
            assert.strictEqual(reopenBody.record.lifecycleState, 'available')
            assert.strictEqual(reopenBody.record.revision, 4)

            console.log('  ✅ Test 6 Passed: Dismiss and reopen endpoints execute cleanly via API')
        }

        console.log('🎉 ALL 6 MANUAL ACTION API & CSRF TESTS PASSED SUCCESSFULLY!\n')
    } finally {
        await server.stop()
        readinessStore.dispose()
        try {
            await fs.promises.rm(baseTestDir, { recursive: true, force: true })
        } catch {}
    }
}
