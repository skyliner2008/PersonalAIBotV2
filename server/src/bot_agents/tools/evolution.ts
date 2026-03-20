// ============================================================
// Self-Evolution Tools — ให้ AI แก้ไขและปรับปรุงตัวเองได้
// ============================================================
// Safety: ทุก operation มี guardrails — backup ก่อนแก้, จำกัด scope,
// ห้ามแก้ core files, ทุกการเปลี่ยน log ลง evolution_log

import * as fs from 'fs';
import * as path from 'path';
import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { logEvolution, getEvolutionLog, getLearnings, addLearning, type LearningCategory } from '../../evolution/learningJournal.js';
import { shouldReflect, triggerReflection } from '../../evolution/selfReflection.js';
import { runHealthCheck } from '../../evolution/selfHealing.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('EvolutionTools');

// ── Safety Constants ──
const PROJECT_ROOT = path.resolve(process.cwd());
const PERSONAS_DIR = path.join(PROJECT_ROOT, 'personas');
const EVOLUTION_DIR = path.join(PROJECT_ROOT, 'evolution_data');

// Files that CANNOT be modified (core system files)
const PROTECTED_FILES = new Set([
    'agent.ts', 'index.ts', 'db.ts', 'schema.sql',
    'botManager.ts', 'queue.ts', 'unifiedMemory.ts',
]);

/**
 * Ensure evolution_data directory exists
 */
function ensureEvolutionDir(): void {
    if (!fs.existsSync(EVOLUTION_DIR)) {
        fs.mkdirSync(EVOLUTION_DIR, { recursive: true });
    }
}

/**
 * Create a backup of a file before modifying it
 */
function backupFile(filePath: string): string {
    const backupPath = filePath + `.bak.${Date.now()}`;
    if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, backupPath);
    }
    return backupPath;
}

/**
 * Validate that a path is within allowed scope
 */
function isPathAllowed(filePath: string, scope: 'personas' | 'source' | 'evolution'): boolean {
    const resolved = path.resolve(filePath);
    switch (scope) {
        case 'personas': return resolved.startsWith(PERSONAS_DIR);
        case 'source': return resolved.startsWith(path.join(PROJECT_ROOT, 'src'));
        case 'evolution': return resolved.startsWith(EVOLUTION_DIR);
        default: return false;
    }
}

// ============================================================
// Tool 1: self_read_source — อ่าน source code ของตัวเอง
// ============================================================

export const selfReadSourceDeclaration: FunctionDeclaration = {
    name: 'self_read_source',
    description: 'อ่าน source code ของตัวเอง เพื่อเข้าใจการทำงานและหาจุดปรับปรุง (read-only, จำกัดเฉพาะ server/src/)',
    parameters: {
        type: Type.OBJECT,
        properties: {
            file_path: {
                type: Type.STRING,
                description: 'พาธไฟล์ที่ต้องการอ่าน (สัมพัทธ์จาก server/ เช่น "src/bot_agents/agent.ts")',
            },
        },
        required: ['file_path'],
    },
};

export async function selfReadSource({ file_path }: { file_path: string }): Promise<string> {
    try {
        const fullPath = path.resolve(PROJECT_ROOT, file_path);
        if (!isPathAllowed(fullPath, 'source') && !isPathAllowed(fullPath, 'personas')) {
            return '🚫 ไม่อนุญาต: สามารถอ่านได้เฉพาะไฟล์ใน src/ และ personas/ เท่านั้น';
        }
        if (!fs.existsSync(fullPath)) return `❌ ไม่พบไฟล์: ${file_path}`;
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n').length;
        return `📄 ${file_path} (${lines} lines):\n---\n${content.substring(0, 5000)}\n---${content.length > 5000 ? `\n[...truncated, total ${content.length} chars]` : ''}`;
    } catch (err: any) {
        return `❌ อ่านไฟล์ไม่ได้: ${err.message}`;
    }
}

// ============================================================
// Tool 2: self_edit_persona — แก้ไข persona files
// ============================================================

export const selfEditPersonaDeclaration: FunctionDeclaration = {
    name: 'self_edit_persona',
    description: 'แก้ไข persona ของตัวเอง (AGENTS.md, IDENTITY.md, SOUL.md, TOOLS.md) เพื่อปรับปรุงพฤติกรรมและการตอบ (auto-backup ก่อนแก้)',
    parameters: {
        type: Type.OBJECT,
        properties: {
            platform: {
                type: Type.STRING,
                description: 'platform ที่ต้องการแก้ เช่น "telegram", "line"',
            },
            file_name: {
                type: Type.STRING,
                description: 'ชื่อไฟล์: AGENTS.md, IDENTITY.md, SOUL.md, TOOLS.md',
            },
            new_content: {
                type: Type.STRING,
                description: 'เนื้อหาใหม่ทั้งหมดที่ต้องการเขียน',
            },
            reason: {
                type: Type.STRING,
                description: 'เหตุผลที่ต้องการแก้ไข (จะถูกบันทึกใน evolution log)',
            },
        },
        required: ['platform', 'file_name', 'new_content', 'reason'],
    },
};

