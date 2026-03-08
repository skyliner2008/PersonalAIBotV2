import { GoogleGenAI } from '@google/genai';
import * as dotenv from 'dotenv';
dotenv.config();
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
async function listModels() {
    try {
        const result = await genAI.models.list();
        console.log("Response:", JSON.stringify(result, null, 2));
    }
    catch (err) {
        console.error("Error listing models:", err);
    }
}
listModels();
//# sourceMappingURL=check_models.js.map