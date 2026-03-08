/** Platform-prefixed chat ID */
export type ChatId = string;
/** Core Memory block — always injected into system prompt */
export interface CoreMemoryBlock {
    label: string;
    value: string;
    updatedAt: string;
}
/** Message stored in working/recall memory */
export interface MemoryMessage {
    id?: number;
    chatId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt?: string;
}
/** Archival memory fact with embedding */
export interface ArchivalFact {
    id?: number;
    chatId: string;
    fact: string;
    embedding?: Float32Array;
    createdAt?: string;
}
/** Full memory context built for a single AI request */
export interface MemoryContext {
    /** Core Memory text — always in system prompt */
    coreMemoryText: string;
    /** Recent messages for conversation context */
    workingMessages: MemoryMessage[];
    /** Relevant archival facts */
    archivalFacts: string[];
    /** Token estimate for the full context */
    tokenEstimate: number;
    /** Stats about memory layers */
    stats: {
        coreBlocks: number;
        workingMessages: number;
        archivalFacts: number;
    };
}
/** Options for buildContext */
export interface BuildContextOptions {
    /** Max recent messages to include (default: 5) */
    maxRecent?: number;
    /** Max archival facts to include (default: 3) */
    maxArchival?: number;
    /** Minimum similarity score for archival search (default: 0.65) */
    archivalThreshold?: number;
    /** Skip archival search (for simple queries) */
    skipArchival?: boolean;
}
