import Database from 'better-sqlite3';
import { createLogger } from './utils/logger.js';

const log = createLogger('RevertProposals');
const db = new Database('c:/Users/MSI/PersonalAIBotV2/data/fb-agent.db');

try {
  const ids = [61, 62, 63, 64, 65, 66];
  const stmt = db.prepare("UPDATE upgrade_proposals SET status = 'approved' WHERE id = ?");
  for (const id of ids) {
    stmt.run(id);
  }
  log.info(`Reverted 6 proposals to 'approved' status.`);
} finally {
  db.close();
}
