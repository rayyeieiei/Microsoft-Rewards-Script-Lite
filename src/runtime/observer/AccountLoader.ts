import fs from 'fs'
import path from 'path'
import { redactAccountKey } from '../../util/Redaction'

export interface ObserverIdentity {
    accountId: string
    displayLabel: string
    sessionLookupKey?: string
}

export type DataSourceLoadingStatus = 'loading' | 'loaded' | 'empty' | 'failed'

export type DataSourceErrorCode =
    | 'file-not-found'
    | 'permission-denied'
    | 'malformed-json'
    | 'security-violation'
    | 'invalid-schema'
    | 'unknown'

export interface AccountRejectionDetail {
    identifier?: string
    reason: string
    code: 'duplicate' | 'invalid-format' | 'missing-field' | 'security-violation' | 'unknown'
}

export interface DataSourceErrorDetail {
    code: DataSourceErrorCode
    message: string
    remediation: string
}

export interface AccountLoadResult {
    status: DataSourceLoadingStatus
    sourceFile: string
    environmentMode: 'normal' | 'development'
    identities: ObserverIdentity[]
    acceptedCount: number
    rejectedCount: number
    rejections: AccountRejectionDetail[]
    rejectionReasons: string[]
    error?: DataSourceErrorDetail
    lastLoadedAt: string
}

export class AccountLoader {
    /**
     * Resolves target file path deterministically relative to configDir,
     * while supporting absolute paths directly.
     */
    public static resolveManifestPath(configDir: string, filePath = 'accounts.json'): string {
        if (path.isAbsolute(filePath)) {
            return path.resolve(filePath)
        }
        return path.resolve(configDir, filePath)
    }

