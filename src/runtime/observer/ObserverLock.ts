import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { ObserverPaths } from './ObserverPaths'

export interface ObserverLockMetadata {
    instanceId: string
    pid: number
    hostname: string
    startedAt: string
    storageDirectory: string
}

export class ObserverLock {
    private readonly storageDirectory: string
    private readonly lockPath: string
    private readonly instanceId: string
    private isHeld = false

    constructor(storageDirectory: string, instanceId?: string) {
        this.storageDirectory = path.resolve(storageDirectory)
        this.lockPath = ObserverPaths.resolveLockPath(this.storageDirectory)
        this.instanceId = instanceId || crypto.randomUUID()
    }

    public getInstanceId(): string {
        return this.instanceId
    }

    public isLockHeld(): boolean {
        return this.isHeld
    }

    /**
     * Acquires exclusive file-based lock with fail-fast semantics.
     * Never automatically takes over existing locks.
     */
    public async acquire(): Promise<void> {
        await fs.promises.mkdir(this.storageDirectory, { recursive: true })

        const metadata: ObserverLockMetadata = {
            instanceId: this.instanceId,
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
            storageDirectory: this.storageDirectory
        }

        try {
            const handle = await fs.promises.open(this.lockPath, 'wx')
            try {
                await handle.writeFile(JSON.stringify(metadata, null, 2), 'utf-8')
            } finally {
                await handle.close()
            }
            this.isHeld = true
        } catch (err: any) {
            if (err.code === 'EEXIST') {
                let existingMeta: any = null
                try {
                    const raw = await fs.promises.readFile(this.lockPath, 'utf-8')
                    existingMeta = JSON.parse(raw)
                } catch {}

                const details = existingMeta
                    ? `PID ${existingMeta.pid} on host ${existingMeta.hostname} (Instance: ${existingMeta.instanceId}, Started: ${existingMeta.startedAt})`
                    : 'Unknown process'

                throw new Error(
                    `[LOCK-COLLISION] Another observer instance is currently running or previous process exited uncleanly. Lock held by ${details}. Verify no process is active before manually removing ${this.lockPath}.`
                )
            }
            throw err
        }
    }

    /**
     * Safely releases lock only if this instance owns it.
     */
    public async release(): Promise<void> {
        if (!this.isHeld) return

        if (!fs.existsSync(this.lockPath)) {
            this.isHeld = false
            return
        }

        try {
            const raw = await fs.promises.readFile(this.lockPath, 'utf-8')
            const parsed = JSON.parse(raw)

            if (parsed.instanceId === this.instanceId) {
                await fs.promises.unlink(this.lockPath)
                this.isHeld = false
            } else {
                console.warn(
                    `[LOCK-WARNING] Refusing to release lock: owned by different instance ${parsed.instanceId} (current: ${this.instanceId})`
                )
            }
        } catch (err: any) {
            console.warn(`[LOCK-WARNING] Failed to cleanly release lock file ${this.lockPath}: ${err.message}`)
        }
    }
}
