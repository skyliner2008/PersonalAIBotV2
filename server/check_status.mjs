import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('../data/fb-agent.db');
db.all("SELECT id, title, status FROM upgrade_proposals WHERE id=74", (err, rows) => {
  if (err) console.error(err);
  else console.log(rows);
});
