import fs from 'fs'
import path from 'path'
import { URL, URLSearchParams } from 'url'
import { HttpClient } from '../core/HttpClient'
import { PlaywrightCookie } from '../types/AccountTypes'
import { OAuthTokenResponse } from '../types/DapiTypes'

export const OAUTH_CLIENT_ID = '0000000040170455'
export const OAUTH_SCOPE = 'service::prod.rewardsplatform.microsoft.com::MBI_SSL'
export const OAUTH_REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf'
export const OAUTH_AUTHORIZE_URL = 'https://login.live.com/oauth20_authorize.srf'
export const OAUTH_TOKEN_URL = 'https://login.live.com/oauth20_token.srf'

export class AuthService {
    private client: HttpClient
    private email: string
    private tokenData: OAuthTokenResponse | null = null
    private tokenExpiresAt: number = 0

    constructor(client: HttpClient, email: string) {
        this.client = client
        this.email = email
    }

    /**
     * Resolves session file for the given email from standard locations.
     */
    public static findSessionFilePath(email: string, baseDir: string = process.cwd()): string | null {
        const candidates = [
            path.join(baseDir, 'browser', 'sessions', email, 'session_mobile.json'),
            path.join(baseDir, 'browser', 'sessions', email.toLowerCase(), 'session_mobile.json'),
            path.join(baseDir, 'browser', 'sessions', email, 'session_desktop.json'),
            path.join(baseDir, 'browser', 'sessions', email.toLowerCase(), 'session_desktop.json'),
            path.join(baseDir, 'sessions', email, 'session_mobile.json'),
            path.join(baseDir, 'sessions', email.toLowerCase(), 'session_mobile.json')
        ]

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate
            }
        }
        return null
    }

    /**
     * Parses a Playwright session JSON file and converts cookies matching target domains
     * (live.com, microsoft.com) into a standard Cookie header string.
     */
    public static parsePlaywrightCookies(
        rawContent: string,
        targetDomains: string[] = ['live.com', 'microsoft.com']
    ): { cookieHeader: string; cookies: PlaywrightCookie[] } {
        if (!rawContent || !rawContent.trim()) {
            return { cookieHeader: '', cookies: [] }
        }

        let parsed: any
        try {
            parsed = JSON.parse(rawContent)
        } catch (err: any) {
            throw new Error(`Format file session cookie tidak valid: ${err.message}`)
        }

        if (!Array.isArray(parsed)) {
            return { cookieHeader: '', cookies: [] }
        }

        const cookieMap = new Map<string, string>()
        const validCookies: PlaywrightCookie[] = []

        for (const item of parsed) {
            if (!item || typeof item !== 'object' || !item.name || typeof item.value !== 'string') {
                continue
            }

            const domain = (item.domain || '').toLowerCase()
            const matchesDomain = targetDomains.some(
                target => domain === target || domain.endsWith('.' + target) || domain.includes(target)
            )

            if (matchesDomain) {
                cookieMap.set(item.name, item.value)
                validCookies.push({
                    name: item.name,
                    value: item.value,
                    domain: item.domain,
                    path: item.path,
                    expires: item.expires,
                    httpOnly: item.httpOnly,
                    secure: item.secure,
                    sameSite: item.sameSite
                })
            }
        }

        const pairs: string[] = []
        for (const [k, v] of cookieMap.entries()) {
            pairs.push(`${k}=${v}`)
        }

        return {
            cookieHeader: pairs.join('; '),
            cookies: validCookies
        }
    }

    /**
     * Injects cookies from the user's session file into the HttpClient instance.
     */
    public loadSessionCookies(sessionFilePath?: string): boolean {
        const targetPath = sessionFilePath || AuthService.findSessionFilePath(this.email)
        if (!targetPath || !fs.existsSync(targetPath)) {
            return false
        }

        const raw = fs.readFileSync(targetPath, 'utf-8')
        const { cookieHeader } = AuthService.parsePlaywrightCookies(raw)
        if (cookieHeader) {
            this.client.setCookieHeaderString(cookieHeader)
            return true
        }
        return false
    }

    /**
     * Executes passive 302 OAuth exchange to obtain authorization code,
     * then trades the code for an access token.
     * Uses maxRedirects: 0 to capture Location header from the 302 response.
     */
    public async authenticate(customCookieHeader?: string): Promise<string> {
        if (this.tokenData && Date.now() < this.tokenExpiresAt - 60000) {
            return this.tokenData.access_token
        }

        // If refresh token exists and access token is expired, attempt refresh
        if (this.tokenData?.refresh_token) {
            try {
                const refreshed = await this.refreshToken(this.tokenData.refresh_token)
                return refreshed
            } catch {
                // Refresh failed, fall back to full OAuth flow
            }
        }

        if (customCookieHeader) {
            this.client.setCookieHeaderString(customCookieHeader)
        } else {
            this.loadSessionCookies()
        }

        const authParams = new URLSearchParams({
            client_id: OAUTH_CLIENT_ID,
            scope: OAUTH_SCOPE,
            response_type: 'code',
            redirect_uri: OAUTH_REDIRECT_URI
        })

        const authUrl = `${OAUTH_AUTHORIZE_URL}?${authParams.toString()}`

        // Step 1: GET authorization endpoint with maxRedirects: 0 to capture 302 Location
        let response
        try {
            response = await this.client.get(authUrl, {
                maxRedirects: 0,
                validateStatus: (status: number) => status >= 200 && status < 400
            })
        } catch (err: any) {
            if (err.response?.status === 403) {
                throw new Error(
                    '[ACCOUNT_FLAGGED_OR_SUSPENDED] Otentikasi OAuth akses ditolak (HTTP 403): Akun dibatasi oleh sistem Microsoft'
                )
            }
            throw err
        }

        const location = response.headers?.location || response.headers?.Location
        if (!location) {
            throw new Error(
                `Otentikasi gagal: Server tidak mengembalikan header Location (status ${response.status}). Sesi login mungkin sudah kedaluwarsa.`
            )
        }

        // Step 2: Extract code parameter from redirect location
        let redirectUrl: URL
        try {
            redirectUrl = new URL(location, 'https://login.live.com')
        } catch (err: any) {
            throw new Error(`Location redirect tidak valid: ${err.message}`)
        }

        const errorCode = redirectUrl.searchParams.get('error')
        if (errorCode) {
            const errorDesc = redirectUrl.searchParams.get('error_description') || errorCode
            if (
                errorCode === 'access_denied' ||
                errorCode.includes('suspended') ||
                errorDesc.toLowerCase().includes('suspended') ||
                errorDesc.toLowerCase().includes('blocked')
            ) {
                throw new Error(`[ACCOUNT_FLAGGED_OR_SUSPENDED] Otentikasi OAuth ditolak: ${errorDesc}`)
            }
            throw new Error(`Otentikasi OAuth ditolak oleh server: ${errorDesc}`)
        }

        const authCode = redirectUrl.searchParams.get('code')
        if (!authCode) {
            throw new Error(
                'Otentikasi gagal: Authorization code tidak ditemukan pada URL redirect. Perbarui session cookies.'
            )
        }

        // Step 3: Exchange authorization code for access token
        return this.exchangeCodeForToken(authCode)
    }

    /**
     * Exchanges authorization code for an OAuth access token via POST.
     */
    public async exchangeCodeForToken(code: string): Promise<string> {
        const bodyParams = new URLSearchParams({
            client_id: OAUTH_CLIENT_ID,
            redirect_uri: OAUTH_REDIRECT_URI,
            grant_type: 'authorization_code',
            code
        })

        try {
            const response = await this.client.post<OAuthTokenResponse>(
                OAUTH_TOKEN_URL,
                bodyParams.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            )

            const data = response.data
            if (!data || !data.access_token) {
                throw new Error('Respon token endpoint tidak berisi access_token yang valid')
            }

            this.tokenData = data
            const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600
            this.tokenExpiresAt = Date.now() + expiresInSec * 1000

            return data.access_token
        } catch (err: any) {
            if (err.response?.status === 403) {
                throw new Error(
                    '[ACCOUNT_FLAGGED_OR_SUSPENDED] Token exchange ditolak (HTTP 403): Akun dibatasi oleh sistem Microsoft'
                )
            }
            throw err
        }
    }

    /**
     * Refreshes access token using a refresh token.
     */
    public async refreshToken(refreshToken: string): Promise<string> {
        const bodyParams = new URLSearchParams({
            client_id: OAUTH_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        })

        try {
            const response = await this.client.post<OAuthTokenResponse>(
                OAUTH_TOKEN_URL,
                bodyParams.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            )

            const data = response.data
            if (!data || !data.access_token) {
                throw new Error('Gagal memperbarui access token dari refresh_token')
            }

            this.tokenData = data
            const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600
            this.tokenExpiresAt = Date.now() + expiresInSec * 1000

            return data.access_token
        } catch (err: any) {
            if (err.response?.status === 403) {
                throw new Error(
                    '[ACCOUNT_FLAGGED_OR_SUSPENDED] Token refresh ditolak (HTTP 403): Akun dibatasi oleh sistem Microsoft'
                )
            }
            throw err
        }
    }

    public getAccessToken(): string | null {
        if (this.tokenData && Date.now() < this.tokenExpiresAt - 60000) {
            return this.tokenData.access_token
        }
        return null
    }

    public getBearerHeader(): string {
        const token = this.getAccessToken()
        if (!token) {
            throw new Error('Access token belum tersedia atau telah kedaluwarsa')
        }
        return `Bearer ${token}`
    }

    public dispose(): void {
        this.tokenData = null
        this.tokenExpiresAt = 0
    }
}
