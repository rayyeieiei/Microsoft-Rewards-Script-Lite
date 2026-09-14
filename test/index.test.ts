import { runRuntimeTests } from './runtime.test'

async function runAll() {
    console.log('🧪 Starting Microsoft-Rewards-Script-Lite Full Test Suite...\n')
    await runRuntimeTests()
    console.log('\n🎉 ALL TESTS IN SUITE PASSED SUCCESSFULLY!')
}

runAll().catch(err => {
    console.error('❌ Test execution failed:', err)
    process.exit(1)
})
