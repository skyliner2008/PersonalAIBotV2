import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { Type, FunctionDeclaration } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// Input validation helpers for command injection prevention
function isValidAppName(name: string): boolean {
  // Allow alphanumeric, dots, hyphens, underscores, spaces, drive letters, slashes
  return /^[\w.\-\s/\\:()]{1,260}$/u.test(name) &&
    !/[&|;`$]/.test(name); // No shell metacharacters
}

function isValidProcessName(name: string): boolean {
  return /^[\w.\-]{1,256}\.exe$/i.test(name);
}

// ============================================================
// 🔒 Command Security Sandbox
// ============================================================

// Patterns ที่อันตราย — ห้ามรันเด็ดขาด
const DANGEROUS_PATTERNS = [
  /\bformat\s+[a-z]:/i,          // format c:
  /\brmdir\s+\/s/i,              // rmdir /s (recursive delete)
  /\bdel\s+\/[sf]/i,             // del /s /f (silent force delete)
  /\brd\s+\/s/i,                 // rd /s
  /\bregsvr32\b/i,               // register DLL
  /\bwmic\s+.*delete/i,          // WMIC delete
  /\bnet\s+(user|localgroup)\b/i,// modify users/groups
  /\bschtasks\s+\/create/i,      // create scheduled tasks
  /\bpowershell.*-enc\b/i,       // base64 encoded PS
  /\bcurl\s+.*\|\s*(sh|bash|cmd)/i, // curl pipe shell
  /\bchmod\s+777/i,              // world-writable
  /\bsudo\b/i,                   // sudo
  /\b(rm|del)\s+.*\\\*/i,        // wildcard delete on root paths
  /shutdown\s+\/[rs]/i,          // shutdown/restart
  /\bregistry\b.*delete/i,       // registry delete
];

// Commands ที่อนุญาต (whitelist สำหรับโหมด strict)
const ALLOWED_COMMANDS_STRICT = new Set([
  'dir', 'ls', 'pwd', 'echo', 'type', 'cat', 'more',
  'ipconfig', 'ifconfig', 'ping', 'tracert', 'netstat', 'nslookup',
  'tasklist', 'ps', 'whoami', 'hostname', 'date', 'time', 'ver',
  'systeminfo', 'diskpart', 'df', 'du', 'free',
  'python', 'python3', 'node', 'npm', 'pip',
  'git', 'curl', 'wget', 'mkdir', 'copy', 'move', 'ren',
]);

function isSafeCommand(command: string): { safe: boolean; reason?: string } {
  const cmd = command.trim().toLowerCase();

  // ตรวจ patterns อันตราย
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { safe: false, reason: `คำสั่งนี้อาจเป็นอันตราย (ตรงกับ pattern: ${pattern.source})` };
    }
  }

  // ห้ามรัน command ที่มี pipe ไปยัง shell interpreter
  if (/\|\s*(cmd|powershell|bash|sh|zsh)\b/i.test(command)) {
    return { safe: false, reason: 'ห้าม pipe ไปยัง shell interpreter' };
  }

  // ห้ามใช้ command substitution ที่ซับซ้อน
  if (/`[^`]+`|\$\([^)]+\)/.test(command)) {
    return { safe: false, reason: 'ห้ามใช้ command substitution' };
  }

  return { safe: true };
}

// ==========================================
// 1. Run Command (CMD/PowerShell)
// ==========================================
export const runCommandDeclaration: FunctionDeclaration = {
  name: "run_command",
  description: "รันคำสั่ง Command Line (CMD/PowerShell) บนระบบปฏิบัติการ Windows คืนค่าผลลัพธ์จาก Terminal. ใช้สำหรับจัดการไฟล์ เช็คสถานะระบบ หรือควบคุม OS ในระดับลึก. ข้อควรระวัง: ห้ามสั่งลบระบบสำคัญเด็ดขาด",
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: {
        type: Type.STRING,
        description: "คำสั่งที่ต้องการรัน (เช่น 'dir', 'ipconfig', 'ping google.com')",
      },
    },
    required: ["command"],
  },
};

export async function runCommand({ command }: { command: string }): Promise<string> {
  // 🔒 Security check ก่อนรันทุกครั้ง
  const check = isSafeCommand(command);
  if (!check.safe) {
    console.warn(`[Security] Blocked command: "${command}" — ${check.reason}`);
    return `🚫 คำสั่งถูกบล็อก: ${check.reason}\nคำสั่งที่ปลอดภัย ได้แก่: dir, ping, ipconfig, tasklist, python, git ฯลฯ`;
  }

  try {
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
    if (stderr) {
      console.warn(`⚠️ Command Stderr: ${stderr}`);
      return `Output:\n${stdout}\n\nWarnings:\n${stderr}`;
    }
    return `✅ Output:\n${stdout || '(ไม่มี output)'}`;
  } catch (error: any) {
    console.error(`❌ Command Error:`, error);
    return `❌ Error: ${error.message}`;
  }
}

