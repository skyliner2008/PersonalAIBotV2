import { type Database as SqliteDatabase } from 'better-sqlite3';
export interface ActivityLog {
    id: number;
    type: string;
    action: string;
    details: string | null;
    level: 'info' | 'success' | 'warning' | 'error';
    created_at: string;
}
export interface Persona {
    id: string;
    name: string;
    description: string | null;
    system_prompt: string;
    personality_traits: string | null;
    speaking_style: string | null;
    language: string;
    temperature: number;
    max_tokens: number;
    is_default: number;
    created_at: string;
    updated_at: string;
}
export interface Conversation {
    id: string;
    fb_user_id: string;
    fb_user_name: string | null;
    fb_avatar_url: string | null;
    last_message_at: string | null;
    summary: string;
    summary_msg_count: number;
    is_active: number;
    auto_reply: number;
    created_at: string;
    updated_at: string;
}
export interface MessageRow {
    id: number;
    conversation_id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    fb_message_id: string | null;
    timestamp: string;
}
export interface UserProfile {
    user_id: string;
    display_name: string | null;
    facts: string;
    preferences: string;
    tags: string;
    total_messages: number;
    first_contact: string;
    updated_at: string;
}
export interface QAPair {
    id: number;
    question_pattern: string;
    answer: string;
    match_type: 'exact' | 'contains' | 'regex';
    category: string | null;
    priority: number;
    use_count: number;
    is_active: number;
    created_at: string;
}
/** Generic SQLite param type */
type SqlParam = string | number | null | Buffer;
export declare function initDb(): Promise<SqliteDatabase>;
export declare function getDb(): SqliteDatabase;
export declare function isDbInitialized(): boolean;
export declare function getSetting(key: string): string | null;
export declare function setSetting(key: string, value: string): void;
export declare function deleteSetting(key: string): void;
/** เก็บ credential แบบ AES-256-GCM encrypted */
export declare function setCredential(key: string, value: string): void;
/** อ่าน credential (auto-detect format: aes > obf(legacy) > plaintext) */
export declare function getCredential(key: string): string | null;
export declare function addLog(type: string, action: string, details?: string | null, level?: string): void;
export declare function getRecentLogs(limit?: number): ActivityLog[];
export declare function getDefaultPersona(): Persona | undefined;
export declare function getAllPersonas(): Persona[];
export declare function getConversation(id: string): Conversation | undefined;
export declare function upsertConversation(id: string, fbUserId: string, fbUserName: string): void;
export declare function getConversationMessages(convId: string, limit?: number): MessageRow[];
export declare function addMessage(convId: string, role: string, content: string, fbMessageId?: string): void;
export declare function getConversationSummary(convId: string): {
    summary: string;
    summaryMsgCount: number;
};
export declare function updateConversationSummary(convId: string, summary: string, msgCount: number): void;
export declare function getMessageCount(convId: string): number;
export declare function getUserProfile(userId: string): UserProfile | undefined;
export declare function upsertUserProfile(userId: string, displayName: string, facts: string[], tags: string[], totalMessages: number): void;
/** Clear regex cache (call when QA pairs are modified) */
export declare function clearRegexCache(): void;
export declare function findQAMatch(question: string): QAPair | null;
export declare function dbAll<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T[];
export declare function dbGet<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): T | undefined;
export declare function dbRun(sql: string, params?: SqlParam[]): void;
/**
 * Get database statistics for health monitoring
 */
export declare function getDbStats(): Record<string, number>;
/**
 * Clean up old activity logs (older than N days)
 */
export declare function cleanupOldLogs(daysOld?: number): number;
/**
 * Clean up old processed message IDs (older than N days)
 */
export declare function cleanupOldProcessedMessages(daysOld?: number): number;
/**
 * Track LLM token usage for the Self-Upgrade system and calculate approximate cost.
 * Calculates cost dynamically based on model name.
 */
export declare function trackUpgradeTokens(model: string, tokensIn: number, tokensOut: number): void;
export {};
