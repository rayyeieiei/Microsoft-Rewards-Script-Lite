import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { PlaywrightCookie, AccountData } from '../types/AccountTypes'
import { HttpClient } from './HttpClient'

export type SessionDevice = 'mobile' | 'desktop'

export interface CrucialCookies {
    _U?: string
    KievRPSAuth?: string
    MUID?: string
    RPSTAuth?: string
    WLSSC?: string
    MSPAuth?: string
    NAP?: string
    ANON?: string
    '__Host-MSAAUTHP'?: string
    SRCHUSR?: string
    SRCHHPGUSR?: string
    [key: string]: string | undefined
}

export interface ResolvedSession {
    accountId: string
    device: SessionDevice
    source: 'modern-envelope' | 'raw-storage-state' | 'legacy-cookie-json'
    filePath: string
    savedAt?: number
    cookies: PlaywrightCookie[]
    crucialCookies: CrucialCookies
    cookieHeader: string
}

export const TARGET_SESSION_DOMAINS = [
    'live.com',
    'microsoft.com',
    'bing.com',
    'msn.com',
    'rewardsplatform.microsoft.com'
]

export const CRUCIAL_COOKIE_NAMES = [
    '_U',
    'KievRPSAuth',
    'MUID',
    'RPSTAuth',
    'WLSSC',
    'MSPAuth',
    'NAP',
    'ANON',
    '__Host-MSAAUTHP',
    'SRCHUSR',
    'SRCHHPGUSR'
]

export class SessionResolver {
    /**
     * Resolves a stable account identifier from account data, matching Main engine v3.1.4 logic.
     */
    public static computeAccountId(account: { email: string; id?: string; accountId?: string }): string {
        if (account.accountId && account.accountId.trim().length > 0) {
            return account.accountId.trim()
        }
        if (account.id && account.id.trim().length > 0) {
            return account.id.trim()
        }
        const normalizedEmail = (account.email || '').toLowerCase().trim()
        return crypto.createHash('sha256').update(normalizedEmail).digest('hex')
    }

