import type { Cookie } from 'patchright'
import type { BrowserFingerprintWithHeaders } from 'fingerprint-generator'
import fs from 'fs';
import path from 'path';

import type { Account, ConfigSaveFingerprint } from '../interface/Account'
import type { Config } from '../interface/Config'
import { validateAccounts, validateConfig } from './Validator'

let configCache: Config
const rateLimitCooldowns = new Map<string, number>() // Penyimpanan cooldown sementara

export function setRateLimitCooldown(sessionPath: string, durationMs: number) {
    rateLimitCooldowns.set(sessionPath, Date.now() + durationMs)
}

export function getRateLimitCooldown(sessionPath: string): number {
    const expiry = rateLimitCooldowns.get(sessionPath) || 0
    return Math.max(0, expiry - Date.now())
}

export function loadAccounts(): Account[] {
    try {
        let file = process.argv.includes('-dev') ? 'accounts.dev.json' : 'accounts.json'
        // Gunakan process.cwd() biar fix nyari di folder terluar
        const accountDir = path.join(process.cwd(), file)
        const accountsData = JSON.parse(fs.readFileSync(accountDir, 'utf-8'))
        validateAccounts(accountsData)
        return accountsData
    } catch (error) { throw new Error(error as string) }
}

export function loadConfig(): Config {
    try {
        if (configCache) return configCache
        // Gunakan process.cwd() biar fix nyari di folder terluar
        const configDir = path.join(process.cwd(), 'config.json')
        const configData = JSON.parse(fs.readFileSync(configDir, 'utf-8'))
        validateConfig(configData)
        configCache = configData
        return configData
    } catch (error) { throw new Error(error as string) }
}

export async function loadSessionData(sessionPath: string, email: string, saveFingerprint: ConfigSaveFingerprint, isMobile: boolean) {
    try {
        const cookiesFileName = isMobile ? 'session_mobile.json' : 'session_desktop.json'
        // Arahin penyimpanan sesi browser ke root project
        const cookieFile = path.join(process.cwd(), 'browser', sessionPath, email, cookiesFileName)
        let cookies: Cookie[] = []
        if (fs.existsSync(cookieFile)) {
            cookies = JSON.parse(await fs.promises.readFile(cookieFile, 'utf-8'))
        }
        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'
        const fingerprintFile = path.join(process.cwd(), 'browser', sessionPath, email, fingerprintFileName)
        let fingerprint!: BrowserFingerprintWithHeaders
        const shouldLoadFingerprint = isMobile ? saveFingerprint.mobile : saveFingerprint.desktop
        if (shouldLoadFingerprint && fs.existsSync(fingerprintFile)) {
            fingerprint = JSON.parse(await fs.promises.readFile(fingerprintFile, 'utf-8'))
        }
        return { cookies, fingerprint }
    } catch (error) { throw new Error(error as string) }
}

export async function saveSessionData(sessionPath: string, cookies: Cookie[], email: string, isMobile: boolean): Promise<string> {
    try {
        const sessionDir = path.join(process.cwd(), 'browser', sessionPath, email)
        const cookiesFileName = isMobile ? 'session_mobile.json' : 'session_desktop.json'
        if (!fs.existsSync(sessionDir)) await fs.promises.mkdir(sessionDir, { recursive: true })
        await fs.promises.writeFile(path.join(sessionDir, cookiesFileName), JSON.stringify(cookies))
        return sessionDir
    } catch (error) { throw new Error(error as string) }
}

export async function saveFingerprintData(sessionPath: string, email: string, isMobile: boolean, fingerpint: BrowserFingerprintWithHeaders): Promise<string> {
    try {
        const sessionDir = path.join(process.cwd(), 'browser', sessionPath, email)
        const fingerprintFileName = isMobile ? 'session_fingerprint_mobile.json' : 'session_fingerprint_desktop.json'
        if (!fs.existsSync(sessionDir)) await fs.promises.mkdir(sessionDir, { recursive: true })
        await fs.promises.writeFile(path.join(sessionDir, fingerprintFileName), JSON.stringify(fingerpint))
        return sessionDir
    } catch (error) { throw new Error(error as string) }
}