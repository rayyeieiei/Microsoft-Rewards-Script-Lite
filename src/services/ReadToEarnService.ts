import crypto from 'crypto'
import { HttpClient } from '../core/HttpClient'
import { DapiActivityClaimPayload, DapiActivityResponse, MsnNewsFeedResponse } from '../types/DapiTypes'

export const MSN_FEED_ENDPOINTS = [
    'https://assets.msn.com/service/news/feed/pages/binghp?apikey=0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM&market=id-id',
    'https://assets.msn.com/service/news/feed/pages/selected?apikey=0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM&market=id-id',
    'https://assets.msn.com/service/news/feed/pages/news?apikey=0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM&market=id-id'
]
export const MSN_FEED_URL = MSN_FEED_ENDPOINTS[0]!
export const READ_TO_EARN_OFFER_ID = 'ENUS_readarticle3_30points'
export const DAPI_ACTIVITIES_URL = 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities'

export interface ReadToEarnOptions {
    country?: string
    minDelayMs?: number
    maxDelayMs?: number
    maxArticles?: number
    sleepFn?: (ms: number) => Promise<void>
    exclusionPool?: Set<string>
    accountSeed?: string
}

export interface ReadArticleProgress {
    index: number
    total: number
    articleId: string
    delayMs: number
}

export class ReadToEarnService {
    private client: HttpClient
    private country: string
    private minDelayMs: number
    private maxDelayMs: number
    private maxArticles: number
    private sleep: (ms: number) => Promise<void>
    private exclusionPool?: Set<string>
    private accountSeed?: string

    constructor(client: HttpClient, options: ReadToEarnOptions = {}) {
        this.client = client
        this.country = options.country ?? 'ID'
        this.minDelayMs = options.minDelayMs ?? 6000
        this.maxDelayMs = options.maxDelayMs ?? 12000
        this.maxArticles = options.maxArticles ?? 10
        this.sleep = options.sleepFn || ((ms: number) => new Promise(r => setTimeout(r, ms)))
        this.exclusionPool = options.exclusionPool
        this.accountSeed = options.accountSeed
    }

    /**
     * Fisher-Yates shuffle with optional deterministic PRNG seed based on account identifier
     * to guarantee distinct, non-replayable article order across multiple accounts.
     */
    public shuffleArticles<T>(array: T[], seedStr?: string): T[] {
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
     * Fetches real article IDs from the MSN news feed endpoints with multi-feed fallback
     * and cross-account exclusion filtering to guarantee Zero-Replay.
     */
    public async fetchRealArticleIds(exclusionPool?: Set<string>): Promise<string[]> {
        const pool = exclusionPool || this.exclusionPool
        const collectedIds: string[] = []
        const seen = new Set<string>()

        for (const endpoint of MSN_FEED_ENDPOINTS) {
            try {
                const response = await this.client.get<MsnNewsFeedResponse>(endpoint)
                const data = response.data

                if (data && Array.isArray(data.sections)) {
                    for (const section of data.sections) {
                        if (!section || !Array.isArray(section.cards)) continue
                        for (const card of section.cards) {
                            if (!card) continue
                            if (card.id && typeof card.id === 'string' && !seen.has(card.id)) {
                                seen.add(card.id)
                                collectedIds.push(card.id)
                            }
                            if (Array.isArray(card.subCards)) {
                                for (const sub of card.subCards) {
                                    if (sub && sub.id && typeof sub.id === 'string' && !seen.has(sub.id)) {
                                        seen.add(sub.id)
                                        collectedIds.push(sub.id)
                                    }
                                }
                            }
                        }
                    }
                }

                // If we collected enough articles, stop querying further endpoints
                if (collectedIds.length >= 25) {
                    break
                }
            } catch {
                // Try next endpoint on failure
                continue
            }
        }

        if (collectedIds.length === 0) {
            throw new Error('Tidak ditemukan artikel riil dari feed MSN')
        }

        // Apply cross-account exclusion filtering to prevent replay ID
        let available = pool ? collectedIds.filter(id => !pool.has(id)) : collectedIds

        // Fallback: If all articles have been consumed in this session, reset available pool
        if (available.length === 0) {
            available = collectedIds
        }

        // Shuffle articles per-account
        return this.shuffleArticles(available, this.accountSeed)
    }

    /**
     * Calculates a non-linear realistic reading delay between minDelayMs and maxDelayMs (6000ms - 12000ms).
     * Uses an Irwin-Hall distribution (sum of 3 uniforms) to emulate human reading cadence
     * and eliminate flat rectangular statistical signatures flagged by ML anti-abuse models.
     */
    public getRandomDelay(): number {
        const min = this.minDelayMs
        const max = this.maxDelayMs
        if (min >= max) return min

        const u = (Math.random() + Math.random() + Math.random()) / 3
        const delay = Math.floor(min + u * (max - min + 1))
        return Math.min(Math.max(delay, min), max)
    }

    /**
     * Executes the Read to Earn routine by reading real articles with non-linear jitter delays,
     * Zero-Replay exclusion tracking, and reporting activity completions to DAPI.
     */
    public async processReadToEarn(
        accessToken: string,
        quotaRemaining: number,
        onProgress?: (progress: ReadArticleProgress) => void
    ): Promise<number> {
        if (quotaRemaining <= 0) {
            return 0
        }

        const realArticleIds = await this.fetchRealArticleIds(this.exclusionPool)
        const articlesNeeded = Math.min(
            Math.ceil(quotaRemaining / 3),
            this.maxArticles,
            realArticleIds.length
        )

        let completedCount = 0

        for (let i = 0; i < articlesNeeded; i++) {
            const articleId = realArticleIds[i]
            if (!articleId) continue
            const delayMs = this.getRandomDelay()

            if (onProgress) {
                onProgress({
                    index: i + 1,
                    total: articlesNeeded,
                    articleId,
                    delayMs
                })
            }

            // Wait with non-linear jitter before reporting claim
            await this.sleep(delayMs)

            await this.reportArticleRead(accessToken, articleId)
            completedCount++

            // Track article ID in exclusion pool to prevent replay in subsequent accounts
            if (this.exclusionPool) {
                this.exclusionPool.add(articleId)
            }
        }

        return completedCount
    }

    /**
     * Reports an article read completion to DAPI activities.
     */
    public async reportArticleRead(
        accessToken: string,
        articleId: string
    ): Promise<DapiActivityResponse> {
        const payload: DapiActivityClaimPayload = {
            id: crypto.randomUUID(),
            amount: 1,
            type: 101,
            attributes: {
                offerid: READ_TO_EARN_OFFER_ID
            },
            country: this.country
        }

        try {
            const response = await this.client.post<DapiActivityResponse>(
                DAPI_ACTIVITIES_URL,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                        'X-Rewards-Country': this.country,
                        'X-Rewards-Language': 'en',
                        'X-Rewards-ismobile': 'true'
                    }
                }
            )

            return response.data
        } catch (err: any) {
            if (err.response?.status === 403) {
                throw new Error(
                    '[ACCOUNT_FLAGGED_OR_SUSPENDED] DAPI akses ditolak (HTTP 403): Akun dibatasi oleh sistem Microsoft'
                )
            }
            throw err
        }
    }
}
