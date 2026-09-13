import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../../index'
import { saveSessionData, setRateLimitCooldown, getRateLimitCooldown } from '../../util/Load'

import { MobileAccessLogin } from './methods/MobileAccessLogin'
import { EmailLogin } from './methods/EmailLogin'
import { PasswordlessLogin } from './methods/PasswordlessLogin'
import { TotpLogin } from './methods/Totp2FALogin'
import { CodeLogin } from './methods/GetACodeLogin'
import { RecoveryLogin } from './methods/RecoveryEmailLogin'

import type { Account } from '../../interface/Account'

type LoginState =
    | 'EMAIL_INPUT'
    | 'PASSWORD_INPUT'
    | 'SIGN_IN_ANOTHER_WAY'
    | 'SIGN_IN_ANOTHER_WAY_EMAIL'
    | 'PASSKEY_ERROR'
    | 'PASSKEY_VIDEO'
    | 'KMSI_PROMPT'
    | 'LOGGED_IN'
    | 'RECOVERY_EMAIL_INPUT'
    | 'ACCOUNT_LOCKED'
    | 'ERROR_ALERT'
    | '2FA_TOTP'
    | 'LOGIN_PASSWORDLESS'
    | 'GET_A_CODE'
    | 'GET_A_CODE_2'
    | 'OTP_CODE_ENTRY'
    | 'UNKNOWN'
    | 'CHROMEWEBDATA_ERROR'
    | 'TOO_MANY_REQUESTS' 

export class Login {
    emailLogin: EmailLogin
    passwordlessLogin: PasswordlessLogin
    totp2FALogin: TotpLogin
    codeLogin: CodeLogin
    recoveryLogin: RecoveryLogin
    private loginRetryCount = 0 

    private readonly selectors = {
        primaryButton: 'button[data-testid="primaryButton"]',
        secondaryButton: 'button[data-testid="secondaryButton"]',
        emailIcon: '[data-testid="tile"]:has(svg path[d*="M5.25 4h13.5a3.25"])',
        emailIconOld: 'img[data-testid="accessibleImg"][src*="picker_verify_email"]',
        recoveryEmail: '[data-testid="proof-confirmation"]',
        passwordIcon: '[data-testid="tile"]:has(svg path[d*="M11.78 10.22a.75.75"])',
        accountLocked: '#serviceAbuseLandingTitle',
        errorAlert: 'div[role="alert"], #usernameError, #passwordError',
        passwordEntry: '[data-testid="passwordEntry"], input[type="password"], input[name="passwd"]',
        emailEntry: 'input#usernameEntry, input[type="email"], input[name="loginfmt"]',
        kmsiVideo: '[data-testid="kmsiVideo"]',
        passKeyVideo: '[data-testid="biometricVideo"]',
        passKeyError: '[data-testid="registrationImg"]',
        passwordlessCheck: '[data-testid="deviceShieldCheckmarkVideo"]',
        totpInput: 'input[name="otc"]',
        totpInputOld: 'form[name="OneTimeCodeViewForm"]',
        identityBanner: '[data-testid="identityBanner"]',
        viewFooter: '[data-testid="viewFooter"] >> [role="button"]',
        otherWaysToSignIn: '[data-testid="viewFooter"] span[role="button"]',
        otpCodeEntry: '[data-testid="codeEntry"]',
        backButton: '#back-button',
        bingProfile: '#id_n',
        requestToken: 'input[name="__RequestVerificationToken"]',
        requestTokenMeta: 'meta[name="__RequestVerificationToken"]',
        otpInput: 'div[data-testid="codeEntry"]'
    } as const

    constructor(private bot: MicrosoftRewardsBot) {
        this.emailLogin = new EmailLogin(this.bot)
        this.passwordlessLogin = new PasswordlessLogin(this.bot)
        this.totp2FALogin = new TotpLogin(this.bot)
        this.codeLogin = new CodeLogin(this.bot)
        this.recoveryLogin = new RecoveryLogin(this.bot)
    }

