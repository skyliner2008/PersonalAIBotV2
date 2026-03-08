import { exec, execSync } from 'child_process';
import { promisify } from 'util';
import { Type, FunctionDeclaration } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);
const COMMAND_TIMEOUT_MS = 30000; // 30 วินาที ป้องกัน hang

// ==========================================
// 1. Run Command (CMD/PowerShell)
// ==========================================
export const runCommandDeclaration: FunctionDeclaration = {
  name: 'run_command',
  description: 'รันคำสั่ง Command Line บนระบบ Windows (CMD/PowerShell) คืนค่าผลลัพธ์จาก Terminal ใช้จัดการไฟล์ ดูสถานะระบบ หรือควบคุม OS ในระดับลึก',
  parameters: {
    type: Type.OBJECT,
    properties: {
      command: { type: Type.STRING, description: 'คำสั่งที่ต้องการรัน เช่น dir, ipconfig, tasklist' },
    },
    required: ['command'],
  },
};

export async function runCommand({ command }: { command: string }): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024, // 1MB buffer
    });

    let result = '';
    if (stderr && stderr.trim()) {
      result += `⚠️ Stderr:\n${stderr.trim()}\n\n`;
    }
    result += stdout.trim() || '(ไม่มี output)';

    // จำกัดความยาว output
    if (result.length > 8000) {
      result = result.substring(0, 8000) + '\n...(ตัดให้สั้นลง)';
    }
    return result;
  } catch (error: any) {
    if (error.killed || error.signal === 'SIGTERM') {
      return `⏰ Command timeout (เกิน ${COMMAND_TIMEOUT_MS / 1000}s): ${command}`;
    }
    return `❌ Error: ${error.message}`;
  }
}

// ==========================================
// 2. Python Code Execution
// ==========================================
export const runPythonDeclaration: FunctionDeclaration = {
  name: 'run_python',
  description: 'รัน Python Code โดยตรงบนเครื่อง ใช้สำหรับคำนวณ วิเคราะห์ข้อมูล สร้างกราฟ หรือทำงานอัตโนมัติ ผลลัพธ์คือ stdout/stderr จาก Python',
  parameters: {
    type: Type.OBJECT,
    properties: {
      code: { type: Type.STRING, description: 'Python code ที่ต้องการรัน (multiline ได้)' },
    },
    required: ['code'],
  },
};

export async function runPython({ code }: { code: string }): Promise<string> {
  // บันทึกโค้ดลงไฟล์ temp แล้วรัน
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `ai_script_${Date.now()}.py`);
  try {
    fs.writeFileSync(tmpFile, code, 'utf8');
    const { stdout, stderr } = await execAsync(`python "${tmpFile}"`, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 512,
    });
    let result = '';
    if (stderr && stderr.trim()) result += `⚠️ Stderr:\n${stderr.trim()}\n\n`;
    result += stdout.trim() || '(ไม่มี output)';
    if (result.length > 6000) result = result.substring(0, 6000) + '\n...(ตัดให้สั้นลง)';
    return result;
  } catch (error: any) {
    if (error.killed || error.signal === 'SIGTERM') {
      return `⏰ Python timeout (เกิน ${COMMAND_TIMEOUT_MS / 1000}s)`;
    }
    return `❌ Python Error: ${error.message}`;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (_) {}
  }
}

// ==========================================
// 3. Open Application
// ==========================================
export const openApplicationDeclaration: FunctionDeclaration = {
  name: 'open_application',
  description: 'เปิดโปรแกรม/ไฟล์บน Windows เช่น notepad, chrome, calc หรือ path เต็มของโปรแกรม',
  parameters: {
    type: Type.OBJECT,
    properties: {
      app_name_or_path: { type: Type.STRING, description: 'ชื่อโปรแกรม (notepad) หรือ path เต็ม' },
    },
    required: ['app_name_or_path'],
  },
};

export async function openApplication({ app_name_or_path }: { app_name_or_path: string }): Promise<string> {
  try {
    await execAsync(`start "" "${app_name_or_path}"`, { timeout: 10000 });
    return `✅ เปิดโปรแกรม '${app_name_or_path}' สำเร็จ`;
  } catch (error: any) {
    return `❌ เปิดโปรแกรมไม่ได้: ${error.message}`;
  }
}

// ==========================================
// 4. Close Application
// ==========================================
export const closeApplicationDeclaration: FunctionDeclaration = {
  name: 'close_application',
  description: 'ปิดโปรแกรมที่ทำงานอยู่ (Force Kill) โดยระบุชื่อ Process เช่น notepad.exe, chrome.exe',
  parameters: {
    type: Type.OBJECT,
    properties: {
      process_name: { type: Type.STRING, description: 'ชื่อ process (ลงท้าย .exe เสมอ เช่น notepad.exe)' },
    },
    required: ['process_name'],
  },
};

export async function closeApplication({ process_name }: { process_name: string }): Promise<string> {
  try {
    await execAsync(`taskkill /IM "${process_name}" /F`, { timeout: 10000 });
    return `✅ ปิดโปรแกรม '${process_name}' สำเร็จ`;
  } catch (error: any) {
    return `❌ ปิดโปรแกรมไม่ได้ (อาจไม่ได้เปิดอยู่): ${error.message}`;
  }
}
