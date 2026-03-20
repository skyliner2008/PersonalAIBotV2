import { getDb } from '../database/db.js';
import { randomUUID } from 'crypto';
import { createLogger } from '../utils/logger.js';

const log = createLogger('PlanTracker');

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface PlanStep {
    id: string;
    description: string;
    status: StepStatus;
    result?: string;
}

export interface AgentPlan {
    id: string;
    chatId: string;
    objective: string;
    steps: PlanStep[];
    status: 'active' | 'completed' | 'failed' | 'paused';
    createdAt: number;
    updatedAt: number;
}

/**
 * Initialize a new plan for a specific chat.
 * If there is already an active plan, it will be marked as paused/overridden.
 */
export function createPlan(chatId: string, objective: string, steps: string[]): AgentPlan {
    const db = getDb();
    
    // Auto-pause any existing active plans for this chat to prevent confusion
    db.prepare(`UPDATE agent_plans SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE chat_id = ? AND status = 'active'`).run(chatId);

    const planId = randomUUID();
    const planSteps: PlanStep[] = steps.map((desc, idx) => ({
        id: `step-${idx + 1}`,
        description: desc,
        status: 'pending'
    }));

    const stepsJson = JSON.stringify(planSteps);
    
    db.prepare(`
        INSERT INTO agent_plans (id, chat_id, objective, steps_json, status)
        VALUES (?, ?, ?, ?, 'active')
    `).run(planId, chatId, objective, stepsJson);

    log.info(`New active plan created`, { planId, chatId, objective });

    return {
        id: planId,
        chatId,
        objective,
        steps: planSteps,
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

/**
 * Retrieve the currently active plan for a chat.
 */
export function getActivePlan(chatId: string): AgentPlan | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM agent_plans WHERE chat_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(chatId) as any;
    
    if (!row) return null;

    try {
        return {
            id: row.id,
            chatId: row.chat_id,
            objective: row.objective,
            steps: JSON.parse(row.steps_json),
            status: row.status,
            createdAt: new Date(row.created_at).getTime(),
            updatedAt: new Date(row.updated_at).getTime()
        };
    } catch (e) {
        log.error(`Failed to parse active plan json`, { planId: row.id, error: e });
        return null;
    }
}

/**
 * Update the status of a specific step in the active plan.
 */
export function updatePlanStep(chatId: string, stepId: string, status: StepStatus, result?: string): boolean {
    const plan = getActivePlan(chatId);
    if (!plan) return false;

    const stepIndex = plan.steps.findIndex(s => s.id === stepId);
    if (stepIndex === -1) return false;

    plan.steps[stepIndex].status = status;
    if (result) {
        plan.steps[stepIndex].result = result;
    }

    // Check if entire plan is completed
    const allCompleted = plan.steps.every(s => s.status === 'completed');
    const newStatus = allCompleted ? 'completed' : 'active';

    const db = getDb();
    db.prepare(`
        UPDATE agent_plans 
        SET steps_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(JSON.stringify(plan.steps), newStatus, plan.id);

    log.info(`Plan step updated`, { planId: plan.id, stepId, status });
    return true;
}

/**
 * Force cancel/complete the active plan.
 */
export function closeActivePlan(chatId: string, status: 'completed' | 'failed' | 'paused'): boolean {
    const db = getDb();
    const result = db.prepare(`
        UPDATE agent_plans 
        SET status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE chat_id = ? AND status = 'active'
    `).run(status, chatId);

    return result.changes > 0;
}
