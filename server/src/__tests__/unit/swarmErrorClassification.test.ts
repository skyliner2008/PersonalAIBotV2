import { describe, it, expect } from 'vitest';
import { classifySwarmError } from '../../swarm/swarmErrorCodes.js';

describe('classifySwarmError', () => {
  it('classifies timeout errors', () => {
    const result = classifySwarmError('Request timeout after 120s');
    expect(result.code).toBe('SWARM_TIMEOUT');
    expect(result.category).toBe('timeout');
    expect(result.recoverable).toBe(true);
  });

  it('classifies "timed out" variant', () => {
    const result = classifySwarmError('Task timed out waiting for response');
    expect(result.code).toBe('SWARM_TIMEOUT');
    expect(result.recoverable).toBe(true);
  });

  it('classifies rate limit (429)', () => {
    const result = classifySwarmError('HTTP 429 Too Many Requests');
    expect(result.code).toBe('SWARM_RATE_LIMIT');
    expect(result.category).toBe('rate_limit');
    expect(result.recoverable).toBe(true);
  });

  it('classifies rate limit by text', () => {
    const result = classifySwarmError('API rate limit exceeded, try again later');
    expect(result.code).toBe('SWARM_RATE_LIMIT');
  });

  it('classifies auth errors (401)', () => {
    const result = classifySwarmError('401 Unauthorized: Invalid API key');
    expect(result.code).toBe('SWARM_AUTH_ERROR');
    expect(result.category).toBe('auth');
    expect(result.recoverable).toBe(false);
  });

  it('classifies forbidden (403)', () => {
    const result = classifySwarmError('403 Forbidden');
    expect(result.code).toBe('SWARM_AUTH_ERROR');
  });

  it('classifies connection refused', () => {
    const result = classifySwarmError('connect ECONNREFUSED 127.0.0.1:3000');
    expect(result.code).toBe('SWARM_CONNECTION');
    expect(result.category).toBe('connection');
    expect(result.recoverable).toBe(true);
  });

  it('classifies connection reset', () => {
    const result = classifySwarmError('read ECONNRESET');
    expect(result.code).toBe('SWARM_CONNECTION');
  });

  it('classifies CLI crashes (spawn ENOENT)', () => {
    const result = classifySwarmError('spawn gemini ENOENT');
    expect(result.code).toBe('SWARM_CLI_CRASH');
    expect(result.category).toBe('cli_crash');
    expect(result.recoverable).toBe(false);
  });

  it('classifies exited with code', () => {
    const result = classifySwarmError('Process exited with code 1');
    expect(result.code).toBe('SWARM_CLI_CRASH');
  });

  it('classifies JSON parse errors', () => {
    const result = classifySwarmError('SyntaxError: Unexpected token < in JSON.parse');
    expect(result.code).toBe('SWARM_PARSE_ERROR');
    expect(result.category).toBe('output_parse');
    expect(result.recoverable).toBe(true);
  });

  it('returns SWARM_UNKNOWN for unrecognized errors', () => {
    const result = classifySwarmError('Something completely unexpected happened');
    expect(result.code).toBe('SWARM_UNKNOWN');
    expect(result.category).toBe('unknown');
    expect(result.recoverable).toBe(false);
  });

  it('returns SWARM_UNKNOWN for undefined/null input', () => {
    expect(classifySwarmError(undefined).code).toBe('SWARM_UNKNOWN');
    expect(classifySwarmError('').code).toBe('SWARM_UNKNOWN');
  });

  it('all classifications have required fields', () => {
    const errors = [
      'timeout', '429', '401', 'ECONNREFUSED', 'spawn ENOENT',
      'JSON.parse', 'random error', undefined,
    ];
    for (const err of errors) {
      const c = classifySwarmError(err);
      expect(c).toHaveProperty('code');
      expect(c).toHaveProperty('category');
      expect(c).toHaveProperty('recoverable');
      expect(c).toHaveProperty('label');
      expect(typeof c.code).toBe('string');
      expect(typeof c.label).toBe('string');
      expect(typeof c.recoverable).toBe('boolean');
    }
  });
});
