/**
 * Strip <think>, <reasoning> and similar AI model internal tags
 * from response text. Handles both complete and unclosed tags.
 */
export declare function stripThinkTags(text: string): string;
/**
 * Delay execution for a given number of milliseconds.
 */
export declare function delay(ms: number): Promise<void>;
/**
 * Generate a random integer between min and max (inclusive).
 */
export declare function randomBetween(min: number, max: number): number;
/**
 * Safely parse JSON with a fallback value.
 */
export declare function safeJsonParse<T>(str: string, fallback: T): T;
/**
 * Simple LRU Cache implementation for in-memory caching.
 */
export declare class LRUCache<K, V> {
    private cache;
    private readonly maxSize;
    constructor(maxSize: number);
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    delete(key: K): boolean;
    clear(): void;
    get size(): number;
}
