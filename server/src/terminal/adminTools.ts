/**
 * Root Admin Agent Tools — Unrestricted system management tools
 *
 * These tools are ONLY available to the Jarvis Root Admin Agent.
 * They provide full project access: read/write files, run commands,
 * manage bots, create tools, delegate to swarm, and view system status.
 *
 * All actions are audit-logged to the activity_logs table.
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { addLog, dbAll } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import {
  MASKED_SECRET_VALUE,
  getManagedSetting,
  isSecretSettingKey,
  setManagedSetting,
} from '../config/settingsSecurity.js';
import { getRootAdminIdentity } from '../system/rootAdmin.js';

const execAsync = promisify(exec);
const log = createLogger('AdminTools');
const PROJECT_ROOT = path.resolve(process.cwd());

// ── Audit Logger ──
function auditLog(action: string, detail: string): void {
  addLog('admin-agent', action, detail.substring(0, 500), 'info');
  log.info(`[AUDIT] ${action}: ${detail.substring(0, 200)}`);
}

// ══════════════════════════════════════════════════════════════
// Tool Declarations
// ══════════════════════════════════════════════════════════════

export const adminReadProjectFileDecl: FunctionDeclaration = {
  name: 'admin_read_project_file',
  description: 'อ่านไฟล์ใดก็ได้ในโปรเจค สำหรับ Root Admin Agent เท่านั้น',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: { type: Type.STRING, description: 'พาธของไฟล์ (สัมพัทธ์จาก project root)' },
    },
    required: ['path'],
  },
};

export const adminWriteProjectFileDecl: FunctionDeclaration = {
  name: 'admin_write_project_file',
  description: 'เขียนหรือสร้างไฟล์ใดก็ได้ในโปรเจค สร้าง directory อัตโนมัติ',
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: { type: Type.STRING, description: 'พาธของไฟล์ (สัมพัทธ์จาก project root)' },
      content: { type: Type.STRING, description: 'เนื้อหาที่ต้องการเขียน' },
    },
    required: ['path', 'content'],
  },
};

export const adminListProjectFilesDecl: FunctionDeclaration = {
  name: 'admin_list_project_files',
  description: 'แสดงรายการไฟล์ในโปรเจค รองรับ directory path และ pattern filter',
  parameters: {
    type: Type.OBJECT,
    properties: {
      dir: { type: Type.STRING, description: 'Directory path (สัมพัทธ์จาก project root)' },
      pattern: { type: Type.STRING, description: 'Glob pattern สำหรับ filter (เช่น *.ts)' },
    },
    required: ['dir'],
  },
};

export const adminRunCommandDecl: FunctionDeclaration = {
  name: 'admin_run_command',
  description: 'รัน shell command ได้ไม่จำกัด (สำหรับ Root Admin Agent เท่านั้น) ใช้ในการจัดการระบบ',
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: { type: Type.STRING, description: 'Shell command ที่ต้องการรัน' },
      cwd: { type: Type.STRING, description: 'Working directory (optional)' },
      timeout: { type: Type.NUMBER, description: 'Timeout ในหน่วย ms (default: 30000)' },
    },
    required: ['command'],
  },
};

export const adminCreateBotAgentDecl: FunctionDeclaration = {
  name: 'admin_create_bot_agent',
  description: 'สร้างและลงทะเบียน bot agent ใหม่',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: 'ชื่อ bot' },
      platform: { type: Type.STRING, description: 'แพลตฟอร์ม: telegram, line, facebook, custom' },
      config: { type: Type.STRING, description: 'JSON config string' },
    },
    required: ['name', 'platform'],
  },
};

export const adminStopBotAgentDecl: FunctionDeclaration = {
  name: 'admin_stop_bot_agent',
  description: 'หยุด bot agent ที่กำลังทำงาน',
  parameters: {
    type: Type.OBJECT,
    properties: {
      botId: { type: Type.STRING, description: 'Bot ID ที่ต้องการหยุด' },
    },
    required: ['botId'],
  },
};

export const adminListAllAgentsDecl: FunctionDeclaration = {
  name: 'admin_list_all_agents',
  description: 'แสดงรายการ agent ทั้งหมดในระบบ พร้อมสถานะ',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const adminCreateDynamicToolDecl: FunctionDeclaration = {
  name: 'admin_create_dynamic_tool',
  description: 'สร้าง dynamic tool ใหม่ให้ agent ใช้งานได้',
  parameters: {
    type: Type.OBJECT,
    properties: {
      name: { type: Type.STRING, description: 'ชื่อ tool (snake_case)' },
      description: { type: Type.STRING, description: 'คำอธิบาย tool' },
      code: { type: Type.STRING, description: 'JavaScript code ที่จะรันเมื่อเรียกใช้ tool' },
      parameters: { type: Type.STRING, description: 'JSON schema ของ parameters' },
    },
    required: ['name', 'description', 'code'],
  },
};

export const adminGetSystemOverviewDecl: FunctionDeclaration = {
  name: 'admin_get_system_overview',
  description: 'ดูสถานะรวมของระบบทั้งหมด: providers, bots, queues, memory, uptime',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const adminDelegateToSwarmDecl: FunctionDeclaration = {
  name: 'admin_delegate_to_swarm',
  description: 'มอบหมายงานให้ swarm coordinator จัดการ',
  parameters: {
    type: Type.OBJECT,
    properties: {
      taskType: { type: Type.STRING, description: 'ประเภทงาน: code_review, code_generation, translation, web_search, data_analysis, summarization, general' },
      message: { type: Type.STRING, description: 'คำอธิบายงาน' },
      specialist: { type: Type.STRING, description: 'เจาะจง specialist agent (optional)' },
      priority: { type: Type.NUMBER, description: 'ลำดับความสำคัญ 1-5 (default: 3)' },
    },
    required: ['taskType', 'message'],
  },
};

export const adminViewLogsDecl: FunctionDeclaration = {
  name: 'admin_view_logs',
  description: 'ดูบันทึก activity logs ของระบบ',
  parameters: {
    type: Type.OBJECT,
    properties: {
      filter: { type: Type.STRING, description: 'กรองตามหมวดหมู่ (เช่น server, agent, admin-agent)' },
      limit: { type: Type.NUMBER, description: 'จำนวน log ที่ต้องการ (default: 20)' },
    },
  },
};

export const adminDiagnoseCliDecl: FunctionDeclaration = {
  name: 'admin_diagnose_cli',
  description: 'ตรวจสอบสถานะ การติดตั้ง และปัญหาของ CLI (เช่น gemini, claude, aider) รวมติงทดสอบรัน command พื้นฐาน',
  parameters: {
    type: Type.OBJECT,
    properties: {
      cliId: { type: Type.STRING, description: 'ชื่อ CLI ที่ต้องการตรวจ เช่น gemini-cli, aider-cli, หรือพิมพ์ all เพื่อดูทั้งหมด' },
    },
    required: ['cliId'],
  },
};

export const adminEditCliProfileDecl: FunctionDeclaration = {
  name: 'admin_edit_cli_profile',
  description: 'แก้ไขการตั้งค่า Template ของ CLI ใน Meeting Room (เช่น เปลี่ยน argument จาก --message เป็น run)',
  parameters: {
    type: Type.OBJECT,
    properties: {
      cliId: { type: Type.STRING, description: 'ชื่อ CLI เช่น kilo-cli, qwen-cli, claude-cli' },
      argsTemplate: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Array ของ Arguments เช่น ["run", "{prompt_content}"]' },
      usesStdin: { type: Type.BOOLEAN, description: 'true ถ้ารับค่าผ่าน stdin, false ถ้ารับผ่าน argument/file' },
    },
    required: ['cliId', 'argsTemplate', 'usesStdin'],
  },
};

export const adminGetRuntimeSettingDecl: FunctionDeclaration = {
  name: 'admin_get_runtime_setting',
  description: 'อ่านค่า runtime setting จากฐานข้อมูล (รองรับทั้ง key ปกติและ key ลับ)',
  parameters: {
    type: Type.OBJECT,
    properties: {
      key: { type: Type.STRING, description: 'ชื่อ setting key' },
    },
    required: ['key'],
  },
};

export const adminSetRuntimeSettingDecl: FunctionDeclaration = {
  name: 'admin_set_runtime_setting',
  description: 'อัปเดตค่า runtime setting ในฐานข้อมูล (รองรับทั้ง key ปกติและ key ลับ)',
  parameters: {
    type: Type.OBJECT,
    properties: {
      key: { type: Type.STRING, description: 'ชื่อ setting key' },
      value: { type: Type.STRING, description: 'ค่าที่ต้องการตั้ง' },
    },
    required: ['key', 'value'],
  },
};

export const adminListRuntimeSettingsDecl: FunctionDeclaration = {
  name: 'admin_list_runtime_settings',
  description: 'แสดงรายการ runtime settings ที่มีอยู่ในฐานข้อมูล (mask ค่าลับอัตโนมัติ)',
  parameters: {
    type: Type.OBJECT,
    properties: {
      pattern: { type: Type.STRING, description: 'กรอง key ด้วยข้อความบางส่วน (optional)' },
      limit: { type: Type.NUMBER, description: 'จำนวนสูงสุดที่ต้องการแสดง (default: 100, max: 500)' },
    },
  },
};

export const adminGetRootAdminConfigDecl: FunctionDeclaration = {
  name: 'admin_get_root_admin_config',
  description: 'อ่านค่า root admin identity ที่ระบบใช้งานอยู่จริง',
  parameters: {
    type: Type.OBJECT,
    properties: {},
  },
};

export const adminSetRootAdminConfigDecl: FunctionDeclaration = {
  name: 'admin_set_root_admin_config',
  description: 'ตั้งค่า root admin identity (botId, botName, supervisorBotIds, personaPlatform) แบบ runtime',
  parameters: {
    type: Type.OBJECT,
    properties: {
      botId: { type: Type.STRING, description: 'botId ของ root admin' },
      botName: { type: Type.STRING, description: 'ชื่อแสดงผลของ root admin' },
      supervisorBotIds: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'รายการ botId ที่ถือเป็น root/supervisor' },
      personaPlatform: { type: Type.STRING, description: 'persona platform สำหรับ root admin (เช่น system)' },
      specialistName: { type: Type.STRING, description: 'ชื่อ specialist หลักของ root admin ในระบบ swarm (เช่น jarvis-root-admin)' },
    },
  },
};

// ══════════════════════════════════════════════════════════════
// Tool Handlers
// ══════════════════════════════════════════════════════════════

async function adminReadProjectFile(args: { path: string }): Promise<string> {
  const filePath = path.resolve(PROJECT_ROOT, args.path);
  auditLog('read_file', filePath);

  if (!fs.existsSync(filePath)) {
    return `Error: File not found: ${args.path}`;
  }

  const stat = fs.statSync(filePath);
  if (stat.size > 1024 * 1024) {
    return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max 1MB.`;
  }

  return fs.readFileSync(filePath, 'utf-8');
}

async function adminWriteProjectFile(args: { path: string; content: string }): Promise<string> {
  const filePath = path.resolve(PROJECT_ROOT, args.path);
  auditLog('write_file', `${filePath} (${args.content.length} bytes)`);

  // Create parent directories
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Backup existing file
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + `.bak.${Date.now()}`;
    fs.copyFileSync(filePath, backupPath);
  }

  fs.writeFileSync(filePath, args.content, 'utf-8');
  return `File written: ${args.path} (${args.content.length} bytes)`;
}

async function adminListProjectFiles(args: { dir: string; pattern?: string }): Promise<string> {
  const dirPath = path.resolve(PROJECT_ROOT, args.dir);
  auditLog('list_files', dirPath);

  if (!fs.existsSync(dirPath)) {
    return `Error: Directory not found: ${args.dir}`;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  let items = entries.map(e => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : 'file',
    size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : 0,
  }));

  // Filter by pattern if provided
  if (args.pattern) {
    const regex = new RegExp(args.pattern.replace(/\*/g, '.*').replace(/\?/g, '.'), 'i');
    items = items.filter(i => regex.test(i.name));
  }

  return items.map(i =>
    `${i.type === 'dir' ? '📁' : '📄'} ${i.name}${i.size ? ` (${(i.size / 1024).toFixed(1)}KB)` : ''}`
  ).join('\n') || '(empty directory)';
}

