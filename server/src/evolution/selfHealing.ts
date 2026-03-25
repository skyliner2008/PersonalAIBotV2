// ============================================================
// Self-Healing System — ตรวจจับปัญหาและซ่อมแซมอัตโนมัติ
// ============================================================

import { getAgentRunHistory, getAgentStats, type AgentRun } from '../bot_agents/agentTelemetry.js';
import { logEvolution, addLearning } from './learningJournal.js';
import { configManager } from '../bot_agents/config/configManager.js';
import { TaskType } from '../bot_agents/config/aiConfig.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SelfHealing');

// Cooldown tracking to prevent fix-attempt loops
const _fixCooldowns = new Map<string, number>(); // issue key → timestamp of last fix attempt
const FIX_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes between fix attempts for same issue

function isOnCooldown(issueKey: string): boolean {
    const lastAttempt = _fixCooldowns.get(issueKey);
    if (!lastAttempt) return false;
    return Date.now() - lastAttempt < FIX_COOLDOWN_MS;
}

function markFixAttempted(issueKey: string): void {
    _fixCooldowns.set(issueKey, Date.now());
    // Clean old entries
    for (const [key, ts] of _fixCooldowns) {
        if (Date.now() - ts > FIX_COOLDOWN_MS * 3) _fixCooldowns.delete(key);
    }
}

/**
 * Categorize an error string into an actionable root cause
 */
