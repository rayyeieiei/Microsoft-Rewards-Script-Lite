import type { Page } from 'patchright'
import type { MicrosoftRewardsBot } from '../index'
import type { DashboardData } from '../interface/DashboardData'
import type { AppDashboardData } from '../interface/AppDashBoardData'

export class Workers {
    public bot: MicrosoftRewardsBot

    constructor(bot: MicrosoftRewardsBot) {
        this.bot = bot
    }

    public async doDailySet(data: DashboardData, page: Page) {
        this.bot.logger.info(
            this.bot.isMobile,
            'DAILY-SET',
            'Daily Set automated solving is disabled in Lite runtime (observer-only)'
        )
    }

    public async doMorePromotions(data: DashboardData, page: Page) {
        this.bot.logger.info(
            this.bot.isMobile,
            'MORE-PROMOTIONS',
            'More Promotions automated solving is disabled in Lite runtime (observer-only)'
        )
    }

    public async doAppPromotions(data: AppDashboardData) {
        this.bot.logger.info(
            this.bot.isMobile,
            'APP-PROMOTIONS',
            'App Promotions automated solving is disabled in Lite runtime (observer-only)'
        )
    }

    public async doSpecialPromotions(data: DashboardData, page: Page) {
        this.bot.logger.info(
            this.bot.isMobile,
            'SPECIAL-ACTIVITY',
            'Special promotions automated solving is disabled in Lite runtime (observer-only)'
        )
    }

    public async doPunchCards(data: DashboardData, page: Page) {
        this.bot.logger.info(
            this.bot.isMobile,
            'PUNCHCARD',
            'PunchCard automated solving is disabled in Lite runtime (observer-only)'
        )
    }
}
