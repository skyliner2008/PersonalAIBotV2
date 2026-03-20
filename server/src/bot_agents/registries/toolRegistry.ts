// ============================================================
// Tool Registry — centralized metadata for all available tools
// ============================================================

import type { FunctionDeclaration } from '@google/genai';

export type ToolCategory = 'utility' | 'os' | 'file' | 'browser' | 'web' | 'memory' | 'communication' | 'system';
export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ToolPlatform = 'telegram' | 'line' | 'facebook' | 'all';

export interface ToolMeta {
  /** Unique tool name (matches FunctionDeclaration.name) */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Short description */
  description: string;
  /** Category for grouping in UI */
  category: ToolCategory;
  /** Risk level — high-risk tools need explicit enablement */
  riskLevel: ToolRiskLevel;
  /** Platforms this tool supports */
  platforms: ToolPlatform[];
  /** Tags for search / filtering */
  tags: string[];
  /** Whether this tool is enabled by default for new bots */
  enabledByDefault: boolean;
  /** Reference to the FunctionDeclaration (set at registration time) */
  declaration?: FunctionDeclaration;
}

// The central registry map
const registry = new Map<string, ToolMeta>();

// ── Default tool metadata ────────────────────────────

const defaultTools: Omit<ToolMeta, 'declaration'>[] = [
  // Utility
  { name: 'get_current_time', displayName: 'Get Current Time', description: 'บอกเวลาปัจจุบัน', category: 'utility', riskLevel: 'low', platforms: ['all'], tags: ['time', 'utility'], enabledByDefault: true },
  { name: 'echo_message', displayName: 'Echo Message', description: 'พิมพ์ข้อความลง Console', category: 'utility', riskLevel: 'low', platforms: ['all'], tags: ['debug', 'utility'], enabledByDefault: true },

  // OS Control
  { name: 'run_command', displayName: 'Run Command', description: 'รันคำสั่ง CMD/Shell', category: 'os', riskLevel: 'high', platforms: ['all'], tags: ['os', 'command', 'shell'], enabledByDefault: false },
  { name: 'run_python', displayName: 'Run Python', description: 'รันโค้ด Python', category: 'os', riskLevel: 'high', platforms: ['all'], tags: ['os', 'python', 'code'], enabledByDefault: false },
  { name: 'open_application', displayName: 'Open Application', description: 'เปิดโปรแกรมบนเครื่อง', category: 'os', riskLevel: 'high', platforms: ['all'], tags: ['os', 'app'], enabledByDefault: false },
  { name: 'close_application', displayName: 'Close Application', description: 'ปิดโปรแกรมบนเครื่อง', category: 'os', riskLevel: 'high', platforms: ['all'], tags: ['os', 'app'], enabledByDefault: false },
  { name: 'system_info', displayName: 'System Info', description: 'ข้อมูลระบบ CPU/RAM/Disk', category: 'os', riskLevel: 'low', platforms: ['all'], tags: ['os', 'info'], enabledByDefault: true },
  { name: 'screenshot_desktop', displayName: 'Screenshot Desktop', description: 'จับภาพหน้าจอ', category: 'os', riskLevel: 'medium', platforms: ['all'], tags: ['os', 'screenshot'], enabledByDefault: false },
  { name: 'clipboard_read', displayName: 'Clipboard Read', description: 'อ่านคลิปบอร์ด', category: 'os', riskLevel: 'medium', platforms: ['all'], tags: ['os', 'clipboard'], enabledByDefault: false },
  { name: 'clipboard_write', displayName: 'Clipboard Write', description: 'เขียนคลิปบอร์ด', category: 'os', riskLevel: 'medium', platforms: ['all'], tags: ['os', 'clipboard'], enabledByDefault: false },

  // File Operations
  { name: 'list_files', displayName: 'List Files', description: 'แสดงรายการไฟล์', category: 'file', riskLevel: 'low', platforms: ['all'], tags: ['file', 'list'], enabledByDefault: true },
  { name: 'read_file_content', displayName: 'Read File', description: 'อ่านเนื้อหาไฟล์', category: 'file', riskLevel: 'low', platforms: ['all'], tags: ['file', 'read'], enabledByDefault: true },
  { name: 'write_file_content', displayName: 'Write File', description: 'เขียนเนื้อหาไฟล์', category: 'file', riskLevel: 'medium', platforms: ['all'], tags: ['file', 'write'], enabledByDefault: false },
  { name: 'delete_file', displayName: 'Delete File', description: 'ลบไฟล์', category: 'file', riskLevel: 'high', platforms: ['all'], tags: ['file', 'delete'], enabledByDefault: false },
  { name: 'send_file_to_chat', displayName: 'Send File to Chat', description: 'ส่งไฟล์ให้ผู้ใช้ในแชท', category: 'communication', riskLevel: 'low', platforms: ['telegram', 'line'], tags: ['file', 'send', 'chat'], enabledByDefault: true },

  // Browser
  { name: 'browser_navigate', displayName: 'Browser Navigate', description: 'เปิดเว็บเพจ', category: 'browser', riskLevel: 'medium', platforms: ['all'], tags: ['browser', 'navigate'], enabledByDefault: false },
  { name: 'browser_click', displayName: 'Browser Click', description: 'คลิกปุ่มในเว็บ', category: 'browser', riskLevel: 'medium', platforms: ['all'], tags: ['browser', 'click'], enabledByDefault: false },
  { name: 'browser_type', displayName: 'Browser Type', description: 'พิมพ์ข้อความในเว็บ', category: 'browser', riskLevel: 'medium', platforms: ['all'], tags: ['browser', 'type'], enabledByDefault: false },
  { name: 'browser_close', displayName: 'Browser Close', description: 'ปิดเบราว์เซอร์', category: 'browser', riskLevel: 'low', platforms: ['all'], tags: ['browser', 'close'], enabledByDefault: false },

  // Web & Search
  { name: 'web_search', displayName: 'Web Search', description: 'ค้นหาข้อมูลจาก Google', category: 'web', riskLevel: 'low', platforms: ['all'], tags: ['web', 'search', 'google'], enabledByDefault: true },
  { name: 'read_webpage', displayName: 'Read Webpage', description: 'อ่านเนื้อหาเว็บเพจ', category: 'web', riskLevel: 'low', platforms: ['all'], tags: ['web', 'read'], enabledByDefault: true },
  { name: 'mouse_click', displayName: 'Mouse Click', description: 'คลิกเมาส์ที่ตำแหน่ง XY', category: 'web', riskLevel: 'medium', platforms: ['all'], tags: ['web', 'mouse'], enabledByDefault: false },
  { name: 'keyboard_type', displayName: 'Keyboard Type', description: 'พิมพ์คีย์บอร์ดในเว็บ', category: 'web', riskLevel: 'medium', platforms: ['all'], tags: ['web', 'keyboard'], enabledByDefault: false },

  // Memory
  { name: 'memory_search', displayName: 'Memory Search', description: 'ค้นหาความทรงจำระยะยาว', category: 'memory', riskLevel: 'low', platforms: ['all'], tags: ['memory', 'search', 'archival'], enabledByDefault: true },
  { name: 'memory_save', displayName: 'Memory Save', description: 'บันทึกความทรงจำระยะยาว', category: 'memory', riskLevel: 'low', platforms: ['all'], tags: ['memory', 'save', 'archival'], enabledByDefault: true },

  // System — Self-Awareness (ความสามารถพื้นฐานทุก Agent มีตั้งแต่สร้าง)
  { name: 'get_my_config', displayName: 'Get My Config', description: 'ดูข้อมูล config ของตัวเอง (model, platform, tools)', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'self-aware', 'config'], enabledByDefault: true },
  { name: 'list_available_models', displayName: 'List Available Models', description: 'แสดงรายการ AI model ทั้งหมดที่ใช้ได้ในระบบ', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'model', 'list'], enabledByDefault: true },
  { name: 'set_my_model', displayName: 'Set My Model', description: 'เปลี่ยน AI model สำหรับ task type ที่กำหนด', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'model', 'config'], enabledByDefault: true },
  { name: 'get_system_status', displayName: 'Get System Status', description: 'ดูสถานะระบบ (uptime, providers, memory stats)', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'status', 'health'], enabledByDefault: true },
  { name: 'get_my_capabilities', displayName: 'Get My Capabilities', description: 'แสดงรายการ tools และความสามารถที่เปิดใช้อยู่', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'tools', 'capabilities'], enabledByDefault: true },
  { name: 'help', displayName: 'Help', description: 'แสดงคู่มือการใช้งานและความสามารถทั้งหมด', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'help', 'guide'], enabledByDefault: true },
  { name: 'get_recent_errors', displayName: 'Get Recent Errors', description: 'ดูข้อผิดพลาดล่าสุดของระบบ', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'error', 'debug'], enabledByDefault: true },
  { name: 'get_session_stats', displayName: 'Get Session Stats', description: 'ดูสถิติการทำงาน (tokens, messages, duration)', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'stats', 'telemetry'], enabledByDefault: true },

  // Self-Evolution Tools (Registered into System Category)
  { name: 'self_read_source', displayName: 'Self Read Source', description: 'อ่าน source code ของตัวเอง', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['evolution', 'read', 'source'], enabledByDefault: true },
  { name: 'self_edit_persona', displayName: 'Self Edit Persona', description: 'แก้ไข persona ของตัวเอง', category: 'system', riskLevel: 'medium', platforms: ['all'], tags: ['evolution', 'edit', 'persona'], enabledByDefault: true },
  { name: 'self_add_learning', displayName: 'Self Add Learning', description: 'บันทึกสิ่งที่เรียนรู้', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['evolution', 'learn', 'journal'], enabledByDefault: true },
  { name: 'self_view_evolution', displayName: 'Self View Evolution', description: 'ดูประวัติการ evolve และสถานะปัญหา', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['evolution', 'log', 'history'], enabledByDefault: true },
  { name: 'self_reflect', displayName: 'Self Reflect', description: 'บังคับวิเคราะห์ผลงานตัวเอง', category: 'system', riskLevel: 'medium', platforms: ['all'], tags: ['evolution', 'reflect', 'analyze'], enabledByDefault: true },
  { name: 'self_heal', displayName: 'Self Heal', description: 'ตรวจสอบและซ่อมแซมตัวเองอัตโนมัติ', category: 'system', riskLevel: 'high', platforms: ['all'], tags: ['evolution', 'heal', 'fix'], enabledByDefault: true },

  // Auto-Tool Generation Tools
  { name: 'create_tool', displayName: 'Create Tool', description: 'สร้างเครื่องมือใหม่ที่ใช้ได้ทันที', category: 'system', riskLevel: 'high', platforms: ['all'], tags: ['evolution', 'tool', 'create', 'dynamic'], enabledByDefault: true },
  { name: 'list_dynamic_tools', displayName: 'List Dynamic Tools', description: 'แสดงรายการเครื่องมือที่สร้างขึ้นเอง', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['evolution', 'tool', 'list', 'dynamic'], enabledByDefault: true },
  { name: 'delete_dynamic_tool', displayName: 'Delete Dynamic Tool', description: 'ลบเครื่องมือที่สร้างขึ้นเอง', category: 'system', riskLevel: 'high', platforms: ['all'], tags: ['evolution', 'tool', 'delete', 'dynamic'], enabledByDefault: true },

  // Swarm Coordination Tools
  { name: 'delegate_task', displayName: 'Delegate Task', description: 'ส่งมอบงานย่อยให้ specialist ที่เหมาะสม', category: 'communication', riskLevel: 'low', platforms: ['all'], tags: ['swarm', 'delegate', 'specialist'], enabledByDefault: true },
  { name: 'check_swarm_status', displayName: 'Check Swarm Status', description: 'ตรวจสอบสถานะของระบบ swarm และคิวงาน', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['swarm', 'status', 'monitoring'], enabledByDefault: true },
  { name: 'list_specialists', displayName: 'List Specialists', description: 'แสดงรายการ specialist ที่ใช้ได้ในระบบ', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['swarm', 'specialist', 'list'], enabledByDefault: true },
  { name: 'add_cli_agent', displayName: 'Add CLI Agent', description: 'เพิ่ม CLI Agent ใหม่แบบอัตโนมัติ', category: 'system', riskLevel: 'high', platforms: ['all'], tags: ['system', 'cli', 'integration', 'admin'], enabledByDefault: true },
  { name: 'audit_cli_integration', displayName: 'Audit CLI Integration', description: 'ตรวจสอบการเชื่อมต่อของ CLI Agent', category: 'system', riskLevel: 'low', platforms: ['all'], tags: ['system', 'cli', 'audit', 'debug'], enabledByDefault: true },
];

