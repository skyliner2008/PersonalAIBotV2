// ============================================================
// Unit tests for src/utils.ts
// ============================================================
import { describe, it, expect } from 'vitest';
import { stripThinkTags, randomBetween, safeJsonParse, LRUCache } from '../utils.js';

// ---- stripThinkTags ----------------------------------------

describe('stripThinkTags', () => {
  it('removes a complete <think> block', () => {
    const input = '<think>internal reasoning</think>Hello!';
    expect(stripThinkTags(input)).toBe('Hello!');
  });

  it('removes an unclosed <think> tag to end-of-string', () => {
    const input = 'Answer: yes <think>thinking...';
    expect(stripThinkTags(input)).toBe('Answer: yes');
  });

  it('removes a complete <reasoning> block', () => {
    const input = '<reasoning>step 1</reasoning>Result';
    expect(stripThinkTags(input)).toBe('Result');
  });

  it('handles case-insensitivity', () => {
    const input = '<THINK>private</THINK>public';
    expect(stripThinkTags(input)).toBe('public');
  });

  it('returns original text when no tags present', () => {
    expect(stripThinkTags('plain text')).toBe('plain text');
  });

  it('trims leading whitespace/newlines after stripping', () => {
    const input = '<think>...</think>\n\n  Hello';
    expect(stripThinkTags(input)).toBe('Hello');
  });

  it('handles empty string', () => {
    expect(stripThinkTags('')).toBe('');
  });

  it('removes orphan closing tag', () => {
    const input = 'hi </think> there';
    expect(stripThinkTags(input)).toBe('hi  there');
  });
});

// ---- randomBetween -----------------------------------------

describe('randomBetween', () => {
  it('returns a number within [min, max]', () => {
    for (let i = 0; i < 100; i++) {
      const n = randomBetween(5, 10);
      expect(n).toBeGreaterThanOrEqual(5);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  it('returns the only value when min === max', () => {
    expect(randomBetween(7, 7)).toBe(7);
  });

  it('returns an integer', () => {
    for (let i = 0; i < 20; i++) {
      expect(Number.isInteger(randomBetween(0, 100))).toBe(true);
    }
  });
});

// ---- safeJsonParse -----------------------------------------

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 });
    expect(safeJsonParse('[1,2,3]', [])).toEqual([1, 2, 3]);
  });

  it('returns fallback for invalid JSON', () => {
    expect(safeJsonParse('not json', null)).toBe(null);
    expect(safeJsonParse('', [])).toEqual([]);
  });

  it('returns fallback for empty string', () => {
    expect(safeJsonParse('', 'fallback')).toBe('fallback');
  });
});

// ---- LRUCache ----------------------------------------------

describe('LRUCache', () => {
  it('stores and retrieves values', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('returns undefined for missing keys', () => {
    const cache = new LRUCache<string, number>(3);
    expect(cache.get('missing')).toBeUndefined();
  });

  it('evicts the least recently used item when capacity exceeded', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Access 'a' to make it recently used
    cache.get('a');
    // Now add 'd' — should evict 'b' (oldest unused)
    cache.set('d', 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('reports correct size', () => {
    const cache = new LRUCache<string, string>(10);
    cache.set('x', 'foo');
    cache.set('y', 'bar');
    expect(cache.size).toBe(2);
  });

  it('deletes entries', () => {
    const cache = new LRUCache<string, number>(5);
    cache.set('k', 99);
    cache.delete('k');
    expect(cache.get('k')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('clear() empties the cache', () => {
    const cache = new LRUCache<string, number>(5);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('updates existing key without growing', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('a', 99);
    expect(cache.get('a')).toBe(99);
    expect(cache.size).toBe(1);
  });
});
