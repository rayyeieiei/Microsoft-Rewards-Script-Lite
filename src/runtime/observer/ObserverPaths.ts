import path from 'path'

export class ObserverPaths {
    public static resolveStorageDir(baseDir = 'data'): string {
        return path.resolve(process.cwd(), baseDir)
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

    public static resolveBridgeDir(bridgeDir = 'bridge'): string {
        return path.resolve(process.cwd(), bridgeDir)
    }

    public static resolveSessionBasePath(sessionPath = 'sessions'): string {
        // Aligns with Load.ts: browser/<sessionPath>
        return path.resolve(process.cwd(), 'browser', sessionPath)
    }

    public static assertWithinDirectory(parentDir: string, targetPath: string): void {
        const resolvedParent = path.resolve(parentDir)
        const resolvedTarget = path.resolve(targetPath)
        const relative = path.relative(resolvedParent, resolvedTarget)

        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new Error(`[SECURITY] Path traversal detected: ${targetPath} is outside ${parentDir}`)
        }
    }
}
