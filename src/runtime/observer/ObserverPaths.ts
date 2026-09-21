import fs from 'fs'
import path from 'path'

export class ObserverPaths {
    public static resolveStorageDir(baseDir = 'data', configDir = process.cwd()): string {
        if (path.isAbsolute(baseDir)) return path.resolve(baseDir)
        return path.resolve(configDir, baseDir)
    }

    public static resolveLockPath(storageDir: string): string {
        return path.join(path.resolve(storageDir), 'observer.lock')
    }

    public static resolveManualActionStorePath(storageDir: string): string {
        return path.join(path.resolve(storageDir), 'manual_actions.json')
    }

    public static resolveAccountEvidenceStorePath(storageDir: string): string {
        return path.join(path.resolve(storageDir), 'account_evidence.json')
    }

    public static resolveBridgeDir(bridgeDir = 'bridge', configDir = process.cwd()): string {
        if (path.isAbsolute(bridgeDir)) return path.resolve(bridgeDir)
        return path.resolve(configDir, bridgeDir)
    }

    public static resolveBridgeReferenceKeyPath(keyPath?: string, configDir = process.cwd()): string | null {
        if (!keyPath) return null
        if (path.isAbsolute(keyPath)) return path.resolve(keyPath)
        return path.resolve(configDir, keyPath)
    }

    public static loadBridgeReferenceKey(keyPath?: string, configDir = process.cwd()): Buffer | null {
        const resolved = ObserverPaths.resolveBridgeReferenceKeyPath(keyPath, configDir)
        if (!resolved) return null

        if (!fs.existsSync(resolved)) {
            throw new Error(`[CONFIG-SECURITY] Configured bridgeReferenceKeyPath file does not exist: ${resolved}`)
        }

        const stat = fs.statSync(resolved)
        if (stat.isDirectory()) {
            throw new Error(`[CONFIG-SECURITY] bridgeReferenceKeyPath is a directory, expected a file: ${resolved}`)
        }

        const raw = fs.readFileSync(resolved)
        const trimmedStr = raw.toString('utf8').trim()
        let keyBuffer: Buffer
        if (/^[0-9a-fA-F]{64}$/.test(trimmedStr)) {
            keyBuffer = Buffer.from(trimmedStr, 'hex')
        } else if (raw.length === 32) {
            keyBuffer = raw
        } else {
            keyBuffer = Buffer.from(trimmedStr, 'utf8')
        }

        if (keyBuffer.length < 32) {
            throw new Error(
                `[CONFIG-SECURITY] bridge reference key is too short (${keyBuffer.length} bytes, minimum 32 bytes required): ${resolved}`
            )
        }

        return keyBuffer
    }

    public static resolveSessionBasePath(sessionPath = 'sessions', configDir = process.cwd()): string {
        if (path.isAbsolute(sessionPath)) return path.resolve(sessionPath)
        return path.resolve(configDir, 'browser', sessionPath)
    }

    public static assertWithinDirectory(parentDir: string, targetPath: string): void {
        const resolvedParent = path.resolve(parentDir)
        const resolvedTarget = path.resolve(targetPath)
        const relative = path.relative(resolvedParent, resolvedTarget)

        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`[SECURITY] Path traversal detected: ${targetPath} is outside ${parentDir}`)
        }
    }

    public static resolveAccountSessionDir(sessionBasePath: string, lookupKey: string): string | null {
        if (!lookupKey || typeof lookupKey !== 'string') return null
        const trimmed = lookupKey.trim()
        if (!trimmed || trimmed.includes('..') || path.isAbsolute(trimmed)) return null
        const resolvedBase = path.resolve(sessionBasePath)
        const targetDir = path.resolve(resolvedBase, trimmed)
        const relative = path.relative(resolvedBase, targetDir)
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return null
        }
        return targetDir
    }
}
