import type { FunctionDeclaration } from '@google/genai';
import type { BotContext, ToolHandlerMap } from '../types.js';
import { type SystemToolContext } from './system.js';
export type { BotContext, SystemToolContext };
export declare const sendFileToChatDeclaration: FunctionDeclaration;
export declare const createSendFileHandler: (ctx: BotContext) => ({ file_path, caption }: {
    file_path: string;
    caption?: string;
}) => Promise<string>;
export declare const memorySearchDeclaration: FunctionDeclaration;
export declare const memorySaveDeclaration: FunctionDeclaration;
export declare const tools: FunctionDeclaration[];
/**
 * Get all tools including dynamic ones
 */
export declare function getAllTools(): FunctionDeclaration[];
export declare const getFunctionHandlers: (ctx: BotContext, sysCtx?: SystemToolContext, chatId?: string) => ToolHandlerMap;
export declare function refreshDynamicToolsRegistry(): Promise<void>;
/** @deprecated Legacy */
export declare function setCurrentChatId(_chatId: string): void;
/** @deprecated Legacy */
export declare function getCurrentChatId(): string;
