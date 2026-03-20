import cron from 'node-cron';
import { addLog, dbAll, dbRun, cleanupOldLogs, cleanupOldProcessedMessages } from '../database/db.js';
import { processPendingPosts } from '../automation/postManager.js';
import { createLogger } from '../utils/logger.js';
const logger = createLogger('scheduler');
let postCheckJob = null;
let maintenanceJob = null;
const cronJobs = new Map();
/**
 * Start the main scheduler.
 */
export function startScheduler(io) {
    // Check for pending posts every minute
    postCheckJob = cron.schedule('* * * * *', async () => {
        try {
            await processPendingPosts(io);
        }
        catch (e) {
            addLog('scheduler', 'Post check error', String(e), 'error');
        }
    });
    // --- Daily maintenance job (every day at 3:00 AM) ---
    maintenanceJob = cron.schedule('0 3 * * *', () => {
        try {
            // 1. Clean up old logs (>30 days)
            const logsCleaned = cleanupOldLogs(30);
            // 2. Clean up old processed message IDs (>7 days)
            const dedupCleaned = cleanupOldProcessedMessages(7);
            // 3. Clean up old episodes (>90 days, keep recent for active chats)
            let episodesCleaned = 0;
            try {
                const result = dbRun(`DELETE FROM episodes WHERE timestamp < datetime('now', '-90 days')
           AND chat_id NOT IN (SELECT DISTINCT chat_id FROM episodes WHERE timestamp > datetime('now', '-7 days'))`, []);
                // Note: dbRun doesn't return changes count, so we log success
                episodesCleaned = -1; // indicate it ran
            }
            catch (e) {
                console.debug('[Scheduler] cleanup episodes:', String(e));
            }
            // 4. Clean up old messages (>60 days, except active conversations)
            try {
                dbRun(`DELETE FROM messages WHERE timestamp < datetime('now', '-60 days')
           AND conversation_id NOT IN (SELECT DISTINCT conversation_id FROM messages WHERE timestamp > datetime('now', '-7 days'))`, []);
            }
            catch (e) {
                console.debug('[Scheduler] cleanup messages:', String(e));
            }
            // 5. SQLite VACUUM (optimize storage)
            try {
                const { getDb: getDatabase } = require('../database/db.js');
                getDatabase().pragma('wal_checkpoint(TRUNCATE)');
            }
            catch (e) {
                console.debug('[Scheduler] vacuum db:', String(e));
            }
            logger.info(`Daily maintenance: logs=${logsCleaned} dedup=${dedupCleaned} episodes=${episodesCleaned}`);
            addLog('scheduler', 'Daily maintenance complete', `Logs: ${logsCleaned}, Dedup: ${dedupCleaned}`, 'info');
        }
        catch (e) {
            addLog('scheduler', 'Maintenance error', String(e), 'error');
        }
    });
    // Register recurring post schedules
    refreshCronJobs(io);
    addLog('scheduler', 'Scheduler started', 'Post check + daily maintenance', 'success');
    io.emit('scheduler:status', { active: true });
}
/**
 * Refresh cron jobs from database (for recurring posts).
 */
export function refreshCronJobs(io) {
    // Clear existing
    for (const [id, job] of cronJobs) {
        job.stop();
    }
    cronJobs.clear();
    // Load recurring posts
    const recurring = dbAll(`SELECT * FROM scheduled_posts WHERE cron_expression IS NOT NULL AND status != 'posted'`);
    for (const post of recurring) {
        if (!cron.validate(post.cron_expression)) {
            addLog('scheduler', `Invalid cron: ${post.cron_expression}`, `Post ${post.id}`, 'warning');
            continue;
        }
        const job = cron.schedule(post.cron_expression, async () => {
            try {
                // Reset status to pending for re-generation
                dbRun('UPDATE scheduled_posts SET status = ?, scheduled_at = datetime("now") WHERE id = ?', ['pending', post.id]);
                await processPendingPosts(io);
            }
            catch (e) {
                addLog('scheduler', 'Recurring post error', String(e), 'error');
            }
        });
        cronJobs.set(String(post.id), job);
        addLog('scheduler', `Cron job registered`, `Post ${post.id}: ${post.cron_expression}`, 'info');
    }
}
export function stopScheduler() {
    if (postCheckJob) {
        postCheckJob.stop();
        postCheckJob = null;
    }
    if (maintenanceJob) {
        maintenanceJob.stop();
        maintenanceJob = null;
    }
    for (const [, job] of cronJobs) {
        job.stop();
    }
    cronJobs.clear();
    addLog('scheduler', 'Scheduler stopped', undefined, 'info');
}
//# sourceMappingURL=scheduler.js.map