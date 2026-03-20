// ============================================================
// Dynamic Tools Manager  Loading & Registration System
// ============================================================
// Handles loading, validating, and hot-registering dynamic tools
// Tools can be created/updated/deleted without server restart

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { Type, FunctionDeclaration } from '@google/genai';
import { createLogger } from '../../utils/logger.js';
import { validateTool, type ValidationResult } from './toolValidator.js';
import { executeTool, validateCodeCompilation } from './toolSandbox.js';

const log = createLogger('DynamicTools');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

//  Configuration 
export const DYNAMIC_TOOLS_DIR =
  process.env.DYNAMIC_TOOLS_DIR?.trim()
    ? path.resolve(process.env.DYNAMIC_TOOLS_DIR)
    : path.resolve(__dirname, '../../../dynamic_tools');

/**
 * Ensure the dynamic tools directory exists
 */
function ensureDynamicToolsDir(): void {
  if (!fs.existsSync(DYNAMIC_TOOLS_DIR)) {
    fs.mkdirSync(DYNAMIC_TOOLS_DIR, { recursive: true });
    log.info('Created dynamic tools directory', { path: DYNAMIC_TOOLS_DIR });
  }
}

/**
 * Dynamically loaded tool definition
 */
export interface DynamicToolDef {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<string>;
  declaration: FunctionDeclaration;
}

/**
 * In-memory registry of loaded dynamic tools
 */
const dynamicToolsMap = new Map<string, DynamicToolDef>();

/**
 * Load a single dynamic tool from a file
 * File should export: { name, description, parameters, code }
 */
async function loadToolFromFile(filePath: string): Promise<{ tool?: DynamicToolDef; error?: string }> {
  try {
    if (!filePath.endsWith('.json')) {
      return { error: `Unsupported dynamic tool format: ${path.basename(filePath)} (only .json is allowed)` };
    }
    const fileContent = fs.readFileSync(filePath, 'utf8');
    let rawDef: Record<string, unknown>;
    try {
      rawDef = JSON.parse(fileContent);
    } catch (parseErr) {
      return { error: `Invalid JSON in ${path.basename(filePath)}: ${(parseErr as Error).message}` };
    }

    const toolName = String(rawDef.name || '');
    const toolDescription = String(rawDef.description || '');
    const toolCode = String(rawDef.code || '');
    const toolParameters = rawDef.parameters as Record<string, unknown> | undefined;

    // Validate the tool definition
    if (!toolName || !toolDescription || !toolCode) {
      return { error: `Missing required fields (name, description, code) in ${filePath}` };
    }

    // Validate the code and metadata
    const validation = validateTool(toolName, toolDescription, toolCode, toolParameters);
    if (!validation.valid) {
      return { error: `Validation failed for ${toolName}: ${validation.errors.join('; ')}` };
    }

    // Check code compilation
    const compCheck = validateCodeCompilation(toolCode);
    if (!compCheck.valid) {
      return { error: `Code compilation failed for ${toolName}: ${compCheck.error}` };
    }

    // Create the handler function (executor wrapper)
    const handler = async (args: Record<string, unknown>) => {
      return executeTool(toolCode, args);
    };

    // Create the FunctionDeclaration for Gemini API
    const declaration: FunctionDeclaration = {
      name: toolName,
      description: toolDescription,
      parameters: toolParameters
        ? {
            type: Type.OBJECT,
            ...toolParameters,
          }
        : {
            type: Type.OBJECT,
            properties: {},
          },
    };

    const tool: DynamicToolDef = {
      name: toolName,
      description: toolDescription,
      parameters: toolParameters,
      handler,
      declaration,
    };

    log.info('Loaded dynamic tool', { name: toolName, path: filePath });
    return { tool };
  } catch (err: any) {
    return { error: `Failed to load ${filePath}: ${err.message}` };
  }
}

/**
 * Load all dynamic tools from the directory
 * Scans for .json files only
 */
