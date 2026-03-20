import { randomUUID } from 'crypto';
import { getBot } from '../bot_agents/registries/botRegistry.js';
import type { Agent } from '../bot_agents/agent.js';
import type { BotContext } from '../bot_agents/types.js';
import { getSpecialistByName } from './specialists.js';
import { createLogger } from '../utils/logger.js';

/**
 * Project Workspace - Manages a 24/7 background session where
 * Multiple AI Agents (Manager, Coder, Tester, Reviewer) collaborate
 * continuously until the project goal is achieved.
 */

export interface WorkspaceState {
  id: string;
  goal: string;
  chatId: string; // The chat where the workspace was triggered
  status: 'planning' | 'executing' | 'reviewing' | 'completed' | 'failed' | 'paused';
  currentTurn: number;
  maxTurns: number;
  history: Array<{
    role: 'manager' | 'coder' | 'tester' | 'reviewer' | 'system';
    content: string;
    timestamp: number;
  }>;
  result?: string;
}

const activeWorkspaces = new Map<string, ProjectWorkspace>();

export class ProjectWorkspace {
  public state: WorkspaceState;
  private agentInstance: Agent;
  private isRunning: boolean = false;
  
  constructor(goal: string, chatId: string, agentInstance: Agent, maxTurns: number = 50) {
    this.state = {
      id: randomUUID(),
      goal,
      chatId,
      status: 'planning',
      currentTurn: 0,
      maxTurns,
      history: [],
    };
    this.agentInstance = agentInstance;
  }

  public async start(): Promise<string> {
    if (this.isRunning) return this.state.id;
    this.isRunning = true;
    
    this.logHistory('system', `Workspace started. Goal: ${this.state.goal}\nMax Turns: ${this.state.maxTurns}`);
    activeWorkspaces.set(this.state.id, this);

    // Kick off the background loop without waiting
    this.runLoop().catch(err => {
      console.error(`[Workspace ${this.state.id}] Background loop error:`, err);
      this.state.status = 'failed';
    });

    return this.state.id;
  }

  private async runLoop(): Promise<void> {
    // Determine the next step based on status
    while (this.isRunning && this.state.status !== 'completed' && this.state.status !== 'failed' && this.state.status !== 'paused') {
      if (this.state.currentTurn >= this.state.maxTurns) {
        this.logHistory('system', `Workspace reached max turns (${this.state.maxTurns}). Pausing for user intervention.`);
        this.state.status = 'paused';
        break;
      }

      this.state.currentTurn++;
      console.log(`[Workspace ${this.state.id}] Turn ${this.state.currentTurn}/${this.state.maxTurns} - Status: ${this.state.status}`);

      try {
        if (this.state.status === 'planning') {
          await this.doPlanningTurn();
        } else if (this.state.status === 'executing') {
          await this.doExecutionTurn();
        } else if (this.state.status === 'reviewing') {
          await this.doReviewTurn();
        }
      } catch (err: any) {
        console.error(`[Workspace ${this.state.id}] Error in loop:`, err);
        this.logHistory('system', `Error: ${err.message}`);
        this.state.status = 'failed';
        this.isRunning = false;
      }
      
      // Delay to avoid spamming the LLM API / 429 errors
      await new Promise(r => setTimeout(r, 15000));
    }

    this.isRunning = false;
    console.log(`[Workspace ${this.state.id}] Loop ended. Final status: ${this.state.status}`);
  }

  private async doPlanningTurn(): Promise<void> {
    const prompt = `
[ROLE: MANAGER]
Goal: ${this.state.goal}

You are the AI Project Manager. Create a quick, high-level JSON action plan for the team (Coder, Tester).
IMPORTANT: Before generating your plan, you MUST use a <think> block to reflect on the codebase status.
If the required tasks are straightforward, reply with NEXT_STATE: executing.
`;
    const response = await this.askSpecialist('manager', prompt);
    this.logHistory('manager', response);

    if (response.includes('NEXT_STATE: executing') || response.includes('executing')) {
      this.state.status = 'executing';
    }
  }

