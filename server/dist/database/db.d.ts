import { type Database as SqliteDatabase } from 'better-sqlite3';
export declare function initDb(): Promise<SqliteDatabase>;
export declare function getDb(): SqliteDatabase;
export declare function getSetting(key: string): string | null;
export declare function setSetting(key: string, value: string): void;
export declare function addLog(type: string, action: string, details?: string, level?: string): void;
export declare function getRecentLogs(limit?: number): any[];
export declare function getDefaultPersona(): any;
export declare function getAllPersonas(): any[];
export declare function getConversation(id: string): any;
export declare function upsertConversation(id: string, fbUserId: string, fbUserName: string): void;
export declare function getConversationMessages(convId: string, limit?: number): any[];
export declare function addMessage(convId: string, role: string, content: string, fbMessageId?: string): void;
export declare function getConversationSummary(convId: string): {
    summary: string;
    summaryMsgCount: number;
};
export declare function updateConversationSummary(convId: string, summary: string, msgCount: number): void;
export declare function getMessageCount(convId: string): number;
export declare function getUserProfile(userId: string): any;
export declare function upsertUserProfile(userId: string, displayName: string, facts: string[], tags: string[], totalMessages: number): void;
export declare function findQAMatch(question: string): any | null;
export declare function dbAll(sql: string, params?: any[]): any[];
export declare function dbGet(sql: string, params?: any[]): any;
export declare function dbRun(sql: string, params?: any[]): void;
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
