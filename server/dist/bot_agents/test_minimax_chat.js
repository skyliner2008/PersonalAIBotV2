import OpenAI from 'openai';
import * as dotenv from 'dotenv';
dotenv.config();
async function testMiniMaxChat() {
    const apiKey = process.env.MINIMAX_API_KEY;
    const client = new OpenAI({
        apiKey,
        baseURL: 'https://api.minimax.io/v1'
    });
    try {
        console.log("Testing Chat Completion...");
        const response = await client.chat.completions.create({
            model: 'MiniMax-M2.5',
            messages: [{ role: 'user', content: 'Hello' }]
        });
        console.log("✅ Chat Success:", response.choices[0].message.content);
    }
    catch (err) {
        console.log("❌ Chat Failed:", err.message);
    }
    try {
        console.log("Testing List Models...");
        const models = await client.models.list();
        console.log("✅ List Success:", models.data.map(m => m.id));
    }
    catch (err) {
        console.log("❌ List Failed:", err.status, err.message);
    }
}
testMiniMaxChat();
//# sourceMappingURL=test_minimax_chat.js.map