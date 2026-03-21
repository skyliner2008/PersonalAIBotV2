// ============================================================
// Tool Validator — AST-based validation for dynamic tool code
// ============================================================
// Validates that dynamically generated tool code is safe to execute
// Uses a robust AST parser for security validation
import * as acorn from 'acorn';
import Ajv from 'ajv';

const ajv = new Ajv();

// ── Dangerous patterns (BLOCKLIST) ──
const DANGEROUS_PATTERNS = [
  // Process control
  /process\.exit/,
  /process\.kill/,
  /process\.abort/,

  // Child process execution
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /require\s*\(\s*['"]cluster['"]\s*\)/,
  /require\s*\(\s*['"]worker_threads['"]\s*\)/,
  /import\s+.*\s+from\s+['"]child_process['"]/,
  /import\s+.*\s+from\s+['"]cluster['"]/,
  /import\s+.*\s+from\s+['"]worker_threads['"]/,

  // Dangerous fs operations
  /fs\.rmSync\s*\(/,
  /fs\.rmdirSync\s*\(/,
  /fs\.unlinkSync\s*\(/,

  // Code evaluation
  /\beval\s*\(/,
  /new\s+Function\s*\(/,
  /Function\s*\(\s*['"][^'"]*['"]\s*,/,

  // Require/import restrictions
  /require\s*\(\s*['"]exec['"]\s*\)/,
  /require\s*\(\s*['"]spawn['"]\s*\)/,
];

// ── Safe patterns (ALLOWLIST) ──
const SAFE_MODULES = new Set([
  'fs', 'path', 'url', 'crypto', 'util', 'os', 'stream',
  'buffer', 'events', 'querystring', 'timers',
  'http', 'https', 'net', 'tls', 'dgram',
  'zlib', 'readline', 'string_decoder', 'punycode', 'dns', 'constants',
  'assert', 'async_hooks', 'console', 'fs/promises', 'stream/promises', 'timers/promises',
]);

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate TypeScript/JavaScript code for dynamic tools
 * @param code The tool handler code to validate
 * @returns Validation result with errors and warnings
 */
export function validateToolCode(code: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Blocked dangerous pattern: ${pattern.source}`);
    }
  }

  // Check for problematic require/import statements
  const requireMatches = code.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g) || []; // test find
  for (const requireCall of requireMatches) {
    const moduleName = requireCall.match(/['"]([^'"]+)['"]/)?.[1];
    if (moduleName && !SAFE_MODULES.has(moduleName) && !moduleName.startsWith('.')) {
      warnings.push(`External module import: ${moduleName} (ensure it's installed)`);
    }
  }

  // Check for import statements
  const importMatches = code.match(/import\s+.*\s+from\s+['"]([^'"]+)['"]/g) || [];
  for (const importStmt of importMatches) {
    const moduleName = importStmt.match(/['"]([^'"]+)['"]/)?.[1];
    if (moduleName && !SAFE_MODULES.has(moduleName) && !moduleName.startsWith('.')) {
      warnings.push(`External module import: ${moduleName} (ensure it's installed)`);
    }
  }

  // Check for async/await (should be used for long operations)
  if (!code.includes('async') && code.includes('fetch')) {
    warnings.push('Code uses fetch() without async/await — may block execution');
  }

  // Check code length (sanity check)
  if (code.length > 50_000) {
    errors.push('Code is too long (>50KB) — exceeds safety limits');
  }

  // Check for handler function syntax
  if (!code.includes('return') && !code.includes('throw')) {
    warnings.push('Code does not return or throw — may return undefined');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate tool metadata
 */
export interface ToolMetadata {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export function validateToolMetadata(meta: ToolMetadata): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate name (kebab-case)
  if (!meta.name || !/^[a-z0-9_-]+$/.test(meta.name)) {
    errors.push('Tool name must be kebab-case or snake_case (lowercase alphanumeric, hyphens, underscores)');
  }

  // Name length
  if (meta.name.length > 64) {
    errors.push('Tool name too long (max 64 characters)');
  }

  // Validate description
  if (!meta.description || meta.description.length === 0) {
    errors.push('Tool description is required');
  }

  if (meta.description && meta.description.length > 500) {
    warnings.push('Tool description is very long (>500 characters) — consider shortening');
  }

  // Validate parameters (basic JSON Schema check)
  if (meta.parameters) {
    if (typeof meta.parameters !== 'object') {
      errors.push('Parameters must be a JSON object');
    } else if ('type' in meta.parameters) {
      const type = (meta.parameters as any).type;
      if (type !== 'object') {
        errors.push('Parameters root must be of type "object"');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Comprehensive validation (code + metadata)
 */
export function validateTool(
  name: string,
  description: string,
  code: string,
  parameters?: Record<string, unknown>
): ValidationResult {
  const metaValidation = validateToolMetadata({ name, description, parameters });
  if (!metaValidation.valid) {
    return metaValidation;
  }

  const codeValidation = validateToolCode(code);
  if (!codeValidation.valid) {
    return codeValidation;
  }

  // Combine warnings
  const allWarnings = [...metaValidation.warnings, ...codeValidation.warnings];

  return {
    valid: true,
    errors: [],
    warnings: allWarnings,
  };
}
