export interface AccountProxyConfig {
    host: string
    port: number
    username?: string
    password?: string
    protocol?: 'http' | 'https' | 'socks' | 'socks5'
    url?: string
}

export interface AccountData {
    email: string
    password?: string
    proxy?: AccountProxyConfig
    id?: string
    accountId?: string
    displayLabel?: string
    [key: string]: any
}

export interface PlaywrightCookie {
    name: string
    value: string
    domain: string
    path?: string
    expires?: number
    httpOnly?: boolean
    secure?: boolean
    sameSite?: 'Strict' | 'Lax' | 'None'
}

export interface LiteRuntimeConfig {
    country: string
    requestTimeoutMs: number
    minReadDelayMs: number
    maxReadDelayMs: number
    maxArticles: number
}

export interface ActivitySummary {
    checkInAvailable: boolean
    checkInClaimed: boolean
    readToEarnRemaining: number
    articlesRead: number
}

export interface AccountExecutionResult {
    accountId: string
    emailMasked: string
    success: boolean
    initialBalance: number
    finalBalance: number
    pointsEarned: number
    checkInClaimed: boolean
    articlesRead: number
    errorMessage?: string
    durationMs: number
}
