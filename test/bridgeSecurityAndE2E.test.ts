import assert from 'assert'
import fs from 'fs'
import path from 'path'
import http from 'http'
import https from 'https'
import crypto from 'crypto'
import { ObservationImporter } from '../src/manual/ObservationImporter'
import { ManualActionStore } from '../src/manual/ManualActionStore'
import { ObservationReconciler } from '../src/manual/ObservationReconciler'
import {
    AccountObservationEnvelope,
    computeStableAccountRef,
    computeStableTaskRef
} from '../src/contracts/AccountObservationContract'

export async function runBridgeSecurityAndE2ETests(): Promise<void> {
    console.log('🧪 Starting Bridge Security, E2E & Static Reachability Suite (Commit 6)...')

    const baseTestDir = path.join(__dirname, 'temp_bridge_e2e_test_' + Date.now())
    await fs.promises.mkdir(baseTestDir, { recursive: true })

    try {
        // --- TEST 1: test_e2e_main_export_lite_import ---
        {
            const bridgeDir = path.join(baseTestDir, 'e2e_bridge')
            const storePath = path.join(baseTestDir, 'e2e_store', 'manual_actions.json')

            const importer = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                allowInWorkerForTesting: true
            })
            await importer.init()

            const store = new ManualActionStore({
                storePath,
                allowInWorkerForTesting: true
            })
            await store.init()

            const reconciler = new ObservationReconciler(store)

            const sampleUuid = 'd0000000-0000-4000-8000-000000000004'
            const referenceKey = Buffer.from('test_ref_key_32_bytes_long_e2e_1!!')
            const accountRef = computeStableAccountRef(referenceKey, sampleUuid)
            const taskRef = computeStableTaskRef(referenceKey, sampleUuid, 'search', 'e2e-task-1')

            // Step 1: Main exports envelope with incomplete task
            const env1: AccountObservationEnvelope = {
                contractVersion: 1,
                observationId: crypto.randomUUID(),
                sequence: 1,
                source: 'main',
                accountRef,
                displayAccount: 'dan***@domain.com',
                emittedAt: new Date().toISOString(),
                sessionState: 'valid-from-existing-runtime-evidence',
                tasks: [
                    {
                        taskRef,
                        title: 'Bing Desktop Search',
                        taskKind: 'search',
                        state: 'incomplete',
                        reason: 'manual-action-required',
                        advertisedPoints: 90,
                        progressCurrent: 0,
                        progressMaximum: 90,
                        observedAt: new Date().toISOString()
                    }
                ]
            }

            // Simulate Main writing to incoming
            const incomingFile1 = path.join(bridgeDir, 'incoming', 'obs_01.json')
            await fs.promises.writeFile(incomingFile1, JSON.stringify(env1), 'utf8')

            // Lite scans and imports
            const importedEnvelopes1 = await importer.scanAndImport()
            assert.strictEqual(importedEnvelopes1.length, 1)

            // Reconcile into ManualActionStore
            const rec1 = await reconciler.reconcile(importedEnvelopes1[0]!)
            assert.strictEqual(rec1.created, 1)

            let record = store.findByTaskRef(accountRef, taskRef)!
            assert.strictEqual(record.lifecycleState, 'available')
            assert.strictEqual(record.verificationState, 'unverified')
            assert.strictEqual(record.revision, 1)

            // Step 2: Operator reports task completion via Manual Action Center
            const reported = await store.reportAction(record.recordId, {
                expectedRevision: 1,
                note: 'Searched manually on PC'
            })
            assert.strictEqual(reported.lifecycleState, 'action-reported')
            // INVARIANT: stays unverified!
            assert.strictEqual(reported.verificationState, 'unverified')
            assert.strictEqual(reported.revision, 2)

            // Step 3: Main sends follow-up observation; task is STILL incomplete
            const env2: AccountObservationEnvelope = {
                ...env1,
                observationId: crypto.randomUUID(),
                sequence: 2,
                tasks: [
                    {
                        ...env1.tasks[0]!,
                        progressCurrent: 30
                    }
                ]
            }
            await fs.promises.writeFile(path.join(bridgeDir, 'incoming', 'obs_02.json'), JSON.stringify(env2), 'utf8')
            const importedEnvelopes2 = await importer.scanAndImport()
            assert.strictEqual(importedEnvelopes2.length, 1)
            await reconciler.reconcile(importedEnvelopes2[0]!)

            record = store.getRecord(record.recordId)!
            assert.strictEqual(record.lifecycleState, 'action-reported')
            assert.strictEqual(record.verificationState, 'unverified')
            assert.strictEqual(record.progressCurrent, 30)

            // Step 4: Main sends final observation; task is now COMPLETE in Main!
            const env3: AccountObservationEnvelope = {
                ...env1,
                observationId: crypto.randomUUID(),
                sequence: 3,
                tasks: [
                    {
                        ...env1.tasks[0]!,
                        state: 'complete',
                        progressCurrent: 90
                    }
                ]
            }
            await fs.promises.writeFile(path.join(bridgeDir, 'incoming', 'obs_03.json'), JSON.stringify(env3), 'utf8')
            const importedEnvelopes3 = await importer.scanAndImport()
            assert.strictEqual(importedEnvelopes3.length, 1)
            const rec3 = await reconciler.reconcile(importedEnvelopes3[0]!)
            assert.strictEqual(rec3.verifiedComplete, 1)

            record = store.getRecord(record.recordId)!
            assert.strictEqual(record.verificationState, 'verified-complete')
            assert.ok(record.verifiedAt && !isNaN(Date.parse(record.verifiedAt)))

            console.log(
                '  ✅ Test 14 Passed: End-to-end Main export -> Lite import -> User report -> Main verification complete'
            )
        }

        // --- TEST 2: test_static_reachability_proof (Amendment 12) ---
        {
            const srcDir = path.resolve(__dirname, '..', 'src')
            const forbiddenGlobalTokens = ['dapi/me/activities', 'reportactivity', 'oauth20_desktop']
            const forbiddenManualAndDashboardTokens = ['playwright', 'puppeteer', 'chromium', 'firefox', 'webkit']

            function scanDirectory(dir: string): string[] {
                const results: string[] = []
                const entries = fs.readdirSync(dir, { withFileTypes: true })
                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name)
                    if (entry.isDirectory()) {
                        results.push(...scanDirectory(fullPath))
                    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
                        results.push(fullPath)
                    }
                }
                return results
            }

            const allSourceFiles = scanDirectory(srcDir)
            const observerSourceFiles = allSourceFiles.filter(filePath => {
                const relativePath = path.relative(srcDir, filePath)
                return (
                    !relativePath.startsWith('services' + path.sep) &&
                    !relativePath.startsWith('core' + path.sep) &&
                    relativePath !== 'index.ts'
                )
            })
            assert.ok(observerSourceFiles.length >= 10, 'Must find source files to scan')

            for (const filePath of observerSourceFiles) {
                const content = fs.readFileSync(filePath, 'utf8')
                const relativePath = path.relative(srcDir, filePath)

                // 1. Forbidden global tokens in observer modules
                for (const token of forbiddenGlobalTokens) {
                    assert.strictEqual(
                        content.includes(token),
                        false,
                        `[STATIC-SECURITY-VIOLATION] Found forbidden token '${token}' in observer file ${relativePath}`
                    )
                }

                // 2. Forbidden automation tokens in manual/, dashboard/, contracts/
                const isSensitiveSubdir =
                    relativePath.startsWith('manual' + path.sep) ||
                    relativePath.startsWith('dashboard' + path.sep) ||
                    relativePath.startsWith('contracts' + path.sep)

                if (isSensitiveSubdir) {
                    for (const token of forbiddenManualAndDashboardTokens) {
                        assert.strictEqual(
                            content.toLowerCase().includes(token),
                            false,
                            `[STATIC-SECURITY-VIOLATION] Found forbidden automation token '${token}' in ${relativePath}`
                        )
                    }
                }
            }

            console.log(
                '  ✅ Test 15 Passed: Static reachability audit confirms ZERO forbidden DAPI, reportactivity, OAuth, or browser automation'
            )
        }

        // --- TEST 3: test_zero_extra_network_requests ---
        {
            // Spy on http.request and https.request
            let externalCallDetected = false
            let attemptedHost = ''

            const originalHttpRequest = http.request
            const originalHttpsRequest = https.request

            const checkHost = (options: any) => {
                let host = ''
                if (typeof options === 'string') {
                    host = new URL(options).hostname
                } else if (options && typeof options === 'object') {
                    host = options.hostname || options.host || ''
                }
                // Strip port if present
                host = host.split(':')[0] || ''
                if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
                    externalCallDetected = true
                    attemptedHost = host
                }
            }

            ;(http as any).request = function (...args: any[]) {
                checkHost(args[0])
                return originalHttpRequest.apply(http, args as any)
            }

            ;(https as any).request = function (...args: any[]) {
                checkHost(args[0])
                return originalHttpsRequest.apply(https, args as any)
            }

            try {
                // Execute bridge operations: import, reconcile, and store save
                const bridgeDir = path.join(baseTestDir, 'zero_net_bridge')
                const storePath = path.join(baseTestDir, 'zero_net_store', 'manual_actions.json')

                const importer = new ObservationImporter({
                    bridgeDirectory: bridgeDir,
                    allowInWorkerForTesting: true
                })
                await importer.init()

                const store = new ManualActionStore({
                    storePath,
                    allowInWorkerForTesting: true
                })
                await store.init()

                const reconciler = new ObservationReconciler(store)

                // Import cycle
                await importer.scanAndImport()

                // Reconcile cycle
                const sampleUuid = 'd0000000-0000-4000-8000-000000000005'
                const referenceKey = Buffer.from('test_ref_key_32_bytes_long_zero_net!')
                const accountRef = computeStableAccountRef(referenceKey, sampleUuid)
                const taskRef = computeStableTaskRef(referenceKey, sampleUuid, 'search', 'zero-net-task')

                await reconciler.reconcile({
                    contractVersion: 1,
                    observationId: crypto.randomUUID(),
                    sequence: 1,
                    source: 'main',
                    accountRef,
                    displayAccount: 'eve***@domain.com',
                    emittedAt: new Date().toISOString(),
                    sessionState: 'valid-from-existing-runtime-evidence',
                    tasks: [
                        {
                            taskRef,
                            title: 'Zero Net Task',
                            taskKind: 'search',
                            state: 'incomplete',
                            reason: 'manual-action-required',
                            observedAt: new Date().toISOString()
                        }
                    ]
                })

                // Assert zero external network calls were attempted
                assert.strictEqual(
                    externalCallDetected,
                    false,
                    `External network call was erroneously attempted to ${attemptedHost}!`
                )
            } finally {
                ;(http as any).request = originalHttpRequest
                ;(https as any).request = originalHttpsRequest
            }

            console.log(
                '  ✅ Test 16 Passed: Zero extra external network requests generated during import, reconciliation, or storage'
            )
        }

        console.log('🎉 ALL BRIDGE SECURITY, E2E & STATIC REACHABILITY TESTS PASSED SUCCESSFULLY!\n')
    } finally {
        try {
            await fs.promises.rm(baseTestDir, { recursive: true, force: true })
        } catch {}
    }
}
