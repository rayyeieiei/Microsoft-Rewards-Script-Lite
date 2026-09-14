import http from 'http'
import https from 'https'
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { URL } from 'url'
import { CircuitBreaker, HttpRetryPolicy } from './HttpRetryPolicy'

export interface HttpAccountScopeOptions {
    accountId: string
    displayAccount: string
    totalBudgetMs: number
    requestTimeoutMs: number
    allowedApiOrigins: string[]
    retryPolicy?: HttpRetryPolicy
    customHttpAgent?: http.Agent
    customHttpsAgent?: https.Agent
}

export class HttpAccountScope {
    public readonly accountId: string
    public readonly displayAccount: string
    public readonly totalBudgetMs: number
    public readonly requestTimeoutMs: number
    public readonly allowedApiOrigins: Set<string>

    public readonly abortController: AbortController = new AbortController()
    private readonly budgetTimer: NodeJS.Timeout | null = null

    private readonly httpAgent: http.Agent
    private readonly httpsAgent: https.Agent
    private readonly axiosInstance: AxiosInstance
    private readonly retryPolicy: HttpRetryPolicy
    private readonly circuitBreakers = new Map<string, CircuitBreaker>()

    private readonly trackedOperations = new Set<Promise<any>>()
    private _isDisposed = false

    private constructor(options: HttpAccountScopeOptions) {
        this.accountId = options.accountId
        this.displayAccount = options.displayAccount
        this.totalBudgetMs = options.totalBudgetMs
        this.requestTimeoutMs = options.requestTimeoutMs

        // Default-deny network policy: origin validation
        const normalizedOrigins = (options.allowedApiOrigins || []).map(o => {
            try {
                return new URL(o).origin
            } catch {
                return o.trim()
            }
        })
        this.allowedApiOrigins = new Set(normalizedOrigins)

        this.retryPolicy = options.retryPolicy || new HttpRetryPolicy()

        // Per-scope connection agents with keepAlive and socket limits
        this.httpAgent = options.customHttpAgent ?? new http.Agent({ keepAlive: true, maxSockets: 10 })
        this.httpsAgent = options.customHttpsAgent ?? new https.Agent({ keepAlive: true, maxSockets: 10 })

        // Isolated Axios instance - never touches global defaults
        this.axiosInstance = axios.create({
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
            maxRedirects: 0, // Intercept and strictly validate redirects
            validateStatus: status => status >= 200 && status < 400
        })

        // Account total budget timer
        if (this.totalBudgetMs > 0) {
            this.budgetTimer = setTimeout(() => {
                this.abortController.abort()
            }, this.totalBudgetMs)
            if (typeof this.budgetTimer.unref === 'function') {
                this.budgetTimer.unref()
            }
        }
    }

    public static async create(options: HttpAccountScopeOptions): Promise<HttpAccountScope> {
        if (!options.allowedApiOrigins || options.allowedApiOrigins.length === 0) {
            // Default-deny: empty origins explicitly allowed as empty set (deny-all)
        }
        return new HttpAccountScope(options)
    }

    public get isDisposed(): boolean {
        return this._isDisposed
    }

    public getCircuitBreaker(origin: string): CircuitBreaker {
        let breaker = this.circuitBreakers.get(origin)
        if (!breaker) {
            breaker = new CircuitBreaker({ clock: this.retryPolicy.clock })
            this.circuitBreakers.set(origin, breaker)
        }
        return breaker
    }

    private validateTargetUrl(rawUrl: string): URL {
        let parsed: URL
        try {
            parsed = new URL(rawUrl)
        } catch {
            throw new Error(`[NETWORK-POLICY] Invalid URL format: ${rawUrl}`)
        }

        // Reject credentials embedded in URL (e.g. http://user:pass@host)
        if (parsed.username || parsed.password) {
            throw new Error('[NETWORK-POLICY] Embedded credentials in URL are strictly prohibited')
        }

        // Compare normalized URL.origin against allowedApiOrigins
        if (!this.allowedApiOrigins.has(parsed.origin)) {
            throw new Error(
                `[NETWORK-POLICY] Destination origin "${parsed.origin}" is not in the allowedApiOrigins allowlist`
            )
        }

        return parsed
    }

    public track<T>(operation: Promise<T>): Promise<T> {
        if (this._isDisposed) {
            return Promise.reject(new Error('Cannot track operation on disposed HttpAccountScope'))
        }
        this.trackedOperations.add(operation)
        operation
            .catch(() => {})
            .finally(() => {
                this.trackedOperations.delete(operation)
            })
        return operation
    }

