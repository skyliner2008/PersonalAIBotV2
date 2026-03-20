import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('../data/fb-agent.db');
db.all("SELECT role, content FROM messages WHERE conversation_id LIKE '%openai-cli%jarvis_self_upgrade%' ORDER BY timestamp DESC LIMIT 5", (err, rows) => {
  if (err) console.error(err);
  else console.log(JSON.stringify(rows, null, 2));
});
