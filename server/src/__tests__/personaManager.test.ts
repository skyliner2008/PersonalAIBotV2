// ============================================================
// Unit tests for persona tool name parsing logic
// Tests the exact regex fix: hyphens must be preserved
// ============================================================
import { describe, it, expect } from 'vitest';

// ---- Replicate the parsing pipeline from personaManager.ts ----
// Testing the logic directly avoids file I/O and ESM module caching issues.

/** Old (buggy) implementation — strips hyphens */
function parseToolsOld(toolsText: string): string[] {
  return toolsText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'))
    .map(line => line.replace(/[`*\-]/g, '').trim())  // BUG: strips hyphens
    .filter(Boolean);
}

/** New (fixed) implementation — preserves hyphens */
function parseToolsNew(toolsText: string): string[] {
  return toolsText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('//'))
    .map(line => line.replace(/^[`*\s]+|[`*\s]+$/g, '').trim())  // FIX: edge-only
    .filter(Boolean);
}

describe('parseTools — old (buggy) behaviour documents the bug', () => {
  it('OLD: incorrectly strips hyphens from tool names', () => {
    const result = parseToolsOld('web-search\nbrowser-navigate\n');
    expect(result).toContain('websearch');
    expect(result).toContain('browsernavigate');
    expect(result).not.toContain('web-search');
  });
});

describe('parseTools — new (fixed) behaviour', () => {
  it('preserves hyphens in tool names', () => {
    const result = parseToolsNew('web-search\nbrowser-navigate\n');
    expect(result).toContain('web-search');
    expect(result).toContain('browser-navigate');
    expect(result).not.toContain('websearch');
    expect(result).not.toContain('browsernavigate');
  });

  it('handles plain underscore-based names unchanged', () => {
    const result = parseToolsNew('get_current_time\necho_message\n');
    expect(result).toContain('get_current_time');
    expect(result).toContain('echo_message');
  });

  it('skips lines starting with # (comments)', () => {
    const text = `# Enabled Tools\nget_current_time\n# echo_message\n# web-search\n`;
    const result = parseToolsNew(text);
    expect(result).toContain('get_current_time');
    expect(result).not.toContain('echo_message');
    expect(result).not.toContain('web-search');
  });

  it('strips surrounding backticks from edges only', () => {
    const result = parseToolsNew('`get_current_time`\n`web-search`\n');
    expect(result).toContain('get_current_time');
    expect(result).toContain('web-search');
  });

  it('strips surrounding asterisks from edges only', () => {
    const result = parseToolsNew('**get_current_time**\n*web-search*\n');
    expect(result).toContain('get_current_time');
    expect(result).toContain('web-search');
  });

  it('ignores empty lines', () => {
    const result = parseToolsNew('\n\n\nget_current_time\n\n\n');
    expect(result).toEqual(['get_current_time']);
  });

  it('skips // line comments', () => {
    const result = parseToolsNew('// comment\nget_current_time\n');
    expect(result).not.toContain('// comment');
    expect(result).toContain('get_current_time');
  });

  it('handles a mix of commented, active, and hyphenated tool names', () => {
    const text = [
      '# Enabled Tools',
      'get_current_time',
      '# echo_message',
      'web-search',
      '# browser-navigate',
      'run_command',
    ].join('\n');
    const result = parseToolsNew(text);
    expect(result).toEqual(['get_current_time', 'web-search', 'run_command']);
  });
});

describe('edge cases for edge-strip regex', () => {
  it('does not strip hyphens in the middle of a name', () => {
    expect(parseToolsNew('a-b-c-d')).toContain('a-b-c-d');
  });

  it('handles mixed backtick and hyphen: `web-search`', () => {
    expect(parseToolsNew('`web-search`')).toContain('web-search');
  });

  it('handles tool name with leading/trailing spaces', () => {
    expect(parseToolsNew('  web-search  ')).toContain('web-search');
  });
});
