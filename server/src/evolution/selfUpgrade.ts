// ============================================================
// Self-Upgrade System — ระบบอัพเกรดตัวเองอัตโนมัติ
// ============================================================
// เมื่อ Jarvis ว่างงาน 30+ นาที จะเริ่ม:
// 1. อ่าน/ศึกษา codebase ทีละไฟล์
// 2. บันทึกความรู้ลง DB
// 3. หาบัค หาจุดบกพร่อง
// 4. เสนอแผนอัพเกรด (ช่วงทดสอบ: เสนอเท่านั้น ไม่ลงมือทำ)
// 5. ใช้ dynamic model switching ตาม task

import { getDb, addLog, trackUpgradeTokens, getSetting } from '../database/db.js';
import { createLogger } from '../utils/logger.js';
import { logEvolution, addLearning } from './learningJournal.js';
import { aiChat } from '../ai/aiRouter.js';
import { getSwarmCoordinator } from '../swarm/swarmCoordinator.js';
import { getRootAdminIdentity } from '../system/rootAdmin.js';
import { exec, execFileSync } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';
import util from 'util';
import fs from 'fs';
import path from 'path';
import { safeJsonParse } from '../utils/jsonUtils.js';

const execPromise = util.promisify(exec);

const log = createLogger('SelfUpgrade');

// ── Configuration ──
let IDLE_THRESHOLD_MS = 5 * 60 * 1000;      // 5 นาที (อิงจากการโต้ตอบแชท)
let CHECK_INTERVAL_MS = 5 * 60 * 1000;      // ตรวจทุก 5 นาที (default)
const SCAN_BATCH_SIZE = 3;                      // อ่านทีละ 3 ไฟล์
const MAX_FILE_SIZE_BYTES = 100 * 1024;         // ข้ามไฟล์ > 100KB
const ANALYSIS_DELAY_MS = 2000;                 // delay ระหว่างไฟล์
const MAX_LLM_CALLS_PER_CYCLE = 5;              // จำกัด LLM call ต่อรอบ
const DRY_RUN = true;                           // ช่วงทดสอบ: เสนอเท่านั้น

// ── Upgrade Lock File — ป้องกัน tsx watch restart ระหว่าง upgrade ──
const UPGRADE_LOCK_PATH = path.resolve(process.cwd(), '../data/upgrade_in_progress.lock');

function acquireUpgradeLock(proposalId: number): void {
  try {
    const lockDir = path.dirname(UPGRADE_LOCK_PATH);
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(UPGRADE_LOCK_PATH, JSON.stringify({ proposalId, pid: process.pid, startedAt: Date.now() }), 'utf-8');
  } catch {}
}

function releaseUpgradeLock(): void {
  try { if (fs.existsSync(UPGRADE_LOCK_PATH)) fs.unlinkSync(UPGRADE_LOCK_PATH); } catch {}
}

export function isUpgradeLockActive(): boolean {
  try {
    if (!fs.existsSync(UPGRADE_LOCK_PATH)) return false;
    const lock = JSON.parse(fs.readFileSync(UPGRADE_LOCK_PATH, 'utf-8'));
    // Lock expires after 12 minutes (longest possible timeout + buffer)
    if (Date.now() - lock.startedAt > 720000) {
      releaseUpgradeLock();
      return false;
    }
    return true;
  } catch { return false; }
}

// ── State ──
let lastUserActivity = Date.now();
let isUpgrading = false;
let upgradeInterval: NodeJS.Timeout | null = null;
let _continuousScanTimeout: NodeJS.Timeout | null = null;
export let _isManualScanActive = false; // Expose manual scan state
let _paused = false;
let _scanCursor = 0;     // ตำแหน่งที่สแกนถึง
let _fileIndex: string[] = [];
let _initialized = false;
export async function resumeBatchImplementation(rootDir: string): Promise<void> {
  const dbModule = await import('../database/db.js');
  const db = dbModule.getDb();

  // Get total approved tasks to show progress
  const totalApproved = db.prepare(`SELECT COUNT(*) as count FROM upgrade_proposals WHERE status = 'approved'`).get() as { count: number };
  let currentTaskNumber = 1;
  const initialApprovedCount = totalApproved ? totalApproved.count : 0;
  let successCount = 0;
  let rejectCount = 0;
  let skipCount = 0;
  let consecutiveQuotaErrors = 0;
  const MAX_CONSECUTIVE_QUOTA_ERRORS = 3;
  const batchStart = Date.now();

  if (initialApprovedCount > 0) {
    console.log(`\n\x1b[36m╔══════════════════════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[36m║  Self-Upgrade Batch: ${initialApprovedCount} approved proposals queued          ║\x1b[0m`);
    console.log(`\x1b[36m╚══════════════════════════════════════════════════════════╝\x1b[0m`);
  }

  while (dbModule.getSetting('upgrade_implement_all') === 'true') {
    const nextProposal = db.prepare(`
      SELECT id, title FROM upgrade_proposals
      WHERE status = 'approved'
      ORDER BY CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC, created_at ASC
      LIMIT 1
    `).get() as { id: number; title: string } | undefined;

    if (!nextProposal) {
      dbModule.setSetting('upgrade_implement_all', 'false');
      break;
    }

    const remaining = initialApprovedCount - currentTaskNumber + 1;
    console.log(`\n\x1b[36m┌─ [${currentTaskNumber}/${initialApprovedCount}] Proposal #${nextProposal.id}\x1b[0m`);
    updateProposalStatus(nextProposal.id, 'implementing');

    try {
      const success = await implementProposalById(nextProposal.id, rootDir);
      if (success) {
        successCount++;
        consecutiveQuotaErrors = 0; // Reset on success
      } else {
        rejectCount++;
      }
      currentTaskNumber++;
    } catch (err: any) {
      const errMsg = err.message || '';
      const isQuotaError = /429|RESOURCE_EXHAUSTED|quota|rate.limit/i.test(errMsg);

      if (isQuotaError) {
        consecutiveQuotaErrors++;
        // On quota error, reset proposal back to approved so it can be retried later
        try {
          db.prepare(`UPDATE upgrade_proposals SET status = 'approved' WHERE id = ?`).run(nextProposal.id);
        } catch { /* best effort */ }

        if (consecutiveQuotaErrors >= MAX_CONSECUTIVE_QUOTA_ERRORS) {
          console.log(`\x1b[33m  └─ ⚠️ API quota exhausted (${consecutiveQuotaErrors} consecutive 429 errors). Pausing batch for 10 minutes...\x1b[0m`);
          await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000)); // Wait 10 minutes
          consecutiveQuotaErrors = 0; // Reset after waiting
          continue; // Retry without incrementing counter
        } else {
          console.log(`\x1b[33m  └─ ⚠️ API quota error (${consecutiveQuotaErrors}/${MAX_CONSECUTIVE_QUOTA_ERRORS}). Waiting 60s before retry...\x1b[0m`);
          await new Promise(resolve => setTimeout(resolve, 60 * 1000));
          continue; // Retry without incrementing counter
        }
      }

      // Non-quota error: reject the proposal so it doesn't loop forever
      consecutiveQuotaErrors = 0;
      try {
        db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
          .run(`\n\nAuto-Implement Failed (uncaught): ${errMsg.substring(0, 300) || 'Unknown error'}`, nextProposal.id);
      } catch { /* best effort */ }
      console.log(`\x1b[31m  └─ ❌ Uncaught Error — ${errMsg.substring(0, 100)}\x1b[0m`);
      rejectCount++;
      currentTaskNumber++;
    }
  }

  // ── Batch Summary ──
  if (initialApprovedCount > 0) {
    const totalTime = ((Date.now() - batchStart) / 1000).toFixed(1);
    const processed = successCount + rejectCount + skipCount;
    console.log(`\n\x1b[36m╔══════════════════════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[36m║  Batch Complete                                          ║\x1b[0m`);
    console.log(`\x1b[36m║  ✅ Implemented: ${String(successCount).padEnd(4)} │ ❌ Rejected: ${String(rejectCount).padEnd(4)} │ Total: ${String(processed).padEnd(4)}║\x1b[0m`);
    console.log(`\x1b[36m║  ⏱️  Duration: ${totalTime}s${' '.repeat(Math.max(0, 42 - totalTime.length))}║\x1b[0m`);
    console.log(`\x1b[36m╚══════════════════════════════════════════════════════════╝\x1b[0m`);
  }
}

let _currentRootDir = '';

// ── Proposal Types ──
export type ProposalType = 'bug' | 'feature' | 'optimization' | 'refactor' | 'tool' | 'security';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'implemented' | 'implementing';
export type ProposalPriority = 'low' | 'medium' | 'high' | 'critical';

export interface UpgradeProposal {
  id?: number;
  type: ProposalType;
  title: string;
  description: string;
  file_path: string;
  line_range?: string;      // e.g. "42-58"
  suggested_fix?: string;
  affected_files?: string;  // JSON array of related files that must also be changed
  impact_analysis?: string; // AI-generated analysis of cross-file dependencies
  priority: ProposalPriority;
  status: ProposalStatus;
  model_used: string;
  confidence: number;       // 0.0 - 1.0
  created_at?: string;
  reviewed_at?: string;
}

// ── DB Table Init ──
export function ensureUpgradeTable(): void {
  try {
    const db = getDb();
    const checkStmt = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='upgrade_proposals'`).get() as { sql: string } | undefined;
    
    // Auto-migrate if the table exists but has the old restrictive CHECK constraint
    if (checkStmt && !checkStmt.sql.includes("'implementing'")) {
      log.info('Migrating upgrade_proposals table to remove CHECK constraint...');
      db.exec(`DROP TABLE IF EXISTS upgrade_proposals_new`); // Clean up from any previous failed migration

      // Detect current columns so SELECT matches exactly
      const currentCols = (db.prepare(`PRAGMA table_info(upgrade_proposals)`).all() as { name: string }[]).map(c => c.name);
      const colList = currentCols.join(', ');

      // New table always has the full 15-column schema
      db.exec(`
        CREATE TABLE upgrade_proposals_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          file_path TEXT NOT NULL,
          line_range TEXT,
          suggested_fix TEXT,
          priority TEXT DEFAULT 'medium',
          status TEXT DEFAULT 'pending',
          model_used TEXT DEFAULT 'local-analysis',
          confidence REAL DEFAULT 0.5,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          reviewed_at DATETIME,
          affected_files TEXT DEFAULT NULL,
          impact_analysis TEXT DEFAULT NULL
        );
      `);
      // Copy only the columns that exist in the old table
      db.exec(`INSERT INTO upgrade_proposals_new (${colList}) SELECT ${colList} FROM upgrade_proposals`);
      db.exec(`DROP TABLE upgrade_proposals`);
      db.exec(`ALTER TABLE upgrade_proposals_new RENAME TO upgrade_proposals`);
      log.info('Migration complete: upgrade_proposals now has flexible status + new columns');
    } else if (!checkStmt) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS upgrade_proposals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          file_path TEXT NOT NULL,
          line_range TEXT,
          suggested_fix TEXT,
          priority TEXT DEFAULT 'medium',
          status TEXT DEFAULT 'pending',
          model_used TEXT DEFAULT 'local-analysis',
          confidence REAL DEFAULT 0.5,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          reviewed_at DATETIME
        );
        CREATE INDEX IF NOT EXISTS idx_upgrade_status ON upgrade_proposals(status, priority);
        CREATE INDEX IF NOT EXISTS idx_upgrade_type ON upgrade_proposals(type);
        CREATE INDEX IF NOT EXISTS idx_upgrade_file ON upgrade_proposals(file_path);
      `);
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS upgrade_scan_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        file_hash TEXT,
        findings_count INTEGER DEFAULT 0,
        scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_scan_file ON upgrade_scan_log(file_path);
    `);
    
    // Auto-migrate: Add affected_files and impact_analysis columns if not exist
    try {
      const tableInfo = db.prepare(`PRAGMA table_info(upgrade_proposals)`).all() as { name: string }[];
      const colNames = new Set(tableInfo.map(c => c.name));
      if (!colNames.has('affected_files')) {
        db.exec(`ALTER TABLE upgrade_proposals ADD COLUMN affected_files TEXT DEFAULT NULL`);
        log.info('Migrated: added affected_files column');
      }
      if (!colNames.has('impact_analysis')) {
        db.exec(`ALTER TABLE upgrade_proposals ADD COLUMN impact_analysis TEXT DEFAULT NULL`);
        log.info('Migrated: added impact_analysis column');
      }
    } catch (migErr: any) {
      log.debug('Column migration skipped (may already exist)', { error: migErr.message });
    }

    // Auto-recovery: If the server crashed while 'implementing', count retries.
    // BUT: if upgrade lock is active, another process is still working — don't touch anything.
    if (isUpgradeLockActive()) {
      log.info('Upgrade lock is active — skipping stuck proposal recovery (another process is still working)');
    }
    const stuckProposals = isUpgradeLockActive() ? [] : db.prepare("SELECT id, description FROM upgrade_proposals WHERE status = 'implementing'").all() as { id: number; description: string }[];
    let resetCount = 0;
    let rejectCount = 0;
    for (const stuck of stuckProposals) {
      const retryMarkers = (stuck.description?.match(/\[Retry #\d+\]/g) || []).length;
      if (retryMarkers >= 2) {
        // Too many retries — permanently reject
        db.prepare("UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?")
          .run(`\n\n[Auto-Rejected]: Stuck in 'implementing' after ${retryMarkers + 1} attempts. Likely un-implementable.`, stuck.id);
        rejectCount++;
      } else {
        // Allow retry but mark it
        db.prepare("UPDATE upgrade_proposals SET status = 'approved', description = description || ? WHERE id = ?")
          .run(`\n[Retry #${retryMarkers + 1}]: Reset from 'implementing' after server restart.`, stuck.id);
        resetCount++;
      }
    }
    if (resetCount > 0) log.info(`Recovered ${resetCount} stuck proposals from 'implementing' back to 'approved'`);
    if (rejectCount > 0) log.warn(`Auto-rejected ${rejectCount} proposals that were stuck in 'implementing' after 3+ attempts`);

    log.info('Upgrade tables ensured');
  } catch (err: any) {
    log.error('Failed to create upgrade tables', { error: err.message });
  }
}

