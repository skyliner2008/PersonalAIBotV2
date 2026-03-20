/**
 * Semantic Tool Discovery Engine
 *
 * Matches task descriptions to available tools using:
 * - Keyword extraction from task descriptions
 * - TF-IDF-like scoring against tool metadata
 * - Tool usage history and success tracking
 * - Semantic similarity for tool chaining
 */

import { createLogger } from '../utils/logger.js';
import { getAllTools, type ToolMeta } from '../bot_agents/registries/toolRegistry.js';
import { getDb } from '../database/db.js';

const log = createLogger('ToolDiscovery');

export interface ToolRecommendation {
  tool: ToolMeta;
  relevanceScore: number;
  reasoning: string;
}

export interface ToolChainStep {
  order: number;
  toolName: string;
  tool: ToolMeta;
  purpose: string;
}

export interface ToolUsageRecord {
  toolName: string;
  success: boolean;
  taskType: string;
  timestamp: string;
  context?: string;
}

/**
 * Tool Discovery Engine - Semantic matching and recommendations
 */
export class ToolDiscoveryEngine {
  private toolUsageHistory: Map<string, ToolUsageRecord[]> = new Map();
  private toolSuccessCache: Map<string, { successes: number; failures: number }> = new Map();

  constructor() {
    this.ensureTables();
    this.loadUsageHistory();
  }

