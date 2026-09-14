import type { MicrosoftRewardsBot } from '../index'
import type { Page } from 'patchright'
import { SearchOnBing } from './activities/browser/SearchOnBing'
import { Search } from './activities/browser/Search'
import type { BasePromotion, DashboardData } from '../interface/DashboardData'

export default class Activities {
    constructor(private bot: MicrosoftRewardsBot) {}

    doSearch = async (data: DashboardData, page: Page, isMobile: boolean) =>
        await new Search(this.bot).doSearch(data, page, isMobile)

    doSearchOnBing = async (promotion: BasePromotion, page: Page) =>
        await new SearchOnBing(this.bot).doSearchOnBing(promotion, page)
}
