import assert from 'assert'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { AccountLoader } from '../src/runtime/observer/AccountLoader'
import { ObserverRuntime } from '../src/runtime/observer/ObserverRuntime'
import { ObserverConfig, resolveObserverSourceSelection } from '../src/runtime/observer/ObserverConfig'
import { ObserverPaths } from '../src/runtime/observer/ObserverPaths'

function makeGetRequest(port: number, pathUrl: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: pathUrl,
                method: 'GET',
                headers: {
                    Host: `127.0.0.1:${port}`
                }
            },
            res => {
                let data = ''
                res.setEncoding('utf8')
                res.on('data', chunk => {
                    data += chunk
                })
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode || 0, body: data })
                })
            }
        )
        req.on('error', reject)
        req.end()
    })
}

export async function runAccountLoaderTests(): Promise<void> {
    console.log('🧪 Starting AccountLoader & UX Acceptance Test Suite...')

    const baseTestDir = path.join(__dirname, 'temp_loader_test_' + Date.now())
    await fs.promises.mkdir(baseTestDir, { recursive: true })

    try {
        // =========================================================================
        // TEST 1: Source selection & Environment Mode (Normal vs Development)
        // =========================================================================
        {
            // Normal mode without -dev
            const normalSel = resolveObserverSourceSelection({}, baseTestDir, ['node', 'src/observer.ts'])
            assert.strictEqual(normalSel.environmentMode, 'normal')
            assert.strictEqual(normalSel.sourceFile, 'accounts.json')

            // Development mode with -dev
            const devSel = resolveObserverSourceSelection({}, baseTestDir, ['node', 'src/observer.ts', '-dev'])
            assert.strictEqual(devSel.environmentMode, 'development')
            assert.strictEqual(devSel.sourceFile, 'accounts.dev.json')

            // Development mode with --dev
            const devSelLong = resolveObserverSourceSelection({}, baseTestDir, ['node', 'src/observer.ts', '--dev'])
            assert.strictEqual(devSelLong.environmentMode, 'development')
            assert.strictEqual(devSelLong.sourceFile, 'accounts.dev.json')

            // Custom CLI accounts path
            const customSel = resolveObserverSourceSelection({}, baseTestDir, [
                'node',
                'src/observer.ts',
                '--accounts',
                'custom.json'
            ])
            assert.strictEqual(customSel.sourceFile, 'custom.json')

            console.log(
                '  ✅ Test 1 Passed: Source selection prioritizes explicit flags (-dev -> accounts.dev.json, default -> accounts.json)'
            )
        }

        // =========================================================================
        // TEST 2: Environment Isolation & Zero Silent Fallback
        // =========================================================================
        {
            // Dev mode when accounts.dev.json is missing: must fail specifically for accounts.dev.json
            const devRes = AccountLoader.load(baseTestDir, 'accounts.dev.json', 'development')
            assert.strictEqual(devRes.status, 'failed')
            assert.strictEqual(devRes.sourceFile, 'accounts.dev.json')
            assert.strictEqual(devRes.error?.code, 'file-not-found')
            assert.ok(devRes.error?.remediation.includes('accounts.dev.json'))
            assert.strictEqual(devRes.environmentMode, 'development')

            // Normal mode when accounts.json is missing: must fail specifically for accounts.json
            const normalRes = AccountLoader.load(baseTestDir, 'accounts.json', 'normal')
            assert.strictEqual(normalRes.status, 'failed')
            assert.strictEqual(normalRes.sourceFile, 'accounts.json')
            assert.strictEqual(normalRes.error?.code, 'file-not-found')
            assert.ok(normalRes.error?.remediation.includes('accounts.json'))
            assert.strictEqual(normalRes.environmentMode, 'normal')

            console.log(
                '  ✅ Test 2 Passed: Environment isolation confirmed (zero silent fallback across environments)'
            )
        }

        // =========================================================================
        // TEST 3: 0-byte or whitespace-only file returns malformed-json, NOT empty
        // =========================================================================
        {
            const zeroByteFile = path.join(baseTestDir, 'zero_byte.json')
            fs.writeFileSync(zeroByteFile, '')
            const resZero = AccountLoader.load(baseTestDir, 'zero_byte.json')
            assert.strictEqual(resZero.status, 'failed')
            assert.strictEqual(resZero.error?.code, 'malformed-json')
            assert.ok(resZero.error?.message.includes('terpotong'))

            const whitespaceFile = path.join(baseTestDir, 'whitespace.json')
            fs.writeFileSync(whitespaceFile, '   \r\n\t  \n  ')
            const resWs = AccountLoader.load(baseTestDir, 'whitespace.json')
            assert.strictEqual(resWs.status, 'failed')
            assert.strictEqual(resWs.error?.code, 'malformed-json')
            console.log('  ✅ Test 3 Passed: 0-byte and whitespace files rejected as malformed-json (not empty)')
        }

        // =========================================================================
        // TEST 4: Zero Credential Leakage & Strict Field Allowlisting
        // =========================================================================
        {
            const sensitiveFile = path.join(baseTestDir, 'sensitive_accounts.json')
            const rawAccountsData = [
                {
                    id: 'alpha-001',
                    email: 'alpha.user@example.com',
                    password: 'super_secret_password_123',
                    totpSecret: 'JBSWY3DPEHPK3PXP',
                    recoveryEmail: 'alpha.recovery@example.com',
                    geoLocale: 'en-US',
                    langCode: 'en',
                    proxy: {
                        proxyAxios: true,
                        url: '10.0.0.1',
                        port: 8080,
                        username: 'proxyuser',
                        password: 'proxypassword'
                    },
                    saveFingerprint: { mobile: true, desktop: true }
                }
            ]
            fs.writeFileSync(sensitiveFile, JSON.stringify(rawAccountsData))

            const res = AccountLoader.load(baseTestDir, 'sensitive_accounts.json')
            assert.strictEqual(res.status, 'loaded')
            assert.strictEqual(res.acceptedCount, 1)

            const loadedIdentity = res.identities[0]!
            // Allowlist check: ONLY accountId, displayLabel, sessionLookupKey exist
            assert.strictEqual(loadedIdentity.accountId, 'alpha-001')
            assert.strictEqual(loadedIdentity.displayLabel, 'alp***@example.com')
            assert.strictEqual((loadedIdentity as any).password, undefined)
            assert.strictEqual((loadedIdentity as any).totpSecret, undefined)
            assert.strictEqual((loadedIdentity as any).recoveryEmail, undefined)
            assert.strictEqual((loadedIdentity as any).proxy, undefined)

            // Stringified output check: zero credential substrings
            const stringified = JSON.stringify(res.identities)
            assert.strictEqual(stringified.includes('super_secret_password_123'), false)
            assert.strictEqual(stringified.includes('JBSWY3DPEHPK3PXP'), false)
            assert.strictEqual(stringified.includes('proxypassword'), false)

            console.log(
                '  ✅ Test 4 Passed: Zero credential leakage confirmed (passwords/secrets stripped via allowlist)'
            )
        }

        // =========================================================================
        // TEST 5: Identifier Stability Across Restarts (accountId stable, publicRef per session)
        // =========================================================================
        {
            const accountsFile = path.join(baseTestDir, 'stable_accounts.json')
            const stableData = [
                { email: 'user.first@outlook.com', password: 'pwd' },
                { id: 'custom-id-999', email: 'user.second@outlook.com', password: 'pwd' }
            ]
            fs.writeFileSync(accountsFile, JSON.stringify(stableData))

            const run1 = AccountLoader.load(baseTestDir, 'stable_accounts.json')
            const run2 = AccountLoader.load(baseTestDir, 'stable_accounts.json')

            assert.strictEqual(run1.identities[0]!.accountId, run2.identities[0]!.accountId)
            assert.strictEqual(run1.identities[0]!.accountId, 'user.first@outlook.com')
            assert.strictEqual(run1.identities[1]!.accountId, run2.identities[1]!.accountId)
            assert.strictEqual(run1.identities[1]!.accountId, 'custom-id-999')
            assert.strictEqual(run1.identities[0]!.displayLabel, run2.identities[0]!.displayLabel)

            console.log('  ✅ Test 5 Passed: accountId stability verified across repeated loads without random UUIDs')
        }

        // =========================================================================
        // TEST 6: Blank Email & Duplicate Identifiers Rejected Fail-Closed
        // =========================================================================
        {
            const mixedFile = path.join(baseTestDir, 'mixed_accounts.json')
            const mixedData = [
                { email: '   ', password: 'pwd' }, // Blank email: reject
                { email: 'valid.one@outlook.com', password: 'pwd' }, // Valid: accept
                { email: 'dup.user@outlook.com', password: 'pwd' }, // Dup 1: reject
                { email: 'dup.user@outlook.com', password: 'pwd' } // Dup 2: reject
            ]
            fs.writeFileSync(mixedFile, JSON.stringify(mixedData))

            const res = AccountLoader.load(baseTestDir, 'mixed_accounts.json')
            assert.strictEqual(res.status, 'loaded')
            assert.strictEqual(res.acceptedCount, 1)
            assert.strictEqual(res.rejectedCount, 3)
            assert.strictEqual(res.identities[0]!.accountId, 'valid.one@outlook.com')

            console.log('  ✅ Test 6 Passed: Blank email and duplicate entries rejected safely fail-closed')
        }

        // =========================================================================
        // TEST 7: Separate Format Parsers (Identities Manifest vs Accounts Format)
        // =========================================================================
        {
            // Format A: Identities manifest without email
            const manifestFile = path.join(baseTestDir, 'pure_identities.json')
            fs.writeFileSync(
                manifestFile,
                JSON.stringify([{ accountId: 'uuid-alpha-1234', displayLabel: 'Akun Khusus Operator' }])
            )
            const manifestRes = AccountLoader.load(baseTestDir, 'pure_identities.json')
            assert.strictEqual(manifestRes.status, 'loaded')
            assert.strictEqual(manifestRes.identities.length, 1)
            assert.strictEqual(manifestRes.identities[0]!.accountId, 'uuid-alpha-1234')
            assert.strictEqual(manifestRes.identities[0]!.displayLabel, 'Aku***')

            console.log('  ✅ Test 7 Passed: Separate format adapters verified (manifest loads cleanly without email)')
        }

        // =========================================================================
        // TEST 8: Session Path Traversal Protection
        // =========================================================================
        {
            const sessionBase = path.join(baseTestDir, 'sessions')
            await fs.promises.mkdir(sessionBase, { recursive: true })

            const maliciousKey1 = '../../windows/system32'
            const resolved1 = ObserverPaths.resolveAccountSessionDir(sessionBase, maliciousKey1)
            assert.strictEqual(resolved1, null, 'Traversal path must resolve to null')

            const maliciousKey2 = '/absolute/path'
            const resolved2 = ObserverPaths.resolveAccountSessionDir(sessionBase, maliciousKey2)
            assert.strictEqual(resolved2, null, 'Absolute path must resolve to null')

            const validKey = 'user@example.com'
            const validResolved = ObserverPaths.resolveAccountSessionDir(sessionBase, validKey)
            assert.ok(validResolved && validResolved.startsWith(path.resolve(sessionBase)))

            console.log('  ✅ Test 8 Passed: Path traversal protection on session directory confirmed')
        }

        // =========================================================================
        // TEST 9: Kriteria A — Source failed -> runtime degraded, dashboard available
        // =========================================================================
        {
            const degradedPort = 41401
            const storageDir = path.join(baseTestDir, 'degraded_storage')
            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: 'missing_accounts.json',
                storageDirectory: storageDir,
                dashboard: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: degradedPort,
                    maxSseClients: 5,
                    sseHeartbeatMs: 10000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({
                config,
                configDir: baseTestDir
            })

            await runtime.start()
            assert.strictEqual(runtime.getState(), 'degraded', 'Runtime must transition to degraded when source fails')

            // Verify dashboard server is running and returns degraded snapshot
            const statusRes = await makeGetRequest(degradedPort, '/api/status')
            assert.strictEqual(statusRes.statusCode, 200)
            const snapshot = JSON.parse(statusRes.body)
            assert.strictEqual(snapshot.runtime.status, 'degraded')
            assert.strictEqual(snapshot.dataSource.status, 'failed')
            assert.strictEqual(snapshot.dataSource.error.code, 'file-not-found')
            assert.ok(snapshot.dataSource.error.remediation.length > 0)

            await runtime.stop('test-done')
            assert.strictEqual(runtime.getState(), 'stopped')
            console.log(
                '  ✅ Test 9 Passed: Kriteria A confirmed (source failed -> degraded runtime, dashboard accessible)'
            )
        }

        // =========================================================================
        // TEST 10: Kriteria B — 5 valid accounts with no session/handoff -> 5 unknown rows
        // =========================================================================
        {
            const readyPort = 41402
            const storageDir = path.join(baseTestDir, 'five_accounts_storage')
            const accountsFile = path.join(baseTestDir, 'five_synthetic_accounts.json')

            const fiveAccounts = [
                { email: 'user.alpha@test.local', password: 'p1' },
                { email: 'user.beta@test.local', password: 'p2' },
                { email: 'user.gamma@test.local', password: 'p3' },
                { email: 'user.delta@test.local', password: 'p4' },
                { email: 'user.epsilon@test.local', password: 'p5' }
            ]
            fs.writeFileSync(accountsFile, JSON.stringify(fiveAccounts))

            const config: ObserverConfig = {
                contractVersion: 1,
                accountsPath: 'five_synthetic_accounts.json',
                storageDirectory: storageDir,
                dashboard: {
                    enabled: true,
                    host: '127.0.0.1',
                    port: readyPort,
                    maxSseClients: 5,
                    sseHeartbeatMs: 10000
                },
                staleEvidenceThresholdHours: 48,
                shutdownTimeoutMs: 5000
            }

            const runtime = new ObserverRuntime({
                config,
                configDir: baseTestDir
            })

            await runtime.start()
            assert.strictEqual(runtime.getState(), 'running')

            const statusRes = await makeGetRequest(readyPort, '/api/status')
            assert.strictEqual(statusRes.statusCode, 200)
            const snapshot = JSON.parse(statusRes.body)

            assert.strictEqual(snapshot.summary.totalAccounts, 5)
            assert.strictEqual(snapshot.accounts.length, 5)
            assert.strictEqual(snapshot.dataSource.status, 'loaded')
            assert.strictEqual(snapshot.dataSource.acceptedCount, 5)
            assert.strictEqual(snapshot.dataSource.sourceFile, 'five_synthetic_accounts.json')

            // Verify each account status reflects ground truth (unknown, NOT technically-ready)
            for (const acc of snapshot.accounts) {
                assert.strictEqual(acc.status, 'unknown')
                assert.strictEqual(acc.sessionState, 'missing')
            }

            // Verify sum formula: unknown + notReady + authRequired + manualReviewRequired + technicallyReady + blocked === totalAccounts
            const sum =
                snapshot.summary.unknown +
                snapshot.summary.notReady +
                snapshot.summary.authRequired +
                snapshot.summary.manualReviewRequired +
                snapshot.summary.technicallyReadyForHandoff +
                snapshot.summary.blocked
            assert.strictEqual(sum, 5, 'Sum of all status buckets must exactly equal totalAccounts')

            // Verify zero credentials in snapshot JSON
            const snapJson = JSON.stringify(snapshot)
            assert.strictEqual(snapJson.includes('p1'), false)
            assert.strictEqual(snapJson.includes('password'), false)

            await runtime.stop('test-done')
            console.log(
                '  ✅ Test 10 Passed: Kriteria B confirmed (5 valid accounts visible with ground truth unknown status & verified counter sum)'
            )
        }

        console.log('🎉 ALL 10 ACCOUNT LOADER & UX ACCEPTANCE TESTS PASSED SUCCESSFULLY!\n')
    } finally {
        try {
            await fs.promises.rm(baseTestDir, { recursive: true, force: true })
        } catch {}
    }
}
