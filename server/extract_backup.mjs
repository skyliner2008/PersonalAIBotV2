import sqlite3 from 'sqlite3';
import fs from 'fs';
const db = new sqlite3.Database('../data/fb-agent.db');
db.all("SELECT content FROM messages WHERE content LIKE '%setupSocketHandlers%' LIMIT 1", (err, rows) => {
  if (err) console.error(err);
  else if (rows.length > 0) {
    const content = rows[0].content;
    const startIdx = content.indexOf('```typescript\n') + 14;
    const endIdx = content.indexOf('```', startIdx);
    if (startIdx > 13 && endIdx !== -1) {
        let code = content.substring(startIdx, endIdx).trim();
        // remove BOM if present
        if (code.charCodeAt(0) === 0xFEFF) {
            code = code.substring(1);
        }
        // write to socketHandlers.ts
        fs.writeFileSync('src/api/socketHandlers.ts', code);
        console.log("Successfully restored socketHandlers.ts from DB backup!");
    } else {
        console.log("Could not find code boundaries.");
    }
  } else {
    console.log("Not found");
  }
});
