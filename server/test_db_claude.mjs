import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('../data/fb-agent.db');
db.all("SELECT content FROM messages WHERE conversation_id LIKE '%claude-cli%' ORDER BY timestamp DESC LIMIT 3", (err, rows) => {
  if (err) console.error(err);
  else {
    rows.forEach((r, i) => {
      console.log(`Msg ${i}: len=${r.content.length} \n${r.content.substring(0, 200)}...`);
    });
  }
});