// ── Activity Tracking ──
/** Call this when user sends a message or interacts */
export function notifyUserActivity(): void {
  lastUserActivity = Date.now();
  if (isUpgrading) {
    log.info('User activity detected — self-upgrade will yield at next checkpoint');
  }
}

const _filename = fileURLToPath(import.meta.url);
const _dirname = path.dirname(_filename);

/** Get actual OS idle time if on Windows, else fallback to API activity */
function getOsIdleTimeMs(): number {
  // Override: Completely ignore OS mouse/keyboard idle. 
  // We only care about Bot Chat idle time.
  return Date.now() - lastUserActivity;
}

/** Check if system has been idle long enough */
function isSystemIdle(): boolean {
  return getOsIdleTimeMs() >= IDLE_THRESHOLD_MS;
}

// ── File Index Builder ──
async function buildFileIndex(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', '.next',
    'coverage', '.turbo', '.cache', '__pycache__',
    '__tests__', 'test', 'tests', 'specs',          // ← ข้าม test directories เพราะแก้ test มัก fail
    'docs', 'logs',                                   // ← ข้าม documentation & logs
  ]);
  const SCAN_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx',                    // ← เฉพาะ source code เท่านั้น
  ]);
  // ข้ามไฟล์ที่ไม่ใช่ production source code
  const SKIP_FILE_PATTERNS = [
    /\.test\.\w+$/,           // *.test.ts, *.test.js
    /\.spec\.\w+$/,           // *.spec.ts
    /REFACTORING/i,           // REFACTORING_NOTES.md etc.
    /README/i,
    /CHANGELOG/i,
    /\.d\.ts$/,               // TypeScript declaration files
    /revert_proposals/i,      // utility scripts
    /test_upgrade/i,          // utility scripts
    /\.example$/,             // example files
  ];
  
  // 🛡️ Immortal Core Sandbox (Self-Preservation)
  // These files are the heart of the backend. They are strictly invisible to the scanner 
  // and immune to Auto-Upgrades so the AI cannot accidentally break the Node server permanently.
  const PROTECTED_CORE_FILES = new Set([
    'index.ts',
    'config.ts',
    'configValidator.ts',
    'queue.js',
    'database/db.ts',
    'database/db.js',
    'evolution/selfUpgrade.ts',
    'evolution/selfReflection.ts',
    'terminal/terminalGateway.ts',
    'api/socketHandlers.ts',
    'api/upgradeRoutes.ts',
    'automation/chatBot.ts',
    'automation/browser.ts',
    'bot_agents/tools/index.ts',
    'bot_agents/agent.ts',
  ]);

  function walk(dir: string): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (SCAN_EXTENSIONS.has(ext)) {
            // Check file name patterns to skip
            if (SKIP_FILE_PATTERNS.some(pat => pat.test(entry.name) || pat.test(fullPath))) {
              continue;
            }
            // Check Immortal Core Sandbox Blacklist
            const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, '/');
            if (PROTECTED_CORE_FILES.has(relativePath)) {
              continue;
            }
            
            try {
              const stat = fs.statSync(fullPath);
              if (stat.size <= MAX_FILE_SIZE_BYTES) {
                files.push(fullPath);
              }
            } catch { /* skip unreadable */ }
          }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  walk(rootDir);
  return files;
}

// ── Code Analysis (Local — no LLM needed) ──

interface Finding {
  type: ProposalType;
  title: string;
  description: string;
  line: number;
  priority: ProposalPriority;
  confidence: number;
}

