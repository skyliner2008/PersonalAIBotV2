import { delay, randomBetween } from './utils.js';
import { addLog } from './database/db.js';
export class MessageQueue {
    queue = [];
    processing = false;
    concurrency;
    activeCount = 0;
    maxQueueSize;
    // Stats
    totalProcessed = 0;
    totalErrors = 0;
    totalRetries = 0;
    totalRejected = 0;
    constructor(concurrency = 1, maxQueueSize = 100) {
        this.concurrency = concurrency;
        this.maxQueueSize = maxQueueSize;
    }
    /**
     * Add a task to the queue with auto-retry.
     * Returns a promise that resolves when the task completes.
     * Rejects immediately if the queue is full.
     */
    enqueue(id, fn, maxRetries = 3) {
        if (this.queue.length >= this.maxQueueSize) {
            this.totalRejected++;
            return Promise.reject(new Error(`Queue full (${this.maxQueueSize} pending). Try again later.`));
        }
        return new Promise((resolve, reject) => {
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
    async processNext() {
        if (this.activeCount >= this.concurrency || this.queue.length === 0)
            return;
        const item = this.queue.shift();
        if (!item)
            return;
        this.activeCount++;
        this.processing = true;
        try {
            const result = await this.executeWithRetry(item);
            item.resolve(result);
            this.totalProcessed++;
        }
        catch (error) {
            item.reject(error);
            this.totalErrors++;
        }
        finally {
            this.activeCount--;
            this.processing = this.activeCount > 0 || this.queue.length > 0;
            // Process next item
            this.processNext();
        }
    }
    async executeWithRetry(item) {
        while (true) {
            try {
                return await item.fn();
            }
            catch (error) {
                item.retries++;
                if (item.retries >= item.maxRetries) {
                    addLog('queue', `Task failed after ${item.retries} retries`, `${item.id}: ${error.message}`, 'error');
                    throw error;
                }
                // Exponential backoff: 1s, 2s, 4s, ...
                const backoffMs = Math.pow(2, item.retries - 1) * 1000;
                const jitter = randomBetween(0, 500);
                const waitMs = backoffMs + jitter;
                console.log(`[Queue] Retry ${item.retries}/${item.maxRetries} for ${item.id} in ${waitMs}ms: ${error.message}`);
                addLog('queue', `Retry ${item.retries}/${item.maxRetries}`, `${item.id}: ${error.message}`, 'warning');
                this.totalRetries++;
                await delay(waitMs);
            }
        }
    }
    /**
     * Get queue stats for health monitoring
     */
    getStats() {
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
    clear() {
        for (const item of this.queue) {
            item.reject(new Error('Queue cleared'));
        }
        this.queue = [];
    }
}
// Singleton instances
export const chatQueue = new MessageQueue(2); // 2 concurrent chat replies
export const webhookQueue = new MessageQueue(3); // 3 concurrent webhook processing
//# sourceMappingURL=queue.js.map