  /**
   * Create tool usage tracking table if it doesn't exist
   */
  private ensureTables(): void {
    try {
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS tool_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tool_name TEXT NOT NULL,
          success INTEGER NOT NULL,
          task_type TEXT NOT NULL,
          context TEXT,
          timestamp TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON tool_usage(tool_name);
        CREATE INDEX IF NOT EXISTS idx_tool_usage_task ON tool_usage(task_type);
      `);
      log.info('Tool usage tables ready');
    } catch (err: any) {
      log.error('Failed to create tool usage tables', { error: err.message });
    }
  }

  /**
   * Load tool usage history from database
   */
  private loadUsageHistory(): void {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT tool_name, success, task_type, context, timestamp
        FROM tool_usage
        WHERE timestamp > datetime('now', '-30 days')
        ORDER BY timestamp DESC
      `).all() as any[];

      for (const row of rows) {
        const toolName = row.tool_name;
        if (!this.toolUsageHistory.has(toolName)) {
          this.toolUsageHistory.set(toolName, []);
        }
        this.toolUsageHistory.get(toolName)!.push({
          toolName,
          success: !!row.success,
          taskType: row.task_type,
          timestamp: row.timestamp,
          context: row.context,
        });
      }
      log.debug('Loaded tool usage history', { toolCount: this.toolUsageHistory.size });
    } catch (err: any) {
      log.warn('Failed to load tool usage history', { error: err.message });
    }
  }

  /**
   * Extract keywords from task description
   */
  private extractKeywords(text: string): Set<string> {
    const keywords = new Set<string>();
    const normalized = text.toLowerCase();

    // Simple tokenization
    const tokens = normalized
      .replace(/[^a-z0-9\s_-]/g, '')
      .split(/\s+/)
      .filter(t => t.length > 2);

    tokens.forEach(t => keywords.add(t));

    return keywords;
  }

  /**
   * Calculate TF-IDF-like score between keywords and tool
   */
  private calculateRelevance(keywords: Set<string>, tool: ToolMeta): number {
    let score = 0;
    const keywordArray = Array.from(keywords);

    // Name match (highest weight)
    const toolNameLower = tool.name.toLowerCase();
    const displayNameLower = tool.displayName.toLowerCase();
    for (const keyword of keywordArray) {
      if (toolNameLower.includes(keyword)) score += 3;
      if (displayNameLower.includes(keyword)) score += 2;
    }

    // Description match
    const descLower = tool.description.toLowerCase();
    for (const keyword of keywordArray) {
      if (descLower.includes(keyword)) score += 1;
    }

    // Tag match
    for (const tag of tool.tags) {
      if (keywords.has(tag.toLowerCase())) score += 1.5;
    }

    return score;
  }

  /**
   * Find tools matching a task description, ranked by relevance
   */
  findToolsForTask(taskDescription: string): ToolRecommendation[] {
    const keywords = this.extractKeywords(taskDescription);
    const allTools = getAllTools();

    const recommendations: ToolRecommendation[] = allTools
      .map(tool => {
        const baseScore = this.calculateRelevance(keywords, tool);
        const successRate = this.getToolSuccessRate(tool.name);
        // Boost score based on historical success
        const boostedScore = baseScore * (0.5 + successRate);

        return {
          tool,
          relevanceScore: boostedScore,
          reasoning: this.generateReasoning(tool, keywords),
        };
      })
      .filter(r => r.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore);

    log.debug('Tools found for task', {
      taskDescription: taskDescription.substring(0, 50),
      count: recommendations.length,
    });

    return recommendations;
  }

  /**
   * Generate human-readable reasoning for recommendation
   */
  private generateReasoning(tool: ToolMeta, keywords: Set<string>): string {
    const matchedKeywords = Array.from(keywords).filter(
      k => tool.name.toLowerCase().includes(k) ||
           tool.displayName.toLowerCase().includes(k) ||
           tool.tags.some(t => t.toLowerCase().includes(k))
    );

    if (matchedKeywords.length > 0) {
      return `Matches keywords: ${matchedKeywords.join(', ')}`;
    }

    const successRate = this.getToolSuccessRate(tool.name);
    if (successRate > 0.8) {
      return `High success rate (${(successRate * 100).toFixed(0)}%) for similar tasks`;
    }

    return `Tagged as ${tool.tags.join(', ')}`;
  }

  /**
   * Get tool success rate from usage history
   */
  private getToolSuccessRate(toolName: string): number {
    if (this.toolSuccessCache.has(toolName)) {
      const stats = this.toolSuccessCache.get(toolName)!;
      if (stats.successes + stats.failures === 0) return 0.5;
      return stats.successes / (stats.successes + stats.failures);
    }

    const records = this.toolUsageHistory.get(toolName) || [];
    const successes = records.filter(r => r.success).length;
    const failures = records.filter(r => !r.success).length;

    const successRate = successes + failures > 0 ? successes / (successes + failures) : 0.5;
    this.toolSuccessCache.set(toolName, { successes, failures });
    return successRate;
  }

  /**
   * Suggest ordered tool chain for multi-step objective
   */
  suggestToolChain(objective: string): ToolChainStep[] {
    const keywords = this.extractKeywords(objective);
    const recommendations = this.findToolsForTask(objective);

    // Build a logical chain based on common patterns
    const chain: ToolChainStep[] = [];
    const used = new Set<string>();

    // Pattern: research -> analyze -> execute -> verify
    const phases = ['research', 'analyze', 'execute', 'verify'];
    let order = 1;

    for (const phase of phases) {
      const phaseKeywords = new Set([...keywords, phase]);
      const best = recommendations
        .filter(r => !used.has(r.tool.name))
        .find(r => this.calculateRelevance(phaseKeywords, r.tool) > 0);

      if (best) {
        chain.push({
          order: order++,
          toolName: best.tool.name,
          tool: best.tool,
          purpose: `${phase}: ${best.tool.description}`,
        });
        used.add(best.tool.name);
      }
    }

    // If no chain formed, add top recommendations
    if (chain.length === 0) {
      recommendations.slice(0, 3).forEach((rec, i) => {
        chain.push({
          order: i + 1,
          toolName: rec.tool.name,
          tool: rec.tool,
          purpose: rec.reasoning,
        });
      });
    }

    log.debug('Tool chain suggested', { objective: objective.substring(0, 50), chainLength: chain.length });
    return chain;
  }

  /**
   * Get capability map (capability keyword -> tools)
   */
  getToolCapabilityMap(): Map<string, ToolMeta[]> {
    const capabilityMap = new Map<string, ToolMeta[]>();
    const allTools = getAllTools();

    for (const tool of allTools) {
      for (const tag of tool.tags) {
        if (!capabilityMap.has(tag)) {
          capabilityMap.set(tag, []);
        }
        capabilityMap.get(tag)!.push(tool);
      }

      // Also add category as a capability
      if (!capabilityMap.has(tool.category)) {
        capabilityMap.set(tool.category, []);
      }
      capabilityMap.get(tool.category)!.push(tool);
    }

    return capabilityMap;
  }

  /**
   * Report tool usage for learning
   */
  reportToolUsage(toolName: string, success: boolean, context: string = ''): void {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO tool_usage (tool_name, success, task_type, context)
        VALUES (?, ?, ?, ?)
      `).run(toolName, success ? 1 : 0, context || 'general', context);

      // Invalidate cache
      this.toolSuccessCache.delete(toolName);

      log.debug('Tool usage reported', { toolName, success });
    } catch (err: any) {
      log.warn('Failed to report tool usage', { toolName, error: err.message });
    }
  }

  /**
   * Get top tools for a task type based on historical success
   */
  getToolRecommendations(taskType: string): ToolRecommendation[] {
    const allTools = getAllTools();

    const recommendations: ToolRecommendation[] = allTools
      .map(tool => {
        // Check if this tool was used for this task type
        const history = this.toolUsageHistory.get(tool.name) || [];
        const relevantHistory = history.filter(r => r.taskType === taskType);

        if (relevantHistory.length === 0) {
          // No history for this task type; use generic match
          const keywords = this.extractKeywords(taskType);
          return {
            tool,
            relevanceScore: this.calculateRelevance(keywords, tool),
            reasoning: `Available for ${taskType}`,
          };
        }

        const successRate = relevantHistory.filter(r => r.success).length / relevantHistory.length;
        return {
          tool,
          relevanceScore: successRate * relevantHistory.length, // Score by success * volume
          reasoning: `${(successRate * 100).toFixed(0)}% success rate (${relevantHistory.length} uses)`,
        };
      })
      .filter(r => r.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 5);

    return recommendations;
  }
}

// Singleton instance
let instance: ToolDiscoveryEngine | null = null;

export function getToolDiscoveryEngine(): ToolDiscoveryEngine {
  if (!instance) {
    instance = new ToolDiscoveryEngine();
  }
  return instance;
}