    public async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
        if (this._isDisposed) {
            throw new Error('HttpAccountScope is disposed')
        }

        if (this.abortController.signal.aborted) {
            throw new Error('HttpAccountScope budget exceeded or cancelled')
        }

        if (!config.url) {
            throw new Error('Request URL is required')
        }

        const parsedUrl = this.validateTargetUrl(config.url)
        const origin = parsedUrl.origin
        const breaker = this.getCircuitBreaker(origin)

        if (!breaker.isCallAllowed()) {
            throw new Error(`[CIRCUIT-BREAKER] Circuit for origin ${origin} is OPEN`)
        }

        // Zero Cookie Policy: strip manual Cookie headers
        const headers = { ...(config.headers || {}) }
        delete headers['Cookie']
        delete headers['cookie']
        delete headers['set-cookie']

        let attempt = 0
        let lastError: any = null

        while (attempt <= this.retryPolicy.maxRetries) {
            if (this._isDisposed || this.abortController.signal.aborted) {
                throw new Error('HttpAccountScope budget exceeded or disposed during retries')
            }

            // Level 2 AbortController: Per-request child controller for requestTimeoutMs
            const requestController = new AbortController()
            let timeoutTriggered = false
            const requestTimer = setTimeout(() => {
                timeoutTriggered = true
                requestController.abort()
            }, this.requestTimeoutMs)

            // Propagate scope abort without sharing the controller
            const onScopeAbort = () => requestController.abort()
            this.abortController.signal.addEventListener('abort', onScopeAbort, { once: true })

            const singleRequestPromise = this.axiosInstance.request<T>({
                ...config,
                headers,
                signal: requestController.signal
            })

            const trackedPromise = this.track(singleRequestPromise)

            try {
                const response = await trackedPromise
                clearTimeout(requestTimer)
                this.abortController.signal.removeEventListener('abort', onScopeAbort)

                // Check for redirect target compliance
                if (response.status >= 300 && response.status < 400 && response.headers?.location) {
                    const redirectUrl = new URL(response.headers.location, parsedUrl.origin)
                    if (!this.allowedApiOrigins.has(redirectUrl.origin)) {
                        throw new Error(
                            `[NETWORK-POLICY] Redirect destination "${redirectUrl.origin}" escapes origin allowlist`
                        )
                    }
                }

                breaker.recordSuccess()
                return response
            } catch (err: any) {
                clearTimeout(requestTimer)
                this.abortController.signal.removeEventListener('abort', onScopeAbort)

                // If per-request timeout triggered, do NOT abort the scope controller
                if (timeoutTriggered) {
                    const timeoutErr = new Error(`Request timed out after ${this.requestTimeoutMs}ms`)
                    ;(timeoutErr as any).name = 'TimeoutError'
                    ;(timeoutErr as any).code = 'ECONNABORTED'
                    lastError = timeoutErr
                } else {
                    lastError = err
                }

                breaker.recordFailure()

                if (this.retryPolicy.isRetryable(config, lastError, attempt)) {
                    attempt++
                    const retryAfterHeader = err.response?.headers?.['retry-after']
                    const delayMs = this.retryPolicy.calculateBackoff(attempt, retryAfterHeader)
                    await new Promise(resolve => setTimeout(resolve, delayMs))
                    continue
                }

                throw lastError
            }
        }

        throw lastError
    }

    public async dispose(): Promise<void> {
        if (this._isDisposed) {
            return // Idempotent
        }

        // 1. Abort scope controller
        this.abortController.abort()

        if (this.budgetTimer) {
            clearTimeout(this.budgetTimer)
        }

        // 2. Bounded drain of tracked operations (max 2000ms)
        if (this.trackedOperations.size > 0) {
            const drainPromise = Promise.allSettled(Array.from(this.trackedOperations))
            const timeoutPromise = new Promise(resolve => setTimeout(resolve, 2000))
            await Promise.race([drainPromise, timeoutPromise])
        }
        this.trackedOperations.clear()

        // 3. Destroy HTTP and HTTPS agents
        try {
            this.httpAgent.destroy()
            ;(this.httpAgent as any).destroyed = true
        } catch {}
        try {
            this.httpsAgent.destroy()
            ;(this.httpsAgent as any).destroyed = true
        } catch {}

        // 4. Clear references
        this.circuitBreakers.clear()

        // 5. Mark disposed
        this._isDisposed = true
    }
}
