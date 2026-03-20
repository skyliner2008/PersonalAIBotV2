const sqlite3 = require('sqlite3');
const fs = require('fs');
const db = new sqlite3.Database('../data/fb-agent.db');

db.all("SELECT * FROM messages ORDER BY timestamp DESC LIMIT 500", (err, rows) => {
  if (err) return console.error(err);
  for (let r of rows) {
    if (r.content && r.content.includes("router.get('/topology'")) {
       console.log('FOUND TOPOLOGY IN MESSAGES');
       fs.writeFileSync('systemRouter.bak.ts', r.content);
       process.exit(0);
    }
    // sometimes it's saved as tool call response
    if (r.tool_calls && r.tool_calls.includes("router.get('/topology'")) {
       console.log('FOUND TOPOLOGY IN TOOL CALLS');
       fs.writeFileSync('systemRouter.bak.ts', r.tool_calls);
       process.exit(0);
    }
  }
  console.log('NOT FOUND in messages. Trying local files...');
  
  // Also check if any old git objects or something exist?
  // Let's just create the route from scratch if none exists.
});
