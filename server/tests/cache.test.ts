import { describe, it, expect, beforeEach } from 'vitest';
import { LRUCache } from '../src/utils/cache.js';

describe('LRUCache', () => {
  let cache: LRUCache<string>;

  beforeEach(() => {
    cache = new LRUCache<string>({ maxSizeMB: 1, defaultTTLMinutes: 60 });
  });

  it('should set and get values', () => {
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('should return undefined for missing keys', () => {
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('should track hits and misses', () => {
    cache.set('a', 'val');
    cache.get('a');       // hit
    cache.get('missing'); // miss

    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hitRate).toBe(50);
  });

  it('should expire entries after TTL', () => {
    cache.set('expire', 'val', 1); // 1ms TTL
    // Wait a tick
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(cache.get('expire')).toBeUndefined();
        resolve();
      }, 10);
    });
  });

  it('should evict LRU entries when full', () => {
    const tiny = new LRUCache<string>({ maxSizeMB: 0.0001, defaultTTLMinutes: 60 });
    // Fill cache past limit
    for (let i = 0; i < 100; i++) {
      tiny.set(`k${i}`, 'x'.repeat(50));
    }
    // Oldest should be evicted
    expect(tiny.get('k0')).toBeUndefined();
    // Most recent should still exist
    expect(tiny.get('k99')).toBe('x'.repeat(50));
  });

  it('should delete entries', () => {
    cache.set('del', 'val');
    expect(cache.has('del')).toBe(true);
    cache.delete('del');
    expect(cache.has('del')).toBe(false);
  });

  it('should clear all entries', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.stats.entries).toBe(0);
  });

  it('should prune expired entries', () => {
    cache.set('fresh', 'val', 999999);
    cache.set('stale', 'old', 1);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const pruned = cache.prune();
        expect(pruned).toBe(1);
        expect(cache.has('fresh')).toBe(true);
        expect(cache.has('stale')).toBe(false);
        resolve();
      }, 10);
    });
  });
});
