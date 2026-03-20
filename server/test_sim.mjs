import sqlite3 from 'sqlite3';
const db = new sqlite3.Database('../data/fb-agent.db');

function sanitizeAssignmentOutput(output) {
  return String(output || '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('{') && trimmed.includes('"type"')) return false;
      if (trimmed.includes('{"type":"')) return false;
      if (/"type"\s*:\s*"(thread|turn|item|response|message)\./i.test(trimmed)) return false;
      if (trimmed.startsWith('Loaded cached credentials')) return false;
      if (trimmed === 'tokens used') return false;
      if (/^[\d,]+$/.test(trimmed)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

db.all("SELECT content FROM messages WHERE conversation_id = 'swarm_task_1773816499827_12' AND role = 'assistant'", (err, rows) => {
  if (err) console.error(err);
  else {
    const text = sanitizeAssignmentOutput(rows[0].content);
    
    const codeBlockRegex = /```[\w]*\n([\s\S]*?)```/g;
    let match;
    let longestBlock = '';
    
    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match[1].length > longestBlock.length) {
        longestBlock = match[1];
      }
    }
    
    console.log("Longest Block length with OLD regex:", longestBlock.length);
    
    const newRegex = /```[^\n]*\r?\n([\s\S]*?)```/g;
    let match2;
    let longestBlock2 = '';
    while ((match2 = newRegex.exec(text)) !== null) {
      if (match2[1].length > longestBlock2.length) {
        longestBlock2 = match2[1];
      }
    }
    console.log("Longest Block length with NEW regex:", longestBlock2.length);
  }
});
