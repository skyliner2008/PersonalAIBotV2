import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('../data/fb-agent.db');
db.all("SELECT content FROM messages WHERE conversation_id LIKE '%gemini-cli-agent%' OR conversation_id LIKE '%gemini-cli%' ORDER BY timestamp DESC LIMIT 5", (err, rows) => {
  if (err) console.error(err);
  else console.log(rows.map(r => r.content).join('\n---\n'));
});