    /**
     * Derives storageKey hex (first 32 characters of sha256(accountId)), matching SessionPathResolver.ts in Main.
     */
    public static computeStorageKey(accountId: string): string {
        if (!accountId || typeof accountId !== 'string') {
            throw new Error('Invalid accountId: must be a non-empty string')
        }
        return crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 32)
    }

    /**
     * Returns candidate directories to search for session files.
     */
    public static getCandidateSessionDirs(baseDir?: string): string[] {
        const cwd = process.cwd()
        const dirs: string[] = []

        if (baseDir) {
            dirs.push(path.resolve(baseDir))
        }

        // Standard locations relative to CWD
        dirs.push(path.resolve(cwd, 'browser', 'sessions'))
        dirs.push(path.resolve(cwd, 'sessions'))

        // Locations if running from inside "Microsoft-Rewards-Script - Lite"
        dirs.push(path.resolve(cwd, '..', 'browser', 'sessions'))
        dirs.push(path.resolve(cwd, '..', 'sessions'))

        // Locations relative to __dirname
        dirs.push(path.resolve(__dirname, '..', '..', '..', 'browser', 'sessions'))
        dirs.push(path.resolve(__dirname, '..', '..', '..', 'sessions'))

        // Filter to unique paths that exist
        const seen = new Set<string>()
        const validDirs: string[] = []
        for (const d of dirs) {
            const resolved = path.resolve(d)
            if (!seen.has(resolved) && fs.existsSync(resolved)) {
                seen.add(resolved)
                validDirs.push(resolved)
            }
        }
        return validDirs
    }

    /**
     * Searches for a matching session file for an account and device across candidate directories.
     */
    public static findSessionFilePath(
        account: { email: string; id?: string; accountId?: string },
        device: SessionDevice = 'mobile',
        baseDir?: string
    ): { filePath: string; matchedBy: string } | null {
        const candidateDirs = this.getCandidateSessionDirs(baseDir)
        if (candidateDirs.length === 0) {
            return null
        }

        const normalizedEmail = (account.email || '').toLowerCase().trim()
        const primaryAccountId = this.computeAccountId(account)
        const primaryStorageKey = this.computeStorageKey(primaryAccountId)

        // Generate candidate storage keys to check
        const storageKeysToCheck: string[] = [primaryStorageKey]

        // Also check email-hash storage key if primary accountId was custom id
        const emailHash = crypto.createHash('sha256').update(normalizedEmail).digest('hex')
        const emailStorageKey = this.computeStorageKey(emailHash)
        if (!storageKeysToCheck.includes(emailStorageKey)) {
            storageKeysToCheck.push(emailStorageKey)
        }

        // 1. Check modern storageState file: <storageKey>.<device>.storageState.json
        for (const dir of candidateDirs) {
            for (const key of storageKeysToCheck) {
                const modernPath = path.resolve(dir, `${key}.${device}.storageState.json`)
                if (fs.existsSync(modernPath)) {
                    return { filePath: modernPath, matchedBy: 'modern-envelope' }
                }
            }
        }

        // 2. Check legacy format: <dir>/<email>/session_<device>.json
        for (const dir of candidateDirs) {
            const legacyCandidates = [
                path.resolve(dir, account.email, `session_${device}.json`),
                path.resolve(dir, normalizedEmail, `session_${device}.json`)
            ]
            for (const p of legacyCandidates) {
                if (fs.existsSync(p)) {
                    return { filePath: p, matchedBy: 'legacy-cookie-json' }
                }
            }
        }

        // 3. Fallback: inspect modern envelopes in candidate dirs to match internal accountId
        for (const dir of candidateDirs) {
            try {
                const files = fs.readdirSync(dir)
                for (const file of files) {
                    if (file.endsWith(`.${device}.storageState.json`)) {
                        const fullPath = path.resolve(dir, file)
                        try {
                            const raw = fs.readFileSync(fullPath, 'utf-8')
                            const parsed = JSON.parse(raw)
                            if (
                                parsed.accountId === primaryAccountId ||
                                parsed.accountId === emailHash ||
                                parsed.accountId === account.email ||
                                parsed.accountId === normalizedEmail
                            ) {
                                return { filePath: fullPath, matchedBy: 'modern-envelope-content' }
                            }
                        } catch {
                            // Ignore unparseable files
                        }
                    }
                }
            } catch {
                // Ignore readdir errors
            }
        }

        return null
    }

    /**
     * Parses raw session file contents (supports modern envelope, raw storageState, and legacy cookie array).
     */
    public static parseSessionContent(
        rawContent: string,
        targetDomains: string[] = TARGET_SESSION_DOMAINS
    ): {
        cookies: PlaywrightCookie[]
        crucialCookies: CrucialCookies
        cookieHeader: string
        source: 'modern-envelope' | 'raw-storage-state' | 'legacy-cookie-json'
        savedAt?: number
        accountId?: string
        device?: SessionDevice
    } {
        if (!rawContent || !rawContent.trim()) {
            return {
                cookies: [],
                crucialCookies: {},
                cookieHeader: '',
                source: 'legacy-cookie-json'
            }
        }

        let parsed: any
        try {
            parsed = JSON.parse(rawContent)
        } catch (err: any) {
            throw new Error(`Format file session cookie tidak valid: ${err.message}`)
        }

        let rawCookies: any[] = []
        let source: 'modern-envelope' | 'raw-storage-state' | 'legacy-cookie-json' = 'legacy-cookie-json'
        let savedAt: number | undefined
        let accountId: string | undefined
        let device: SessionDevice | undefined

        if (parsed && typeof parsed === 'object') {
            if (parsed.schemaVersion === 1 && parsed.storageState && Array.isArray(parsed.storageState.cookies)) {
                // Modern StoredSessionEnvelope
                source = 'modern-envelope'
                rawCookies = parsed.storageState.cookies
                savedAt = parsed.savedAt
                accountId = parsed.accountId
                device = parsed.device
            } else if (Array.isArray(parsed.cookies)) {
                // Raw Playwright storageState
                source = 'raw-storage-state'
                rawCookies = parsed.cookies
            } else if (Array.isArray(parsed)) {
                // Legacy cookie array
                source = 'legacy-cookie-json'
                rawCookies = parsed
            }
        }

        const validCookies: PlaywrightCookie[] = []
        const crucialCookies: CrucialCookies = {}
        const cookieMap = new Map<string, string>()

        for (const item of rawCookies) {
            if (!item || typeof item !== 'object' || !item.name || typeof item.value !== 'string') {
                continue
            }

            const name = item.name.trim()
            const value = item.value
            const domain = (item.domain || '').toLowerCase()

            const cookieObj: PlaywrightCookie = {
                name,
                value,
                domain: item.domain,
                path: item.path,
                expires: item.expires,
                httpOnly: item.httpOnly,
                secure: item.secure,
                sameSite: item.sameSite
            }
            validCookies.push(cookieObj)

            // Extract crucial cookies
            if (CRUCIAL_COOKIE_NAMES.includes(name) && value) {
                crucialCookies[name] = value
            }

            // Domain filter for Cookie header
            const matchesDomain = targetDomains.some(
                target => domain === target || domain.endsWith('.' + target) || domain.includes(target)
            )

            if (matchesDomain && value) {
                cookieMap.set(name, value)
            }
        }

        const pairs: string[] = []
        for (const [k, v] of cookieMap.entries()) {
            pairs.push(`${k}=${v}`)
        }

        return {
            cookies: validCookies,
            crucialCookies,
            cookieHeader: pairs.join('; '),
            source,
            savedAt,
            accountId,
            device
        }
    }

    /**
     * Resolves a session for an account and device, returning full ResolvedSession data.
     */
    public static resolveSession(
        account: AccountData | { email: string; id?: string; accountId?: string },
        device: SessionDevice = 'mobile',
        baseDir?: string
    ): ResolvedSession | null {
        const found = this.findSessionFilePath(account, device, baseDir)
        if (!found) {
            return null
        }

        return this.resolveSessionFromFile(found.filePath, account, device)
    }

    /**
     * Reads and parses a specific session file directly.
     */
    public static resolveSessionFromFile(
        filePath: string,
        account?: { email: string; id?: string; accountId?: string },
        device: SessionDevice = 'mobile'
    ): ResolvedSession {
        if (!fs.existsSync(filePath)) {
            throw new Error(`File sesi tidak ditemukan: ${filePath}`)
        }

        const rawContent = fs.readFileSync(filePath, 'utf-8')
        const parsed = this.parseSessionContent(rawContent)

        const accountId =
            parsed.accountId ||
            (account ? this.computeAccountId(account) : 'unknown')

        return {
            accountId,
            device: parsed.device || device,
            source: parsed.source,
            filePath,
            savedAt: parsed.savedAt,
            cookies: parsed.cookies,
            crucialCookies: parsed.crucialCookies,
            cookieHeader: parsed.cookieHeader
        }
    }

    /**
     * Injects all resolved cookies into an HttpClient instance, guaranteeing crucial cookies are set.
     */
    public static injectIntoHttpClient(client: HttpClient, session: ResolvedSession): void {
        // 1. Inject standard Cookie header for target domains
        if (session.cookieHeader) {
            client.setCookieHeaderString(session.cookieHeader)
        }

        // 2. Explicitly inject individual cookies into cookieStore
        for (const cookie of session.cookies) {
            if (cookie.name && cookie.value) {
                client.setCookie(cookie.name, cookie.value)
            }
        }

        // 3. Explicitly verify crucial cookies are preserved
        for (const [key, val] of Object.entries(session.crucialCookies)) {
            if (val) {
                client.setCookie(key, val)
            }
        }
    }
}
