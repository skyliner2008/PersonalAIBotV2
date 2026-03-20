import { describe, it, expect, vi } from 'vitest';

// Mock the logger used by sanitizer
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  escapeHtml,
  stripXSS,
  detectSQLInjection,
  sanitizePath,
  sanitizeDeep,
  sanitizeUserInput,
} from '../../utils/sanitizer.js';

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;'
    );
  });

  it('preserves normal text', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });

  it('preserves Thai text', () => {
    const thai = 'สวัสดีครับ ยินดีต้อนรับ';
    expect(escapeHtml(thai)).toBe(thai);
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('stripXSS', () => {
  it('removes script tags with content', () => {
    const result = stripXSS('Hello<script>alert(1)</script>World');
    expect(result).toBe('HelloWorld');
    expect(result).not.toContain('script');
  });

  it('removes onclick handlers', () => {
    const result = stripXSS('<div onclick="alert(1)">test</div>');
    expect(result).not.toContain('onclick');
  });

  it('removes javascript: protocol', () => {
    const result = stripXSS('<a href="javascript:alert(1)">click</a>');
    expect(result).not.toContain('javascript:');
  });

  it('removes iframe tags', () => {
    const result = stripXSS('<iframe src="evil.com"></iframe>');
    expect(result).not.toContain('<iframe');
  });

  it('removes eval() calls', () => {
    const result = stripXSS('eval("dangerous code")');
    expect(result).not.toContain('eval(');
  });

  it('preserves normal HTML-like content', () => {
    const result = stripXSS('Price is 100 < 200');
    expect(result).toContain('100 < 200');
  });
});

describe('detectSQLInjection', () => {
  it('detects UNION SELECT', () => {
    expect(detectSQLInjection("1' UNION SELECT * FROM users")).not.toBeNull();
  });

  it('detects OR 1=1', () => {
    expect(detectSQLInjection("'; OR '1'='1")).not.toBeNull();
  });

  it('detects stacked DROP', () => {
    expect(detectSQLInjection('; DROP TABLE users')).not.toBeNull();
  });

  it('detects SQL comments', () => {
    expect(detectSQLInjection('admin-- ')).not.toBeNull();
  });

  it('returns null for clean input', () => {
    expect(detectSQLInjection('Hello World')).toBeNull();
    expect(detectSQLInjection('สินค้าราคา 100 บาท')).toBeNull();
  });
});

describe('sanitizePath', () => {
  it('removes ../ traversal', () => {
    expect(sanitizePath('../../etc/passwd')).toBe('etc/passwd');
  });

  it('removes ..\\ traversal', () => {
    // sanitizePath replaces ..\\ patterns only
    const result = sanitizePath('..\\..\\windows\\system32');
    expect(result).not.toContain('..');
  });

  it('removes null bytes', () => {
    expect(sanitizePath('file.txt\0.exe')).toBe('file.txt.exe');
  });

  it('collapses double slashes', () => {
    expect(sanitizePath('path//to//file')).toBe('path/to/file');
  });

  it('preserves normal paths', () => {
    expect(sanitizePath('uploads/images/photo.jpg')).toBe('uploads/images/photo.jpg');
  });
});

describe('sanitizeDeep', () => {
  it('trims strings', () => {
    expect(sanitizeDeep('  hello  ', { logInjection: false })).toBe('hello');
  });

  it('sanitizes nested objects', () => {
    const result = sanitizeDeep(
      { name: '<script>alert(1)</script>', nested: { val: 'ok' } },
      { logInjection: false },
    ) as any;
    expect(result.name).not.toContain('<script>');
    expect(result.nested.val).toBe('ok');
  });

  it('sanitizes arrays', () => {
    const result = sanitizeDeep(['<script>x</script>', 'normal'], { logInjection: false }) as any[];
    expect(result[0]).not.toContain('<script>');
    expect(result[1]).toBe('normal');
  });

  it('blocks prototype pollution keys via constructor/prototype', () => {
    // sanitizeDeep strips keys matching __proto__, constructor, prototype
    // Test by checking the key was removed from Object.keys
    const input = Object.create(null) as Record<string, string>;
    input['__proto__'] = 'evil';
    input['constructor'] = 'bad';
    input['prototype'] = 'worse';
    input['normal'] = 'ok';
    const result = sanitizeDeep(input, { logInjection: false }) as any;
    const keys = Object.keys(result);
    expect(keys).not.toContain('__proto__');
    expect(keys).not.toContain('constructor');
    expect(keys).not.toContain('prototype');
    expect(result.normal).toBe('ok');
  });

  it('passes through numbers and booleans unchanged', () => {
    expect(sanitizeDeep(42)).toBe(42);
    expect(sanitizeDeep(true)).toBe(true);
    expect(sanitizeDeep(null)).toBeNull();
  });
});

describe('sanitizeUserInput', () => {
  it('returns clean text for normal input', () => {
    const { clean, warnings } = sanitizeUserInput('สวัสดีครับ');
    expect(clean).toBe('สวัสดีครับ');
    expect(warnings).toHaveLength(0);
  });

  it('strips XSS and adds warning', () => {
    const { clean, warnings } = sanitizeUserInput('<script>alert(1)</script>Hello');
    expect(clean).toBe('Hello');
    expect(warnings.some(w => w.includes('XSS'))).toBe(true);
  });

  it('detects SQL injection and adds warning', () => {
    const { warnings } = sanitizeUserInput("'; DROP TABLE users;--");
    expect(warnings.some(w => w.includes('SQL injection'))).toBe(true);
  });

  it('truncates extremely long input', () => {
    const longInput = 'a'.repeat(60000);
    const { clean, warnings } = sanitizeUserInput(longInput);
    expect(clean.length).toBe(50000);
    expect(warnings.some(w => w.includes('truncated'))).toBe(true);
  });

  it('handles empty string', () => {
    const { clean, warnings } = sanitizeUserInput('');
    expect(clean).toBe('');
    expect(warnings).toHaveLength(0);
  });
});
