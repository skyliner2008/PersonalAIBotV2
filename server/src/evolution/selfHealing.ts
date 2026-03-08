// ============================================================
// Self-Healing System — ตรวจจับปัญหาและซ่อมแซมอัตโนมัติ
// ============================================================

import { getAgentRunHistory, getAgentStats } from '../bot_agents/agent.js';
import { logEvolution, addLearning } from './learningJournal.js';
import { configManager } from '../bot_agents/config/configManager.js';
import { TaskType } from '../bot_agents/config/aiConfig.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SelfHealing');

export interface Issue {
    type: 'high_error_rate' | 'tool_failing' | 'slow_model' | 'memory_leak';
    severity: 'low' | 'medium' | 'high';
    description: string;
    suggestedFix: string;
}

/**
 * Scan recent history for issues
 */
export function detectIssues(): Issue[] {
    const issues: Issue[] = [];
    const runs = getAgentRunHistory().slice(0, 30);
    if (runs.length < 5) return issues;

    // 1. High error rate
    const errorRuns = runs.filter(r => r.error);
    const errorRate = errorRuns.length / runs.length;
    if (errorRate > 0.3) {
        issues.push({
            type: 'high_error_rate',
            severity: errorRate > 0.5 ? 'high' : 'medium',
            description: `Error rate: ${(errorRate * 100).toFixed(0)}% (${errorRuns.length}/${runs.length})`,
            suggestedFix: 'Switch to more stable model or check API key',
        });
    }

    // 2. Tool repeatedly failing
    const toolFails: Record<string, { total: number; fails: number }> = {};
    for (const run of runs) {
        for (const tc of run.toolCalls) {
            if (!toolFails[tc.name]) toolFails[tc.name] = { total: 0, fails: 0 };
            toolFails[tc.name].total++;
            if (!tc.success) toolFails[tc.name].fails++;
        }
    }
    for (const [name, stats] of Object.entries(toolFails)) {
        if (stats.total >= 3 && stats.fails / stats.total > 0.5) {
            issues.push({
                type: 'tool_failing',
                severity: 'medium',
                description: `Tool "${name}" failing ${stats.fails}/${stats.total} times`,
                suggestedFix: `Investigate tool "${name}" — may have dependency issues`,
            });
        }
    }

    // 3. Slow model for specific task type
    const taskPerf: Record<string, number[]> = {};
    for (const run of runs.filter(r => r.durationMs)) {
        const tt = run.taskType || 'unknown';
        if (!taskPerf[tt]) taskPerf[tt] = [];
        taskPerf[tt].push(run.durationMs!);
    }
    for (const [tt, durations] of Object.entries(taskPerf)) {
        const avg = durations.reduce((s, d) => s + d, 0) / durations.length;
        if (avg > 20000 && durations.length >= 3) {
            issues.push({
                type: 'slow_model',
                severity: 'medium',
                description: `Task "${tt}" avg duration: ${Math.round(avg)}ms (${durations.length} runs)`,
                suggestedFix: `Switch to faster model for "${tt}" tasks`,
            });
        }
    }

    // 4. Memory leak detection
    const mem = process.memoryUsage();
    const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
    if (heapMB > 500) {
        issues.push({
            type: 'memory_leak',
            severity: heapMB > 800 ? 'high' : 'medium',
            description: `Heap usage: ${heapMB}MB`,
            suggestedFix: 'Trigger garbage collection or restart',
        });
    }

    return issues;
}

/**
 * Attempt to fix detected issues automatically
 */
export function attemptFixes(issues: Issue[]): { fixed: number; skipped: number } {
    let fixed = 0;
    let skipped = 0;

    for (const issue of issues) {
        try {
            switch (issue.type) {
                case 'slow_model': {
                    // Auto-switch slow task type to a faster model
                    const match = issue.description.match(/Task "(\w+)"/);
                    const taskType = match?.[1] as TaskType;
                    if (taskType && Object.values(TaskType).includes(taskType)) {
                        const currentConfig = configManager.getConfig();
                        const current = currentConfig[taskType];
                        // Only switch if currently using a heavy model
                        if (current?.modelName?.includes('2.5')) {
                            const newConfig = { ...currentConfig };
                            newConfig[taskType] = { provider: 'gemini', modelName: 'gemini-2.0-flash' };
                            configManager.updateConfig(newConfig);
                            logEvolution('self_heal', `Auto-switched "${taskType}" model from ${current.modelName} → gemini-2.0-flash due to slow performance`, { issue });
                            addLearning('performance', `Switched ${taskType} to faster model due to avg ${issue.description}`, 'self_healing', 0.7);
                            fixed++;
                            continue;
                        }
                    }
                    skipped++;
                    break;
                }

                case 'memory_leak': {
                    // Force garbage collection if available
                    if (global.gc) {
                        global.gc();
                        logEvolution('self_heal', 'Triggered garbage collection due to high memory usage', { issue });
                        fixed++;
                    } else {
                        skipped++;
                    }
                    break;
                }

                case 'high_error_rate':
                case 'tool_failing': {
                    // Log for manual review — don't auto-fix these
                    addLearning('error_solutions', issue.description + ' → ' + issue.suggestedFix, 'self_healing', 0.5);
                    logEvolution('self_heal', `Detected: ${issue.description}`, { issue, action: 'logged_for_review' });
                    skipped++;
                    break;
                }

                default:
                    skipped++;
            }
        } catch (err: any) {
            log.error('Fix attempt failed', { issue: issue.type, error: err.message });
            skipped++;
        }
    }

    if (fixed > 0) {
        log.info(`Self-healing completed: ${fixed} fixed, ${skipped} skipped`);
    }

    return { fixed, skipped };
}

/**
 * Run full health check: detect + attempt fixes
 */
export function runHealthCheck(): { issues: Issue[]; fixed: number; skipped: number } {
    const issues = detectIssues();
    if (issues.length === 0) return { issues, fixed: 0, skipped: 0 };

    log.warn(`Health check found ${issues.length} issues`, { types: issues.map(i => i.type) });
    const result = attemptFixes(issues);
    return { issues, ...result };
}
