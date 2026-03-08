// ============================================================
// Self-Reflection Engine — AI วิเคราะห์ตัวเองอัตโนมัติ
// ============================================================
// ทำงานทุก N ข้อความ: วิเคราะห์ error patterns, performance,
// tool usage แล้วสร้าง insights + auto-actions

import { getAgentRunHistory, getAgentStats, type AgentRun } from '../bot_agents/agent.js';
import { addLearning, logEvolution, type LearningCategory } from './learningJournal.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SelfReflection');

// Trigger reflection every N completed runs
const REFLECTION_INTERVAL = 50;
let lastReflectionAt = 0;

export interface ReflectionReport {
    findings: string[];
    suggestions: string[];
    autoActions: AutoAction[];
    timestamp: number;
}

export interface AutoAction {
    type: 'add_learning' | 'log_warning' | 'tune_config';
    description: string;
    applied: boolean;
}

/**
 * Check if reflection should be triggered
 */
export function shouldReflect(): boolean {
    const stats = getAgentStats();
    return stats.totalRuns > 0 && (stats.totalRuns - lastReflectionAt) >= REFLECTION_INTERVAL;
}

/**
 * Run self-reflection analysis on recent agent history
 * This is designed to run asynchronously (non-blocking)
 */
export async function triggerReflection(
    llmCall?: (prompt: string) => Promise<string>
): Promise<ReflectionReport | null> {
    const stats = getAgentStats();
    const runs = getAgentRunHistory().slice(0, 50); // last 50 runs

    if (runs.length < 5) return null;
    lastReflectionAt = stats.totalRuns;

    const report: ReflectionReport = {
        findings: [],
        suggestions: [],
        autoActions: [],
        timestamp: Date.now(),
    };

    try {
        // ── 1. Error Pattern Analysis ──
        analyzeErrors(runs, report);

        // ── 2. Performance Analysis ──
        analyzePerformance(runs, report);

        // ── 3. Tool Usage Analysis ──
        analyzeToolUsage(runs, report);

        // ── 4. LLM-Powered Deep Analysis (optional) ──
        if (llmCall && runs.length >= 10) {
            await deepAnalysis(runs, report, llmCall);
        }

        // ── 5. Execute Auto-Actions ──
        executeAutoActions(report);

        // Log the reflection
        logEvolution('reflection', `Self-reflection completed: ${report.findings.length} findings, ${report.autoActions.length} actions`, {
            findings: report.findings,
            suggestions: report.suggestions,
            autoActionsCount: report.autoActions.length,
        });

        log.info('Reflection completed', {
            findings: report.findings.length,
            suggestions: report.suggestions.length,
            autoActions: report.autoActions.length,
        });

        return report;
    } catch (err: any) {
        log.error('Reflection failed', { error: err.message });
        return null;
    }
}

// ── Analysis Functions ──

function analyzeErrors(runs: AgentRun[], report: ReflectionReport): void {
    const errorRuns = runs.filter(r => r.error);
    const errorRate = runs.length > 0 ? errorRuns.length / runs.length : 0;

    if (errorRate > 0.2) {
        report.findings.push(`⚠️ Error rate สูง: ${(errorRate * 100).toFixed(0)}% (${errorRuns.length}/${runs.length} runs)`);

        // Group errors by pattern
        const errorPatterns: Record<string, number> = {};
        for (const run of errorRuns) {
            const pattern = run.error?.substring(0, 50) ?? 'unknown';
            errorPatterns[pattern] = (errorPatterns[pattern] || 0) + 1;
        }

        for (const [pattern, count] of Object.entries(errorPatterns)) {
            if (count >= 3) {
                report.findings.push(`🔴 Error ซ้ำ ${count} ครั้ง: "${pattern}"`);
                report.autoActions.push({
                    type: 'add_learning',
                    description: `Recurring error: ${pattern} (${count}x)`,
                    applied: false,
                });
            }
        }
    }

    if (errorRate === 0 && runs.length >= 20) {
        report.findings.push('✅ ไม่พบ errors ใน 20 runs ล่าสุด — ระบบเสถียร');
    }
}

