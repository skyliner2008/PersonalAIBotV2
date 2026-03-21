import * as fs from 'fs';
import * as path from 'path';
import { Type, FunctionDeclaration } from '@google/genai';

declare global {
  var onFileWrittenByTool: ((filePath: string) => void) | undefined;
}

// ============================================================
// 🔒 Path Security — prevent path traversal & system file access
// ============================================================
const BLOCKED_DIRS = [
  /[/\\]windows[/\\]system32/i,
  /[/\\]program files/i,
  /[/\\]programdata/i,
  /^[a-zA-Z]:[/\\]windows/i,
  /^\/etc/i,
  /^\/usr[/\\]bin/i,
  /^\/sys/i,
  /^\/proc/i,
];
const BLOCKED_EXTENSIONS = new Set(['.exe', '.dll', '.sys', '.bat', '.cmd', '.msi', '.scr', '.reg']);

async function executeFileOperation(
  filePath: string,
  mode: 'read' | 'write',
  errorPrefix: string,
  operation: (resolvedPath: string) => string | Promise<string>
): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const check = validateFilePath(filePath, mode, resolvedPath);
  if (!check.safe) return check.reason!;
  try {
    return await operation(resolvedPath);
  } catch (error: any) {
    return `${errorPrefix}: ${error.message}`;
  }
}

function validateFilePath(filePath: string, mode: 'read' | 'write' = 'write'): { safe: boolean; reason?: string } {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, '/');

  // Block system directories (both read and write)
  for (const pattern of BLOCKED_DIRS) {
    if (pattern.test(normalized)) {
      return { safe: false, reason: `🚫 ไม่อนุญาตให้เข้าถึง system directory: ${resolved}` };
    }
  }

  // Write/Delete: stricter checks
  if (mode === 'write') {
    // Block path traversal — must stay within cwd
    const cwdResolved = path.resolve(process.cwd());
    if (!resolved.startsWith(cwdResolved)) {
      return { safe: false, reason: '🚫 Path traversal — เข้าถึงบริเวณที่ไม่อนุญาต' };
    }
    // Block dangerous file extensions (write/delete only)
    const ext = path.extname(resolved).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return { safe: false, reason: `🚫 ไม่อนุญาตให้แก้ไขไฟล์ประเภท ${ext}` };
    }
  }

  return { safe: true };
}


// ==========================================
// 1. List Files in Directory
// ==========================================
export const listFilesDeclaration: FunctionDeclaration = {
  name: "list_files",
  description: "แสดงรายชื่อไฟล์และโฟลเดอร์ในไดเรกทอรีที่ระบุ เพื่อดูว่ามีไฟล์อะไรอยู่บ้าง",
  parameters: {
    type: Type.OBJECT,
    properties: {
      directory_path: {
        type: Type.STRING,
        description: "พาธของไดเรกทอรี (เช่น 'C:\\Users\\MSI\\Documents' หรือ '.')",
      },
    },
    required: ["directory_path"],
  },
};

export async function listFiles({ directory_path }: { directory_path: string }): Promise<string> {
  const check = validateFilePath(directory_path, 'read');
  if (!check.safe) return check.reason!;
  try {
    const resolvedPath = path.resolve(directory_path);
    const files = await fs.promises.readdir(resolvedPath);
    return `รายชื่อไฟล์ใน ${resolvedPath}:\n${files.join('\n')}`;
  } catch (error: any) {
    return `ไม่สามารถอ่านไดเรกทอรีได้: ${error.message}`;
  }
}

// ==========================================
// 2. Read File Content
// ==========================================
export const readFileContentDeclaration: FunctionDeclaration = {
  name: "read_file_content",
  description: "อ่านเนื้อหาภายในไฟล์ (รองรับเฉพาะไฟล์ข้อความ .txt, .js, .ts, .json, .md)",
  parameters: {
    type: Type.OBJECT,
    properties: {
      file_path: {
        type: Type.STRING,
        description: "พาธของไฟล์ที่ต้องการอ่าน",
      },
    },
    required: ["file_path"],
  },
};

export async function readFileContent({ file_path }: { file_path: string }): Promise<string> {
  const check = validateFilePath(file_path, 'read'); // updated
  if (!check.safe) return check.reason!;
  try {
    const resolvedPath = path.resolve(file_path);
    const content = fs.readFileSync(resolvedPath, 'utf8');
    return `เนื้อหาในไฟล์ ${resolvedPath}:\n---\n${content}\n---`;
  } catch (error: any) {
    return `ไม่สามารถอ่านไฟล์ได้: ${error.message}`;
  }
}

