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
        maxArticles: z.number().int().min(1).max(50).default(10)
    })
    .refine(data => data.minReadDelayMs <= data.maxReadDelayMs, {
        message: 'minReadDelayMs cannot exceed maxReadDelayMs'
    })

export function getDefaultConfig(overrides?: Partial<LiteRuntimeConfig>): LiteRuntimeConfig {
    return LiteConfigSchema.parse(overrides || {})
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
