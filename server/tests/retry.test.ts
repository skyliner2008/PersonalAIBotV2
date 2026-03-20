import { describe, it, expect, vi } from 'vitest';

// Mock logger before importing retry module
vi.mock('../src/utils/logger.js', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { withRetry, withTimeoutRetry } from '../src/utils/retry.js';

describe('withRetry', () => {
  it('should return result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on transient failure then succeed', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should throw after max retries exhausted', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('server error'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('server error');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('should NOT retry non-retryable errors (api key)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Invalid API key provided'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('Invalid API key');
    expect(fn).toHaveBeenCalledTimes(1); // no retry
  });

  it('should NOT retry 401 unauthorized', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('401 Unauthorized'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry safety/blocked errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Content blocked by safety filter'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('blocked');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should NOT retry 404 not found', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('model_not_found'));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 10 })
    ).rejects.toThrow('model_not_found');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should use default options when none provided', async () => {
    const fn = vi.fn().mockResolvedValue('default');
    const result = await withRetry(fn);
    expect(result).toBe('default');
  });
});

describe('withTimeoutRetry', () => {
  it('should pass AbortSignal to function', async () => {
    const fn = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      return 'done';
    });

    const result = await withTimeoutRetry(fn, 5000, { maxRetries: 1 });
    expect(result).toBe('done');
  });

  it('should abort on timeout', async () => {
    const fn = vi.fn().mockImplementation(async (signal: AbortSignal) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve('late'), 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    });

    await expect(
      withTimeoutRetry(fn, 50, { maxRetries: 1, baseDelayMs: 10 })
    ).rejects.toThrow();
  });
});