function categorizeError(errorMsg: string): string {
    const msg = errorMsg.toLowerCase();
    if (/429|rate.limit|quota|resource.exhausted/i.test(msg)) return 'api_quota';
    if (/timeout|timed.out|econnreset|socket.hang/i.test(msg)) return 'timeout';
    if (/401|403|unauthorized|forbidden|invalid.*key/i.test(msg)) return 'auth';
    if (/500|502|503|504|internal.server/i.test(msg)) return 'server_error';
    if (/enotfound|dns|network|econnrefused/i.test(msg)) return 'network';
    if (/out.of.memory|heap|allocation/i.test(msg)) return 'memory';
    if (/json|parse|syntax/i.test(msg)) return 'parse_error';
    return 'unknown';
}

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

    // 1. High error rate (adaptive threshold based on recent trend)
    const errorRuns = runs.filter((r: AgentRun) => r.error);
    const errorRate = errorRuns.length / runs.length;
    const recentErrors = runs.slice(0, 10).filter((r: AgentRun) => r.error);
    const olderErrors = runs.slice(10).filter((r: AgentRun) => r.error);
    const recentErrorRate = runs.length >= 10 ? recentErrors.length / 10 : errorRate;
    const olderErrorRate = olderErrors.length > 0 ? olderErrors.length / Math.max(runs.length - 10, 1) : 0;

    // Adaptive: alert if recent rate is significantly worse than older rate
    const isRegressing = recentErrorRate > olderErrorRate * 1.5 + 0.1;

    if (errorRate > 0.3 || isRegressing) {
        // Root cause analysis: group errors by type
        const errorTypes: Record<string, number> = {};
        for (const r of errorRuns) {
            const errType = categorizeError(r.error || '');
            errorTypes[errType] = (errorTypes[errType] || 0) + 1;
        }
        const topError = Object.entries(errorTypes).sort((a, b) => b[1] - a[1])[0];

        issues.push({
            type: 'high_error_rate',
            severity: errorRate > 0.5 ? 'high' : 'medium',
            description: `Error rate: ${(errorRate * 100).toFixed(0)}% (${errorRuns.length}/${runs.length})${isRegressing ? ' [REGRESSING]' : ''}. Top cause: ${topError?.[0] || 'unknown'} (${topError?.[1] || 0}x)`,
            suggestedFix: topError?.[0] === 'api_quota' ? 'Switch to cheaper model or add rate limiting'
                : topError?.[0] === 'timeout' ? 'Reduce model complexity or increase timeout'
                : topError?.[0] === 'auth' ? 'Check API key validity'
                : 'Switch to more stable model or check API key',
        });
    }

    // 2. Tool repeatedly failing
    const toolFails: Record<string, { total: number; fails: number }> = {};
    for (const run of runs) {
        if (!run.toolCalls) {
            continue;
        }
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
    for (const run of runs.filter(r => r.durationMs !== undefined)) {
        const tt = run.taskType || 'unknown';
        if (!taskPerf[tt]) taskPerf[tt] = [];
        taskPerf[tt].push(run.durationMs!);
    }
    for (const [tt, durations] of Object.entries(taskPerf)) {
        if (durations.length === 0) {
            continue; // Skip calculation if no durations to avoid NaN
        }
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

    // 5. Stale model detection: if a specific model is failing more than others
    const modelFails: Record<string, { total: number; fails: number }> = {};
    for (const run of runs) {
        const model = (run as any).model || 'unknown';
        if (!modelFails[model]) modelFails[model] = { total: 0, fails: 0 };
        modelFails[model].total++;
        if (run.error) modelFails[model].fails++;
    }
    for (const [model, stats] of Object.entries(modelFails)) {
        if (stats.total >= 5 && stats.fails / stats.total > 0.6) {
            issues.push({
                type: 'high_error_rate',
                severity: 'high',
                description: `Model "${model}" failing ${stats.fails}/${stats.total} times (${Math.round(stats.fails/stats.total*100)}%)`,
                suggestedFix: `Consider switching from "${model}" to a more reliable alternative`,
            });
        }
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
        const issueKey = `${issue.type}:${issue.description.substring(0, 50)}`;
        if (isOnCooldown(issueKey)) {
            log.debug(`Skipping fix for ${issue.type} — still on cooldown`);
            skipped++;
            continue;
        }

        try {
            switch (issue.type) {
                case 'slow_model': {
                    // Auto-switch slow task type to a faster model based on actual performance data
                    const match = issue.description.match(/Task "(\w+)"/);
                    const taskType = match?.[1] as TaskType;
                    if (taskType && taskType in TaskType) {
                        const currentConfig = configManager.getConfig();
                        const current = currentConfig.routes[taskType];
                        const active = current?.active;
                        if (active?.modelName) {
                            // Check if there's a faster alternative available
                            const fasterAlternatives: Record<string, string> = {
                                'gemini-2.5-flash': 'gemini-2.0-flash',

                                'gemini-2.0-flash': 'gemini-2.0-flash-lite',
                                'gpt-4o': 'gpt-4o-mini',
                                'gpt-4.1': 'gpt-4.1-mini',
                                'claude-3-5-sonnet-20241022': 'claude-3-5-haiku-20241022',
                            };
                            const fasterModel = fasterAlternatives[active.modelName];
                            if (fasterModel) {
                                const newRoutes = { ...currentConfig.routes };
                                newRoutes[taskType] = { 
                                    active: { provider: active.provider, modelName: fasterModel },
                                    fallbacks: current.fallbacks
                                };
                                configManager.updateConfig({ autoRouting: currentConfig.autoRouting, routes: newRoutes });
                                logEvolution('self_heal', `Auto-switched "${taskType}" model from ${active.modelName} → ${fasterModel} due to slow performance`, { issue });
                                addLearning('performance', `Switched ${taskType} to faster model due to avg ${issue.description}`, 'self_healing', 0.7);
                                markFixAttempted(issueKey);
                                fixed++;
                                continue;
                            }
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
                        markFixAttempted(issueKey);
                        fixed++;
                    } else {
                        skipped++;
                    }
                    break;
                }

                case 'high_error_rate':
                case 'tool_failing': {
                    // Log for manual review — don't auto-fix these
                    addLearning('error_solutions', `${issue.description} → ${issue.suggestedFix}`, 'self_healing', 0.5);
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
