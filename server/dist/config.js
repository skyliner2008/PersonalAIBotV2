import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');
export const config = {
    port: parseInt(process.env.PORT || '3000'),
    dataDir: DATA_DIR,
    dbPath: path.join(DATA_DIR, 'fb-agent.db'),
    cookiesDir: path.join(DATA_DIR, 'cookies'),
    uploadsDir: path.join(DATA_DIR, 'uploads'),
    // AI Defaults (overridden via dashboard settings)
    defaultAiProvider: 'gemini',
    // Playwright
    headless: process.env.HEADLESS === 'true', // default false (show browser), set HEADLESS=true to hide
    slowMo: parseInt(process.env.SLOW_MO || '0'),
    // Anti-detection
    minReplyDelay: 3000, // min ms before replying
    maxReplyDelay: 15000, // max ms
    minTypingSpeed: 30, // ms per character (typing indicator)
    maxTypingSpeed: 80,
    // Rate Limiting Configuration
    rateLimit: {
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes default
        max: parseInt(process.env.RATE_LIMIT_MAX || '100'), // 100 requests per window
        message: 'Too many requests from this IP, please try again later.',
        standardHeaders: true,
        legacyHeaders: false,
    },
    // Encryption Configuration
    encryption: {
        key: process.env.ENCRYPTION_KEY || '',
        algorithm: 'aes-256-gcm',
        ivLength: 12, // 12 bytes for GCM
        authTagLength: 16, // 16 bytes for GCM
    },
    // Security Configuration
    security: {
        /** Refuse encrypt/decrypt when no ENCRYPTION_KEY is set (recommended for production) */
        requireEncryptionKey: process.env.REQUIRE_ENCRYPTION_KEY === '1' || process.env.NODE_ENV === 'production',
        /** Content-Security-Policy directives */
        cspEnabled: process.env.CSP_ENABLED !== '0',
        /** HSTS max-age in seconds (default 1 year) */
        hstsMaxAge: parseInt(process.env.HSTS_MAX_AGE || '31536000'),
    },
};
// Warn about missing security-critical env vars at import time
if (!config.encryption.key) {
    const level = config.security.requireEncryptionKey ? 'ERROR' : 'WARN';
    console.warn(`⚠️  [${level}] ENCRYPTION_KEY not set — encryption features will ${config.security.requireEncryptionKey ? 'FAIL' : 'use empty-key fallback'}. Set ENCRYPTION_KEY in .env for production.`);
}
//# sourceMappingURL=config.js.map