export async function selfEditPersona(
    { platform, file_name, new_content, reason }: { platform: string; file_name: string; new_content: string; reason: string }
): Promise<string> {
    const allowedFiles = ['AGENTS.md', 'IDENTITY.md', 'SOUL.md', 'TOOLS.md'];
    if (!allowedFiles.includes(file_name)) {
        return `🚫 ไม่อนุญาต: ไฟล์ที่แก้ได้มีแค่ ${allowedFiles.join(', ')}`;
    }

    const filePath = path.join(PERSONAS_DIR, platform, file_name);
    if (!isPathAllowed(filePath, 'personas')) {
        return '🚫 ไม่อนุญาต: path อยู่นอก personas directory';
    }

    try {
        const backupPath = backupFile(filePath);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        fs.writeFileSync(filePath, new_content, 'utf8');

        logEvolution('self_edit', `Edited persona: ${platform}/${file_name} — ${reason}`, {
            platform, file_name, reason,
            backup: backupPath,
            newContentLength: new_content.length,
        });

        log.info('Persona edited', { platform, file_name, reason });
        return `✅ แก้ไข ${platform}/${file_name} สำเร็จ!\nBackup: ${backupPath}\nReason: ${reason}`;
    } catch (err: any) {
        return `❌ แก้ไขไม่ได้: ${err.message}`;
    }
}

// ============================================================
// Tool 3: self_add_learning — บันทึกสิ่งที่เรียนรู้
// ============================================================

export const selfAddLearningDeclaration: FunctionDeclaration = {
    name: 'self_add_learning',
    description: 'บันทึกสิ่งที่เรียนรู้จากการทำงาน เช่น error solution, user pattern, prompt improvement — จะถูกนำไปใช้ปรับปรุงการตอบในอนาคต',
    parameters: {
        type: Type.OBJECT,
        properties: {
            category: {
                type: Type.STRING,
                description: 'หมวดหมู่: user_patterns, tool_usage, error_solutions, prompt_improvements, performance, general',
            },
            insight: {
                type: Type.STRING,
                description: 'สิ่งที่เรียนรู้ เช่น "ผู้ใช้มักถามเรื่อง crypto pricing ด้วยคำว่า เช็คราคา"',
            },
        },
        required: ['category', 'insight'],
    },
};

export async function selfAddLearning(
    { category, insight }: { category: string; insight: string }
): Promise<string> {
    try {
        const validCategories = ['user_patterns', 'tool_usage', 'error_solutions', 'prompt_improvements', 'performance', 'general'];
        if (!validCategories.includes(category)) {
            return `❌ category ไม่ถูกต้อง ต้องเป็น: ${validCategories.join(', ')}`;
        }
        addLearning(category as LearningCategory, insight, 'self_tool', 0.6);
        return `✅ บันทึกการเรียนรู้แล้ว: [${category}] ${insight}`;
    } catch (err: any) {
        return `❌ Error: ${err.message}`;
    }
}

// ============================================================
// Tool 4: self_view_evolution — ดู history การ evolve ตัวเอง
// ============================================================

export const selfViewEvolutionDeclaration: FunctionDeclaration = {
    name: 'self_view_evolution',
    description: 'ดู history การ evolve ตัวเอง: การแก้ไข, การเรียนรู้, การซ่อมตัวเอง ทั้งหมด',
    parameters: {
        type: Type.OBJECT,
        properties: {
            view_type: {
                type: Type.STRING,
                description: '"log" = evolution log, "learnings" = learning journal, "health" = health check',
            },
            limit: {
                type: Type.NUMBER,
                description: 'จำนวนรายการ (ค่าเริ่มต้น 10)',
            },
        },
    },
};

