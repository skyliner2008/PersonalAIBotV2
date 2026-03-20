/**
 * Gemini CLI bridge
 *
 * Executes local `gemini` CLI and returns stdout.
 * This path is intentionally lightweight for low-latency admin usage.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger.js';
import { getCLIConfig } from '../terminal/commandRouter.js';

const log = createLogger('GeminiCLI');
const CLI_TIMEOUT_MS = 45_000;

interface GeminiInvocation {
  command: string;
  args: string[];
  source: string;
}

function resolveExecutablePath(inputPath: string): string {
  const cleanPath = inputPath.trim().replace(/^"|"$/g, '');
  if (process.platform !== 'win32') return cleanPath;
  if (/\.[^\\/]+$/.test(cleanPath)) return cleanPath;

  const candidates = [
    `${cleanPath}.cmd`,
    `${cleanPath}.exe`,
    `${cleanPath}.bat`,
    `${cleanPath}.ps1`,
    cleanPath,
  ];
  const existing = candidates.find((p) => fs.existsSync(p));
  return existing || cleanPath;
}

function resolveGeminiInvocation(prompt: string): GeminiInvocation {
  const cliConfig = getCLIConfig('gemini-cli');
  if (cliConfig?.command) {
    return {
      command: cliConfig.command,
      args: [...(cliConfig.args || []), '--prompt', prompt],
      source: 'command-router',
    };
  }

  const envPath = process.env.GEMINI_CLI_PATH || process.env.GEMINI_CLI_BIN;
  if (envPath) {
    const resolved = resolveExecutablePath(envPath);
    if (fs.existsSync(resolved)) {
      return {
        command: resolved,
        args: ['--prompt', prompt],
        source: 'env',
      };
    }
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    const fallback = path.join(appData, 'npm', 'gemini.cmd');
    if (fs.existsSync(fallback)) {
      return {
        command: fallback,
        args: ['--prompt', prompt],
        source: 'windows-fallback',
      };
    }
  }

  return {
    command: 'gemini',
    args: ['--prompt', prompt],
    source: 'path-fallback',
  };
}

function quoteArgForWindowsShell(arg: string): string {
  if (!/[ \t"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

export async function callGeminiWithOAuth(
  sessionId: string,
  userMessage: string
): Promise<string> {
  const prompt = String(userMessage || '').replace(/\0/g, '').trim();
  if (!prompt) return '[Error: empty prompt]';

  const invocation = resolveGeminiInvocation(prompt);
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(invocation.command.trim());
  const spawnArgs = useShell
    ? invocation.args.map((arg) => quoteArgForWindowsShell(String(arg ?? '')))
    : invocation.args;

  log.info(`[Gemini CLI] Invoking gemini command for session: ${sessionId}`, {
    source: invocation.source,
    command: invocation.command,
    shell: useShell,
  });

  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    let finished = false;

    const finish = (result: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const proc = spawn(invocation.command, spawnArgs, {
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CLICOLOR: '0', CLICOLOR_FORCE: '0' },
      shell: useShell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch (err) { log.debug('Process kill failed during timeout', { error: String(err) }); }
      finish(
        output.trim()
          ? `${output.trim()}\n\n[Warning: Gemini CLI timed out]`
          : '[Error: Gemini CLI timed out and returned no response]',
      );
    }, CLI_TIMEOUT_MS);

    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);

      let finalOutput = output.trim();
      finalOutput = finalOutput
        .split('\n')
        .filter((line) => !line.startsWith('Loaded cached credentials'))
        .filter((line) => !line.match(/^Attempt \d+ failed:/))
        .join('\n')
        .trim();

      if (code !== 0 && !finalOutput) {
        log.error(`[Gemini CLI] Exited with code ${code}. Error: ${errorOutput}`);
        return finish(`[Gemini CLI Error] (Code ${code})\n${errorOutput || '(No stderr output)'}`);
      }

      log.info(`[Gemini CLI] Received ${finalOutput.length} chars (session: ${sessionId})`);
      finish(finalOutput || '(no response)');
    });

    proc.on('error', (err) => {
      log.error(`[Gemini CLI] Failed to spawn: ${err.message}`);
      const errorCode = (err as NodeJS.ErrnoException).code;
      if (errorCode === 'ENOENT' || errorCode === 'EINVAL') {
        return finish(
          '[Gemini System Error] Gemini CLI executable not found or not runnable. ' +
          'Set GEMINI_CLI_PATH to gemini.cmd (Windows) or install globally with npm.',
        );
      }
      finish(`[Gemini System Error] Failed to start CLI: ${err.message}`);
    });
  });
}
