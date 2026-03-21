import sqlite3 from 'better-sqlite3';

const db = sqlite3('C:/Users/MSI/PersonalAIBotV2/data/fb-agent.db');
const rows = db.prepare("SELECT id, description FROM upgrade_proposals WHERE id IN (417, 420, 422)").all();
for (const row of rows) {
  console.log(`\n\n------- ID ${row.id} -------`);
  const parts = row.description.split('Auto-Implement Failed:');
  if (parts.length > 1) {
    console.log(parts[parts.length - 1].trim());
  } else {
    // If it's too long, just print the end
    console.log(row.description.slice(-500));
  }
}
