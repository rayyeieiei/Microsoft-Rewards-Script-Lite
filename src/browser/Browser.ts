import rebrowser, { BrowserContext } from 'patchright'
import { newInjectedContext } from 'fingerprint-injector'
import { BrowserFingerprintWithHeaders, FingerprintGenerator } from 'fingerprint-generator'

import type { MicrosoftRewardsBot } from '../index'
import { loadSessionData, saveFingerprintData } from '../util/Load'
import { UserAgentManager } from './UserAgent'

import type { Account, AccountProxy } from '../interface/Account'
import os from 'os'
import http from 'http'
import net from 'net'

interface BrowserCreationResult {
    context: BrowserContext
    fingerprint: BrowserFingerprintWithHeaders
}

class Browser {
    private readonly bot: MicrosoftRewardsBot
    private localProxyServer: http.Server | null = null;
    private proxyPort: number = 0;

    private static readonly BROWSER_ARGS = [
        '--no-sandbox',
        '--mute-audio',
        '--disable-setuid-sandbox',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        '--ignore-ssl-errors',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-web-authentication-ui',
        '--disable-external-intent-requests',
        '--disable-blink-features=Attestation',
        '--disable-features=WebAuthentication,PasswordManagerOnboarding,PasswordManager,EnablePasswordsAccountStorage,Passkeys,WebAuthenticationProxy,U2F',
        '--disable-save-password-bubble',
        '--blink-settings=imagesEnabled=false' , // Matikan gambar dari level engine Chromium
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
    ] as const

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    private getWifiIpAddress(): string | null {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            if (name.toLowerCase().includes('wi-fi') || name.toLowerCase().includes('wireless')) {
                const iface = interfaces[name];
                if (iface) {
                    for (const config of iface) {
                        if (config.family === 'IPv4' && !config.internal && !config.address.startsWith('169.254')) {
                            return config.address;
                        }
                    }
                }
            }
        }
        return null; 
    }

    private async setupLocalProxy(wifiIp: string): Promise<number> {
        if (this.localProxyServer) return this.proxyPort; 

        return new Promise((resolve) => {
            this.localProxyServer = http.createServer((req, res) => {
                res.writeHead(405, { 'Content-Type': 'text/plain' });
                res.end('Method not allowed');
            });

            this.localProxyServer.on('connect', (req, clientSocket, head) => {
                const [host, port] = req.url?.split(':') || [];
                if (!host || !port) {
                    clientSocket.end();
                    return;
                }

                const serverSocket = net.connect({
                    host: host,
                    port: parseInt(port, 10),
                    localAddress: wifiIp
                }, () => {
                    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                    serverSocket.write(head);
                    serverSocket.pipe(clientSocket);
                    clientSocket.pipe(serverSocket);
                });

                serverSocket.on('error', () => clientSocket.end());
                clientSocket.on('error', () => serverSocket.end());
            });

            this.localProxyServer.listen(0, '127.0.0.1', () => {
                const address = this.localProxyServer?.address();
                if (address && typeof address !== 'string') {
                    this.proxyPort = address.port;
                    this.bot.logger.info(this.bot.isMobile, 'LOCAL-PROXY', `Mini Proxy aktif di port ${this.proxyPort} mem-bypass lewat Wi-Fi IP [${wifiIp}]`, 'cyan');
                    resolve(this.proxyPort);
                }
            });
        });
    }

    async createBrowser(account: Account): Promise<BrowserCreationResult> {
        let browser: any; 
        
        try {
            let proxyConfig: any = undefined;
            const wifiIp = this.getWifiIpAddress();

            const isOfficeMode = this.bot.config.isOfficeMode === true;
            if (isOfficeMode && wifiIp) {
                const port = await this.setupLocalProxy(wifiIp);
                proxyConfig = { server: `http://127.0.0.1:${port}` };
                this.bot.logger.info(this.bot.isMobile, 'NETWORK', `🏢 [MODE KANTOR] Chromium dipaksa membelok ke Wi-Fi (Tethering)`, 'yellow');
            } else {
                if (isOfficeMode && !wifiIp) {
                    this.bot.logger.warn(this.bot.isMobile, 'NETWORK', `Saklar Mode Kantor ON, tapi Wi-Fi mati! Kembali ke jalur utama 🚨`, 'red');
                } else {
                    this.bot.logger.info(this.bot.isMobile, 'NETWORK', `🏠 [MODE RUMAH] Chromium menggunakan jalur utama tanpa Mini Proxy`, 'cyan');
                }
                
                proxyConfig = account.proxy.url
                    ? {
                          server: this.formatProxyServer(account.proxy),
                          ...(account.proxy.username && account.proxy.password && {
                              username: account.proxy.username,
                              password: account.proxy.password
                          })
                      }
                    : undefined;
            }

            browser = await rebrowser.chromium.launch({
                headless: this.bot.config.headless === true,
                channel: this.bot.config.headless ? undefined : 'chrome',
                args: [...Browser.BROWSER_ARGS],
                proxy: proxyConfig 
            } as any);

            this.bot.logger.info(this.bot.isMobile, 'BROWSER', 'Browser launched successfully')
            
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.bot.logger.error(this.bot.isMobile, 'BROWSER', `Launch failed: ${errorMessage}`);
            throw error;
        }

       try {
            const sessionData = await loadSessionData(
                this.bot.config.sessionPath,
                account.email,
                account.saveFingerprint,
                this.bot.isMobile
            );

            // ==========================================
            // ⏳ SISTEM ROTASI KTP 14 HARI
            // ==========================================
            let fingerprint = sessionData.fingerprint;
            let needNewFingerprint = false;

            if (fingerprint) {
                const createdAt = (fingerprint as any).createdAt;
                if (!createdAt) {
                    needNewFingerprint = true;
                } else {
                    const ageInMs = Date.now() - createdAt;
                    const ageInDays = ageInMs / (1000 * 60 * 60 * 24);
                    
                    if (ageInDays >= 14) {
                        needNewFingerprint = true;
                        this.bot.logger.info(this.bot.isMobile, 'FINGERPRINT', `[KTP EXPIRED] Identitas akun udah ${Math.floor(ageInDays)} hari. Waktunya beli HP/PC baru! ♻️`, 'yellow');
                    } else {
                        this.bot.logger.info(this.bot.isMobile, 'FINGERPRINT', `[KTP AMAN] Umur hardware virtual baru ${Math.floor(ageInDays)} hari. Lanjut pakai spek lama. 🛡️`, 'cyan');
                    }
                }
            } else {
                needNewFingerprint = true;
            }

            if (needNewFingerprint) {
                fingerprint = await this.generateFingerprint(this.bot.isMobile);
            }
            // ==========================================

            const context = await newInjectedContext(browser as any, {
                fingerprint,
                newContextOptions: {
                    permissions: [],
                    ignoreHTTPSErrors: true
                }
            });

            await context.addInitScript(() => {
                Object.defineProperty(navigator, 'credentials', {
                    value: {
                        create: () => Promise.reject(new Error('WebAuthn disabled')),
                        get: () => Promise.reject(new Error('WebAuthn disabled'))
                    }
                });
            });

            // ==========================================
            // 🛡️ SMART DIET NETWORK INTERCEPTOR (FINAL)
            // ==========================================
            const safeContext = context as unknown as BrowserContext;
            await safeContext.route('**/*', (route) => {
                const req = route.request();
                const resourceType = req.resourceType();
                const url = req.url().toLowerCase();
                
                // 1. Daftar Hitam File Gajah (Hemat Kuota)
                const blockedTypes = ['image', 'media', 'font', 'stylesheet', 'websocket', 'texttrack', 'manifest'];

                // 2. Daftar Hitam Iklan Murni (Telemetri Microsoft DIHAPUS dari sini biar aman)
                const hasBlockedKeyword = 
                    url.includes('scorecardresearch') ||
                    url.includes('doubleclick') ||
                    url.includes('adnxs') ||
                    url.includes('advertising') ||
                    url.includes('ads') ||
                    url.includes('vids.msn.com') ||
                    url.includes('video');

                if (blockedTypes.includes(resourceType) || hasBlockedKeyword) {
                    route.abort(); // Tendang Iklan, Video, Gambar, CSS
                } else {
                    route.continue(); // Loloskan HTML, Javascript Kuis, dan Telemetri Microsoft
                }
            });
            // ==========================================

            context.setDefaultTimeout(this.bot.utils.stringToNumber(this.bot.config?.globalTimeout ?? 30000));

            await context.addCookies(sessionData.cookies);

            if (
                (account.saveFingerprint.mobile && this.bot.isMobile) ||
                (account.saveFingerprint.desktop && !this.bot.isMobile)
            ) {
                await saveFingerprintData(this.bot.config.sessionPath, account.email, this.bot.isMobile, fingerprint);
            }

            this.bot.logger.debug(this.bot.isMobile, 'BROWSER-FINGERPRINT', JSON.stringify(fingerprint));

            return { context: safeContext, fingerprint };
        } catch (error) {
            if (browser) {
                await browser.close().catch(() => {});
            }
            throw error;
        }
    }

    private formatProxyServer(proxy: AccountProxy): string {
        try {
            const urlObj = new URL(proxy.url)
            const protocol = urlObj.protocol.replace(':', '')
            return `${protocol}://${urlObj.hostname}:${proxy.port}`
        } catch {
            return `${proxy.url}:${proxy.port}`
        }
    }

async generateFingerprint(isMobile: boolean) {
        const fingerPrintData = new FingerprintGenerator().getFingerprint({
            devices: isMobile ? ['mobile'] : ['desktop'],
            operatingSystems: isMobile ? ['android', 'ios'] : ['windows', 'linux'],
            browsers: [{ name: 'edge' }]
        })

        const userAgentManager = new UserAgentManager(this.bot)
        const updatedFingerPrintData = await userAgentManager.updateFingerprintUserAgent(fingerPrintData, isMobile)

        ;(updatedFingerPrintData as any).createdAt = Date.now()

        return updatedFingerPrintData
    }
}

export default Browser