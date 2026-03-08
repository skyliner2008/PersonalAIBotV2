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
  defaultAiProvider: 'openai' as const,

  // Playwright
  headless: process.env.HEADLESS === 'true', // default false (show browser), set HEADLESS=true to hide
  slowMo: parseInt(process.env.SLOW_MO || '0'),

  // Anti-detection
  minReplyDelay: 3000,   // min ms before replying
  maxReplyDelay: 15000,  // max ms
  minTypingSpeed: 30,    // ms per character (typing indicator)
  maxTypingSpeed: 80,
};
