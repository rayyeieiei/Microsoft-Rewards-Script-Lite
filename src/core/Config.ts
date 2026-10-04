import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { AccountData, LiteRuntimeConfig } from '../types/AccountTypes'

export const LiteConfigSchema = z
    .object({
        country: z.string().default('ID'),
        requestTimeoutMs: z.number().int().positive().max(7000).default(7000),
        minReadDelayMs: z.number().int().min(1000).default(5000),
        maxReadDelayMs: z.number().int().min(1000).default(9000),
        maxArticles: z.number().int().min(1).max(50).default(10),
        warmupMode: z.boolean().default(false),
        warmupDay: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
        enableCheckIn: z.boolean().default(true),
        enableReadToEarn: z.boolean().default(true),
        searchQueriesLimit: z.number().int().min(1).max(100).default(30)
    })
    .refine(data => data.minReadDelayMs <= data.maxReadDelayMs, {
        message: 'minReadDelayMs cannot exceed maxReadDelayMs'
    })

export function getDefaultConfig(
    overrides?: Partial<LiteRuntimeConfig>,
    baseDir: string = process.cwd()
): LiteRuntimeConfig {
    const configPath = path.resolve(baseDir, 'config.json')
    let fileConfig: any = {}
    if (fs.existsSync(configPath)) {
        try {
            const raw = fs.readFileSync(configPath, 'utf-8')
            const parsed = JSON.parse(raw)
            if (parsed && typeof parsed === 'object') {
                if (typeof parsed.country === 'string') fileConfig.country = parsed.country
                if (typeof parsed.requestTimeoutMs === 'number') fileConfig.requestTimeoutMs = parsed.requestTimeoutMs
                if (typeof parsed.minReadDelayMs === 'number') fileConfig.minReadDelayMs = parsed.minReadDelayMs
                if (typeof parsed.maxReadDelayMs === 'number') fileConfig.maxReadDelayMs = parsed.maxReadDelayMs
                if (typeof parsed.maxArticles === 'number') fileConfig.maxArticles = parsed.maxArticles
                if (typeof parsed.warmupMode === 'boolean') fileConfig.warmupMode = parsed.warmupMode
                if (typeof parsed.warmupDay === 'number' && [1, 2, 3].includes(parsed.warmupDay)) fileConfig.warmupDay = parsed.warmupDay
                if (typeof parsed.enableCheckIn === 'boolean') fileConfig.enableCheckIn = parsed.enableCheckIn
                if (typeof parsed.enableReadToEarn === 'boolean') fileConfig.enableReadToEarn = parsed.enableReadToEarn
                if (typeof parsed.searchQueriesLimit === 'number') fileConfig.searchQueriesLimit = parsed.searchQueriesLimit
            }
        } catch {
            // Ignore parse errors, fallback to defaults
        }
    }
    return LiteConfigSchema.parse({ ...fileConfig, ...(overrides || {}) })
}

export function resolveAccountsFilePath(isDev: boolean, baseDir: string = process.cwd()): string {
    const filename = isDev ? 'accounts.dev.json' : 'accounts.json'
    return path.resolve(baseDir, filename)
}

export function loadLiteAccounts(isDev: boolean, baseDir: string = process.cwd()): AccountData[] {
    const filePath = resolveAccountsFilePath(isDev, baseDir)
    if (!fs.existsSync(filePath)) {
        throw new Error(`File sumber akun tidak ditemukan: ${path.basename(filePath)} (${filePath})`)
    }

    const raw = fs.readFileSync(filePath, 'utf-8').trim()
    if (!raw) {
        throw new Error(`File akun kosong: ${path.basename(filePath)}`)
    }

    let parsed: any
    try {
        parsed = JSON.parse(raw)
    } catch (err: any) {
        throw new Error(`Format JSON akun tidak valid (${path.basename(filePath)}): ${err.message}`)
    }

    if (!Array.isArray(parsed)) {
        throw new Error(`File akun harus berupa array JSON (${path.basename(filePath)})`)
    }

    const validAccounts: AccountData[] = []
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue
        const email = typeof item.email === 'string' ? item.email.trim() : ''
        if (!email) continue

        const validProxy =
            item.proxy &&
            typeof item.proxy === 'object' &&
            (Boolean(item.proxy.url) || Boolean(item.proxy.host))
                ? item.proxy
                : undefined

        validAccounts.push({
            email,
            password: typeof item.password === 'string' ? item.password : undefined,
            proxy: validProxy,
            id: item.id || item.accountId || undefined,
            accountId: item.accountId || item.id || undefined,
            displayLabel: item.displayLabel || undefined
        })
    }

    return validAccounts
}
