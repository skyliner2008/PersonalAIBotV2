import { initDb, getDb } from './src/database/db.js';

initDb().then(() => {
  const db = getDb();
  
  // Delete all API provider keys from the database
  const count1 = db.prepare("DELETE FROM settings WHERE key LIKE 'provider_key_%'").run().changes;
  const count2 = db.prepare("DELETE FROM settings WHERE key LIKE 'ai_%_key'").run().changes;
  
  console.log(`Database keys completely wiped! Removed ${count1 + count2} API key records.`);
});