export async function selfViewEvolution(
    { view_type, limit }: { view_type?: string; limit?: number }
): Promise<string> {
    try {
        const n = limit || 10;

        switch (view_type) {
            case 'learnings': {
                const learnings = getLearnings(undefined, n);
                if (learnings.length === 0) return '📓 ยังไม่มี learnings ที่บันทึก';
                return `📓 Learning Journal (${learnings.length} entries):\n` +
                    learnings.map((l, i) => `${i + 1}. [${l.category}] ${l.insight} (confidence: ${l.confidence}, used: ${l.times_applied}x)`).join('\n');
            }
            case 'health': {
                const result = runHealthCheck();
                if (result.issues.length === 0) return '✅ Health check passed — ไม่พบปัญหา';
                return `🏥 Health Check: ${result.issues.length} issues found, ${result.fixed} fixed\n` +
                    result.issues.map(i => `  ${i.severity === 'high' ? '🔴' : '🟡'} [${i.type}] ${i.description}`).join('\n');
            }
            default: {
                const logs = getEvolutionLog(n);
                if (logs.length === 0) return '📋 ยังไม่มี evolution log';
                return `📋 Evolution Log (${logs.length} entries):\n` +
                    logs.map((l: any, i: number) => `${i + 1}. [${l.action_type}] ${l.description} (${l.created_at})`).join('\n');
            }
        }
    } catch (err: any) {
        return `❌ Error: ${err.message}`;
    }
}

// ============================================================
// Tool 5: self_reflect — บังคับทำ self-reflection ตอนนี้
// ============================================================

export const selfReflectDeclaration: FunctionDeclaration = {
    name: 'self_reflect',
    description: 'วิเคราะห์ตัวเอง: error patterns, performance, tool usage แล้วสร้าง insights เพื่อปรับปรุง',
    parameters: { type: Type.OBJECT, properties: {} },
};

export async function selfReflect(): Promise<string> {
    try {
        const report = await triggerReflection();
        if (!report) return '📊 ข้อมูลไม่เพียงพอสำหรับการวิเคราะห์ (ต้องมี >= 5 runs)';

        let output = `🧠 Self-Reflection Report:\n\n`;
        output += `📋 Findings (${report.findings.length}):\n`;
        output += report.findings.map(f => `  ${f}`).join('\n');
        output += `\n\n💡 Suggestions (${report.suggestions.length}):\n`;
        output += report.suggestions.map(s => `  • ${s}`).join('\n');
        output += `\n\n⚡ Auto-Actions: ${report.autoActions.filter(a => a.applied).length}/${report.autoActions.length} applied`;
        return output;
    } catch (err: any) {
        return `❌ Error: ${err.message}`;
    }
}

// ============================================================
// Tool 6: self_heal — บังคับทำ health check + auto-fix
// ============================================================

export const selfHealDeclaration: FunctionDeclaration = {
    name: 'self_heal',
    description: 'ตรวจสอบสุขภาพระบบและซ่อมแซมปัญหาที่พบอัตโนมัติ: auto-switch model, clear stuck queues',
    parameters: { type: Type.OBJECT, properties: {} },
};

export async function selfHeal(): Promise<string> {
    try {
        const result = runHealthCheck();
        if (result.issues.length === 0) {
            return '✅ ระบบสุขภาพดี — ไม่พบปัญหาที่ต้องแก้ไข';
        }

        let output = `🔧 Self-Healing Report:\n`;
        output += `Issues: ${result.issues.length} | Fixed: ${result.fixed} | Skipped: ${result.skipped}\n\n`;
        for (const issue of result.issues) {
            const icon = issue.severity === 'high' ? '🔴' : issue.severity === 'medium' ? '🟡' : '🟢';
            output += `${icon} ${issue.description}\n  → ${issue.suggestedFix}\n`;
        }
        return output;
    } catch (err: any) {
        return `❌ Error: ${err.message}`;
    }
}

// ============================================================
// Tool 7: create_tool — Create new dynamic tools
// ============================================================

import { registerDynamicTool, unregisterDynamicTool, listDynamicTools, getDynamicTool } from './dynamicTools.js';

export const createToolDeclaration: FunctionDeclaration = {
    name: 'create_tool',
    description: 'สร้างเครื่องมือใหม่ที่ฉันสามารถใช้ได้ ให้ระบุชื่อ, คำอธิบาย, schema ของ parameter, และ code implementation',
    parameters: {
        type: Type.OBJECT,
        properties: {
            name: {
                type: Type.STRING,
                description: 'ชื่อเครื่องมือ (kebab-case, เช่น fetch-weather, convert-units)',
            },
            description: {
                type: Type.STRING,
                description: 'คำอธิบายว่าเครื่องมือนี้ทำอะไร',
            },
            parameters: {
                type: Type.OBJECT,
                description: 'JSON Schema สำหรับ parameter ของเครื่องมือ (ใช้ type object)',
            },
            code: {
                type: Type.STRING,
                description: 'TypeScript/JavaScript code สำหรับ handler ฟังก์ชัน (async function body, return ผลลัพธ์เป็น string)',
            },
        },
        required: ['name', 'description', 'code'],
    },
};

