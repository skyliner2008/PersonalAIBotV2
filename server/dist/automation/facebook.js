import { getMainPage, saveCookies, humanDelay } from './browser.js';
import { addLog, getSetting, setSetting } from '../database/db.js';
const FB_URL = 'https://www.facebook.com';
const MESSENGER_URL = 'https://www.facebook.com/messages/t/';
/**
 * Dismiss any cookie consent / overlay popups that block interaction.
 */
async function dismissPopups(page) {
    const popupSelectors = [
        // Cookie consent buttons
        'button[data-cookiebanner="accept_button"]',
        'button[data-cookiebanner="accept_only_essential_button"]',
        'button[title="อนุญาตคุกกี้ทั้งหมด"]',
        'button[title="Allow all cookies"]',
        'button[title="Allow essential and optional cookies"]',
        'button:has-text("Accept All")',
        'button:has-text("ยอมรับทั้งหมด")',
        'button:has-text("Allow")',
        // "Not Now" buttons
        'a[role="button"]:has-text("Not Now")',
        'a[role="button"]:has-text("ไม่ใช่ตอนนี้")',
        // Close dialog buttons
        'div[aria-label="Close"] [role="button"]',
        'div[aria-label="ปิด"] [role="button"]',
    ];
    for (const sel of popupSelectors) {
        try {
            const btn = await page.$(sel);
            if (btn && await btn.isVisible()) {
                console.log(`[FB] Dismissing popup: ${sel}`);
                await btn.click();
                await humanDelay(1000, 2000);
            }
        }
        catch { /* ignore */ }
    }
}
/**
 * Check if currently logged in to Facebook.
 */