// ── Registry API ─────────────────────────────────────

/** Initialize the registry with default tool metadata */
export function initToolRegistry(): void {
  for (const meta of defaultTools) {
    registry.set(meta.name, { ...meta });
  }
}

/** Register or update a tool's metadata + declaration */
export function registerTool(meta: ToolMeta): void {
  registry.set(meta.name, meta);
}

/** Get metadata for a specific tool */
export function getToolMeta(name: string): ToolMeta | undefined {
  return registry.get(name);
}

/** Get all registered tools */
export function getAllTools(): ToolMeta[] {
  return Array.from(registry.values());
}

/** Filter tools by category */
export function getToolsByCategory(category: ToolCategory): ToolMeta[] {
  return getAllTools().filter(t => t.category === category);
}

/** Filter tools by platform */
export function getToolsByPlatform(platform: ToolPlatform): ToolMeta[] {
  return getAllTools().filter(t => t.platforms.includes('all') || t.platforms.includes(platform));
}

/** Search tools by query (matches name, displayName, description, tags) */
export function searchTools(query: string): ToolMeta[] {
  const q = query.toLowerCase();
  return getAllTools().filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.displayName.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    t.tags.some(tag => tag.toLowerCase().includes(q))
  );
}

/** Get list of all categories with tool counts */
export function getToolCategories(): { category: ToolCategory; count: number }[] {
  const counts = new Map<ToolCategory, number>();
  for (const tool of registry.values()) {
    counts.set(tool.category, (counts.get(tool.category) || 0) + 1);
  }
  return Array.from(counts.entries()).map(([category, count]) => ({ category, count }));
}

/** Get tool names that are enabled by default */
export function getDefaultToolNames(): string[] {
  return getAllTools().filter(t => t.enabledByDefault).map(t => t.name);
}

// Auto-init on import
initToolRegistry();