function analyzeFileContent(filePath: string, content: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split('\n');
  const ext = path.extname(filePath).toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // ── Bug Detection ──

    // 1. Catch blocks that swallow errors silently
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(line) ||
        (trimmed === '} catch {' && i + 1 < lines.length && lines[i + 1].trim() === '}')) {
      findings.push({
        type: 'bug',
        title: 'Empty catch block swallows errors',
        description: `Empty catch block at line ${lineNum} — errors are silently swallowed. At minimum, log the error.`,
        line: lineNum,
        priority: 'medium',
        confidence: 0.85,
      });
    }

    // 2. console.log left in production code (not in test files)
    if (!filePath.includes('test') && !filePath.includes('spec') &&
        /^\s*console\.log\(/.test(line) && !filePath.includes('logger')) {
      findings.push({
        type: 'optimization',
        title: 'console.log in production code',
        description: `console.log at line ${lineNum} should use createLogger() instead for proper log levels.`,
        line: lineNum,
        priority: 'low',
        confidence: 0.7,
      });
    }

    // 3. TODO/FIXME/HACK/XXX comments
    const todoMatch = trimmed.match(/\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\s*:?\s*(.*)/i);
    if (todoMatch) {
      const tag = todoMatch[1].toUpperCase();
      const desc = todoMatch[2] || 'no description';
      findings.push({
        type: tag === 'BUG' || tag === 'FIXME' ? 'bug' : 'optimization',
        title: `${tag} comment found`,
        description: `${tag}: ${desc} (line ${lineNum})`,
        line: lineNum,
        priority: tag === 'BUG' || tag === 'FIXME' ? 'medium' : 'low',
        confidence: 0.6,
      });
    }

    // 4. Hardcoded secrets / API keys
    if (/(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}['"]/i.test(line) &&
        !filePath.includes('.example') && !filePath.includes('schema') &&
        !filePath.includes('test')) {
      findings.push({
        type: 'security',
        title: 'Possible hardcoded secret',
        description: `Potential hardcoded credential at line ${lineNum}. Should use environment variables.`,
        line: lineNum,
        priority: 'high',
        confidence: 0.75,
      });
    }

    // 5. TypeScript `any` type abuse
    if (ext === '.ts' || ext === '.tsx') {
      const anyCount = (line.match(/:\s*any\b/g) || []).length;
      if (anyCount >= 2) {
        findings.push({
          type: 'refactor',
          title: 'Multiple `any` types on single line',
          description: `Line ${lineNum} uses 'any' type ${anyCount} times — consider proper typing.`,
          line: lineNum,
          priority: 'low',
          confidence: 0.65,
        });
      }
    }

    // 6. Very long functions (heuristic: 80+ lines without another function/class)
    if (/^(export\s+)?(async\s+)?function\s+\w+/.test(trimmed) || /^\w+\s*=\s*(async\s+)?\(/.test(trimmed)) {
      let fnEnd = i;
      let braceCount = 0;
      for (let j = i; j < lines.length; j++) {
        braceCount += (lines[j].match(/{/g) || []).length;
        braceCount -= (lines[j].match(/}/g) || []).length;
        if (braceCount <= 0 && j > i) { fnEnd = j; break; }
      }
      const fnLength = fnEnd - i;
      if (fnLength > 80) {
        findings.push({
          type: 'refactor',
          title: 'Function too long',
          description: `Function starting at line ${lineNum} is ${fnLength} lines long. Consider breaking it into smaller functions.`,
          line: lineNum,
          priority: 'low',
          confidence: 0.6,
        });
      }
    }

    // 7. Potential memory leak: setInterval without cleanup
    if (/setInterval\s*\(/.test(line) && !content.includes('clearInterval')) {
      findings.push({
        type: 'bug',
        title: 'setInterval without clearInterval',
        description: `setInterval at line ${lineNum} — no corresponding clearInterval found. Potential memory leak.`,
        line: lineNum,
        priority: 'medium',
        confidence: 0.55,
      });
    }

    // 8. SQL injection risk (string concatenation in SQL)
    if (/(?:prepare|query|exec)\s*\(\s*`[^`]*\$\{/.test(line) && ext === '.ts') {
      findings.push({
        type: 'security',
        title: 'Potential SQL injection via template literal',
        description: `Line ${lineNum} uses template literals in SQL query — use parameterized queries instead.`,
        line: lineNum,
        priority: 'high',
        confidence: 0.7,
      });
    }
  }

  // ── File-Level Analysis ──

  // Missing error handling in async functions
  if ((ext === '.ts' || ext === '.tsx') && content.includes('async ')) {
    const asyncFns = content.match(/async\s+function\s+\w+/g) || [];
    const tryCatchCount = (content.match(/try\s*{/g) || []).length;
    if (asyncFns.length > 3 && tryCatchCount < asyncFns.length / 2) {
      findings.push({
        type: 'bug',
        title: 'Many async functions with few try-catch blocks',
        description: `${asyncFns.length} async functions but only ${tryCatchCount} try-catch blocks. Some errors may be unhandled.`,
        line: 1,
        priority: 'medium',
        confidence: 0.5,
      });
    }
  }

  return findings;
}

// ── Proposal Management ──

export function insertProposal(proposal: Omit<UpgradeProposal, 'id' | 'created_at' | 'reviewed_at'>): { id: number, isNew: boolean } {
  try {
    const db = getDb();
    // Normalize path to forward slashes for cross-OS consistency
    const normalizedPath = proposal.file_path.replace(/\\/g, '/');

    // 🛡️ Filter: Reject proposals targeting non-implementable files
    const NON_SOURCE_PATTERNS = [/\.md$/i, /\.txt$/i, /\.json$/i, /\.css$/i, /\.html$/i, /REFACTORING/i, /README/i, /CHANGELOG/i, /N\/A/i, /multiple_files/i];
    if (NON_SOURCE_PATTERNS.some(pat => pat.test(normalizedPath))) {
      log.debug(`Skipped proposal for non-source file: ${normalizedPath}`);
      return { id: 0, isNew: false };
    }

    // 🛡️ Filter: Require higher confidence for non-bug proposals (optimization/refactor are risky)
    const minConfidence = (proposal.type === 'bug' || proposal.type === 'security') ? 0.7 : 0.85;
    if ((proposal.confidence || 0) < minConfidence) {
      log.debug(`Skipped low-confidence ${proposal.type} proposal (${proposal.confidence} < ${minConfidence}): ${proposal.title}`);
      return { id: 0, isNew: false };
    }

    // 🛡️ Filter: Reject vague proposals by title pattern
    const VAGUE_TITLES = [/^add logging$/i, /^add error handling$/i, /^improve.*performance$/i, /^refactor.*code$/i, /^optimize$/i, /^clean.*up$/i];
    if (VAGUE_TITLES.some(pat => pat.test(proposal.title.trim()))) {
      log.debug(`Skipped vague proposal: ${proposal.title}`);
      return { id: 0, isNew: false };
    }
    // Dedup: skip if same file+title already exists in any active state (pending, approved, implementing)
    const existingActive = db.prepare(
      `SELECT id FROM upgrade_proposals WHERE file_path = ? AND title = ? AND status IN ('pending','approved','implementing') LIMIT 1`
    ).get(normalizedPath, proposal.title);
    if (existingActive) return { id: (existingActive as any).id, isNew: false };

    // Skip if same file+title was rejected in the last 7 days (avoid re-proposing known failures)
    const recentlyRejected = db.prepare(
      `SELECT id FROM upgrade_proposals WHERE file_path = ? AND title = ? AND status = 'rejected' AND created_at > datetime('now', '-7 days') LIMIT 1`
    ).get(normalizedPath, proposal.title);
    if (recentlyRejected) {
      log.debug(`Skipped proposal — same title was rejected recently for ${normalizedPath}`);
      return { id: 0, isNew: false };
    }

    // Skip if same file has too many rejected proposals recently (AI keeps failing on this file)
    const fileRejectCount = db.prepare(
      `SELECT COUNT(*) as count FROM upgrade_proposals WHERE file_path = ? AND status = 'rejected' AND created_at > datetime('now', '-3 days')`
    ).get(normalizedPath) as { count: number };
    if (fileRejectCount && fileRejectCount.count >= 5) {
      log.debug(`Skipped proposal — file ${normalizedPath} has ${fileRejectCount.count} recent rejections`);
      return { id: 0, isNew: false };
    }

    const result = db.prepare(`
      INSERT INTO upgrade_proposals (type, title, description, file_path, line_range, suggested_fix, priority, status, model_used, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposal.type, proposal.title, proposal.description,
      normalizedPath, proposal.line_range || null,
      proposal.suggested_fix || null, proposal.priority,
      proposal.status, proposal.model_used, proposal.confidence
    );
    return { id: Number((result as any).lastInsertRowid) || 0, isNew: true };
  } catch (err: any) {
    log.error('Failed to insert proposal', { error: err.message });
    return { id: 0, isNew: false };
  }
}

export function getProposals(
  status?: ProposalStatus,
  type?: ProposalType,
  limit: number = 50,
  offset: number = 0,
): UpgradeProposal[] {
  try {
    const db = getDb();
    let sql = 'SELECT * FROM upgrade_proposals WHERE 1=1';
    const params: any[] = [];
    if (status) { sql += ' AND status = ?'; params.push(status); }
    if (type) { sql += ' AND type = ?'; params.push(type); }
    sql += ' ORDER BY CASE priority WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return db.prepare(sql).all(...params) as UpgradeProposal[];
  } catch (err: any) {
    log.error('Failed to get proposals', { error: err.message });
    return [];
  }
}

export function getProposalStats(): {
  total: number; pending: number; approved: number; rejected: number; implemented: number; skipped: number;
  byType: Record<string, number>; byPriority: Record<string, number>;
  tokensIn: number; tokensOut: number; costUsd: number;
} {
  try {
    const db = getDb();
    const total = (db.prepare('SELECT COUNT(*) as c FROM upgrade_proposals').get() as any).c;
    const pending = (db.prepare("SELECT COUNT(*) as c FROM upgrade_proposals WHERE status = 'pending'").get() as any).c;
    const approved = (db.prepare("SELECT COUNT(*) as c FROM upgrade_proposals WHERE status = 'approved'").get() as any).c;
    const rejected = (db.prepare("SELECT COUNT(*) as c FROM upgrade_proposals WHERE status = 'rejected'").get() as any).c;
    const implemented = (db.prepare("SELECT COUNT(*) as c FROM upgrade_proposals WHERE status = 'implemented'").get() as any).c;
    const skipped = (db.prepare("SELECT COUNT(*) as c FROM upgrade_proposals WHERE status = 'skipped'").get() as any).c;

    const typeRows = db.prepare('SELECT type, COUNT(*) as c FROM upgrade_proposals GROUP BY type').all() as any[];
    const byType: Record<string, number> = {};
    for (const r of typeRows) byType[r.type] = r.c;

    const prioRows = db.prepare('SELECT priority, COUNT(*) as c FROM upgrade_proposals GROUP BY priority').all() as any[];
    const byPriority: Record<string, number> = {};
    for (const r of prioRows) byPriority[r.priority] = r.c;

    const tokensIn = parseFloat(getSetting('upgrade_tokens_in') || '0');
    const tokensOut = parseFloat(getSetting('upgrade_tokens_out') || '0');
    const costUsd = parseFloat(getSetting('upgrade_cost_usd') || '0');

    return { total, pending, approved, rejected, implemented, skipped, byType, byPriority, tokensIn, tokensOut, costUsd };
  } catch {
    return { total: 0, pending: 0, approved: 0, rejected: 0, implemented: 0, skipped: 0, byType: {}, byPriority: {}, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }
}

export function updateProposalStatus(id: number, status: ProposalStatus): boolean {
  try {
    const db = getDb();
    const result = db.prepare(
      `UPDATE upgrade_proposals SET status = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(status, id);
    return (result as any).changes > 0;
  } catch {
    return false;
  }
}

export function deleteProposal(id: number): boolean {
  try {
    const result = getDb().prepare('DELETE FROM upgrade_proposals WHERE id = ?').run(id);
    return (result as any).changes > 0;
  } catch {
    return false;
  }
}

export function retryAllRejectedProposals(): number {
  try {
    const result = getDb().prepare('UPDATE upgrade_proposals SET status = ? WHERE status = ?').run('pending', 'rejected');
    return (result as any).changes || 0;
  } catch (err: any) {
    log.error(`Failed to retry all rejected proposals: ${err.message}`);
    return 0;
  }
}

export function deleteAllRejectedProposals(): number {
  try {
    const result = getDb().prepare('DELETE FROM upgrade_proposals WHERE status = ?').run('rejected');
    return (result as any).changes || 0;
  } catch (err: any) {
    log.error(`Failed to delete all rejected proposals: ${err.message}`);
    return 0;
  }
}

function logScan(filePath: string, findingsCount: number): void {
  try {
    getDb().prepare(
      'INSERT INTO upgrade_scan_log (file_path, findings_count) VALUES (?, ?)'
    ).run(filePath, findingsCount);
  } catch { /* non-critical */ }
}

// ── Core Scan Loop ──

export interface ScanBatchResult {
  totalFindings: number;
  batchProcessed: string[];
}

async function scanBatch(rootDir: string, ignoreIdle: boolean = false): Promise<ScanBatchResult & { newFindings: number }> {
  // Build index on first run
  if (!_initialized || _fileIndex.length === 0) {
    _fileIndex = await buildFileIndex(rootDir);
    try {
      const { getSetting } = await import('../database/db.js');
      const savedCursor = getSetting('upgrade_scan_cursor');
      _scanCursor = savedCursor ? parseInt(savedCursor, 10) : 0;
      if (isNaN(_scanCursor) || _scanCursor >= _fileIndex.length) _scanCursor = 0;
    } catch {
      _scanCursor = 0;
    }
    _initialized = true;
    log.info(`File index built: ${_fileIndex.length} files to scan (Resuming cursor: ${_scanCursor})`);
  }

  // Wrap around if we've scanned everything
  if (_scanCursor >= _fileIndex.length) {
    _scanCursor = 0;
    log.info('Full scan cycle complete — restarting from beginning');
  }

  // Persist cursor dynamically ahead of processing
  import('../database/db.js').then(({ setSetting }) => {
    setSetting('upgrade_scan_cursor', String(_scanCursor));
  }).catch(() => {});

  const batch = _fileIndex.slice(_scanCursor, _scanCursor + SCAN_BATCH_SIZE);
  let totalFindings = 0;
  let newFindings = 0;

  for (const filePath of batch) {
    // Check if user came back (only if not forced)
    if (!ignoreIdle && (_paused || !isSystemIdle())) {
      log.info('Scan paused — user activity detected');
      return { totalFindings, newFindings, batchProcessed: batch };
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const findings = analyzeFileContent(filePath, content);

      // Make path relative for readability and normalize to forward slashes
      const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');

      for (const f of findings) {
        const result = insertProposal({
          type: f.type,
          title: f.title,
          description: f.description,
          file_path: relPath,
          line_range: String(f.line),
          priority: f.priority,
          status: 'pending',
          model_used: 'local-static-analysis',
          confidence: f.confidence,
        });

        if (result.isNew) newFindings++;
      }

      logScan(relPath, findings.length);
      totalFindings += findings.length;

      if (findings.length > 0) {
        log.debug(`Scanned ${relPath}: ${findings.length} findings`);
      }
    } catch (err: any) {
      log.debug(`Skip unreadable file: ${filePath}`, { error: err.message });
    }

    // Small delay between files
    await new Promise(r => setTimeout(r, ANALYSIS_DELAY_MS));
  }

  _scanCursor += SCAN_BATCH_SIZE;
  return { totalFindings, newFindings, batchProcessed: batch };
}

// ── LLM Deep Analysis ──

async function analyzeBatchWithLLM(rootDir: string, batchFiles: string[]): Promise<number> {
  let llmFindings = 0;
  let llmCalls = 0;

  for (const filePath of batchFiles) {
    if (llmCalls >= MAX_LLM_CALLS_PER_CYCLE) break;
    // check if idle unless it's a small carry-over? No, let's just keep same logic.
    // If it's called from forceScan, maybe it should also ignore idle.
    // But scanBatch is already done.

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relPath = path.relative(rootDir, filePath).replace(/\\/g, '/');

      const prompt = `You are an expert TypeScript code reviewer performing a SAFETY audit. Your goal: find bugs that WILL crash the server or corrupt data at runtime. Nothing else matters.

FILE: "${relPath}"

WHAT TO REPORT (only these):
- Uncaught exceptions that will crash the process
- Null/undefined dereference that will throw at runtime
- Incorrect function calls (wrong argument count, wrong types that JS won't auto-coerce)
- Resource leaks (unclosed connections, missing clearInterval/clearTimeout)
- SQL injection via unsanitized template literals in .prepare()/.exec()
- Race conditions that cause data corruption
- Infinite loops or unbounded recursion

WHAT TO NEVER REPORT:
- Style issues, naming conventions, code organization
- Missing logging, comments, documentation
- TypeScript type-only issues (they don't crash at runtime)
- Theoretical security concerns without concrete exploit path
- Performance optimizations that aren't causing actual bugs
- Redundant null checks (safe code is GOOD code, don't remove safety)
- Issues in other files — you can ONLY see "${relPath}"
- "Add error handling" for code that already has try/catch
- "Add validation" for internal functions not exposed to user input
- BUGS THAT ARE ALREADY FIXED: Read the code carefully. If an object is already correctly null-checked (e.g., using '?.' or an if statement), DO NOT report it as a null dereference risk.

YOUR SUGGESTED FIX RULES:
- Must be a MINIMAL valid TypeScript snippet (only the changed lines, max 20 lines)
- Must preserve ALL existing closing brackets }, ), ]
- Must NOT add imports for packages not in the project
- Must NOT change function signatures, export names, or interface definitions
- If unsure → set confidence below 0.5 (it will be auto-filtered)

Respond in pure JSON (no markdown wrapping):
[{"type":"bug"|"security","title":"Short title","description":"What crashes and when","line_range":"10-15","suggested_fix":"minimal fix code","priority":"medium"|"high"|"critical","confidence":0.0-1.0}]

Return [] if no real runtime bugs found. Be conservative — false negatives are OK, false positives waste resources.

Code:
${content}`;

      const response = await aiChat('chat', [{ role: 'user', content: prompt }], { model: 'gemini-2.0-flash' });
      llmCalls++;

      // Track usage
      if (response.usage) {
        trackUpgradeTokens('gemini-2.0-flash', response.usage.promptTokens || 0, response.usage.completionTokens || 0);
      }

      // Better JSON extraction logic to ignore markdown and unparsed trailing text
      let matchText = response.text || '';
      const mdMatch = matchText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (mdMatch) matchText = mdMatch[1];
      
      const bracketMatch = matchText.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (bracketMatch) {
        try {
          const issues = JSON.parse(bracketMatch[0]);
          if (Array.isArray(issues)) {
            for (const issue of issues) {
          const result = insertProposal({
            type: issue.type || 'refactor',
            title: issue.title || 'LLM Suggestion',
            description: issue.description || 'No description provided',
            file_path: relPath,
            line_range: issue.line_range || null,
            suggested_fix: issue.suggested_fix || null,
            priority: issue.priority || 'medium',
            status: 'pending',
            model_used: 'gemini-2.0-flash',
            confidence: issue.confidence || 0.8
          });
          if (result.isNew) llmFindings++;
        }
          if (issues.length > 0) {
            log.debug(`LLM analyzed ${relPath}: ${issues.length} findings`);
          }
        }
        } catch (parseErr: any) {
          log.warn(`LLM returned invalid JSON for ${relPath}. Parse error: ${parseErr.message}`);
        }
      }
    } catch (err: any) {
      const errMsg = err.message || '';
      if (/429|RESOURCE_EXHAUSTED|quota|rate.limit/i.test(errMsg)) {
        log.warn(`[SelfUpgrade] API quota exhausted during scan. Stopping scan early.`);
        console.log(`\x1b[33m  ⚠️ API quota exhausted — scan paused. Will resume on next cycle.\x1b[0m`);
        break; // Stop scanning, don't waste more calls
      }
      log.warn(`LLM analysis failed for ${filePath}: ${errMsg}`);
    }

    // Rate limiting delay between LLM calls
    await new Promise(r => setTimeout(r, ANALYSIS_DELAY_MS));
  }

  return llmFindings;
}

// ── Auto Implementation Helpers ──

/** Helper to save file diffs for history */
function saveUpgradeDiff(id: number, original: string, modified: string): void {
  try {
    const historyDir = path.resolve(process.cwd(), '../data/upgrade_history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(path.join(historyDir, `proposal_${id}_before.txt`), original, 'utf-8');
    fs.writeFileSync(path.join(historyDir, `proposal_${id}_after.txt`), modified, 'utf-8');
  } catch (e: any) {
    log.error(`[SelfUpgrade] Failed to save code diffs for #${id}: ${e.message}`);
  }
}

/**
 * Smart TSC verification — compares errors BEFORE vs AFTER the upgrade.
 * Only rejects if the upgrade INTRODUCED NEW errors (not pre-existing ones).
 */
let _baselineErrors: string[] | null = null;

async function captureBaselineErrors(rootDir: string): Promise<string[]> {
  if (_baselineErrors !== null) return _baselineErrors;
  const checkDir = path.resolve(rootDir, '..');
  try {
    await execPromise('npx tsc --noEmit', { cwd: checkDir });
    _baselineErrors = [];
  } catch (err: any) {
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    _baselineErrors = stdout.split('\n').filter((line: string) => line.includes('error TS')).sort();
  }
  log.info(`TSC baseline captured: ${_baselineErrors!.length} pre-existing errors`);
  return _baselineErrors!;
}

/** Reset baseline cache (call after successful implementation) */
export function invalidateBaselineCache(): void {
  _baselineErrors = null;
}

async function verifyUpgrade(rootDir: string, proposalId: number): Promise<void> {
  log.debug(`Running smart tsc check for proposal #${proposalId}...`);
  const checkDir = path.resolve(rootDir, '..');

  // Get baseline errors (cached)
  const baseline = await captureBaselineErrors(rootDir);

  // Run tsc after the upgrade
  let afterErrors: string[] = [];
  try {
    await execPromise('npx tsc --noEmit', { cwd: checkDir });
    // No errors at all — even better than baseline!
    return;
  } catch (err: any) {
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    afterErrors = stdout.split('\n').filter((line: string) => line.includes('error TS')).sort();
  }

  // Compare: find NEW errors that didn't exist in baseline
  const baselineSet = new Set(baseline);
  const newErrors = afterErrors.filter((err: string) => !baselineSet.has(err));

  if (newErrors.length === 0) {
    // No new errors introduced — the upgrade is safe even if baseline errors remain
    log.info(`Proposal #${proposalId} verification passed (${afterErrors.length} pre-existing errors, 0 new)`);
    return;
  }

  // New errors were introduced — reject the upgrade
  const errorMsg = `New TypeScript errors introduced (${newErrors.length}):\n${newErrors.join('\n')}`;
  throw { stdout: errorMsg, message: errorMsg };
}

// ── Quick Structural Validation — fast bracket/duplicate checks ──

/**
 * Fast pre-check before running expensive TSC/esbuild:
 * 1. Bracket balance (catches missing } which crashes esbuild)
 * 2. Duplicate top-level declarations (catches AI adding duplicates)
 * 3. Basic syntax structure
 */
function quickStructuralCheck(filePath: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const basename = path.basename(filePath);

    // 1. Bracket balance check
    let braces = 0, parens = 0, brackets = 0;
    let inString = false;
    let stringChar = '';
    let inTemplate = 0;
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      const next = content[i + 1];

      if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
      if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
      if (inString) {
        if (c === '\\') { i++; continue; }
        if (c === stringChar) inString = false;
        continue;
      }
      if (inTemplate > 0) {
        if (c === '\\') { i++; continue; }
        if (c === '`') inTemplate = 0;
        continue;
      }
      if (c === '/' && next === '/') { inLineComment = true; continue; }
      if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
      if (c === '"' || c === "'") { inString = true; stringChar = c; continue; }
      if (c === '`') { inTemplate = 1; continue; }

      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
    }

    if (braces !== 0) errors.push(`${basename}: Unbalanced braces — ${braces > 0 ? `${braces} unclosed {` : `${-braces} extra }`}`);
    if (parens !== 0) errors.push(`${basename}: Unbalanced parentheses — ${parens > 0 ? `${parens} unclosed (` : `${-parens} extra )`}`);

    // 2. Duplicate top-level declarations
    const lines = content.split('\n');
    const declaredNames = new Map<string, number>();
    const declRegex = /^(?:export\s+)?(?:const|let|var|function|class|enum|type|interface)\s+(\w+)/;
    for (let ln = 0; ln < lines.length; ln++) {
      const m = lines[ln].match(declRegex);
      if (m) {
        const name = m[1];
        if (declaredNames.has(name)) {
          errors.push(`${basename}: Duplicate declaration "${name}" at lines ${declaredNames.get(name)! + 1} and ${ln + 1}`);
        }
        declaredNames.set(name, ln);
      }
    }

  } catch { /* skip unreadable */ }
  return { ok: errors.length === 0, errors };
}

// ── esbuild Syntax Validation — catch syntax errors that TSC misses ──

/**
 * esbuild is the actual transpiler used by tsx (our runtime).
 * TSC may accept some syntax patterns that esbuild rejects.
 * Run esbuild transform on each modified file to catch these early.
 */
async function verifyEsbuildSyntax(modifiedFiles: string[], proposalId: number): Promise<void> {
  const errors: string[] = [];
  for (const filePath of modifiedFiles) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      const loader = ext === '.tsx' ? 'tsx' : ext === '.jsx' ? 'jsx' : 'ts';
      const basename = path.basename(filePath);
      // Pass content via base64 to avoid path escaping issues on Windows
      const content = fs.readFileSync(filePath, 'utf-8');
      const b64 = Buffer.from(content).toString('base64');
      const script = `const esbuild=require('esbuild');const code=Buffer.from('${b64}','base64').toString('utf-8');esbuild.transform(code,{loader:'${loader}',sourcefile:'${basename}'}).then(()=>process.exit(0)).catch(e=>{console.error(e.errors?e.errors.map(x=>x.text).join('\\n'):e.message);process.exit(1)})`;
      await execPromise(`node -e "${script.replace(/"/g, '\\"')}"`, {
        cwd: path.resolve(filePath, '..'),
        timeout: 15000,
      });
    } catch (err: any) {
      const msg = (err.stderr || err.stdout || err.message || 'Unknown esbuild error').toString().trim();
      errors.push(`${path.basename(filePath)}: ${msg.substring(0, 300)}`);
    }
  }

  if (errors.length > 0) {
    const errorMsg = `esbuild syntax check failed for ${errors.length} file(s):\n${errors.join('\n')}`;
    log.warn(`[SelfUpgrade] Proposal #${proposalId} rejected: ${errorMsg}`);
    throw { stdout: errorMsg, message: errorMsg };
  }
}

// ── Lightweight Runtime Test — ลอง boot server จริงแล้ว check /health ──

/**
 * After TSC passes, try to actually start the server process and hit /health.
 * If the server crashes within a few seconds or /health fails, rollback.
 * Uses a child process so the main server is unaffected.
 */
async function runtimeBootTest(rootDir: string, proposalId: number): Promise<void> {
  const serverDir = path.resolve(rootDir, '..');
  const testPort = 19876 + (proposalId % 100); // Unique port per proposal to avoid conflicts

  log.info(`[RuntimeTest] Starting boot test for proposal #${proposalId} on port ${testPort}...`);

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let childOutput = '';

    // Start server with a test port, suppressing interactive features
    // Use cross-platform env: pass via env option (works on both Windows and Linux)
    const child = exec(
      `npx tsx src/index.ts`,
      {
        cwd: serverDir,
        timeout: 20000,
        env: { ...process.env, PORT: String(testPort), NODE_ENV: 'test' }
      }
    );

    child.stdout?.on('data', (data: string) => { childOutput += data; });
    child.stderr?.on('data', (data: string) => { childOutput += data; });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`Runtime boot test: server failed to start — ${err.message}`));
      }
    });

    child.on('exit', (code) => {
      // If the child exits before we settle, it crashed during boot
      if (!settled) {
        settled = true;
        const snippet = childOutput.slice(-500);
        reject(new Error(`Runtime boot test: server exited with code ${code} during startup.\nLast output: ${snippet}`));
      }
    });

    // Wait 4 seconds, then try to hit /health
    setTimeout(async () => {
      if (settled) return;

      try {
        const resp = await fetch(`http://127.0.0.1:${testPort}/health`, { signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
          settled = true;
          log.info(`[RuntimeTest] Proposal #${proposalId} — /health returned OK, server boots clean.`);
          resolve();
        } else {
          settled = true;
          reject(new Error(`Runtime boot test: /health returned status ${resp.status}`));
        }
      } catch (err: any) {
        // If fetch fails, the server didn't start properly
        if (!settled) {
          settled = true;
          reject(new Error(`Runtime boot test: /health unreachable — ${err.message}`));
        }
      } finally {
        // Always kill the test server
        try { child.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
      }
    }, 4000);

    // Hard timeout: kill after 15 seconds no matter what
    setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error(`Runtime boot test: timed out after 15 seconds`));
      }
    }, 15000);
  });
}