function analyzePerformance(runs: AgentRun[], report: ReflectionReport): void {
    const completedRuns = runs.filter(r => r.durationMs);
    if (completedRuns.length === 0) return;

    const avgDuration = completedRuns.reduce((s, r) => s + (r.durationMs || 0), 0) / completedRuns.length;
    const avgTokens = completedRuns.reduce((s, r) => s + r.totalTokens, 0) / completedRuns.length;

    // Slow runs
    const slowRuns = completedRuns.filter(r => (r.durationMs || 0) > 15000);
    if (slowRuns.length > completedRuns.length * 0.3) {
        report.findings.push(`🐌 ${slowRuns.length} runs ใช้เวลา > 15s (avg: ${Math.round(avgDuration)}ms)`);
        report.suggestions.push('ลองเปลี่ยนไปใช้ model ที่เร็วกว่าสำหรับ task ที่ช้า');
    }

    // Token waste
    if (avgTokens > 3000) {
        report.findings.push(`💸 Token usage สูง: avg ${Math.round(avgTokens)} tokens/run`);
        report.suggestions.push('ปรับปรุง prompt ให้กระชับขึ้น หรือลด max_tokens');
    }

    // Task type performance breakdown
    const byTaskType: Record<string, { count: number; avgMs: number; avgTokens: number }> = {};
    for (const run of completedRuns) {
        const tt = run.taskType || 'unknown';
        if (!byTaskType[tt]) byTaskType[tt] = { count: 0, avgMs: 0, avgTokens: 0 };
        byTaskType[tt].count++;
        byTaskType[tt].avgMs += run.durationMs || 0;
        byTaskType[tt].avgTokens += run.totalTokens;
    }
    for (const tt of Object.keys(byTaskType)) {
        byTaskType[tt].avgMs = Math.round(byTaskType[tt].avgMs / byTaskType[tt].count);
        byTaskType[tt].avgTokens = Math.round(byTaskType[tt].avgTokens / byTaskType[tt].count);
    }

    // Find the slowest task type
    const slowest = Object.entries(byTaskType).sort((a, b) => b[1].avgMs - a[1].avgMs)[0];
    if (slowest && slowest[1].avgMs > 10000) {
        report.findings.push(`📊 Task "${slowest[0]}" ช้าที่สุด: avg ${slowest[1].avgMs}ms`);
        report.autoActions.push({
            type: 'add_learning',
            description: `Task "${slowest[0]}" is consistently slow (${slowest[1].avgMs}ms avg). Consider using a faster model.`,
            applied: false,
        });
    }
}

function analyzeToolUsage(runs: AgentRun[], report: ReflectionReport): void {
    const toolStats: Record<string, { calls: number; failures: number }> = {};

    for (const run of runs) {
        for (const tc of run.toolCalls) {
            if (!toolStats[tc.name]) toolStats[tc.name] = { calls: 0, failures: 0 };
            toolStats[tc.name].calls++;
            if (!tc.success) toolStats[tc.name].failures++;
        }
    }

    for (const [tool, stats] of Object.entries(toolStats)) {
        const failRate = stats.calls > 0 ? stats.failures / stats.calls : 0;
        if (failRate > 0.4 && stats.calls >= 3) {
            report.findings.push(`🔧 Tool "${tool}" fail rate สูง: ${(failRate * 100).toFixed(0)}% (${stats.failures}/${stats.calls})`);
            report.suggestions.push(`ตรวจสอบ tool "${tool}" — อาจมี bug หรือ config ผิด`);
            report.autoActions.push({
                type: 'add_learning',
                description: `Tool "${tool}" has high failure rate (${(failRate * 100).toFixed(0)}%). May need investigation.`,
                applied: false,
            });
        }
    }

    // Unused tools (if no calls at all)
    const totalTools = Object.keys(toolStats).length;
    if (totalTools > 0) {
        report.findings.push(`📦 ใช้ ${totalTools} tools จากทั้งหมดใน ${runs.length} runs`);
    }
}

async function deepAnalysis(
    runs: AgentRun[],
    report: ReflectionReport,
    llmCall: (prompt: string) => Promise<string>
): Promise<void> {
    try {
        const summary = runs.slice(0, 20).map(r => ({
            task: r.taskType,
            duration: r.durationMs,
            tokens: r.totalTokens,
            tools: r.toolCalls.length,
            error: r.error ? r.error.substring(0, 50) : null,
        }));

        const prompt = `คุณเป็น AI ที่วิเคราะห์ประสิทธิภาพตัวเอง จากข้อมูล 20 runs ล่าสุด:
${JSON.stringify(summary, null, 1)}

วิเคราะห์และให้ข้อเสนอแนะ 2-3 ข้อ สำหรับปรับปรุง (ภาษาไทย, กระชับ):`;

        const analysis = await llmCall(prompt);
        if (analysis && analysis.length > 10) {
            report.findings.push(`🧠 AI Deep Analysis:\n${analysis}`);
            report.autoActions.push({
                type: 'add_learning',
                description: analysis.substring(0, 200),
                applied: false,
            });
        }
    } catch (err: any) {
        log.error('Deep analysis failed', { error: err.message });
    }
}

function executeAutoActions(report: ReflectionReport): void {
    for (const action of report.autoActions) {
        try {
            if (action.type === 'add_learning') {
                addLearning('performance', action.description, 'self_reflection', 0.6);
                action.applied = true;
            } else if (action.type === 'log_warning') {
                log.warn(action.description);
                action.applied = true;
            }
        } catch {
            action.applied = false;
        }
    }
}
