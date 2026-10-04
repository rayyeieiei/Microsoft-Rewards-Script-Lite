import crypto from 'crypto'
import { HttpClient } from '../core/HttpClient'

export const CANONICAL_EDGE_DESKTOP_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
    Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Sec-CH-UA': '"Chromium";v="131", "Not_A Brand";v="24", "Microsoft Edge";v="131"',
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': '"Windows"',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    Referer: 'https://www.bing.com/'
}

export const DEFAULT_NATURAL_QUERIES: string[] = [
    'cuaca hari ini jakarta',
    'resep masakan sederhana rumahan',
    'jadwal bioskop hari ini',
    'berita olahraga terkini',
    'tips kesehatan pola tidur',
    'wisata alam jawa barat',
    'cara merawat tanaman hias',
    'sejarah museum nasional indonesia',
    'teknologi kecerdasan buatan 2026',
    'latihan kardio ringan di rumah',
    'rekomendasi buku nonfiksi terbaik',
    'perbedaan kopi arabika dan robusta',
    'kalender hari libur nasional',
    'panduan gaya hidup ramah lingkungan',
    'cara belajar bahasa asing mandiri',
    'tren perkembangan energi terbarukan',
    'resep minuman segar buah tropis',
    'tips menghemat daya baterai laptop',
    'panduan dasar berkebun hidroponik',
    'fakta menarik luar angkasa teleskop james webb',
    'resep kue kering praktis',
    'tempat wisata anak di bandung',
    'manfaat olahraga jalan pagi setiap hari',
    'tips merawat kulit wajah alami',
    'cara membuat resume kerja profesional',
    'daftar film animasi pemenang oscar',
    'perbedaan motor listrik dan motor konvensional',
    'tips mengatur keuangan bulanan keluarga',
    'cara memilih laptop untuk mahasiswa',
    'rute transportasi umum mrt jakarta'
]

export interface HttpSearchOptions {
    minDelayMs?: number
    maxDelayMs?: number
    sleepFn?: (ms: number) => Promise<void>
    accountSeed?: string
    queries?: string[]
    pointsChecker?: () => Promise<number | null>
    logger?: (message: string) => void
}

export interface SearchProgress {
    queryIndex: number
    totalQueries: number
    query: string
    delayMs: number
    pointsGained?: number
}

export interface SearchExecutionResult {
    queriesExecuted: number
    pointsEarned: number
    cooldownDetected: boolean
}

export class HttpSearchService {
    private client: HttpClient
    private minDelayMs: number
    private maxDelayMs: number
    private sleep: (ms: number) => Promise<void>
    private accountSeed?: string
    private customQueries?: string[]
    private customPointsChecker?: () => Promise<number | null>
    private log: (msg: string) => void

    constructor(client: HttpClient, options: HttpSearchOptions = {}) {
        this.client = client
        this.minDelayMs = options.minDelayMs ?? 20000
        this.maxDelayMs = options.maxDelayMs ?? 35000
        this.sleep = options.sleepFn || ((ms: number) => new Promise(r => setTimeout(r, ms)))
        this.accountSeed = options.accountSeed
        this.customQueries = options.queries
        this.customPointsChecker = options.pointsChecker
        this.log = options.logger || ((msg: string) => console.log(msg))
    }

