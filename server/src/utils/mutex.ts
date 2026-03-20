/**
 * Simple Async Mutex — Per-key locking for memory operations
 *
 * Prevents race conditions when multiple concurrent requests
 * write to the same chat's memory simultaneously.
 */

export class KeyedMutex {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire a lock for the given key.
   * Returns an unlock function that MUST be called when done.
   */
  async acquire(key: string): Promise<() => void> {
    // Wait for existing lock to release
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }

    // Create new lock
    let unlock!: () => void;
    const promise = new Promise<void>(resolve => {
      unlock = resolve;
    });
    this.locks.set(key, promise);

    // Return release function
    return () => {
      this.locks.delete(key);
      unlock();
    };
  }

  /**
   * Execute a function while holding the lock for a key
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Number of active locks */
  get size(): number {
    return this.locks.size;
  }
}

/** Global mutex for memory operations (per-chatId locking) */
export const memoryMutex = new KeyedMutex();
