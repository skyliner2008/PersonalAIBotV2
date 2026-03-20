export declare const config: {
    port: number;
    dataDir: string;
    dbPath: string;
    cookiesDir: string;
    uploadsDir: string;
    defaultAiProvider: "gemini";
    headless: boolean;
    slowMo: number;
    minReplyDelay: number;
    maxReplyDelay: number;
    minTypingSpeed: number;
    maxTypingSpeed: number;
    rateLimit: {
        windowMs: number;
        max: number;
        message: string;
        standardHeaders: boolean;
        legacyHeaders: boolean;
    };
    encryption: {
        key: string;
        algorithm: "aes-256-gcm";
        ivLength: number;
        authTagLength: number;
    };
    security: {
        /** Refuse encrypt/decrypt when no ENCRYPTION_KEY is set (recommended for production) */
        requireEncryptionKey: boolean;
        /** Content-Security-Policy directives */
        cspEnabled: boolean;
        /** HSTS max-age in seconds (default 1 year) */
        hstsMaxAge: number;
    };
};