    /**
     * Fisher-Yates shuffle with optional deterministic PRNG seed based on account identifier
     * to guarantee diverse, non-repeating search query orders across accounts.
     */
    public shuffleQueries<T>(array: T[], seedStr?: string): T[] {
        const copy = [...array]
        let seed = 0
        if (seedStr) {
            for (let i = 0; i < seedStr.length; i++) {
                seed = (seed * 31 + seedStr.charCodeAt(i)) >>> 0
            }
        }
        const rng = () => {
            if (seedStr) {
                seed = (seed * 1664525 + 1013904223) >>> 0
                return seed / 4294967296
            }
            return Math.random()
        }

        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1))
            const temp = copy[i]!
            copy[i] = copy[j]!
            copy[j] = temp
        }
        return copy
    }

    /**
     * Calculates a realistic random jitter delay between minDelayMs and maxDelayMs (default 20s–35s).
     */
    public getRandomDelay(): number {
        const min = this.minDelayMs
        const max = this.maxDelayMs
        if (min >= max) return min
        return Math.floor(Math.random() * (max - min + 1)) + min
    }

    /**
     * Fetches the current point balance or search progress from Microsoft Rewards endpoint.
     * Returns null if endpoint is unreachable or response cannot be parsed.
     */
    public async fetchCurrentPoints(): Promise<number | null> {
        if (this.customPointsChecker) {
            return this.customPointsChecker()
        }

        try {
            const response = await this.client.get('https://rewards.bing.com/api/getuserinfo', {
                headers: {
                    ...CANONICAL_EDGE_DESKTOP_HEADERS,
                    Referer: 'https://rewards.bing.com/'
                },
                timeout: 5000
            })

            const data = response.data
            if (data?.dashboard?.userStatus) {
                const pcProgress = data.dashboard.userStatus.counters?.pcSearch?.[0]?.pointProgress
                if (typeof pcProgress === 'number') {
                    return pcProgress
                }
                const available = data.dashboard.userStatus.availablePoints
                if (typeof available === 'number') {
                    return available
                }
            }
            return null
        } catch {
            return null
        }
    }

    /**
     * Executes pure HTTP desktop searches on Bing with randomized jitter,
     * natural language queries, and cooldown protection circuit breaker.
     */
    public async executeSearches(
        targetCount: number,
        onProgress?: (progress: SearchProgress) => void
    ): Promise<SearchExecutionResult> {
        if (targetCount <= 0) {
            return { queriesExecuted: 0, pointsEarned: 0, cooldownDetected: false }
        }

        const pool = this.customQueries || DEFAULT_NATURAL_QUERIES
        const shuffled = this.shuffleQueries(pool, this.accountSeed)
        const queriesToRun: string[] = []

        // Fill queries up to targetCount (repeating with salt if pool is smaller)
        while (queriesToRun.length < targetCount) {
            for (const q of shuffled) {
                if (queriesToRun.length >= targetCount) break
                queriesToRun.push(q)
            }
        }

        let queriesExecuted = 0
        let totalPointsEarned = 0
        let cooldownDetected = false
        let consecutiveZeroDelta = 0

        // Fetch initial baseline points
        let lastPoints = await this.fetchCurrentPoints()

        for (let i = 0; i < queriesToRun.length; i++) {
            const query = queriesToRun[i]!
            const delayMs = i === 0 ? 0 : this.getRandomDelay()

            if (delayMs > 0) {
                await this.sleep(delayMs)
            }

            const cvid = crypto.randomBytes(16).toString('hex').toUpperCase()
            const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&cvid=${cvid}&FORM=QBLH`

            try {
                await this.client.get(searchUrl, {
                    headers: {
                        ...CANONICAL_EDGE_DESKTOP_HEADERS,
                        Referer: 'https://www.bing.com/'
                    }
                })
                queriesExecuted++
            } catch (err: any) {
                // If network/request fails, record and safely break or continue
                this.log(`[SEARCH] Gagal mengeksekusi kueri "${query}": ${err.message || String(err)}`)
                break
            }

            // Circuit breaker check via point delta
            const currentPoints = await this.fetchCurrentPoints()
            let pointDelta = 0

            if (lastPoints !== null && currentPoints !== null) {
                pointDelta = Math.max(0, currentPoints - lastPoints)
                if (pointDelta === 0) {
                    consecutiveZeroDelta++
                    if (consecutiveZeroDelta >= 3) {
                        cooldownDetected = true
                        this.log(
                            `🚨 [COOLDOWN-DETECTED] Delta poin pencarian tidak bertambah 3x berturut-turut. Menghentikan pencarian (Cooldown Guard).`
                        )
                        if (onProgress) {
                            onProgress({
                                queryIndex: i + 1,
                                totalQueries: targetCount,
                                query,
                                delayMs,
                                pointsGained: pointDelta
                            })
                        }
                        break
                    }
                } else {
                    consecutiveZeroDelta = 0
                    totalPointsEarned += pointDelta
                    lastPoints = currentPoints
                }
            }

            if (onProgress) {
                onProgress({
                    queryIndex: i + 1,
                    totalQueries: targetCount,
                    query,
                    delayMs,
                    pointsGained: pointDelta
                })
            }
        }

        return {
            queriesExecuted,
            pointsEarned: totalPointsEarned,
            cooldownDetected
        }
    }
}