    /**
     * Loads, validates, and adapts account source files (accounts.json, accounts.dev.json, or identities.json).
     * Strictly creates fresh allowlisted objects and never retains raw credential objects.
     */
    public static load(
        configDir: string,
        customPath?: string,
        explicitMode?: 'normal' | 'development'
    ): AccountLoadResult {
        // Determine mode and default file if customPath not provided
        let environmentMode: 'normal' | 'development' = explicitMode || 'normal'
        if (!customPath) {
            customPath = environmentMode === 'development' ? 'accounts.dev.json' : 'accounts.json'
        } else {
            const lowerPath = customPath.toLowerCase()
            if (lowerPath.includes('dev') && !explicitMode) {
                environmentMode = 'development'
            }
        }

        const fullPath = this.resolveManifestPath(configDir, customPath)
        const sourceFile = path.basename(fullPath)
        const lastLoadedAt = new Date().toISOString()

        // 1. Check file existence
        if (!fs.existsSync(fullPath)) {
            let remediation = `Pastikan file ${sourceFile} tersedia di direktori proyek.`
            if (sourceFile === 'accounts.dev.json') {
                remediation = `Pastikan file accounts.dev.json tersedia di direktori proyek, atau jalankan mode normal tanpa argumen -dev.`
            } else if (sourceFile === 'accounts.json') {
                remediation = `Pastikan file accounts.json tersedia di direktori proyek (salin dari accounts.example.json).`
            } else if (sourceFile === 'identities.json') {
                remediation = `Buat file ${sourceFile} berdasarkan identities.example.json atau atur accountsPath di config.observer.json.`
            }

            return {
                status: 'failed',
                sourceFile,
                environmentMode,
                identities: [],
                acceptedCount: 0,
                rejectedCount: 0,
                rejections: [],
                rejectionReasons: [],
                error: {
                    code: 'file-not-found',
                    message: `File sumber akun tidak ditemukan: ${sourceFile}`,
                    remediation
                },
                lastLoadedAt
            }
        }

        // 2. Read file contents
        let raw: string
        try {
            raw = fs.readFileSync(fullPath, 'utf-8')
        } catch (err: any) {
            const isPerm = err.code === 'EACCES' || err.code === 'EPERM'
            return {
                status: 'failed',
                sourceFile,
                environmentMode,
                identities: [],
                acceptedCount: 0,
                rejectedCount: 0,
                rejections: [],
                rejectionReasons: [],
                error: {
                    code: isPerm ? 'permission-denied' : 'unknown',
                    message: `Gagal membaca file ${sourceFile}: ${err.message}`,
                    remediation: isPerm
                        ? `Periksa izin akses baca (read permission) untuk file ${sourceFile}.`
                        : `Periksa apakah file dapat diakses oleh proses observer.`
                },
                lastLoadedAt
            }
        }

        // 3. Check for 0-byte or whitespace-only files (malformed, NOT valid empty list)
        if (!raw || raw.trim().length === 0) {
            return {
                status: 'failed',
                sourceFile,
                environmentMode,
                identities: [],
                acceptedCount: 0,
                rejectedCount: 0,
                rejections: [],
                rejectionReasons: [],
                error: {
                    code: 'malformed-json',
                    message: `File konfigurasi akun kosong atau terpotong saat penulisan (0 byte / spasi saja)`,
                    remediation: `Pastikan file ${sourceFile} berisi array JSON valid (contoh: []) dan tidak terpotong saat disimpan.`
                },
                lastLoadedAt
            }
        }

        // 4. JSON parsing
        let parsed: unknown
        try {
            parsed = JSON.parse(raw)
        } catch (err: any) {
            return {
                status: 'failed',
                sourceFile,
                environmentMode,
                identities: [],
                acceptedCount: 0,
                rejectedCount: 0,
                rejections: [],
                rejectionReasons: [],
                error: {
                    code: 'malformed-json',
                    message: `Format JSON tidak valid di ${sourceFile}: ${err.message}`,
                    remediation: `Periksa sintaks JSON di ${sourceFile} dan pastikan penutupan kurung serta tanda kutip sudah sesuai.`
                },
                lastLoadedAt
            }
        }

        // 5. Root must be an array
        if (!Array.isArray(parsed)) {
            return {
                status: 'failed',
                sourceFile,
                environmentMode,
                identities: [],
                acceptedCount: 0,
                rejectedCount: 0,
                rejections: [],
                rejectionReasons: [],
                error: {
                    code: 'invalid-schema',
                    message: `Struktur data di ${sourceFile} harus berupa array JSON`,
                    remediation: `Ubah struktur ${sourceFile} menjadi array objek akun valid: [ { ... } ].`
                },
                lastLoadedAt
            }
        }

        // 6. Check for empty list: valid JSON []
        if (parsed.length === 0) {
            return {
                status: 'empty',
                sourceFile,
                environmentMode,
                identities: [],
                acceptedCount: 0,
                rejectedCount: 0,
                rejections: [],
                rejectionReasons: [],
                lastLoadedAt
            }
        }

        // 7. Separate Format Adapters: Accounts format vs Identities format
        // Check if entries look like identities (has accountId and no email)
        const isIdentitiesFormat = parsed.some(
            item => item && typeof item === 'object' && 'accountId' in item && !('email' in item)
        )

        const rejections: AccountRejectionDetail[] = []
        const validIdentities: ObserverIdentity[] = []

        if (isIdentitiesFormat) {
            this.parseIdentitiesFormat(parsed, rejections, validIdentities)
        } else {
            this.parseAccountsFormat(parsed, rejections, validIdentities)
        }

        const acceptedCount = validIdentities.length
        const rejectedCount = rejections.length
        const rejectionReasons = rejections.map(r => `${r.identifier ? r.identifier + ': ' : ''}${r.reason}`)

        // If all entries were rejected, status is 'failed', NOT 'loaded'
        if (acceptedCount === 0 && rejectedCount > 0) {
            return {
                status: 'failed',
                sourceFile,
                environmentMode,
                identities: [],
                acceptedCount: 0,
                rejectedCount,
                rejections,
                rejectionReasons,
                error: {
                    code: 'invalid-schema',
                    message: `Seluruh entri akun dalam ${sourceFile} ditolak (${rejectedCount} penolakan)`,
                    remediation: `Periksa daftar penolakan konfigurasi akun dan pastikan format email/ID valid.`
                },
                lastLoadedAt
            }
        }

        return {
            status: 'loaded',
            sourceFile,
            environmentMode,
            identities: validIdentities,
            acceptedCount,
            rejectedCount,
            rejections,
            rejectionReasons,
            lastLoadedAt
        }
    }

