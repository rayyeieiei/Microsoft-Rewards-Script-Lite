import { randomBytes } from 'crypto'
import type { Page } from 'patchright'

import { Workers } from '../../Workers'

import type { BasePromotion } from '../../../interface/DashboardData'

export class SearchOnBing extends Workers {
    private bingHome = 'https://bing.com'
    private success: boolean = false
    private gainedPoints: number = 0
    private oldBalance: number = 0 // Inisialisasi awal 0

    public async doSearchOnBing(promotion: BasePromotion, page: Page) {
        const offerId = promotion.offerId
        this.oldBalance = Number(this.bot.userData.currentPoints ?? 0)
        this.success = false // Reset status sukses

        this.bot.logger.info(
            this.bot.isMobile,
            'SEARCH-ON-BING',
            `Starting SearchOnBing | offerId=${offerId} | title="${promotion.title}"`
        )

        try {
            const queries = await this.getSearchQueries(promotion)
            await this.searchBing(page, queries)

            if (this.success) {
                this.bot.logger.info(this.bot.isMobile, 'SEARCH-ON-BING', `Successfully completed | offerId=${offerId}`, 'green')
            }
        } catch (error) {
            this.bot.logger.error(this.bot.isMobile, 'SEARCH-ON-BING', `Fatal Error | offerId=${offerId} | ${error instanceof Error ? error.message : String(error)}`)
        }
    }

    private async searchBing(page: Page, queries: string[]) {
        queries = [...new Set(queries)]
        let i = 0

        for (const query of queries) {
            try {
                this.bot.logger.debug(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Searching: "${query}"`)

                const cvid = randomBytes(16).toString('hex')
                // FIXED: Menggunakan parameter 'page', bukan 'this.bot.mainMobilePage'
                const url = `${this.bingHome}/search?q=${encodeURIComponent(query)}&PC=U531&FORM=ANNTA1&cvid=${cvid}`

                await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 }).catch(() => {})
                await this.bot.browser.utils.tryDismissAllMessages(page)

                const searchBar = '#sb_form_q'
                await page.waitForSelector(searchBar, { state: 'attached', timeout: 10000 }).catch(() => {})

                // Animasi ketik biar lebih manusiawi
                await page.click(searchBar, { clickCount: 3 }).catch(() => {})
                await page.keyboard.press('Backspace').catch(() => {})
                await page.keyboard.type(query, { delay: 50 })
                await page.keyboard.press('Enter')

                await this.bot.utils.wait(this.bot.utils.randomDelay(7000, 10000))

                const newBalance = await this.bot.browser.func.getCurrentPoints()
                this.gainedPoints = newBalance - this.oldBalance

                if (this.gainedPoints > 0) {
                    this.bot.userData.currentPoints = newBalance
                    this.bot.userData.gainedPoints = (this.bot.userData.gainedPoints ?? 0) + this.gainedPoints
                    this.success = true
                    return // Poin sudah masuk, berhenti loop
                } else {
                    this.bot.logger.warn(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `${++i}/${queries.length} | No points yet...`)
                }
            } catch (error) {
                this.bot.logger.error(this.bot.isMobile, 'SEARCH-ON-BING-SEARCH', `Loop error: ${query}`)
            } finally {
                await this.bot.utils.wait(this.bot.utils.randomDelay(3000, 5000))
            }
        }
    }



    private async getSearchQueries(promotion: BasePromotion): Promise<string[]> {
        // ... (Fungsi getSearchQueries tetap seperti aslinya karena sudah bagus)
        // Pastikan lu copy bagian remote fetching lu yang tadi ke sini
        return [promotion.title] // Fallback sederhana (silakan pakai logika lengkap lu)
    }
}
