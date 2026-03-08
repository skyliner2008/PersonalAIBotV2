export interface FBTokenInfo {
    accessToken: string;
    tokenType: string;
    expiresAt: number;
}
export interface FBPageToken {
    pageId: string;
    pageName: string;
    accessToken: string;
    category?: string;
}
export interface FBPage {
    id: string;
    name: string;
    category?: string;
    accessToken: string;
    picture?: {
        data: {
            url: string;
        };
    };
    fan_count?: number;
}
export interface FBWebhookEntry {
    id: string;
    time: number;
    messaging?: FBMessagingEvent[];
    changes?: FBChangeEvent[];
}
export interface FBMessagingEvent {
    sender: {
        id: string;
    };
    recipient: {
        id: string;
    };
    timestamp: number;
    message?: {
        mid: string;
        text: string;
        attachments?: FBAttachment[];
    };
    postback?: {
        title: string;
        payload: string;
    };
    read?: {
        watermark: number;
    };
    delivery?: {
        watermark: number;
        mids?: string[];
    };
}
export interface FBAttachment {
    type: 'image' | 'audio' | 'video' | 'file' | 'template' | 'fallback';
    payload: {
        url?: string;
        sticker_id?: number;
    };
}
export interface FBChangeEvent {
    field: string;
    value: {
        item?: string;
        verb?: string;
        comment_id?: string;
        parent_id?: string;
        post_id?: string;
        from: {
            id: string;
            name: string;
        };
        message?: string;
        created_time?: number;
    };
}
export interface FBSendMessageRequest {
    recipient: {
        id: string;
    };
    message: {
        text?: string;
        attachment?: FBAttachment;
    };
    messaging_type?: 'RESPONSE' | 'UPDATE' | 'MESSAGE_TAG';
}
export interface FBSendResponse {
    recipient_id: string;
    message_id: string;
}
export interface FBPost {
    id: string;
    message?: string;
    created_time: string;
    full_picture?: string;
    permalink_url?: string;
    likes?: {
        summary: {
            total_count: number;
        };
    };
    comments?: {
        summary: {
            total_count: number;
        };
    };
    shares?: {
        count: number;
    };
}
export interface FBComment {
    id: string;
    message: string;
    from: {
        id: string;
        name: string;
    };
    created_time: string;
    like_count?: number;
    comment_count?: number;
    parent?: {
        id: string;
    };
}
export interface FBApiConfig {
    appId: string;
    appSecret: string;
    pageAccessToken: string;
    pageId: string;
    verifyToken: string;
    apiVersion: string;
}
