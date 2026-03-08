import { GoogleGenAI, Type } from '@google/genai';
import * as dotenv from 'dotenv';
dotenv.config();

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
    console.error('No API key');
    process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function testFunctionCall() {
    const tools = [{
        functionDeclarations: [
            {
                name: 'self_heal',
                description: 'ตรวจสอบและซ่อมแซมปัญหาที่พบอัตโนมัติ: auto-switch model, clear stuck queues. คุณต้องเรียกใช้เครื่องมือนี้เสมอผู้ใช้สั่ง "self_heal"',
                parameters: { type: Type.OBJECT, properties: {} }
            }
        ]
    }];

    const result = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: [{ role: 'user', parts: [{ text: 'เรียกใช้ self_heal เดี๋ยวนี้' }] }],
        config: {
            tools: tools,
        }
    });

    console.log('Text:', result.text);
    console.log('Function Calls:', JSON.stringify(result.functionCalls, null, 2));
}

testFunctionCall().catch(console.error);
