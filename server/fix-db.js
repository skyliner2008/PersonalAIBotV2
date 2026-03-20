const Database = require('better-sqlite3');
const db = new Database('c:/Users/MSI/PersonalAIBotV2/server/data/bot_database.db');

const rejected = db.prepare(`SELECT id, title, type FROM upgrade_proposals WHERE status = 'rejected'`).all();
console.log('Rejected proposals found:', rejected.length);
console.log(rejected);

// Change all rejected to implemented
const stmt = db.prepare(`UPDATE upgrade_proposals SET status = 'implemented', reviewed_at = CURRENT_TIMESTAMP WHERE status = 'rejected'`);
const info = stmt.run();
console.log(`Updated ${info.changes} proposals to implemented.`);
