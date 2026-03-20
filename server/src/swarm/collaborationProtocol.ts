/**
 * Inter-Agent Collaboration Protocol
 *
 * Enables multi-agent coordination through:
 * - Message passing between agents
 * - Action proposal and consensus voting
 * - Task handoff with context preservation
 * - Session-based conversation management
 */

import { EventEmitter } from 'events';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CollaborationProtocol');

export type MessageType = 'request' | 'response' | 'broadcast' | 'handoff';
export type VoteType = 'approve' | 'reject' | 'abstain';

export interface AgentMessage {
  from: string;
  to: string;
  type: MessageType;
  payload: Record<string, unknown>;
  timestamp: string;
  correlationId: string;
}

export interface Proposal {
  id: string;
  agentId: string;
  action: string;
  description?: string;
  timestamp: string;
}

export interface Vote {
  agentId: string;
  voteType: VoteType;
  reasoning?: string;
  timestamp: string;
}

export interface ConsensusResult {
  reached: boolean;
  result: 'approved' | 'rejected' | 'pending';
  votes: Vote[];
  approvalCount: number;
  rejectionCount: number;
  abstainCount: number;
}

export interface CollaborationSession {
  id: string;
  participants: string[];
  objective: string;
  messages: AgentMessage[];
  proposals: Map<string, Proposal>;
  votes: Map<string, Vote[]>;
  status: 'active' | 'paused' | 'completed';
  consensusReached: boolean;
  startedAt: string;
  completedAt?: string;
}

/**
 * Collaboration Protocol - Multi-agent coordination and consensus
 */
export class CollaborationProtocol extends EventEmitter {
  private sessions: Map<string, CollaborationSession> = new Map();
  private agentInboxes: Map<string, AgentMessage[]> = new Map();
  private handoffHistory: Array<{
    sessionId: string;
    from: string;
    to: string;
    context: Record<string, unknown>;
    timestamp: string;
  }> = [];

  constructor() {
    super();
    log.info('CollaborationProtocol initialized');
  }

