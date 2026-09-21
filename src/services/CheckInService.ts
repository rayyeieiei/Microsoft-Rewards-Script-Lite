import crypto from 'crypto'
import { HttpClient } from '../core/HttpClient'
import { DapiActivityClaimPayload, DapiActivityResponse } from '../types/DapiTypes'

export const DAPI_ACTIVITIES_URL = 'https://prod.rewardsplatform.microsoft.com/dapi/me/activities'
export const DAILY_CHECKIN_OFFER_ID = 'Gamification_Sapphire_DailyCheckIn'

export interface CheckInResult {
    claimed: boolean
    balance?: number
    message?: string
}

export class CheckInService {
    private client: HttpClient
    private country: string

    constructor(client: HttpClient, country: string = 'ID') {
        this.client = client
        this.country = country
    }

    /**
     * Claims the Daily Check-In activity via DAPI.
     */
    public async claimDailyCheckIn(accessToken: string): Promise<CheckInResult> {
        const payload: DapiActivityClaimPayload = {
            id: crypto.randomUUID(),
            amount: 1,
            type: 101,
            attributes: {
                offerid: DAILY_CHECKIN_OFFER_ID
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

            const data = response.data
            if (data?.error) {
                return {
                    claimed: false,
                    message: typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
                }
            }

            return {
                claimed: true,
                balance: data?.response?.balance
            }
        } catch (err: any) {
            const status = err.response?.status
            const errorMsg = err.response?.data?.error?.message || err.message
            if (status === 403) {
                throw new Error(
                    '[ACCOUNT_FLAGGED_OR_SUSPENDED] DAPI Check-In akses ditolak (HTTP 403): Akun dibatasi oleh sistem Microsoft'
                )
            }
            if (status === 400 || status === 409) {
                return {
                    claimed: false,
                    message: `Check-in sudah pernah diklaim hari ini (${status}): ${errorMsg}`
                }
            }
            throw new Error(`Gagal mengklaim Daily Check-In: ${errorMsg}`)
        }
    }
}
