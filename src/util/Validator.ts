import { z } from 'zod'
import semver from 'semver'
import pkg from '../../package.json'

const NumberOrString = z.union([z.number(), z.string()])

const LogFilterSchema = z.object({
    enabled: z.boolean(),
    mode: z.enum(['whitelist', 'blacklist']),
    levels: z.array(z.enum(['debug', 'info', 'warn', 'error'])).optional(),
    keywords: z.array(z.string()).optional(),
    regexPatterns: z.array(z.string()).optional()
})

const DelaySchema = z.object({
    min: NumberOrString,
    max: NumberOrString
})

const QueryEngineSchema = z.enum(['google', 'wikipedia', 'reddit', 'local'])

// Webhook
const WebhookSchema = z.object({
    discord: z
        .object({
            enabled: z.boolean(),
            url: z.string()
        })
        .optional(),
    ntfy: z
        .object({
            enabled: z.boolean().optional(),
            url: z.string(),
            topic: z.string().optional(),
            token: z.string().optional(),
            title: z.string().optional(),
            tags: z.array(z.string()).optional(),
            priority: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional()
        })
        .optional(),
    webhookLogFilter: LogFilterSchema
})

export const LiteDashboardConfigSchema = z
    .object({
        enabled: z.boolean(),
        host: z.literal('127.0.0.1'),
        port: z.number().int().min(1024).max(65535),
        maxSseClients: z.number().int().min(1).max(25),
        sseHeartbeatMs: z.number().int().min(5000).max(60000)
    })
    .strict()

// Config
export const ConfigSchema = z.object({
    baseURL: z.string(),
    sessionPath: z.string(),
    headless: z.boolean(),
    clusters: z.number().int().nonnegative(),
    errorDiagnostics: z.boolean(),
    workers: z.object({
        doDailySet: z.boolean(),
        doSpecialPromotions: z.boolean(),
        doMorePromotions: z.boolean(),
        doPunchCards: z.boolean(),
        doAppPromotions: z.boolean(),
        doDesktopSearch: z.boolean(),
        doMobileSearch: z.boolean(),
        doDailyCheckIn: z.boolean(),
        doReadToEarn: z.boolean()
    }),
    loginRateLimit: z
        .object({
            delay: NumberOrString,
            maxAttempts: z.number().int().positive()
        })
        .optional(),
    searchOnBingLocalQueries: z.boolean(),
    globalTimeout: NumberOrString,
    searchSettings: z.object({
        scrollRandomResults: z.boolean(),
        clickRandomResults: z.boolean(),
        parallelSearching: z.boolean(),
        queryEngines: z.array(QueryEngineSchema),
        searchResultVisitTime: NumberOrString,
        searchDelay: DelaySchema,
        readDelay: DelaySchema
    }),
    debugLogs: z.boolean(),
    proxy: z.object({ queryEngine: z.boolean() }),
    consoleLogFilter: LogFilterSchema,
    webhook: WebhookSchema,
    dashboard: LiteDashboardConfigSchema.optional()
})

import path from 'path'
import { URL } from 'url'
import { Config, LiteRuntimeConfig } from '../interface/Config'
import { Account } from '../interface/Account'

// Account
export const AccountSchema = z.object({
    id: z.string().uuid().optional(),
    email: z.string(),
    password: z.string(),
    totpSecret: z.string().optional(),
    recoveryEmail: z.string(),
    geoLocale: z.string(),
    langCode: z.string(),
    proxy: z.object({
        proxyAxios: z.boolean(),
        url: z.string(),
        port: z.number(),
        password: z.string(),
        username: z.string()
    }),
    saveFingerprint: z.object({
        mobile: z.boolean(),
        desktop: z.boolean()
    })
})

export const LiteRuntimeConfigSchema = z
    .object({
        contractVersion: z.literal(1),
        requestTimeoutMs: z.number().positive(),
        accountBudgetMs: z.number().positive(),
        maxReadRetries: z.number().nonnegative(),
        handoffDirectory: z.string().min(1),
        allowedApiOrigins: z.array(z.string()).min(1),
        observerOnly: z.literal(true),
        dashboard: LiteDashboardConfigSchema.optional()
    })
    .strict()

export function validateLiteRuntimeConfig(data: unknown): LiteRuntimeConfig {
    if (!data || typeof data !== 'object') {
        throw new Error('Config must be a non-null object')
    }

    // Check for raw forbidden token/cookie keys in config
    const str = JSON.stringify(data).toLowerCase()
    if (str.includes('"accesstoken"') || str.includes('"refreshtoken"') || str.includes('"cookie"')) {
        throw new Error('[SECURITY] JSON config cannot contain raw tokens or cookies')
    }

    const parsed = LiteRuntimeConfigSchema.parse(data)

    // Validate origins
    for (const origin of parsed.allowedApiOrigins) {
        let u: URL
        try {
            u = new URL(origin)
        } catch {
            throw new Error(`[CONFIG] Invalid origin format: ${origin}`)
        }
        if (u.username || u.password) {
            throw new Error(`[CONFIG] Origin ${origin} must not contain embedded credentials`)
        }
    }

    const resolvedHandoffDir = path.resolve(parsed.handoffDirectory)

    return {
        ...parsed,
        handoffDirectory: resolvedHandoffDir
    }
}

export function validateUniqueAccountIdentities(accounts: Array<{ id?: string; email: string }>): void {
    const seenIds = new Set<string>()
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

    for (const acc of accounts) {
        if (!acc.id) {
            throw new Error(`[IDENTITY] Account missing required explicit UUID id: ${acc.email}`)
        }
        if (!uuidRegex.test(acc.id)) {
            throw new Error(`[IDENTITY] Account id must be an explicit valid UUID: ${acc.id}`)
        }
        if (seenIds.has(acc.id)) {
            throw new Error(`[IDENTITY] Duplicate accountId detected: ${acc.id}`)
        }
        seenIds.add(acc.id)
    }
}

export function validateConfig(data: unknown): Config {
    return ConfigSchema.parse(data) as Config
}

export function validateAccounts(data: unknown): Account[] {
    return z.array(AccountSchema).parse(data)
}

export function checkNodeVersion(): void {
    try {
        const requiredVersion = pkg.engines?.node

        if (!requiredVersion) {
            console.warn('No Node.js version requirement found in package.json "engines" field.')
            return
        }

        if (!semver.satisfies(process.version, requiredVersion)) {
            console.error(`Current Node.js version ${process.version} does not satisfy requirement: ${requiredVersion}`)
            process.exit(1)
        }
    } catch (error) {
        console.error('Failed to validate Node.js version:', error)
        process.exit(1)
    }
}
