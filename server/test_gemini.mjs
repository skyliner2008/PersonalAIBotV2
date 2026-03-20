import { runCliCommand } from './src/terminal/cliCommandExecutor.js';
import fs from 'fs';

async function test() {
  const prompt = fs.readFileSync('test_prompt.txt', 'utf8');
  console.log('Starting gemini-cli execution...');
  try {
    const start = Date.now();
    const result = await runCliCommand('gemini.cmd', ['-p', prompt], 'gemini-cli', undefined, 'shell', 180000);
    console.log(`Finished in ${Date.now() - start}ms:`, result);
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
