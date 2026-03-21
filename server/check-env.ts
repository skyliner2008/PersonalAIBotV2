import dotenv from 'dotenv'; dotenv.config(); console.log('.env OPENAI: ...' + (process.env.OPENAI_API_KEY || '').slice(-8));
