import { getDb, initDb } from './database/db.js';

try {
  initDb();
  const db = getDb();
  const info = db.prepare("UPDATE upgrade_proposals SET status = 'rejected' WHERE status IN ('pending', 'approved', 'implementing')").run();
  console.log('Cleared proposals:', info.changes);
} catch (e: any) {
  console.error('Error clearing proposals:', e.message);
}