    async login(page: Page, account: Account) {
        try {
            this.loginRetryCount = 0
            this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Starting login process')

            const remainingCooldown = getRateLimitCooldown(this.bot.config.sessionPath)
            if (remainingCooldown > 0) {
                const configLimit = this.bot.config.loginRateLimit
                if (configLimit && this.loginRetryCount >= configLimit.maxAttempts) {
                    const msg = 'IP is rate limited and max retries exhausted, skipping account'
                    this.bot.logger.error(this.bot.isMobile, 'LOGIN', msg)
                    throw new Error(msg)
                }
                this.bot.logger.warn(
                    this.bot.isMobile,
                    'LOGIN',
                    `IP rate limit active, waiting remaining ${Math.ceil(remainingCooldown / 1000)}s`
                )
                await this.bot.utils.wait(remainingCooldown)
            }

            await page
                .goto('https://rewards.bing.com/createuser?idru=%2F&userScenarioId=anonsignin', {
                    waitUntil: 'domcontentloaded'
                })
                .catch(() => {})
            await this.bot.utils.wait(2000)
            await this.bot.browser.utils.reloadBadPage(page)
            await this.bot.browser.utils.disableFido(page)

            const maxIterations = 25
            let iteration = 0
            let previousState: LoginState = 'UNKNOWN'
            let sameStateCount = 0

while (iteration < maxIterations) {
                if (page.isClosed()) throw new Error('Page closed unexpectedly')

                iteration++
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `State check iteration ${iteration}/${maxIterations}`)

                // =========================================================================
                // 🛠️ SAFE DEFENSIVE INTERCEPTOR (GLOBAL BYPASS TO PASSWORD SCREEN)
                // =========================================================================
                try {
                    const usePasswordBtn = page.locator('#idA_PWD').first()
                    if (await usePasswordBtn.count() > 0 && await usePasswordBtn.isVisible()) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-INTERCEPTOR', 'Bypassing passwordless screen. Forcing password field...', 'yellow')
                        await usePasswordBtn.click().catch(() => {})
                        await this.bot.utils.wait(1500)
                    }

                    const skipRecoveryBtn = page.locator('#iShowSkip').first()
                    if (await skipRecoveryBtn.count() > 0 && await skipRecoveryBtn.isVisible()) {
                        await skipRecoveryBtn.click().catch(() => {})
                        await this.bot.utils.wait(1500)
                    }
                } catch (e) {
                    // Safe error isolation
                }
                // =========================================================================

                const state = await this.detectCurrentState(page, account)
                this.bot.logger.debug(this.bot.isMobile, 'LOGIN', `Current state: ${state}`)

                if (state === 'UNKNOWN') {
                    const currentTitle = await page.title().catch(() => 'No Title')
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN-TELEMETRY', `Stuck on page title: "${currentTitle}" | URL: ${page.url()}`, 'yellow')
                }

                if (state !== previousState && previousState !== 'UNKNOWN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', `State transition: ${previousState} → ${state}`)
                }

                // FIX RPL: Jangan pernah me-refresh halaman jika user sedang dalam proses ketik manual OTP / 2FA!
                if (state === previousState && state !== 'LOGGED_IN' && state !== 'UNKNOWN' && state !== 'OTP_CODE_ENTRY' && state !== '2FA_TOTP') {
                    sameStateCount++
                    if (sameStateCount >= 4) {
                        this.bot.logger.warn(this.bot.isMobile, 'LOGIN', `Stuck in state "${state}", refreshing page`)
                        await page.reload({ waitUntil: 'domcontentloaded' })
                        await this.bot.utils.wait(3000)
                        sameStateCount = 0
                        previousState = 'UNKNOWN'
                        continue
                    }
                } else {
                    sameStateCount = 0
                }
                previousState = state

                if (state === 'LOGGED_IN') {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Successfully logged in')
                    break
                }