    /**
     * Parses standard accounts format (accounts.json, accounts.dev.json).
     * Extracts allowlisted fields only: id/email -> accountId, email -> displayLabel (redacted), email -> sessionLookupKey.
     * All sensitive fields (password, totpSecret, recoveryEmail, proxy, cookies, tokens) are discarded.
     */
    private static parseAccountsFormat(
        items: any[],
        rejections: AccountRejectionDetail[],
        validIdentities: ObserverIdentity[]
    ): void {
        // Pre-scan for duplicate identifiers across all valid account items
        const idCounts = new Map<string, number>()
        for (const item of items) {
            if (item && typeof item === 'object') {
                const rawId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined
                const rawEmail =
                    typeof item.email === 'string' && item.email.trim() ? item.email.trim().toLowerCase() : undefined
                const effectiveId = rawId || rawEmail
                if (effectiveId) {
                    idCounts.set(effectiveId, (idCounts.get(effectiveId) || 0) + 1)
                }
            }
        }

        for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx]

            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                rejections.push({
                    identifier: `entry[${idx}]`,
                    reason: `Entri bukan objek JSON yang valid`,
                    code: 'invalid-format'
                })
                continue
            }

            // Validate email: must be non-empty string and not whitespace-only
            if (typeof item.email !== 'string' || item.email.trim().length === 0) {
                rejections.push({
                    identifier: `entry[${idx}]`,
                    reason: `Email akun wajib diisi dan tidak boleh kosong`,
                    code: 'missing-field'
                })
                continue
            }

            const rawEmail = item.email.trim()
            const rawId = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : undefined
            const effectiveId = rawId || rawEmail.toLowerCase()

            // Check duplicate policy: fail-closed for all entries sharing this identifier
            if ((idCounts.get(effectiveId) || 0) > 1) {
                rejections.push({
                    identifier: redactAccountKey(rawEmail),
                    reason: `Identitas akun duplikat terdeteksi (${effectiveId}). Seluruh entri dengan identitas ini ditolak fail-closed.`,
                    code: 'duplicate'
                })
                continue
            }

            // Redact display label
            const displayLabel = redactAccountKey(rawEmail)

            // Construct fresh allowlisted object without retaining any sensitive fields
            const identity: ObserverIdentity = {
                accountId: effectiveId,
                displayLabel,
                sessionLookupKey: rawEmail
            }

            validIdentities.push(identity)
        }
    }

    /**
     * Parses manifest format (identities.json).
     * Extracts allowlisted fields only: accountId, displayLabel.
     * Does not require email.
     */
    private static parseIdentitiesFormat(
        items: any[],
        rejections: AccountRejectionDetail[],
        validIdentities: ObserverIdentity[]
    ): void {
        const idCounts = new Map<string, number>()
        for (const item of items) {
            if (item && typeof item === 'object' && typeof (item as any).accountId === 'string') {
                const normalizedId = (item as any).accountId.trim().toLowerCase()
                if (normalizedId) {
                    idCounts.set(normalizedId, (idCounts.get(normalizedId) || 0) + 1)
                }
            }
        }

        for (let idx = 0; idx < items.length; idx++) {
            const item = items[idx]

            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                rejections.push({
                    identifier: `entry[${idx}]`,
                    reason: `Entri bukan objek JSON yang valid`,
                    code: 'invalid-format'
                })
                continue
            }

            const rawAccountId = (item as any).accountId
            const rawDisplayLabel = (item as any).displayLabel

            if (typeof rawAccountId !== 'string' || !rawAccountId.trim()) {
                rejections.push({
                    identifier: `entry[${idx}]`,
                    reason: `Properti 'accountId' wajib ada dan tidak boleh kosong`,
                    code: 'missing-field'
                })
                continue
            }

            const normalizedId = rawAccountId.trim().toLowerCase()

            if ((idCounts.get(normalizedId) || 0) > 1) {
                rejections.push({
                    identifier: normalizedId,
                    reason: `ID duplikat terdeteksi (${normalizedId}). Seluruh entri dengan ID ini ditolak fail-closed.`,
                    code: 'duplicate'
                })
                continue
            }

            if (typeof rawDisplayLabel !== 'string' || !rawDisplayLabel.trim()) {
                rejections.push({
                    identifier: normalizedId,
                    reason: `Properti 'displayLabel' wajib ada dan tidak boleh kosong`,
                    code: 'missing-field'
                })
                continue
            }

            const trimmedLabel = rawDisplayLabel.trim()
            if (trimmedLabel.length > 100) {
                rejections.push({
                    identifier: normalizedId,
                    reason: `Panjang 'displayLabel' melebihi batas maksimum 100 karakter`,
                    code: 'invalid-format'
                })
                continue
            }

            const sanitizedLabel = redactAccountKey(trimmedLabel)

            // Construct fresh allowlisted object without retaining any extra fields
            const identity: ObserverIdentity = {
                accountId: normalizedId,
                displayLabel: sanitizedLabel
            }

            validIdentities.push(identity)
        }
    }
}
