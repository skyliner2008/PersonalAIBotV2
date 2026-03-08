// ============================================================
// Facebook Graph API — Core Module
// Send messages, manage posts, comments via Graph API
// ============================================================
import { addLog, getSetting } from '../database/db.js';
const DEFAULT_API_VERSION = 'v19.0';
// ---- Config helpers ----
export function getFBConfig() {
    return {
        appId: getSetting('fb_app_id') || process.env.FB_APP_ID || '',
        appSecret: getSetting('fb_app_secret') || process.env.FB_APP_SECRET || '',
        pageAccessToken: getSetting('fb_page_access_token') || process.env.FB_PAGE_ACCESS_TOKEN || '',
        pageId: getSetting('fb_page_id') || process.env.FB_PAGE_ID || '',
        verifyToken: getSetting('fb_verify_token') || process.env.FB_VERIFY_TOKEN || 'fbai_verify_2024',
        apiVersion: getSetting('fb_api_version') || DEFAULT_API_VERSION,
    };
}
export function isFBConfigured() {
    const cfg = getFBConfig();
    return !!(cfg.pageAccessToken && cfg.pageId);
}
// ---- Base API call ----
async function graphFetch(endpoint, method = 'GET', body, customToken) {
    const cfg = getFBConfig();
    const token = customToken || cfg.pageAccessToken;
    const baseUrl = `https://graph.facebook.com/${cfg.apiVersion}`;
    const url = new URL(`${baseUrl}${endpoint}`);
    if (method === 'GET' && token) {
        url.searchParams.set('access_token', token);
    }
    try {
        const options = {
            method,
            headers: { 'Content-Type': 'application/json' },
        };
        if (method !== 'GET' && body) {
            options.body = JSON.stringify({ ...body, access_token: token });
        }
        const res = await fetch(url.toString(), options);
        const data = await res.json();
        if (data.error) {
            addLog('fb-api', 'Graph API Error', `${data.error.message} (code: ${data.error.code})`, 'error');
            return null;
        }
        return data;
    }
    catch (e) {
        addLog('fb-api', 'Graph API Fetch Error', e.message, 'error');
        return null;
    }
}
// ============================================================
// MESSAGING — Send Message via Conversations API
// ============================================================
export async function sendMessage(recipientId, text) {
    const cfg = getFBConfig();
    const result = await graphFetch(`/${cfg.pageId}/messages`, 'POST', {
        recipient: { id: recipientId },
        message: { text },
        messaging_type: 'RESPONSE',
    });
    if (result) {
        addLog('fb-api', 'Message sent', `To: ${recipientId}, Text: "${text.substring(0, 50)}"`, 'success');
    }
    return result;
}
export async function sendTypingAction(recipientId, action = 'typing_on') {
    const cfg = getFBConfig();
    const result = await graphFetch(`/${cfg.pageId}/messages`, 'POST', {
        recipient: { id: recipientId },
        sender_action: action,
    });
    return !!result;
}
// ============================================================
// PAGES — Get page info & connected pages
// ============================================================
export async function getPageInfo() {
    const cfg = getFBConfig();
    if (!cfg.pageId)
        return null;
    return graphFetch(`/${cfg.pageId}?fields=id,name,category,picture,fan_count`);
}
export async function getConnectedPages(userAccessToken) {
    const result = await graphFetch('/me/accounts?fields=id,name,category,access_token,picture', 'GET', undefined, userAccessToken);
    return result?.data || [];
}
// ============================================================
// POSTS — Create, read, delete
// ============================================================
export async function getPagePosts(limit = 10) {
    const cfg = getFBConfig();
    const result = await graphFetch(`/${cfg.pageId}/posts?fields=id,message,created_time,full_picture,permalink_url,likes.summary(true),comments.summary(true),shares&limit=${limit}`);
    return result?.data || [];
}
export async function createPagePost(message, link, imageUrl) {
    const cfg = getFBConfig();
    const body = { message };
    if (link)
        body.link = link;
    let endpoint = `/${cfg.pageId}/feed`;
    // If image URL, use photos endpoint
    if (imageUrl) {
        endpoint = `/${cfg.pageId}/photos`;
        body.url = imageUrl;
        body.caption = message;
        delete body.message;
    }
    const result = await graphFetch(endpoint, 'POST', body);
    if (result) {
        addLog('fb-api', 'Post created', `ID: ${result.id}`, 'success');
    }
    return result;
}
export async function deletePost(postId) {
    const result = await graphFetch(`/${postId}`, 'DELETE');
    return result?.success || false;
}
// ============================================================
// COMMENTS — Read & reply
// ============================================================
export async function getPostComments(postId, limit = 25) {
    const result = await graphFetch(`/${postId}/comments?fields=id,message,from,created_time,like_count,comment_count,parent&limit=${limit}`);
    return result?.data || [];
}
export async function replyToComment(commentId, message) {
    const result = await graphFetch(`/${commentId}/comments`, 'POST', { message });
    if (result) {
        addLog('fb-api', 'Comment replied', `To: ${commentId}, Text: "${message.substring(0, 50)}"`, 'success');
    }
    return result;
}
export async function likeComment(commentId) {
    const result = await graphFetch(`/${commentId}/likes`, 'POST');
    return result?.success || false;
}
// ============================================================
// CONVERSATIONS — List conversations
// ============================================================
export async function getPageConversations(limit = 20) {
    const cfg = getFBConfig();
    const result = await graphFetch(`/${cfg.pageId}/conversations?fields=id,participants,updated_time,snippet,unread_count,message_count&limit=${limit}`);
    return result?.data || [];
}
export async function getConversationMessages(conversationId, limit = 20) {
    const result = await graphFetch(`/${conversationId}/messages?fields=id,message,from,created_time,attachments&limit=${limit}`);
    return result?.data || [];
}
// ============================================================
// TOKEN MANAGEMENT
// ============================================================
export async function debugToken(token) {
    const cfg = getFBConfig();
    if (!cfg.appId || !cfg.appSecret) {
        return { error: 'App ID and App Secret are required for token debug' };
    }
    const url = `https://graph.facebook.com/debug_token?input_token=${token}&access_token=${cfg.appId}|${cfg.appSecret}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        return data.data || data;
    }
    catch (e) {
        return { error: e.message };
    }
}
export async function exchangeForLongLivedToken(shortLivedToken) {
    const cfg = getFBConfig();
    if (!cfg.appId || !cfg.appSecret)
        return null;
    const url = `https://graph.facebook.com/${cfg.apiVersion}/oauth/access_token?grant_type=fb_exchange_token&client_id=${cfg.appId}&client_secret=${cfg.appSecret}&fb_exchange_token=${shortLivedToken}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.access_token) {
            addLog('fb-api', 'Token exchanged', 'Got long-lived token', 'success');
            return data.access_token;
        }
        addLog('fb-api', 'Token exchange failed', data.error?.message || 'Unknown error', 'error');
        return null;
    }
    catch (e) {
        addLog('fb-api', 'Token exchange error', e.message, 'error');
        return null;
    }
}
// ============================================================
// WEBHOOK SUBSCRIPTION
// ============================================================
export async function subscribeAppToPage() {
    const cfg = getFBConfig();
    const result = await graphFetch(`/${cfg.pageId}/subscribed_apps`, 'POST', {
        subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_deliveries,message_reads,feed',
    });
    if (result?.success) {
        addLog('fb-api', 'Webhook subscribed', `Page ${cfg.pageId} subscribed to app`, 'success');
    }
    return result?.success || false;
}
//# sourceMappingURL=graphAPI.js.map