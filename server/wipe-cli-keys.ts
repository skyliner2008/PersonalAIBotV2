import { dbRun, dbGet } from './src/database/db.js';

['openai-cli', 'codex-cli', 'gemini-cli', 'claude-cli'].forEach(p => {
  console.log('Wiping', p);
  dbRun('DELETE FROM api_keys WHERE provider_id = ?', [p]);
  dbRun('DELETE FROM settings WHERE key = ?', ['provider_key_' + p]);
});
console.log('Done');

