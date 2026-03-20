import { Type, FunctionDeclaration } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('CLIManagementTool');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../../');

export const addCliAgentDeclaration: FunctionDeclaration = {
  name: "add_cli_agent",
  description: "เพิ่ม CLI Agent ใหม่เข้าไปในระบบโดยอัตโนมัติ (Discovery, Messaging, Swarm, Voice). ต้องระบุชื่อ executable และข้อมูลพื้นฐาน.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      cliName: {
        type: Type.STRING,
        description: "ชื่อตัวเล็กของ CLI (เช่น 'opencode', 'gemini', 'claude')"
      },
      executable: {
        type: Type.STRING,
        description: "ชื่อไฟล์รัน (executable) เช่น 'opencode', 'gemini-cli'"
      },
      displayName: {
        type: Type.STRING,
        description: "ชื่อที่แสดงบน Dashboard"
      },
      description: {
        type: Type.STRING,
        description: "คำอธิบายความสามารถสั้นๆ"
      },
      icon: {
        type: Type.STRING,
        description: "Emoji icon (เช่น '📜', '🔷')"
      }
    },
    required: ["cliName", "executable", "displayName", "description", "icon"]
  }
};

export async function addCliAgent(args: {
  cliName: string;
  executable: string;
  displayName: string;
  description: string;
  icon: string;
}): Promise<string> {
  const { cliName, executable, displayName, description, icon } = args;
  const cli = cliName.toLowerCase();
  const logs: string[] = [];

  try {
    updateCommandRouter(executable, logs);
    updateMessagingBridge(cli, displayName, logs);
    updateMeetingRoom(cli, icon, description, logs);
    updateSocketHandlers(cli, icon, logs);

    return `🚀 Successfully integrated ${displayName} (@${cli}):\n${logs.join('\n')}\n\nPlease restart the server or wait for the next health check to see the changes.`;
  } catch (err: any) {
    log.error('Failed to add CLI agent', { cli, error: err.message });
    return `❌ Failed to add CLI agent: ${err.message}`;
  }
}

/** 1. Update commandRouter.ts (Discovery) */
function updateCommandRouter(executable: string, logs: string[]) {
  const routerPath = path.join(rootDir, 'server/src/terminal/commandRouter.ts');
  if (fs.existsSync(routerPath)) {
    let content = fs.readFileSync(routerPath, 'utf8');
    if (!content.includes(`'${executable}'`)) {
      content = content.replace(
        /const KNOWN_CLI_CANDIDATES = \[([\s\S]*?)\];/,
        (match, p1) => `const KNOWN_CLI_CANDIDATES = [${p1.trim()}, '${executable}'];`
      );
      fs.writeFileSync(routerPath, content, 'utf8');
      logs.push(`✅ Added to KNOWN_CLI_CANDIDATES in commandRouter.ts`);
    } else {
      logs.push(`ℹ️ Executable '${executable}' already exists in commandRouter.ts`);
    }
  }
}

/** 2. Update messagingBridge.ts (Messaging) */
function updateMessagingBridge(cli: string, displayName: string, logs: string[]) {
  const bridgePath = path.join(rootDir, 'server/src/terminal/messagingBridge.ts');
  if (fs.existsSync(bridgePath)) {
    let content = fs.readFileSync(bridgePath, 'utf8');
    if (!content.includes(`@${cli}`)) {
      // Add to ADMIN_PREFIXES
      content = content.replace(
        /const ADMIN_PREFIXES = \[([\s\S]*?)\];/,
        (match, p1) => `const ADMIN_PREFIXES = [${p1.trim()}, /^@${cli}(?:\\s+|$)/i];`
      );
      // Add to isSummoning regex
      content = content.replace(
        /const isSummoning = \/\^@(jarvis|gemini|claude|codex|kilo|all|opencode)/i,
        (match) => match.includes(cli) ? match : `${match.slice(0, -1)}|${cli})`
      );
      // Add to bossModeLabel
      content = content.replace(
        /case '(.*?)': return '(.*?)';/g,
        (match, p1, p2) => match + (p1 === 'opencode' ? `\n    case '${cli}': return '${displayName}';` : '')
      );
      fs.writeFileSync(bridgePath, content, 'utf8');
      logs.push(`✅ Updated messagingBridge.ts for @${cli} support`);
    }
  }
}

/** 3. Update meetingRoom.ts (Voice) */
function updateMeetingRoom(cli: string, icon: string, description: string, logs: string[]) {
  const meetingRoomPath = path.join(rootDir, 'server/src/api/meetingRoom.ts');
  if (fs.existsSync(meetingRoomPath)) {
    let content = fs.readFileSync(meetingRoomPath, 'utf8');
    if (!content.includes(`${cli}:`)) {
      // Add icon
      content = content.replace(
        /const CLI_ICONS: Record<string, string> = \{([\s\S]*?)\};/,
        (match, p1) => `const CLI_ICONS: Record<string, string> = {${p1.trim()} ${cli}: '${icon}', };`
      );
      // Add to DECOMPOSE_PROMPT
      content = content.replace(
        /- opencode: (.*?)\n/,
        (match) => `${match}- ${cli}: ${description}\n`
      );
      fs.writeFileSync(meetingRoomPath, content, 'utf8');
      logs.push(`✅ Updated meetingRoom.ts with icon '${icon}' and description`);
    }
  }
}

/** 4. Update socketHandlers.ts (Voice Icons) */
function updateSocketHandlers(cli: string, icon: string, logs: string[]) {
  const socketPath = path.join(rootDir, 'server/src/api/socketHandlers.ts');
  if (fs.existsSync(socketPath)) {
    let content = fs.readFileSync(socketPath, 'utf8');
    if (!content.includes(`${cli}:`)) {
      content = content.replace(
        /const iconMap: Record<string, string> = \{ (.*?) \};/,
        (match, p1) => `const iconMap: Record<string, string> = { ${p1.trim()} ${cli}: '${icon}' };`
      );
      fs.writeFileSync(socketPath, content, 'utf8');
      logs.push(`✅ Updated socketHandlers.ts icon map`);
    }
  }
}
