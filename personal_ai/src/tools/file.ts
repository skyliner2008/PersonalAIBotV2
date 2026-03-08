import * as fs from 'fs';
import * as path from 'path';
import { Type, FunctionDeclaration } from '@google/genai';

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
  try {
    const resolvedPath = path.resolve(directory_path);
    const files = fs.readdirSync(resolvedPath);
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
  try {
    const resolvedPath = path.resolve(file_path);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolvedPath, content, 'utf8');
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