export async function createTool({
    name,
    description,
    code,
    parameters,
}: {
    name: string;
    description: string;
    code: string;
    parameters?: Record<string, unknown>;
}): Promise<string> {
    try {
        const result = await registerDynamicTool(name, description, code, parameters);

        if (!result.valid) {
            let errorMsg = `❌ ไม่สามารถสร้างเครื่องมือได้:\n`;
            errorMsg += result.errors.map((e) => `  • ${e}`).join('\n');
            if (result.warnings.length > 0) {
                errorMsg += `\n\n⚠️ Warnings:\n`;
                errorMsg += result.warnings.map((w) => `  • ${w}`).join('\n');
            }
            return errorMsg;
        }

        let successMsg = `✅ สร้างเครื่องมือ '${name}' สำเร็จแล้ว!`;
        if (result.warnings.length > 0) {
            successMsg += `\n\n⚠️ Warnings:\n`;
            successMsg += result.warnings.map((w) => `  • ${w}`).join('\n');
        }
        return successMsg;
    } catch (err: any) {
        return `❌ Error: ${err.message}`;
    }
}

// ============================================================
// Tool 8: list_dynamic_tools — List all custom tools
// ============================================================

export const listDynamicToolsDeclaration: FunctionDeclaration = {
    name: 'list_dynamic_tools',
    description: 'แสดงรายการเครื่องมือที่เราสร้างขึ้นเองทั้งหมด',
    parameters: { type: Type.OBJECT, properties: {} },
};

export async function listDynamicToolsHandler(): Promise<string> {
    try {
        const tools = listDynamicTools();
        if (tools.length === 0) {
            return '📋 ยังไม่มีเครื่องมือที่สร้างขึ้นเอง';
        }

        let output = `📋 Custom Tools (${tools.length}):\n\n`;
        for (const tool of tools) {
            output += `• ${tool.name}\n`;
            output += `  ${tool.description}\n`;
            if (tool.parameters) {
                const hasProperties = (tool.parameters as any).properties;
                if (hasProperties) {
                    const paramList = Object.keys(hasProperties)
                        .map((p) => `${p}`)
                        .join(', ');
                    output += `  Parameters: ${paramList}\n`;
                }
            }
            output += '\n';
        }
        return output;
    } catch (err: any) {
        return `❌ Error: ${err.message}`;
    }
}

// ============================================================
// Tool 9: delete_dynamic_tool — Delete a custom tool
// ============================================================

export const deleteDynamicToolDeclaration: FunctionDeclaration = {
    name: 'delete_dynamic_tool',
    description: 'ลบเครื่องมือที่สร้างขึ้นเอง (ไม่สามารถคืนได้)',
    parameters: {
        type: Type.OBJECT,
        properties: {
            name: {
                type: Type.STRING,
                description: 'ชื่อของเครื่องมือที่ต้องการลบ',
            },
        },
        required: ['name'],
    },
};

export async function deleteDynamicTool({ name }: { name: string }): Promise<string> {
    try {
        const tool = getDynamicTool(name);
        if (!tool) {
            return `❌ ไม่พบเครื่องมือ: ${name}`;
        }

        const result = await unregisterDynamicTool(name);
        if (!result.success) {
            return `❌ ไม่สามารถลบเครื่องมือได้: ${result.error}`;
        }

        return `✅ ลบเครื่องมือ '${name}' สำเร็จแล้ว`;
    } catch (err: any) {
        return `❌ Error: ${err.message}`;
    }
}

// ============================================================
// Export all declarations and handlers
// ============================================================

export const evolutionToolDeclarations: FunctionDeclaration[] = [
    selfReadSourceDeclaration,
    selfEditPersonaDeclaration,
    selfAddLearningDeclaration,
    selfViewEvolutionDeclaration,
    selfReflectDeclaration,
    selfHealDeclaration,
    createToolDeclaration,
    listDynamicToolsDeclaration,
    deleteDynamicToolDeclaration,
];

export function getEvolutionToolHandlers(): Record<string, (args: any) => Promise<string>> {
    return {
        self_read_source: selfReadSource,
        self_edit_persona: selfEditPersona,
        self_add_learning: selfAddLearning,
        self_view_evolution: selfViewEvolution,
        self_reflect: selfReflect,
        self_heal: selfHeal,
        create_tool: createTool,
        list_dynamic_tools: listDynamicToolsHandler,
        delete_dynamic_tool: deleteDynamicTool,
    };
}
