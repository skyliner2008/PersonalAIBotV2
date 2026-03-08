// ============================================================
// Unit tests for MessageQueue — pure-logic replica
// (Same pattern as db.test.ts: test logic in isolation without native deps)
// ============================================================
import { describe, it, expect } from 'vitest';

// ---- Replicate MessageQueue logic for pure testing ----
// This avoids importing queue.ts which depends on db.js (native SQLite)

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

interface QueueItem<T = any> {
    id: string;
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: any) => void;
    retries: number;
    maxRetries: number;
}

class TestMessageQueue {
    private queue: QueueItem[] = [];
    private processing = false;
    private concurrency: number;
    private activeCount = 0;
    private maxQueueSize: number;
    private totalProcessed = 0;
    private totalErrors = 0;
    private totalRetries = 0;
    private totalRejected = 0;

    constructor(concurrency = 1, maxQueueSize = 100) {
        this.concurrency = concurrency;
        this.maxQueueSize = maxQueueSize;
    }

    public enqueue<T>(id: string, fn: () => Promise<T>, maxRetries = 3): Promise<T> {
        if (this.queue.length >= this.maxQueueSize) {
            this.totalRejected++;
            return Promise.reject(new Error(`Queue full (${this.maxQueueSize} pending). Try again later.`));
        }
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ id, fn, resolve, reject, retries: 0, maxRetries });
            this.processNext();
        });
    }

    private async processNext(): Promise<void> {
        if (this.activeCount >= this.concurrency || this.queue.length === 0) return;
        const item = this.queue.shift();
        if (!item) return;
        this.activeCount++;
        this.processing = true;
        try {
            const result = await this.executeWithRetry(item);
            item.resolve(result);
            this.totalProcessed++;
        } catch (error) {
            item.reject(error);
            this.totalErrors++;
        } finally {
            this.activeCount--;
            this.processing = this.activeCount > 0 || this.queue.length > 0;
            this.processNext();
        }
    }

    private async executeWithRetry<T>(item: QueueItem<T>): Promise<T> {
        while (true) {
            try {
                return await item.fn();
            } catch (error: any) {
                item.retries++;
                if (item.retries >= item.maxRetries) throw error;
                this.totalRetries++;
                await delay(10); // Fast retry for tests
            }
        }
    }

    public getStats() {
        return {
            pending: this.queue.length,
            active: this.activeCount,
            isProcessing: this.processing,
            totalProcessed: this.totalProcessed,
            totalErrors: this.totalErrors,
            totalRetries: this.totalRetries,
            totalRejected: this.totalRejected,
        };
    }

    public clear(): void {
        for (const item of this.queue) {
            item.reject(new Error('Queue cleared'));
        }
        this.queue = [];
    }
}

// ---- Tests ----

describe('MessageQueue', () => {
    it('processes a single task successfully', async () => {
        const queue = new TestMessageQueue(1);
        const result = await queue.enqueue('test-1', async () => 'done');
        expect(result).toBe('done');
        expect(queue.getStats().totalProcessed).toBe(1);
    });

    it('processes multiple tasks in FIFO order', async () => {
        const queue = new TestMessageQueue(1);
        const order: number[] = [];

        const p1 = queue.enqueue('t1', async () => { order.push(1); return 'a'; });
        const p2 = queue.enqueue('t2', async () => { order.push(2); return 'b'; });
        const p3 = queue.enqueue('t3', async () => { order.push(3); return 'c'; });

        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
        expect(r1).toBe('a');
        expect(r2).toBe('b');
        expect(r3).toBe('c');
        expect(order).toEqual([1, 2, 3]);
    });

    it('retries on failure and succeeds eventually', async () => {
        const queue = new TestMessageQueue(1);
        let attempts = 0;

        const result = await queue.enqueue('retry-test', async () => {
            attempts++;
            if (attempts < 3) throw new Error('fail');
            return 'success';
        }, 3);

        expect(result).toBe('success');
        expect(attempts).toBe(3);
        expect(queue.getStats().totalRetries).toBeGreaterThanOrEqual(2);
    });

    it('rejects after max retries exhausted', async () => {
        const queue = new TestMessageQueue(1);

        await expect(
            queue.enqueue('fail-test', async () => { throw new Error('always fails'); }, 2)
        ).rejects.toThrow('always fails');

        expect(queue.getStats().totalErrors).toBe(1);
    });

    it('rejects when queue is full', async () => {
        const queue = new TestMessageQueue(1, 2);

        // First task will be processing immediately, then 2 more fill the queue
        const blocker = queue.enqueue('block', () => new Promise(resolve => setTimeout(() => resolve('ok'), 200)));
        queue.enqueue('q1', async () => 'a');
        queue.enqueue('q2', async () => 'b');

        // Queue should now be full (2 pending)
        await expect(
            queue.enqueue('overflow', async () => 'c')
        ).rejects.toThrow('Queue full');

        expect(queue.getStats().totalRejected).toBeGreaterThanOrEqual(1);
        await blocker;
    });

    it('clear() rejects all pending tasks', async () => {
        const queue = new TestMessageQueue(1);

        // First task occupies processing, second is pending
        const slow = queue.enqueue('slow', () => new Promise(r => setTimeout(() => r('done'), 200)));
        const pending = queue.enqueue('pending', async () => 'never');

        // Clear immediately — pending should be rejected
        queue.clear();

        await expect(pending).rejects.toThrow('Queue cleared');
        await slow.catch(() => { }); // clean up
    });

    it('getStats() returns valid stats object', () => {
        const queue = new TestMessageQueue(2, 50);
        const stats = queue.getStats();

        expect(stats).toHaveProperty('pending');
        expect(stats).toHaveProperty('active');
        expect(stats).toHaveProperty('isProcessing');
        expect(stats).toHaveProperty('totalProcessed');
        expect(stats).toHaveProperty('totalErrors');
        expect(stats).toHaveProperty('totalRetries');
        expect(stats).toHaveProperty('totalRejected');
        expect(stats.pending).toBe(0);
        expect(stats.active).toBe(0);
    });

    it('supports concurrent processing', async () => {
        const queue = new TestMessageQueue(3);
        const startTimes: number[] = [];

        const tasks = Array.from({ length: 3 }, (_, i) =>
            queue.enqueue(`concurrent-${i}`, async () => {
                startTimes.push(Date.now());
                await delay(50);
                return `done-${i}`;
            })
        );

        const results = await Promise.all(tasks);
        expect(results).toHaveLength(3);

        // All should have started roughly at the same time (within 50ms)
        if (startTimes.length === 3) {
            const spread = Math.max(...startTimes) - Math.min(...startTimes);
            expect(spread).toBeLessThan(50);
        }
    });
});