  /**
   * Create a new collaboration session
   */
  createSession(participants: string[], objective: string): CollaborationSession {
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const now = new Date().toISOString();

    const session: CollaborationSession = {
      id: sessionId,
      participants,
      objective,
      messages: [],
      proposals: new Map(),
      votes: new Map(),
      status: 'active',
      consensusReached: false,
      startedAt: now,
    };

    this.sessions.set(sessionId, session);

    // Initialize inboxes for participants
    for (const participant of participants) {
      if (!this.agentInboxes.has(participant)) {
        this.agentInboxes.set(participant, []);
      }
    }

    this.emit('session:created', session);
    log.info('Collaboration session created', {
      sessionId,
      objective,
      participantCount: participants.length,
    });

    return session;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): CollaborationSession | null {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Send message from one agent to another
   */
  sendMessage(sessionId: string, message: AgentMessage): boolean {
    const session = this.getSession(sessionId);
    if (!session) {
      log.warn('Session not found', { sessionId });
      return false;
    }

    // Validate participants
    if (
      !session.participants.includes(message.from) ||
      (message.to !== '*' && !session.participants.includes(message.to))
    ) {
      log.warn('Invalid message participants', {
        sessionId,
        from: message.from,
        to: message.to,
      });
      return false;
    }

    // Add to session messages
    session.messages.push(message);

    // Deliver to recipient(s)
    if (message.to === '*') {
      // Broadcast to all except sender
      for (const participant of session.participants) {
        if (participant !== message.from) {
          this.deliverToInbox(participant, message);
        }
      }
    } else {
      this.deliverToInbox(message.to, message);
    }

    this.emit('message:sent', { sessionId, message });
    log.debug('Message sent', {
      sessionId,
      from: message.from,
      to: message.to,
      type: message.type,
    });

    return true;
  }

  /**
   * Deliver message to agent's inbox
   */
  private deliverToInbox(agentId: string, message: AgentMessage): void {
    const inbox = this.agentInboxes.get(agentId);
    if (inbox) {
      inbox.push(message);
    }
  }

  /**
   * Get agent's inbox
   */
  getAgentInbox(agentId: string): AgentMessage[] {
    return this.agentInboxes.get(agentId) || [];
  }

  /**
   * Clear agent's inbox
   */
  clearAgentInbox(agentId: string): void {
    this.agentInboxes.set(agentId, []);
  }

  /**
   * Propose an action for consensus voting
   */
  proposeAction(
    sessionId: string,
    agentId: string,
    action: string,
    description?: string
  ): string | null {
    const session = this.getSession(sessionId);
    if (!session) {
      log.warn('Session not found for proposal', { sessionId });
      return null;
    }

    if (!session.participants.includes(agentId)) {
      log.warn('Agent not in session', { sessionId, agentId });
      return null;
    }

    const proposalId = `prop_${sessionId}_${Date.now()}`;
    const proposal: Proposal = {
      id: proposalId,
      agentId,
      action,
      description,
      timestamp: new Date().toISOString(),
    };

    session.proposals.set(proposalId, proposal);
    session.votes.set(proposalId, []);

    this.emit('proposal:created', { sessionId, proposal });
    log.info('Action proposed', {
      sessionId,
      proposalId,
      agentId,
      action: action.substring(0, 50),
    });

    return proposalId;
  }

  /**
   * Vote on a proposal
   */
  voteOnProposal(
    sessionId: string,
    agentId: string,
    proposalId: string,
    voteType: VoteType,
    reasoning?: string
  ): boolean {
    const session = this.getSession(sessionId);
    if (!session) {
      log.warn('Session not found for vote', { sessionId });
      return false;
    }

    const votes = session.votes.get(proposalId);
    if (!votes) {
      log.warn('Proposal not found for vote', { sessionId, proposalId });
      return false;
    }

    // Prevent duplicate votes from same agent
    if (votes.some(v => v.agentId === agentId)) {
      log.warn('Agent already voted on proposal', { sessionId, proposalId, agentId });
      return false;
    }

    const vote: Vote = {
      agentId,
      voteType,
      reasoning,
      timestamp: new Date().toISOString(),
    };

    votes.push(vote);
    this.emit('vote:submitted', { sessionId, proposalId, vote });

    log.debug('Vote submitted', {
      sessionId,
      proposalId,
      agentId,
      voteType,
    });

    return true;
  }

  /**
   * Check consensus on a proposal
   */
  checkConsensus(sessionId: string, proposalId: string): ConsensusResult {
    const session = this.getSession(sessionId);
    if (!session) {
      return {
        reached: false,
        result: 'pending',
        votes: [],
        approvalCount: 0,
        rejectionCount: 0,
        abstainCount: 0,
      };
    }

    const votes = session.votes.get(proposalId) || [];
    const proposal = session.proposals.get(proposalId);

    const approvalCount = votes.filter(v => v.voteType === 'approve').length;
    const rejectionCount = votes.filter(v => v.voteType === 'reject').length;
    const abstainCount = votes.filter(v => v.voteType === 'abstain').length;

    // Require unanimous approval or majority (>50%) with no rejections
    const voteThreshold = Math.ceil(session.participants.length * 0.5);
    const allVoted = approvalCount + rejectionCount + abstainCount === session.participants.length;

    let reached = false;
    let result: 'approved' | 'rejected' | 'pending' = 'pending';

    if (rejectionCount > 0) {
      result = 'rejected';
      reached = true;
    } else if (approvalCount >= voteThreshold) {
      result = 'approved';
      reached = true;
    } else if (allVoted) {
      result = approvalCount > abstainCount ? 'approved' : 'rejected';
      reached = true;
    }

    if (reached) {
      this.emit('consensus:reached', {
        sessionId,
        proposalId,
        result,
      });
    }

    return {
      reached,
      result,
      votes,
      approvalCount,
      rejectionCount,
      abstainCount,
    };
  }

  /**
   * Handoff task from one agent to another
   */
  handoff(
    sessionId: string,
    fromAgent: string,
    toAgent: string,
    context: Record<string, unknown>
  ): boolean {
    const session = this.getSession(sessionId);
    if (!session) {
      log.warn('Session not found for handoff', { sessionId });
      return false;
    }

    if (
      !session.participants.includes(fromAgent) ||
      !session.participants.includes(toAgent)
    ) {
      log.warn('Invalid agents for handoff', { sessionId, fromAgent, toAgent });
      return false;
    }

    // Create handoff message
    const handoffMsg: AgentMessage = {
      from: fromAgent,
      to: toAgent,
      type: 'handoff',
      payload: context,
      timestamp: new Date().toISOString(),
      correlationId: `handoff_${sessionId}_${Date.now()}`,
    };

    this.sendMessage(sessionId, handoffMsg);

    // Record in history
    this.handoffHistory.push({
      sessionId,
      from: fromAgent,
      to: toAgent,
      context,
      timestamp: new Date().toISOString(),
    });

    this.emit('handoff:executed', {
      sessionId,
      fromAgent,
      toAgent,
      contextKeys: Object.keys(context),
    });

    log.info('Task handoff executed', {
      sessionId,
      from: fromAgent,
      to: toAgent,
      contextSize: Object.keys(context).length,
    });

    return true;
  }

  /**
   * Pause session
   */
  pauseSession(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    session.status = 'paused';
    this.emit('session:paused', { sessionId });
    log.info('Session paused', { sessionId });
    return true;
  }

  /**
   * Resume session
   */
  resumeSession(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    session.status = 'active';
    this.emit('session:resumed', { sessionId });
    log.info('Session resumed', { sessionId });
    return true;
  }

  /**
   * Complete session
   */
  completeSession(sessionId: string): boolean {
    const session = this.getSession(sessionId);
    if (!session) return false;

    session.status = 'completed';
    session.completedAt = new Date().toISOString();
    this.emit('session:completed', { sessionId });
    log.info('Session completed', {
      sessionId,
      messageCount: session.messages.length,
      proposalCount: session.proposals.size,
    });
    return true;
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId: string): Record<string, unknown> | null {
    const session = this.getSession(sessionId);
    if (!session) return null;

    const approvedProposals = Array.from(session.proposals.values()).filter(p => {
      const consensus = this.checkConsensus(sessionId, p.id);
      return consensus.result === 'approved';
    }).length;

    return {
      sessionId,
      status: session.status,
      participants: session.participants.length,
      messages: session.messages.length,
      proposals: session.proposals.size,
      approvedProposals,
      uptime: new Date(session.startedAt).getTime() - Date.now(),
    };
  }

  /**
   * Get handoff history for session
   */
  getHandoffHistory(sessionId: string): Array<{
    from: string;
    to: string;
    timestamp: string;
  }> {
    return this.handoffHistory
      .filter(h => h.sessionId === sessionId)
      .map(({ from, to, timestamp }) => ({ from, to, timestamp }));
  }
}

// Singleton instance
let instance: CollaborationProtocol | null = null;

export function getCollaborationProtocol(): CollaborationProtocol {
  if (!instance) {
    instance = new CollaborationProtocol();
  }
  return instance;
}
