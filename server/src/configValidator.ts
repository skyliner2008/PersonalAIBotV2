/**
 * Configuration validator for startup environment variables.
 *
 * - Validates schema with Zod.
 * - Enforces required keys by environment.
 * - Emits security warnings/errors.
 * - In production, startup halts when invalid.
 */

import { z } from 'zod';
import { createLogger } from './utils/logger';

const STARTUP_COMPACT = process.env.STARTUP_COMPACT === '1';
const logger = createLogger('Config');

const envSchema = z.object({
  GEMINI_API_KEY: z.string().min(1).optional(),
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),

  PORT: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().min(1).max(65535)).optional(),

  JWT_SECRET: z.string().min(16).optional(),
  ADMIN_USER: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(1).optional(),
  AUTH_DISABLED: z.enum(['true', 'false']).optional(),

  ENCRYPTION_KEY: z.string().min(32).optional(),

  RATE_LIMIT_WINDOW_MS: z.string().regex(/^\d+$/).optional(),
  RATE_LIMIT_MAX: z.string().regex(/^\d+$/).optional(),

  HEADLESS: z.enum(['true', 'false']).optional(),
  SLOW_MO: z.string().regex(/^\d+$/).optional(),

  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  LINE_CHANNEL_SECRET: z.string().min(1).optional(),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1).optional(),
  FB_VERIFY_TOKEN: z.string().min(1).optional(),
  FB_PAGE_ACCESS_TOKEN: z.string().min(1).optional(),

  SOCKET_AUTH_TOKEN: z.string().min(1).optional(),
});

interface ValidationRule {
  key: string;
  required: Array<'production' | 'staging' | 'development'>;
  securityWarning?: string;
}

const VALIDATION_RULES: ValidationRule[] = [
  { key: 'GEMINI_API_KEY', required: ['production', 'staging'] },
  {
    key: 'JWT_SECRET',
    required: ['production'],
    securityWarning: 'Auto-generated JWT secret will invalidate all tokens on restart',
  },
  {
    key: 'ENCRYPTION_KEY',
    required: ['production'],
    securityWarning: 'Default encryption key means credential data is not secure',
  },
  { key: 'ADMIN_USER', required: ['production'] },
  { key: 'ADMIN_PASSWORD', required: ['production'] },
  {
    key: 'SOCKET_AUTH_TOKEN',
    required: ['production'],
    securityWarning: 'Socket.IO connections will be unauthenticated',
  },
];

export interface ValidationResult {
  valid: boolean;
  environment: string;
  errors: string[];
  warnings: string[];
  info: string[];
}

export function validateConfig(): ValidationResult {
  const env = process.env.NODE_ENV || 'development';
  const result: ValidationResult = {
    valid: true,
    environment: env,
    errors: [],
    warnings: [],
    info: [],
  };

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.');
      result.errors.push(`${path}: ${issue.message}`);
    }
    result.valid = false;
  }

  for (const rule of VALIDATION_RULES) {
    const value = process.env[rule.key];
    const isRequired = rule.required.includes(env as 'production' | 'staging' | 'development');

    if (isRequired && !value) {
      result.errors.push(`${rule.key} is required in ${env}`);
      result.valid = false;
    } else if (!value && rule.securityWarning) {
      result.warnings.push(`${rule.key} not set - ${rule.securityWarning}`);
    }
  }

  const weakPasswords = new Set(['admin', 'password', '12345678', 'changeme', 'qwerty123']);
  const adminPassword = String(process.env.ADMIN_PASSWORD || '').trim();
  const lowerPass = adminPassword.toLowerCase();
  if (adminPassword && (weakPasswords.has(lowerPass) || adminPassword.length < 8)) {
    const msg = adminPassword.length < 8 
      ? 'ADMIN_PASSWORD should contain at least 8 characters for better security'
      : 'ADMIN_PASSWORD is weak/common and should be changed';
    if (env === 'production') {
      result.errors.push(msg);
      result.valid = false;
    } else {
      result.warnings.push(msg);
    }
  }

  if (env === 'production') {
    if (process.env.AUTH_DISABLED === 'true') {
      result.errors.push('AUTH_DISABLED=true is not allowed in production');
      result.valid = false;
    }

    const encKey = process.env.ENCRYPTION_KEY || '';
    if (encKey === 'default-dev-key-change-in-production-32') {
      result.errors.push('ENCRYPTION_KEY must not use the default development value in production');
      result.valid = false;
    }

    if (!process.env.SOCKET_AUTH_TOKEN) {
      result.warnings.push('SOCKET_AUTH_TOKEN not set - WebSocket connections are open');
    }
  } else if (process.env.AUTH_DISABLED === 'true') {
    result.warnings.push('AUTH_DISABLED=true - APIs are open without JWT authentication');
  }

  result.info.push(`Environment: ${env}`);
  result.info.push(`Port: ${process.env.PORT || '3000'}`);
  result.info.push(`Auth: ${process.env.AUTH_DISABLED === 'true' ? 'DISABLED' : 'enabled'}`);
  result.info.push(`Headless: ${process.env.HEADLESS === 'true' ? 'yes' : 'no'}`);

  const platformCount = [
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.LINE_CHANNEL_ACCESS_TOKEN,
    process.env.FB_PAGE_ACCESS_TOKEN,
  ].filter(Boolean).length;
  result.info.push(`Platform tokens configured: ${platformCount}/3`);

  return result;
}

export function printConfigReport(result: ValidationResult): void {
  if (STARTUP_COMPACT) {
    const statusText = result.valid ? 'valid' : 'INVALID';
    const infoText = result.info.join(' | ');
    console.log(`[Config] ${statusText} | ${infoText}`);

    for (const warn of result.warnings) {
      console.warn(`[Config][WARN] ${warn}`);
    }
    for (const err of result.errors) {
      console.error(`[Config][ERROR] ${err}`);
    }
    return;
  }

  const width = 64;
  const border = '+'.padEnd(width - 1, '-') + '+';
  const row = (text: string) => {
    const clipped = text.length > width - 4 ? text.slice(0, width - 7) + '...' : text;
    return `| ${clipped.padEnd(width - 4)} |`;
  };

  console.log(`\n${border}`);
  console.log(row('PersonalAIBotV2 - Configuration Report'));
  console.log(border);

  for (const info of result.info) {
    console.log(row(`INFO  ${info}`));
  }

  if (result.warnings.length > 0) {
    console.log(border);
    for (const warn of result.warnings) {
      console.warn(row(`WARN  ${warn}`));
    }
  }

  if (result.errors.length > 0) {
    console.log(border);
    for (const err of result.errors) {
      console.error(row(`ERROR ${err}`));
    }
  }

  console.log(border);
  console.log(row(result.valid ? 'Status: configuration valid - startup allowed' : 'Status: configuration INVALID'));
  console.log(border + '\n');
}

/**
 * Run validation and halt startup in production when invalid.
 */
export function validateAndReport(): boolean {
  const result = validateConfig();
  printConfigReport(result);

  if (!result.valid && result.environment === 'production') {
    console.error('[Config] FATAL: Cannot start in production with invalid configuration');
    process.exit(1);
  }

  return result.valid;
}