export async function loadDynamicTools(): Promise<void> {
  ensureDynamicToolsDir();

  try {
    const files = fs.readdirSync(DYNAMIC_TOOLS_DIR);
    const toolFiles = files.filter((f) => f.endsWith('.json'));

    if (toolFiles.length === 0) {
      log.info('No dynamic tools found', { path: DYNAMIC_TOOLS_DIR });
      return;
    }

    for (const file of toolFiles) {
      const filePath = path.join(DYNAMIC_TOOLS_DIR, file);
      const { tool, error } = await loadToolFromFile(filePath);

      if (error) {
        log.warn('Failed to load dynamic tool', { file, error });
        continue;
      }

      if (tool) {
        dynamicToolsMap.set(tool.name, tool);
        log.info('Registered dynamic tool', { name: tool.name });
      }
    }

    log.info('Dynamic tools loaded', { count: dynamicToolsMap.size });
  } catch (err: any) {
    log.error('Error loading dynamic tools', { error: err.message });
  }
}

/**
 * Register a new dynamic tool at runtime
 * @param name Tool name (kebab-case)
 * @param description Tool description
 * @param code Handler code (the function body)
 * @param parameters JSON Schema for parameters
 * @returns Validation result
 */
export async function registerDynamicTool(
  name: string,
  description: string,
  code: string,
  parameters?: Record<string, unknown>
): Promise<ValidationResult & { registered?: boolean }> {
  ensureDynamicToolsDir();

  // Validate the tool
  const validation = validateTool(name, description, code, parameters);
  if (!validation.valid) {
    return validation;
  }

  // Check compilation
  const compCheck = validateCodeCompilation(code);
  if (!compCheck.valid) {
    return {
      valid: false,
      errors: [`Code compilation failed: ${compCheck.error}`],
      warnings: [],
    };
  }

  try {
    // Save to file
    const filePath = path.join(DYNAMIC_TOOLS_DIR, `${name}.json`);
    const toolDef = {
      name,
      description,
      code,
      parameters: parameters || { type: 'object', properties: {} },
    };

    fs.writeFileSync(filePath, JSON.stringify(toolDef, null, 2), 'utf8');
    log.info('Saved dynamic tool to file', { name, path: filePath });

    // Load and register in memory
    const { tool, error: loadError } = await loadToolFromFile(filePath);
    if (loadError) {
      log.error('Failed to load saved tool', { name, error: loadError });
      return {
        valid: false,
        errors: [loadError || 'Failed to load saved tool'],
        warnings: validation.warnings,
      };
    }

    if (tool) {
      dynamicToolsMap.set(name, tool);
      log.info('Registered dynamic tool in memory', { name });
      return {
        valid: true,
        errors: [],
        warnings: validation.warnings,
        registered: true,
      };
    }

    return {
      valid: false,
      errors: ['Failed to register tool'],
      warnings: validation.warnings,
    };
  } catch (err: any) {
    log.error('Error registering dynamic tool', { name, error: err.message });
    return {
      valid: false,
      errors: [err.message],
      warnings: validation.warnings,
    };
  }
}

/**
 * Unregister and delete a dynamic tool
 */
export async function unregisterDynamicTool(name: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Remove from memory
    dynamicToolsMap.delete(name);
    log.info('Unregistered dynamic tool from memory', { name });

    // Remove file
    const filePath = path.join(DYNAMIC_TOOLS_DIR, `${name}.json`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      log.info('Deleted dynamic tool file', { name, path: filePath });
    }

    return { success: true };
  } catch (err: any) {
    const error = err.message;
    log.error('Error unregistering dynamic tool', { name, error });
    return { success: false, error };
  }
}

/**
 * Get all loaded dynamic tools
 */
export function listDynamicTools(): DynamicToolDef[] {
  return Array.from(dynamicToolsMap.values());
}

/**
 * Get a specific dynamic tool
 */
export function getDynamicTool(name: string): DynamicToolDef | undefined {
  return dynamicToolsMap.get(name);
}

/**
 * Get all dynamic tools as handler map (for agent.ts)
 */
export function getDynamicToolHandlers(): Record<string, (args: Record<string, unknown>) => Promise<string>> {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {};
  for (const [name, tool] of dynamicToolsMap.entries()) {
    handlers[name] = tool.handler;
  }
  return handlers;
}

/**
 * Get all dynamic tool declarations (for Gemini API)
 */
export function getDynamicToolDeclarations(): FunctionDeclaration[] {
  return Array.from(dynamicToolsMap.values()).map((tool) => tool.declaration);
}

/**
 * Refresh dynamic tools (reload from disk)
 * Useful for hot-reloading during development
 */
export async function refreshDynamicTools(): Promise<void> {
  dynamicToolsMap.clear();
  await loadDynamicTools();
  log.info('Dynamic tools refreshed');
}

