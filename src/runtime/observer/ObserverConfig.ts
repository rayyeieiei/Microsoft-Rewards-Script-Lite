import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import {
    LiteDashboardConfigSchema,
    ObservationBridgeImportConfigSchema
} from '../../util/Validator'

export const ObserverConfigSchema = z
    .object({
        contractVersion: z.literal(1),
        identitiesPath: z.string().min(1).default('identities.json'),
        storageDirectory: z.string().min(1).default('data'),
        sessionBasePath: z.string().optional(),
        dashboard: LiteDashboardConfigSchema.default({
            enabled: true,
            host: '127.0.0.1',
            port: 4100,
            maxSseClients: 10,
            sseHeartbeatMs: 15000
        }),
        observationBridge: ObservationBridgeImportConfigSchema.optional(),
        staleEvidenceThresholdHours: z.number().int().min(1).max(720).default(48),
        shutdownTimeoutMs: z.number().int().min(1000).max(60000).default(10000)
    })
    .strict()

export type ObserverConfig = z.infer<typeof ObserverConfigSchema>

export const ObserverIdentitySchema = z
    .object({
        accountId: z.string().uuid(),
        displayLabel: z.string().min(1).max(100)
    })
    .strict()

export type ObserverIdentity = z.infer<typeof ObserverIdentitySchema>

export function validateObserverIdentities(data: unknown): ObserverIdentity[] {
    if (!Array.isArray(data)) {
        throw new Error('[CONFIG] Identities data must be an array')
    }

    const identities = z.array(ObserverIdentitySchema).parse(data)
    const seen = new Set<string>()

    for (const identity of identities) {
        if (seen.has(identity.accountId)) {
            throw new Error(`[CONFIG] Duplicate accountId detected in identities.json: ${identity.accountId}`)
        }
        seen.add(identity.accountId)
    }

    return identities
}

export function loadObserverConfig(customPath?: string): ObserverConfig {
    const configPath = customPath
        ? path.resolve(customPath)
        : path.join(process.cwd(), 'config.observer.json')

    if (!fs.existsSync(configPath)) {
        throw new Error(
            `[CONFIG] Missing configuration file: ${configPath}. Please create it from config.observer.example.json.`
        )
    }

    const raw = fs.readFileSync(configPath, 'utf-8')
    const lower = raw.toLowerCase()
    if (
        lower.includes('"accesstoken"') ||
        lower.includes('"refreshtoken"') ||
        lower.includes('"cookie"') ||
        lower.includes('"password"')
    ) {
        throw new Error('[SECURITY] Observer configuration cannot contain credentials, tokens, or cookies')
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (err: any) {
        throw new Error(`[CONFIG] Malformed JSON in ${configPath}: ${err.message}`)
    }

    return ObserverConfigSchema.parse(parsed)
}

export function loadObserverIdentities(customPath?: string): ObserverIdentity[] {
    const identitiesPath = customPath
        ? path.resolve(customPath)
        : path.join(process.cwd(), 'identities.json')

    if (!fs.existsSync(identitiesPath)) {
        return []
    }

    const raw = fs.readFileSync(identitiesPath, 'utf-8')
    const lower = raw.toLowerCase()
    if (
        lower.includes('"password"') ||
        lower.includes('"totpsecret"') ||
        lower.includes('"accesstoken"') ||
        lower.includes('"cookie"')
    ) {
        throw new Error('[SECURITY] Identities file cannot contain passwords, secrets, or tokens')
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (err: any) {
        throw new Error(`[CONFIG] Malformed JSON in ${identitiesPath}: ${err.message}`)
    }

    return validateObserverIdentities(parsed)
}
