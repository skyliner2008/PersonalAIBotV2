import sqlite3 from 'better-sqlite3';

const db = sqlite3('C:/Users/MSI/PersonalAIBotV2/data/fb-agent.db');
const row = db.prepare("SELECT * FROM upgrade_proposals WHERE id = 422").get();
console.log(row);
