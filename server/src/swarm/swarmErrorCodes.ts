/**
 * Structured error codes for swarm task failures.
 * Enables dashboard to group, filter, and visualize failures by category.
 */

export interface SwarmErrorClassification {
  code: string;
  category: 'timeout' | 'rate_limit' | 'auth' | 'connection' | 'cli_crash' | 'output_parse' | 'unknown';
  recoverable: boolean;
  label: string;
}

const ERROR_PATTERNS: Array<{ pattern: RegExp; classification: SwarmErrorClassification }> = [
  {
    pattern: /timeout|timed?\s*out/i,
    classification: { code: 'SWARM_TIMEOUT', category: 'timeout', recoverable: true, label: 'Task timed out' },
  },
  {
    pattern: /429|rate.?limit/i,
    classification: { code: 'SWARM_RATE_LIMIT', category: 'rate_limit', recoverable: true, label: 'Rate limit exceeded' },
  },
  {
    pattern: /401|403|unauthorized|forbidden|auth/i,
    classification: { code: 'SWARM_AUTH_ERROR', category: 'auth', recoverable: false, label: 'Authentication/authorization error' },
  },
  {
    pattern: /ECONNREFUSED|ECONNRESET|ENOTFOUND|connection\s*(refused|reset|closed)/i,
    classification: { code: 'SWARM_CONNECTION', category: 'connection', recoverable: true, label: 'Connection error' },
  },
  {
    pattern: /spawn|ENOENT|command\s*not\s*found|exited\s*with\s*code/i,
    classification: { code: 'SWARM_CLI_CRASH', category: 'cli_crash', recoverable: false, label: 'CLI process crashed' },
  },
  {
    pattern: /JSON\.parse|Unexpected\s*token|invalid\s*json|parse\s*error/i,
    classification: { code: 'SWARM_PARSE_ERROR', category: 'output_parse', recoverable: true, label: 'Output parse failure' },
  },
];

export function classifySwarmError(errorMsg?: string): SwarmErrorClassification {
  if (!errorMsg) {
    return { code: 'SWARM_UNKNOWN', category: 'unknown', recoverable: false, label: 'Unknown error' };
  }
  for (const { pattern, classification } of ERROR_PATTERNS) {
    if (pattern.test(errorMsg)) return classification;
  }
  return { code: 'SWARM_UNKNOWN', category: 'unknown', recoverable: false, label: 'Unknown error' };
}
