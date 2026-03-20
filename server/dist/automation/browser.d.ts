import { type BrowserContext, type Page } from 'playwright';
/**
 * Launch Playwright browser with stealth settings.
 */
export declare function launchBrowser(): Promise<BrowserContext>;
/**
 * Save current cookies to file for session persistence.
 */
export declare function saveCookies(): Promise<void>;
/**
 * Get or create the main Facebook page.
 */
export declare function getMainPage(): Promise<Page>;
/**
 * Create a new page (for parallel operations).
 */
export declare function newPage(): Promise<Page>;
/**
 * Close everything.
 */
export declare function closeBrowser(): Promise<void>;
/**
 * Human-like delay (random between min and max).
 */
export declare function humanDelay(min?: number, max?: number): Promise<void>;
/**
 * Human-like typing (type with random delays between keys).
 */
export declare function humanType(page: Page, selector: string, text: string): Promise<void>;
export declare function isRunning(): boolean;
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
export declare function navigateWithRetry(page: Page, url: string, maxRetries?: number, baseDelayMs?: number): Promise<void>;
