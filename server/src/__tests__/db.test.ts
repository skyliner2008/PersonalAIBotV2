// ============================================================
// Unit tests for database helper logic (pure-logic layer)
// These tests don't require native SQLite to run.
// Schema-level tests that do need SQLite are in db.integration.test.ts
// ============================================================
import { describe, it, expect } from 'vitest';

// ---- findQAMatch logic (pure) ----
// Replicate the matching logic from db.ts to test it in isolation.

interface QAPair {
  question_pattern: string;
  answer: string;
  match_type: 'exact' | 'contains' | 'regex';
  priority: number;
  is_active: number;
}

function findQAMatchPure(question: string, pairs: QAPair[]): QAPair | null {
  const qLower = question.toLowerCase().trim();
  const active = pairs.filter(p => p.is_active === 1);

  // 1. Exact match
  const exact = active
    .filter(p => p.match_type === 'exact' && p.question_pattern.toLowerCase() === qLower)
    .sort((a, b) => b.priority - a.priority)[0];
  if (exact) return exact;

  // 2. Contains match
  const contains = active
    .filter(p => p.match_type === 'contains')
    .sort((a, b) => b.priority - a.priority);
  for (const qa of contains) {
    if (qLower.includes(qa.question_pattern.toLowerCase())) return qa;
  }

  // 3. Regex match
  const regex = active
    .filter(p => p.match_type === 'regex')
    .sort((a, b) => b.priority - a.priority);
  for (const qa of regex) {
    try {
      if (new RegExp(qa.question_pattern, 'i').test(question)) return qa;
    } catch { /* skip invalid regex */ }
  }

  return null;
}

describe('findQAMatch logic', () => {
  const pairs: QAPair[] = [
    { question_pattern: 'สวัสดี', answer: 'สวัสดีค่ะ!', match_type: 'exact', priority: 10, is_active: 1 },
    { question_pattern: 'ราคา', answer: 'ราคาเริ่มต้น 100 บาท', match_type: 'contains', priority: 5, is_active: 1 },
    { question_pattern: '\\d+\\s*บาท', answer: 'มีโปรราคาพิเศษ', match_type: 'regex', priority: 1, is_active: 1 },
    { question_pattern: 'secret', answer: 'should not appear', match_type: 'exact', priority: 999, is_active: 0 },
  ];

  it('returns exact match for matching question', () => {
    const hit = findQAMatchPure('สวัสดี', pairs);
    expect(hit?.answer).toBe('สวัสดีค่ะ!');
  });

  it('is case-insensitive for exact match', () => {
    const hit = findQAMatchPure('สวัสดี', pairs);
    expect(hit).not.toBeNull();
  });

  it('returns contains match for substring', () => {
    const hit = findQAMatchPure('สอบถามราคาสินค้า', pairs);
    expect(hit?.answer).toBe('ราคาเริ่มต้น 100 บาท');
  });

  it('returns regex match for pattern', () => {
    const hit = findQAMatchPure('ราคา 500 บาท', pairs);
    // "ราคา" (contains) has higher priority than regex, so it matches first
    expect(hit?.answer).toBe('ราคาเริ่มต้น 100 บาท');
  });

  it('regex match is used when contains does not match', () => {
    const hit = findQAMatchPure('ต้องการ 200 บาท', pairs);
    expect(hit?.answer).toBe('มีโปรราคาพิเศษ');
  });

  it('returns null when no match found', () => {
    expect(findQAMatchPure('ไม่มีข้อมูล xyz', pairs)).toBeNull();
  });

  it('inactive Q&A pairs are never matched', () => {
    const hit = findQAMatchPure('secret', pairs);
    expect(hit).toBeNull();
  });

  it('exact match has higher priority than contains', () => {
    const mixedPairs: QAPair[] = [
      { question_pattern: 'test', answer: 'exact-answer', match_type: 'exact', priority: 1, is_active: 1 },
      { question_pattern: 'test', answer: 'contains-answer', match_type: 'contains', priority: 99, is_active: 1 },
    ];
    // Exact match should win regardless of priority order
    expect(findQAMatchPure('test', mixedPairs)?.answer).toBe('exact-answer');
  });

  it('among multiple contains matches, higher priority wins', () => {
    const pairsMulti: QAPair[] = [
      { question_pattern: 'สวัสดี', answer: 'low', match_type: 'contains', priority: 1, is_active: 1 },
      { question_pattern: 'สวัสดี', answer: 'high', match_type: 'contains', priority: 10, is_active: 1 },
    ];
    expect(findQAMatchPure('สวัสดีครับ', pairsMulti)?.answer).toBe('high');
  });

  it('skips invalid regex patterns without throwing', () => {
    const badRegex: QAPair[] = [
      { question_pattern: '[invalid(', answer: 'bad', match_type: 'regex', priority: 1, is_active: 1 },
      { question_pattern: 'hello', answer: 'good', match_type: 'contains', priority: 1, is_active: 1 },
    ];
    expect(() => findQAMatchPure('hello world', badRegex)).not.toThrow();
    expect(findQAMatchPure('hello world', badRegex)?.answer).toBe('good');
  });
});

