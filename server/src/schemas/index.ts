/**
 * Example Zod Schemas
 * 
 * Sample schemas demonstrating validation patterns.
 * Add your own schemas here based on your API endpoints.
 */

import { z } from 'zod';

// ===================
// Common Schemas
// ===================

/**
 * UUID Schema
 */
export const uuidSchema = z.string().uuid('Invalid UUID format');

/**
 * Email Schema
 */
export const emailSchema = z.string().email('Invalid email format');

/**
 * Pagination Query Schema
 */
export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});

// ===================
// Auth Schemas
// ===================

/**
 * Login Schema
 */
export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

/**
 * Register Schema
 */
export const registerSchema = z.object({
  email: emailSchema,
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(2, 'Name must be at least 2 characters').max(50),
});

/**
 * Change Password Schema
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

// ===================
// Chat/Message Schemas
// ===================

/**
 * Send Message Schema
 */
export const sendMessageSchema = z.object({
  platform: z.enum(['telegram', 'line', 'facebook', 'web']),
  chatId: z.string().min(1, 'Chat ID is required'),
  message: z.string().min(1, 'Message is required').max(4000),
  metadata: z.record(z.unknown()).optional(),
});

/**
 * Chat Query Schema
 */
export const chatQuerySchema = z.object({
  platform: z.enum(['telegram', 'line', 'facebook', 'web']).optional(),
  chatId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(50),
  before: z.string().optional(), // ISO date string
});

// ===================
// Dynamic Tool Schemas
// ===================

/**
 * Create Tool Schema
 */
export const createToolSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(50, 'Name must be at most 50 characters')
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Name must start with letter and contain only letters, numbers, underscores'),
  description: z.string().max(200, 'Description must be at most 200 characters'),
  code: z.string().min(1, 'Code is required').max(10000, 'Code must be at most 10000 characters'),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.any()).optional(),
    required: z.array(z.string()).optional(),
  }).optional(),
});

/**
 * Update Tool Schema
 */
export const updateToolSchema = createToolSchema.partial();

/**
 * Test Tool Schema
 */
export const testToolSchema = z.object({
  args: z.record(z.any()).default({}),
});

// ===================
// Provider Schemas
// ===================

/**
 * Provider Key Schema
 */
export const providerKeySchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
  source: z.enum(['env', 'dashboard']).default('dashboard'),
});

/**
 * Provider Test Schema
 */
export const providerTestSchema = z.object({
  providerId: z.string().min(1, 'Provider ID is required'),
});

// ===================
// Swarm Schemas
// ===================

/**
 * Delegate Task Schema
 */
export const delegateTaskSchema = z.object({
  taskType: z.enum([
    'image_analysis',
    'code_generation',
    'code_review',
    'web_search',
    'translation',
    'data_analysis',
    'general',
  ]),
  message: z.string().min(1, 'Message is required').max(4000),
  specialist: z.string().optional(),
  priority: z.number().int().min(1).max(5).default(3),
  timeout: z.number().int().positive().max(300000).default(120000), // max 5 minutes
});

/**
 * Task Query Schema
 */
export const taskQuerySchema = z.object({
  status: z.enum(['queued', 'processing', 'completed', 'failed']).optional(),
  specialist: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// ===================
// Memory Schemas
// ===================

/**
 * Search Memory Schema
 */
export const searchMemorySchema = z.object({
  query: z.string().min(1, 'Query is required').max(500),
  chatId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(20).default(5),
  type: z.enum(['archival', 'working', 'all']).default('all'),
});

/**
 * Save Memory Schema
 */
export const saveMemorySchema = z.object({
  content: z.string().min(1, 'Content is required').max(10000),
  type: z.enum(['archival', 'working']).default('archival'),
  chatId: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// Export all schemas
export const schemas = {
  // Common
  uuidSchema,
  emailSchema,
  paginationSchema,
  
  // Auth
  loginSchema,
  registerSchema,
  changePasswordSchema,
  
  // Chat
  sendMessageSchema,
  chatQuerySchema,
  
  // Tools
  createToolSchema,
  updateToolSchema,
  testToolSchema,
  
  // Provider
  providerKeySchema,
  providerTestSchema,
  
  // Swarm
  delegateTaskSchema,
  taskQuerySchema,
  
  // Memory
  searchMemorySchema,
  saveMemorySchema,
};

export default schemas;
