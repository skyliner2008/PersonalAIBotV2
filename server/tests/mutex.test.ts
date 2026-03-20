import { describe, it, expect } from 'vitest';
import { KeyedMutex } from '../src/utils/mutex.js';

describe('KeyedMutex', () => {
  it('should acquire and release a lock', async () => {
    const mutex = new KeyedMutex();
    const release = await mutex.acquire('key1');
    expect(mutex.size).toBe(1);
    release();
    expect(mutex.size).toBe(0);
  });

  it('should allow different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const release1 = await mutex.acquire('a');
    const release2 = await mutex.acquire('b');
    expect(mutex.size).toBe(2);
    release1();
    release2();
    expect(mutex.size).toBe(0);
  });

  it('should serialize access for the same key', async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];

    const task1 = async () => {
      const release = await mutex.acquire('key');
      order.push(1);
      await new Promise(r => setTimeout(r, 50));
      order.push(2);
      release();
    };

    const task2 = async () => {
      const release = await mutex.acquire('key');
      order.push(3);
      release();
    };

    // Start both — task2 should wait for task1
    await Promise.all([task1(), task2()]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('withLock should execute fn and auto-release', async () => {
    const mutex = new KeyedMutex();
    const result = await mutex.withLock('key', async () => {
      expect(mutex.size).toBe(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(mutex.size).toBe(0);
  });

  it('withLock should release on error', async () => {
    const mutex = new KeyedMutex();
    await expect(
      mutex.withLock('key', async () => {
        throw new Error('fail');
      })
    ).rejects.toThrow('fail');
    expect(mutex.size).toBe(0);
  });

  it('should handle multiple sequential locks on same key', async () => {
    const mutex = new KeyedMutex();
    for (let i = 0; i < 5; i++) {
      const release = await mutex.acquire('seq');
      release();
    }
    expect(mutex.size).toBe(0);
  });
});
