import { initDb, getDb } from './src/database/db.js';
import fs from 'fs';

async function main() {
    await initDb();
    const db = getDb();

    const stmtSettings = db.prepare("SELECT * FROM settings WHERE key LIKE 'ai_%'");
    const settings = [];
    while (stmtSettings.step()) settings.push(stmtSettings.getAsObject());
    stmtSettings.free();

    const stmtLogs = db.prepare("SELECT id, type, action, details FROM activity_logs ORDER BY id DESC LIMIT 10");
    const logs = [];
    while (stmtLogs.step()) logs.push(stmtLogs.getAsObject());
    stmtLogs.free();

    fs.writeFileSync('output2.json', JSON.stringify({ settings, logs }, null, 2), 'utf-8');
    console.log('Saved to output2.json');
}
main();