// ==========================================
// 2. Open Application
// ==========================================
export const openApplicationDeclaration: FunctionDeclaration = {
  name: "open_application",
  description: "เปิดโปรแกรมประยุกต์ (Application) หรือไฟล์บน Windows. ตัวอย่างเช่น 'notepad', 'chrome', 'calc', หรือพาธเต็มของโปรแกรม",
  parameters: {
    type: Type.OBJECT,
    properties: {
      app_name_or_path: {
        type: Type.STRING,
        description: "ชื่อโปรแกรม (เช่น notepad) หรือ พาธเต็ม",
      },
    },
    required: ["app_name_or_path"],
  },
};

export async function openApplication({ app_name_or_path }: { app_name_or_path: string }): Promise<string> {
  if (!isValidAppName(app_name_or_path)) {
    return `🚫 ชื่อโปรแกรมไม่ถูกต้อง (ห้ามมีอักขระพิเศษ &|;\`$)`;
  }
  try {
    // Use execFile with cmd.exe to avoid shell interpretation of app_name_or_path
    await execFileAsync('cmd.exe', ['/c', 'start', '', app_name_or_path], { timeout: 10_000 });
    return `สั่งเปิดโปรแกรม '${app_name_or_path}' สำเร็จแล้ว`;
  } catch (error: any) {
    console.error(`❌ Open App Error:`, error);
    return `ไม่สามารถเปิดโปรแกรมได้: ${error.message}`;
  }
}

// ==========================================
// 3. Close Application
// ==========================================
export const closeApplicationDeclaration: FunctionDeclaration = {
  name: "close_application",
  description: "ปิดโปรแกรมที่ทำงานอยู่โดยบังคับปิด (Force Close). ต้องระบุชื่อ Process Name ให้ถูกต้อง เช่น 'notepad.exe', 'chrome.exe'",
  parameters: {
    type: Type.OBJECT,
    properties: {
      process_name: {
        type: Type.STRING,
        description: "ชื่อของ process ที่ต้องการปิด (ต้องลงท้ายด้วย .exe เสมอ เช่น notepad.exe)",
      },
    },
    required: ["process_name"],
  },
};

export async function closeApplication({ process_name }: { process_name: string }): Promise<string> {
  if (!isValidProcessName(process_name)) {
    return `🚫 ชื่อ process ต้องลงท้ายด้วย .exe และมีเฉพาะตัวอักษร/ตัวเลข (เช่น notepad.exe)`;
  }
  try {
    // Use execFile to prevent shell injection
    await execFileAsync('taskkill', ['/IM', process_name, '/F'], { timeout: 10_000 });
    return `สั่งปิดโปรแกรม '${process_name}' สำเร็จแล้ว`;
  } catch (error: any) {
    console.error(`❌ Close App Error:`, error);
    return `ไม่สามารถปิดโปรแกรมได้ หรือโปรแกรมไม่ได้เปิดอยู่: ${error.message}`;
  }
}

// ==========================================
// 4. Run Python Code (Code Interpreter)
// ==========================================
export const runPythonDeclaration: FunctionDeclaration = {
  name: "run_python",
  description: "รัน Python code โดยตรง ใช้คำนวณ วิเคราะห์ข้อมูล สร้างกราฟ จัดการไฟล์ หรือทำอะไรก็ได้ที่ Python ทำได้ ส่งคืนผลลัพธ์ของ code",
  parameters: {
    type: Type.OBJECT,
    properties: {
      code: {
        type: Type.STRING,
        description: "Python code ที่ต้องการรัน (ใช้ print() เพื่อแสดงผล)",
      },
    },
    required: ["code"],
  },
};

