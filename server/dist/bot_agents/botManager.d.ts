import express from 'express';
/** Start a single bot by registry ID (uses stored app reference) */
export declare function startBotInstance(app: express.Express | null, botId: string): boolean;
/** Stop a single bot by registry ID */
export declare function stopBotInstance(botId: string): void;
/** Start all bots (called at server startup) */
export declare function startBots(app: express.Express): void;
/** Stop all bot agents gracefully */
export declare function stopBots(): void;
/** Get list of active bot IDs */
export declare function getActiveBotIds(): string[];
