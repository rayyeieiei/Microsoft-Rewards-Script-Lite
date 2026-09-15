import { runRuntimeTests } from './runtime.test'
import { runDashboardTests } from './dashboard.test'
import { runObservationImporterTests } from './observationImporter.test'
import { runManualActionStoreTests } from './manualActionStore.test'

async function runAll() {
    console.log('🧪 Starting Microsoft-Rewards-Script-Lite Full Test Suite...\n')
    await runRuntimeTests()
    console.log('')
    await runDashboardTests()
    console.log('')
    await runObservationImporterTests()
    console.log('')
    await runManualActionStoreTests()
    console.log('\n🎉 ALL TESTS IN SUITE PASSED SUCCESSFULLY!')
}

runAll().catch(err => {
    console.error('❌ Test execution failed:', err)
    process.exit(1)
})
