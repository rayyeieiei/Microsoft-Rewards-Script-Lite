import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { LiteDashboardConfigSchema, ObservationBridgeImportConfigSchema } from '../../util/Validator'
import { AccountLoader, AccountLoadResult, ObserverIdentity } from './AccountLoader'

export { ObserverIdentity, AccountLoader, AccountLoadResult }

export const ObserverConfigSchema = z
    .object({
        contractVersion: z.literal(1),
        accountsPath: z.string().min(1).optional(),
        identitiesPath: z.string().min(1).optional(),
        environmentMode: z.enum(['normal', 'development']).optional(),
        storageDirectory: z.string().min(1).default('data'),
        sessionBasePath: z.string().optional(),
        configDir: z.string().optional(),
        dashboard: LiteDashboardConfigSchema.default({
            enabled: true,
            host: '127.0.0.1',
            port: 4100,
            maxSseClients: 10,
            sseHeartbeatMs: 15000
        }),
        observationBridge: ObservationBridgeImportConfigSchema.optional(),
        bridgeReferenceKeyPath: z.string().min(1).optional(),
        staleEvidenceThresholdHours: z.number().int().min(1).max(720).default(48),
        shutdownTimeoutMs: z.number().int().min(1000).max(60000).default(10000),
        checkIntervalMs: z.number().int().min(1000).max(86400000).optional(),
        checkTimeoutMs: z.number().int().min(1000).max(60000).optional()
    })
    .strict()

export type ObserverConfig = z.infer<typeof ObserverConfigSchema>

export interface ObserverSourceSelection {
    environmentMode: 'normal' | 'development'
    sourceFile: string
    sourcePath: string
}

export function resolveObserverSourceSelection(
    config: Partial<ObserverConfig>,
    configDir = process.cwd(),
    cliArgs: string[] = process.argv
): ObserverSourceSelection {
    // 1. Determine environment mode
    const hasDevFlag = cliArgs.includes('-dev') || cliArgs.includes('--dev')
    let environmentMode: 'normal' | 'development' = 'normal'

    if (hasDevFlag) {
        environmentMode = 'development'
    } else if (config.environmentMode === 'development') {
        environmentMode = 'development'
    } else {
        environmentMode = 'normal'
    }

    // 2. Check for explicit CLI account path args: --accounts <path> or -a <path>
    let explicitPath: string | undefined
    for (let i = 0; i < cliArgs.length; i++) {
        if ((cliArgs[i] === '--accounts' || cliArgs[i] === '-a') && cliArgs[i + 1]) {
            explicitPath = cliArgs[i + 1]
            break
        }
    }

    // 3. Determine selected path according to documented priority:
    // CLI explicit path > config.accountsPath > config.identitiesPath (if explicitly set and not 'identities.json' default) > default per mode
    let chosenRelativeOrAbsPath: string

    if (explicitPath) {
        chosenRelativeOrAbsPath = explicitPath
    } else if (config.accountsPath) {
        chosenRelativeOrAbsPath = config.accountsPath
    } else if (config.identitiesPath && config.identitiesPath !== 'identities.json') {
        chosenRelativeOrAbsPath = config.identitiesPath
    } else if (
        config.identitiesPath === 'identities.json' &&
        fs.existsSync(path.resolve(configDir, 'identities.json')) &&
        !fs.existsSync(
            path.resolve(configDir, environmentMode === 'development' ? 'accounts.dev.json' : 'accounts.json')
        )
    ) {
        chosenRelativeOrAbsPath = 'identities.json'
    } else {
        chosenRelativeOrAbsPath = environmentMode === 'development' ? 'accounts.dev.json' : 'accounts.json'
    }

    const sourcePath = path.isAbsolute(chosenRelativeOrAbsPath)
        ? path.resolve(chosenRelativeOrAbsPath)
        : path.resolve(configDir, chosenRelativeOrAbsPath)

    return {
        environmentMode,
        sourceFile: path.basename(sourcePath),
        sourcePath
    }
}

export const ObserverIdentitySchema = z
    .object({
        accountId: z.string().uuid(),
        displayLabel: z.string().min(1).max(100)
    })
    .strict()

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
    const configPath = customPath ? path.resolve(customPath) : path.join(process.cwd(), 'config.observer.json')

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

    const config = ObserverConfigSchema.parse(parsed)
    config.configDir = path.dirname(configPath)
    return config
}

export function loadObserverIdentities(customPath?: string, configDir = process.cwd()): ObserverIdentity[] {
    const result = AccountLoader.load(configDir, customPath || 'identities.json')
    if (result.status === 'failed') {
        if (result.error?.code === 'security-violation') {
            throw new Error('[SECURITY] Identities file cannot contain passwords, secrets, or tokens')
        }
        if (result.error?.code === 'malformed-json') {
            throw new Error(`[CONFIG] Malformed JSON in ${result.sourceFile}: ${result.error.message}`)
        }
        if (result.error?.code === 'invalid-schema') {
            throw new Error(`[CONFIG] ${result.error.message}`)
        }
        return []
    }
    return result.identities
}