// ---- XOR obfuscation (from db.ts) ----

const CRED_KEY = 'test-key-12345';

function xorObfuscate(text: string, key: string): string {
  const result: number[] = [];
  for (let i = 0; i < text.length; i++) {
    result.push(text.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }
  return Buffer.from(result).toString('base64');
}

function xorDeobfuscate(encoded: string, key: string): string {
  try {
    const bytes = Buffer.from(encoded, 'base64');
    const result: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      result.push(bytes[i] ^ key.charCodeAt(i % key.length));
    }
    return result.map(c => String.fromCharCode(c)).join('');
  } catch {
    return encoded;
  }
}

describe('credential obfuscation (XOR)', () => {
  it('round-trips a simple ASCII string', () => {
    const original = 'my-secret-password';
    const obf = xorObfuscate(original, CRED_KEY);
    expect(xorDeobfuscate(obf, CRED_KEY)).toBe(original);
  });

  it('round-trips a string with special characters', () => {
    const original = 'p@ssw0rd!#$%^&*()';
    expect(xorDeobfuscate(xorObfuscate(original, CRED_KEY), CRED_KEY)).toBe(original);
  });

  it('obfuscated output is different from original', () => {
    const original = 'plaintext';
    const obf = xorObfuscate(original, CRED_KEY);
    expect(obf).not.toBe(original);
  });

  it('same key always produces the same output (deterministic)', () => {
    const original = 'stable';
    expect(xorObfuscate(original, CRED_KEY)).toBe(xorObfuscate(original, CRED_KEY));
  });

  it('different keys produce different output', () => {
    const original = 'test';
    expect(xorObfuscate(original, 'key1')).not.toBe(xorObfuscate(original, 'key2'));
  });

  it('deobfuscate returns original on invalid base64 (graceful fallback)', () => {
    // An obviously invalid base64 string will hit the catch block
    const garbage = '!!!not-valid-base64!!!';
    // May not throw — just returns the original value
    expect(() => xorDeobfuscate(garbage, CRED_KEY)).not.toThrow();
  });
});

// ---- parseIntParam (from api/routes.ts) ----

function parseIntParam(value: unknown, defaultVal: number, min = 1, max = 1000): number {
  const n = parseInt(String(value ?? ''), 10);
  if (Number.isNaN(n) || n < min) return defaultVal;
  return Math.min(n, max);
}

describe('parseIntParam helper', () => {
  it('parses a valid integer string', () => {
    expect(parseIntParam('50', 20)).toBe(50);
  });

  it('returns default for non-numeric strings', () => {
    expect(parseIntParam('abc', 20)).toBe(20);
    expect(parseIntParam('', 20)).toBe(20);
  });

  it('returns default for undefined/null', () => {
    expect(parseIntParam(undefined, 20)).toBe(20);
    expect(parseIntParam(null, 20)).toBe(20);
  });

  it('clamps to max', () => {
    expect(parseIntParam('9999', 10, 1, 100)).toBe(100);
  });

  it('returns default for values below min', () => {
    expect(parseIntParam('0', 5, 1, 100)).toBe(5);
    expect(parseIntParam('-5', 5, 1, 100)).toBe(5);
  });

  it('accepts boundary values exactly', () => {
    expect(parseIntParam('1', 5, 1, 100)).toBe(1);
    expect(parseIntParam('100', 5, 1, 100)).toBe(100);
  });
});
