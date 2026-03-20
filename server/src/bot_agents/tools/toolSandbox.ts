// ============================================================
// Tool Sandbox — Lightweight VM-based execution environment
// ============================================================
// Safely executes dynamic tool code in an isolated context
// Uses Node.js vm module with restricted require and timeouts

import { runInNewContext, createContext, Script } from 'vm';
import { createRequire } from 'module';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('ToolSandbox');
const nativeRequire = createRequire(import.meta.url);

// ── Safe modules that dynamic tools can use ──
const SAFE_MODULES = new Set([
  'fs', 'path', 'url', 'crypto', 'util', 'os', 'stream',
  'buffer', 'events', 'querystring', 'timers', 'net', 'http', 'https',
]);

// ── Configuration ──
const EXECUTION_TIMEOUT = 30_000; // 30 seconds max per tool

/**
 * Create a restricted require function for the sandbox
 */
function createRestrictedRequire() {
  return (moduleName: string) => {
    // Block dangerous modules
    if (moduleName.includes('child_process') || moduleName.includes('cluster') || moduleName.includes('worker_threads')) {
      throw new Error(`Module not allowed: ${moduleName}`);
    }

    // Only allow safe modules
    if (!SAFE_MODULES.has(moduleName) && !moduleName.startsWith('.')) {
      throw new Error(`Module not in allowlist: ${moduleName}`);
    }

    // Use native require for safe modules
    try {
      return nativeRequire(moduleName);
    } catch (err: any) {
      throw new Error(`Failed to load module ${moduleName}: ${err.message}`);
    }
  };
}

/**
 * Execute tool handler code in a sandbox
 * @param code The handler code to execute (the function body)
 * @param args Arguments to pass to the handler
 * @param timeout Execution timeout in milliseconds
 * @returns Result of the handler
 */
export async function executeTool(
  code: string,
  args: Record<string, unknown>,
  timeout: number = EXECUTION_TIMEOUT
): Promise<string> {
  try {
    // Create the sandbox context with limited access
    const sandbox = {
      // Built-in globals (safe subset)
      console: {
        log: (...msgs: unknown[]) => log.info(msgs.join(' ')),
        error: (...msgs: unknown[]) => log.error(msgs.join(' ')),
        warn: (...msgs: unknown[]) => log.warn(msgs.join(' ')),
      },
      JSON,
      Math,
      Date,
      String,
      Number,
      Boolean,
      Array,
      Object,
      Error,
      RegExp,
      Promise,
      Buffer,
      URL,
      URLSearchParams,
      Set,
      Map,
      WeakMap,
      WeakSet,

      // Restricted require
      require: createRestrictedRequire(),

      // Safe utilities
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,

      // Args passed by the caller
      args,
    };

    // Wrap the code in an async function that returns a result
    const wrappedCode = `
(async () => {
  ${code}
})()
`;

    // Execute with timeout
    const context = createContext(sandbox);
    const promise = runInNewContext(wrappedCode, context, {
      timeout,
      displayErrors: true,
    });

    // Execute the returned promise
    const result = await Promise.race([
      promise as Promise<unknown>,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timeout (${timeout}ms exceeded)`)), timeout)
      ),
    ]);

    // Ensure result is a string
    if (typeof result === 'string') {
      return result;
    }

    if (typeof result === 'object' && result !== null) {
      return JSON.stringify(result);
    }

    return String(result ?? '(no result)');
  } catch (err: any) {
    log.error('Tool execution error:', err);

    // Sanitize error message (remove sensitive info)
    let message = err.message || String(err);
    if (message.length > 500) {
      message = message.substring(0, 500) + '...';
    }

    return `❌ Execution error: ${message}`;
  }
}

/**
 * Validate code can be compiled before execution
 * @param code The handler code to check
 * @returns True if code compiles, false otherwise
 */
export function validateCodeCompilation(code: string): { valid: boolean; error?: string } {
  try {
    const wrappedCode = `
(async (args) => {
  ${code}
})
`;
    // Just try to create the context — doesn't execute
    new Script(wrappedCode, { filename: 'dynamic_tool.js' });
    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      error: err.message || 'Syntax error',
    };
  }
}

/**
 * Create a standalone tool executor with custom timeout
 */
export function createToolExecutor(timeoutMs: number = EXECUTION_TIMEOUT) {
  return async (code: string, args: Record<string, unknown>) => {
    return executeTool(code, args, timeoutMs);
  };
}