// ==========================================
// 3. Write/Create File
// ==========================================
export const writeFileContentDeclaration: FunctionDeclaration = {
  name: "write_file_content",
  description: "สร้างไฟล์ใหม่หรือเขียนทับไฟล์เดิมด้วยเนื้อหาที่ระบุ",
  parameters: {
    type: Type.OBJECT,
    properties: {
      file_path: {
        type: Type.STRING,
        description: "พาธของไฟล์ที่ต้องการสร้างหรือแก้ไข",
      },
      content: {
        type: Type.STRING,
        description: "เนื้อหาที่ต้องการเขียนลงในไฟล์",
      },
    },
    required: ["file_path", "content"],
  },
};

export async function writeFileContent({ file_path, content }: { file_path: string, content: string }): Promise<string> {
  const check = validateFilePath(file_path);
  if (!check.safe) return check.reason!;
  try {
    const resolvedPath = path.resolve(file_path);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolvedPath, content, 'utf8');
    
    // Allow external listeners (e.g. SelfUpgrade) to react before the server restarts
    if (typeof (global as any).onFileWrittenByTool === 'function') {
      (global as any).onFileWrittenByTool(resolvedPath);
    }

    return `เขียนไฟล์ลงใน ${resolvedPath} สำเร็จแล้ว`;
  } catch (error: any) {
    return `ไม่สามารถเขียนไฟล์ได้: ${error.message}`;
  }
}

// ==========================================
// 4. Delete File
// ==========================================
export const deleteFileDeclaration: FunctionDeclaration = {
  name: "delete_file",
  description: "ลบไฟล์ออกจากระบบอย่างถาวร (โปรดระมัดระวัง)",
  parameters: {
    type: Type.OBJECT,
    properties: {
      file_path: {
        type: Type.STRING,
        description: "พาธของไฟล์ที่ต้องการลบ",
      },
    },
    required: ["file_path"],
  },
};

export async function deleteFile({ file_path }: { file_path: string }): Promise<string> {
  const check = validateFilePath(file_path);
  if (!check.safe) return check.reason!;
  try {
    const resolvedPath = path.resolve(file_path);
    if (fs.existsSync(resolvedPath)) {
      fs.unlinkSync(resolvedPath);
      return `ลบไฟล์ ${resolvedPath} สำเร็จแล้ว`;
    }
    return `ไม่พบไฟล์ที่ต้องการลบ: ${resolvedPath}`;
  } catch (error: any) {
    return `เกิดข้อผิดพลาดในการลบไฟล์: ${error.message}`;
  }
}

// ==========================================
// 5. Surgical Code Replacement (Agentic Core)
// ==========================================
export const replaceCodeBlockDeclaration: FunctionDeclaration = {
  name: "replace_code_block",
  description: "ผ่าตัดโค้ด: แทนที่ข้อความหรือบล็อคโค้ดเดิมด้วยโค้ดใหม่ (ปลอดภัยกว่าการเขียนทับทั้งไฟล์)",
  parameters: {
    type: Type.OBJECT,
    properties: {
      file_path: {
        type: Type.STRING,
        description: "พาธของไฟล์ที่ต้องการแก้ไข",
      },
      exact_old_string: {
        type: Type.STRING,
        description: "ข้อความ/โค้ดเดิมเป๊ะๆ ที่ต้องการจะแก้ (รวม Tab/Space ให้ตรง)",
      },
      new_string: {
        type: Type.STRING,
        description: "ข้อความ/โค้ดใหม่ที่จะใส่ลงไปแทนที่",
      },
    },
    required: ["file_path", "exact_old_string", "new_string"],
  },
};

export async function replaceCodeBlock({ file_path, exact_old_string, new_string }: { file_path: string, exact_old_string: string, new_string: string }): Promise<string> {
  const check = validateFilePath(file_path);
  if (!check.safe) return check.reason!;
  try {
    const resolvedPath = path.resolve(file_path);
    if (!fs.existsSync(resolvedPath)) {
      return `Error: ไม่พบไฟล์ที่กำหนด: ${resolvedPath}`;
    }
    const content = fs.readFileSync(resolvedPath, 'utf8');
    if (!content.includes(exact_old_string)) {
      return `Error: ค้นหา exact_old_string ไม่เจอ กรุณาตรวจสอบว่าก็อปปี้มารวม \n และช่องว่าง (Space/Tab) ตรงตามต้นฉบับหรือไม่`;
    }
    const newContent = content.replace(exact_old_string, new_string);
    fs.writeFileSync(resolvedPath, newContent, 'utf8');
    
    // Allow external listeners (e.g. SelfUpgrade) to react
    if (typeof (global as any).onFileWrittenByTool === 'function') {
      (global as any).onFileWrittenByTool(resolvedPath);
    }

    return `Successfully replaced the exactly matched code block in ${resolvedPath}.`;
  } catch (error: any) {
    return `Error failed to replace code block: ${error.message}`;
  }
}