                const shouldContinue = await this.handleState(state, page, account)
                if (!shouldContinue) {
                    throw new Error(`Login failed or aborted at state: ${state}`)
                }

                await this.bot.utils.wait(1000)
            }

            if (iteration >= maxIterations) throw new Error('Login timeout: exceeded maximum iterations')

            await this.finalizeLogin(page, account.email)
        } catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'LOGIN', `Fatal error: ${error instanceof Error ? error.message : String(error)}`)
            throw error
        }
    }
    
    async getAppAccessToken(page: Page, email: string) {
        this.bot.logger.info(this.bot.isMobile, 'GET-APP-TOKEN', 'Requesting mobile access token')
        return await new MobileAccessLogin(this.bot, page).get(email)
    }

    private async detectCurrentState(page: Page, account?: Account): Promise<LoginState> {
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {})

        const url = new URL(page.url())
        
        if (url.hostname === 'login.live.com' && url.pathname === '/ppsecure/post.srf') {
            const pageContent = await page.content().catch(() => '')
            if (pageContent.toLowerCase().includes('too many requests')) {
                return 'TOO_MANY_REQUESTS'
            }
        }

        if (url.hostname === 'chromewebdata') return 'CHROMEWEBDATA_ERROR'

        const isLocked = await this.checkSelector(page, this.selectors.accountLocked)
        if (isLocked) return 'ACCOUNT_LOCKED'

        if (url.hostname === 'rewards.bing.com' || url.hostname === 'account.microsoft.com') return 'LOGGED_IN'

        const stateChecks: Array<[string, LoginState]> = [
            [this.selectors.errorAlert, 'ERROR_ALERT'],
            [this.selectors.passwordEntry, 'PASSWORD_INPUT'],
            [this.selectors.emailEntry, 'EMAIL_INPUT'],
            [this.selectors.recoveryEmail, 'RECOVERY_EMAIL_INPUT'],
            ['#iProofEmail, input[name="proof"]', 'RECOVERY_EMAIL_INPUT'],
            ['#idDiv_SAOTCS_Title, *:has-text("Get a code to sign in")', 'GET_A_CODE'], 
            [this.selectors.kmsiVideo, 'KMSI_PROMPT'],
            [this.selectors.passKeyVideo, 'PASSKEY_VIDEO'],
            [this.selectors.passKeyError, 'PASSKEY_ERROR'],
            [this.selectors.passwordIcon, 'SIGN_IN_ANOTHER_WAY'],
            [this.selectors.emailIcon, 'SIGN_IN_ANOTHER_WAY_EMAIL'],
            [this.selectors.emailIconOld, 'SIGN_IN_ANOTHER_WAY_EMAIL'],
            [this.selectors.passwordlessCheck, 'LOGIN_PASSWORDLESS'],
            [this.selectors.totpInput, '2FA_TOTP'],
            [this.selectors.totpInputOld, '2FA_TOTP'],
            [this.selectors.otpCodeEntry, 'OTP_CODE_ENTRY'],
            [this.selectors.otpInput, 'OTP_CODE_ENTRY']
        ]

        const results = await Promise.all(stateChecks.map(async ([sel, state]) => (await this.checkSelector(page, sel)) ? state : null))
        const foundStates = results.filter((s): s is LoginState => s !== null)

        if (foundStates.length === 0) return 'UNKNOWN'

        const priorities: LoginState[] = [
            'ACCOUNT_LOCKED', 'ERROR_ALERT', 'PASSKEY_VIDEO', 'PASSKEY_ERROR', 'KMSI_PROMPT', 
            'PASSWORD_INPUT', 'EMAIL_INPUT', 'SIGN_IN_ANOTHER_WAY', 'SIGN_IN_ANOTHER_WAY_EMAIL', 
            'RECOVERY_EMAIL_INPUT', 'GET_A_CODE', 'OTP_CODE_ENTRY', 'LOGIN_PASSWORDLESS', '2FA_TOTP'
        ]

        for (const priority of priorities) {
            if (foundStates.includes(priority)) return priority
        }

        return foundStates[0] as LoginState
    }

 private async handleState(state: LoginState, page: Page, account: Account): Promise<boolean> {
        this.bot.logger.debug(this.bot.isMobile, 'HANDLE-STATE', `Processing state: ${state}`)

        switch (state) {
            case 'TOO_MANY_REQUESTS': { 
                const configLimit = this.bot.config.loginRateLimit
                if (!configLimit) throw new Error('loginRateLimit config missing')
                
                this.loginRetryCount++
                if (this.loginRetryCount > configLimit.maxAttempts) {
                    throw new Error(`Rate limit retry exhausted after ${configLimit.maxAttempts} attempts`)
                }

                const delayMs = this.bot.utils.stringToNumber(configLimit.delay)
                setRateLimitCooldown(this.bot.config.sessionPath, delayMs)
                await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
                await this.bot.utils.wait(2000)
                return true
            }

            case 'ACCOUNT_LOCKED':
                throw new Error('This account has been locked!')

            case 'ERROR_ALERT': {
                const alertEl = page.locator(this.selectors.errorAlert).first()
                const errorMsg = await alertEl.innerText().catch(() => 'Unknown Error')
                throw new Error(`Microsoft login error: ${errorMsg}`)
            }

            case 'PASSKEY_VIDEO':
            case 'PASSKEY_ERROR': {
                this.bot.logger.warn(this.bot.isMobile, 'LOGIN-PASSKEY', 'Passkey enrollment interrupt detected! Attempting to skip...', 'yellow')
                const skipBtn = page.locator("#iCancel, #iSkip, button:has-text('Skip for now'), button:has-text('Not now'), button:has-text('Cancel')").first()
                if (await skipBtn.count() > 0 && await skipBtn.isVisible()) {
                    await skipBtn.click().catch(() => {})
                    await this.bot.utils.wait(2000)
                } else {
                    // Kalau lu pake headful mode (headless: false), kasih waktu 10 detik buat klik "Cancel/Skip" manual di layar
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-PASSKEY', 'No auto-skip button found. Please click "Cancel/Skip" manually on the browser screen!', 'yellow')
                    await this.bot.utils.wait(10000)
                }
                return true
            }

            case 'EMAIL_INPUT':
                await this.emailLogin.enterEmail(page, account.email)
                return true

            case 'PASSWORD_INPUT':
                await this.emailLogin.enterPassword(page, account.password)
                return true

            case 'GET_A_CODE': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-PASSWORDLESS', 'Get code screen detected. Scanning redirection options...');
                const buttons = ['#idA_PWD', '#iSignInInstead', 'text=Use your password instead', 'text=Sign in with a password', 'text=Use a password instead'];
                for (const selector of buttons) {
                    const btn = page.locator(selector).first();
                    if (await btn.count() > 0 && await btn.isVisible()) {
                        this.bot.logger.info(this.bot.isMobile, 'LOGIN-PASSWORDLESS', `Redirect shortcut found via ${selector}, triggering...`, 'yellow');
                        await btn.click().catch(() => {});
                        await this.bot.utils.wait(2000);
                        return true;
                    }
                }
                
                if (this.bot.config.headless === false) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN-PASSWORDLESS', 'Headless is FALSE. Clicking "Send Code" to let you perform manual entry...', 'yellow')
                    const submits = ['#idSubmitButton', 'input[type="submit"]', 'button[type="submit"]', '#idBtn_Back'];
                    for (const sel of submits) {
                        const btn = page.locator(sel).first();
                        if (await btn.count() > 0 && await btn.isVisible()) {
                            await btn.click().catch(() => {});
                            await this.bot.utils.wait(2000);
                            return true;
                        }
                    }
                }

                throw new Error('Account locked into strictly passwordless OTP sequence by Microsoft.')
            }

            case 'RECOVERY_EMAIL_INPUT': {
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-RECOVERY', 'Handling email screening compliance...');
                const usePasswordBtn = page.locator('#idA_PWD, #iSignInInstead').first()
                if (await usePasswordBtn.count() > 0 && await usePasswordBtn.isVisible()) {
                    await usePasswordBtn.click().catch(() => {})
                } else {
                    await this.recoveryLogin.handle(page, account.recoveryEmail).catch(() => {})
                }
                return true
            }

            // FIX RPL: Satukan state 2FA_TOTP ke mari biar ikut nahan thread pas lu mau input manual
            case '2FA_TOTP':
            case 'OTP_CODE_ENTRY': { 
                this.bot.logger.info(this.bot.isMobile, 'LOGIN-OTP', 'OTP/2FA Code Entry screen detected. Checking fallbacks...');
                const usePasswordBtn = page.locator('#idA_PWD, #iSignInInstead').first()
                if (await usePasswordBtn.count() > 0 && await usePasswordBtn.isVisible()) {
                    this.bot.logger.info(this.bot.isMobile, 'LOGIN-OTP', 'Bypassing OTP via password fallback...', 'yellow')
                    await usePasswordBtn.click().catch(() => {})
                    await this.bot.utils.wait(2000)
                    return true
                } 

                if (this.bot.config.headless === false) {
                    this.bot.logger.warn(this.bot.isMobile, 'LOGIN-OTP', 'MANUAL OVERRIDE: Thread locked for 60s. Enter OTP pin directly on browser screen!', 'yellow')
                    for (let i = 0; i < 60; i++) {
                        await this.bot.utils.wait(1000)
                        const currentUrl = page.url()
                        if (currentUrl.includes('rewards.bing.com') || currentUrl.includes('account.microsoft.com')) {
                            return true 
                        }
                    }
                }

                throw new Error('Forced OTP verification checkpoint active with no automated bypass options.')
            }

            case 'KMSI_PROMPT':
                await this.bot.browser.utils.ghostClick(page, this.selectors.primaryButton)
                return true

            case 'LOGGED_IN': return true
            default: return true
        }
    }

    private async finalizeLogin(page: Page, email: string) {
        await page.goto(this.bot.config.baseURL, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})
        await this.verifyBingSession(page)
        await this.getRewardsSession(page)
        const cookies = await page.context().cookies()
        await saveSessionData(this.bot.config.sessionPath, cookies, email, this.bot.isMobile)
        this.bot.logger.info(this.bot.isMobile, 'LOGIN', 'Login completed, session saved')
    }

    async verifyBingSession(page: Page) {
        const url = 'https://www.bing.com/fd/auth/signin?action=interactive&provider=windows_live_id&return_url=https%3A%2F%2Fwww.bing.com%2F'
        await page.goto(url, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})
        const signedIn = await page.waitForSelector(this.selectors.bingProfile, { timeout: 3000 }).then(() => true).catch(() => false)
        if (signedIn) this.bot.logger.info(this.bot.isMobile, 'LOGIN-BING', 'Bing session verified successfully')
    }

    private async getRewardsSession(page: Page) {
        await page.goto(`${this.bot.config.baseURL}?_=${Date.now()}`, { waitUntil: 'networkidle', timeout: 10000 }).catch(() => {})
        const html = await page.content()
        const $ = await this.bot.browser.utils.loadInCheerio(html)
        if ($('section#dailyset').length > 0) {
            this.bot.rewardsVersion = 'modern' 
            this.bot.logger.warn(this.bot.isMobile, 'GET-REWARD-SESSION', 'Modern Rewards dashboard detected.')
        }
        const token = $(this.selectors.requestToken).attr('value') ?? $(this.selectors.requestTokenMeta).attr('content')
        if (token) this.bot.requestToken = token
    }

    private async checkSelector(page: Page, selector: string): Promise<boolean> {
        return page.waitForSelector(selector, { state: 'visible', timeout: 200 }).then(() => true).catch(() => false)
    }
}