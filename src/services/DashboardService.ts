import { HttpClient } from '../core/HttpClient'
import { DapiProfileResponse, DapiUserPromotion } from '../types/DapiTypes'

export const DAPI_ME_URL = 'https://prod.rewardsplatform.microsoft.com/dapi/me?channel=SAAndroid&options=613'

export interface DashboardSnapshot {
    balance: number
    checkInAvailable: boolean
    readToEarnMax: number
    readToEarnProgress: number
    readToEarnRemaining: number
    rawPromotions: DapiUserPromotion[]
}

export class DashboardService {
    private client: HttpClient

    constructor(client: HttpClient) {
        this.client = client
    }

    /**
     * Fetches user profile, point balance, and activity quotas from DAPI.
     */
    public async fetchDashboard(accessToken: string): Promise<DashboardSnapshot> {
        try {
            const response = await this.client.get<DapiProfileResponse>(DAPI_ME_URL, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'X-Rewards-Country': 'ID',
                    'X-Rewards-Language': 'en',
                    'X-Rewards-ismobile': 'true'
                }
            })

            const data = response.data
            if (!data || !data.response) {
                throw new Error('Respon DAPI profile tidak memiliki struktur response yang valid')
            }

            const res = data.response
            const balance =
                typeof res.balance === 'number'
                    ? res.balance
                    : typeof res.user?.balance === 'number'
                      ? res.user.balance
                      : 0

            const promotions: DapiUserPromotion[] = Array.isArray(res.promotions) ? res.promotions : []

        // Check-In evaluation
        let checkInAvailable = false
        const checkInPromo = promotions.find(
            p => p?.attributes?.offerid === 'Gamification_Sapphire_DailyCheckIn'
        )
        if (checkInPromo) {
            const complete = String(checkInPromo.attributes.complete || '').toLowerCase()
            checkInAvailable = complete !== 'true'
        }

        // Read to Earn evaluation
        let readToEarnMax = 30
        let readToEarnProgress = 0
        let readToEarnRemaining = 0

        const readPromo = promotions.find(
            p => p?.attributes?.offerid === 'ENUS_readarticle3_30points'
        )
        if (readPromo) {
            readToEarnMax = parseInt(readPromo.attributes.pointmax || '30', 10) || 30
            readToEarnProgress = parseInt(readPromo.attributes.pointprogress || '0', 10) || 0
            readToEarnRemaining = Math.max(0, readToEarnMax - readToEarnProgress)
        }

        return {
            balance,
            checkInAvailable,
            readToEarnMax,
            readToEarnProgress,
            readToEarnRemaining,
            rawPromotions: promotions
        }
    } catch (err: any) {
        if (err.response?.status === 403) {
            throw new Error(
                '[ACCOUNT_FLAGGED_OR_SUSPENDED] DAPI Profile akses ditolak (HTTP 403): Akun dibatasi oleh sistem Microsoft'
            )
        }
        throw err
    }
}
}

