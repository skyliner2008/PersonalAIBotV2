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
