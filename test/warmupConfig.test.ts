import assert from 'assert'
import { LiteConfigSchema, getDefaultConfig } from '../src/core/Config'
import { HttpClient, CANONICAL_EDGE_ANDROID_HEADERS } from '../src/core/HttpClient'
import { HttpSearchService, CANONICAL_EDGE_DESKTOP_HEADERS } from '../src/services/HttpSearchService'
import { LiteAccountScope } from '../src/core/LiteAccountScope'
import { AccountData } from '../src/types/AccountTypes'

export async function runWarmupConfigTests() {
    console.log('🧪 Running Warm-Up Engine & HttpSearchService Test Suite...\n')

    // =========================================================================
    // TEST 1: Config Schema Defaults & Warm-Up Fields Validation
    // =========================================================================
    {
        const parsedDefault = LiteConfigSchema.parse({})
        assert.strictEqual(parsedDefault.warmupMode, false, 'warmupMode default must be false')
        assert.strictEqual(parsedDefault.warmupDay, 1, 'warmupDay default must be 1')
        assert.strictEqual(parsedDefault.enableCheckIn, true, 'enableCheckIn default must be true')
        assert.strictEqual(parsedDefault.enableReadToEarn, true, 'enableReadToEarn default must be true')
        assert.strictEqual(parsedDefault.searchQueriesLimit, 30, 'searchQueriesLimit default must be 30')

        // Valid overrides
        const parsedCustom = LiteConfigSchema.parse({
            warmupMode: true,
            warmupDay: 2,
            enableCheckIn: false,
            enableReadToEarn: false,
            searchQueriesLimit: 15
        })
        assert.strictEqual(parsedCustom.warmupMode, true)
        assert.strictEqual(parsedCustom.warmupDay, 2)
        assert.strictEqual(parsedCustom.enableCheckIn, false)
        assert.strictEqual(parsedCustom.enableReadToEarn, false)
        assert.strictEqual(parsedCustom.searchQueriesLimit, 15)

        // Invalid warmupDay rejection
        assert.throws(() => {
            LiteConfigSchema.parse({ warmupDay: 4 as any })
        }, /invalid_union/)

        assert.throws(() => {
            LiteConfigSchema.parse({ warmupDay: 0 as any })
        }, /invalid_union/)

        console.log('  ✅ Test 1 Passed: LiteConfigSchema warmup parameters & validation rules verified')
    }

    // =========================================================================
    // TEST 2: Canonical User-Agents & Client Hints Alignment
    // =========================================================================
    {
        // Edge Android Headers (v131)
        assert.ok(
            (CANONICAL_EDGE_ANDROID_HEADERS['User-Agent'] ?? '').includes('EdgA/131.0.0.0'),
            'Edge Android UA must reflect EdgA/131.0.0.0'
        )
        assert.ok(
            (CANONICAL_EDGE_ANDROID_HEADERS['Sec-CH-UA'] ?? '').includes('"Microsoft Edge";v="131"'),
            'Edge Android Sec-CH-UA must declare Edge v131'
        )
        assert.strictEqual(CANONICAL_EDGE_ANDROID_HEADERS['Sec-CH-UA-Platform'], '"Android"')

        // Edge Windows Desktop Headers (v131)
        assert.ok(
            (CANONICAL_EDGE_DESKTOP_HEADERS['User-Agent'] ?? '').includes('Windows NT 10.0; Win64; x64'),
            'Edge Desktop UA must declare Windows NT 10.0 64-bit'
        )
        assert.ok(
            (CANONICAL_EDGE_DESKTOP_HEADERS['User-Agent'] ?? '').includes('Edg/131.0.0.0'),
            'Edge Desktop UA must declare Edg/131.0.0.0'
        )
        assert.strictEqual(CANONICAL_EDGE_DESKTOP_HEADERS['Sec-CH-UA-Platform'], '"Windows"')
        assert.strictEqual(CANONICAL_EDGE_DESKTOP_HEADERS['Sec-CH-UA-Mobile'], '?0')

        console.log('  ✅ Test 2 Passed: Canonical User-Agent and Client Hints telemetry verified')
    }

    // =========================================================================
    // TEST 3: HttpSearchService Query Shuffling & Seed Determinism
    // =========================================================================
    {
        const client = new HttpClient()
        const service = new HttpSearchService(client)

        const pool = ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8']
        const shuffledA1 = service.shuffleQueries(pool, 'account-alpha')
        const shuffledA2 = service.shuffleQueries(pool, 'account-alpha')
        const shuffledB = service.shuffleQueries(pool, 'account-beta')

        assert.deepStrictEqual(shuffledA1, shuffledA2, 'Same accountSeed must produce deterministic order')
        assert.strictEqual(shuffledA1.length, pool.length)
        assert.notDeepStrictEqual(shuffledA1, shuffledB, 'Different accountSeed should produce diverse order')

        // Delay bounds
        const customService = new HttpSearchService(client, { minDelayMs: 20000, maxDelayMs: 35000 })
        for (let i = 0; i < 50; i++) {
            const delay = customService.getRandomDelay()
            assert.ok(delay >= 20000 && delay <= 35000, `Delay ${delay} must be within [20000, 35000]`)
        }

        client.dispose()
        console.log('  ✅ Test 3 Passed: Query PRNG shuffling & random jitter bounds verified')
    }

    // =========================================================================
    // TEST 4: HttpSearchService Circuit Breaker (3-Strike Zero-Delta Cooldown)
    // =========================================================================
    {
        const client = new HttpClient()
        let callCount = 0

        // Mock pointsChecker that stays at 500 (3 zero-deltas in a row)
        const mockPoints = [500, 500, 500, 500, 500]
        const service = new HttpSearchService(client, {
            sleepFn: async () => {},
            pointsChecker: async () => {
                const pt = mockPoints[callCount] ?? 500
                callCount++
                return pt
            }
        })

        const progressUpdates: any[] = []
        const result = await service.executeSearches(10, p => progressUpdates.push(p))

        assert.strictEqual(result.cooldownDetected, true, 'Cooldown must be detected after 3 consecutive zero deltas')
        assert.strictEqual(result.pointsEarned, 0, 'No points earned during cooldown')
        assert.ok(result.queriesExecuted <= 4, 'Search loop must halt safely without running all 10 queries')

        client.dispose()
        console.log('  ✅ Test 4 Passed: Cooldown Circuit Breaker triggers after 3 consecutive zero deltas')
    }

    // =========================================================================
    // TEST 5: HttpSearchService Successful Points Accumulation
    // =========================================================================
    {
        const client = new HttpClient()
        let callCount = 0

        // Mock pointsChecker incrementing +3 points each query
        const mockPoints = [100, 103, 106, 109, 112]
        const service = new HttpSearchService(client, {
            sleepFn: async () => {},
            pointsChecker: async () => {
                const pt = mockPoints[callCount] ?? 112
                callCount++
                return pt
            }
        })

        const result = await service.executeSearches(3)
        assert.strictEqual(result.cooldownDetected, false, 'Cooldown should not trigger when points increase')
        assert.strictEqual(result.pointsEarned, 9, 'Points earned must equal delta sum (9 points for 3 searches)')

        client.dispose()
        console.log('  ✅ Test 5 Passed: HttpSearchService points tracking & completion verified')
    }

    // =========================================================================
    // TEST 6: LiteAccountScope Warm-Up Day 1 (Cold Account - Bypass DAPI Mobile)
    // =========================================================================
    {
        const config = getDefaultConfig({
            warmupMode: true,
            warmupDay: 1,
            searchQueriesLimit: 3
        })
        const account: AccountData = {
            email: 'warmup.day1@test.com',
            accountId: 'acc-warmup-1'
        }

        const logs: string[] = []
        let disposedLogged = false

        const scope = new LiteAccountScope(account, config, {
            sleepFn: async () => {},
            customCookieHeader: '_U=mock_u_token; MUID=mock_muid; KievRPSAuth=mock_kiev',
            logger: msg => {
                logs.push(msg)
                if (msg.includes('Zero State')) disposedLogged = true
            }
        })

        const result = await scope.run()

        // Verify Day 1 specific behaviors
        assert.strictEqual(result.success, true, 'Day 1 should succeed without DAPI OAuth')
        assert.strictEqual(result.articlesRead, 0, 'Day 1 must not read any MSN articles')
        assert.strictEqual(result.checkInClaimed, false, 'Day 1 must not claim Daily Check-In')
        assert.strictEqual(result.searchesCompleted, 3, 'Day 1 must execute 3 desktop searches')
        assert.strictEqual(disposedLogged, true, 'Zero State cleanup must occur')

        const hasDay1Log = logs.some(l => l.includes('[WARM-UP-DAY-1] Menjalankan pemanasan dingin: 3 pencarian desktop, bypass DAPI mobile.'))
        assert.ok(hasDay1Log, 'Must emit exact WARM-UP-DAY-1 log indicator')

        // Verify mobile OAuth was NOT attempted
        const hasOAuthLog = logs.some(l => l.includes('Melakukan otentikasi OAuth2 mobile'))
        assert.strictEqual(hasOAuthLog, false, 'Day 1 must NOT attempt mobile OAuth2')

        console.log('  ✅ Test 6 Passed: Warm-Up Day 1 cold onboarding bypasses DAPI & executes desktop search')
    }

    // =========================================================================
    // TEST 7: LiteAccountScope Warm-Up Day 2 Branching & Check-In Bypass
    // =========================================================================
    {
        const config = getDefaultConfig({
            warmupMode: true,
            warmupDay: 2,
            minReadDelayMs: 1000,
            maxReadDelayMs: 2000
        })
        const account: AccountData = {
            email: 'warmup.day2@test.com',
            accountId: 'acc-warmup-2'
        }

        const logs: string[] = []
        let disposedLogged = false

        const scope = new LiteAccountScope(account, config, {
            sleepFn: async () => {},
            logger: msg => {
                logs.push(msg)
                if (msg.includes('Zero State')) disposedLogged = true
            }
        })

        // Run scope (will fail cleanly at OAuth stage in offline test environment, verifying branching log)
        const result = await scope.run()

        assert.strictEqual(result.success, false) // Network fail-closed
        assert.strictEqual(disposedLogged, true, 'Zero State cleanup must execute')

        const hasDay2Log = logs.some(l => l.includes('[WARM-UP-DAY-2] Menjalankan pemanasan moderat: pencarian desktop + baca 2-3 artikel, bypass Check-In.'))
        assert.ok(hasDay2Log, 'Must emit exact WARM-UP-DAY-2 log indicator')

        console.log('  ✅ Test 7 Passed: Warm-Up Day 2 branch logging & resource cleanup verified')
    }

    // =========================================================================
    // TEST 8: LiteAccountScope Warm-Up Day 3 Branching
    // =========================================================================
    {
        const config = getDefaultConfig({
            warmupMode: true,
            warmupDay: 3,
            minReadDelayMs: 1000,
            maxReadDelayMs: 2000
        })
        const account: AccountData = {
            email: 'warmup.day3@test.com',
            accountId: 'acc-warmup-3'
        }

        const logs: string[] = []
        let disposedLogged = false

        const scope = new LiteAccountScope(account, config, {
            sleepFn: async () => {},
            logger: msg => {
                logs.push(msg)
                if (msg.includes('Zero State')) disposedLogged = true
            }
        })

        const result = await scope.run()

        assert.strictEqual(result.success, false) // Network fail-closed
        assert.strictEqual(disposedLogged, true, 'Zero State cleanup must execute')

        const hasDay3Log = logs.some(l => l.includes('[WARM-UP-DAY-3] Menjalankan pemanasan lanjutan: Check-In, pencarian desktop, dan 5 artikel.'))
        assert.ok(hasDay3Log, 'Must emit exact WARM-UP-DAY-3 log indicator')

        console.log('  ✅ Test 8 Passed: Warm-Up Day 3 branch logging & resource cleanup verified')
    }

    console.log('\n🎉 ALL 8 WARM-UP ENGINE & HTTP SEARCH TESTS PASSED SUCCESSFULLY!\n')
}

// Allow direct execution
if (require.main === module) {
    runWarmupConfigTests().catch(err => {
        console.error('❌ Warmup test failed:', err)
        process.exit(1)
    })
}
