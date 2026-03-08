import type { FBWebhookEntry } from './types.js';
type BroadcastFn = (event: string, data: any) => void;
export declare function setWebhookBroadcast(fn: BroadcastFn): void;
export declare function processWebhookEntries(entries: FBWebhookEntry[]): Promise<void>;
export {};
