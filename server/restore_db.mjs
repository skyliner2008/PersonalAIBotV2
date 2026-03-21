import sqlite3 from 'better-sqlite3';

const db = sqlite3('C:/Users/MSI/PersonalAIBotV2/data/fb-agent.db');
const result = db.prepare("UPDATE upgrade_proposals SET status = 'rejected' WHERE status = 'failed'").run();
console.log(`Restored ${result.changes} hidden proposals back to Rejected status.`);
