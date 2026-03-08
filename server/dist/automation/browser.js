import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { addLog } from '../database/db.js';
let browser = null;
let context = null;
let mainPage = null;
const COOKIES_FILE = path.join(config.cookiesDir, 'fb-cookies.json');
/**
 * Launch Playwright browser with stealth settings.
 */
export async function launchBrowser() {
    if (context)
        return context;
    fs.mkdirSync(config.cookiesDir, { recursive: true });
    browser = await chromium.launch({
        headless: config.headless,
        slowMo: config.slowMo,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--lang=th-TH,th',
        ],
    });
    context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        locale: 'th-TH',
        timezoneId: 'Asia/Bangkok',
    });
    // Anti-detection: override navigator.webdriver
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        // @ts-ignore
        window.chrome = { runtime: {} };
    });
    // Restore cookies if they exist
    if (fs.existsSync(COOKIES_FILE)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
            await context.addCookies(cookies);
            addLog('browser', 'Restored saved cookies', null, 'info');
        }
        catch (e) {
            addLog('browser', 'Failed to restore cookies', String(e), 'warning');
        }
    }
    addLog('browser', 'Browser launched', `headless=${config.headless}`, 'success');
    return context;
}
/**
 * Save current cookies to file for session persistence.
 */
export async function saveCookies() {
    if (!context)
        return;
    const cookies = await context.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    addLog('browser', 'Cookies saved', `${cookies.length} cookies`, 'info');
}
/**
 * Get or create the main Facebook page.
 */
export async function getMainPage() {
    if (mainPage && !mainPage.isClosed())
        return mainPage;
    const ctx = await launchBrowser();
    mainPage = await ctx.newPage();
    return mainPage;
}
/**
 * Create a new page (for parallel operations).
 */
export async function newPage() {
    const ctx = await launchBrowser();
    return ctx.newPage();
}
/**
 * Close everything.
 */
export async function closeBrowser() {
    // Set state first so bots detect browser is closing
    const hadContext = !!context;
    mainPage = null;
    if (context) {
        try {
            await saveCookies();
        }
        catch { }
        try {
            await context.close();
        }
        catch { }
        context = null;
    }
    if (browser) {
        try {
            await browser.close();
        }
        catch { }
        browser = null;
    }
    if (hadContext) {
        addLog('browser', 'Browser closed', null, 'info');
    }
}
/**
 * Human-like delay (random between min and max).
 */
export function humanDelay(min = 1000, max = 3000) {
    const ms = Math.floor(Math.random() * (max - min) + min);
    return new Promise(r => setTimeout(r, ms));
}
/**
 * Human-like typing (type with random delays between keys).
 */
export async function humanType(page, selector, text) {
    await page.click(selector);
    for (const char of text) {
        await page.keyboard.type(char, {
            delay: Math.random() * (config.maxTypingSpeed - config.minTypingSpeed) + config.minTypingSpeed
        });
    }
}
export function isRunning() {
    return !!context && !!browser;
}
//# sourceMappingURL=browser.js.map