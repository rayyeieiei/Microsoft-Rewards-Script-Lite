import type { AxiosRequestConfig } from 'axios'

export type HttpFailureCategory =
    | 'timeout'
    | 'dns-connection-failure'
    | 'authentication-required'
    | 'authorization-denied'
    | 'rate-limited'
    | 'schema-invalid'
    | 'unsupported'
    | 'server-failure'
    | 'client-error'

export interface CircuitBreakerOptions {
    failureThreshold?: number
    resetTimeoutMs?: number
    clock?: () => number
}

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export class CircuitBreaker {
    private state: CircuitState = 'CLOSED'
    private failureCount = 0
    private lastFailureTime = 0
    private readonly failureThreshold: number
    private readonly resetTimeoutMs: number
    private readonly clock: () => number

    constructor(options?: CircuitBreakerOptions) {
        this.failureThreshold = options?.failureThreshold ?? 5
        this.resetTimeoutMs = options?.resetTimeoutMs ?? 10000
        this.clock = options?.clock ?? Date.now
    }

    public getState(): CircuitState {
        const now = this.clock()
        if (this.state === 'OPEN' && now - this.lastFailureTime >= this.resetTimeoutMs) {
            this.state = 'HALF_OPEN'
        }
        return this.state
    }

    public recordSuccess(): void {
        this.failureCount = 0
        this.state = 'CLOSED'
    }

    public recordFailure(): void {
        this.failureCount++
        this.lastFailureTime = this.clock()
        if (this.failureCount >= this.failureThreshold) {
            this.state = 'OPEN'
        }
    }

    public isCallAllowed(): boolean {
        const currentState = this.getState()
        return currentState !== 'OPEN'
    }
}

export interface RetryPolicyOptions {
    maxRetries?: number
    initialDelayMs?: number
    maxDelayMs?: number
    maxRetryAfterMs?: number
    clock?: () => number
    random?: () => number
}

const SAFE_IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function isIdempotentMethod(method?: string): boolean {
    if (!method) return true // Default axios method is GET
    return SAFE_IDEMPOTENT_METHODS.has(method.toUpperCase())
}

export function parseRetryAfter(
    headerValue: string | undefined | null,
    maxRetryAfterMs = 30000,
    clock = Date.now
): number | null {
    if (!headerValue) return null
    const trimmed = headerValue.trim()
    const numericSeconds = parseInt(trimmed, 10)
    if (!isNaN(numericSeconds) && numericSeconds >= 0) {
        return Math.min(numericSeconds * 1000, maxRetryAfterMs)
    }

    const dateMs = Date.parse(trimmed)
    if (!isNaN(dateMs)) {
        const delta = dateMs - clock()
        return Math.max(0, Math.min(delta, maxRetryAfterMs))
    }

    return null
}

export function classifyHttpError(error: unknown): {
    category: HttpFailureCategory
    message: string
    statusCode?: number
} {
    if (!error) {
        return { category: 'client-error', message: 'Unknown error' }
    }

    const err = error as any

    // Timeout check
    if (
        err.code === 'ECONNABORTED' ||
        err.name === 'AbortError' ||
        err.name === 'TimeoutError' ||
        err.message?.includes('timeout')
    ) {
        return { category: 'timeout', message: err.message || 'Request timed out' }
    }

    // DNS / Connection check
    if (
        err.code === 'ENOTFOUND' ||
        err.code === 'ECONNREFUSED' ||
        err.code === 'EAI_AGAIN' ||
        err.code === 'ENETUNREACH' ||
        (err.isAxiosError && !err.response)
    ) {
        return { category: 'dns-connection-failure', message: err.message || 'Network connection failed' }
    }

    // HTTP Response status check
    const status = err.response?.status
    if (typeof status === 'number') {
        if (status === 401) {
            return { category: 'authentication-required', message: 'HTTP 401 Unauthorized', statusCode: status }
        }
        if (status === 403) {
            return { category: 'authorization-denied', message: 'HTTP 403 Forbidden', statusCode: status }
        }
        if (status === 429) {
            return { category: 'rate-limited', message: 'HTTP 429 Rate Limited', statusCode: status }
        }
        if (status >= 500 && status < 600) {
            return { category: 'server-failure', message: `HTTP ${status} Server Error`, statusCode: status }
        }
        return { category: 'client-error', message: `HTTP ${status} Client Error`, statusCode: status }
    }

    return { category: 'client-error', message: err.message || String(err) }
}

export class HttpRetryPolicy {
    public readonly maxRetries: number
    public readonly initialDelayMs: number
    public readonly maxDelayMs: number
    public readonly maxRetryAfterMs: number
    public readonly clock: () => number
    public readonly random: () => number

    constructor(options?: RetryPolicyOptions) {
        this.maxRetries = options?.maxRetries ?? 3
        this.initialDelayMs = options?.initialDelayMs ?? 500
        this.maxDelayMs = options?.maxDelayMs ?? 5000
        this.maxRetryAfterMs = options?.maxRetryAfterMs ?? 30000
        this.clock = options?.clock ?? Date.now
        this.random = options?.random ?? Math.random
    }

    public calculateBackoff(attempt: number, retryAfterHeader?: string): number {
        const retryAfter = parseRetryAfter(retryAfterHeader, this.maxRetryAfterMs, this.clock)
        if (retryAfter !== null) {
            return retryAfter
        }

        const exponential = this.initialDelayMs * Math.pow(2, attempt)
        const capped = Math.min(exponential, this.maxDelayMs)
        // Add full jitter: random between 0.5 and 1.5 * capped
        const jitter = (this.random() * 0.5 + 0.75) * capped
        return Math.floor(Math.min(jitter, this.maxDelayMs))
    }

    public isRetryable(config: AxiosRequestConfig, error: unknown, attempt: number): boolean {
        if (attempt >= this.maxRetries) {
            return false
        }

        // Only retry safe idempotent read operations! Never mutating POST/PUT/DELETE
        if (!isIdempotentMethod(config.method)) {
            return false
        }

        const { category } = classifyHttpError(error)
        return (
            category === 'timeout' ||
            category === 'dns-connection-failure' ||
            category === 'rate-limited' ||
            category === 'server-failure'
        )
    }
}
