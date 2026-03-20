/**
 * Terminal Utilities
 *
 * Helper functions for token extraction, output normalization, and text processing.
 * Used by CLI command execution and output handling.
 */

import type { CommandTokenUsage } from './terminalTypes.js';
import { stripAnsi } from './cliCommandExecutor.js';

/**
 * Parse a token number from a string
 */
function parseTokenNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[^\d]/g, '');
  if (!normalized) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

/**
 * Extract JSON objects from text (for token stats parsing)
 */
export function extractJsonObjectsFromText(text: string, maxObjects = 400): string[] {
  const source = String(text || '');
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (start < 0) {
      if (ch === '{') {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === '\\') {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const candidate = source.slice(start, i + 1).trim();
        if (candidate.startsWith('{') && candidate.endsWith('}')) {
          objects.push(candidate);
          if (objects.length >= maxObjects) break;
        }
        start = -1;
      }
    }
  }

  return objects;
}

/**
 * Try to extract token stats from a JSON line
 */
function tryExtractTokenStatsFromJsonLine(line: string): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} | null {
  if (!line.trim().startsWith('{')) return null;
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    const serialized = JSON.stringify(obj);
    const promptTokens = parseTokenNumber(serialized.match(/(?:prompt|input)[_\s-]*tokens?\D+([\d,]+)/i)?.[1]);
    const completionTokens = parseTokenNumber(serialized.match(/(?:completion|output)[_\s-]*tokens?\D+([\d,]+)/i)?.[1]);
    const totalTokens = parseTokenNumber(serialized.match(/total[_\s-]*tokens?\D+([\d,]+)/i)?.[1]);
    if (!promptTokens && !completionTokens && !totalTokens) return null;
    return { promptTokens, completionTokens, totalTokens };
  } catch {
    return null;
  }
}

/**
 * Estimate token usage based on character count (rough approximation)
 */
function estimateTokenUsage(promptInput: string, output: string): CommandTokenUsage | undefined {
  const promptTokens = Math.max(0, Math.ceil((promptInput || '').length / 4));
  const completionTokens = Math.max(0, Math.ceil((output || '').length / 4));
  const totalTokens = promptTokens + completionTokens;
  if (totalTokens <= 0) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    source: 'estimated',
  };
}

/**
 * Extract CLI token usage from raw output
 */
export function extractCliTokenUsage(
  backendId: `${string}-cli`,
  rawOutput: string,
  normalizedOutput: string,
  promptInput: string,
): CommandTokenUsage | undefined {
  const text = stripAnsi(rawOutput || '');
  const lines = text.split(/\r?\n/);
  const jsonObjects = extractJsonObjectsFromText(text, 800);

  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let totalTokens: number | undefined;

  for (const objectText of jsonObjects) {
    const jsonStat = tryExtractTokenStatsFromJsonLine(objectText);
    if (!jsonStat) continue;
    if (jsonStat.promptTokens !== undefined) promptTokens = jsonStat.promptTokens;
    if (jsonStat.completionTokens !== undefined) completionTokens = jsonStat.completionTokens;
    if (jsonStat.totalTokens !== undefined) totalTokens = jsonStat.totalTokens;
  }

  for (const line of lines) {
    const jsonStat = tryExtractTokenStatsFromJsonLine(line);
    if (!jsonStat) continue;
    if (jsonStat.promptTokens !== undefined) promptTokens = jsonStat.promptTokens;
    if (jsonStat.completionTokens !== undefined) completionTokens = jsonStat.completionTokens;
    if (jsonStat.totalTokens !== undefined) totalTokens = jsonStat.totalTokens;
  }

  if (promptTokens === undefined) {
    promptTokens = parseTokenNumber(text.match(/(?:prompt|input)[_\s-]*tokens?\s*[:=]?\s*([\d,]+)/i)?.[1]);
  }
  if (completionTokens === undefined) {
    completionTokens = parseTokenNumber(text.match(/(?:completion|output)[_\s-]*tokens?\s*[:=]?\s*([\d,]+)/i)?.[1]);
  }
  if (totalTokens === undefined) {
    totalTokens = parseTokenNumber(text.match(/total[_\s-]*tokens?\s*[:=]?\s*([\d,]+)/i)?.[1]);
  }
  if (totalTokens === undefined) {
    totalTokens = parseTokenNumber(text.match(/tokens?\s*used\s*[:=]?\s*([\d,]+)/i)?.[1]);
  }
  if (totalTokens === undefined) {
    for (let i = 0; i < lines.length - 1; i++) {
      if (/tokens?\s*used/i.test(lines[i])) {
        const next = parseTokenNumber(lines[i + 1]);
        if (next !== undefined) {
          totalTokens = next;
          break;
        }
      }
    }
  }
  if (totalTokens === undefined && promptTokens !== undefined && completionTokens !== undefined) {
    totalTokens = promptTokens + completionTokens;
  }

  if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      source: 'reported',
    };
  }

  if (backendId === 'codex-cli' || backendId === 'claude-cli' || backendId === 'gemini-cli') {
    return estimateTokenUsage(promptInput, normalizedOutput);
  }

  return undefined;
}