  private async doExecutionTurn(): Promise<void> {
    // Coder writes the code and Tester validates it
    // First, let the coder process the current state
    const historySummary = this.getRecentHistory(5);
    const coderPrompt = `
[ROLE: CODER]
Goal: ${this.state.goal}

Recent context:
${historySummary}

You are the Coder. Execute the next step in the plan.
[CRITICAL RULE]: Before using any file editing tools, you MUST wrap your thoughts in a <think> block to plan your precise line edits.
[CRITICAL RULE]: You MUST use the \`replace_code_block\` tool to surgically edit files based on your plan. Do NOT rewrite entire files.
When you finish your part, explicitly state: DONE_CODING.
`;
    const coderResponse = await this.askSpecialist('coder', coderPrompt);
    this.logHistory('coder', coderResponse);

    if (coderResponse.includes('DONE_CODING') || coderResponse.toLowerCase().includes('เสร็จ')) {
      // Transition to Tester
      const testerPrompt = `
[ROLE: TESTER]
Goal: ${this.state.goal}

Recent context:
${this.getRecentHistory(3)}

You are the Tester. Check if the code works by running commands or scripts. 
If it fails, state what needs fixing. If it passes, reply with: NEXT_STATE: reviewing.
`;
      const testerResponse = await this.askSpecialist('tester', testerPrompt);
      this.logHistory('tester', testerResponse);

      if (testerResponse.includes('NEXT_STATE: reviewing') || testerResponse.includes('reviewing')) {
        this.state.status = 'reviewing';
      }
    }
  }

  private async doReviewTurn(): Promise<void> {
    const historySummary = this.getRecentHistory(5);
    const reviewPrompt = `
[ROLE: REVIEWER]
Goal: ${this.state.goal}

Recent context:
${historySummary}

You are the strict Reviewer. Scrutinize the work done. 
Before making a decision, you MUST use a <think> block to thoroughly trace edge cases and code logic.
If the implementation fulfills the goal completely and has no errors, reply with: PROJECT_COMPLETE.
If it needs more work, explain why and reply with: NEXT_STATE: executing.
`;
    const reviewerResponse = await this.askSpecialist('reviewer', reviewPrompt);
    this.logHistory('reviewer', reviewerResponse);

    if (reviewerResponse.includes('PROJECT_COMPLETE')) {
      this.state.status = 'completed';
      this.state.result = 'Project successfully completed by the Swarm.';
    } else if (reviewerResponse.includes('NEXT_STATE: executing') || reviewerResponse.includes('executing')) {
      this.state.status = 'executing';
    }
  }

  private async askSpecialist(role: 'manager' | 'coder' | 'tester' | 'reviewer', instruction: string): Promise<string> {
    const specContext: BotContext = {
      botId: `workspace_${this.state.id}_${role}`,
      botName: `Workspace ${role.toUpperCase()}`,
      platform: 'custom',
      replyWithFile: async () => 'File transfer unsupported in background workspace',
    };

    // Determine taskType based on role for routing
    let pseudoType: any = 'general';
    if (role === 'coder' || role === 'reviewer') pseudoType = 'code_generation';
    if (role === 'manager') pseudoType = 'thinking';

    // Call Agent
    const reply = await this.agentInstance.processMessage(
      `workspace_${this.state.id}`, 
      instruction, 
      specContext
    );

    return reply;
  }

  private logHistory(role: 'manager' | 'coder' | 'tester' | 'reviewer' | 'system', content: string) {
    this.state.history.push({
      role,
      content,
      timestamp: Date.now()
    });
  }

  private getRecentHistory(n: number): string {
    return this.state.history.slice(-n).map(h => `[${h.role.toUpperCase()}]: ${h.content}`).join('\n\n');
  }

  public getSummary(): string {
    return `Workspace ${this.state.id} | Status: ${this.state.status} | Turns: ${this.state.currentTurn}/${this.state.maxTurns}`;
  }
}

export function startNewWorkspace(goal: string, chatId: string, agentInstance: Agent, maxTurns?: number): Promise<string> {
  const ws = new ProjectWorkspace(goal, chatId, agentInstance, maxTurns);
  return ws.start();
}

export function getWorkspace(id: string): ProjectWorkspace | undefined {
  return activeWorkspaces.get(id);
}

export function getAllWorkspaces(): ProjectWorkspace[] {
  return Array.from(activeWorkspaces.values());
}