// ── Pre-Implementation Planning Step — AI วางแผนก่อนลงมือ ──

interface ImplementationPlan {
  steps: string[];
  filesToEdit: string[];
  riskAssessment: string;
  shouldProceed: boolean;
  reason?: string;
}

/**
 * Before implementation, ask the AI to create a concrete plan.
 * If the plan says "don't do this", we skip the proposal.
 * The plan is injected into the implementation prompt for guidance.
 */
async function createImplementationPlan(
  proposal: UpgradeProposal,
  impact: ImpactReport,
  originalContent: string,
  learningContext: string
): Promise<ImplementationPlan> {
  const planPrompt = `You are a GATEKEEPER deciding whether a code change proposal is safe to auto-implement.
Your job: REJECT risky proposals and APPROVE only safe ones. When in doubt, REJECT.

Proposal: ${proposal.title}
Description: ${proposal.description}
Target file: ${proposal.file_path}
Suggested fix: ${proposal.suggested_fix || 'N/A'}
Impact risk: ${impact.riskLevel}
Affected files: ${impact.affectedFiles.length > 0 ? impact.affectedFiles.join(', ') : 'none'}
Exported symbols at risk: ${impact.exportedSymbols.length > 0 ? impact.exportedSymbols.join(', ') : 'none'}
${learningContext ? `\n[Lessons from past failures — MUST consider]:\n${learningContext}` : ''}

Target file first 100 lines:
\`\`\`typescript
${originalContent.split('\n').slice(0, 100).join('\n')}
\`\`\`

AUTO-REJECT if ANY of these apply:
- Proposal changes an interface, type, or exported function signature
- Proposal adds imports for packages not visible in the file
- Proposal is about "add logging" or "add error handling" to working code
- Proposal description is vague (e.g., "optimize", "improve", "refactor" without specifics)
- Suggested fix references methods/properties that might not exist on the type
- Change would affect > 3 files
- The "bug" described is actually correct existing behavior
- The fix is already implemented in the code (redundant)

Return JSON (no markdown):
{"shouldProceed":true/false,"reason":"Why reject or why it's safe","riskAssessment":"What could go wrong","filesToEdit":["files"],"steps":["Step 1: ...","Step 2: ..."]}

Max 6 steps. More = too complex = shouldProceed: false.`;

  try {
    const response = await aiChat('chat', [{ role: 'user', content: planPrompt }], {
      model: 'gemini-2.0-flash',
      maxTokens: 1500,
    });

    const match = response.text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        shouldProceed: parsed.shouldProceed !== false,
        reason: parsed.reason || undefined,
        riskAssessment: parsed.riskAssessment || 'Unknown',
        filesToEdit: Array.isArray(parsed.filesToEdit) ? parsed.filesToEdit : [proposal.file_path],
        steps: Array.isArray(parsed.steps) ? parsed.steps : [],
      };
    }
  } catch (err: any) {
    log.warn(`[Planning] Failed to generate plan for proposal #${proposal.id}: ${err.message}`);
  }

  // Fallback: proceed without plan
  return {
    shouldProceed: true,
    riskAssessment: 'Plan generation failed — proceeding with default behavior',
    filesToEdit: [proposal.file_path],
    steps: [],
  };
}

// ── Learning Journal Feedback — ดึงบทเรียนจากความผิดพลาดเก่ามา feed AI ──

/**
 * Build a context string from Learning Journal that's relevant to this specific proposal.
 * Searches both by file path and by proposal description keywords.
 */
async function buildUpgradeLearningContext(proposal: UpgradeProposal): Promise<string> {
  try {
    // 1. Get recent error_solutions learnings (most relevant for code changes)
    const { getLearnings: getLearningsFromJournal } = await import('./learningJournal.js');
    const errorLearnings = getLearningsFromJournal('error_solutions', 5);
    const perfLearnings = getLearningsFromJournal('performance', 3);
    const toolLearnings = getLearningsFromJournal('tool_usage', 3);

    // 2. Semantic search for learnings relevant to this specific proposal
    const { searchLearnings: searchLearningsFromJournal } = await import('./learningJournal.js');
    const relevantLearnings = await searchLearningsFromJournal(
      `${proposal.title} ${proposal.file_path}`, 5
    );

    // 3. Get recent rejection reasons from DB for pattern matching
    const db = getDb();
    const recentRejections = db.prepare(`
      SELECT title, description FROM upgrade_proposals
      WHERE status = 'rejected' AND file_path = ?
      ORDER BY id DESC LIMIT 3
    `).all(proposal.file_path) as any[];

    // Combine and deduplicate
    const allInsights: string[] = [];
    const seen = new Set<string>();

    const addInsight = (category: string, insight: string) => {
      const key = insight.substring(0, 80);
      if (!seen.has(key) && insight.length > 10) {
        seen.add(key);
        allInsights.push(`[${category}] ${insight}`);
      }
    };

    for (const l of errorLearnings) addInsight('Error Fix', l.insight);
    for (const l of perfLearnings) addInsight('Performance', l.insight);
    for (const l of toolLearnings) addInsight('Tool Usage', l.insight);
    for (const l of relevantLearnings) addInsight('Relevant', l.insight);

    for (const r of recentRejections) {
      const failReason = String(r.description).split('Auto-Implement Failed:').pop()?.trim();
      if (failReason) {
        addInsight('Same-File Rejection', `"${r.title}" failed: ${failReason.substring(0, 150)}`);
      }
    }

    if (allInsights.length === 0) return '';

    return `\n[📚 LEARNING JOURNAL — Lessons from past experience]\n` +
      allInsights.slice(0, 10).map((i, idx) => `${idx + 1}. ${i}`).join('\n') +
      `\nUse these lessons to AVOID repeating past mistakes. If a lesson contradicts the proposal, reply "SKIP: [reason]".\n`;
  } catch (err: any) {
    log.debug(`[LearningFeedback] Failed to build learning context: ${err.message}`);
    return '';
  }
}

// ── Impact Analysis — "มองภาพใหญ่ก่อนแก้" ──

interface ImpactReport {
  targetFile: string;
  exportedSymbols: string[];          // functions/types/interfaces exported from target
  callerFiles: Map<string, string[]>; // file → [symbols it uses from target]
  affectedFiles: string[];            // files that MUST be updated together
  riskLevel: 'safe' | 'moderate' | 'high';
  analysis: string;                   // human-readable summary
}

/**
 * Analyze cross-file impact BEFORE attempting any code changes.
 * This scans the codebase to find all files that import/use symbols from the target file.
 */
