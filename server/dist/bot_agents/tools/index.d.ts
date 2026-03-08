import { FunctionDeclaration } from '@google/genai';
export interface BotContext {
    platform: 'telegram' | 'line';
    replyWithFile: (filePath: string, caption?: string) => Promise<string>;
}
export declare const sendFileToChatDeclaration: FunctionDeclaration;
export declare const createSendFileHandler: (ctx: BotContext) => ({ file_path, caption }: {
    file_path: string;
    caption?: string;
}) => Promise<string>;
export declare const tools: FunctionDeclaration[];
export declare const getFunctionHandlers: (ctx: BotContext) => Record<string, Function>;