export async function isLoggedIn() {
    try {
        const page = await getMainPage();
        console.log('[FB] Checking login status...');
        await page.goto(FB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(2000, 4000);
        await dismissPopups(page);
        const url = page.url();
        // If redirected to login page
        if (url.includes('login') || url.includes('checkpoint')) {
            console.log('[FB] On login/checkpoint page → not logged in');
            return false;
        }
        // Check for login form → not logged in
        const loginForm = await page.$('input[name="email"]');
        if (loginForm) {
            console.log('[FB] Login form found → not logged in');
            return false;
        }
        console.log('[FB] No login form → logged in');
        return true;
    }
    catch (e) {
        console.error('[FB] Login check error:', e);
        addLog('facebook', 'Login check failed', String(e), 'error');
        return false;
    }
}
/**
 * Login to Facebook with email and password.
 * Uses page.fill() for reliable input instead of keyboard typing.
 */
export async function login(email, password) {
    const fbEmail = email || getSetting('fb_email') || '';
    const fbPassword = password || getSetting('fb_password') || '';
    if (!fbEmail || !fbPassword) {
        console.error('[FB] Login failed: Email/Password not configured');
        addLog('facebook', 'Login failed', 'Email/Password not configured', 'error');
        return false;
    }
    try {
        console.log(`[FB] Starting login for: ${fbEmail}`);
        addLog('facebook', 'Opening Facebook...', null, 'info');
        const page = await getMainPage();
        console.log('[FB] Got main page, navigating to Facebook...');
        await page.goto(FB_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        console.log('[FB] Facebook loaded');
        addLog('facebook', 'Facebook page loaded', null, 'info');
        // Wait for page to be ready
        await humanDelay(3000, 5000);
        // Dismiss cookie popups first
        await dismissPopups(page);
        await humanDelay(1000, 2000);
        const currentUrl = page.url();
        console.log(`[FB] Current URL: ${currentUrl}`);
        // Wait for either login form or home page content
        try {
            await page.waitForSelector('input[name="email"], [role="navigation"], [aria-label="Facebook"]', { timeout: 15000 });
        }
        catch {
            console.log('[FB] Page structure not recognized, taking screenshot for debug...');
            addLog('facebook', 'Page structure not recognized', `URL: ${currentUrl}`, 'warning');
        }
        // Already logged in?
        const emailInput = await page.$('input[name="email"]');
        if (!emailInput) {
            console.log('[FB] No login form found → already logged in');
            addLog('facebook', 'Already logged in (session restored)', null, 'success');
            return true;
        }
        // Make sure email input is visible
        const isVisible = await emailInput.isVisible();
        if (!isVisible) {
            console.log('[FB] Email input exists but not visible, waiting...');
            await page.waitForSelector('input[name="email"]', { state: 'visible', timeout: 10000 });
        }
        console.log('[FB] Login form found, filling credentials...');
        addLog('facebook', 'Filling login form...', null, 'info');
        // ===== USE page.fill() INSTEAD OF keyboard.type =====
        // page.fill() clears the field and fills it directly on the element
        // This is much more reliable than clicking + keyboard typing
        await page.fill('input[name="email"]', fbEmail);
        console.log('[FB] Email filled');
        await humanDelay(500, 1000);
        // Make sure password input is visible
        const passInput = await page.$('input[name="pass"]');
        if (!passInput) {
            console.error('[FB] Password input not found!');
            addLog('facebook', 'Password input not found', 'page structure unexpected', 'error');
            return false;
        }
        await page.fill('input[name="pass"]', fbPassword);
        console.log('[FB] Password filled');
        await humanDelay(500, 1500);
        // Click login button
        addLog('facebook', 'Clicking login button...', null, 'info');
        // Try multiple button selectors in order
        const loginBtnSelectors = [
            'button[name="login"]',
            'button[data-testid="royal_login_button"]',
            'button[type="submit"]',
            'input[type="submit"]',
            '#loginbutton',
        ];
        let loginBtn = null;
        for (const sel of loginBtnSelectors) {
            loginBtn = await page.$(sel);
            if (loginBtn && await loginBtn.isVisible()) {
                console.log(`[FB] Found login button: ${sel}`);
                break;
            }
            loginBtn = null;
        }
        if (!loginBtn) {
            console.error('[FB] Login button not found!');
            addLog('facebook', 'Login button not found', 'Could not find login/submit button on page', 'error');
            return false;
        }
        await loginBtn.click();
        console.log('[FB] Login button clicked, waiting for response...');
        addLog('facebook', 'Login submitted, waiting...', null, 'info');
        // Wait for page change (navigation away from login page)
        try {
            await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 });
        }
        catch {
            // Might not trigger a full navigation, that's ok
        }
        await humanDelay(3000, 5000);
        const afterUrl = page.url();
        console.log(`[FB] After login URL: ${afterUrl}`);
        // Dismiss any post-login popups
        await dismissPopups(page);
        // Check for checkpoint/2FA
        if (afterUrl.includes('checkpoint') || afterUrl.includes('two_step_verification')) {
            console.log('[FB] 2FA/Checkpoint detected!');
            addLog('facebook', '2FA required!', 'Please complete 2FA in the browser window manually', 'warning');
            // Wait for user to complete 2FA manually (up to 2 minutes)
            for (let i = 0; i < 12; i++) {
                await humanDelay(10000, 10000);
                const checkUrl = page.url();
                console.log(`[FB] Waiting for 2FA... URL: ${checkUrl}`);
                if (!checkUrl.includes('checkpoint') && !checkUrl.includes('two_step_verification')) {
                    console.log('[FB] 2FA completed!');
                    break;
                }
            }
        }
        // Final check - are we still on login page?
        const finalUrl = page.url();
        const stillLoginPage = await page.$('input[name="email"]');
        if (stillLoginPage && (finalUrl.includes('login') || finalUrl === FB_URL + '/')) {
            const errorEl = await page.$('#error_box, [data-testid="royal_login_error"], ._9ay7, [role="alert"]');
            let errorMsg = 'Credentials may be wrong or 2FA required';
            if (errorEl) {
                errorMsg = await errorEl.textContent() || errorMsg;
            }
            console.error(`[FB] Login failed: ${errorMsg}`);
            addLog('facebook', 'Login failed', errorMsg, 'error');
            return false;
        }
        // Success!
        await saveCookies();
        console.log('[FB] Cookies saved');
        setSetting('fb_email', fbEmail);
        setSetting('fb_password', fbPassword);
        addLog('facebook', 'Login successful!', fbEmail, 'success');
        console.log('[FB] Login successful!');
        return true;
    }
    catch (e) {
        const msg = e?.message || String(e);
        console.error('[FB] Login error:', msg);
        addLog('facebook', 'Login error', msg, 'error');
        return false;
    }
}
/**
 * Navigate to a specific Facebook page.
 */
