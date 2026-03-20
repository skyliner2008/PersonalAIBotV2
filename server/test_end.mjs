import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('../data/fb-agent.db');
db.all("SELECT content FROM messages WHERE conversation_id = 'swarm_task_1773816499827_12' AND role = 'assistant'", (err, rows) => {
  if (err) console.error(err);
  else {
    const text = rows[0].content;
    console.log("Last 100 chars:", text.substring(text.length - 100));
  }
});
