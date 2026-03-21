import fs from 'fs';
import path from 'path';
import sqlite3 from 'better-sqlite3';

const UPTIME_THRESHOLD_MS = 15000; // 15 seconds
const RECENT_UPGRADE_THRESHOLD_MS = 60000; // 1 minute

export function initBootGuardian() {
  const handleFatalCrash = (error: Error) => {
    try {
      if (process.uptime() * 1000 > UPTIME_THRESHOLD_MS) {
        // Crash happened after safe boot window, let it die normally
        console.error('Fatal error after boot window:', error);
        process.exit(1);
      }

      console.error('\n🚨 [BootGuardian] Fatal crash detected during server startup!');
      console.error(error);

      const historyDir = path.resolve(process.cwd(), '../data/upgrade_history');
      const latestUpgradeFile = path.join(historyDir, 'latest_upgrade.json');
      
      if (!fs.existsSync(latestUpgradeFile)) {
        console.error('[BootGuardian] No recent upgrade record found. Exiting.');
        process.exit(1);
      }

      const latestUpgradeContent = fs.readFileSync(latestUpgradeFile, 'utf-8');
      const latestUpgrade = JSON.parse(latestUpgradeContent);

      const msSinceUpgrade = Date.now() - latestUpgrade.timestamp;
      if (msSinceUpgrade > RECENT_UPGRADE_THRESHOLD_MS) {
        console.error('[BootGuardian] Latest upgrade was too long ago. Exiting.');
        process.exit(1);
      }

      console.error(`[BootGuardian] Suspect Self-Upgrade: Proposal #${latestUpgrade.id} (${latestUpgrade.filePath})`);
      console.error(`[BootGuardian] Initiating Auto-Rollback...`);

      const backupFile = path.join(historyDir, `proposal_${latestUpgrade.id}_before.txt`);
      if (!fs.existsSync(backupFile)) {
        console.error(`[BootGuardian] Backup file not found at ${backupFile}. Cannot rollback!`);
        process.exit(1);
      }

      const originalContent = fs.readFileSync(backupFile, 'utf-8');
      fs.writeFileSync(latestUpgrade.filePath, originalContent, 'utf-8');
      console.error(`[BootGuardian] ✔️ Source code restored.`);

      // Update Database Status
      const dbPath = process.env.DB_PATH || path.resolve(process.cwd(), '../data/fb-agent.db');
      if (fs.existsSync(dbPath)) {
        const db = new sqlite3(dbPath);
        db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
          .run(`\n\nAuto-Rollback Triggered: Server crashed during boot with error: ${error.message}`, latestUpgrade.id);
        db.close();
        console.error(`[BootGuardian] ✔️ Database status updated to Rejected.`);
      }

      // Delete the latest_upgrade file so we don't rollback endlessly
      fs.unlinkSync(latestUpgradeFile);

      console.error(`[BootGuardian] Rollback complete. Nodemon will now restart the server cleanly.\n`);
      process.exit(1);
    } catch (guardianError) {
      console.error('[BootGuardian] Failed to execute auto-rollback:', guardianError);
      process.exit(1);
    }
  };

  process.on('uncaughtException', handleFatalCrash);
  process.on('unhandledRejection', (reason: any) => {
    handleFatalCrash(reason instanceof Error ? reason : new Error(String(reason)));
  });

  // If the server survives the critical boot window (15 seconds), clear the footprint
  setTimeout(() => {
    try {
      const historyDir = path.resolve(process.cwd(), '../data/upgrade_history');
      const latestUpgradeFile = path.join(historyDir, 'latest_upgrade.json');
      if (fs.existsSync(latestUpgradeFile)) {
        fs.unlinkSync(latestUpgradeFile);
        console.log('[BootGuardian] 🛡️ Server stabilized. Upgrade footprint cleared.');
      }
    } catch {}
  }, UPTIME_THRESHOLD_MS + 1000);
}

// Auto-init when imported
initBootGuardian();