async function analyzeImpact(rootDir: string, targetFilePath: string, proposalDescription: string): Promise<ImpactReport> {
  const fullPath = path.resolve(rootDir, targetFilePath);
  const report: ImpactReport = {
    targetFile: targetFilePath,
    exportedSymbols: [],
    callerFiles: new Map(),
    affectedFiles: [],
    riskLevel: 'safe',
    analysis: '',
  };

  try {
    const content = fs.readFileSync(fullPath, 'utf-8');

    // 1. Extract all exported symbols from the target file
    const exportPatterns = [
      /export\s+(?:async\s+)?function\s+(\w+)/g,      // export function foo
      /export\s+(?:const|let|var)\s+(\w+)/g,           // export const foo
      /export\s+(?:interface|type|enum|class)\s+(\w+)/g, // export interface Foo
      /export\s+\{\s*([^}]+)\}/g,                      // export { foo, bar }
    ];

    for (const pattern of exportPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const symbols = match[1].split(',').map(s => s.trim().split(' as ')[0].trim());
        report.exportedSymbols.push(...symbols.filter(s => s.length > 0));
      }
    }

    // Deduplicate
    report.exportedSymbols = [...new Set(report.exportedSymbols)];

    if (report.exportedSymbols.length === 0) {
      report.riskLevel = 'safe';
      report.analysis = `File "${targetFilePath}" exports no public symbols — safe to modify in isolation.`;
      return report;
    }

    // 2. Search codebase for files that import FROM the target file
    const targetModuleName = targetFilePath
      .replace(/\\/g, '/')
      .replace(/\.(ts|tsx|js|jsx)$/, '')
      .replace(/^src\//, '');

    // Build search patterns for import statements
    const searchPatterns = [
      targetModuleName,
      path.basename(targetFilePath).replace(/\.(ts|tsx|js|jsx)$/, ''),
    ];

    const srcDir = rootDir;
    const allFiles = await buildFileIndex(rootDir);

    for (const file of allFiles) {
      if (path.resolve(file) === path.resolve(fullPath)) continue; // skip self

      try {
        const fileContent = fs.readFileSync(file, 'utf-8');
        const relFile = path.relative(rootDir, file).replace(/\\/g, '/');

        // Check if this file imports from the target
        const importMatch = searchPatterns.some(pattern =>
          fileContent.includes(pattern)
        );

        if (importMatch) {
          // Find which specific symbols are used
          const usedSymbols = report.exportedSymbols.filter(sym => {
            const symRegex = new RegExp(`\\b${sym}\\b`);
            return symRegex.test(fileContent);
          });

          if (usedSymbols.length > 0) {
            report.callerFiles.set(relFile, usedSymbols);
          }
        }
      } catch { /* skip unreadable */ }
    }

    // 3. Determine affected files — files that likely need changes too
    report.affectedFiles = [...report.callerFiles.keys()];

    // 4. Assess risk level
    if (report.affectedFiles.length === 0) {
      report.riskLevel = 'safe';
      report.analysis = `File "${targetFilePath}" exports ${report.exportedSymbols.length} symbols but none are used externally — safe to modify.`;
    } else if (report.affectedFiles.length <= 3) {
      report.riskLevel = 'moderate';
      report.analysis = `File "${targetFilePath}" is imported by ${report.affectedFiles.length} files. Symbols used: ${[...report.callerFiles.entries()].map(([f, syms]) => `${f} uses [${syms.join(', ')}]`).join('; ')}. Changes to exported interfaces/functions MUST be synchronized across these files.`;
    } else {
      report.riskLevel = 'high';
      report.analysis = `File "${targetFilePath}" is a widely-imported module (${report.affectedFiles.length} dependents). HIGH RISK — changes to exported APIs will cascade across: ${report.affectedFiles.slice(0, 8).join(', ')}${report.affectedFiles.length > 8 ? ` and ${report.affectedFiles.length - 8} more` : ''}. Requires careful multi-file coordination.`;
    }

    log.info(`Impact analysis for "${targetFilePath}": risk=${report.riskLevel}, ${report.affectedFiles.length} affected files, ${report.exportedSymbols.length} exported symbols`);
  } catch (err: any) {
    log.warn(`Impact analysis failed for "${targetFilePath}": ${err.message}`);
    report.riskLevel = 'moderate';
    report.analysis = `Impact analysis could not be completed — proceed with caution.`;
  }

  return report;
}

/** Format impact report for DB storage */
function serializeImpactReport(report: ImpactReport): { affected_files: string; impact_analysis: string } {
  return {
    affected_files: JSON.stringify(report.affectedFiles),
    impact_analysis: report.analysis,
  };
}

/** Helper to select best specialists */
function getSortedImplementationSpecialists(swarmCoordinator: any): string[] {
  const implementationSpecialists = ['coder', 'reviewer'];
  const availableSpecs = swarmCoordinator.getAvailableSpecialists();
  const runtimeHealth = swarmCoordinator.getSpecialistRuntimeHealth();

  const sorted = implementationSpecialists.filter(name => 
    availableSpecs.some((s: any) => s.name === name)
  ).sort((a, b) => {
    const hA = runtimeHealth.find((h: any) => h.specialist === a);
    const hB = runtimeHealth.find((h: any) => h.specialist === b);
    const score = (h: any) => {
      if (!h) return 0;
      if (h.state === 'healthy') return 3;
      if (h.state === 'idle') return 2;
      if (h.state === 'degraded') return 1;
      return 0;
    };
    return score(hB) - score(hA);
  });

  if (sorted.length === 0) {
    log.warn(`No implementation specialists found. Falling back to codex-cli-agent.`);
    sorted.push('codex-cli-agent');
  }
  return sorted;
}

// ── Auto Implementation ──