export async function navigateTo(url, page) {
    const p = page || await getMainPage();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanDelay(2000, 4000);
    await dismissPopups(p);
    return p;
}
/**
 * Create a text post on profile/page/group.
 */
export async function createPost(content, target = 'profile', targetId) {
    try {
        const page = await getMainPage();
        let url = FB_URL;
        if (target === 'page' && targetId)
            url = `${FB_URL}/${targetId}`;
        if (target === 'group' && targetId)
            url = `${FB_URL}/groups/${targetId}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay(3000, 5000);
        await dismissPopups(page);
        // Click "What's on your mind?" / create post area
        const postTriggers = [
            '[aria-label="คุณกำลังคิดอะไรอยู่"]',
            '[aria-label="What\'s on your mind"]',
            '[role="button"]:has-text("คุณกำลังคิดอะไร")',
            '[role="button"]:has-text("What\'s on your mind")',
            'div[data-pagelet="FeedComposer"] [role="button"]',
        ];
        let clicked = false;
        for (const sel of postTriggers) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible()) {
                    await el.click();
                    clicked = true;
                    console.log(`[FB Post] Clicked composer: ${sel}`);
                    break;
                }
            }
            catch {
                continue;
            }
        }
        if (!clicked) {
            addLog('post', 'Failed to find post composer', null, 'error');
            return false;
        }
        await humanDelay(2000, 3000);
        // Type content in the post editor
        const editorSelectors = [
            '[contenteditable="true"][role="textbox"]',
            '[data-testid="post-composer-text-input"]',
            'div[contenteditable="true"][aria-label]',
        ];
        let typed = false;
        for (const sel of editorSelectors) {
            try {
                const editor = await page.$(sel);
                if (editor && await editor.isVisible()) {
                    await editor.click();
                    await humanDelay(500, 1000);
                    // Type in chunks
                    const chunks = content.match(/.{1,50}/gs) || [content];
                    for (const chunk of chunks) {
                        await page.keyboard.type(chunk, { delay: 20 });
                        await humanDelay(100, 500);
                    }
                    typed = true;
                    console.log('[FB Post] Content typed');
                    break;
                }
            }
            catch {
                continue;
            }
        }
        if (!typed) {
            addLog('post', 'Failed to type in post editor', null, 'error');
            return false;
        }
        await humanDelay(2000, 4000);
        // Click Post button
        const postButtons = [
            'div[aria-label="โพสต์"]',
            'div[aria-label="Post"]',
            'button:has-text("โพสต์")',
            'button:has-text("Post")',
            '[data-testid="post-button"]',
        ];
        for (const sel of postButtons) {
            try {
                const btn = await page.$(sel);
                if (btn && await btn.isVisible()) {
                    await btn.click();
                    await humanDelay(3000, 5000);
                    addLog('post', 'Post created successfully', content.substring(0, 100), 'success');
                    return true;
                }
            }
            catch {
                continue;
            }
        }
        addLog('post', 'Failed to find Post button', null, 'error');
        return false;
    }
    catch (e) {
        addLog('post', 'Create post error', String(e), 'error');
        return false;
    }
}
/**
 * Get the Facebook user name from the logged-in session.
 */
export async function getLoggedInUserName() {
    try {
        const page = await getMainPage();
        const profileLink = await page.$('[aria-label="โปรไฟล์ของคุณ"] span, [aria-label="Your profile"] span');
        if (profileLink)
            return await profileLink.textContent();
        return null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=facebook.js.map