import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('../data/fb-agent.db');
db.all("SELECT conversation_id, role, content FROM messages WHERE timestamp >= '2026-03-18 06:40:00' ORDER BY timestamp DESC LIMIT 10", (err, rows) => {
  if (err) console.error(err);
  else console.log(JSON.stringify(rows.map(r => ({ cid: r.conversation_id, r: r.role, l: r.content.length, txt: r.content.substring(0, 300) })), null, 2));
});
