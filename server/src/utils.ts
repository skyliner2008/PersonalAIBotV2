// ============================================================
// Shared Utility Functions
// ============================================================

/**
 * Strip <think>, <reasoning> and similar AI model internal tags
 * from response text. Handles both complete and unclosed tags.
 */
export function stripThinkTags(text: string): string {
    let result = text;
    // Remove complete think/reasoning blocks
    result = result.replace(/<think>[\s\S]*?<\/think>/gi, '');
    result = result.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
    // Remove unclosed tags (from tag to end of string)
    result = result.replace(/<think>[\s\S]*$/gi, '');
    result = result.replace(/<reasoning>[\s\S]*$/gi, '');
    // Remove any remaining orphan tags
    result = result.replace(/<\/?think>/gi, '');
    result = result.replace(/<\/?reasoning>/gi, '');
    // Clean up leading whitespace/newlines
    result = result.replace(/^[\s\n]*/, '');
    return result.trim();
}

/**
 * Delay execution for a given number of milliseconds.
 */
export function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a random integer between min and max (inclusive).
 */
export function randomBetween(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Safely parse JSON with a fallback value.
 */
export function safeJsonParse<T>(str: string, fallback: T): T {
    try {
        return JSON.parse(str);
    } catch {
        return fallback;
    }
}

/**
 * Simple LRU Cache implementation for in-memory caching.
 */
export class LRUCache<K, V> {
    private cache = new Map<K, V>();
    private readonly maxSize: number;

    constructor(maxSize: number) {
        this.maxSize = maxSize;
    }

    get(key: K): V | undefined {
        const value = this.cache.get(key);
        if (value !== undefined) {
            // Move to end (most recently used)
            this.cache.delete(key);
            this.cache.set(key, value);
        }
        return value;
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            // Delete oldest entry (first key)
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    delete(key: K): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}
