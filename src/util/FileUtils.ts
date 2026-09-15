import fs from 'fs'

export interface AtomicRenameOptions {
    maxRetries?: number
    baseDelayMs?: number
    maxDelayMs?: number
}

/**
 * Executes an atomic rename with bounded retry handling for transient Windows NTFS locking
 * violations (EPERM, EBUSY, EACCES). Cleans up temporary file if rename fails permanently.
 */
export async function retryAtomicRename(
    sourcePath: string,
    destPath: string,
    options: AtomicRenameOptions = {}
): Promise<void> {
    const maxRetries = options.maxRetries ?? 10
    const baseDelayMs = options.baseDelayMs ?? 15
    const maxDelayMs = options.maxDelayMs ?? 150

    let attempt = 0
    while (true) {
        try {
            await fs.promises.rename(sourcePath, destPath)
            return
        } catch (err: any) {
            attempt++
            const isLockError =
                err &&
                (err.code === 'EPERM' ||
                    err.code === 'EBUSY' ||
                    err.code === 'EACCES' ||
                    err.syscall === 'rename')

            if (isLockError && attempt <= maxRetries) {
                const delay = Math.min(
                    baseDelayMs * Math.pow(1.5, attempt - 1) + Math.random() * 10,
                    maxDelayMs
                )
                await new Promise(resolve => setTimeout(resolve, delay))
                continue
            }

            // Cleanup orphaned source temp file before failing
            try {
                await fs.promises.unlink(sourcePath)
            } catch {}

            throw err
        }
    }
}