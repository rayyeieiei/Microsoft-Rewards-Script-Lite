import { HttpClient } from './HttpClient'
import { AuthService } from '../services/AuthService'
import { DashboardService } from '../services/DashboardService'
import { CheckInService } from '../services/CheckInService'
import { ReadToEarnService } from '../services/ReadToEarnService'
import { AccountData, AccountExecutionResult, LiteRuntimeConfig } from '../types/AccountTypes'
import { redactAccountKey, sanitizeLogMessage } from '../util/Redaction'

export interface LiteAccountScopeOptions {
    sessionFilePath?: string
    customCookieHeader?: string
    sleepFn?: (ms: number) => Promise<void>
    logger?: (message: string) => void
    exclusionPool?: Set<string>
}

export function extractSafeErrorMessage(err: any): string {
    if (!err) return 'Unknown error'
    if (typeof err === 'string') return sanitizeLogMessage(err)

    const isSuspended =
        err.message?.includes('ACCOUNT_FLAGGED_OR_SUSPENDED') ||
        err.response?.status === 403

    if (isSuspended) {
        return '[ACCOUNT_FLAGGED_OR_SUSPENDED] Akun dibatasi/ditangguhkan oleh sistem Microsoft (HTTP 403 / Access Denied)'
    }

    if (err.isAxiosError) {
        const status = err.response?.status
        const statusText = err.response?.statusText || ''
        const serverDetail =
            err.response?.data?.error_description ||
            err.response?.data?.error?.message ||
            err.response?.data?.error
        const detailStr = typeof serverDetail === 'string' ? serverDetail : ''
        return sanitizeLogMessage(
            `HTTP ${status || 'Network'} ${statusText}${detailStr ? ': ' + detailStr : ': ' + err.message}`
        )
    }

    return sanitizeLogMessage(err.message || String(err))
}

export class LiteAccountScope {
    private account: AccountData
    private config: LiteRuntimeConfig
    private options: LiteAccountScopeOptions
    private log: (message: string) => void

    constructor(
        account: AccountData,
        config: LiteRuntimeConfig,
        options: LiteAccountScopeOptions = {}
    ) {
        this.account = account
        this.config = config
        this.options = options
        this.log = (msg: string) => {
            const sanitized = sanitizeLogMessage(msg)
            if (options.logger) {
                options.logger(sanitized)
            } else {
                console.log(sanitized)
            }
        }
    }

