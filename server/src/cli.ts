import * as readline from 'readline';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../../.env') });

import { initDb, upsertConversation } from './database/db.js';
import { Agent } from './bot_agents/agent.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('CLI');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n👤 You: '
});

async function main() {
    logger.info('🤖 Initializing CLI Bot...');
    await initDb();

    // Use telegram bot's persona for CLI testing
    const botId = 'env-telegram';
    const chatId = 'cli_local_user';

    logger.info(`✅ System Ready. Testing with Bot ID: ${botId}`);
    logger.info('💡 Type "exit" or "quit" to stop. Type "clear" to clear console.');

    rl.prompt();

    rl.on('line', async (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }

        if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
            console.log('👋 Goodbye!');
            process.exit(0);
        }

        if (input.toLowerCase() === 'clear') {
            console.clear();
            rl.prompt();
            return;
        }

        try {
            if (!process.env.GEMINI_API_KEY) {
                throw new Error('GEMINI_API_KEY is not set in .env');
            }
            const aiAgent = new Agent(process.env.GEMINI_API_KEY);

            // We directly construct the context to skip the webhook layer
            const ctx = {
                botId,
                botName: 'CLI Local Bot',
                platform: 'telegram' as any,
                replyWithText: async (text: string) => {
                    console.log(`\n🤖 Bot:\n${text}`);
                },
                replyWithFile: async (filePath: string, caption?: string) => {
                    console.log(`\n🤖 Bot (File: ${filePath}):\n${caption || '[No caption]'}`);
                    return 'ส่งสำเร็จ';
                }
            };

            // Call internal agent logic
            logger.info('⏳ Thinking...');
            upsertConversation(chatId, 'local', 'CLI User');
            const response = await aiAgent.processMessage(chatId, input, ctx);

            console.log(`\n🤖 Bot:\n${response}`);
            rl.prompt();

        } catch (err: any) {
            logger.error(`❌ Error: ${err.message}`);
            rl.prompt();
        }
    });
}

main().catch(logger.error);
