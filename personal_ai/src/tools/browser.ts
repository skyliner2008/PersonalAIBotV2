import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { Type, FunctionDeclaration } from '@google/genai';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page | null = null;

// ==========================================
// Browser Manager (Singleton + Auto-Heal)
// ==========================================
async function getPage(): Promise<Page> {
  try {
    if (!browser || !browser.isConnected()) {
      browser = await chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox']
      });
      context = null;
    }

    if (!context) {
      context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        locale: 'th-TH,en-US',
      });
      page = null;
    }

    if (!page || page.isClosed()) {
      page = await context.newPage();
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(60000);
    }

    return page;
  } catch (err) {
    console.error('[Browser Manager Error]:', err);
    await cleanupBrowser();
    throw err;
  }
}

async function cleanupBrowser() {
  try { if (browser) await browser.close(); } catch (_) {}
  browser = null;
  context = null;
  page = null;
}

// ==========================================
// Smart Text Extractor — กรองขยะ nav/ads/script ออก
// ==========================================
async function extractSmartText(p: Page, maxChars = 12000): Promise<string> {
  return p.evaluate((limit: number) => {
    // ลบ elements ที่ไม่มีประโยชน์
    const remove = document.querySelectorAll(
      'script, style, noscript, nav, header, footer, aside, [role="banner"], [role="navigation"], [aria-hidden="true"], .ads, .advertisement, .cookie-banner'
    );
    remove.forEach(el => el.remove());

    // ดึง main content ก่อน ถ้าไม่มีค่อย fallback เป็น body
    const mainEl = document.querySelector('main, article, [role="main"], #content, .content, #main') || document.body;
    const text = (mainEl as HTMLElement).innerText || '';

    // Collapse whitespace
    return text.replace(/\n{3,}/g, '\n\n').trim().substring(0, limit);
  }, maxChars);
}

// ==========================================
// 1. Browser Navigate
// ==========================================
export const browserNavigateDeclaration: FunctionDeclaration = {
  name: 'browser_navigate',
  description: 'เปิดเว็บเบราว์เซอร์และไปยัง URL ที่กำหนด ส่งคืนเนื้อหาสำคัญบนหน้าเว็บ (กรองโฆษณา/menu ออกแล้ว)',
  parameters: {
    type: Type.OBJECT,
    properties: {
      url: { type: Type.STRING, description: 'URL เว็บไซต์ (ต้องมี http:// หรือ https://)' },
    },
    required: ['url'],
  },
};

export async function browserNavigate({ url }: { url: string }): Promise<string> {
  try {
    const p = await getPage();
    console.log(`[Browser] Navigating to: ${url}`);
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // รอให้ Dynamic content โหลด แต่สั้นกว่าเดิม
    await p.waitForTimeout(2000);
    const title = await p.title();
    const currentUrl = p.url();
    const textContent = await extractSmartText(p);
    return `✅ เปิดหน้าเว็บสำเร็จ\nTitle: ${title}\nURL: ${currentUrl}\n\nเนื้อหา:\n${textContent}`;
  } catch (error: any) {
    console.error('[Browser Navigate Error]:', error);
    return `❌ ไม่สามารถเข้าถึงเว็บได้: ${error.message}`;
  }
}

// ==========================================
// 2. Browser Get State (อ่านสถานะปัจจุบัน)
// ==========================================
export const browserGetStateDeclaration: FunctionDeclaration = {
  name: 'browser_get_state',
  description: 'อ่านสถานะเว็บที่เปิดอยู่: Title, URL และเนื้อหาที่มองเห็น ใช้เพื่อตรวจสอบผลหลังจากคลิกหรือ navigate',
  parameters: { type: Type.OBJECT, properties: {} },
};

export async function browserGetState(): Promise<string> {
  try {
    if (!page || page.isClosed()) return '❌ ยังไม่ได้เปิดเว็บ กรุณาใช้ browser_navigate ก่อน';
    const title = await page.title();
    const url = page.url();
    const text = await extractSmartText(page, 8000);
    return `📄 Title: ${title}\n🌐 URL: ${url}\n\nเนื้อหา:\n${text}`;
  } catch (error: any) {
    return `❌ อ่านสถานะไม่ได้: ${error.message}`;
  }
}

// ==========================================
// 3. Browser Screenshot (ถ่ายภาพหน้าจอ)
// ==========================================
export const browserScreenshotDeclaration: FunctionDeclaration = {
  name: 'browser_screenshot',
  description: 'ถ่ายภาพหน้าจอเว็บที่เปิดอยู่ บันทึกเป็น PNG ในโฟลเดอร์ downloads และส่งคืน path',
  parameters: { type: Type.OBJECT, properties: {} },
};

export async function browserScreenshot(): Promise<string> {
  try {
    if (!page || page.isClosed()) return '❌ ยังไม่ได้เปิดเว็บ';
    const { mkdirSync, existsSync } = await import('fs');
    const { join } = await import('path');
    const screenshotDir = join(process.cwd(), 'downloads');
    if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });
    const filename = `screenshot_${Date.now()}.png`;
    const filePath = join(screenshotDir, filename);
    await page.screenshot({ path: filePath, fullPage: false });
    return `📸 ถ่ายภาพสำเร็จ\nบันทึกที่: ${filePath}`;
  } catch (error: any) {
    return `❌ ถ่ายภาพไม่ได้: ${error.message}`;
  }
}

// ==========================================
// 4. Browser Click
// ==========================================
export const browserClickDeclaration: FunctionDeclaration = {
  name: 'browser_click',
  description: 'คลิกปุ่ม/ลิงก์บนเว็บโดยใช้ CSS Selector หรือ Text ที่มองเห็น',
  parameters: {
    type: Type.OBJECT,
    properties: {
      selector: { type: Type.STRING, description: 'CSS Selector (เช่น button#submit, .btn-search) หรือ text ที่ปรากฏ (เช่น "ค้นหา")' },
    },
    required: ['selector'],
  },
};

