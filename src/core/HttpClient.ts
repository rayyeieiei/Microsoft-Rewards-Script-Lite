import http from 'http'
import https from 'https'
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { AccountProxyConfig } from '../types/AccountTypes'

export const CANONICAL_EDGE_ANDROID_HEADERS: Record<string, string> = {
    'User-Agent':
        'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 EdgA/128.0.2708.57',
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Sec-CH-UA': '"Chromium";v="128", "Not;A=Brand";v="24", "Microsoft Edge";v="128"',
    'Sec-CH-UA-Mobile': '?1',
    'Sec-CH-UA-Platform': '"Android"',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'X-Rewards-Country': 'ID',
    'X-Rewards-Language': 'en',
    'X-Rewards-ismobile': 'true'
}

export interface HttpClientOptions {
    proxy?: AccountProxyConfig
    timeoutMs?: number
    country?: string
}

export class HttpClient {
    private client: AxiosInstance
    private httpAgent: http.Agent | null = null
    private httpsAgent: https.Agent | null = null
    private cookieStore: Map<string, string> = new Map()
    private requestInterceptorId: number | null = null
    private responseInterceptorId: number | null = null
    private isDisposed = false

    constructor(options: HttpClientOptions = {}) {
        const timeout = Math.min(Math.max(options.timeoutMs ?? 7000, 1000), 7000)
        const country = options.country ?? 'ID'

        const hasProxy =
            options.proxy &&
            typeof options.proxy === 'object' &&
            (Boolean(options.proxy.url) || Boolean(options.proxy.host))

        if (hasProxy) {
            const agent = this.createProxyAgent(options.proxy!)
            this.httpAgent = agent as any
            this.httpsAgent = agent as any
        } else {
            this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 20 })
            this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20 })
        }

        const headers: Record<string, string> = {
            ...CANONICAL_EDGE_ANDROID_HEADERS,
            'X-Rewards-Country': country
        }

        this.client = axios.create({
            timeout,
            httpAgent: this.httpAgent,
            httpsAgent: this.httpsAgent,
            headers
        })

        // Clean any default axios/node headers that may leak library fingerprint
        if (this.client.defaults.headers) {
            delete (this.client.defaults.headers as any).common?.['User-Agent']
        }

        // Request interceptor: inject cookies from in-memory store
        this.requestInterceptorId = this.client.interceptors.request.use(config => {
            if (this.isDisposed) {
                throw new Error('HttpClient has already been disposed')
            }

            if (!config.headers) {
                config.headers = {} as any
            }

            const currentCookieHeader = (config.headers['Cookie'] as string) || ''
            const storedCookieHeader = this.getCookieHeaderString()

            if (storedCookieHeader) {
                // Merge without duplicating
                const merged = this.mergeCookieHeaders(currentCookieHeader, storedCookieHeader)
                config.headers['Cookie'] = merged
            }

            return config
        })

        // Response interceptor: extract Set-Cookie
        this.responseInterceptorId = this.client.interceptors.response.use(
            response => {
                this.captureCookiesFromResponse(response)
                return response
            },
            error => {
                if (error.response) {
                    this.captureCookiesFromResponse(error.response)
                }
                return Promise.reject(error)
            }
        )
    }

    private createProxyAgent(proxy: AccountProxyConfig): any {
        const protocol = proxy.protocol || 'http'
        const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : ''
        const url = proxy.url || `${protocol}://${auth}${proxy.host}:${proxy.port}`

        if (url.startsWith('socks')) {
            return new SocksProxyAgent(url)
        } else if (url.startsWith('https')) {
            return new HttpsProxyAgent(url)
        } else {
            return new HttpProxyAgent(url)
        }
    }

    public captureCookiesFromResponse(response: AxiosResponse): void {
        const setCookie = response.headers?.['set-cookie']
        if (setCookie) {
            const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie]
            this.storeCookies(cookieList)
        }
    }

    public storeCookies(cookieStrings: string[]): void {
        for (const cookieStr of cookieStrings) {
            if (!cookieStr || typeof cookieStr !== 'string') continue
            const firstPart = cookieStr.split(';')[0]
            if (!firstPart) continue
            const parts = firstPart.trim().split('=')
            if (parts.length >= 2) {
                const name = parts[0]?.trim()
                const value = parts.slice(1).join('=').trim()
                if (name) {
                    this.cookieStore.set(name, value)
                }
            }
        }
    }

    public setCookie(name: string, value: string): void {
        this.cookieStore.set(name, value)
    }

    public getCookie(name: string): string | undefined {
        return this.cookieStore.get(name)
    }

    public setCookieHeaderString(cookieHeader: string): void {
        if (!cookieHeader) return
        const pairs = cookieHeader.split(';')
        for (const pair of pairs) {
            if (!pair) continue
            const parts = pair.trim().split('=')
            if (parts.length >= 2) {
                const name = parts[0]?.trim()
                const value = parts.slice(1).join('=').trim()
                if (name) {
                    this.cookieStore.set(name, value)
                }
            }
        }
    }

    public getCookieHeaderString(): string {
        const items: string[] = []
        for (const [name, val] of this.cookieStore.entries()) {
            items.push(`${name}=${val}`)
        }
        return items.join('; ')
    }

    private mergeCookieHeaders(existing: string, stored: string): string {
        const map = new Map<string, string>()
        const parseIntoMap = (str: string) => {
            for (const part of str.split(';')) {
                const [k, ...rest] = part.trim().split('=')
                if (k && rest.length > 0) {
                    map.set(k.trim(), rest.join('=').trim())
                }
            }
        }
        parseIntoMap(stored)
        if (existing) {
            parseIntoMap(existing)
        }
        const result: string[] = []
        for (const [k, v] of map.entries()) {
            result.push(`${k}=${v}`)
        }
        return result.join('; ')
    }

    public getAxios(): AxiosInstance {
        if (this.isDisposed) {
            throw new Error('HttpClient has already been disposed')
        }
        return this.client
    }

    public async request<T = any>(config: AxiosRequestConfig): Promise<AxiosResponse<T>> {
        return this.getAxios().request<T>(config)
    }

    public async get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
        return this.getAxios().get<T>(url, config)
    }

    public async post<T = any>(
        url: string,
        data?: any,
        config?: AxiosRequestConfig
    ): Promise<AxiosResponse<T>> {
        return this.getAxios().post<T>(url, data, config)
    }

    public dispose(): void {
        if (this.isDisposed) return
        this.isDisposed = true

        if (this.requestInterceptorId !== null) {
            this.client.interceptors.request.eject(this.requestInterceptorId)
            this.requestInterceptorId = null
        }
        if (this.responseInterceptorId !== null) {
            this.client.interceptors.response.eject(this.responseInterceptorId)
            this.responseInterceptorId = null
        }

        const agentToDestroy = this.httpAgent
        const httpsAgentToDestroy = this.httpsAgent

        if (agentToDestroy && typeof agentToDestroy.destroy === 'function') {
            agentToDestroy.destroy()
        }
        if (
            httpsAgentToDestroy &&
            httpsAgentToDestroy !== agentToDestroy &&
            typeof httpsAgentToDestroy.destroy === 'function'
        ) {
            httpsAgentToDestroy.destroy()
        }

        this.httpAgent = null
        this.httpsAgent = null
        this.cookieStore.clear()
    }
}
