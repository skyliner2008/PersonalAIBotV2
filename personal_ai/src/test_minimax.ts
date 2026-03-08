import axios from 'axios';
import * as dotenv from 'dotenv';
dotenv.config();

async function testMiniMaxModels() {
  const apiKey = process.env.MINIMAX_API_KEY;
  const urls = [
    'https://api.minimax.io/v1/models',
    'https://api.minimaxi.com/v1/models',
    'https://api.minimax.chat/v1/models'
  ];

  for (const url of urls) {
    try {
      console.log(`Testing URL: ${url}...`);
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`
        }
      });
      console.log(`✅ Success for ${url}:`, JSON.stringify(response.data).substring(0, 200));
    } catch (err: any) {
      console.log(`❌ Failed for ${url}: ${err.response?.status} ${err.response?.statusText || err.message}`);
    }
  }
}

testMiniMaxModels();
