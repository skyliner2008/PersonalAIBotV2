/**
 * LRU Cache with TTL
 *
 * In-memory cache for embeddings, classifications, and search results.
 * Prevents duplicate API calls and reduces token usage by 30-40%.
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  size: number;
}

export class LRUCache<T = unknown> {
  private cache = new Map<string, CacheEntry<T>>();
  private readonly maxSize: number;     // bytes
  private readonly defaultTTL: number;  // ms
  private currentSize = 0;
  private hits = 0;
  private misses = 0;

  constructor(opts: { maxSizeMB?: number; defaultTTLMinutes?: number } = {}) {
    this.maxSize = (opts.maxSizeMB ?? 10) * 1024 * 1024;
    this.defaultTTL = (opts.defaultTTLMinutes ?? 60) * 60 * 1000;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      this.misses++;
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    // Remove old entry if exists
    this.delete(key);

    const size = this.estimateSize(value);
    const entry: CacheEntry<T> = {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.defaultTTL),
      size,
    };

    // Evict LRU entries until we have space
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }

    this.cache.set(key, entry);
    this.currentSize += size;
  }

  delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      return this.cache.delete(key);
    }
    return false;
  }

  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return false;
    }
    return true;
  }

  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  /** Remove all expired entries */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  get stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      sizeMB: +(this.currentSize / 1024 / 1024).toFixed(2),
      maxSizeMB: +(this.maxSize / 1024 / 1024).toFixed(2),
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? +((this.hits / total) * 100).toFixed(1) : 0,
    };
  }

  private estimateSize(value: unknown): number {
    if (typeof value === 'string') return value.length * 2;
    if (Array.isArray(value)) {
      // For embedding vectors (number[])
      if (typeof value[0] === 'number') return value.length * 8;
      return JSON.stringify(value).length * 2;
    }
    if (value && typeof value === 'object') {
      return JSON.stringify(value).length * 2;
    }
    return 64; // default estimate
  }
}

// ─── Singleton Caches ─────────────────────────────────────────

/** Embedding vectors: cache 7 days, 10MB max */
export const embeddingCache = new LRUCache<number[]>({
  maxSizeMB: 10,
  defaultTTLMinutes: 7 * 24 * 60, // 7 days
});

/** Task classification results: cache 24h, 1MB max */
export const classificationCache = new LRUCache<string>({
  maxSizeMB: 1,
  defaultTTLMinutes: 24 * 60, // 24 hours
});

/** Archival search results: cache 1h, 5MB max */
export const searchCache = new LRUCache<unknown[]>({
  maxSizeMB: 5,
  defaultTTLMinutes: 60, // 1 hour
});

/** Get combined stats for all caches */
export function getAllCacheStats() {
  return {
    embedding: embeddingCache.stats,
    classification: classificationCache.stats,
    search: searchCache.stats,
  };
}