/**
 * Collect text from Codex event payload
 */
function collectCodexText(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';

  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (!text) return;
    if (!parts.includes(text)) parts.push(text);
  };

  push(obj.text);
  push(obj.output_text);
  push(obj.message);

  const content = obj.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string') {
        push(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const segment = item as Record<string, unknown>;
      push(segment.text);
      push(segment.output_text);
      push(segment.value);
    }
  }

  const outputs = obj.output;
  if (Array.isArray(outputs)) {
    for (const item of outputs) {
      if (!item || typeof item !== 'object') continue;
      const segment = item as Record<string, unknown>;
      push(segment.text);
      push(segment.output_text);
      push(segment.value);
      const nestedContent = segment.content;
      if (Array.isArray(nestedContent)) {
        for (const nested of nestedContent) {
          if (!nested || typeof nested !== 'object') continue;
          const nestedRecord = nested as Record<string, unknown>;
          push(nestedRecord.text);
          push(nestedRecord.output_text);
          push(nestedRecord.value);
        }
      }
    }
  }

  return parts.join('\n').trim();
}

/**
 * Extract assistant message from Codex event
 */
function extractCodexAssistantMessage(event: unknown): string | null {
  if (!event || typeof event !== 'object') return null;
  const record = event as Record<string, unknown>;
  const eventType = String(record.type || '').toLowerCase();
  const item = record.item && typeof record.item === 'object'
    ? (record.item as Record<string, unknown>)
    : null;

  if (item) {
    const itemType = String(item.type || '').toLowerCase();
    const role = String(item.role || '').toLowerCase();
    const isAssistantItem =
      role === 'assistant' ||
      itemType.includes('assistant') ||
      itemType.includes('agent_message') ||
      itemType.includes('assistant_message');

    if (isAssistantItem) {
      const text = collectCodexText(item);
      if (text) return text;
    }
  }

  if (eventType === 'turn.completed' || eventType === 'response.completed' || eventType === 'message.completed') {
    const text = collectCodexText(record.turn || record.response || record.message || record);
    if (text) return text;
  }

  return null;
}

/**
 * Deduplicate repeated response blocks
 */