export async function runPython({ code }: { code: string }): Promise<string> {
  const tmpDir = path.join(os.tmpdir(), 'ai_python');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `script_${Date.now()}.py`);
  try {
    fs.writeFileSync(tmpFile, code, 'utf8');
    const { stdout, stderr } = await execAsync(`python "${tmpFile}"`, { timeout: 30000 });
    const output = stdout || '';
    const errors = stderr || '';
    return errors
      ? `Output:\n${output}\n\nWarnings/Errors:\n${errors}`
      : `Output:\n${output}`;
  } catch (error: any) {
    return `❌ Python Error: ${error.message}\n${error.stderr || ''}`;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ==========================================
// 5. System Info
// ==========================================
export const systemInfoDeclaration: FunctionDeclaration = {
  name: "system_info",
  description: "ดึงข้อมูลระบบปฏิบัติการ เช่น CPU, RAM, Disk, Network, Uptime ใช้เมื่อต้องการเช็คสถานะเครื่อง",
  parameters: { type: Type.OBJECT, properties: {} },
};

export function systemInfo(): string {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const nets = os.networkInterfaces();
  const ips: string[] = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(`${name}: ${addr.address}`);
      }
    }
  }

  return `🖥️ ข้อมูลระบบ:
• OS: ${os.type()} ${os.release()} (${os.arch()})
• Hostname: ${os.hostname()}
• CPU: ${cpus[0]?.model || 'Unknown'} (${cpus.length} cores)
• RAM: ${(usedMem / 1024 / 1024 / 1024).toFixed(1)}GB / ${(totalMem / 1024 / 1024 / 1024).toFixed(1)}GB (${((usedMem / totalMem) * 100).toFixed(0)}%)
• Free RAM: ${(freeMem / 1024 / 1024 / 1024).toFixed(1)}GB
• Uptime: ${(os.uptime() / 3600).toFixed(1)} ชม.
• Network: ${ips.join(', ') || 'N/A'}
• Node.js: ${process.version}`;
}

// ==========================================
// 6. Screenshot Desktop (via PowerShell)
// ==========================================
export const screenshotDesktopDeclaration: FunctionDeclaration = {
  name: "screenshot_desktop",
  description: "ถ่ายภาพหน้าจอ Desktop ทั้งจอ บันทึกเป็นไฟล์ภาพ ใช้เมื่อต้องการดูว่าหน้าจอแสดงอะไรอยู่",
  parameters: {
    type: Type.OBJECT,
    properties: {
      save_path: {
        type: Type.STRING,
        description: "พาธที่จะบันทึกไฟล์ภาพ (ค่าเริ่มต้น: Desktop/screenshot.png)",
      },
    },
  },
};

export async function screenshotDesktop({ save_path }: { save_path?: string }): Promise<string> {
  const filePath = save_path || path.join(os.homedir(), 'Desktop', `screenshot_${Date.now()}.png`);
  try {
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bitmap = New-Object System.Drawing.Bitmap($screen.Bounds.Width, $screen.Bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Bounds.Location, [System.Drawing.Point]::Empty, $screen.Bounds.Size)
$bitmap.Save('${filePath.replace(/'/g, "''")}')
$graphics.Dispose()
$bitmap.Dispose()
`;
    await execAsync(`powershell -Command "${psScript.replace(/\n/g, '; ')}"`, { timeout: 15000 });
    return `✅ ถ่ายภาพหน้าจอสำเร็จ → ${filePath}`;
  } catch (err: any) {
    return `❌ Screenshot failed: ${err.message}`;
  }
}

// ==========================================
// 7. Clipboard Operations
// ==========================================
export const clipboardReadDeclaration: FunctionDeclaration = {
  name: "clipboard_read",
  description: "อ่านข้อความจาก Clipboard (คลิปบอร์ด) ของ Windows",
  parameters: { type: Type.OBJECT, properties: {} },
};

export async function clipboardRead(): Promise<string> {
  try {
    const { stdout } = await execAsync('powershell -command "Get-Clipboard"', { timeout: 5000 });
    return `📋 Clipboard: ${stdout.trim() || '(ว่าง)'}`;
  } catch (err: any) {
    return `❌ อ่าน Clipboard ไม่ได้: ${err.message}`;
  }
}

export const clipboardWriteDeclaration: FunctionDeclaration = {
  name: "clipboard_write",
  description: "เขียนข้อความลง Clipboard ของ Windows",
  parameters: {
    type: Type.OBJECT,
    properties: {
      text: { type: Type.STRING, description: "ข้อความที่ต้องการเขียน" },
    },
    required: ["text"],
  },
};

export async function clipboardWrite({ text }: { text: string }): Promise<string> {
  try {
    // Use stdin pipe instead of string interpolation to prevent injection
    const child = execFile('powershell', ['-command', '$input | Set-Clipboard'], { timeout: 5000 });
    child.stdin?.write(text);
    child.stdin?.end();
    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Exit code ${code}`)));
      child.on('error', reject);
    });
    return `✅ เขียนลง Clipboard สำเร็จ`;
  } catch (err: any) {
    return `❌ เขียน Clipboard ไม่ได้: ${err.message}`;
  }
}
