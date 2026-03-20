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
    const oldRegex = /```[\w]*\n([\s\S]*?)```/g;
    const newRegex = /```[^\n]*\r?\n([\s\S]*?)```/g;
    console.log("Sanitized match old:", oldRegex.exec(text) !== null);
    console.log("Sanitized match new:", newRegex.exec(text) !== null);
  }
});