export async function browserClick({ selector }: { selector: string }): Promise<string> {
  try {
    if (!page || page.isClosed()) return '❌ ยังไม่ได้เปิดเว็บ';
    // ลองคลิกด้วย CSS selector ก่อน ถ้าไม่ได้ลอง text match
    try {
      await page.click(selector, { timeout: 8000 });
    } catch {
      // fallback: ลอง role/text
      await page.getByText(selector, { exact: false }).first().click({ timeout: 5000 });
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(1000);
    return `✅ คลิก '${selector}' สำเร็จ URL ปัจจุบัน: ${page.url()}`;
  } catch (error: any) {
    return `❌ คลิกไม่ได้: ${error.message}`;
  }
}

// ==========================================
// 5. Browser Type (กรอกข้อความ)
// ==========================================
export const browserTypeDeclaration: FunctionDeclaration = {
  name: 'browser_type',
  description: 'กรอกข้อความลงในช่อง input บนเว็บ (ช่องค้นหา, ฟอร์ม, login) อ้างอิงด้วย CSS Selector',
  parameters: {
    type: Type.OBJECT,
    properties: {
      selector: { type: Type.STRING, description: 'CSS Selector ของช่อง input (เช่น input[name=q], #search-box)' },
      text: { type: Type.STRING, description: 'ข้อความที่ต้องการกรอก' },
    },
    required: ['selector', 'text'],
  },
};

export async function browserType({ selector, text }: { selector: string; text: string }): Promise<string> {
  try {
    if (!page || page.isClosed()) return '❌ ยังไม่ได้เปิดเว็บ';
    const currentPage = page;
    await currentPage.fill(selector, text, { timeout: 10000 });
    return `✅ กรอกข้อความ '${text}' ลงใน '${selector}' สำเร็จ`;
  } catch (error: any) {
    // Fallback: type character by character
    try {
      if (!page || page.isClosed()) return `❌ กรอกข้อความไม่ได้: ${error.message}`;
      await page.type(selector, text, { delay: 50 });
      return `✅ กรอกข้อความ '${text}' สำเร็จ (fallback mode)`;
    } catch (_: any) {
      return `❌ กรอกข้อความไม่ได้: ${error.message}`;
    }
  }
}

// ==========================================
// 6. Browser Press Key
// ==========================================
export const browserPressKeyDeclaration: FunctionDeclaration = {
  name: 'browser_press_key',
  description: 'กดปุ่มคีย์บอร์ดบนเว็บ เช่น Enter, Tab, Escape, ArrowDown สำหรับส่งฟอร์มหรือ navigate dropdown',
  parameters: {
    type: Type.OBJECT,
    properties: {
      key: { type: Type.STRING, description: 'ชื่อปุ่ม เช่น Enter, Tab, Escape, ArrowDown, ArrowUp, Space, Backspace' },
    },
    required: ['key'],
  },
};

export async function browserPressKey({ key }: { key: string }): Promise<string> {
  try {
    if (!page || page.isClosed()) return '❌ ยังไม่ได้เปิดเว็บ';
    await page.keyboard.press(key);
    await page.waitForTimeout(800);
    return `✅ กดปุ่ม '${key}' สำเร็จ`;
  } catch (error: any) {
    return `❌ กดปุ่มไม่ได้: ${error.message}`;
  }
}

// ==========================================
// 7. Browser Scroll
// ==========================================
export const browserScrollDeclaration: FunctionDeclaration = {
  name: 'browser_scroll',
  description: 'เลื่อนหน้าเว็บขึ้น (up) หรือลง (down) เพื่อดูเนื้อหาที่ซ่อนอยู่ด้านล่าง',
  parameters: {
    type: Type.OBJECT,
    properties: {
      direction: {
        type: Type.STRING,
        description: 'ทิศทาง: "down" เลื่อนลง, "up" เลื่อนขึ้น, "bottom" ไปสุดล่าง, "top" ไปสุดบน'
      },
    },
    required: ['direction'],
  },
};

export async function browserScroll({ direction }: { direction: string }): Promise<string> {
  try {
    if (!page || page.isClosed()) return '❌ ยังไม่ได้เปิดเว็บ';

    const scrollMap: Record<string, string> = {
      down: 'window.scrollBy(0, window.innerHeight * 0.8)',
      up: 'window.scrollBy(0, -window.innerHeight * 0.8)',
      bottom: 'window.scrollTo(0, document.body.scrollHeight)',
      top: 'window.scrollTo(0, 0)',
    };
    const script = scrollMap[direction] || scrollMap['down'];
    await page.evaluate(script);
    await page.waitForTimeout(800);

    // อ่านเนื้อหาใหม่หลัง scroll
    const text = await extractSmartText(page, 8000);
    return `✅ เลื่อนหน้า '${direction}' สำเร็จ\nเนื้อหาที่มองเห็น:\n${text}`;
  } catch (error: any) {
    return `❌ เลื่อนหน้าไม่ได้: ${error.message}`;
  }
}

// ==========================================
// 8. Browser Close
// ==========================================
export const browserCloseDeclaration: FunctionDeclaration = {
  name: 'browser_close',
  description: 'ปิดเว็บเบราว์เซอร์เพื่อคืนทรัพยากร ควรเรียกหลังใช้งานเว็บเสร็จทุกครั้ง',
  parameters: { type: Type.OBJECT, properties: {} },
};

export async function browserClose(): Promise<string> {
  await cleanupBrowser();
  return '✅ ปิดเว็บเบราว์เซอร์เรียบร้อยแล้ว';
}