    /**
     * Executes the pure HTTP lifecycle for a single account:
     * Auth -> Initial Balance -> CheckIn -> ReadToEarn -> Final Balance
     * Guarantees all allocated network resources and state are disposed in finally block.
     */
    public async run(): Promise<AccountExecutionResult> {
        const startTime = Date.now()
        const emailMasked = redactAccountKey(this.account.email)
        const accountId = this.account.accountId || this.account.id || this.account.email

        let client: HttpClient | null = null
        let authService: AuthService | null = null

        let initialBalance = 0
        let finalBalance = 0
        let checkInClaimed = false
        let articlesRead = 0
        let errorMessage: string | undefined

        try {
            this.log(`[LITE] [${emailMasked}] Memulai eksekusi Pure HTTP DAPI engine...`)

            // 1. Inisialisasi HTTP Client terisolasi
            client = new HttpClient({
                proxy: this.account.proxy,
                timeoutMs: this.config.requestTimeoutMs,
                country: this.config.country
            })

            authService = new AuthService(client, this.account.email)
            const dashboardService = new DashboardService(client)
            const checkInService = new CheckInService(client, this.config.country)
            const readToEarnService = new ReadToEarnService(client, {
                country: this.config.country,
                minDelayMs: this.config.minReadDelayMs,
                maxDelayMs: this.config.maxReadDelayMs,
                maxArticles: this.config.maxArticles,
                sleepFn: this.options.sleepFn,
                exclusionPool: this.options.exclusionPool,
                accountSeed: this.account.email
            })

            // 2. Otentikasi OAuth via passive 302
            this.log(`[LITE] [${emailMasked}] Melakukan otentikasi OAuth2 mobile...`)
            let accessToken = await authService.authenticate(this.options.customCookieHeader)
            this.log(`[LITE] [${emailMasked}] Otentikasi berhasil, token diperoleh`)

            // Helper to execute DAPI calls with 1x silent token refresh on HTTP 401
            const executeWithTokenRetry = async <T>(
                operation: (token: string) => Promise<T>
            ): Promise<T> => {
                try {
                    return await operation(accessToken)
                } catch (err: any) {
                    if (err.response?.status === 401 && authService) {
                        this.log(
                            `[LITE] [${emailMasked}] Token expired (HTTP 401). Melakukan 1x silent token refresh...`
                        )
                        try {
                            accessToken = await authService.authenticate(
                                this.options.customCookieHeader
                            )
                            this.log(`[LITE] [${emailMasked}] Token refresh berhasil, mengulang operasi...`)
                            return await operation(accessToken)
                        } catch (refreshErr) {
                            throw new Error(
                                `Token refresh gagal setelah HTTP 401: ${extractSafeErrorMessage(refreshErr)}`
                            )
                        }
                    }
                    throw err
                }
            }

            // 3. Ambil data profil & saldo awal
            const initialSnapshot = await executeWithTokenRetry(tok =>
                dashboardService.fetchDashboard(tok)
            )
            initialBalance = initialSnapshot.balance
            finalBalance = initialBalance
            this.log(
                `[LITE] [${emailMasked}] Saldo awal: ${initialBalance} poin | Check-in: ${
                    initialSnapshot.checkInAvailable ? 'Tersedia' : 'Sudah selesai'
                } | Read to Earn: ${initialSnapshot.readToEarnRemaining} poin tersisa`
            )

            // 4. Daily Check-In
            if (initialSnapshot.checkInAvailable) {
                this.log(`[LITE] [${emailMasked}] Mengklaim Daily Check-In...`)
                try {
                    const checkInResult = await executeWithTokenRetry(tok =>
                        checkInService.claimDailyCheckIn(tok)
                    )
                    if (checkInResult.claimed) {
                        checkInClaimed = true
                        this.log(`[LITE] [${emailMasked}] Daily Check-In berhasil diklaim!`)
                    } else {
                        this.log(
                            `[LITE] [${emailMasked}] Daily Check-In dilewati: ${
                                checkInResult.message || 'Belum tersedia'
                            }`
                        )
                    }
                } catch (checkInErr: any) {
                    this.log(
                        `[LITE] [${emailMasked}] Peringatan saat klaim Check-In: ${extractSafeErrorMessage(checkInErr)}`
                    )
                }
            }

            // 5. Read to Earn
            if (initialSnapshot.readToEarnRemaining > 0) {
                this.log(
                    `[LITE] [${emailMasked}] Memproses Read to Earn (kuota tersisa: ${initialSnapshot.readToEarnRemaining} poin)...`
                )
                try {
                    articlesRead = await executeWithTokenRetry(tok =>
                        readToEarnService.processReadToEarn(
                            tok,
                            initialSnapshot.readToEarnRemaining,
                            progress => {
                                this.log(
                                    `[LITE] [${emailMasked}] Membaca artikel riil [${progress.index}/${progress.total}] (ID: ${progress.articleId}) dengan jeda ${(progress.delayMs / 1000).toFixed(1)}s`
                                )
                            }
                        )
                    )
                    this.log(
                        `[LITE] [${emailMasked}] Berhasil memproses ${articlesRead} artikel berita MSN`
                    )
                } catch (readErr: any) {
                    this.log(
                        `[LITE] [${emailMasked}] Peringatan saat Read to Earn: ${extractSafeErrorMessage(readErr)}`
                    )
                }
            } else {
                this.log(`[LITE] [${emailMasked}] Kuota Read to Earn sudah terpenuhi hari ini`)
            }

            // 6. Ambil saldo akhir
            try {
                const finalSnapshot = await executeWithTokenRetry(tok =>
                    dashboardService.fetchDashboard(tok)
                )
                finalBalance = finalSnapshot.balance
            } catch {
                finalBalance = initialBalance
            }

            const pointsEarned = Math.max(0, finalBalance - initialBalance)
            this.log(
                `[LITE] [${emailMasked}] Selesai! Saldo akhir: ${finalBalance} poin (+${pointsEarned} poin bertambah)`
            )

            return {
                accountId,
                emailMasked,
                success: true,
                initialBalance,
                finalBalance,
                pointsEarned,
                checkInClaimed,
                articlesRead,
                durationMs: Date.now() - startTime
            }
        } catch (err: any) {
            errorMessage = extractSafeErrorMessage(err)
            const isSuspended = errorMessage.includes('ACCOUNT_FLAGGED_OR_SUSPENDED')
            if (isSuspended) {
                this.log(`[LITE] [${emailMasked}] ⚠️ AKUN DI-QUARANTINE: ${errorMessage}`)
            } else {
                this.log(`[LITE] [${emailMasked}] Eksekusi gagal: ${errorMessage}`)
            }

            return {
                accountId,
                emailMasked,
                success: false,
                initialBalance,
                finalBalance,
                pointsEarned: Math.max(0, finalBalance - initialBalance),
                checkInClaimed,
                articlesRead,
                errorMessage,
                durationMs: Date.now() - startTime
            }
        } finally {
            // ZERO GLOBAL STATE: Pastikan seluruh resource client dan auth dihancurkan total
            if (authService) {
                authService.dispose()
            }
            if (client) {
                client.dispose()
            }
            this.log(`[LITE] [${emailMasked}] Resource koneksi & sesi berhasil dibersihkan (Zero State)`)
        }
    }
}
