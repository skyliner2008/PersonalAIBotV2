import { describe, it, expect, vi } from 'vitest';

// Mock the cliCommandExecutor import that terminalUtils depends on
vi.mock('../../terminal/cliCommandExecutor.js', () => ({
  stripAnsi: (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ''),
}));

import { extractJsonObjectsFromText } from '../../terminal/terminalUtils.js';

describe('extractJsonObjectsFromText', () => {
  it('extracts a single JSON object', () => {
    const text = 'Some prefix { "key": "value" } some suffix';
    const result = extractJsonObjectsFromText(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{ "key": "value" }');
  });

  it('extracts multiple JSON objects', () => {
    const text = '{"a":1} text {"b":2}';
    const result = extractJsonObjectsFromText(text);
    expect(result).toHaveLength(2);
  });

  it('handles nested JSON objects', () => {
    const text = '{"outer":{"inner":"val"}}';
    const result = extractJsonObjectsFromText(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"outer":{"inner":"val"}}');
  });

  it('returns empty for no JSON', () => {
    expect(extractJsonObjectsFromText('hello world')).toHaveLength(0);
    expect(extractJsonObjectsFromText('')).toHaveLength(0);
  });

  it('handles strings with curly braces inside quotes', () => {
    const text = '{"msg":"hello {world}"}';
    const result = extractJsonObjectsFromText(text);
    expect(result).toHaveLength(1);
  });

  it('handles escaped quotes inside strings', () => {
    const text = '{"msg":"say \\"hello\\""}';
    const result = extractJsonObjectsFromText(text);
    expect(result).toHaveLength(1);
  });

  it('respects maxObjects limit', () => {
    const text = '{"a":1} {"b":2} {"c":3} {"d":4} {"e":5}';
    const result = extractJsonObjectsFromText(text, 2);
    expect(result).toHaveLength(2);
  });

  it('handles malformed JSON gracefully (unclosed brace)', () => {
    const text = '{"key": "value"';
    const result = extractJsonObjectsFromText(text);
    expect(result).toHaveLength(0);
  });

  it('handles token usage format from Gemini CLI', () => {
    const text = 'Generating...\n{"prompt_tokens": 150, "completion_tokens": 200, "total_tokens": 350}\nDone.';
    const result = extractJsonObjectsFromText(text);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]);
    expect(parsed.prompt_tokens).toBe(150);
    expect(parsed.total_tokens).toBe(350);
  });
});