async function adminRunCommand(args: { command: string; cwd?: string; timeout?: number }): Promise<string> {
  const timeout = Math.min(args.timeout ?? 30000, 120000);
  const cwd = args.cwd ? path.resolve(PROJECT_ROOT, args.cwd) : PROJECT_ROOT;
  auditLog('run_command', `[${cwd}] ${args.command}`);

  try {
    const { stdout, stderr } = await execAsync(args.command, {
      cwd,
      timeout,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    return (stdout + (stderr ? `\n[stderr]: ${stderr}` : '')).substring(0, 50000);
  } catch (err: any) {
    return `Command failed: ${err.message || err}`.substring(0, 10000);
  }
}

async function adminCreateBotAgent(args: { name: string; platform: string; config?: string }): Promise<string> {
  auditLog('create_bot', `${args.name} on ${args.platform}`);
  try {
    const { createBot } = await import('../bot_agents/registries/botRegistry.js');
    const cfg = args.config ? JSON.parse(args.config) : {};
    const id = args.name.toLowerCase().replace(/\s+/g, '-');
    createBot({ id, name: args.name, platform: args.platform as any, credentials: cfg });
    return `Bot "${args.name}" registered on platform "${args.platform}" (id: ${id})`;
  } catch (err: any) {
    return `Error creating bot: ${err.message}`;
  }
}

async function adminStopBotAgent(args: { botId: string }): Promise<string> {
  auditLog('stop_bot', args.botId);
  try {
    const { stopBotInstance } = await import('../bot_agents/botManager.js');
    stopBotInstance(args.botId);
    return `Bot "${args.botId}" stopped`;
  } catch (err: any) {
    return `Error stopping bot: ${err.message}`;
  }
}

async function adminListAllAgents(): Promise<string> {
  auditLog('list_agents', 'all');
  try {
    const { listBots } = await import('../bot_agents/registries/botRegistry.js');
    const bots = listBots();
    if (bots.length === 0) return 'No registered agents';
    return bots.map((b: any) =>
      `• ${b.name} | ${b.platform} | ${b.status || 'unknown'} | Tools: ${b.toolCount || '?'}`
    ).join('\n');
  } catch (err: any) {
    return `Error listing agents: ${err.message}`;
  }
}

async function adminCreateDynamicTool(args: { name: string; description: string; code: string; parameters?: string }): Promise<string> {
  auditLog('create_tool', args.name);
  try {
    // Write tool definition to dynamic_tools directory
    const toolDir = path.join(PROJECT_ROOT, 'data', 'dynamic_tools');
    if (!fs.existsSync(toolDir)) fs.mkdirSync(toolDir, { recursive: true });
    const toolDef = {
      name: args.name,
      description: args.description,
      code: args.code,
      parameters: args.parameters ? JSON.parse(args.parameters) : {},
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(toolDir, `${args.name}.json`), JSON.stringify(toolDef, null, 2));
    // Trigger reload
    const { refreshDynamicTools } = await import('../bot_agents/tools/dynamicTools.js');
    await refreshDynamicTools();
    return `Dynamic tool "${args.name}" created and loaded`;
  } catch (err: any) {
    return `Error creating tool: ${err.message}`;
  }
}

async function adminGetSystemOverview(): Promise<string> {
  auditLog('system_overview', 'requested');
  const mem = process.memoryUsage();
  const sections: string[] = [];

  sections.push(`== System Overview ==`);
  sections.push(`Uptime: ${Math.floor(process.uptime() / 60)}m`);
  sections.push(`Memory: Heap ${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB / RSS ${(mem.rss / 1024 / 1024).toFixed(1)}MB`);
  sections.push(`Node: ${process.version}`);
  sections.push(`PID: ${process.pid}`);

  // Provider status
  try {
    const { getEnabledProviders } = await import('../providers/registry.js');
    const llm = getEnabledProviders('llm');
    sections.push(`\n== AI Providers ==`);
    for (const p of llm) {
      sections.push(`• ${p.id}: ${p.name} (${(p as any).status || p.type})`);
    }
  } catch { sections.push('\nProviders: unavailable'); }

  // Bot status
  try {
    const { listBots } = await import('../bot_agents/registries/botRegistry.js');
    const bots = listBots();
    sections.push(`\n== Bots (${bots.length}) ==`);
    for (const b of bots.slice(0, 10)) {
      sections.push(`• ${(b as any).name}: ${(b as any).platform} (${(b as any).status || '?'})`);
    }
  } catch { sections.push('\nBots: unavailable'); }

  // Swarm
  try {
    const { getSwarmCoordinator } = await import('../swarm/swarmCoordinator.js');
    const sc = getSwarmCoordinator();
    const q = sc.getTaskQueue();
    if (q) {
      const stats = q.getStats();
      sections.push(`\n== Swarm Queue ==`);
      sections.push(`Queued: ${stats.queued} | Processing: ${stats.processing} | Completed: ${stats.completed} | Failed: ${stats.failed}`);
    }
  } catch { sections.push('\nSwarm: unavailable'); }

  return sections.join('\n');
}

async function adminDelegateToSwarm(args: { taskType: string; message: string; specialist?: string; priority?: number }): Promise<string> {
  auditLog('delegate_swarm', `${args.taskType}: ${args.message.substring(0, 100)}`);
  try {
    const { getSwarmCoordinator } = await import('../swarm/swarmCoordinator.js');
    const sc = getSwarmCoordinator();
    const rootAdmin = getRootAdminIdentity();
    const adminCtx = {
      botId: rootAdmin.botId,
      botName: rootAdmin.botName,
      platform: 'custom' as const,
      replyWithFile: async () => 'not supported from admin',
    };
    const taskId = await sc.delegateTask(adminCtx, args.taskType as any, { message: args.message }, {
      toSpecialist: args.specialist,
      priority: args.priority ?? 3,
    });
    return `Swarm task created: ${taskId} (${args.taskType})`;
  } catch (err: any) {
    return `Swarm delegation error: ${err.message}`;
  }
}

async function adminViewLogs(args: { filter?: string; limit?: number }): Promise<string> {
  const limit = Math.min(args.limit ?? 20, 100);
  auditLog('view_logs', `filter=${args.filter || 'all'} limit=${limit}`);

  try {
    let query = 'SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT ?';
    const params: any[] = [limit];

    if (args.filter) {
      query = 'SELECT * FROM activity_logs WHERE category = ? ORDER BY created_at DESC LIMIT ?';
      params.unshift(args.filter);
    }

    const rows = dbAll(query, params);
    if (!rows || rows.length === 0) return 'No logs found';

    return rows.map((r: any) =>
      `[${r.created_at}] ${r.category} | ${r.action} | ${(r.detail || '').substring(0, 80)}`
    ).join('\n');
  } catch (err: any) {
    return `Error reading logs: ${err.message}`;
  }
}

async function adminDiagnoseCli(args: { cliId: string }): Promise<string> {
  const { cliId } = args;
  auditLog('diagnose_cli', cliId);
  try {
    const { getAvailableBackends, getCLIConfig } = await import('../terminal/commandRouter.js');
    const backends = getAvailableBackends().filter(b => b.kind === 'cli');
    
    let targets = backends;
    if (cliId.toLowerCase() !== 'all') {
      targets = backends.filter(b => b.id === cliId || b.id === `${cliId}-cli` || b.name.toLowerCase().includes(cliId.toLowerCase()));
    }

    if (targets.length === 0) {
      return `❌ ไม่พบ CLI ที่ชื่อตรงกับ "${cliId}" ในระบบ known CLIs ของ commandRouter`;
    }

    const report: string[] = [`# 🛠️ โหมดตรวจสอบ CLI Diagnostics (${targets.length} tools)`];

    for (const target of targets) {
      report.push(`\n## ${target.name} (ID: ${target.id})`);
      report.push(`**Status in Registry**: ${target.available ? '✅ Available' : '❌ Not Available'}`);
      
      const config = getCLIConfig(target.id as `${string}-cli`);
      if (!config) {
        report.push(`**Config**: ⚠️ ไม่มี Config (หา executable ไม่พบใน PATH หรือ ENV ไม่ถูกต้อง)`);
        continue;
      }
      report.push(`**Command Config**: \`${config.command} ${config.args.join(' ')}\``);

      // Test Execution
      try {
        // Try --version first, fallback to --help
        let testCmd = `${config.command} --version`;
        if (target.id === 'codex-cli' || target.id === 'kilo-cli') testCmd = `${config.command} --help`;
        
        report.push(`**Testing Execution**: \`${testCmd}\``);
        const { stdout, stderr } = await execAsync(testCmd, { timeout: 5000, maxBuffer: 1024 * 1024, env: process.env });
        
        const output = (stdout || stderr || '').trim().split('\n')[0].substring(0, 100);
        report.push(`**Result**: ✅ สำเร็จ (Output: \`${output}...\`)`);
      } catch (err: any) {
        report.push(`**Result**: ❌ ล้มเหลว`);
        report.push(`> ${err.message?.split('\n')[0] || String(err)}`);
        
        // Suggestion
        report.push(`**คำแนะนำในการแก้ปัญหา**:`);
        if (target.id.includes('gemini')) report.push(`ลองใช้ tool \`admin_run_command\` เพื่อรัน: \`npm install -g @google/genai-cli\``);
        if (target.id.includes('claude')) report.push(`ลองใช้ tool \`admin_run_command\` เพื่อรัน: \`npm install -g @anthropic-ai/claude-code\``);
        if (target.id.includes('aider')) report.push(`ตรวจดูว่าติดตั้ง Python และ Aider แล้วผ่าน \`pip install aider-chat\``);
      }
    }

    report.push(`\n---\n*หมายเหตุ: Jarvis สามารถใช้ admin_run_command เพื่อติดตั้ง CLI หรือ admin_write_project_file เพื่อแก้ Code ใน commandRouter/roundtable ได้ หากพบปัญหาเชิงลึก*`);
    return report.join('\n');
  } catch (err: any) {
    return `Error diagnosing CLI: ${err.message}`;
  }
}

async function adminEditCliProfile(args: { cliId: string; argsTemplate: string[]; usesStdin: boolean }): Promise<string> {
  const { cliId, argsTemplate, usesStdin } = args;
  auditLog('edit_cli_profile', `${cliId} | stdin=${usesStdin}`);
  try {
    const { loadCliProfiles, saveCliProfiles } = await import('../swarm/cliProfileManager.js');
    const profiles = loadCliProfiles();
    
    // Preserve extraEnv if modifying existing
    const existingEnv = profiles[cliId]?.extraEnv;
    
    profiles[cliId] = { argsTemplate, usesStdin, extraEnv: existingEnv };
    saveCliProfiles(profiles);

    return `✅ อัปเดต CLI Profile ของ '${cliId}' เรียบร้อยแล้ว\nArguments: ${JSON.stringify(argsTemplate)}\nUses Stdin: ${usesStdin}`;
  } catch (err: any) {
    return `Error updating CLI Profile: ${err.message}`;
  }
}

async function adminGetRuntimeSetting(args: { key: string }): Promise<string> {
  const key = String(args.key || '').trim();
  if (!key) return 'Error: key is required';
  auditLog('get_runtime_setting', key);

  const value = getManagedSetting(key);
  if (!value) return `Setting "${key}" is not set`;
  if (isSecretSettingKey(key)) {
    return `${key} = ${MASKED_SECRET_VALUE} (stored securely)`;
  }
  return `${key} = ${value}`;
}

async function adminSetRuntimeSetting(args: { key: string; value: string }): Promise<string> {
  const key = String(args.key || '').trim();
  if (!key) return 'Error: key is required';
  const value = String(args.value ?? '');
  auditLog('set_runtime_setting', `${key} (${value.length} chars)`);

  setManagedSetting(key, value);
  if (isSecretSettingKey(key)) {
    return `Updated "${key}" = ${MASKED_SECRET_VALUE} (stored securely)`;
  }
  return `Updated "${key}" = ${value}`;
}

async function adminListRuntimeSettings(args: { pattern?: string; limit?: number }): Promise<string> {
  const pattern = String(args.pattern || '').trim();
  const limit = Math.min(Math.max(Number(args.limit || 100), 1), 500);
  auditLog('list_runtime_settings', `pattern=${pattern || '*'} limit=${limit}`);

  let sql = 'SELECT key, value FROM settings ORDER BY key ASC LIMIT ?';
  const params: any[] = [limit];
  if (pattern) {
    sql = 'SELECT key, value FROM settings WHERE key LIKE ? ORDER BY key ASC LIMIT ?';
    params.unshift(`%${pattern}%`);
  }
  const rows = dbAll(sql, params) as Array<{ key: string; value: string }>;
  if (!rows.length) return 'No settings found';

  return rows
    .map((row) => {
      if (isSecretSettingKey(row.key) && row.value) {
        return `${row.key} = ${MASKED_SECRET_VALUE}`;
      }
      return `${row.key} = ${row.value}`;
    })
    .join('\n');
}

async function adminGetRootAdminConfig(): Promise<string> {
  auditLog('get_root_admin_config', 'current');
  const identity = getRootAdminIdentity();
  return [
    `botId = ${identity.botId}`,
    `botName = ${identity.botName}`,
    `personaPlatform = ${identity.personaPlatform}`,
    `specialistName = ${identity.specialistName}`,
    `supervisorBotIds = ${identity.supervisorBotIds.join(', ')}`,
  ].join('\n');
}

async function adminSetRootAdminConfig(args: {
  botId?: string;
  botName?: string;
  supervisorBotIds?: string[];
  personaPlatform?: string;
  specialistName?: string;
}): Promise<string> {
  const updatedKeys: string[] = [];

  if (typeof args.botId === 'string' && args.botId.trim()) {
    setManagedSetting('jarvis_root_bot_id', args.botId.trim().toLowerCase());
    updatedKeys.push('jarvis_root_bot_id');
  }
  if (typeof args.botName === 'string' && args.botName.trim()) {
    setManagedSetting('jarvis_root_bot_name', args.botName.trim());
    updatedKeys.push('jarvis_root_bot_name');
  }
  if (Array.isArray(args.supervisorBotIds) && args.supervisorBotIds.length > 0) {
    const normalized = Array.from(
      new Set(
        args.supervisorBotIds
          .map((item) => String(item || '').trim().toLowerCase())
          .filter(Boolean),
      ),
    );
    if (normalized.length > 0) {
      setManagedSetting('jarvis_supervisor_bot_ids', normalized.join(','));
      updatedKeys.push('jarvis_supervisor_bot_ids');
    }
  }
  if (typeof args.personaPlatform === 'string' && args.personaPlatform.trim()) {
    setManagedSetting('jarvis_root_persona_platform', args.personaPlatform.trim());
    updatedKeys.push('jarvis_root_persona_platform');
  }
  if (typeof args.specialistName === 'string' && args.specialistName.trim()) {
    setManagedSetting('jarvis_root_specialist_name', args.specialistName.trim().toLowerCase());
    updatedKeys.push('jarvis_root_specialist_name');
  }

  if (updatedKeys.length === 0) {
    return 'No root admin config updated (provide at least one field)';
  }

  auditLog('set_root_admin_config', updatedKeys.join(', '));
  const identity = getRootAdminIdentity();
  return [
    `Updated keys: ${updatedKeys.join(', ')}`,
    `botId = ${identity.botId}`,
    `botName = ${identity.botName}`,
    `personaPlatform = ${identity.personaPlatform}`,
    `specialistName = ${identity.specialistName}`,
    `supervisorBotIds = ${identity.supervisorBotIds.join(', ')}`,
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════
// Exports — Declarations + Handlers
// ══════════════════════════════════════════════════════════════

export const adminToolDeclarations: FunctionDeclaration[] = [
  adminReadProjectFileDecl,
  adminWriteProjectFileDecl,
  adminListProjectFilesDecl,
  adminRunCommandDecl,
  adminCreateBotAgentDecl,
  adminStopBotAgentDecl,
  adminListAllAgentsDecl,
  adminCreateDynamicToolDecl,
  adminGetSystemOverviewDecl,
  adminDelegateToSwarmDecl,
  adminViewLogsDecl,
  adminDiagnoseCliDecl,
  adminEditCliProfileDecl,
  adminGetRuntimeSettingDecl,
  adminSetRuntimeSettingDecl,
  adminListRuntimeSettingsDecl,
  adminGetRootAdminConfigDecl,
  adminSetRootAdminConfigDecl,
];

export function getAdminToolHandlers(): Record<string, (args: any) => Promise<string>> {
  return {
    admin_read_project_file: adminReadProjectFile,
    admin_write_project_file: adminWriteProjectFile,
    admin_list_project_files: adminListProjectFiles,
    admin_run_command: adminRunCommand,
    admin_create_bot_agent: adminCreateBotAgent,
    admin_stop_bot_agent: adminStopBotAgent,
    admin_list_all_agents: adminListAllAgents,
    admin_create_dynamic_tool: adminCreateDynamicTool,
    admin_get_system_overview: adminGetSystemOverview,
    admin_delegate_to_swarm: adminDelegateToSwarm,
    admin_view_logs: adminViewLogs,
    admin_diagnose_cli: adminDiagnoseCli,
    admin_edit_cli_profile: adminEditCliProfile,
    admin_get_runtime_setting: adminGetRuntimeSetting,
    admin_set_runtime_setting: adminSetRuntimeSetting,
    admin_list_runtime_settings: adminListRuntimeSettings,
    admin_get_root_admin_config: adminGetRootAdminConfig,
    admin_set_root_admin_config: adminSetRootAdminConfig,
  };
}