export async function implementProposalById(id: number, rootDir: string): Promise<boolean> {
  const db = getDb();
  const proposal = db.prepare('SELECT * FROM upgrade_proposals WHERE id = ?').get(id) as UpgradeProposal | undefined;
  if (!proposal) return false;

  const fileName = path.basename(proposal.file_path);
  const relativePath = proposal.file_path.replace(/\\/g, '/');

  // 🛡️ Pre-Implementation Validation Gate — reject obviously bad proposals before wasting resources
  const REJECT_FILE_PATTERNS = [
    /\.md$/i,                   // Markdown files are NOT source code
    /\.txt$/i,                  // Text files
    /REFACTORING/i,             // Refactoring notes
    /README/i,
    /\.test\.\w+$/,             // Test files
    /\.spec\.\w+$/,             // Spec files
    /__tests__/i,               // Test directories
    /revert_proposals/i,        // Utility scripts
    /test_upgrade/i,            // Utility scripts
  ];

  if (REJECT_FILE_PATTERNS.some(pat => pat.test(relativePath) || pat.test(fileName))) {
    log.warn(`[SelfUpgrade] Auto-rejected proposal #${id} — target "${relativePath}" is not production source code`);
    db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
      .run(`\n\n[Pre-Validation]: Rejected — "${relativePath}" is not a production source file (test/docs/utility).`, id);
    return false;
  }

  // Check that the actual source file exists
  const fullPathCheck = path.resolve(rootDir, proposal.file_path);
  if (!fs.existsSync(fullPathCheck)) {
    log.warn(`[SelfUpgrade] Auto-rejected proposal #${id} — file "${relativePath}" does not exist`);
    db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
      .run(`\n\n[Pre-Validation]: Rejected — file "${relativePath}" not found on disk.`, id);
    return false;
  }
  
  // 🛡️ Immortal Core Sandbox Hard-Blocker
  // Failsafe in case a proposal targeting a core file was generated manually or pre-dates the blacklist
  const PROTECTED_CORE_FILES = new Set([
    'index.ts', 'config.ts', 'configValidator.ts', 'queue.js',
    'database/db.ts', 'database/db.js',
    'evolution/selfUpgrade.ts', 'evolution/selfReflection.ts',
    'terminal/terminalGateway.ts', 'api/socketHandlers.ts', 'api/upgradeRoutes.ts',
    'bot_agents/tools/index.ts', 'bot_agents/agent.ts',
    'automation/chatBot.ts', 'automation/browser.ts',
  ]);
  
  if (PROTECTED_CORE_FILES.has(relativePath)) {
    log.warn(`[SelfUpgrade] Hard-blocked implementation of proposal #${proposal.id} because "${relativePath}" is an Immortal Core Sandbox file.`);
    db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
      .run(`\n\n[System Failsafe]: Rejected. This file (${relativePath}) is part of the Protected Core Server Infrastructure and cannot be auto-upgraded to prevent unrecoverable Node.js crashes.`, id);
    return false;
  }

  const pStart = Date.now();
  const elapsed = () => `${((Date.now() - pStart) / 1000).toFixed(1)}s`;
  const phaseLog = (phase: string, detail?: string) => {
    const msg = detail ? `${phase} — ${detail}` : phase;
    console.log(`\x1b[36m  ├─ ${msg} \x1b[90m(${elapsed()})\x1b[0m`);
  };

  console.log(`\x1b[36m[SelfUpgrade] Proposal #${proposal.id} : ${proposal.title}\x1b[0m`);
  console.log(`\x1b[90m  │ File: ${relativePath}\x1b[0m`);

  const fullPath = path.resolve(rootDir, proposal.file_path);
  let originalContent = '';
  try {
    originalContent = fs.readFileSync(fullPath, 'utf-8');
  } catch (err: any) {
    phaseLog('❌ File Read Failed', err.message);
    updateProposalStatus(id, 'rejected');
    return false;
  }
  phaseLog('📂 File Read', `${(originalContent.length / 1024).toFixed(1)}KB`);

  // Phase 5 Cognitive Upgrade: Inject trauma to prevent recursive stupidity
  let traumaContext = '';
  try {
    const traumaRecords = db.prepare(`
      SELECT title, description FROM upgrade_proposals
      WHERE status = 'rejected'
      ORDER BY id DESC LIMIT 5
    `).all() as any[];

    if (traumaRecords.length > 0) {
      traumaContext = `\n[🚨 CRITICAL TRAUMA MEMORY - DO NOT REPEAT THESE RECENT MISTAKES! 🚨]\n`;
      traumaRecords.forEach((r, i) => {
        const errDesc = String(r.description).split('Auto-Implement Failed:').pop()?.trim() || 'Syntax or Type Error';
        traumaContext += `Failure #${i+1}:\n- Task: ${r.title}\n- Compiler Crashed With: ${errDesc}\n`;
      });
      traumaContext += `\nYou MUST read the above compiler errors and ENSURE your current edit does not trigger the exact same problem!\n`;
    }
  } catch(e) {}

  // ── Phase 6: Impact Analysis — "มองภาพใหญ่ก่อนแก้" ──
  phaseLog('🔍 Impact Analysis', 'scanning cross-file dependencies...');
  const impact = await analyzeImpact(rootDir, relativePath, proposal.description);
  phaseLog('🔍 Impact Analysis', `risk=${impact.riskLevel}, dependents=${impact.affectedFiles.length}, exports=${impact.exportedSymbols.length}`);

  // Save impact analysis to DB for dashboard visibility
  try {
    const { affected_files: af, impact_analysis: ia } = serializeImpactReport(impact);
    db.prepare(`UPDATE upgrade_proposals SET affected_files = ?, impact_analysis = ? WHERE id = ?`)
      .run(af, ia, id);
  } catch {}

  // ── Phase 7: Learning Journal Feedback — ดึงบทเรียนจากอดีต ──
  phaseLog('📚 Learning Feedback', 'querying past lessons...');
  const learningContext = await buildUpgradeLearningContext(proposal);
  if (learningContext) {
    const lessonCount = learningContext.split('\n').filter(l => l.match(/^\d+\./)).length;
    phaseLog('📚 Learning Feedback', `${lessonCount} lessons injected`);
  } else {
    phaseLog('📚 Learning Feedback', 'no relevant lessons found');
  }

  // ── Phase 8: Pre-Implementation Planning — วางแผนก่อนลงมือ ──
  phaseLog('📋 Planning', 'AI generating implementation plan...');
  const plan = await createImplementationPlan(proposal, impact, originalContent, learningContext);

  if (!plan.shouldProceed) {
    phaseLog('📋 Planning', `REJECTED — ${plan.reason}`);
    console.log(`\x1b[31m  └─ ❌ Rejected at Planning Phase\x1b[0m`);
    db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
      .run(`\n\n[Planning Phase]: Rejected — ${plan.reason}`, id);
    // NOTE: Do NOT addLearning here — rejection reasons fed back as "lessons" create a
    // circular feedback loop where the gatekeeper reads its own rejections and over-rejects.
    // Only real implementation failures (TSC/esbuild/runtime errors) should become lessons.
    releaseUpgradeLock();
    return false;
  }
  phaseLog('📋 Planning', `${plan.steps.length} steps, risk: ${plan.riskAssessment.substring(0, 60)}`);

  // Build plan context to inject into implementation prompt
  let planContext = '';
  if (plan.steps.length > 0) {
    planContext = `\n[📋 PRE-APPROVED IMPLEMENTATION PLAN — Follow these steps IN ORDER]\n`;
    plan.steps.forEach((step, i) => { planContext += `${i + 1}. ${step}\n`; });
    planContext += `Risk Assessment: ${plan.riskAssessment}\n`;
    planContext += `You MUST follow this plan. If you discover the plan is wrong mid-execution, reply "SKIP: plan was incorrect because [reason]".\n`;
  }

  // Gather import context: find what types/interfaces the target file imports
  let importContext = '';
  try {
    const importLines = originalContent.split('\n').filter(l => l.trim().startsWith('import '));
    if (importLines.length > 0) {
      importContext = `\n[EXISTING IMPORTS — DO NOT BREAK THESE]:\n${importLines.join('\n')}\n`;
    }
  } catch {}

  // Build affected files context — show AI what other files depend on this one
  let affectedFilesContext = '';
  if (impact.affectedFiles.length > 0) {
    affectedFilesContext = `\n[⚡ CROSS-FILE DEPENDENCY MAP — ${impact.riskLevel.toUpperCase()} RISK]\n`;
    affectedFilesContext += `Impact Analysis: ${impact.analysis}\n`;
    affectedFilesContext += `Exported symbols from this file: [${impact.exportedSymbols.join(', ')}]\n`;
    affectedFilesContext += `Files that depend on this file:\n`;
    for (const [file, symbols] of impact.callerFiles.entries()) {
      affectedFilesContext += `  - ${file} uses: [${symbols.join(', ')}]\n`;
    }
    affectedFilesContext += `\nIMPORTANT: If your change modifies any of the exported symbols above, you MUST also update ALL dependent files listed.\n`;

    // Read snippets of affected files so AI has full context
    const MAX_AFFECTED_PREVIEW = 5;
    const affectedPreviews: string[] = [];
    for (const affectedFile of impact.affectedFiles.slice(0, MAX_AFFECTED_PREVIEW)) {
      try {
        const affectedFullPath = path.resolve(rootDir, affectedFile);
        const affectedContent = fs.readFileSync(affectedFullPath, 'utf-8');
        // Show relevant import lines + usage context
        const lines = affectedContent.split('\n');
        const relevantLines: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (impact.exportedSymbols.some(sym => line.includes(sym))) {
            // Include 2 lines before and after for context
            for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
              relevantLines.push(`${j + 1}: ${lines[j]}`);
            }
            relevantLines.push('...');
          }
        }
        if (relevantLines.length > 0) {
          affectedPreviews.push(`\n--- ${affectedFile} (relevant sections) ---\n${relevantLines.join('\n')}`);
        }
      } catch { /* skip */ }
    }
    if (affectedPreviews.length > 0) {
      affectedFilesContext += `\n[DEPENDENT FILE PREVIEWS — showing where exported symbols are used]\n${affectedPreviews.join('\n')}`;
    }
  }

  // Choose prompt strategy based on impact risk level
  const isMultiFile = impact.riskLevel !== 'safe' && impact.affectedFiles.length > 0;

  // Common safety rules based on real failure patterns from past AI upgrades
  const commonSafetyRules = `
CRITICAL SAFETY RULES (learned from past failures that crashed the server):
A. BRACKET INTEGRITY: Every { must have a matching }. Every ( must have ). Count them before and after your edit.
B. NO DUPLICATE DECLARATIONS: Before adding any const/let/function/class, search the file to confirm it doesn't already exist.
C. NO PHANTOM IMPORTS: Only import symbols that actually exist in the target module. Use \`read_file_content\` to verify exports first.
D. NO SIGNATURE CHANGES: Do NOT change function parameter count, parameter types, return types, or interface/type definitions.
E. NO SPLICING CODE: Never insert code INSIDE an existing function call, string literal, or expression. Place new code on its own line.
F. VERIFY BEFORE EDIT: Always call \`read_file_content\` to get the CURRENT file content before editing. Never edit from memory.
G. MINIMAL CHANGE: Change the fewest lines possible. If the fix requires > 30 lines of change, reply "SKIP: too complex".
H. PRESERVE CONTEXT: When using \`replace_code_block\`, include 2-3 unchanged lines before and after the change to ensure correct placement.`;

  const prompt = isMultiFile
    ? `You are a senior Software Engineer AI performing a SURGICAL code fix across multiple files.${traumaContext}
${learningContext}${planContext}
🔍 MULTI-FILE MODE — You may edit: "${fileName}" + dependent files listed below.
${affectedFilesContext}
${importContext}
${commonSafetyRules}

MULTI-FILE SPECIFIC RULES:
1. If changing an exported symbol, you MUST update ALL callers in ALL files.
2. Edit the PRIMARY file first, then each dependent file.
3. If it requires editing > 5 files, reply "SKIP: too many files affected".
4. EXACT MATCHING IS REQUIRED for \`replace_code_block\`. The \`TargetContent\` must exactly match the existing source.
5. PRESERVE BRACES/BRACKETS. Ensure your replaced code block maintains balanced \`{\`, \`}\`, \`(\`, \`)\` relative to what you target. DO NOT accidentally delete closing braces '}'.

WORKFLOW:
1. <think> block: Plan exactly what changes in each file.
2. \`read_file_content\` on EVERY file you will edit.
3. \`replace_code_block\` for each change (surgical, minimal).
4. VERIFY: Count brackets in your edits. Check no duplicate declarations.
5. If the file DOES NOT need changes (it is already safe), you MUST reply "SKIP: [reason]".
6. Otherwise, reply "DONE".

Proposal: ${proposal.title}
Description: ${proposal.description}
Primary File: ${fullPath}
Suggested Fix: ${proposal.suggested_fix || 'No snippet provided — infer from description.'}

Primary File Content:
\`\`\`typescript
${originalContent}
\`\`\``
    : `You are a senior Software Engineer AI performing a SURGICAL single-file code fix.${traumaContext}
${learningContext}${planContext}
📋 SINGLE-FILE MODE — Only edit "${fileName}". No other files.
${importContext}
${commonSafetyRules}

SINGLE-FILE SPECIFIC RULES:
1. Do NOT change any exported function signatures, types, or interfaces.
2. Do NOT add new exports.
3. Do NOT remove or rename existing exports.
4. EXACT MATCHING IS REQUIRED for \`replace_code_block\`. The \`TargetContent\` must exactly match the existing source.
5. PRESERVE BRACES/BRACKETS. Ensure your replaced code block maintains balanced \`{\`, \`}\`, \`(\`, \`)\` relative to what you target. DO NOT accidentally delete closing braces '}'.

WORKFLOW:
1. <think> block: Is this change safe? What exactly will I change?
2. \`read_file_content\` on "${fullPath}" to get current state.
3. \`replace_code_block\` with minimal surgical change.
4. VERIFY: Count brackets. Check no duplicates. Check all variables are defined.
5. If the file DOES NOT need changes (it is already safe), you MUST reply "SKIP: [reason]".
6. Otherwise, reply "DONE".

Proposal: ${proposal.title}
Description: ${proposal.description}
File: ${fullPath}
Suggested Fix: ${proposal.suggested_fix || 'No snippet provided — infer from description.'}

File Content:
\`\`\`typescript
${originalContent}
\`\`\``;

  // Declare outside try so catch block can rollback all files
  const allTargetFiles: Array<{ path: string; fullPath: string; backup: string }> = [
    { path: relativePath, fullPath, backup: originalContent }
  ];

  // Acquire upgrade lock — signals tsx watch / Boot Guardian that upgrade is in progress
  acquireUpgradeLock(id);

  try {
    const rootAdmin = getRootAdminIdentity();
    const swarmCoordinator = getSwarmCoordinator();
    const sortedSpecs = getSortedImplementationSpecialists(swarmCoordinator);

    // ── Multi-File Backup System ──
    const historyDir = path.resolve(rootDir, '../data/upgrade_history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
    if (isMultiFile) {
      for (const affectedFile of impact.affectedFiles) {
        try {
          const affFullPath = path.resolve(rootDir, affectedFile);
          if (fs.existsSync(affFullPath)) {
            const affContent = fs.readFileSync(affFullPath, 'utf-8');
            allTargetFiles.push({ path: affectedFile, fullPath: affFullPath, backup: affContent });
          }
        } catch { /* skip */ }
      }
    }

    // Save backups for ALL target files
    const backupManifest: Array<{ file: string; fullPath: string }> = [];
    for (let i = 0; i < allTargetFiles.length; i++) {
      const backupName = `proposal_${id}_before${i > 0 ? `_dep${i}` : ''}.txt`;
      fs.writeFileSync(path.join(historyDir, backupName), allTargetFiles[i].backup, 'utf-8');
      backupManifest.push({ file: allTargetFiles[i].path, fullPath: allTargetFiles[i].fullPath });
    }

    // Save manifest + Boot Guardian breadcrumb
    fs.writeFileSync(path.join(historyDir, 'latest_upgrade.json'), JSON.stringify({
      id,
      filePath: fullPath,
      allFiles: backupManifest,
      isMultiFile,
      timestamp: Date.now()
    }), 'utf-8');

    phaseLog('💾 Backup', `${allTargetFiles.length} file(s) backed up, mode=${isMultiFile ? 'MULTI-FILE' : 'SINGLE-FILE'}`);

    /** Rollback ALL files to their backed-up state */
    const rollbackAll = () => {
      for (let i = 0; i < allTargetFiles.length; i++) {
        try {
          fs.writeFileSync(allTargetFiles[i].fullPath, allTargetFiles[i].backup, 'utf-8');
        } catch (rbErr: any) {
          log.error(`[SelfUpgrade] Rollback failed for ${allTargetFiles[i].path}: ${rbErr.message}`);
        }
      }
      log.info(`[SelfUpgrade] Rolled back ${allTargetFiles.length} file(s) for proposal #${id}`);
    };

    let lastError = '';
    for (const specialistName of sortedSpecs) {
      phaseLog('🤖 Implement', `delegating to ${specialistName}...`);

      try {
        const taskId = await swarmCoordinator.delegateTask(
          {
            platform: 'system' as any,
            botId: rootAdmin.botId,
            botName: rootAdmin.botName,
            replyWithFile: async () => 'Not supported in autonomous mode'
          },
          'code_generation',
          { message: prompt, context: `Self-Upgrade System — ${isMultiFile ? 'Multi-File' : 'Single-File'} Mode` },
          {
            toSpecialist: specialistName,
            priority: 4,
            timeout: isMultiFile ? 600000 : 300000, // 10 min for multi-file, 5 min for single
            fromChatId: 'jarvis_self_upgrade',
            metadata: { proposalId: proposal.id, isMultiFile, affectedFileCount: allTargetFiles.length }
          }
        );

        // Track ALL file modifications (multi-file aware)
        const modifiedFiles = new Set<string>();
        (global as any).onFileWrittenByTool = (writtenPath: string) => {
          const resolvedWritten = path.resolve(writtenPath);
          const isTargetFile = allTargetFiles.some(t => path.resolve(t.fullPath) === resolvedWritten);
          if (isTargetFile) {
            modifiedFiles.add(resolvedWritten);
            log.info(`[SelfUpgrade] Intercepted file write: ${path.relative(rootDir, writtenPath)} (${modifiedFiles.size}/${allTargetFiles.length})`);
          }
        };

        phaseLog('🤖 Implement', `waiting for ${specialistName} (timeout: ${isMultiFile ? '10' : '5'}min)...`);
        const taskTimeout = isMultiFile ? 600000 : 300000;

        // Heartbeat: print progress every 15s so we know it's not stuck
        const waitStart = Date.now();
        const heartbeat = setInterval(() => {
          const waitSec = Math.round((Date.now() - waitStart) / 1000);
          const modCount = modifiedFiles.size;
          console.log(`\x1b[90m  │  ⏳ ${specialistName} working... ${waitSec}s elapsed${modCount > 0 ? `, ${modCount} file(s) modified so far` : ''}\x1b[0m`);
        }, 15000);

        let result: { status: string; result?: string; error?: string };
        try {
          result = await swarmCoordinator.waitForTaskResult(taskId, taskTimeout);
        } finally {
          clearInterval(heartbeat);
        }
        phaseLog('🤖 Implement', `${specialistName} returned: status=${result.status}`);

        // Track API usage
        try {
          const inTokens = Math.floor(prompt.length / 3.5);
          const outTokens = Math.floor((result.result?.length || 0) / 3.5);
          const agentModel = getSetting('ai_task_code_generation_model') || getSetting('ai_task_agent_model') || getSetting('ai_model') || 'gemini-2.0-flash';
          trackUpgradeTokens(agentModel, inTokens, outTokens);
        } catch (e) { log.warn(`Token tracking estimation failed: ${String(e)}`); }

        (global as any).onFileWrittenByTool = undefined;

        if (result.status === 'completed') {
          // Check if specialist decided to SKIP the proposal
          const resultText = result.result || '';
          if (resultText.includes('SKIP:') || resultText.includes('SKIP —')) {
            const skipReason = resultText.match(/SKIP[:\s—]+(.+?)(?:\n|$)/)?.[1] || 'AI determined fix is unsafe';
            phaseLog('🤖 Implement', `SKIPPED by ${specialistName}: ${skipReason.substring(0, 80)}`);
            console.log(`\x1b[33m  └─ ⏭️  Skipped by AI\x1b[0m`);
            db.prepare(`UPDATE upgrade_proposals SET status = 'skipped', description = description || ? WHERE id = ?`)
              .run(`\n\n[AI SKIP]: ${skipReason}`, id);
            rollbackAll();
            return false;
          }

          // Check which files were actually modified
          let primaryModified = false;
          const newContent = fs.readFileSync(fullPath, 'utf-8');
          primaryModified = newContent !== originalContent;

          // For single-file: fallback extract code block if file wasn't modified by tool
          if (!primaryModified && !isMultiFile && result.result) {
            log.debug(`File unchanged by ${specialistName} tools. Analyzing response string...`);
            const codeBlockRegex = /```[^\n]*\r?\n([\s\S]*?)```/g;
            let match;
            let longestBlock = '';
            while ((match = codeBlockRegex.exec(result.result)) !== null) {
              if (match[1].length > longestBlock.length) longestBlock = match[1];
            }

            if (longestBlock.trim().length > 0) {
              if (longestBlock.length < originalContent.length * 0.4) {
                throw new Error(`${specialistName} generated a truncated response.`);
              }
              log.info(`Applying extracted code block to ${fileName}...`);
              fs.writeFileSync(fullPath, longestBlock, 'utf-8');
              saveUpgradeDiff(id, originalContent, longestBlock);
              primaryModified = true;
            }
          }

          // Check if any files were modified at all
          const totalModified = modifiedFiles.size > 0 ? modifiedFiles.size : (primaryModified ? 1 : 0);
          if (totalModified === 0) {
            phaseLog('🤖 Implement', `${specialistName} completed but NO files modified`);
            throw new Error(`${specialistName} completed the task but did not modify any target file.`);
          }

          phaseLog('🤖 Implement', `${totalModified} file(s) modified by ${specialistName}`);

          // Save diffs for all modified files
          for (const target of allTargetFiles) {
            try {
              const currentContent = fs.readFileSync(target.fullPath, 'utf-8');
              if (currentContent !== target.backup) {
                saveUpgradeDiff(id, target.backup, currentContent);
              }
            } catch { /* skip */ }
          }

          // ── Quick Structural Check (fast, catches bracket/duplicate issues) ──
          phaseLog('🔍 Structure Check', 'validating brackets and declarations...');
          const structErrors: string[] = [];
          for (const target of allTargetFiles) {
            const check = quickStructuralCheck(target.fullPath);
            if (!check.ok) structErrors.push(...check.errors);
          }
          if (structErrors.length > 0) {
            phaseLog('🔍 Structure Check', `FAILED — ${structErrors.length} issue(s)`);
            const errDetail = structErrors.join('; ');

            const logDir = path.resolve(process.cwd(), '../data/upgrade_logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            fs.writeFileSync(path.join(logDir, `proposal_${proposal.id}_rejected.log`), errDetail, 'utf-8');

            rollbackAll();
            console.log(`\x1b[31m  └─ ❌ Structure Check Failed — ${totalModified} file(s) rolled back \x1b[90m(${elapsed()})\x1b[0m`);
            throw new Error(`Structural validation failed: ${errDetail}`);
          }
          phaseLog('🔍 Structure Check', 'PASSED — brackets balanced, no duplicates');

          // ── TSC Verification ──
          phaseLog('🔨 TSC Check', 'running TypeScript compiler...');
          try {
            await verifyUpgrade(rootDir, id);
            phaseLog('🔨 TSC Check', 'PASSED — no new compile errors');
          } catch (tscErr: any) {
            const errMsg = typeof tscErr.stdout === 'string' ? tscErr.stdout : tscErr.message;
            phaseLog('🔨 TSC Check', 'FAILED — new compile errors detected');

            // Write compiler error to log file
            const logDir = path.resolve(process.cwd(), '../data/upgrade_logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const logFilePath = path.join(logDir, `proposal_${proposal.id}_rejected.log`);
            fs.writeFileSync(logFilePath, errMsg, 'utf-8');

            // Rollback ALL files (not just primary)
            rollbackAll();
            console.log(`\x1b[31m  └─ ❌ TSC Failed — ${totalModified} file(s) rolled back \x1b[90m(${elapsed()})\x1b[0m`);
            throw new Error(`Compiler rejected the fix (${totalModified} file(s) rolled back). See log: data/upgrade_logs/proposal_${proposal.id}_rejected.log`);
          }

          // ── esbuild Syntax Check — catch syntax errors TSC misses ──
          phaseLog('🔧 esbuild Check', 'validating syntax for modified files...');
          try {
            const modifiedPaths = allTargetFiles.map(t => t.fullPath);
            await verifyEsbuildSyntax(modifiedPaths, id);
            phaseLog('🔧 esbuild Check', 'PASSED — all files parse cleanly');
          } catch (esbuildErr: any) {
            const errMsg = typeof esbuildErr.stdout === 'string' ? esbuildErr.stdout : esbuildErr.message;
            phaseLog('🔧 esbuild Check', 'FAILED — syntax error detected');

            const logDir = path.resolve(process.cwd(), '../data/upgrade_logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const logFilePath = path.join(logDir, `proposal_${proposal.id}_rejected.log`);
            fs.writeFileSync(logFilePath, errMsg, 'utf-8');

            rollbackAll();
            console.log(`\x1b[31m  └─ ❌ esbuild Failed — ${totalModified} file(s) rolled back \x1b[90m(${elapsed()})\x1b[0m`);
            throw new Error(`esbuild syntax check rejected the fix (${totalModified} file(s) rolled back). See log: data/upgrade_logs/proposal_${proposal.id}_rejected.log`);
          }

          // ── Runtime Boot Test — ลองบูท server จริงดูว่าไม่พัง ──
          phaseLog('🚀 Boot Test', 'spawning test server...');
          try {
            await runtimeBootTest(rootDir, id);
            phaseLog('🚀 Boot Test', 'PASSED — /health responded OK');
          } catch (bootErr: any) {
            const errMsg = bootErr.message || 'Unknown boot error';
            phaseLog('🚀 Boot Test', `FAILED — ${errMsg.substring(0, 80)}`);

            // Write boot error to log file
            const logDir = path.resolve(process.cwd(), '../data/upgrade_logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const logFilePath = path.join(logDir, `proposal_${proposal.id}_boot_rejected.log`);
            fs.writeFileSync(logFilePath, errMsg, 'utf-8');

            // Record lesson for future proposals
            addLearning(
              'error_solutions',
              `Proposal "${proposal.title}" passed TSC but CRASHED at runtime: ${errMsg.substring(0, 200)}`,
              'runtime_boot_test',
              0.8
            );

            // Rollback ALL files
            rollbackAll();
            console.log(`\x1b[31m  └─ ❌ Boot Test Failed — ${totalModified} file(s) rolled back \x1b[90m(${elapsed()})\x1b[0m`);
            throw new Error(`Runtime boot test failed (${totalModified} file(s) rolled back): ${errMsg.substring(0, 300)}`);
          }

          // Mark as implemented — wrap in try/catch to prevent stuck 'implementing' on DB errors.
          // At this point, files are already modified and boot-tested, so we must NOT rollback.
          try {
            updateProposalStatus(id, 'implemented');
          } catch (statusErr: any) {
            log.error(`[SelfUpgrade] CRITICAL: Failed to mark proposal #${id} as implemented (files already modified): ${statusErr.message}`);
            // Retry once with direct SQL
            try {
              db.prepare(`UPDATE upgrade_proposals SET status = 'implemented', reviewed_at = datetime('now') WHERE id = ?`).run(id);
            } catch {
              log.error(`[SelfUpgrade] CRITICAL: Proposal #${id} stuck as 'implementing' — files were modified successfully. Will be caught by stuck-recovery on restart.`);
            }
          }
          invalidateBaselineCache(); // Reset TSC baseline after successful edit

          // Record successful implementation as positive learning (non-critical, ignore errors)
          try {
            addLearning(
              'general',
              `Successfully implemented "${proposal.title}" on ${proposal.file_path} (${isMultiFile ? 'multi-file' : 'single-file'}, ${totalModified} files)`,
              'self_upgrade_success',
              0.6
            );
          } catch { /* non-critical */ }

          try {
            logEvolution('self_upgrade_impl', `Successfully implemented proposal #${id}: ${proposal.title}`, {
              proposalId: id,
              isMultiFile,
              filesModified: totalModified,
              specialist: specialistName,
              passedRuntimeTest: true
            });
          } catch { /* non-critical */ }

          console.log(`\x1b[32m  └─ ✅ Implemented — ${totalModified} file(s) via ${specialistName} \x1b[90m(${elapsed()})\x1b[0m`);
          releaseUpgradeLock();
          return true;
        } else {
          lastError = result.error || 'Unknown error';
          phaseLog('🤖 Implement', `${specialistName} failed: ${(lastError || '').substring(0, 80)}`);
        }
      } catch (err: any) {
        lastError = err.message;
        phaseLog('🤖 Implement', `${specialistName} error: ${(lastError || '').substring(0, 80)}`);
      }

      if (specialistName !== sortedSpecs[sortedSpecs.length - 1]) {
        phaseLog('🔄 Fallback', `trying next specialist...`);
      }
    }

    phaseLog('❌ All Failed', `${sortedSpecs.length} specialists tried, last error: ${(lastError || '').substring(0, 80)}`);
    throw new Error(`All implementation specialists failed for proposal #${proposal.id}. Last error: ${lastError}`);
  } catch (err: any) {
    // Rollback ALL tracked files (multi-file safe)
    for (const target of allTargetFiles) {
      try {
        fs.writeFileSync(target.fullPath, target.backup, 'utf-8');
      } catch { /* best effort */ }
    }

    const errMsg = err.message || '';
    const isQuotaError = /429|RESOURCE_EXHAUSTED|quota|rate.limit/i.test(errMsg);

    // Safety net: Always try to update status out of 'implementing' to prevent stuck proposals.
    // Wrap DB operations in try/catch so disk I/O errors don't leave status stuck.
    try {
      if (isQuotaError) {
        // Don't reject proposal on quota errors — let batch loop handle retry
        db.prepare(`UPDATE upgrade_proposals SET status = 'approved' WHERE id = ?`).run(id);
        console.log(`\x1b[33m  └─ ⚠️ API Quota Error — proposal reset to approved for retry \x1b[90m(${elapsed()})\x1b[0m`);
        releaseUpgradeLock();
        throw err; // Re-throw so batch loop can detect and pause
      }

      db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
        .run(`\n\nAuto-Implement Failed: ${errMsg}`, id);
    } catch (dbErr: any) {
      if (dbErr === err) throw err; // Re-throw quota errors
      log.error(`[SelfUpgrade] DB error while updating proposal #${id} status: ${dbErr.message}`);
      // Last resort: try a simpler update without appending description
      try {
        db.prepare(`UPDATE upgrade_proposals SET status = 'rejected' WHERE id = ? AND status = 'implementing'`).run(id);
      } catch { /* truly best effort — proposal will be caught by stuck-recovery on next restart */ }
    }
    console.log(`\x1b[31m  └─ ❌ Rejected — ${errMsg.substring(0, 100)} \x1b[90m(${elapsed()})\x1b[0m`);
    releaseUpgradeLock();
    return false;
  }
}

// ── Tool Optimization ──

async function discoverToolOpportunities(rootDir: string, batchFiles: string[]): Promise<number> {
  // To avoid heavy operations here initially, we can just log or use LLM 
  // to ask if there are duplicated actions that could be a new tool.
  // We'll pass the content of the batch and ask LLM if it spots any repeated tool logic.
  let toolProposals = 0;
  if (batchFiles.length < 2) return 0;
  
  try {
    const combinedContent = batchFiles.map(f => {
      const rel = path.relative(rootDir, f);
      const code = fs.readFileSync(f, 'utf-8').slice(0, 2000); // Only first 2000 chars per file to save tokens
      return `File: ${rel}\nCode Snippet:\n${code}`;
    }).join('\n\n---\n\n');

    const prompt = `You are Jarvis. Analyze these files to see if there are repeated patterns (e.g., duplicated fetch+parse logic, repetitive data formatting) that would be better served by creating a NEW TOOL.
If you find a strong opportunity for a new tool, return a JSON array of tool proposals:
[
  {
    "title": "Create tool: xyz",
    "description": "Why this tool is useful and what it should do based on the duplicated patterns in these files.",
    "suggested_fix": "Tool specification / interface details"
  }
]
Return purely JSON array. Do not wrap in markdown \`\`\`json. Return [] if no strong tool opportunities.

Files context:
${combinedContent}`;

    const response = await aiChat('chat', [{ role: 'user', content: prompt }], { model: 'gemini-2.0-flash' });
    const match = response.text.match(/\\[[\\s\\S]*\\]/);
    if (match) {
      const issues = JSON.parse(match[0]);
      for (const issue of issues) {
        const result = insertProposal({
          type: 'tool',
          title: issue.title || 'New Tool Opportunity',
          description: issue.description || 'No description provided',
          file_path: 'multiple_files',
          suggested_fix: issue.suggested_fix || null,
          priority: 'medium',
          status: 'pending',
          model_used: 'gemini-2.0-flash',
          confidence: 0.7
        });
        if (result.isNew) toolProposals++;
      }
    }
  } catch (err: any) {
    log.warn(`Tool discovery failed: ${err.message}`);
  }
  return toolProposals;
}

async function implementPendingProposals(rootDir: string): Promise<number> {
  const db = getDb();
  // Fetch up to 3 approved OR pending proposals (prioritize 'approved' items if any exist)
  const toProcess = db.prepare(`
    SELECT id FROM upgrade_proposals 
    WHERE status IN ('approved', 'pending') 
    ORDER BY status = 'approved' DESC, priority DESC, id ASC 
    LIMIT 3
  `).all() as { id: number }[];
  
  if (toProcess.length === 0) return 0;

  let implementedCount = 0;
  for (const row of toProcess) {
    const success = await implementProposalById(row.id, rootDir);
    if (success) implementedCount++;
  }
  return implementedCount;
}

// ── Learning Feedback Loop ──

async function learnFromResults(): Promise<number> {
  let learningsAdded = 0;
  const db = getDb();
  
  // 1. Analyze rejected proposals (only unreviewed ones)
  const rejected = db.prepare(`SELECT * FROM upgrade_proposals WHERE status = 'rejected' AND reviewed_at IS NULL LIMIT 5`).all() as UpgradeProposal[];
  for (const p of rejected) {
    addLearning('error_solutions', `Auto-implement failed for pattern: ${p.title}. Reason: ${p.description}`, 'self_upgrade', 0.8);
    // Mark as reviewed so we don't process it again for learning, but preserve its 'rejected' status so it remains visible in the Dashboard 
    db.prepare(`UPDATE upgrade_proposals SET reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.id);
    learningsAdded++;
  }
  
  // 2. Analyze implemented proposals (only unreviewed ones)
  const implemented = db.prepare(`SELECT * FROM upgrade_proposals WHERE status = 'implemented' AND reviewed_at IS NULL LIMIT 5`).all() as UpgradeProposal[];
  for (const p of implemented) {
    addLearning('performance', `Successfully auto-implemented pattern: ${p.title}`, 'self_upgrade', 0.9);
    // Mark as reviewed to avoid duplicate learning loops
    db.prepare(`UPDATE upgrade_proposals SET reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(p.id);
    learningsAdded++;
  }
  
  return learningsAdded;
}

// ── Export to Markdown for Developer Agents ──

export async function exportProposalsToMarkdown(rootDir: string): Promise<void> {
  try {
    const db = getDb();
    const proposals = db.prepare(`SELECT * FROM upgrade_proposals WHERE status = 'pending' ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC`).all() as UpgradeProposal[];
    
    // We will save this next to the `server/data` directory as `pending_upgrades.md`
    const exportPath = path.resolve(rootDir, '../data/pending_upgrades.md');
    const dataDir = path.dirname(exportPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (proposals.length === 0) {
      fs.writeFileSync(exportPath, '# No Pending Upgrades\n\nAll clear! The AI has not found any new bugs or improvements during the last scan.\n', 'utf-8');
      return;
    }

    let md = '# 🤖 Pending Self-Evolution Proposals\n\n';
    md += '> **Attention Developer Agent (e.g. Antigravity):**\n';
    md += '> This file contains autonomous findings from the Self-Evolution system.\n';
    md += '> To resolve an issue, locate the file, apply the suggested fix, and then update the database status for this proposal via the `/api/upgrade/proposals/:id` API or directly in DB to `implemented`.\n\n';

    // Grouping
    const bugs = proposals.filter(p => p.type === 'bug' || p.type === 'security');
    const others = proposals.filter(p => p.type !== 'bug' && p.type !== 'security');

    const renderProposal = (p: UpgradeProposal) => {
      let snippet = `### [${p.priority.toUpperCase()}] #${p.id}: ${p.title}\n`;
      snippet += `- **Type**: ${p.type}\n`;
      snippet += `- **File**: \`${p.file_path}\`${p.line_range ? ` (Lines: ${p.line_range})` : ''}\n`;
      snippet += `- **Confidence**: ${Math.round(p.confidence * 100)}%\n\n`;
      snippet += `**Description:**\n${p.description}\n\n`;
      if (p.suggested_fix) {
         snippet += `**Suggested Fix:**\n\`\`\`typescript\n${p.suggested_fix}\n\`\`\`\n\n`;
      }
      snippet += `---\n\n`;
      return snippet;
    };

    if (bugs.length > 0) {
      md += '## 🚨 Bugs & Security Issues\n\n';
      bugs.forEach(p => md += renderProposal(p));
    }

    if (others.length > 0) {
      md += '## 🛠️ Optimizations & Refactors\n\n';
      others.forEach(p => md += renderProposal(p));
    }

    fs.writeFileSync(exportPath, md, 'utf-8');
    log.info(`Exported ${proposals.length} pending proposals to ${exportPath}`);
  } catch (err: any) {
    log.error('Failed to export proposals to markdown', { error: err.message });
  }
}

// ── Main Upgrade Cycle ──

async function runUpgradeCycle(rootDir: string, forceStart: boolean = false): Promise<void> {
  if (isUpgrading) return;
  if (!forceStart && (_paused || !isSystemIdle())) return;
  isUpgrading = true;

  try {
    log.info(`Self-upgrade cycle starting (idle ${Math.round((Date.now() - lastUserActivity) / 60000)}min)${DRY_RUN ? ' [DRY RUN]' : ''}`);
    addLog('evolution', 'Self-Upgrade', 'เริ่มรอบสแกนอัตโนมัติ', 'info');

    // Queue Zero First: Auto-implement approved or pending proposals
    // Native Bypass: If user is running a Manual Continuous Scan, they
    // normally start with `_paused=true` so Auto-Implement is skipped.
    // If they explicitly unpause, we allow Auto-Implement to run.
    if (!_paused && !DRY_RUN) {
      const implemented = await implementPendingProposals(rootDir);
      if (implemented > 0) {
        log.info(`[SelfUpgrade] Implemented ${implemented} pending tasks. Yielding scan to next cycle to prevent backlog.`);
        isUpgrading = false;
        return;
      }
    }

    const scanResult = await scanBatch(rootDir, forceStart);
    const llmFindings = await analyzeBatchWithLLM(rootDir, scanResult.batchProcessed);
    
    // Discover tools
    const toolProposals = await discoverToolOpportunities(rootDir, scanResult.batchProcessed);
    
    // Learning Feedback Loop
    const learnings = await learnFromResults();

    const totalFindings = scanResult.totalFindings + llmFindings + toolProposals + learnings;
    const totalNew = scanResult.newFindings + llmFindings + toolProposals + learnings;

    if (totalFindings > 0) {
      // Export current pending proposals to Markdown for Antigravity AI
      await exportProposalsToMarkdown(rootDir);

      logEvolution('self_upgrade_scan', `Scanned ${SCAN_BATCH_SIZE} files, found ${totalFindings} issues (${totalNew} new)`, {
        cursor: _scanCursor,
        totalFiles: _fileIndex.length,
        dryRun: DRY_RUN,
      });
      addLog('evolution', 'Self-Upgrade', `พบ ${totalFindings} ข้อเสนอจาก ${SCAN_BATCH_SIZE} ไฟล์ (${totalNew} รายการใหม่)`, 'info');
    }

    log.info(`Upgrade cycle complete: ${totalFindings} findings (${totalNew} new) from batch at cursor ${_scanCursor}/${_fileIndex.length}`);
  } catch (err: any) {
    log.error('Upgrade cycle failed', { error: err.message });
  } finally {
    isUpgrading = false;
  }
}

// ── Public API ──

/**
 * Start the self-upgrade background loop
 * @param rootDir - Project root to scan (e.g. path to server/src)
 */
export function startSelfUpgrade(rootDir: string): void {
  if (upgradeInterval) {
    log.warn('Self-upgrade already running');
    return;
  }

  ensureUpgradeTable();

  _currentRootDir = rootDir;

  // Load persisted configuration
  const savedIdle = import('../database/db.js').then(db => db.getSetting('upgrade_idle_threshold_ms'));
  const savedInterval = import('../database/db.js').then(db => db.getSetting('upgrade_scan_interval_ms'));

  Promise.all([savedIdle, savedInterval]).then(async ([idle, interval]) => {
    if (idle) IDLE_THRESHOLD_MS = parseInt(idle);
    if (interval) CHECK_INTERVAL_MS = parseInt(interval);
    
    log.info(`Self-Upgrade System initialized (idle threshold: ${IDLE_THRESHOLD_MS / 60000}min, check every ${CHECK_INTERVAL_MS / 60000}min, dry_run: ${DRY_RUN})`);

    // Initial activity stamp
    lastUserActivity = Date.now();

    upgradeInterval = setInterval(() => {
      runUpgradeCycle(rootDir, false).catch(err => {
        log.error('Upgrade cycle error', { error: String(err) });
      });
    }, CHECK_INTERVAL_MS);

    // --- Persistent State Restoration ---
    try {
      const dbModule = await import('../database/db.js');
      
      // 0. Restore Auto-Upgrade Pause State
      const isPaused = dbModule.getSetting('upgrade_paused');
      if (isPaused === 'true') {
        _paused = true;
        log.info('[SelfUpgrade] Auto-Upgrade is globally PAUSED from previous session.');
      } else if (isPaused === 'false') {
        _paused = false;
        log.info('[SelfUpgrade] Auto-Upgrade is running normally.');
      }

      // 1. Restore Continuous Scan State
      const isContinuous = dbModule.getSetting('upgrade_continuous_scan');
      if (isContinuous === 'true') {
        log.info('[SelfUpgrade] Resuming Continuous Scan mode after server restart...');
        // Only flip _paused externally if you want it explicitly paused on boot,
        // but since they left it ON, it should resume with _paused = true (default for manual scans)
        _paused = true; 
        executeContinuousStart(rootDir);
      }
      
      // 2. Resume Batch Implementation (Queue Zero)
      const isBatching = dbModule.getSetting('upgrade_implement_all');
      if (isBatching === 'true') {
        import('./selfUpgrade.js').then(({ resumeBatchImplementation }) => {
           resumeBatchImplementation(rootDir);
        });
      }
    } catch (err: any) {
      log.warn(`[SelfUpgrade] Failed to restore state from DB: ${err.message}`);
    }
  });
}

/** Stop the self-upgrade loop */
export function stopSelfUpgrade(): void {
  if (upgradeInterval) {
    clearInterval(upgradeInterval);
    upgradeInterval = null;
    log.info('Self-Upgrade System stopped');
  }
  if (_continuousScanTimeout) {
    clearTimeout(_continuousScanTimeout);
    _continuousScanTimeout = null;
  }
  _isManualScanActive = false;
}

/** Toggle pause status of the self-upgrade loop */
export function setUpgradePaused(paused: boolean): void {
  _paused = paused;
  import('../database/db.js').then(({ setSetting }) => {
    setSetting('upgrade_paused', paused ? 'true' : 'false');
  });
  log.info(`Self-Upgrade System ${paused ? 'Paused' : 'Resumed'}`);
}

/** Get current upgrade system status */
export function getUpgradeStatus(): {
  running: boolean;
  paused: boolean;
  isIdle: boolean;
  idleMinutes: number;
  idleThresholdMinutes: number;
  checkIntervalMs: number;
  scanProgress: { cursor: number; total: number; percent: number };
  dryRun: boolean;
  isContinuousActive: boolean;
} {
  const idleMs = getOsIdleTimeMs();
  const total = _fileIndex.length || 1;
  return {
    running: !!upgradeInterval || !!_continuousScanTimeout,
    isContinuousActive: !!_continuousScanTimeout,
    paused: _paused,
    isIdle: _isManualScanActive ? false : isSystemIdle(), // Manual scan doesn't count as "Idle" system
    idleMinutes: _isManualScanActive ? 0 : Math.round(idleMs / 60000), // Stop showing huge/fake idle times during manual scan
    idleThresholdMinutes: Math.round(IDLE_THRESHOLD_MS / 60000),
    checkIntervalMs: CHECK_INTERVAL_MS,
    scanProgress: {
      cursor: _scanCursor,
      total: _fileIndex.length,
      percent: Math.round((_scanCursor / total) * 100),
    },
    dryRun: DRY_RUN,
  };
}

/** Update scan configuration and restart loop if needed */
export async function updateUpgradeConfig(config: { intervalMs?: number, idleThresholdMs?: number }): Promise<void> {
  const { setSetting } = await import('../database/db.js');
  
  if (config.intervalMs) {
    CHECK_INTERVAL_MS = config.intervalMs;
    setSetting('upgrade_scan_interval_ms', String(CHECK_INTERVAL_MS));
    log.info(`Scan interval updated to ${CHECK_INTERVAL_MS / 60000}min`);
  }
  
  if (config.idleThresholdMs) {
    IDLE_THRESHOLD_MS = config.idleThresholdMs;
    setSetting('upgrade_idle_threshold_ms', String(IDLE_THRESHOLD_MS));
    log.info(`Idle threshold updated to ${IDLE_THRESHOLD_MS / 60000}min`);
  }

  // Restart loop to apply new interval
  if (upgradeInterval && config.intervalMs) {
    stopSelfUpgrade();
    if (_currentRootDir) startSelfUpgrade(_currentRootDir);
  }
}

/** Force a single scan cycle (Legacy endpoint) */
export async function forceScan(rootDir: string): Promise<{ totalFindings: number; newFindings: number }> {
  if (isUpgrading) return { totalFindings: 0, newFindings: 0 };
  isUpgrading = true;
  _paused = false;
  try {
    const res = await scanBatch(rootDir, true);
    if (res.totalFindings > 0) {
      await exportProposalsToMarkdown(rootDir);
    }
    return { totalFindings: res.totalFindings, newFindings: res.newFindings };
  } finally {
    isUpgrading = false;
  }
}

/**
 * Internal logic to start the Continuous Scan loop securely.
 */
function executeContinuousStart(rootDir: string): void {
  _isManualScanActive = true;
  if (_continuousScanTimeout) return;
  
  const cycle = async () => {
    // Yield to bot interaction safely honoring the user's configured Idle Threshold
    if (Date.now() - lastUserActivity < IDLE_THRESHOLD_MS) {
      // Schedule next check without running upgrade (preserves the continuous scan loop)
      _continuousScanTimeout = setTimeout(cycle, 5000);
      return;
    }
    
    try {
      await runUpgradeCycle(rootDir, true);
    } catch (err: any) {
      log.warn(`Continuous scan cycle error: ${err.message}`);
    }

    // Schedule next batch safely in 5 seconds
    _continuousScanTimeout = setTimeout(cycle, 5000);
  };
  
  // Kick off first cycle immediately
  _continuousScanTimeout = setTimeout(cycle, 100);
}

/** 
 * Toggle Continuous Scan Loop
 * Starts or stops the native continuous scan batch.
 */
export async function toggleContinuousScan(rootDir: string): Promise<boolean> {
  const { setSetting } = await import('../database/db.js');

  if (_continuousScanTimeout) {
    clearTimeout(_continuousScanTimeout);
    _continuousScanTimeout = null;
    _isManualScanActive = false;
    setSetting('upgrade_continuous_scan', 'false');
    log.info('Continuous scan mode stopped explicitly.');
    return false;
  }

  // Set Paused = true so that Auto-Upgrade yields natively in Dashboard UI
  _paused = true;
  setSetting('upgrade_continuous_scan', 'true');
  
  log.info('Continuous scan mode requested');
  executeContinuousStart(rootDir);
  
  return true;
}
