import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { broadcast } from './socketBroadcast.js';
import { createLogger } from './logger.js';

const log = createLogger('ApprovalSystem');

interface PendingApproval {
  id: string;
  action: string;
  details: string;
  chatId: string;
  createdAt: number;
  resolve: (value: boolean) => void;
  timeoutId: NodeJS.Timeout;
}

class ApprovalSystem extends EventEmitter {
  private pendingApprovals = new Map<string, PendingApproval>();
  private readonly DEFAULT_TIMEOUT_MS = 60000 * 5; // 5 minutes

  /**
   * Request human approval for a sensitive action.
   * This pauses the current async execution until the user approves or rejects,
   * or until the timeout is reached.
   */
  public async requestApproval(
    chatId: string,
    action: string,
    details: string,
    timeoutMs: number = this.DEFAULT_TIMEOUT_MS
  ): Promise<boolean> {
    const id = randomUUID();
    
    return new Promise<boolean>((resolve) => {
      const timeoutId = setTimeout(() => {
        log.warn(`Approval request timed out`, { approvalId: id, action });
        this.pendingApprovals.delete(id);
        this.emit('timeout', { id, action, chatId });
        resolve(false);
      }, timeoutMs);

      this.pendingApprovals.set(id, {
        id,
        action,
        details,
        chatId,
        createdAt: Date.now(),
        resolve,
        timeoutId
      });

      log.info(`Approval requested`, { approvalId: id, action, chatId });
      
      // Emit event internally (e.g., for Telegram/LINE bots to pick up and ask the user)
      this.emit('requested', { id, action, details, chatId });
      
      // Also broadcast to Web Dashboard via Socket.io
      broadcast('agent:approval_required', { id, action, details, chatId });
    });
  }

  /**
   * Resolve a pending approval (called when user clicks Approve or Reject)
   */
  public resolveApproval(id: string, approved: boolean): boolean {
    const pending = this.pendingApprovals.get(id);
    if (!pending) {
      log.warn(`Attempted to resolve unknown or expired approval`, { approvalId: id });
      return false;
    }

    clearTimeout(pending.timeoutId);
    this.pendingApprovals.delete(id);
    log.info(`Approval resolved`, { approvalId: id, approved, action: pending.action });
    
    // Resume the suspended execution
    pending.resolve(approved);
    
    // Broadcast resolution so UI can update
    broadcast('agent:approval_resolved', { id, action: pending.action, approved });
    
    return true;
  }

  /**
   * Get all currently pending approvals
   */
  public getPendingApprovals() {
    return Array.from(this.pendingApprovals.values()).map(p => ({
      id: p.id,
      action: p.action,
      details: p.details,
      chatId: p.chatId,
      createdAt: p.createdAt
    }));
  }
}

// Export singleton instance
export const approvalSystem = new ApprovalSystem();