function dedupeRepeatedResponseBlock(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (paragraphs.length >= 2 && paragraphs.length % 2 === 0) {
    const half = paragraphs.length / 2;
    const left = paragraphs.slice(0, half).join('\n\n');
    const right = paragraphs.slice(half).join('\n\n');
    if (left === right) {
      return left.trim();
    }
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  if (lines.length >= 2 && lines.length % 2 === 0) {
    const half = lines.length / 2;
    const left = lines.slice(0, half).join('\n');
    const right = lines.slice(half).join('\n');
    if (left === right) {
      return left.trim();
    }
  }

  return trimmed;
}

/**
 * Normalize CLI output by backend type
 */
export function normalizeCliOutput(backendId: `${string}-cli`, output: string): string {
  const text = output.trim();
  if (backendId === 'gemini-cli') {
    const cleaned = text
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (trimmed.startsWith('Loaded cached credentials')) return false;
        if (/^Attempt \d+ failed:/i.test(trimmed)) return false;
        if (/^Error executing tool .*$/i.test(trimmed)) return false;
        if (/^Tool ".*" not found\./i.test(trimmed)) return false;
        return true;
      })
      .join('\n')
      .trim();
    return cleaned || '(no response)';
  }

  if (backendId === 'claude-cli') {
    const cleaned = text
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        if (trimmed.startsWith('Loaded cached credentials.')) return false;
        if (/^Reading prompt from stdin/i.test(trimmed)) return false;
        if (/^Using fallback model/i.test(trimmed)) return false;
        return true;
      })
      .join('\n')
      .trim();
    return cleaned || '(no response)';
  }

  if (backendId === 'codex-cli') {
    const jsonMessages: string[] = [];
    let sawJsonEvents = false;
    const jsonObjects = extractJsonObjectsFromText(text);
    for (const objectText of jsonObjects) {
      try {
        const event = JSON.parse(objectText) as Record<string, unknown>;
        if (event && typeof event.type === 'string') {
          sawJsonEvents = true;
        }
        const msg = extractCodexAssistantMessage(event);
        if (msg && !jsonMessages.includes(msg)) {
          jsonMessages.push(msg);
        }
      } catch {
        // ignore malformed segments
      }
    }

    if (jsonMessages.length > 0) {
      return dedupeRepeatedResponseBlock(jsonMessages.join('\n\n').trim());
    }

    const rawLines = text.split(/\r?\n/);
    const assistantMarkerIndex = (() => {
      for (let i = rawLines.length - 1; i >= 0; i--) {
        const trimmed = rawLines[i]?.trim().toLowerCase();
        if (trimmed === 'codex' || trimmed === 'assistant') {
          return i;
        }
      }
      return -1;
    })();

    if (assistantMarkerIndex >= 0) {
      let lastNonEmpty = '';
      const assistantBody = rawLines
        .slice(assistantMarkerIndex + 1)
        .filter((line) => {
          const trimmed = line.trim();
          if (!trimmed) {
            return false;
          }
          if (trimmed === 'tokens used') {
            lastNonEmpty = trimmed;
            return false;
          }
          if (/^[\d,]+$/.test(trimmed) && lastNonEmpty === 'tokens used') {
            return false;
          }
          lastNonEmpty = trimmed;
          return true;
        })
        .join('\n')
        .trim();

      if (assistantBody) {
        return dedupeRepeatedResponseBlock(assistantBody);
      }
    }

    const cleaned = text
      .split(/\r?\n/)
      .filter((line, index, lines) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        if (trimmed.startsWith('{') && trimmed.includes('"type"')) return false;
        if (trimmed.includes('{"type":"')) return false;
        if (/"type"\s*:\s*"(thread|turn|item|response|message)\./i.test(trimmed)) return false;
        if (/^\d{4}-\d{2}-\d{2}t.*codex_core::shell_snapshot/i.test(trimmed)) return false;
        if (trimmed.startsWith('OpenAI Codex v')) return false;
        if (trimmed === '--------') return false;
        if (/^(workdir|model|provider|approval|sandbox|reasoning effort|reasoning summaries|session id):/i.test(trimmed)) return false;
        if (trimmed === 'user' || trimmed === 'codex') return false;
        if (trimmed.startsWith('mcp startup:')) return false;
        if (trimmed === 'tokens used') return false;
        if (trimmed.startsWith('Loaded cached credentials')) return false;
        if (/^[\d,]+$/.test(trimmed)) {
          let previousMeaningful = '';
          for (let i = index - 1; i >= 0; i--) {
            const candidate = lines[i]?.trim();
            if (!candidate) continue;
            previousMeaningful = candidate;
            break;
          }
          if (previousMeaningful === 'tokens used') {
            return false;
          }
        }
        return true;
      })
      .join('\n')
      .trim();
    if (cleaned) return dedupeRepeatedResponseBlock(cleaned);
    if (/CLI timeout exceeded/i.test(text) && sawJsonEvents) {
      return 'CLI timeout exceeded before final assistant response.';
    }
    if (sawJsonEvents) {
      return '(no final assistant response from codex-cli)';
    }
    return '(no response)';
  }

  // ─── Kilo CLI: strip the "> code · model" prefix line from output
  if (backendId === 'kilo-cli') {
    const cleaned = text
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        // Strip kilo's status prefix like "> code · kilo-auto/free"
        if (/^>\s*(code|agent|architect)\s*·\s*.+/i.test(trimmed)) return false;
        // Strip token/cost lines
        if (/^(tokens|cost|duration|model):/i.test(trimmed)) return false;
        return true;
      })
      .join('\n')
      .trim();
    return cleaned || '(no response)';
  }

  if (backendId !== 'openai-cli') return text;

  if (!text) {
    return 'No output from openai-cli. This installation may only provide SDK migration utilities.';
  }

  if (/Unknown subcommand|Usage:\s*openai\s*<subcommand>/i.test(text)) {
    return `${text}\nHint: openai-cli expects subcommands (not free-text prompts).`;
  }

  return text;
}
