export interface DapiUserPromotion {
    attributes: {
        offerid?: string
        complete?: string
        pointmax?: string
        pointprogress?: string
        type?: string
        [key: string]: any
    }
    name?: string
    [key: string]: any
}

export interface DapiProfileResponse {
    response: {
        balance?: number
        user?: {
            balance?: number
            [key: string]: any
        }
        promotions?: DapiUserPromotion[]
        [key: string]: any
    }
    error?: any
}

export interface DapiActivityClaimPayload {
    id: string
    amount: number
    type: number
    attributes: {
        offerid: string
        [key: string]: any
    }
    country: string
}

export interface DapiActivityResponse {
    response?: {
        balance?: number
        status?: string
        [key: string]: any
    }
    error?: any
}

export interface MsnSubCard {
    id?: string
    [key: string]: any
}

export interface MsnCard {
    id?: string
    title?: string
    url?: string
    subCards?: MsnSubCard[]
    [key: string]: any
}

export interface MsnSection {
    cards?: MsnCard[]
    [key: string]: any
}

export interface MsnNewsFeedResponse {
    sections?: MsnSection[]
    [key: string]: any
}

export interface OAuthTokenResponse {
    token_type: string
    scope: string
    expires_in: number
    ext_expires_in?: number
    access_token: string
    refresh_token?: string
    id_token?: string
    user_id?: string
}
