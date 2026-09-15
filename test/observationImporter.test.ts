import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ObservationImporter } from '../src/manual/ObservationImporter'
import {
    AccountObservationEnvelope,
    computeStableAccountRef,
    computeStableTaskRef
} from '../src/contracts/AccountObservationContract'

export async function runObservationImporterTests(): Promise<void> {
    console.log('\n🧪 Starting ObservationImporter Test Suite (Commit 3)...')

    const baseTestDir = path.join(__dirname, 'temp_bridge_importer_test_' + Date.now())
    await fs.promises.mkdir(baseTestDir, { recursive: true })

    const sampleUuid = 'a0000000-0000-4000-8000-000000000001'
    const referenceKey = Buffer.from('test_reference_key_32_bytes_long!!')
    const accountRef = computeStableAccountRef(referenceKey, sampleUuid)
    const taskRef1 = computeStableTaskRef(referenceKey, sampleUuid, 'search', 'desktop-search-01')

    const createValidEnvelope = (sequence: number, observationId?: string): AccountObservationEnvelope => ({
        contractVersion: 1,
        observationId: observationId || crypto.randomUUID(),
        sequence,
        source: 'main',
        accountRef,
        displayAccount: 'alice***@domain.com',
        emittedAt: new Date().toISOString(),
        sessionState: 'valid-from-existing-runtime-evidence',
        tasks: [
            {
                taskRef: taskRef1,
                title: 'Search on Bing Desktop',
                taskKind: 'search',
                state: 'incomplete',
                reason: 'manual-action-required',
                advertisedPoints: 30,
                progressCurrent: 10,
                progressMaximum: 30,
                observedAt: new Date().toISOString()
            }
        ]
    })

    try {
        // Test 1: Happy path import of valid envelope
        {
            const bridgeDir = path.join(baseTestDir, 'test1_bridge')
            const importer = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                allowInWorkerForTesting: true
            })
            await importer.init()

            const env1 = createValidEnvelope(1)
            const incomingFile = path.join(bridgeDir, 'incoming', 'obs_01.json')
            await fs.promises.writeFile(incomingFile, JSON.stringify(env1), 'utf8')

            const imported = await importer.scanAndImport()
            if (imported.length !== 1) {
                throw new Error(`Expected 1 imported envelope, got ${imported.length}`)
            }
            if (imported[0]!.observationId !== env1.observationId) {
                throw new Error('Imported observationId mismatch')
            }

            // Verify file moved to processed/
            const processedFiles = await fs.promises.readdir(path.join(bridgeDir, 'processed'))
            if (processedFiles.length !== 1) {
                throw new Error(`Expected 1 processed file, got ${processedFiles.length}`)
            }

            // Verify cursor updated
            const cursor = importer.getCursor()
            if (cursor.latestSequenceByAccountRef[accountRef] !== 1) {
                throw new Error(`Expected latest sequence 1, got ${cursor.latestSequenceByAccountRef[accountRef]}`)
            }
            if (!cursor.recentlyProcessedObservationIds.includes(env1.observationId)) {
                throw new Error('Expected observationId in cursor recentlyProcessedObservationIds')
            }

            console.log('  ✅ Test 1 Passed: Valid envelope imported, moved to processed/, and cursor updated')
        }

        // Test 2: Sequence regression / out-of-order rejection (Amendment 4)
        {
            const bridgeDir = path.join(baseTestDir, 'test2_bridge')
            const importer = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                allowInWorkerForTesting: true
            })
            await importer.init()

            // Import sequence 5
            const env5 = createValidEnvelope(5)
            await fs.promises.writeFile(
                path.join(bridgeDir, 'incoming', 'obs_05.json'),
                JSON.stringify(env5),
                'utf8'
            )
            await importer.scanAndImport()

            // Attempt to import sequence 3 (regressed)
            const env3 = createValidEnvelope(3)
            const regressedFile = path.join(bridgeDir, 'incoming', 'obs_03.json')
            await fs.promises.writeFile(regressedFile, JSON.stringify(env3), 'utf8')

            const imported = await importer.scanAndImport()
            if (imported.length !== 0) {
                throw new Error(`Expected regressed sequence to be rejected, got ${imported.length}`)
            }

            // Raw payload must be deleted
            if (fs.existsSync(regressedFile)) {
                throw new Error('Expected regressed incoming file to be deleted')
            }

            // Diagnostic must be recorded
            const diagFiles = await fs.promises.readdir(path.join(bridgeDir, 'diagnostics'))
            if (diagFiles.length === 0) {
                throw new Error('Expected rejection diagnostic file to be created')
            }

            // Cursor sequence must remain 5
            const cursor = importer.getCursor()
            if (cursor.latestSequenceByAccountRef[accountRef] !== 5) {
                throw new Error(`Expected sequence to remain 5, got ${cursor.latestSequenceByAccountRef[accountRef]}`)
            }

            console.log('  ✅ Test 2 Passed: Regressed sequence rejected, diagnostic logged, raw payload deleted')
        }

        // Test 3: Duplicate observationId rejection (Amendment 4)
        {
            const bridgeDir = path.join(baseTestDir, 'test3_bridge')
            const importer = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                allowInWorkerForTesting: true
            })
            await importer.init()

            const dupId = crypto.randomUUID()
            const env1 = createValidEnvelope(1, dupId)
            await fs.promises.writeFile(
                path.join(bridgeDir, 'incoming', 'obs_01.json'),
                JSON.stringify(env1),
                'utf8'
            )
            await importer.scanAndImport()

            // Next envelope with sequence 2 but same observationId
            const env2 = createValidEnvelope(2, dupId)
            const dupFile = path.join(bridgeDir, 'incoming', 'obs_02.json')
            await fs.promises.writeFile(dupFile, JSON.stringify(env2), 'utf8')

            const imported = await importer.scanAndImport()
            if (imported.length !== 0) {
                throw new Error(`Expected duplicate observationId to be rejected, got ${imported.length}`)
            }
            if (fs.existsSync(dupFile)) {
                throw new Error('Expected duplicate file to be deleted')
            }

            console.log('  ✅ Test 3 Passed: Duplicate observationId rejected and deleted')
        }

        // Test 4: Oversized file rejection (> maximumFileBytes, Amendment 5)
        {
            const bridgeDir = path.join(baseTestDir, 'test4_bridge')
            const importer = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                maximumFileBytes: 500, // 500 bytes limit
                allowInWorkerForTesting: true
            })
            await importer.init()

            const oversizedPayload = JSON.stringify({
                data: 'x'.repeat(1000)
            })
            const oversizedFile = path.join(bridgeDir, 'incoming', 'obs_big.json')
            await fs.promises.writeFile(oversizedFile, oversizedPayload, 'utf8')

            const imported = await importer.scanAndImport()
            if (imported.length !== 0) {
                throw new Error('Expected oversized file to be rejected')
            }
            if (fs.existsSync(oversizedFile)) {
                throw new Error('Expected oversized raw file to be deleted')
            }

            const diagFiles = await fs.promises.readdir(path.join(bridgeDir, 'diagnostics'))
            if (diagFiles.length === 0) {
                throw new Error('Expected diagnostic file for oversized rejection')
            }

            console.log('  ✅ Test 4 Passed: Oversized file rejected before full parsing and raw payload removed')
        }

        // Test 5: Rejection of sensitive token leak and schema corruption (Amendment 5)
        {
            const bridgeDir = path.join(baseTestDir, 'test5_bridge')
            const importer = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                allowInWorkerForTesting: true
            })
            await importer.init()

            const leakyEnvelope: any = createValidEnvelope(1)
            leakyEnvelope.accessToken = 'stolen_bearer_token'
            const leakyFile = path.join(bridgeDir, 'incoming', 'obs_leaky.json')
            await fs.promises.writeFile(leakyFile, JSON.stringify(leakyEnvelope), 'utf8')

            const imported = await importer.scanAndImport()
            if (imported.length !== 0) {
                throw new Error('Expected leaky envelope to be rejected')
            }
            if (fs.existsSync(leakyFile)) {
                throw new Error('Expected leaky raw file to be deleted')
            }

            // Diagnostic file must be sanitized (never contain the sensitive key)
            const diagFiles = await fs.promises.readdir(path.join(bridgeDir, 'diagnostics'))
            const diagContent = await fs.promises.readFile(
                path.join(bridgeDir, 'diagnostics', diagFiles[0]!),
                'utf8'
            )
            if (diagContent.includes('stolen_bearer_token')) {
                throw new Error('Diagnostic file leaked raw sensitive token!')
            }

            console.log('  ✅ Test 5 Passed: Leaky envelope rejected, raw file deleted, diagnostic sanitized')
        }

        // Test 6: Abandoned / stale claim recovery (Amendment 6)
        {
            const bridgeDir = path.join(baseTestDir, 'test6_bridge')
            const importer = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                claimingStaleMs: 50, // 50ms stale threshold for testing
                allowInWorkerForTesting: true
            })
            await importer.init()

            // Simulate abandoned claim from a dead pid (pid: 99999999)
            const abandonedClaim = path.join(
                bridgeDir,
                'incoming',
                'obs_stale.json.claiming.99999999.123456'
            )
            const env = createValidEnvelope(1)
            await fs.promises.writeFile(abandonedClaim, JSON.stringify(env), 'utf8')

            // Wait 60ms to exceed claimingStaleMs
            await new Promise(r => setTimeout(r, 60))

            const reclaimed = await importer.reclaimStaleClaims()
            if (reclaimed !== 1) {
                throw new Error(`Expected 1 reclaimed file, got ${reclaimed}`)
            }

            // Verify file renamed back to original
            const originalFile = path.join(bridgeDir, 'incoming', 'obs_stale.json')
            if (!fs.existsSync(originalFile)) {
                throw new Error('Expected reclaimed file to exist at incoming/obs_stale.json')
            }

            // Now scanAndImport should successfully import it
            const imported = await importer.scanAndImport()
            if (imported.length !== 1) {
                throw new Error('Expected reclaimed file to be imported cleanly')
            }

            console.log('  ✅ Test 6 Passed: Stale claim recovered from dead pid and imported cleanly')
        }

        // Test 7: Bounded retention cleanup (Amendment 5)
        {
            const bridgeDir = path.join(baseTestDir, 'test7_bridge')
            const importer = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                processedRetentionHours: 1,
                rejectionMetadataRetentionHours: 1,
                allowInWorkerForTesting: true
            })
            await importer.init()

            // Create a "fresh" processed file and an "old" processed file
            const freshProcessed = path.join(bridgeDir, 'processed', 'fresh.json')
            const oldProcessed = path.join(bridgeDir, 'processed', 'old.json')
            await fs.promises.writeFile(freshProcessed, '{}', 'utf8')
            await fs.promises.writeFile(oldProcessed, '{}', 'utf8')

            // Backdate oldProcessed mtime by 2 hours
            const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000)
            await fs.promises.utimes(oldProcessed, twoHoursAgo, twoHoursAgo)

            await importer.cleanupRetention()

            if (!fs.existsSync(freshProcessed)) {
                throw new Error('Fresh processed file was erroneously deleted')
            }
            if (fs.existsSync(oldProcessed)) {
                throw new Error('Old processed file was not pruned by retention cleanup')
            }

            console.log('  ✅ Test 7 Passed: Bounded retention pruned expired processed artifacts')
        }

        // Test 8: Persistent cursor and corruption quarantine (Amendment 11)
        {
            const bridgeDir = path.join(baseTestDir, 'test8_bridge')
            const importer1 = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                allowInWorkerForTesting: true
            })
            await importer1.init()

            const env1 = createValidEnvelope(1)
            await fs.promises.writeFile(
                path.join(bridgeDir, 'incoming', 'obs_01.json'),
                JSON.stringify(env1),
                'utf8'
            )
            await importer1.scanAndImport()

            // Create a second importer on the same directory to verify persistence
            const importer2 = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                allowInWorkerForTesting: true
            })
            await importer2.init()
            const cursor2 = importer2.getCursor()
            if (cursor2.latestSequenceByAccountRef[accountRef] !== 1) {
                throw new Error('Persisted cursor was not reloaded accurately')
            }

            // Corrupt the cursor file intentionally
            const cursorPath = path.join(bridgeDir, 'bridge_cursor.json')
            await fs.promises.writeFile(cursorPath, '{ corrupted json :::: ', 'utf8')

            const importer3 = new ObservationImporter({
                bridgeDirectory: bridgeDir,
                allowInWorkerForTesting: true
            })

            let threw = false
            try {
                await importer3.init()
            } catch (err: any) {
                threw = true
                if (!err.message.includes('corrupted and quarantined')) {
                    throw new Error(`Unexpected error message: ${err.message}`)
                }
            }
            if (!threw) {
                throw new Error('Expected importer to fail-closed on corrupted cursor')
            }

            // Verify quarantined file exists
            const files = await fs.promises.readdir(bridgeDir)
            const quarantined = files.find(f => f.startsWith('bridge_cursor.corrupted.'))
            if (!quarantined) {
                throw new Error('Expected corrupted cursor file to be quarantined')
            }

            console.log('  ✅ Test 8 Passed: Cursor persists across restarts and corrupt cursor safely quarantined')
        }

        console.log('🎉 ALL 8 OBSERVATION IMPORTER TESTS PASSED SUCCESSFULLY!\n')
    } finally {
        try {
            await fs.promises.rm(baseTestDir, { recursive: true, force: true })
        } catch {}
    }
}
