import { delay, randomBetween } from './utils.js';
import { addLog } from './database/db.js';
import logger from './utils/logger.js';

// ============================================================
// Message Processing Queue with Auto-Retry
// ============================================================
// Prevents race conditions when multiple messages arrive simultaneously
// Provides exponential backoff retry for failed AI calls

interface QueueItem<T = any> {
    id: string;
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (error: any) => void;
    retries: number;
    maxRetries: number;
}

export class MessageQueue {
    private queue: QueueItem[] = [];
    private processing = false;
    private concurrency: number;
    private activeCount = 0;
    private maxQueueSize: number;

    // Stats
    private totalProcessed = 0;
    private totalErrors = 0;
    private totalRetries = 0;
    private totalRejected = 0;

    constructor(concurrency: number = 1, maxQueueSize: number = 100) {
        this.concurrency = concurrency;
        this.maxQueueSize = maxQueueSize;
    }

    /**
     * Add a task to the queue with auto-retry.
     * Returns a promise that resolves when the task completes.
     * Rejects immediately if the queue is full.
     */
    public enqueue<T>(
        id: string,
        fn: () => Promise<T>,
        maxRetries: number = 3
    ): Promise<T> {
        if (this.queue.length >= this.maxQueueSize) {
            this.totalRejected++;
            return Promise.reject(new Error(`Queue full (${this.maxQueueSize} pending). Try again later.`));
        }
        return new Promise<T>((resolve, reject) => {
            this.queue.push({
                id,
                fn,
                resolve,
                reject,
                retries: 0,
                maxRetries,
            });
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
            // Process next item
            this.processNext();
        }
    }

    private async executeWithRetry<T>(item: QueueItem<T>): Promise<T> {
        while (true) {
            try {
                return await item.fn();
            } catch (error: any) {
                item.retries++;

                if (item.retries >= item.maxRetries) {
                    addLog('queue', `Task failed after ${item.retries} retries`, `${item.id}: ${error.message}`, 'error');
                    throw error;
                }

                // Exponential backoff: 1s, 2s, 4s, ...
                const backoffMs = Math.pow(2, item.retries - 1) * 1000;
                const jitter = randomBetween(0, 500);
                const waitMs = backoffMs + jitter;

                logger.warn(`Retry ${item.retries}/${item.maxRetries} for ${item.id} in ${waitMs}ms: ${error.message}`);
                addLog('queue', `Retry ${item.retries}/${item.maxRetries}`, `${item.id}: ${error.message}`, 'warning');
                this.totalRetries++;

                await delay(waitMs);
            }
        }
    }

    /**
     * Get queue stats for health monitoring
     */
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

    /**
     * Clear all pending items (for shutdown)
     */
    public clear(): void {
        for (const item of this.queue) {
            item.reject(new Error('Queue cleared'));
        }
        this.queue = [];
    }
}

// Singleton instances
export const chatQueue = new MessageQueue(2);    // 2 concurrent chat replies
export const webhookQueue = new MessageQueue(3);  // 3 concurrent webhook processing
