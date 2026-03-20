// ============================================================
// Unit Tests: Tool Validator
// ============================================================
// Tests the tool code validator to ensure dangerous patterns
// are blocked and safe operations are allowed

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateToolCode,
  validateToolMetadata,
  validateTool,
  type ValidationResult,
} from '../../bot_agents/tools/toolValidator.js';

describe('validateToolCode', () => {
  // ── Dangerous patterns that should be BLOCKED ──

  it('should BLOCK process.exit()', () => {
    const code = 'process.exit(1);';
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].toLowerCase()).toContain('process');
    expect(result.errors[0].toLowerCase()).toContain('blocked');
  });

  it('should BLOCK process.kill()', () => {
    const code = 'process.kill(pid);';
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should BLOCK child_process require', () => {
    const code = `const { exec } = require('child_process');`;
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should BLOCK child_process import', () => {
    const code = `import { exec } from 'child_process';`;
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should BLOCK eval()', () => {
    const code = 'eval("malicious code");';
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('eval');
  });

  it('should BLOCK new Function() constructor', () => {
    const code = 'new Function("return 42")();';
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Function');
  });

  it('should BLOCK Function constructor with eval-like usage', () => {
    const code = 'Function("x", "return x * 2")(5);';
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
  });

  it('should BLOCK fs.rmSync() on unsafe paths', () => {
    const code = 'fs.rmSync("/");';
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('rmSync');
  });

  it('should BLOCK fs.rmdirSync()', () => {
    const code = 'fs.rmdirSync("/tmp");';
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
  });

  it('should BLOCK fs.unlinkSync()', () => {
    const code = 'fs.unlinkSync("/etc/passwd");';
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
  });

  it('should BLOCK cluster module', () => {
    const code = `require('cluster');`;
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
  });

  it('should BLOCK worker_threads module', () => {
    const code = `import { Worker } from 'worker_threads';`;
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
  });

  // ── Safe patterns that should be ALLOWED ──

  it('should ALLOW fs.readFileSync()', () => {
    const code = 'const data = fs.readFileSync("/safe/file.txt", "utf-8");';
    const result = validateToolCode(code);
    expect(result.valid).toBe(true);
    expect(result.errors.length).toBe(0);
  });

  it('should ALLOW safe modules (path, url, crypto)', () => {
    const code = `
      import { resolve } from 'path';
      import { parse } from 'url';
      import { randomBytes } from 'crypto';
    `;
    const result = validateToolCode(code);
    expect(result.valid).toBe(true);
  });

  it('should ALLOW simple fetch() calls', () => {
    const code = `
      async function getData() {
        const resp = await fetch('https://api.example.com/data');
        return resp.json();
      }
    `;
    const result = validateToolCode(code);
    expect(result.valid).toBe(true);
  });

  it('should ALLOW basic function definitions', () => {
    const code = `
      function add(a, b) {
        return a + b;
      }
    `;
    const result = validateToolCode(code);
    expect(result.valid).toBe(true);
  });

  it('should ALLOW async/await', () => {
    const code = `
      async function processData() {
        const data = await fetchData();
        return transform(data);
      }
    `;
    const result = validateToolCode(code);
    expect(result.valid).toBe(true);
  });

  // ── Warnings for best practices ──

  it('should WARN about external modules that might not be installed', () => {
    const code = `require('some-external-library');`;
    const result = validateToolCode(code);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('some-external-library');
  });

  it('should WARN about fetch() without async/await', () => {
    const code = `fetch('https://api.example.com/data');`;
    const result = validateToolCode(code);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('should WARN about code with no return or throw', () => {
    const code = `console.log('hello');`;
    const result = validateToolCode(code);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  // ── Edge cases ──

  it('should handle empty code', () => {
    const result = validateToolCode('');
    expect(result).toEqual({
      valid: true,
      errors: [],
      warnings: expect.any(Array),
    });
  });

  it('should handle code with only comments', () => {
    const code = `
      // This is a comment
      /* Block comment */
    `;
    const result = validateToolCode(code);
    expect(result.valid).toBe(true);
  });

  it('should BLOCK dangerous patterns hidden in comments', () => {
    // Note: Comments don't actually hide regex patterns, but test the behavior
    const code = `
      // process.exit(1)  -- This is still detected
      const x = 1;
    `;
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
  });

  it('should REJECT code over 50KB', () => {
    const code = 'x'.repeat(51_000);
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('too long');
  });

  it('should ALLOW code under 50KB', () => {
    const code = 'x'.repeat(10_000);
    const result = validateToolCode(code);
    expect(result.valid).toBe(true);
  });

  it('should handle unicode/emoji in code', () => {
    const code = `console.log("Hello 世界 🌍");`;
    const result = validateToolCode(code);
    // Should not crash
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('errors');
  });

  it('should handle multiple dangerous patterns in one code', () => {
    const code = `
      process.exit(1);
      eval('malicious');
      const { exec } = require('child_process');
    `;
    const result = validateToolCode(code);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('validateToolMetadata', () => {
  it('should require valid tool name (kebab-case)', () => {
    const meta = {
      name: 'InvalidName!@#',
      description: 'A tool',
    };
    const result = validateToolMetadata(meta);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('kebab-case');
  });

  it('should accept kebab-case names', () => {
    const meta = {
      name: 'read-file-tool',
      description: 'Read files',
    };
    const result = validateToolMetadata(meta);
    expect(result.valid).toBe(true);
  });

  it('should accept snake_case names', () => {
    const meta = {
      name: 'read_file_tool',
      description: 'Read files',
    };
    const result = validateToolMetadata(meta);
    expect(result.valid).toBe(true);
  });

  it('should reject name over 64 characters', () => {
    const meta = {
      name: 'a'.repeat(65),
      description: 'Tool',
    };
    const result = validateToolMetadata(meta);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('name too long');
  });

  it('should require description', () => {
    const meta = {
      name: 'my-tool',
      description: '',
    };
    const result = validateToolMetadata(meta);
    expect(result.valid).toBe(false);
  });

  it('should warn about very long descriptions', () => {
    const meta = {
      name: 'my-tool',
      description: 'x'.repeat(501),
    };
    const result = validateToolMetadata(meta);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('very long');
  });

  it('should accept valid parameters as JSON object', () => {
    const meta = {
      name: 'my-tool',
      description: 'A tool',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    };
    const result = validateToolMetadata(meta);
    expect(result.valid).toBe(true);
  });

  it('should reject non-object parameters', () => {
    const meta = {
      name: 'my-tool',
      description: 'A tool',
      parameters: { type: 'string' },
    };
    const result = validateToolMetadata(meta);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('must be of type "object"');
  });
});

describe('validateTool', () => {
  it('should validate both code and metadata', () => {
    const result = validateTool(
      'read-file',
      'Read file contents',
      `async function handler(params) {
        const fs = require('fs');
        return fs.readFileSync(params.path, 'utf-8');
      }`,
      { type: 'object', properties: { path: { type: 'string' } } }
    );
    expect(result.valid).toBe(true);
  });

  it('should fail if metadata invalid', () => {
    const result = validateTool(
      'invalid!@#name',
      'Description',
      `async function() { return "ok"; }`
    );
    expect(result.valid).toBe(false);
  });

  it('should fail if code invalid', () => {
    const result = validateTool(
      'my-tool',
      'Description',
      `process.exit(0);`
    );
    expect(result.valid).toBe(false);
  });

  it('should combine warnings from both validators', () => {
    const result = validateTool(
      'my-tool',
      'x'.repeat(501), // Too long description
      `fetch('https://api.example.com'); // No async/await`
    );
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
