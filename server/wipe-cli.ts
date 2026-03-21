import { initDb } from './src/database/db.js';
import { KeyManager } from './src/providers/keyManager.js';

(async () => {
  initDb();
  for (const p of ['openai-cli', 'codex-cli', 'gemini-cli', 'claude-cli']) {
    console.log('Deleting', p);
    await KeyManager.deleteKey(p);
  }
  console.log('Deleted cli ghost keys');
})();

