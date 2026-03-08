import { exec } from 'child_process';
import { promisify } from 'util';
import { Type } from '@google/genai';
const execAsync = promisify(exec);
// ==========================================
// 1. Run Command (CMD/PowerShell)
// ==========================================
export const runCommandDeclaration = {
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
export async function runCommand({ command }) {
    try {
        const { stdout, stderr } = await execAsync(command);
        if (stderr) {
            console.warn(`⚠️ Command Stderr: ${stderr}`);
            return `Command executed with warnings/errors:
${stderr}
Output:
${stdout}`;
        }
        return `Success:
${stdout}`;
    }
    catch (error) {
        console.error(`❌ Command Error:`, error);
        return `Error executing command: ${error.message}`;
    }
}
// ==========================================
// 2. Open Application
// ==========================================
export const openApplicationDeclaration = {
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
export async function openApplication({ app_name_or_path }) {
    try {
        // ใช้คำสั่ง 'start' ของ Windows ในการเปิด
        await execAsync(`start "" "${app_name_or_path}"`);
        return `สั่งเปิดโปรแกรม '${app_name_or_path}' สำเร็จแล้ว`;
    }
    catch (error) {
        console.error(`❌ Open App Error:`, error);
        return `ไม่สามารถเปิดโปรแกรมได้: ${error.message}`;
    }
}
// ==========================================
// 3. Close Application
// ==========================================
export const closeApplicationDeclaration = {
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
export async function closeApplication({ process_name }) {
    try {
        // ใช้ taskkill ของ Windows
        await execAsync(`taskkill /IM "${process_name}" /F`);
        return `สั่งปิดโปรแกรม '${process_name}' สำเร็จแล้ว`;
    }
    catch (error) {
        console.error(`❌ Close App Error:`, error);
        return `ไม่สามารถปิดโปรแกรมได้ หรือโปรแกรมไม่ได้เปิดอยู่: ${error.message}`;
    }
}
//# sourceMappingURL=os.js.map