// ============================================================
// Unit tests for memory utilities (pure-logic only)
// ============================================================
import { describe, it, expect } from 'vitest';

// ---- cosineSimilarity (replicated from unifiedMemory.ts) ----

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
}

// ---- escapeLikePattern (replicated from unifiedMemory.ts) ----

function escapeLikePattern(s: string): string {
    return s.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

describe('cosineSimilarity', () => {
    it('returns 1.0 for identical vectors', () => {
        const a = new Float32Array([1, 2, 3]);
        const b = new Float32Array([1, 2, 3]);
        expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for orthogonal vectors', () => {
        const a = new Float32Array([1, 0, 0]);
        const b = new Float32Array([0, 1, 0]);
        expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
    });

    it('returns -1.0 for opposite vectors', () => {
        const a = new Float32Array([1, 0, 0]);
        const b = new Float32Array([-1, 0, 0]);
        expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
    });

    it('returns 0 for empty arrays', () => {
        expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0);
    });

    it('returns 0 for zero vectors', () => {
        const a = new Float32Array([0, 0, 0]);
        const b = new Float32Array([1, 2, 3]);
        expect(cosineSimilarity(a, b)).toBe(0);
    });

    it('handles high-dimensional vectors', () => {
        const dim = 768; // typical embedding dimension
        const a = new Float32Array(dim).fill(0.5);
        const b = new Float32Array(dim).fill(0.5);
        expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
    });

    it('returns 0 for mismatched lengths', () => {
        const a = new Float32Array([1, 2]);
        const b = new Float32Array([1, 2, 3]);
        expect(cosineSimilarity(a, b)).toBe(0);
    });
});

describe('escapeLikePattern', () => {
    it('escapes % character', () => {
        expect(escapeLikePattern('100%')).toBe('100\\%');
    });

    it('escapes _ character', () => {
        expect(escapeLikePattern('hello_world')).toBe('hello\\_world');
    });

    it('escapes multiple occurrences', () => {
        expect(escapeLikePattern('%foo%_bar_')).toBe('\\%foo\\%\\_bar\\_');
    });

    it('returns unchanged string when no wildcards', () => {
        expect(escapeLikePattern('normal text')).toBe('normal text');
    });

    it('handles empty string', () => {
        expect(escapeLikePattern('')).toBe('');
    });
});
