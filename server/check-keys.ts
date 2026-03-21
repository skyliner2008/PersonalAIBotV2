import { initDb, getDb } from './src/database/db.js'; initDb().then(() => { const rows = getDb().prepare('SELECT key, value FROM settings').all(); console.log(rows); });
