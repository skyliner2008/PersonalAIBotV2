import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { addLog } from '../database/db.js';
import { getBrowserHeadless } from '../config/runtimeSettings.js';

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let mainPage: Page | null = null;

const COOKIES_FILE = path.join(config.cookiesDir, 'fb-cookies.json');

/**
 * Launch Playwright browser with stealth settings.
 */
export async function launchBrowser(): Promise<BrowserContext> {
  if (context) return context;

  fs.mkdirSync(config.cookiesDir, { recursive: true });

  const headless = getBrowserHeadless();

  browser = await chromium.launch({
    headless,
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
      addLog('browser', 'Restored saved cookies', undefined, 'info');
    } catch (e) {
      addLog('browser', 'Failed to restore cookies', String(e), 'warning');
    }
  }

  addLog('browser', 'Browser launched', `headless=${headless}`, 'success');
  return context;
}

/**
 * Save current cookies to file for session persistence.
 */
export async function saveCookies(): Promise<void> {
  if (!context) return;
  const cookies = await context.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  addLog('browser', 'Cookies saved', `${cookies.length} cookies`, 'info');
}

/**
 * Get or create the main Facebook page.
 */
export async function getMainPage(): Promise<Page> {
  if (mainPage && !mainPage.isClosed()) return mainPage;

  // Close existing page if it exists but is closed to prevent orphaned resources
  if (mainPage && mainPage.isClosed()) {
    try {
      await mainPage.close();
    } catch {
      // Page already closed, ignore
    }
    mainPage = null;
  }

  const ctx = await launchBrowser();
  mainPage = await ctx.newPage();
  return mainPage;
}

/**
 * Create a new page (for parallel operations).
 */
export async function newPage(): Promise<Page> {
  const ctx = await launchBrowser();
  return ctx.newPage();
}

/**
 * Close everything.
 */
export async function closeBrowser(): Promise<void> {
  // Set state first so bots detect browser is closing
  const hadContext = !!context;
  mainPage = null;

  if (context) {
    try { await saveCookies(); } catch (e) { console.debug('[Browser] saveCookies:', String(e)); }
    try { await context.close(); } catch (e) { console.debug('[Browser] close context:', String(e)); }
    context = null;
  }
  if (browser) {
    try { await browser.close(); } catch (e) { console.debug('[Browser] close browser:', String(e)); }
    browser = null;
  }
  if (hadContext) {
    addLog('browser', 'Browser closed', undefined, 'info');
  }
}

/**
 * Human-like delay (random between min and max).
 */
export function humanDelay(min: number = 1000, max: number = 3000): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min) + min);
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Human-like typing (type with random delays between keys).
 */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector);
  for (const char of text) {
    await page.keyboard.type(char, {
      delay: Math.random() * (config.maxTypingSpeed - config.minTypingSpeed) + config.minTypingSpeed
    });
  }
}

export function isRunning(): boolean {
  return !!context && !!browser;
}

/**
 * Navigate with exponential-backoff retry.
 * Retries up to `maxRetries` times on navigation errors (network blips,
 * Facebook rate-limit redirects, etc.) before throwing.
 *
 * @param page        - Playwright Page
 * @param url         - URL to navigate to
 * @param maxRetries  - How many attempts total (default 3)
 * @param baseDelayMs - Initial wait before first retry in ms (default 1500)
 */
export async function navigateWithRetry(
  page: Page,
  url: string,
  maxRetries = 3,
  baseDelayMs = 1500,
): Promise<void> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return; // success
    } catch (err) {
      lastErr = err;
      const backoff = baseDelayMs * Math.pow(2, attempt - 1); // 1.5s, 3s, 6s…
      addLog(
        'browser',
        `navigateWithRetry (attempt ${attempt}/${maxRetries})`,
        `url=${url} err=${String(err)} retrying in ${backoff}ms`,
        attempt < maxRetries ? 'warning' : 'error',
      );
      if (attempt < maxRetries) {
        await humanDelay(backoff, backoff + 1000);
      }
    }
  }

  throw lastErr;
}
