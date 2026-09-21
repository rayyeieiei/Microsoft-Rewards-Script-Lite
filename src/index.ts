import { getDefaultConfig, loadLiteAccounts } from './core/Config'
import { LiteAccountScope } from './core/LiteAccountScope'
import { AccountExecutionResult } from './types/AccountTypes'
import { sanitizeLogMessage } from './util/Redaction'

export async function runCountdown(
    seconds: number,
    sleepFn?: (ms: number) => Promise<void>
): Promise<void> {
    const sleep = sleepFn || ((ms: number) => new Promise(r => setTimeout(r, ms)))
    for (let s = seconds; s > 0; s--) {
        if (process.stdout && process.stdout.isTTY) {
            process.stdout.write(
                `\r   └─ [Inter-Account Cool-Off] Melanjutkan akun berikutnya dalam ${s} detik...   `
            )
        }
        await sleep(1000)
    }
    if (process.stdout && process.stdout.isTTY) {
        process.stdout.write(
            `\r   └─ [Inter-Account Cool-Off] Melanjutkan sekarang...                          \n`
        )
    }
}

async function main() {
    const isDev = process.argv.includes('-dev')
    const config = getDefaultConfig()

    console.log('='.repeat(65))
    console.log('   Microsoft Rewards Script Lite - Pure HTTP / DAPI Engine   ')
    console.log('='.repeat(65))
    console.log(`Mode Lingkungan: ${isDev ? 'DEVELOPMENT (-dev)' : 'PRODUCTION'}`)
    console.log(`Target Negara   : ${config.country}`)
    console.log(`Timeout HTTP    : ${config.requestTimeoutMs}ms (Batas Anti-Abuse)`)
    console.log(`Jeda Artikel    : ${config.minReadDelayMs}ms - ${config.maxReadDelayMs}ms (Jitter)`)
    console.log(`Maks Artikel    : ${config.maxArticles} artikel per akun`)
    console.log('='.repeat(65))

    let accounts
    try {
        accounts = loadLiteAccounts(isDev)
    } catch (err: any) {
        console.error(`\n❌ Gagal memuat daftar akun: ${err.message}`)
        process.exit(1)
    }

    if (accounts.length === 0) {
        console.log('\n⚠️  Tidak ada akun yang ditemukan untuk diproses.')
        return
    }

    console.log(`\n📋 Ditemukan ${accounts.length} akun terdaftar. Memulai antrean eksekusi...\n`)

    const exclusionPool = new Set<string>()
    const results: AccountExecutionResult[] = []

    let accountIdx = 0
    for (const account of accounts) {
        accountIdx++
        console.log(`\n[Akun ${accountIdx}/${accounts.length}] ------------------------------------------`)

        const scope = new LiteAccountScope(account, config, {
            exclusionPool
        })
        const result = await scope.run()
        results.push(result)

        // Humanized cool-off delay antar-akun (35 s.d. 75 detik)
        if (accountIdx < accounts.length) {
            const minCoolOff = 35
            const maxCoolOff = 75
            const coolOffSeconds =
                Math.floor(Math.random() * (maxCoolOff - minCoolOff + 1)) + minCoolOff
            console.log(
                `\n⏳ Menunggu ${coolOffSeconds} detik sebelum memproses akun berikutnya (Humanized Cool-Off)...`
            )
            await runCountdown(coolOffSeconds)
        }
    }

    // Print summary report
    console.log('\n' + '='.repeat(70))
    console.log('                   RINGKASAN EKSEKUSI AKUN                    ')
    console.log('='.repeat(70))
    console.log(
        `${'AKUN'.padEnd(25)} | ${'STATUS'.padEnd(10)} | ${'AWAL'.padEnd(7)} | ${'AKHIR'.padEnd(7)} | ${'POIN'.padEnd(6)} | ${'DURASI'.padEnd(8)}`
    )
    console.log('-'.repeat(70))

    let totalEarned = 0
    let successCount = 0

    for (const res of results) {
        const statusStr = res.success ? 'SUKSES' : 'GAGAL'
        const durationStr = `${(res.durationMs / 1000).toFixed(1)}s`
        totalEarned += res.pointsEarned
        if (res.success) successCount++

        console.log(
            `${res.emailMasked.padEnd(25)} | ${statusStr.padEnd(10)} | ${String(res.initialBalance).padEnd(7)} | ${String(res.finalBalance).padEnd(7)} | ${`+${res.pointsEarned}`.padEnd(6)} | ${durationStr.padEnd(8)}`
        )
        if (res.errorMessage) {
            console.log(`  └─ Error: ${sanitizeLogMessage(res.errorMessage)}`)
        }
    }

    console.log('='.repeat(70))
    console.log(
        `Total: ${accounts.length} akun | Berhasil: ${successCount} | Gagal: ${accounts.length - successCount} | Total Poin Diperoleh: +${totalEarned}`
    )
    console.log('='.repeat(70) + '\n')
}

// Global unhandled rejection safety
process.on('unhandledRejection', (reason: any) => {
    const msg = reason?.message || String(reason)
    console.error(`[FATAL] Unhandled Rejection: ${sanitizeLogMessage(msg)}`)
})

main().catch(err => {
    console.error(`[FATAL] Program error: ${sanitizeLogMessage(err.message || String(err))}`)
    process.exit(1)
})
