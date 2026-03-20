/**
 * Safe JSON Parsing Utilities
 *
 * Wraps JSON.parse with Zod schema validation for runtime type safety.
 * Use these instead of raw JSON.parse on untrusted data (API inputs,
 * LLM outputs, WebSocket messages, file content).
 */

import { z, type ZodSchema } from 'zod';
import logger from './logger.js';

/**
 * Parse JSON with Zod schema validation.
 * Returns `undefined` on parse or validation failure (never throws).
 */
export function safeJsonParse<T>(
  raw: string,
  schema: ZodSchema<T>,
  context?: string,
): T | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.warn(`[safeJsonParse] Invalid JSON${context ? ` (${context})` : ''}: ${(err as Error).message}`);
    return undefined;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      `[safeJsonParse] Schema validation failed${context ? ` (${context})` : ''}: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
    );
    return undefined;
  }
  return result.data;
}

/**
 * Parse JSON with Zod schema, throwing on failure.
 * Use when you want the caller to handle the error.
 */
export function strictJsonParse<T>(
  raw: string,
  schema: ZodSchema<T>,
  context?: string,
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON${context ? ` (${context})` : ''}: ${(err as Error).message}`);
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Schema validation failed${context ? ` (${context})` : ''}: ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
    );
  }
  return result.data;
}

/**
 * Parse JSON without schema, but with proper error logging.
 * Returns fallback on failure instead of throwing.
 */
export function parseJsonOrDefault<T>(raw: string, fallback: T, context?: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn(`[parseJsonOrDefault] Parse failed${context ? ` (${context})` : ''}: ${(err as Error).message}`);
    return fallback;
  }
}

// ── Common reusable schemas ──────────────────────────────────────────

/** Schema for WebSocket auth payload */
export const SocketAuthSchema = z.object({
  type: z.string().optional(),
  token: z.string().min(1),
}).passthrough();

/** Schema for tool function arguments from LLM */
export const ToolArgsSchema = z.record(z.string(), z.unknown());

/** Schema for CLI profile data */
export const CliProfileSchema = z.object({
  specialist: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** Schema for dynamic tool definition files */
export const DynamicToolDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** Schema for provider registry file */
export const ProviderRegistrySchema = z.object({
  providers: z.array(z.object({
    name: z.string(),
    type: z.string(),
  }).passthrough()).optional(),
}).passthrough();
