export declare class MessageQueue {
    private queue;
    private processing;
    private concurrency;
    private activeCount;
    private maxQueueSize;
    private totalProcessed;
    private totalErrors;
    private totalRetries;
    private totalRejected;
    constructor(concurrency?: number, maxQueueSize?: number);
    /**
     * Add a task to the queue with auto-retry.
     * Returns a promise that resolves when the task completes.
     * Rejects immediately if the queue is full.
     */
    enqueue<T>(id: string, fn: () => Promise<T>, maxRetries?: number): Promise<T>;
    private processNext;
    private executeWithRetry;
    /**
     * Get queue stats for health monitoring
     */
    getStats(): {
        pending: number;
        active: number;
        isProcessing: boolean;
        totalProcessed: number;
        totalErrors: number;
        totalRetries: number;
        totalRejected: number;
    };
    /**
     * Clear all pending items (for shutdown)
     */
    clear(): void;
}
export declare const chatQueue: MessageQueue;
export declare const webhookQueue: MessageQueue;
