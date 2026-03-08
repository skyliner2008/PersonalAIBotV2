import { chromium } from 'playwright';
import { Type } from '@google/genai';
let browser = null;
let context = null;
let page = null;
/**
 * ฟังก์ชันจัดการเบราว์เซอร์ให้มีเพียงตัวเดียวและเสถียร
 */
async function getPage() {
    try {
        // 1. ตรวจสอบว่า Browser ยังทำงานอยู่ไหม
        if (!browser || !browser.isConnected()) {
            browser = await chromium.launch({
                headless: false, // เปลี่ยนเป็น true หากไม่ต้องการเห็นหน้าต่าง
                args: ['--disable-blink-features=AutomationControlled']
            });
            context = null; // Reset context เมื่อเปิด browser ใหม่
        }
        // 2. ตรวจสอบว่า Context ยังอยู่ไหม
        if (!context) {
            context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1280, height: 720 }
            });
            page = null; // Reset page เมื่อเปิด context ใหม่
        }
        // 3. ตรวจสอบว่า Page ยังอยู่และไม่ถูกปิดไป
        if (!page || page.isClosed()) {
            page = await context.newPage();
            // ตั้งค่า Timeout พื้นฐาน
            page.setDefaultTimeout(30000);
            page.setDefaultNavigationTimeout(60000);
        }
        return page;
    }
    catch (err) {
        console.error("[Browser Manager Error]:", err);
        // กรณีพังหนัก ให้ปิดและ Reset ทั้งหมดเพื่อให้ครั้งหน้าเริ่มใหม่ได้
        await cleanupBrowser();
        throw err;
    }
}
async function cleanupBrowser() {
    try {
        if (browser)
            await browser.close();
    }
    catch (e) { }
    browser = null;
    context = null;
    page = null;
}
// ==========================================
// 1. Browser Navigate
// ==========================================
export const browserNavigateDeclaration = {
    name: "browser_navigate",
    description: "เปิดเว็บเบราว์เซอร์และเข้าไปที่ URL ที่กำหนด พร้อมส่งคืนข้อความ (text) ทั้งหมดบนหน้าเว็บเพื่อให้อ่าน",
    parameters: {
        type: Type.OBJECT,
        properties: {
            url: {
                type: Type.STRING,
                description: "URL ของเว็บไซต์ที่ต้องการไป (ต้องมี http:// หรือ https://)",
            },
        },
        required: ["url"],
    },
};
export async function browserNavigate({ url }) {
    try {
        const p = await getPage();
        console.log(`[Browser] Navigating to: ${url}`);
        // เปลี่ยนมาใช้ 'domcontentloaded' เพื่อความเร็ว และป้องกัน Timeout จากโฆษณา
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        // รอสัก 3 วินาทีเพื่อให้ JavaScript รันและแสดงราคา (แทนการรอ networkidle)
        await p.waitForTimeout(3000);
        const title = await p.title();
        // ดึงเนื้อหา
        const textContent = await p.evaluate(() => document.body.innerText.substring(0, 15000));
        return `เปิดหน้าเว็บ '${title}' สำเร็จแล้ว\nURL ปัจจุบัน: ${url}\nเนื้อหาบนหน้าเว็บ:\n${textContent}...`;
    }
    catch (error) {
        console.error(`[Browser Navigate Error]:`, error);
        return `ไม่สามารถเข้าถึงหน้าเว็บได้ในขณะนี้: ${error.message}. ผมแนะนำให้ลองสั่งให้ผมค้นหาผ่าน Google Search แทนหากเว็บนี้เข้าไม่ได้ครับ`;
    }
}
// ==========================================
// 2. Browser Click
// ==========================================
export const browserClickDeclaration = {
    name: "browser_click",
    description: "คลิกปุ่มหรือลิงก์บนหน้าเว็บที่เปิดอยู่ โดยใช้ CSS Selector (เช่น button#submit หรือ .nav-link)",
    parameters: {
        type: Type.OBJECT,
        properties: {
            selector: {
                type: Type.STRING,
                description: "CSS Selector สำหรับอ้างอิง element ที่ต้องการคลิก",
            },
        },
        required: ["selector"],
    },
};
export async function browserClick({ selector }) {
    try {
        if (!page || page.isClosed())
            return "ข้อผิดพลาด: ยังไม่ได้เปิดหน้าเว็บ กรุณาใช้ browser_navigate ก่อน";
        await page.click(selector, { timeout: 10000 });
        await page.waitForLoadState('networkidle').catch(() => { });
        const newUrl = page.url();
        return `คลิกที่ '${selector}' สำเร็จแล้ว. URL ปัจจุบันคือ: ${newUrl}`;
    }
    catch (error) {
        return `ไม่สามารถคลิกได้: ${error.message}`;
    }
}
// ==========================================
// 3. Browser Type (Fill Text)
// ==========================================
export const browserTypeDeclaration = {
    name: "browser_type",
    description: "พิมพ์ข้อความลงในช่อง input บนหน้าเว็บ (เช่น ช่องค้นหา, ฟอร์มล็อกอิน) โดยอ้างอิงด้วย CSS Selector",
    parameters: {
        type: Type.OBJECT,
        properties: {
            selector: {
                type: Type.STRING,
                description: "CSS Selector สำหรับช่อง input (เช่น input[name=q])"
            },
            text: {
                type: Type.STRING,
                description: "ข้อความที่ต้องการพิมพ์",
            },
        },
        required: ["selector", "text"],
    },
};
export async function browserType({ selector, text }) {
    try {
        if (!page || page.isClosed())
            return "ข้อผิดพลาด: ยังไม่ได้เปิดหน้าเว็บ";
        await page.fill(selector, text, { timeout: 10000 });
        return `พิมพ์ข้อความ '${text}' ลงใน '${selector}' สำเร็จแล้ว`;
    }
    catch (error) {
        return `ไม่สามารถพิมพ์ข้อความได้: ${error.message}`;
    }
}
// ==========================================
// 4. Browser Close
// ==========================================
export const browserCloseDeclaration = {
    name: "browser_close",
    description: "ปิดหน้าเว็บเบราว์เซอร์หลังจากใช้งานเสร็จแล้ว เพื่อคืนทรัพยากร",
    parameters: { type: Type.OBJECT, properties: {} },
};
export async function browserClose() {
    await cleanupBrowser();
    return "ปิดเว็บเบราว์เซอร์เรียบร้อยแล้ว";
}
//# sourceMappingURL=browser.js.map