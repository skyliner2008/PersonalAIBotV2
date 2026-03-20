import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('../data/swarm.db');
db.all("SELECT id, result, status FROM tasks WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 5", (err, rows) => {
  if (err) console.error(err);
  else {
    console.log(JSON.stringify(rows.map(r => ({ 
      id: r.id, 
      status: r.status, 
      resultLength: r.result ? r.result.length : 0,
      matchOld: /```[\w]*\n([\s\S]*?)```/g.test(r.result || ''),
      matchNew: /```[^\n]*\r?\n([\s\S]*?)```/g.test(r.result || ''),
      preview: r.result ? r.result.substring(0, 100) : ''
    })), null, 2));
  }
});
