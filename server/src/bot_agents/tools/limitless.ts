import { Type, FunctionDeclaration } from '@google/genai';
import { runCommand } from './os.js';
import * as cheerio from 'cheerio';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('limitless-tool');

// ==========================================
// Web Search Tool
// ==========================================
export const webSearchDeclaration: FunctionDeclaration = {
    name: "web_search",
    description: "ค้นหาข้อมูลในอินเทอร์เน็ตผ่านเว็บเบราว์เซอร์ ใช้เมื่อไม่รู้ข้อมูลปัจจุบัน หรือต้องการสืบค้นข่าวสาร อัปเดตล่าสุด",
    parameters: {
        type: Type.OBJECT,
        properties: {
            query: { type: Type.STRING, description: "คำค้นหา (Search Query)" },
        },
        required: ["query"],
    },
};

function stripHtml(html: string): string {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&nbsp;/g, ' ')
        .replace(/\s{2,}/g, ' ').trim();
}

async function searchDDGLite(query: string): Promise<string | null> {
    const response = await fetch('https://lite.duckduckgo.com/lite/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
        },
        body: `q=${encodeURIComponent(query)}&kl=th-th&df=`,
        signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return null;
    const html = await response.text();
    if (html.length < 200) return null;

    const snippetPatterns = [
        /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi,
        /<td[^>]*class=['"][^'"]*snippet[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi,
    ];
    const snippets: string[] = [];
    const links: string[] = [];

    for (const pat of snippetPatterns) {
        let m;
        const re = new RegExp(pat);
        while ((m = re.exec(html)) !== null) {
            const text = stripHtml(m[1]);
            if (text.length > 20) snippets.push(text);
            if (snippets.length >= 5) break;
        }
        if (snippets.length > 0) break;
    }

    const linkRe = /<a[^>]+class=['"]result-link['"][^>]+href=['"]([^'"]+)['"][^>]*>/gi;
    let lm;
    while ((lm = linkRe.exec(html)) !== null) {
        links.push(lm[1]);
        if (links.length >= 5) break;
    }
    if (links.length === 0) {
        const allLinks = html.match(/https?:\/\/(?!duckduckgo)(?!www\.w3\.org)(?!schema\.org)[^\s"'<>&]{10,}/g) || [];
        links.push(...allLinks.slice(0, 5));
    }

    if (snippets.length === 0) return null;

    let result = `🔍 ผลการค้นหา: "${query}"\n\n`;
    const limit = Math.min(4, snippets.length);
    for (let i = 0; i < limit; i++) {
        const url = links[i] ? `\n   🔗 ${links[i]}` : '';
        result += `${i + 1}. ${snippets[i]}${url}\n\n`;
    }
    return result;
}

async function searchDDGInstant(query: string): Promise<string | null> {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const data = await response.json() as any;

    let result = `🔍 ผลการค้นหา: "${query}"\n\n`;
    let hasContent = false;

    if (data.AbstractText && data.AbstractText.length > 20) {
        result += `📖 ${data.AbstractText}\n`;
        if (data.AbstractURL) result += `   🔗 ${data.AbstractURL}\n`;
        result += '\n';
        hasContent = true;
    }
    if (data.Answer && data.Answer.length > 5) {
        result += `💡 ${data.Answer}\n\n`;
        hasContent = true;
    }
    const topics: any[] = data.RelatedTopics || [];
    let count = 0;
    for (const t of topics) {
        if (count >= 3) break;
        const text = t.Text || t.Result;
        if (text && text.length > 10) {
            result += `${count + 1}. ${text}`;
            if (t.FirstURL) result += `\n   🔗 ${t.FirstURL}`;
            result += '\n\n';
            count++;
            hasContent = true;
        }
    }
    return hasContent ? result : null;
}

export async function webSearch({ query }: { query: string }): Promise<string> {
    try {
        // Step 1: Get search snippets + links
        const liteResult = await searchDDGLite(query).catch(() => null);
        const instantResult = !liteResult ? await searchDDGInstant(query).catch(() => null) : null;
        const searchResult = liteResult || instantResult;

        if (!searchResult) {
            return `🔍 ค้นหา "${query}"\n\nไม่พบผลลัพธ์ในขณะนี้`;
        }

        // Step 2: Extract URLs from search results, skip non-content URLs
        const urlMatches = [...searchResult.matchAll(/🔗\s*(https?:\/\/[^\s]+)/g)]
            .map(m => m[1])
            .filter(u =>
              !u.includes('w3.org') && !u.includes('schema.org') &&
              !u.includes('.dtd') && !u.includes('.xml') &&
              !u.includes('translate.google') && !u.includes('google.com/translate') &&
              !u.includes('youtube.com') && !u.includes('facebook.com') &&
              !u.includes('instagram.com') && !u.includes('twitter.com')
            );

        if (urlMatches.length === 0) return searchResult;

        // Step 3: Auto-fetch the first result's actual page content
        try {
            logger.info(`[web_search] Auto-reading first result: ${urlMatches[0]}`);
            const pageContent = await readWebpage({ url: urlMatches[0] });

            // Combine snippets + page content (limit 2500 chars for voice-friendly speed)
            return `${searchResult}\n---\n📄 เนื้อหาจากผลลัพธ์อันดับ 1:\n${pageContent.substring(0, 2500)}`;
        } catch {
            // If page read fails, return just the snippets
            return searchResult;
        }
    } catch (err: any) {
        return `❌ ค้นหาไม่สำเร็จ: ${err.message}`;
    }
}

// ==========================================
// Read Webpage Content Tool
// ==========================================
export const readWebpageDeclaration: FunctionDeclaration = {
    name: "read_webpage",
    description: "อ่านเนื้อหาจากเว็บไซต์ (URL) แล้วแปลงเป็นข้อความ ใช้เมื่อต้องการอ่านบทความ ข่าว หรือเนื้อหาจากลิงก์ที่ค้นหาเจอ",
    parameters: {
        type: Type.OBJECT,
        properties: {
            url: { type: Type.STRING, description: "URL ของเว็บไซต์ที่ต้องการอ่าน" },
        },
        required: ["url"],
    },
};

export async function readWebpage({ url }: { url: string }): Promise<string> {
    try {
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
            },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return `❌ ไม่สามารถเปิดเว็บ ${url} ได้ (HTTP ${response.status})`;

        const html = await response.text();
        const $ = cheerio.load(html);

        // Remove unnecessary elements that consume tokens
        $('script, style, noscript, nav, header, footer, iframe, svg, img, form, button, .sidebar, #sidebar, .header, .footer, .ad, .advertisement, [role="navigation"]').remove();

        // Target article/main content first, fallback to body
        let root = $('article');
        if (root.length === 0) root = $('main');
        if (root.length === 0) root = $('body');

        let text = root.text() || '';

        // Clean up excessive whitespace
        text = text
            .replace(/\s{3,}/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        if (text.length < 50) return `❌ เว็บ ${url} มีโครงสร้างซับซ้อนหรือไม่พบเนื้อหาที่อ่านได้`;

        // Limit to 8000 chars for token efficiency
        if (text.length > 8000) {
            text = text.substring(0, 8000) + '\n\n...(เนื้อหาถูกตัดให้สั้นลงเพื่อประหยัด Token)';
        }

        return `📄 เนื้อหาจาก ${url}:\n\n${text}`;
    } catch (err: any) {
        return `❌ อ่านเว็บไม่สำเร็จ: ${err.message}`;
    }
}

// ==========================================
// Mouse & Keyboard Control (PyAutoGUI)
// ==========================================
export const mouseClickDeclaration: FunctionDeclaration = {
    name: "mouse_click",
    description: "คลิกเม้าส์ซ้าย 1 ครั้งตรงตำแหน่งปัจจุบัน ใช้สำหรับโต้ตอบกับ GUI ในคอมพิวเตอร์",
    parameters: { type: Type.OBJECT, properties: {} },
};

export async function mouseClick() {
    try {
        await runCommand({ command: 'python -c "import pyautogui; pyautogui.click()"' });
        return "คลิกเม้าส์สำเร็จ";
    } catch (err: any) {
        return `ไม่สามารถคลิกได้ (ต้องลง pip install pyautogui ก่อน): ${err.message}`;
    }
}

export const keyboardTypeDeclaration: FunctionDeclaration = {
    name: "keyboard_type",
    description: "พิมพ์ข้อความลงบนคีย์บอร์ดโดยตรง",
    parameters: {
        type: Type.OBJECT,
        properties: {
            text: { type: Type.STRING, description: "ข้อความที่จะพิมพ์" },
        },
        required: ["text"],
    },
};

export async function keyboardType({ text }: { text: string }) {
    try {
        // Safely escape user input to prevent command injection
        const safeText = JSON.stringify(text);
        await runCommand({ command: `python -c "import pyautogui, json; pyautogui.write(json.loads(${JSON.stringify(safeText)}))"` });
        return "พิมพ์ข้อความสำเร็จ";
    } catch (err: any) {
        return `พิมพ์ไม่สำเร็จ: ${err.message}`;
    }
}
