// ============================================================
// Self-Upgrade System — ระบบอัพเกรดตัวเองอัตโนมัติ
// ============================================================
// เมื่อ Jarvis ว่างงาน 30+ นาที จะเริ่ม:
// 1. อ่าน/ศึกษา codebase ทีละไฟล์
// 2. บันทึกความรู้ลง DB
// 3. หาบัค หาจุดบกพร่อง
// 4. เสนอแผนอัพเกรด (ช่วงทดสอบ: เสนอเท่านั้น ไม่ลงมือทำ)
// 5. ใช้ dynamic model switching ตาม task

import { getDb, addLog, trackUpgradeTokens, resetUpgradeStats, getSetting, setSetting, upsertCodebaseNode, searchCodebaseMapByDependencies } from '../database/db.js';
import * as diff from 'diff';
import { createLogger } from '../utils/logger.js';
import { logEvolution, addLearning } from './learningJournal.js';
import { generateTestForChange, runGeneratedTest } from './testGenerator.js';
import { refactorManager } from './refactorManager.js';
import { Node } from 'ts-morph';
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

function getImplementModel(): string {
  // Use premium Code or Agent Model for actual patching/implementation
  // Fallback is empty string — provider runtime resolves to the first enabled provider's default
  return getSetting('ai_task_code_generation_model') || getSetting('ai_task_agent_model') || getSetting('ai_model') || '';
}

function getScanModel(): string {
  // Use fast, cheaper model for bulk context scanning
  // Fallback is empty string — provider runtime resolves to the first enabled provider's default
  return getSetting('ai_task_system_model') || getSetting('ai_task_data_model') || getSetting('ai_model') || '';
}

// ── Configuration ──
let IDLE_THRESHOLD_MS = 1 * 60 * 1000;      // 1 นาที default (อิงจากการโต้ตอบแชท)
let CHECK_INTERVAL_MS = 30 * 60 * 1000;     // 30 นาที default
const SCAN_BATCH_SIZE = 3;                      // อ่านทีละ 3 ไฟล์
const MAX_FILE_SIZE_BYTES = 100 * 1024;         // ข้ามไฟล์ > 100KB
const ANALYSIS_DELAY_MS = 2000;                 // delay ระหว่างไฟล์
const MAX_LLM_CALLS_PER_CYCLE = 5;              // จำกัด LLM call ต่อรอบ
const CHUNK_TOKEN_THRESHOLD = 2000;             // ไฟล์ที่มี token > threshold จะถูก chunk
const APPROX_CHARS_PER_TOKEN = 3.5;             // ค่าประมาณ chars/token สำหรับ TypeScript
let DRY_RUN = false;                            // true = เสนอเท่านั้น, false = แก้ไขอัตโนมัติ

function refreshConfig() {
  try {
    const idleMin = parseInt(getSetting('upgrade_idle_threshold') || '1', 10);
    IDLE_THRESHOLD_MS = idleMin * 60 * 1000;

    const intervalMs = parseInt(getSetting('upgrade_check_interval') || '1800000', 10);
    CHECK_INTERVAL_MS = intervalMs;

    // Auto-Fix default: ENABLED (DRY_RUN=false) unless explicitly disabled
    // getSetting returns null if key doesn't exist → treat as enabled
    const autoFixSetting = getSetting('upgrade_auto_fix');
    DRY_RUN = autoFixSetting === 'false';  // Only disable if explicitly set to 'false'

    // Default to paused=true (OFF) unless explicitly set to 'false' in DB
    const pausedSetting = getSetting('upgrade_paused');
    _paused = pausedSetting !== 'false';  // null/undefined/'true' → paused; only 'false' → running
  } catch (err) {
    log.error('Failed to refresh config from DB', { error: err });
  }
}

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
    
    // Check if the process that created the lock is still alive
    let isAlive = false;
    if (lock.pid) {
      try {
        process.kill(lock.pid, 0);
        isAlive = true;
      } catch (e) {
        // process.kill(pid, 0) throws if process doesn't exist
        isAlive = false;
      }
    }

    // Lock expires after 12 minutes OR if the process is dead
    if (!isAlive || (Date.now() - lock.startedAt > 720000)) {
      log.info(`[SelfUpgrade] Releasing stale/dead lock (isAlive=${isAlive}, age=${Math.round((Date.now() - lock.startedAt)/1000)}s)`);
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
let _paused = true;  // Default: OFF on first start — user must explicitly enable
let _scanCursor = 0;     // ตำแหน่งที่สแกนถึง
let _fileIndex: string[] = [];
let _initialized = false;
let _coldBootFlagPath = '';

export async function resumeBatchImplementation(rootDir: string): Promise<void> {
  const db = getDb();

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
  
  clearColdBootFlag();

  if (initialApprovedCount > 0) {
    console.log(`\n\x1b[36m╔══════════════════════════════════════════════════════════╗\x1b[0m`);
    console.log(`\x1b[36m║  Self-Upgrade Batch: ${initialApprovedCount} approved proposals queued          ║\x1b[0m`);
    console.log(`\x1b[36m╚══════════════════════════════════════════════════════════╝\x1b[0m`);
  }

  while (getSetting('upgrade_implement_all') === 'true') {
    const nextProposal = db.prepare(`
      SELECT id, title FROM upgrade_proposals
      WHERE status = 'approved'
      ORDER BY CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC, created_at ASC
      LIMIT 1
    `).get() as { id: number; title: string } | undefined;

    if (!nextProposal) {
      // Check if there are any still 'implementing' — if so, wait for recovery to finish
      const stuckCount = db.prepare(`SELECT COUNT(*) as count FROM upgrade_proposals WHERE status = 'implementing'`).get() as { count: number };
      if (stuckCount && stuckCount.count > 0 && currentTaskNumber < 10) { 
        // We use currentTaskNumber (re-purposed as wait counter here since it's the first iteration) 
        // to prevent infinite waiting if recovery fails
        console.log(`\x1b[33m  └─ Waiting for ${stuckCount.count} 'implementing' proposals to be recovered (Attempt ${currentTaskNumber}/10)...\x1b[0m`);
        await new Promise(resolve => setTimeout(resolve, 5000));
        currentTaskNumber++; 
        continue; 
      }
      
      setSetting('upgrade_implement_all', 'false');
      console.log(`\x1b[32m  └─ No more approved proposals found. Batch mode deactivated.\x1b[0m`);
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
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'implemented' | 'implementing' | 'review_diff';
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
    
    // 1. Ensure Upgrade Tables are ready (now handled by db.ts migrations, 
    // but we keep this as a secondary check for indices/logs)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_upgrade_status ON upgrade_proposals(status, priority);
      CREATE TABLE IF NOT EXISTS upgrade_scan_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        file_hash TEXT,
        findings_count INTEGER DEFAULT 0,
        scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_scan_file ON upgrade_scan_log(file_path);
    `);
    
    // 2. Auto-recovery: If the server crashed while 'implementing'
    if (isUpgradeLockActive()) {
      log.info('Upgrade lock is active — skipping stuck proposal recovery (another process is still working)');
    } else {
      const stuckProposals = db.prepare("SELECT id, description FROM upgrade_proposals WHERE status = 'implementing'").all() as { id: number; description: string }[];
      let resetCount = 0;
      let rejectCount = 0;
      for (const stuck of stuckProposals) {
        const retryMarkers = (stuck.description?.match(/\[Retry #\d+\]/g) || []).length;
        if (retryMarkers >= 2) {
          db.prepare("UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?")
            .run(`\n\n[Auto-Rejected]: Stuck in 'implementing' after ${retryMarkers + 1} attempts. Likely un-implementable.`, stuck.id);
          rejectCount++;
        } else {
          db.prepare("UPDATE upgrade_proposals SET status = 'approved', description = description || ? WHERE id = ?")
            .run(`\n[Retry #${retryMarkers + 1}]: Reset from 'implementing' after server restart.`, stuck.id);
          resetCount++;
        }
      }
      if (resetCount > 0) log.info(`Recovered ${resetCount} stuck proposals from 'implementing' back to 'approved'`);
      if (rejectCount > 0) log.warn(`Auto-rejected ${rejectCount} proposals that were stuck in 'implementing' after 3+ attempts`);
    }

    log.info('Upgrade tables ensured and recovery check complete');
  } catch (err: any) {
    log.error('Failed to ensure upgrade table or recover stuck proposals', { error: err.message });
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
  refreshConfig(); // Refresh before checking
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
    'api/routes.ts',
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

    // Skip if a similar fix was already implemented for the same file recently
    // (prevents "fix already implemented" planning rejections)
    const recentlyImplemented = db.prepare(
      `SELECT id FROM upgrade_proposals WHERE file_path = ? AND status = 'implemented' AND title = ? AND created_at > datetime('now', '-14 days') LIMIT 1`
    ).get(normalizedPath, proposal.title);
    if (recentlyImplemented) {
      log.debug(`Skipped proposal — same fix already implemented for ${normalizedPath}`);
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

export function deleteAllProposals(): number {
  try {
    const result = getDb().prepare('DELETE FROM upgrade_proposals').run();
    return (result as any).changes || 0;
  } catch (err: any) {
    log.error(`Failed to delete all proposals: ${err.message}`);
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
  try { setSetting('upgrade_scan_cursor', String(_scanCursor)); } catch { /* ignore */ }

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

// ── File Chunking for Large Files ──

/**
 * Split a large file into function-level chunks for LLM analysis.
 * Uses regex-based extraction (fast) instead of full AST parsing.
 * Each chunk includes file header (imports) + one function/class body.
 */
function chunkFileByFunctions(content: string, filePath: string): Array<{ chunkLabel: string; code: string }> {
  const lines = content.split('\n');

  // Extract import section (always included in every chunk as context)
  const importLines: string[] = [];
  let bodyStartLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('import ') || trimmed.startsWith('import{') || trimmed.startsWith('from ') ||
        (trimmed === '' && importLines.length > 0 && i < 30)) {
      importLines.push(lines[i]);
      bodyStartLine = i + 1;
    } else if (importLines.length > 0 && !trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*') && trimmed !== '') {
      break;
    }
  }
  const importHeader = importLines.join('\n');

  // Find function/class boundaries using brace counting
  const chunks: Array<{ chunkLabel: string; code: string }> = [];
  let currentChunkStart = -1;
  let currentChunkLabel = '';
  let braceDepth = 0;
  let inChunk = false;

  for (let i = bodyStartLine; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Detect function/class/interface/type declaration at top-level (braceDepth 0)
    if (!inChunk && braceDepth === 0) {
      const declMatch = trimmed.match(
        /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let)\s+(\w+)/
      );
      if (declMatch) {
        currentChunkStart = i;
        currentChunkLabel = declMatch[1];
        inChunk = true;
      }
    }

    // Count braces
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // When braces close back to 0, this function/class is complete
    if (inChunk && braceDepth <= 0) {
      const chunkCode = lines.slice(currentChunkStart, i + 1).join('\n');
      chunks.push({ chunkLabel: currentChunkLabel, code: chunkCode });
      inChunk = false;
      braceDepth = 0;
      currentChunkStart = -1;
    }
  }

  // If no functions found or only one small chunk, return the whole file
  if (chunks.length === 0) {
    return [{ chunkLabel: path.basename(filePath), code: content }];
  }

  // Group small consecutive chunks together (merge adjacent functions < 500 chars)
  const mergedChunks: Array<{ chunkLabel: string; code: string }> = [];
  let pending = { chunkLabel: '', code: '' };

  for (const chunk of chunks) {
    if (pending.code.length + chunk.code.length < CHUNK_TOKEN_THRESHOLD * APPROX_CHARS_PER_TOKEN) {
      pending.chunkLabel = pending.chunkLabel ? `${pending.chunkLabel}, ${chunk.chunkLabel}` : chunk.chunkLabel;
      pending.code = pending.code ? `${pending.code}\n\n${chunk.code}` : chunk.code;
    } else {
      if (pending.code) mergedChunks.push(pending);
      pending = { ...chunk };
    }
  }
  if (pending.code) mergedChunks.push(pending);

  // Prepend import header to each chunk
  return mergedChunks.map(c => ({
    chunkLabel: c.chunkLabel,
    code: `${importHeader}\n\n// ── Chunk: ${c.chunkLabel} ──\n${c.code}`,
  }));
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

      // ── File Chunking: split large files into function-level chunks ──
      const estimatedTokens = Math.ceil(content.length / APPROX_CHARS_PER_TOKEN);
      const chunks = estimatedTokens > CHUNK_TOKEN_THRESHOLD
        ? chunkFileByFunctions(content, filePath)
        : [{ chunkLabel: path.basename(filePath), code: content }];

      if (chunks.length > 1) {
        log.info(`[SelfUpgrade] File "${relPath}" (~${estimatedTokens} tokens) split into ${chunks.length} chunks for analysis`);
      }

      for (const chunk of chunks) {
      if (llmCalls >= MAX_LLM_CALLS_PER_CYCLE) break;

      const chunkContent = chunk.code;
      const chunkInfo = chunks.length > 1 ? ` [Chunk: ${chunk.chunkLabel}]` : '';

      const prompt = `You are an expert TypeScript code reviewer performing a codebase audit.
Your primary focus MUST be finding critical bugs and security vulnerabilities that WILL crash the server or corrupt data at runtime.
However, you are also allowed to report highly valuable improvements in performance, refactoring, new features, or tool usage if they are significant.

FILE: "${relPath}"${chunkInfo}

PRIORITY 1 - WHAT TO ACTIVELY REPORT (CRITICAL):
- Uncaught exceptions, null/undefined dereferences that will throw at runtime
- Incorrect function calls, type mismatches that crash JS
- Resource leaks, Infinite loops, race conditions
- SQL/NoSQL injection paths or explicit security flaws

PRIORITY 2 - OTHER ACCEPTABLE REPORTS (ONLY IF SIGNIFICANT):
- Performance bottlenecks (e.g., N+1 queries, unnecessary deep cloning)
- Refactor opportunities (e.g., extracting massive functions, deduplicating logic)
- Missing features or absent tool integrations that would greatly enhance functionality

WHAT TO NEVER REPORT (STRICT RULES):
- Minor style issues, naming conventions, code organization preferences
- Missing logging, comments, documentation
- TypeScript type-only issues (that don't crash at runtime)
- Redundant null checks (safe code is GOOD code)
- Issues in other files — you can ONLY see "${relPath}"
- BUGS THAT ARE ALREADY FIXED: If an object is already safely null-checked, DO NOT report it.

YOUR SUGGESTED FIX RULES:
- Must be a MINIMAL valid TypeScript snippet (only the changed lines)
- Must preserve ALL existing closing brackets }, ), ]
- Must NOT add imports for packages not in the project
- Must NOT change function signatures or export names
- If unsure → set confidence below 0.5 (it will be auto-filtered)

Respond in pure JSON (no markdown wrapping) matching exactly this structure:
{
  "architecture": {
    "summary": "Brief 1-2 sentence explanation of this file's purpose",
    "exports": ["ClassA", "functionB"],
    "dependencies": ["../database/db", "fs"]
  },
  "issues": [
    {"type":"bug"|"feature"|"performance"|"refactor"|"security"|"tools","title":"Short title","description":"What crashes or what can be improved","line_range":"10-15","suggested_fix":"minimal fix code","priority":"low"|"medium"|"high"|"critical","confidence":0.0-1.0}
  ]
}

If no issues are found, return an empty array for "issues": []
Be conservative — false negatives are OK, false positives waste resources.

EXAMPLE OUTPUT (for reference — adapt to actual findings):
{
  "architecture": {
    "summary": "Manages WebSocket connections for real-time messaging",
    "exports": ["WebSocketManager", "broadcastMessage"],
    "dependencies": ["../database/db", "ws", "../utils/logger"]
  },
  "issues": [
    {
      "type": "bug",
      "title": "Uncaught null dereference in broadcastMessage",
      "description": "client.socket can be null after disconnect, but send() is called without null check at line 45. Will throw TypeError at runtime when broadcasting to disconnected clients.",
      "line_range": "44-46",
      "suggested_fix": "if (client.socket && client.socket.readyState === WebSocket.OPEN) { client.socket.send(data); }",
      "priority": "high",
      "confidence": 0.9
    }
  ]
}

Code:
${chunkContent}`;

      const modelName = getScanModel();
      const response = await aiChat('chat', [{ role: 'user', content: prompt }], { model: modelName });
      llmCalls++;

      // Track usage
      if (response.usage) {
        trackUpgradeTokens(modelName, response.usage.promptTokens || 0, response.usage.completionTokens || 0);
      }

      // Better JSON extraction logic to ignore markdown and unparsed trailing text
      let matchText = response.text || '';
      const mdMatch = matchText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (mdMatch) matchText = mdMatch[1];

      try {
        let parsed: any = null;
        try {
          parsed = JSON.parse(matchText);
        } catch {
          const objMatch = matchText.match(/\{[\s\S]*\}/);
          if (objMatch) parsed = JSON.parse(objMatch[0]);
        }

        if (parsed) {
          // 1. Save Architecture to Second Brain (only on first chunk or whole-file analysis)
          if (parsed.architecture && chunk === chunks[0]) {
            upsertCodebaseNode(
              relPath,
              parsed.architecture.summary || '',
              Array.isArray(parsed.architecture.exports) ? parsed.architecture.exports : [],
              Array.isArray(parsed.architecture.dependencies) ? parsed.architecture.dependencies : []
            );
            log.info(`🧠 Mapped codebase node: ${relPath}`);

            // Static analysis: extract typed exports + call graph (no LLM cost)
            updateSecondBrainStaticAnalysis(rootDir, relPath, content);
          }

          // 2. Process Bug Proposals
          const issues = Array.isArray(parsed.issues) ? parsed.issues : (Array.isArray(parsed) ? parsed : []);
          if (issues.length > 0) {
            for (const issue of issues) {
              if (!issue.title && !issue.description) continue;
              const result = insertProposal({
                type: issue.type || 'refactor',
                title: issue.title || 'LLM Suggestion',
                description: issue.description || 'No description provided',
                file_path: relPath,
                line_range: issue.line_range || null,
                suggested_fix: issue.suggested_fix || null,
                priority: issue.priority || 'medium',
                status: 'pending',
                model_used: modelName,
                confidence: issue.confidence || 0.8
              });
              if (result.isNew) llmFindings++;
            }
            log.debug(`LLM analyzed ${relPath}${chunkInfo}: ${issues.length} findings`);
          }
        }
      } catch (parseErr: any) {
        log.warn(`LLM returned invalid JSON for ${relPath}${chunkInfo}. Parse error: ${parseErr.message}`);
      }

      // Rate limiting delay between LLM calls
      await new Promise(r => setTimeout(r, ANALYSIS_DELAY_MS));

      } // end chunk loop
    } catch (err: any) {
      const errMsg = err.message || '';
      if (/429|RESOURCE_EXHAUSTED|quota|rate.limit/i.test(errMsg)) {
        log.warn(`[SelfUpgrade] API quota exhausted during scan. Stopping scan early.`);
        console.log(`\x1b[33m  ⚠️ API quota exhausted — scan paused. Will resume on next cycle.\x1b[0m`);
        break; // Stop scanning, don't waste more calls
      }
      log.warn(`LLM analysis failed for ${filePath}: ${errMsg}`);
    }
  }

  return llmFindings;
}

// ── Second Brain: Map Protected Core Files (read-only architecture) ──

/**
 * Protected Core Files are invisible to the scanner (no proposals created),
 * but their architecture MUST be in Second Brain so the AI specialist understands
 * what they export and depend on when editing files that import from them.
 *
 * Uses lightweight static analysis (no LLM calls) — parses import/export lines directly.
 */
async function mapProtectedCoresToSecondBrain(rootDir: string): Promise<void> {
  const PROTECTED_CORE_FILES = new Set([
    'index.ts', 'config.ts', 'configValidator.ts',
    'database/db.ts', 'evolution/selfUpgrade.ts', 'evolution/selfReflection.ts',
    'terminal/terminalGateway.ts', 'api/routes.ts', 'api/socketHandlers.ts', 'api/upgradeRoutes.ts',
    'automation/chatBot.ts', 'automation/browser.ts',
    'bot_agents/tools/index.ts', 'bot_agents/agent.ts',
  ]);

  let mapped = 0;
  for (const relPath of PROTECTED_CORE_FILES) {
    try {
      const fullPath = path.join(rootDir, relPath);
      if (!fs.existsSync(fullPath)) continue;
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      // Extract exports via regex
      const exports: string[] = [];
      for (const line of lines) {
        // export function foo / export async function foo
        const fnMatch = line.match(/export\s+(?:async\s+)?function\s+(\w+)/);
        if (fnMatch) { exports.push(fnMatch[1]); continue; }
        // export class Foo
        const clsMatch = line.match(/export\s+class\s+(\w+)/);
        if (clsMatch) { exports.push(clsMatch[1]); continue; }
        // export const/let/var foo
        const varMatch = line.match(/export\s+(?:const|let|var)\s+(\w+)/);
        if (varMatch) { exports.push(varMatch[1]); continue; }
        // export interface/type Foo
        const typeMatch = line.match(/export\s+(?:interface|type)\s+(\w+)/);
        if (typeMatch) { exports.push(typeMatch[1]); continue; }
        // export { a, b, c }
        const reExportMatch = line.match(/export\s+\{([^}]+)\}/);
        if (reExportMatch) {
          const names = reExportMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean);
          exports.push(...(names as string[]));
        }
        // export default
        if (/export\s+default\s/.test(line)) exports.push('default');
      }

      // Extract dependencies via regex
      const deps: string[] = [];
      for (const line of lines) {
        const importMatch = line.match(/from\s+['"]([^'"]+)['"]/);
        if (importMatch) deps.push(importMatch[1]);
        // require('...')
        const reqMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (reqMatch && !deps.includes(reqMatch[1])) deps.push(reqMatch[1]);
      }

      // Generate summary from first few meaningful lines
      const commentLines = lines.filter(l => l.trim().startsWith('//') || l.trim().startsWith('*'));
      let summary = `[Protected Core] ${relPath} — exports ${exports.length} symbols`;
      if (commentLines.length > 0) {
        const firstComment = commentLines.slice(0, 3).map(l => l.replace(/^[\s/*]+/, '').trim()).join(' ').substring(0, 200);
        if (firstComment.length > 10) summary += `. ${firstComment}`;
      }

      upsertCodebaseNode(relPath, summary, exports, deps);
      mapped++;
    } catch { /* skip unreadable */ }
  }
  if (mapped > 0) log.info(`🧠 Second Brain: mapped ${mapped} protected core files (read-only architecture)`);
}

// ── Second Brain: Call Graph + Typed Export Extraction ──

interface TypedExportInfo {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'let' | 'var' | 'unknown';
  signature?: string;
}

/**
 * Extract typed exports from a TypeScript file using regex.
 * Returns enriched export info with kind and signature.
 */
function extractTypedExports(content: string): TypedExportInfo[] {
  const exports: TypedExportInfo[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // export function foo(a: string, b: number): ReturnType
    const fnMatch = line.match(/export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))\s*(?::\s*([^\s{]+))?/);
    if (fnMatch) {
      const sig = fnMatch[3] ? `${fnMatch[2]} => ${fnMatch[3]}` : fnMatch[2];
      exports.push({ name: fnMatch[1], kind: 'function', signature: sig });
      continue;
    }

    // export class Foo { / export class Foo extends Bar {
    const clsMatch = line.match(/export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?/);
    if (clsMatch) {
      exports.push({ name: clsMatch[1], kind: 'class', signature: clsMatch[2] ? `extends ${clsMatch[2]}` : undefined });
      continue;
    }

    // export interface Foo {
    const ifaceMatch = line.match(/export\s+interface\s+(\w+)(?:\s+extends\s+([^{]+))?/);
    if (ifaceMatch) {
      exports.push({ name: ifaceMatch[1], kind: 'interface', signature: ifaceMatch[2]?.trim() });
      continue;
    }

    // export type Foo = ...
    const typeMatch = line.match(/export\s+type\s+(\w+)\s*=\s*(.{0,60})/);
    if (typeMatch) {
      exports.push({ name: typeMatch[1], kind: 'type', signature: typeMatch[2].trim().replace(/\s*\{[\s\S]*/, '{...}') });
      continue;
    }

    // export enum Foo {
    const enumMatch = line.match(/export\s+enum\s+(\w+)/);
    if (enumMatch) {
      exports.push({ name: enumMatch[1], kind: 'enum' });
      continue;
    }

    // export const/let/var foo: Type = ... or export const foo = ...
    const varMatch = line.match(/export\s+(const|let|var)\s+(\w+)\s*(?::\s*([^\s=]+))?/);
    if (varMatch) {
      exports.push({ name: varMatch[2], kind: varMatch[1] as 'const' | 'let' | 'var', signature: varMatch[3] });
      continue;
    }
  }

  return exports;
}

/**
 * Extract function-level call relationships from a TypeScript file.
 * Builds a call graph: "function X calls function Y from module Z"
 *
 * Uses import resolution + call-site detection via regex.
 */
function extractCallGraph(content: string, relPath: string): Array<{
  callerFunction: string;
  calleeFile: string;
  calleeFunction: string;
  callType: string;
  lineNumber: number;
}> {
  const lines = content.split('\n');
  const calls: Array<{
    callerFunction: string;
    calleeFile: string;
    calleeFunction: string;
    callType: string;
    lineNumber: number;
  }> = [];

  // Step 1: Map imported symbols to their source file
  const importMap = new Map<string, string>(); // symbol → source file
  for (const line of lines) {
    const m = line.match(/import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/);
    if (m) {
      const symbols = m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()?.trim()).filter(Boolean) as string[];
      const source = m[2];
      for (const sym of symbols) {
        importMap.set(sym, source);
      }
    }
    // import DefaultName from '...'
    const defaultM = line.match(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/);
    if (defaultM && !defaultM[1].startsWith('{')) {
      importMap.set(defaultM[1], defaultM[2]);
    }
  }

  if (importMap.size === 0) return calls; // No imports = no cross-file calls to track

  // Step 2: Find current function scope at each line
  let currentFunction = '<module>';
  let braceDepth = 0;
  const funcStack: Array<{ name: string; depth: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect function declarations
    const funcMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
    const methodMatch = !funcMatch ? line.match(/(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*\S+)?\s*\{/) : null;
    const arrowMatch = !funcMatch && !methodMatch ? line.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*\S+)?\s*=>/) : null;

    if (funcMatch || methodMatch || arrowMatch) {
      const name = (funcMatch || methodMatch || arrowMatch)![1];
      funcStack.push({ name, depth: braceDepth });
      currentFunction = name;
    }

    // Track brace depth
    for (const ch of line) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        // Pop function from stack if we exit its scope
        while (funcStack.length > 0 && braceDepth <= funcStack[funcStack.length - 1].depth) {
          funcStack.pop();
          currentFunction = funcStack.length > 0 ? funcStack[funcStack.length - 1].name : '<module>';
        }
      }
    }

    // Step 3: Detect call sites for imported symbols
    for (const [symbol, sourceFile] of importMap) {
      // Match: symbol( or symbol.method( or await symbol(
      const callRegex = new RegExp(`\\b${symbol}\\s*\\(`, 'g');
      if (callRegex.test(line)) {
        const callType = /await\s/.test(line) ? 'await' : 'direct';
        calls.push({
          callerFunction: currentFunction,
          calleeFile: sourceFile,
          calleeFunction: symbol,
          callType,
          lineNumber: i + 1,
        });
      }
    }
  }

  return calls;
}

/**
 * Run static analysis on a scanned file to extract call graph and typed exports.
 * Called after LLM analysis completes for a file.
 */
function updateSecondBrainStaticAnalysis(rootDir: string, relPath: string, content: string): void {
  try {
    // 1. Extract typed exports and update codebase_map
    const typedExports = extractTypedExports(content);
    if (typedExports.length > 0) {
      // Read current node to preserve summary and deps
      const db = getDb();
      const existing = db.prepare('SELECT summary, dependencies_json FROM codebase_map WHERE file_path = ?').get(relPath) as { summary: string; dependencies_json: string } | undefined;
      if (existing) {
        let deps: string[] = [];
        try { deps = JSON.parse(existing.dependencies_json); } catch { /* ignore */ }
        upsertCodebaseNode(relPath, existing.summary, typedExports as any, deps);
      }
    }

    // 2. Extract call graph and update codebase_calls
    const dbMod = getDb();

    // Clear old calls and re-build
    try { dbMod.prepare('DELETE FROM codebase_calls WHERE caller_file = ?').run(relPath); } catch { /* table might not exist yet */ }

    const calls = extractCallGraph(content, relPath);
    for (const call of calls) {
      // Resolve relative import path to absolute project path
      let resolvedCalleeFile = call.calleeFile;
      if (call.calleeFile.startsWith('.')) {
        resolvedCalleeFile = path.posix.normalize(
          path.posix.join(path.posix.dirname(relPath), call.calleeFile)
        ).replace(/\.js$/, '.ts');
      }

      try {
        dbMod.prepare(`
          INSERT INTO codebase_calls (caller_file, caller_function, callee_file, callee_function, call_type, line_number, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(caller_file, caller_function, callee_file, callee_function) DO UPDATE SET
            call_type = excluded.call_type,
            line_number = excluded.line_number,
            updated_at = datetime('now')
        `).run(relPath, call.callerFunction, resolvedCalleeFile, call.calleeFunction, call.callType, call.lineNumber);
      } catch { /* ignore individual insert errors */ }
    }

    if (calls.length > 0 || typedExports.length > 0) {
      log.debug(`[SecondBrain] ${relPath}: ${typedExports.length} typed exports, ${calls.length} call-graph edges`);
    }
  } catch (err: any) {
    log.debug(`[SecondBrain] Static analysis failed for ${relPath}: ${err.message}`);
  }
}

// ── Second Brain: Dependency Graph Builder ──

/**
 * Build explicit dependency edges from all known codebase_map entries.
 * Parses each file's dependencies_json and resolves relative import paths
 * to create directed edges: source --imports(symbols)--> target.
 *
 * This creates a traversable graph that enables:
 * - Multi-hop impact analysis ("if I change db.ts, what breaks 3 levels deep?")
 * - Accurate upstream context ("what modules does this file depend on?")
 * - Risk scoring based on dependency fan-out/fan-in
 */
async function buildDependencyGraph(rootDir: string): Promise<number> {
  let edgeCount = 0;
  try {
    const { getCodebaseContextMap, upsertCodebaseEdge, clearCodebaseEdgesForFile } = await import('../database/db.js');
    const allNodes = getCodebaseContextMap();
    const nodeMap = new Map(allNodes.map(n => [n.file_path, n]));

    // Also build a lookup by possible import paths (without extension, with .js/.ts variants)
    const pathLookup = new Map<string, string>();
    for (const node of allNodes) {
      pathLookup.set(node.file_path, node.file_path);
      // Map common import variants: 'database/db.js' → 'database/db.ts'
      pathLookup.set(node.file_path.replace(/\.ts$/, '.js'), node.file_path);
      pathLookup.set(node.file_path.replace(/\.tsx$/, '.jsx'), node.file_path);
      // Without extension
      pathLookup.set(node.file_path.replace(/\.\w+$/, ''), node.file_path);
    }

    for (const node of allNodes) {
      try {
        const deps: string[] = JSON.parse(node.dependencies_json || '[]');
        if (deps.length === 0) continue;

        // Clear old edges for this source before rebuilding
        clearCodebaseEdgesForFile(node.file_path);

        for (const dep of deps) {
          // Skip external packages (no relative path)
          if (!dep.startsWith('.') && !dep.startsWith('/')) continue;

          // Resolve relative path
          const resolved = path.posix.normalize(
            path.posix.join(path.posix.dirname(node.file_path), dep)
          );

          // Try to find the target file in our codebase map
          const targetPath = pathLookup.get(resolved)
            || pathLookup.get(resolved.replace(/\.js$/, '.ts'))
            || pathLookup.get(resolved.replace(/\.jsx$/, '.tsx'))
            || pathLookup.get(resolved.replace(/\.\w+$/, ''));

          if (targetPath && nodeMap.has(targetPath)) {
            // Parse what specific symbols are imported
            // We don't have exact import info in deps, but we know what the target exports
            const targetNode = nodeMap.get(targetPath)!;
            let targetExports: string[] = [];
            try { targetExports = JSON.parse(targetNode.exports_json || '[]'); } catch {}

            // Weight = number of exported symbols (higher = more important dependency)
            const weight = Math.min(targetExports.length / 10, 1.0) + 0.1;

            upsertCodebaseEdge(node.file_path, targetPath, 'imports', targetExports.slice(0, 20), weight);
            edgeCount++;
          }
        }
      } catch { /* skip individual file errors */ }
    }

    log.info(`🧠 Second Brain Graph: built ${edgeCount} dependency edges from ${allNodes.length} files`);
  } catch (err: any) {
    log.warn(`[SecondBrain] Graph build error: ${err.message}`);
  }
  return edgeCount;
}

// ── Second Brain: Code Embeddings (Semantic Fingerprints) ──

/**
 * Generate embeddings for file summaries that don't have one yet.
 * Uses the existing VectorStore's embedding infrastructure.
 * Enables "find similar files" for deduplication and pattern detection.
 */
async function updateCodeEmbeddings(rootDir: string): Promise<number> {
  let indexed = 0;
  try {
    const { getCodebaseContextMap, upsertCodebaseEmbedding } = await import('../database/db.js');
    const allNodes = getCodebaseContextMap();
    const db = getDb();

    // ── Staleness Detection: find files whose summary changed since last embedding ──
    // Build a hash of the current summary to compare with stored hash.
    // Also detect embeddings older than 7 days for forced refresh.
    const STALE_DAYS = 7;
    const existingEmbeddings = db.prepare(
      'SELECT file_path, updated_at FROM codebase_embeddings'
    ).all() as { file_path: string; updated_at: string }[];

    const embeddingMap = new Map(existingEmbeddings.map(e => [e.file_path, e.updated_at]));

    // Compute simple hash of summary+exports for staleness check
    const hashStr = (s: string) => {
      let h = 0;
      for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
      return h.toString(36);
    };

    const needsEmbedding = allNodes.filter(n => {
      if (!n.summary || n.summary.length < 20) return false;

      const existingDate = embeddingMap.get(n.file_path);
      if (!existingDate) return true; // Never embedded

      // Check staleness: summary changed since last scan?
      // Compare last_scanned (codebase_map) vs updated_at (codebase_embeddings)
      const mapScanned = new Date(n.last_scanned).getTime();
      const embUpdated = new Date(existingDate).getTime();
      if (mapScanned > embUpdated) return true; // Summary updated after embedding

      // Force refresh if older than STALE_DAYS
      const ageDays = (Date.now() - embUpdated) / (1000 * 60 * 60 * 24);
      if (ageDays > STALE_DAYS) return true;

      return false;
    });

    if (needsEmbedding.length === 0) return 0;

    const staleCount = needsEmbedding.filter(n => embeddingMap.has(n.file_path)).length;
    const newCount = needsEmbedding.length - staleCount;
    log.info(`🧠 Embeddings: ${newCount} new, ${staleCount} stale (of ${allNodes.length} total)`);

    // Batch embed: max 10 per cycle to avoid rate limits
    const batch = needsEmbedding.slice(0, 10);

    try {
      const { embedText } = await import('../memory/embeddingProvider.js');
      if (!embedText) return 0;

      for (const node of batch) {
        try {
          // Create a rich text representation for embedding
          let exportsStr = '';
          try {
            const exports = JSON.parse(node.exports_json || '[]');
            if (exports.length > 0 && typeof exports[0] === 'object') {
              exportsStr = exports.map((e: any) => `${e.name}(${e.kind})`).join(', ');
            } else {
              exportsStr = exports.join(', ');
            }
          } catch {}
          const text = `File: ${node.file_path}\nPurpose: ${node.summary}\nExports: ${exportsStr}`;

          const embedding = await embedText(text);
          if (embedding && embedding.length > 0) {
            upsertCodebaseEmbedding(node.file_path, embedding, 'embedding_provider');
            indexed++;
          }
        } catch { /* skip individual failures */ }
      }
    } catch {
      // Embedding provider not available — skip embedding generation
      return 0;
    }

    if (indexed > 0) log.info(`🧠 Second Brain Embeddings: indexed/refreshed ${indexed} file summaries`);
  } catch (err: any) {
    log.warn(`[SecondBrain] Embedding update error: ${err.message}`);
  }
  return indexed;
}

// ── Auto Implementation Helpers ──

/** Helper to save file diffs for history and generate unified diffs for preview */
function saveUpgradeDiff(id: number, filePath: string, original: string, modified: string): void {
  try {
    const historyDir = path.resolve(process.cwd(), '../data/upgrade_history');
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
    
    // Extract base filename for the backup
    const baseName = path.basename(filePath);
    fs.writeFileSync(path.join(historyDir, `proposal_${id}_before_${baseName}.txt`), original, 'utf-8');
    fs.writeFileSync(path.join(historyDir, `proposal_${id}_after_${baseName}.txt`), modified, 'utf-8');

    // Generate unified diff
    const patch = diff.createPatch(filePath, original, modified, 'Original', 'Modified', { context: 3 });
    
    // Save to database
    const db = getDb();
    db.prepare(`
      UPDATE upgrade_proposals 
      SET diff_preview = CASE 
        WHEN diff_preview IS NULL THEN ? 
        ELSE diff_preview || '\n\n' || ? 
      END
      WHERE id = ?
    `).run(patch, patch, id);
    
  } catch (e: any) {
    log.error(`[SelfUpgrade] Failed to save code diffs for #${id}: ${e.message}`);
  }
}

/**
 * Smart TSC verification — compares errors BEFORE vs AFTER the upgrade.
 * Only rejects if the upgrade INTRODUCED NEW errors (not pre-existing ones).
 */
let _baselineErrors: string[] | null = null;

/** §5.1: Parse TSC error line into structured { file, line, errorCode } for reliable comparison */
interface TscError { file: string; line: number; errorCode: string; message: string; raw: string; }
function parseTscErrors(stdout: string): TscError[] {
  const errors: TscError[] = [];
  for (const line of stdout.split('\n')) {
    // Match: src/foo.ts(42,5): error TS2339: Property 'x' does not exist
    const m = line.match(/^(.+?)\((\d+),\d+\):\s*error\s+(TS\d+):\s*(.+)/);
    if (m) {
      errors.push({ file: m[1].trim(), line: parseInt(m[2], 10), errorCode: m[3], message: m[4].trim(), raw: line });
    }
  }
  return errors;
}

/** Create a dedup key from a TSC error — uses file + errorCode + line for stable comparison */
function tscErrorKey(e: TscError): string {
  return `${e.file}:${e.line}:${e.errorCode}`;
}

async function captureBaselineErrors(rootDir: string): Promise<string[]> {
  if (_baselineErrors !== null) return _baselineErrors;
  const checkDir = path.resolve(rootDir, '..');
  try {
    await execPromise('npx tsc --noEmit', { cwd: checkDir });
    _baselineErrors = [];
  } catch (err: any) {
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    _baselineErrors = parseTscErrors(stdout).map(e => tscErrorKey(e)).sort();
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
  let afterErrorKeys: string[] = [];
  let afterRawErrors: string[] = [];
  try {
    await execPromise('npx tsc --noEmit', { cwd: checkDir });
    // No errors at all — even better than baseline!
    return;
  } catch (err: any) {
    const stdout = typeof err.stdout === 'string' ? err.stdout : '';
    const parsed = parseTscErrors(stdout);
    afterErrorKeys = parsed.map(e => tscErrorKey(e)).sort();
    afterRawErrors = parsed.map(e => e.raw);
  }

  // §5.1: Compare using structured error codes instead of raw string matching
  const baselineSet = new Set(baseline);
  const newErrorKeys = afterErrorKeys.filter(key => !baselineSet.has(key));

  if (newErrorKeys.length === 0) {
    log.info(`Proposal #${proposalId} verification passed (${afterErrorKeys.length} pre-existing errors, 0 new)`);
    return;
  }

  // New errors were introduced — reject the upgrade
  _baselineErrors = null;
  // Show the raw error lines for readability in the rejection message
  const newRawErrors = afterRawErrors.filter(raw => {
    const parsed = parseTscErrors(raw);
    return parsed.length > 0 && !baselineSet.has(tscErrorKey(parsed[0]));
  });
  const errorMsg = `New TypeScript errors introduced (${newErrorKeys.length}):\n${(newRawErrors.length > 0 ? newRawErrors : newErrorKeys).join('\n')}`;
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

    // 🕵️ Pre-flight Syntax Validation Logic
    let braces = 0, parens = 0, brackets = 0;
    let inString = false, stringChar = '', isEscaped = false;
    let inTemplate = false;
    let inLineComment = false, inBlockComment = false;

    for (let i = 0; i < content.length; i++) {
      const c = content[i];
      const next = content[i + 1];

      if (inLineComment) { if (c === '\n') inLineComment = false; continue; }
      if (inBlockComment) { if (c === '*' && next === '/') { inBlockComment = false; i++; } continue; }
      
      if (inString) {
        if (isEscaped) { isEscaped = false; continue; }
        if (c === '\\') { isEscaped = true; continue; }
        if (c === stringChar) inString = false;
        continue;
      }
      
      if (inTemplate) {
        if (isEscaped) { isEscaped = false; continue; }
        if (c === '\\') { isEscaped = true; continue; }
        if (c === '`') inTemplate = false;
        continue;
      }

      if (c === '/' && next === '/') { inLineComment = true; i++; continue; }
      if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
      if (c === '"' || c === "'") { inString = true; stringChar = c; continue; }
      if (c === '`') { inTemplate = true; continue; }

      if (c === '{') braces++;
      else if (c === '}') braces--;
      else if (c === '(') parens++;
      else if (c === ')') parens--;
      else if (c === '[') brackets++;
      else if (c === ']') brackets--;
    }

    if (inString) errors.push(`${basename}: Unterminated string literal (${stringChar})`);
    if (inTemplate) errors.push(`${basename}: Unterminated template literal (\`)`);
    if (braces !== 0) errors.push(`${basename}: Unbalanced braces — ${braces > 0 ? `${braces} unclosed {` : `${-braces} extra }`}`);
    if (parens !== 0) errors.push(`${basename}: Unbalanced parentheses — ${parens > 0 ? `${parens} unclosed (` : `${-parens} extra )`}`);
    if (brackets !== 0) errors.push(`${basename}: Unbalanced square brackets — ${brackets > 0 ? `${brackets} unclosed [` : `${-brackets} extra ]`}`);

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

    // 3. Detect `continue` or `break` outside of loop/switch context
    //    This catches the exact crash that killed routes.ts
    let loopDepth = 0;
    let switchDepth = 0;
    for (let ln = 0; ln < lines.length; ln++) {
      const trimmed = lines[ln].trim();
      // Skip comments
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      // Approximate loop/switch tracking via keywords at line start
      if (/^(for|while|do)\b/.test(trimmed)) loopDepth++;
      if (/^switch\b/.test(trimmed)) switchDepth++;
      // Track closing braces (very rough — better than nothing)
      if (trimmed === '}' || trimmed.startsWith('})')) {
        if (loopDepth > 0) loopDepth--;
        else if (switchDepth > 0) switchDepth--;
      }
      // Check for bare continue/break
      if (/^\s*(continue|break)\s*;/.test(lines[ln]) && loopDepth === 0 && switchDepth === 0) {
        errors.push(`${basename}:${ln + 1}: "${trimmed}" outside of loop/switch — will crash esbuild`);
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
      // Use a temp script file that reads the target file from disk.
      // This avoids ENAMETOOLONG and pipe buffer limits entirely.
      const scriptFile = path.resolve(filePath, '..', `__esbuild_check_${proposalId}.cjs`);
      const script = `const esbuild=require('esbuild');
const fs=require('fs');
const content=fs.readFileSync('${basename}', 'utf-8');
esbuild.transform(content,{loader:'${loader}',sourcefile:'${basename}'})
  .then(()=>process.exit(0))
  .catch(e=>{console.error(e.errors?e.errors.map(x=>x.text).join('\\n'):e.message);process.exit(1)});
`;
      fs.writeFileSync(scriptFile, script, 'utf-8');
      try {
        const { execFile } = await import('child_process');
        await new Promise<void>((resolve, reject) => {
          execFile('node', [scriptFile], {
            cwd: path.resolve(filePath, '..'),
            timeout: 15000,
            maxBuffer: 10 * 1024 * 1024,
          }, (err, stdout, stderr) => {
            if (err) reject({ stderr: stderr || stdout || err.message, message: stderr || stdout || err.message });
            else resolve();
          });
        });
      } finally {
        try { fs.unlinkSync(scriptFile); } catch { /* cleanup best effort */ }
      }
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

    // §5.2: Wait 6 seconds (increased from 4s), then run smoke tests
    setTimeout(async () => {
      if (settled) return;

      try {
        // 1. Health check
        const healthResp = await fetch(`http://127.0.0.1:${testPort}/health`, { signal: AbortSignal.timeout(5000) });
        if (!healthResp.ok) {
          settled = true;
          reject(new Error(`Runtime boot test: /health returned status ${healthResp.status}`));
          return;
        }
        log.info(`[RuntimeTest] Proposal #${proposalId} — /health OK`);

        // §5.2: Smoke test endpoints — verify subsystems are functional
        const smokeEndpoints = [
          '/api/upgrade/status',
          '/api/models',
        ];
        const failedSmoke: string[] = [];
        for (const ep of smokeEndpoints) {
          try {
            const resp = await fetch(`http://127.0.0.1:${testPort}${ep}`, { signal: AbortSignal.timeout(3000) });
            // Accept 2xx or 401 (auth required but endpoint exists)
            if (resp.status >= 500) {
              failedSmoke.push(`${ep} returned ${resp.status}`);
            }
          } catch (smokeErr: any) {
            failedSmoke.push(`${ep}: ${smokeErr.message}`);
          }
        }

        if (failedSmoke.length > 0) {
          log.warn(`[RuntimeTest] Smoke test warnings: ${failedSmoke.join('; ')}`);
          // Warnings only — don't reject for smoke test failures (they may need auth)
        }

        settled = true;
        log.info(`[RuntimeTest] Proposal #${proposalId} — boot + smoke tests passed.`);
        resolve();
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
    }, 6000);

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
  learningContext: string,
  codebaseContext: string
): Promise<ImplementationPlan> {
  const planPrompt = `You are a CODE ARCHITECT deciding how to safely implement a code change proposal.
Your job: Create a robust, safe implementation plan. Do NOT reject proposals just because they are incomplete (e.g., missing imports) — instead, ADD the missing steps to your plan!

Proposal: ${proposal.title}
Description: ${proposal.description}
Target file: ${proposal.file_path}
Suggested fix: ${proposal.suggested_fix || 'N/A'}
Impact risk: ${impact.riskLevel}
Affected files: ${impact.affectedFiles.length > 0 ? impact.affectedFiles.join(', ') : 'none'}
Exported symbols at risk: ${impact.exportedSymbols.length > 0 ? impact.exportedSymbols.join(', ') : 'none'}
${learningContext ? `\n[Lessons from past failures — MUST consider]:\n${learningContext}` : ''}
${codebaseContext ? `${codebaseContext}` : ''}

Target file first 100 lines:
\`\`\`typescript
${originalContent.split('\n').slice(0, 100).join('\n')}
\`\`\`

AUTO-REJECT ONLY if ANY of these fundamentally block implementation:
- Proposal description is too vague to understand even with context
- Change requires editing > 20 files
- The "bug" described is actually correct existing behavior and changing it breaks core logic
- The fix is already implemented in the code (redundant)

If the proposal is missing imports or has minor flaws, FIX IT in your plan steps. 
If the learning journal warns against a similar past failure, figure out a DIFFERENT, SAFER approach rather than giving up.

Return JSON (no markdown):
{"shouldProceed":true/false,"reason":"Why reject or why it's safe","riskAssessment":"What could go wrong","filesToEdit":["files"],"steps":["Step 1: ...","Step 2: ..."]}

Max 6 steps.`;

  try {
    const modelName = getImplementModel();
    const response = await aiChat('chat', [{ role: 'user', content: planPrompt }], {
      model: modelName,
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
    // 1. Initialize and load project
    await refactorManager.initialize();
    
    // 2. Get exports using AST
    const sourceFile = (refactorManager as any).project.getSourceFile(fullPath);
    if (!sourceFile) {
      report.analysis = "Could not load file into AST project.";
      return report;
    }

    const exportDeclarations = sourceFile.getExportedDeclarations();
    for (const [name, declarations] of exportDeclarations) {
      report.exportedSymbols.push(name);
      
      // 3. Find external references for each exported symbol
      for (const decl of declarations) {
        if (Node.isFunctionDeclaration(decl) || Node.isVariableDeclaration(decl) || Node.isClassDeclaration(decl) || Node.isInterfaceDeclaration(decl)) {
          const refs = decl.findReferences();
          for (const refSym of refs) {
            for (const ref of refSym.getReferences()) {
              const refFile = ref.getSourceFile();
              if (refFile.getFilePath() === sourceFile.getFilePath()) continue; // skip self
              
              const relPath = path.relative(process.cwd(), refFile.getFilePath()).replace(/\\/g, '/');
              const existing = report.callerFiles.get(relPath) || [];
              if (!existing.includes(name)) {
                existing.push(name);
                report.callerFiles.set(relPath, existing);
              }
            }
          }
        }
      }
    }

    report.exportedSymbols = [...new Set(report.exportedSymbols)];

    // 4. Determine affected files
    report.affectedFiles = [...report.callerFiles.keys()];

    // 5. Assess risk level
    if (report.affectedFiles.length === 0) {
      report.riskLevel = 'safe';
      if (report.exportedSymbols.length === 0) {
        report.analysis = `File "${targetFilePath}" exports no public symbols — safe to modify in isolation.`;
      } else {
        report.analysis = `File "${targetFilePath}" exports ${report.exportedSymbols.length} symbols but none are used externally.`;
      }
    } else if (report.affectedFiles.length <= 3) {
      report.riskLevel = 'moderate';
      report.analysis = `File "${targetFilePath}" is imported by ${report.affectedFiles.length} files. Symbols used: ${[...report.callerFiles.entries()].map(([f, syms]) => `${f} uses [${syms.join(', ')}]`).join('; ')}. Changes to exported APIs MUST be synchronized.`;
    } else {
      report.riskLevel = 'high';
      report.analysis = `File "${targetFilePath}" is a widely-imported module (${report.affectedFiles.length} dependents). HIGH RISK — changes to exported APIs will cascade across: ${report.affectedFiles.slice(0, 8).join(', ')}${report.affectedFiles.length > 8 ? ` and ${report.affectedFiles.length - 8} more` : ''}.`;
    }

    log.info(`Impact analysis (AST) for "${targetFilePath}": risk=${report.riskLevel}, ${report.affectedFiles.length} affected files`);
  } catch (err: any) {
    log.warn(`Impact analysis (AST) failed for "${targetFilePath}": ${err.message}`);
    report.riskLevel = 'moderate';
    report.analysis = `Impact analysis could not be completed accurately — proceed with caution. Error: ${err.message}`;
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

/** Helper to select best specialists for code implementation.
 *  NOTE: Only include specialists that can EDIT files, not review-only ones.
 *  'reviewer' was removed because it doesn't have file-editing tools and caused
 *  46% of rejections ("completed the task but did not modify any target file"). */
function getSortedImplementationSpecialists(swarmCoordinator: any): string[] {
  const implementationSpecialists = ['coder', 'tester', 'general'];
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

// §6.1: File-level locking — prevent 2 proposals from editing the same file concurrently
const _fileLocks = new Map<string, number>(); // Map<normalizedPath, proposalId>

function acquireFileLock(filePath: string, proposalId: number): boolean {
  const key = filePath.replace(/\\/g, '/');
  const existing = _fileLocks.get(key);
  if (existing !== undefined && existing !== proposalId) {
    log.warn(`[SelfUpgrade] File lock denied for proposal #${proposalId} — file "${key}" is locked by proposal #${existing}`);
    return false;
  }
  _fileLocks.set(key, proposalId);
  return true;
}

function releaseFileLock(filePath: string): void {
  _fileLocks.delete(filePath.replace(/\\/g, '/'));
}

function releaseAllFileLocks(proposalId: number): void {
  for (const [key, pid] of _fileLocks) {
    if (pid === proposalId) _fileLocks.delete(key);
  }
}

export async function implementProposalById(id: number, rootDir: string): Promise<boolean> {
  const db = getDb();
  const proposal = db.prepare('SELECT * FROM upgrade_proposals WHERE id = ?').get(id) as UpgradeProposal | undefined;
  if (!proposal) return false;

  const fileName = path.basename(proposal.file_path);
  const relativePath = proposal.file_path.replace(/\\/g, '/');

  // §6.1: Acquire file lock before implementation
  if (!acquireFileLock(relativePath, id)) {
    log.warn(`[SelfUpgrade] Skipping proposal #${id} — file "${relativePath}" is currently being edited by another proposal`);
    return false;
  }

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
    'terminal/terminalGateway.ts', 'api/routes.ts', 'api/socketHandlers.ts', 'api/upgradeRoutes.ts',
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

  // ── Phase 7.5: Assemble Second Brain Context (Graph-Enhanced) ──
  // Uses the dependency graph + node architecture + semantic search to give AI
  // maximum understanding of the codebase before making changes.
  //
  // Sources:
  //  1. Target file node (summary, exports, deps)
  //  2. Graph: upstream dependencies (files the target imports FROM)
  //  3. Graph: downstream dependents (files that import FROM the target) — multi-hop
  //  4. Semantic: similar files (code that does similar things — for pattern reference)
  phaseLog('🧠 Second Brain', 'assembling graph-enhanced context...');
  let codebaseContext = '';
  try {
    const {
      getCodebaseContextMap, getFileNeighborhood, getImpactRadius, searchSimilarFiles
    } = await import('../database/db.js');
    const allNodes = getCodebaseContextMap();
    const nodeMap = new Map(allNodes.map(n => [n.file_path, n]));

    // ── Layer 1: Graph-based neighborhood ──
    const neighborhood = getFileNeighborhood(relativePath);
    const upstreamPaths = new Set(neighborhood.upstream.map(e => e.target_file));
    const downstreamPaths = new Set(neighborhood.downstream.map(e => e.source_file));

    // ── Layer 2: Multi-hop impact radius (2 hops) ──
    const impactMap = getImpactRadius(relativePath, 2);
    const hop2Paths = new Set<string>();
    for (const [hop, edges] of impactMap) {
      for (const e of edges) hop2Paths.add(e.source_file);
    }

    // ── Layer 3: Semantic search for similar files ──
    let semanticPaths = new Set<string>();
    try {
      const db = getDb();
      const targetEmb = db.prepare('SELECT embedding FROM codebase_embeddings WHERE file_path = ?').get(relativePath) as { embedding: Buffer } | undefined;
      if (targetEmb?.embedding) {
        const vec = Array.from(new Float32Array(
          targetEmb.embedding.buffer, targetEmb.embedding.byteOffset, targetEmb.embedding.byteLength / 4
        ));
        const similar = searchSimilarFiles(vec, 3);
        semanticPaths = new Set(similar.filter(s => s.file_path !== relativePath).map(s => s.file_path));
      }
    } catch { /* semantic search not available yet */ }

    // Combine all relevant paths (deduplicated)
    const relevantPaths = new Set([
      relativePath,
      ...impact.affectedFiles,
      ...upstreamPaths,
      ...downstreamPaths,
      ...hop2Paths,
    ]);

    // Fallback: if graph is empty, parse imports from file content directly
    if (upstreamPaths.size === 0) {
      try {
        const importLines = originalContent.split('\n').filter(l => /^\s*import\s/.test(l));
        for (const line of importLines) {
          const m = line.match(/from\s+['"]([^'"]+)['"]/);
          if (m && m[1].startsWith('.')) {
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), m[1]))
              .replace(/\.js$/, '.ts').replace(/\.jsx$/, '.tsx');
            if (nodeMap.has(resolved)) {
              relevantPaths.add(resolved);
              upstreamPaths.add(resolved);
            }
          }
        }
      } catch { /* ignore */ }
    }

    const relevantNodes = allNodes.filter(n => relevantPaths.has(n.file_path));

    if (relevantNodes.length > 0) {
      codebaseContext = `\n[🧠 CODEBASE ARCHITECTURE MAP — Graph-Enhanced]\n`;

      // Format each node with its role label and edge info
      const formatNode = (node: typeof allNodes[0]) => {
        let exportsList = '', depsList = '';
        try { exportsList = JSON.parse(node.exports_json).join(', '); } catch {}
        try { depsList = JSON.parse(node.dependencies_json).join(', '); } catch {}

        const isTarget = node.file_path === relativePath;
        const isUpstream = upstreamPaths.has(node.file_path);
        const isDownstream = downstreamPaths.has(node.file_path);
        const isHop2 = hop2Paths.has(node.file_path) && !isDownstream;
        const isSemantic = semanticPaths.has(node.file_path);
        const isAffected = impact.affectedFiles.includes(node.file_path);

        let label = '';
        if (isTarget) label = '🎯 TARGET';
        else if (isUpstream) label = '⬆️ IMPORTS FROM';
        else if (isAffected || isDownstream) label = '⬇️ DEPENDS ON TARGET';
        else if (isHop2) label = '⬇️⬇️ 2-HOP DEPENDENT';
        else if (isSemantic) label = '🔗 SIMILAR PATTERN';
        else label = '📄 RELATED';

        let out = `[${label}] ${node.file_path}\n  Purpose: ${node.summary || 'N/A'}\n`;
        // Show typed exports if available (ExportInfo objects)
        if (exportsList) {
          try {
            const exportsData = JSON.parse(node.exports_json || '[]');
            if (exportsData.length > 0 && typeof exportsData[0] === 'object' && exportsData[0].kind) {
              // Typed exports available — show with signatures
              const typedList = exportsData.map((e: any) =>
                `${e.name}(${e.kind}${e.signature ? ': ' + e.signature : ''})`
              ).join(', ');
              out += `  Exports: ${typedList}\n`;
            } else {
              out += `  Exports: ${exportsList}\n`;
            }
          } catch {
            out += `  Exports: ${exportsList}\n`;
          }
        }

        // Show specific imported symbols from graph edges
        if (isUpstream) {
          const edge = neighborhood.upstream.find(e => e.target_file === node.file_path);
          if (edge) {
            try {
              const syms = JSON.parse(edge.symbols_json || '[]');
              if (syms.length > 0) out += `  Symbols available: ${syms.join(', ')}\n`;
            } catch {}
          }
        }

        if (isDownstream) {
          const edge = neighborhood.downstream.find(e => e.source_file === node.file_path);
          if (edge) {
            try {
              const syms = JSON.parse(edge.symbols_json || '[]');
              if (syms.length > 0) out += `  Uses from target: ${syms.join(', ')}\n`;
            } catch {}
          }
        }

        return out;
      };

      // Order: target first, then upstream, downstream, hop2, semantic
      const target = relevantNodes.filter(n => n.file_path === relativePath);
      const upstream = relevantNodes.filter(n => upstreamPaths.has(n.file_path));
      const downstream = relevantNodes.filter(n =>
        (downstreamPaths.has(n.file_path) || impact.affectedFiles.includes(n.file_path)) && n.file_path !== relativePath
      );
      const hop2 = relevantNodes.filter(n => hop2Paths.has(n.file_path) && !downstreamPaths.has(n.file_path));
      const semantic = allNodes.filter(n => semanticPaths.has(n.file_path) && !relevantPaths.has(n.file_path));

      for (const n of target) codebaseContext += formatNode(n);
      if (upstream.length > 0) {
        codebaseContext += `\n── Upstream Dependencies (${upstream.length} files this target imports from) ──\n`;
        for (const n of upstream) codebaseContext += formatNode(n);
      }
      if (downstream.length > 0) {
        codebaseContext += `\n── Downstream Dependents (${downstream.length} files that will break if exports change) ──\n`;
        for (const n of downstream.slice(0, 8)) codebaseContext += formatNode(n);
        if (downstream.length > 8) codebaseContext += `  ... and ${downstream.length - 8} more files\n`;
      }
      if (hop2.length > 0) {
        codebaseContext += `\n── 2-Hop Impact Zone (${hop2.length} files indirectly affected) ──\n`;
        for (const n of hop2.slice(0, 5)) codebaseContext += formatNode(n);
        if (hop2.length > 5) codebaseContext += `  ... and ${hop2.length - 5} more files\n`;
      }
      if (semantic.length > 0) {
        codebaseContext += `\n── Semantically Similar Files (reference patterns) ──\n`;
        for (const n of semantic.slice(0, 3)) codebaseContext += formatNode(n);
      }

      // ── Layer 4: Call Graph (function-level callers/callees) ──
      let callGraphEntries = 0;
      try {
        const db = getDb();
        // Who calls functions in our target file?
        const callers = db.prepare(
          `SELECT DISTINCT caller_file, caller_function, callee_function, call_type, line_number
           FROM codebase_calls WHERE callee_file = ? ORDER BY caller_file LIMIT 20`
        ).all(relativePath) as Array<{ caller_file: string; caller_function: string; callee_function: string; call_type: string; line_number: number }>;

        if (callers.length > 0) {
          codebaseContext += `\n── Call Graph: Who Calls Functions in This File (${callers.length} callers) ──\n`;
          const grouped = new Map<string, string[]>();
          for (const c of callers) {
            const key = c.caller_file;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key)!.push(`${c.caller_function}() calls ${c.callee_function}() [${c.call_type}, line ${c.line_number}]`);
          }
          for (const [file, callList] of grouped) {
            codebaseContext += `  ${file}:\n`;
            for (const call of callList.slice(0, 5)) {
              codebaseContext += `    - ${call}\n`;
            }
            if (callList.length > 5) codebaseContext += `    ... and ${callList.length - 5} more\n`;
          }
          callGraphEntries = callers.length;
        }
      } catch { /* call graph table might not exist yet */ }

      const totalContext = upstream.length + downstream.length + hop2.length + semantic.length;
      phaseLog('🧠 Second Brain', `graph context: ${upstream.length} upstream, ${downstream.length} downstream, ${hop2.length} hop-2, ${semantic.length} semantic, ${callGraphEntries} call-graph (${relevantNodes.length} total nodes)`);
    } else {
      phaseLog('🧠 Second Brain', `no architectural map available yet`);
    }
  } catch(e) { /* ignore */ }

  // ── Phase 8: Pre-Implementation Planning — วางแผนก่อนลงมือ ──
  phaseLog('📋 Planning', 'AI generating implementation plan...');
  const plan = await createImplementationPlan(proposal, impact, originalContent, learningContext, codebaseContext);

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

  // §3.2: Build available project imports map from Second Brain
  let projectImportsMap = '';
  try {
    const upstreamDeps = getDb().prepare(
      `SELECT cm.file_path, cm.exports_json FROM codebase_map cm
       INNER JOIN codebase_edges ce ON ce.target_file = cm.file_path
       WHERE ce.source_file = ? LIMIT 15`
    ).all(relativePath) as Array<{ file_path: string; exports_json: string }>;
    if (upstreamDeps.length > 0) {
      const importItems: string[] = [];
      for (const dep of upstreamDeps) {
        try {
          const exports = JSON.parse(dep.exports_json || '[]');
          const symbols = exports.map((e: any) => typeof e === 'string' ? e : `${e.name}${e.signature ? `: ${e.signature}` : ''}`).slice(0, 10);
          if (symbols.length > 0) {
            importItems.push(`  ${dep.file_path}: [${symbols.join(', ')}]`);
          }
        } catch { /* skip bad JSON */ }
      }
      if (importItems.length > 0) {
        projectImportsMap = `\n[📦 AVAILABLE PROJECT IMPORTS — Use these instead of inventing new ones]\n${importItems.join('\n')}\n`;
      }
    }
  } catch { /* Second Brain may not be populated yet */ }

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

  // Choose prompt strategy: multi-file if plan specifies additional files OR impact analysis shows dependents
  // plan.filesToEdit comes from the AI planner and may include files the impact analysis missed
  const planExtraFiles = (plan.filesToEdit || [])
    .filter(f => f !== relativePath && f !== proposal.file_path)
    .map(f => f.replace(/\\/g, '/'));
  const allAffectedFiles = [...new Set([...impact.affectedFiles, ...planExtraFiles])];
  const isMultiFile = allAffectedFiles.length > 0;

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
H. PRESERVE CONTEXT: When using \`replace_code_block\`, include 2-3 unchanged lines before and after the change to ensure correct placement.
I. MUST USE TOOLS: You MUST actually modify the file. Do not just explain the fix. You will fail if you reply with descriptions but no file-editing tool usage.`;

  const prompt = isMultiFile
    ? `You are a senior Software Engineer AI performing a SURGICAL code fix across multiple files.${traumaContext}
${learningContext}${codebaseContext}${planContext}
🔍 MULTI-FILE MODE — You may edit: "${fileName}" + dependent files listed below.
${affectedFilesContext}
${importContext}
${commonSafetyRules}

MULTI-FILE SPECIFIC RULES:
1. If changing an exported symbol, you MUST update ALL callers in ALL files.
2. Use \`find_references\` to see who uses the symbol before changing it.
3. For function/method changes, prefer \`ast_replace_function\` for precise surgery.
4. For renames, use \`ast_rename\` to update all files automatically.
5. Edit the PRIMARY file first, then each dependent file.
6. If it requires editing > 5 files, reply "SKIP: too many files affected".
7. YOU MUST ACTUALLY MODIFY THE FILES USING TOOLS. Do not just explain the fix.
8. PRESERVE BRACES/BRACKETS. DO NOT accidentally delete closing braces '}'.

WORKFLOW:
1. <think> block: Plan exactly what changes in each file. Use \`find_references\` if needed.
2. \`read_file_content\` on EVERY file you will edit.
3. Use file editing tools (e.g. \`multi_replace_file_content\` or \`replace_code_block\`) for each change.
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
${learningContext}${codebaseContext}${planContext}
📋 SINGLE-FILE MODE — Only edit "${fileName}". No other files.
${importContext}
${commonSafetyRules}

SINGLE-FILE SPECIFIC RULES:
1. Do NOT change any exported function signatures, types, or interfaces.
2. Do NOT add new exports.
3. Do NOT remove or rename existing exports.
4. Prefer \`ast_replace_function\` for precise function surgery.
5. YOU MUST ACTUALLY MODIFY THE FILE USING TOOLS. Do not just explain the fix.
6. PRESERVE BRACES/BRACKETS. DO NOT accidentally delete closing braces '}'.

WORKFLOW:
1. <think> block: Is this change safe? What exactly will I change?
2. \`read_file_content\` on "${fullPath}" to get current state.
3. Use AST tools (\`ast_replace_function\`, \`ast_add_import\`) for precise surgery.
4. Use standard editing tools (\`multi_replace_file_content\` or \`replace_code_block\`) as fallback.
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
      // Use combined list: impact.affectedFiles + plan.filesToEdit (deduplicated)
      for (const affectedFile of allAffectedFiles) {
        try {
          const affFullPath = path.resolve(rootDir, affectedFile);
          if (fs.existsSync(affFullPath)) {
            // Avoid duplicates in allTargetFiles
            if (!allTargetFiles.some(t => t.path === affectedFile)) {
              const affContent = fs.readFileSync(affFullPath, 'utf-8');
              allTargetFiles.push({ path: affectedFile, fullPath: affFullPath, backup: affContent });
            }
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
            
            // Mark as implemented EARLY — prevents infinite loops in 'tsx watch' environments
            // where the server restarts as soon as the first file is saved.
            try {
              updateProposalStatus(id, 'implemented');
            } catch (statusErr: any) {
              log.error(`[SelfUpgrade] Failed to mark proposal #${id} as implemented early: ${statusErr.message}`);
            }
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

        // Track API usage based on real Swarm generation in the DB
        try {
          const rows = getDb().prepare(`
            SELECT SUM(prompt_tokens) as tin, SUM(completion_tokens) as tout
            FROM usage_tracking
            WHERE task IN ('code_generation', 'coding', 'agent', 'chat') 
            AND created_at >= datetime(?, 'unixepoch')
          `).get(Math.floor(waitStart / 1000)) as { tin: number; tout: number } | undefined;

          let inTokens = rows?.tin || 0;
          let outTokens = rows?.tout || 0;

          // Fallback if no usage captured
          if (inTokens === 0 && outTokens === 0) {
            inTokens = Math.floor(prompt.length / 3.5);
            outTokens = Math.floor((result.result?.length || 0) / 3.5);
          }
          const agentModel = getImplementModel();
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
              if (longestBlock.length < originalContent.length * 0.2) {
                throw new Error(`${specialistName} generated a truncated response (${longestBlock.length} chars vs ${originalContent.length} original).`);
              }
              log.info(`Applying extracted code block to ${fileName}...`);
              fs.writeFileSync(fullPath, longestBlock, 'utf-8');
              saveUpgradeDiff(id, fullPath, originalContent, longestBlock);
              primaryModified = true;
              
              // Mark as review_diff EARLY (extraction fallback)
              try {
                // Save diffs and rollback
                fs.writeFileSync(path.join(path.resolve(process.cwd(), '../data/upgrade_history'), `proposal_${id}_approved.json`), JSON.stringify([{ fullPath, content: longestBlock }]), 'utf-8');
                rollbackAll();
                updateProposalStatus(id, 'review_diff');
                console.log(`\x1b[33m  └─ 👁️ Pending Review — code block extracted, rolled back awaiting approval\x1b[0m`);
                releaseUpgradeLock();
                return true;
              } catch (statusErr: any) {
                log.error(`[SelfUpgrade] Failed to mark proposal #${id} as review_diff (extraction): ${statusErr.message}`);
              }
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
          const finalState: Array<{ fullPath: string; content: string }> = [];
          for (const target of allTargetFiles) {
            try {
              const currentContent = fs.readFileSync(target.fullPath, 'utf-8');
              finalState.push({ fullPath: target.fullPath, content: currentContent });
              if (currentContent !== target.backup) {
                saveUpgradeDiff(id, target.fullPath, target.backup, currentContent);
              }
            } catch { /* skip */ }
          }

          // ═══════════════════════════════════════════════════════════════
          // ── MULTI-TURN SELF-CORRECTION LOOP (max 3 attempts) ──
          // If gatekeeper checks fail, inject the error back into AI
          // and ask it to fix the issue, instead of immediately rejecting.
          // ═══════════════════════════════════════════════════════════════
          const MAX_CORRECTION_ATTEMPTS = 3;
          let gatekeeperPassed = false;
          let lastGatekeeperError = '';

          for (let correctionAttempt = 1; correctionAttempt <= MAX_CORRECTION_ATTEMPTS; correctionAttempt++) {
            if (correctionAttempt > 1) {
              phaseLog('🔄 Self-Correction', `Attempt ${correctionAttempt}/${MAX_CORRECTION_ATTEMPTS} — asking AI to fix: ${lastGatekeeperError.substring(0, 80)}...`);

              // Build correction prompt with the error details
              const correctionPrompt = `You are fixing a COMPILATION ERROR that YOUR PREVIOUS EDIT caused.

[🚨 ERROR FROM PREVIOUS ATTEMPT #${correctionAttempt - 1}]:
${lastGatekeeperError.substring(0, 1500)}

[ORIGINAL PROPOSAL]: ${proposal.title}
[FILE]: ${fullPath}

Your previous edit caused the above error. You MUST:
1. Read the file using \`read_file_content\` to see the current state.
2. Identify exactly what went wrong in your previous edit.
3. Fix the error surgically using file editing tools.
4. Do NOT re-introduce the original bug — only fix the compilation error.
5. Reply "DONE" when fixed, or "SKIP: [reason]" if unfixable.

${commonSafetyRules}`;

              // Delegate correction task to the SAME specialist
              try {
                const correctionTaskId = await swarmCoordinator.delegateTask(
                  {
                    platform: 'system' as any,
                    botId: rootAdmin.botId,
                    botName: rootAdmin.botName,
                    replyWithFile: async () => 'Not supported in autonomous mode'
                  },
                  'code_generation',
                  { message: correctionPrompt, context: `Self-Upgrade Self-Correction — Attempt ${correctionAttempt}` },
                  {
                    toSpecialist: specialistName,
                    priority: 5,
                    timeout: 180000, // 3 min for corrections
                    fromChatId: 'jarvis_self_upgrade',
                    metadata: { proposalId: proposal.id, correctionAttempt }
                  }
                );

                const correctionResult = await swarmCoordinator.waitForTaskResult(correctionTaskId, 180000);
                if (correctionResult?.status !== 'completed' || correctionResult?.error) {
                  phaseLog('🔄 Self-Correction', `Attempt ${correctionAttempt} failed — ${(correctionResult?.error || 'unknown').substring(0, 80)}`);
                  // If correction itself fails, try next attempt
                  continue;
                }

                // Check if AI skipped
                const corrText = String(correctionResult.result || '').trim();
                if (/^SKIP\s*:/i.test(corrText)) {
                  phaseLog('🔄 Self-Correction', `AI skipped correction: ${corrText.substring(0, 80)}`);
                  break; // Don't retry if AI says it can't fix
                }

                phaseLog('🔄 Self-Correction', `AI applied correction, re-running gatekeeper checks...`);
              } catch (corrErr: any) {
                phaseLog('🔄 Self-Correction', `Correction delegation error: ${(corrErr.message || '').substring(0, 80)}`);
                continue;
              }
            }

            // ── Run all gatekeeper checks ──
            let checkFailed = false;
            let checkError = '';

            // 1. Quick Structural Check
            phaseLog('🔍 Structure Check', `validating brackets and declarations... ${correctionAttempt > 1 ? `(attempt ${correctionAttempt})` : ''}`);
            const structErrors: string[] = [];
            for (const target of allTargetFiles) {
              const check = quickStructuralCheck(target.fullPath);
              if (!check.ok) structErrors.push(...check.errors);
            }
            if (structErrors.length > 0) {
              checkError = `Structural validation failed: ${structErrors.join('; ')}`;
              phaseLog('🔍 Structure Check', `FAILED — ${structErrors.length} issue(s)`);
              checkFailed = true;
            } else {
              phaseLog('🔍 Structure Check', 'PASSED — brackets balanced, no duplicates');
            }

            // 2. TSC Verification (only if structure passed)
            if (!checkFailed) {
              phaseLog('🔨 TSC Check', `running TypeScript compiler... ${correctionAttempt > 1 ? `(attempt ${correctionAttempt})` : ''}`);
              try {
                await verifyUpgrade(rootDir, id);
                phaseLog('🔨 TSC Check', 'PASSED — no new compile errors');
              } catch (tscErr: any) {
                checkError = typeof tscErr.stdout === 'string' ? tscErr.stdout : tscErr.message;
                phaseLog('🔨 TSC Check', 'FAILED — new compile errors detected');
                checkFailed = true;
              }
            }

            // 3. esbuild Syntax Check (only if TSC passed)
            if (!checkFailed) {
              phaseLog('🔧 esbuild Check', `validating syntax... ${correctionAttempt > 1 ? `(attempt ${correctionAttempt})` : ''}`);
              try {
                const modifiedPaths = allTargetFiles.map(t => t.fullPath);
                await verifyEsbuildSyntax(modifiedPaths, id);
                phaseLog('🔧 esbuild Check', 'PASSED — all files parse cleanly');
              } catch (esbuildErr: any) {
                checkError = typeof esbuildErr.stdout === 'string' ? esbuildErr.stdout : esbuildErr.message;
                phaseLog('🔧 esbuild Check', 'FAILED — syntax error detected');
                checkFailed = true;
              }
            }

            // 4. Phase 10.5: Test Generation & Execution (only if esbuild passed)
            if (!checkFailed && proposal.type !== 'tool') { // Skip tests for tool declarations
              phaseLog('🧪 Test Gen', `generating and running unit tests... ${correctionAttempt > 1 ? `(attempt ${correctionAttempt})` : ''}`);
              try {
                // We use the primary target file for test generation
                const primaryTarget = allTargetFiles[0];
                const originalCode = primaryTarget.backup;
                const modifiedCode = fs.readFileSync(primaryTarget.fullPath, 'utf-8');
                
                // 4.1 Generate Test
                phaseLog('🧪 Test Gen', 'AI is writing vitest specs...');
                const testCode = await generateTestForChange(
                  originalCode, 
                  modifiedCode, 
                  primaryTarget.fullPath, 
                  proposal.description,
                  specialistName
                );
                
                // 4.2 Run Test
                phaseLog('🧪 Test Run', 'executing generated tests...');
                const testResult = await runGeneratedTest(testCode, proposal.id as number);
                
                if (!testResult.success) {
                  checkError = `Unit tests failed:\n\n${testResult.log}\n\n[Test Code]:\n${testCode}`;
                  phaseLog('🧪 Test Run', 'FAILED — some tests did not pass');
                  checkFailed = true;
                } else {
                  phaseLog('🧪 Test Run', 'PASSED — all generated tests green 🟢');
                }
              } catch (testGenErr: any) {
                // If test generation fails, we don't necessarily fail the proposal,
                // but for Senior Expert level, let's treat it as a hard failure.
                checkError = `Failed to generate or run tests: ${testGenErr.message}`;
                phaseLog('🧪 Test Gen', 'ERROR — could not create tests');
                checkFailed = true;
              }
            }

            if (!checkFailed) {
              gatekeeperPassed = true;
              break; // All checks passed!
            }

            // Store error for next correction attempt
            lastGatekeeperError = checkError;

            if (correctionAttempt < MAX_CORRECTION_ATTEMPTS) {
              // Rollback files before correction attempt
              phaseLog('🔄 Self-Correction', `Rolling back for correction attempt ${correctionAttempt + 1}...`);
              rollbackAll();
            }
          }

          // If all correction attempts exhausted, reject
          if (!gatekeeperPassed) {
            const logDir = path.resolve(process.cwd(), '../data/upgrade_logs');
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
            const logFilePath = path.join(logDir, `proposal_${proposal.id}_rejected.log`);
            fs.writeFileSync(logFilePath, lastGatekeeperError, 'utf-8');

            rollbackAll();
            console.log(`\x1b[31m  └─ ❌ Gatekeeper Failed after ${MAX_CORRECTION_ATTEMPTS} attempts — ${totalModified} file(s) rolled back \x1b[90m(${elapsed()})\x1b[0m`);
            throw new Error(`Gatekeeper rejected after ${MAX_CORRECTION_ATTEMPTS} self-correction attempts (${totalModified} file(s) rolled back). See log: data/upgrade_logs/proposal_${proposal.id}_rejected.log`);
          }

          // ── Runtime Boot Test — ลองบูท server จริงดูว่าไม่พัง (with 1 retry) ──
          const MAX_BOOT_RETRIES = 1;
          let bootPassed = false;
          for (let bootAttempt = 0; bootAttempt <= MAX_BOOT_RETRIES; bootAttempt++) {
            phaseLog('🚀 Boot Test', `spawning test server...${bootAttempt > 0 ? ` (retry ${bootAttempt})` : ''}`);
            try {
              await runtimeBootTest(rootDir, id);
              phaseLog('🚀 Boot Test', 'PASSED — /health responded OK');
              bootPassed = true;
              break;
            } catch (bootErr: any) {
              const errMsg = bootErr.message || 'Unknown boot error';
              phaseLog('🚀 Boot Test', `FAILED — ${errMsg.substring(0, 80)}`);

              if (bootAttempt < MAX_BOOT_RETRIES) {
                // Rollback → ask AI to fix → re-apply
                phaseLog('🔄 Boot Fix', `Rolling back and asking AI to fix runtime error...`);
                rollbackAll();

                const bootFixPrompt = `You are fixing a RUNTIME BOOT ERROR that YOUR PREVIOUS EDIT caused.
The TypeScript compiler was happy, but when the server actually started it crashed.

[🚨 RUNTIME ERROR]:
${errMsg.substring(0, 1500)}

[ORIGINAL PROPOSAL]: ${proposal.title}
[FILE]: ${fullPath}

Your previous edit passed compile checks but crashed the server at runtime. This typically means:
- An import references a module/export that doesn't exist at runtime
- A function is called with wrong argument count/types at runtime
- A circular dependency causes undefined at import time
- A newly added code path throws during server initialization

You MUST:
1. Read the file using \`read_file_content\` to see the current state.
2. Fix the runtime error surgically using file editing tools.
3. Reply "DONE" when fixed, or "SKIP: [reason]" if unfixable.

${commonSafetyRules}`;

                try {
                  const bootFixTaskId = await swarmCoordinator.delegateTask(
                    {
                      platform: 'system' as any,
                      botId: rootAdmin.botId,
                      botName: rootAdmin.botName,
                      replyWithFile: async () => 'Not supported in autonomous mode'
                    },
                    'code_generation',
                    { message: bootFixPrompt, context: `Self-Upgrade Boot Fix — Proposal #${proposal.id}` },
                    {
                      toSpecialist: specialistName,
                      priority: 5,
                      timeout: 180000,
                      fromChatId: 'jarvis_self_upgrade',
                      metadata: { proposalId: proposal.id, bootRetry: bootAttempt + 1 }
                    }
                  );
                  const bootFixResult = await swarmCoordinator.waitForTaskResult(bootFixTaskId, 180000);
                  if (bootFixResult?.status === 'completed' && !/^SKIP\s*:/i.test(String(bootFixResult.result || ''))) {
                    phaseLog('🔄 Boot Fix', 'AI applied fix, re-running boot test...');
                    continue; // Retry boot test
                  }
                } catch (fixErr: any) {
                  phaseLog('🔄 Boot Fix', `Fix delegation failed: ${(fixErr.message || '').substring(0, 80)}`);
                }
              }

              // Final failure — log and reject
              const logDir = path.resolve(process.cwd(), '../data/upgrade_logs');
              if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
              const logFilePath = path.join(logDir, `proposal_${proposal.id}_boot_rejected.log`);
              fs.writeFileSync(logFilePath, errMsg, 'utf-8');

              addLearning(
                'error_solutions',
                `Proposal "${proposal.title}" passed TSC but CRASHED at runtime: ${errMsg.substring(0, 200)}`,
                'runtime_boot_test',
                0.8
              );

              rollbackAll();
              console.log(`\x1b[31m  └─ ❌ Boot Test Failed — ${totalModified} file(s) rolled back \x1b[90m(${elapsed()})\x1b[0m`);
              throw new Error(`Runtime boot test failed (${totalModified} file(s) rolled back): ${errMsg.substring(0, 300)}`);
            }
          }

          // ── Finalization: Save state for Review ──
          phaseLog('✅ All checks passed', 'Saving diff and rolling back for human review...');
          invalidateBaselineCache();

          // Record successful implementation as positive learning (non-critical, ignore errors)
          try {
            addLearning(
              'general',
              `Proposal "${proposal.title}" passed all checks on ${proposal.file_path} (${isMultiFile ? 'multi-file' : 'single-file'}, ${totalModified} files). Awaiting review.`,
              'self_upgrade_success',
              0.6
            );
            logEvolution('self_upgrade_impl', `Proposal #${id} passed checks: ${proposal.title}`, {
              proposalId: id,
              isMultiFile,
              filesModified: totalModified,
              specialist: specialistName,
              passedRuntimeTest: true
            });
          } catch { /* non-critical */ }

          try {
            // Write the final JSON state
            fs.writeFileSync(path.join(path.resolve(process.cwd(), '../data/upgrade_history'), `proposal_${id}_approved.json`), JSON.stringify(finalState), 'utf-8');
            
            // Rollback to original so the system is unchanged until user approves
            rollbackAll();
            
            // Mark as review_diff
            const db = getDb();
            db.prepare(`UPDATE upgrade_proposals SET status = 'review_diff', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);

            console.log(`\x1b[33m  └─ 👁️ Pending Review — ${totalModified} file(s) rolled back awaiting approval \x1b[90m(${elapsed()})\x1b[0m`);
            releaseUpgradeLock();
            return true;
          } catch (finErr: any) {
            log.error(`[SelfUpgrade] Failed to finalize proposal #${id} to review_diff: ${finErr.message}`);
            rollbackAll();
            throw new Error(`Failed to save review state: ${finErr.message}`);
          }
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

      // §4.1: Record anti_pattern learning from rejection
      try {
        const { addLearning } = await import('./learningJournal.js');
        // Only record pattern for non-generic errors (quota, timeout, etc. are not anti-patterns)
        const isGenericError = /429|quota|timeout|ECONNREFUSED|SIGTERM/i.test(errMsg);
        if (!isGenericError && proposal.file_path) {
          const antiPatternInsight = `[Anti-Pattern] File: ${proposal.file_path} | Proposal: "${proposal.title}" failed: ${errMsg.substring(0, 200)}`;
          addLearning('anti_pattern', antiPatternInsight, `rejection_proposal_${id}`, 0.6);
          log.debug(`[SelfUpgrade] Recorded anti_pattern learning for proposal #${id}`);
        }
      } catch { /* best effort */ }
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

    const modelName = getScanModel();
    const response = await aiChat('chat', [{ role: 'user', content: prompt }], { model: modelName });
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
          model_used: modelName,
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

    // Pre-scan: Ensure Protected Core Files are in Second Brain (read-only architecture).
    // These files are not scanned for proposals but their exports/deps MUST be known
    // so the AI specialist can understand cross-file dependencies when implementing fixes.
    try { await mapProtectedCoresToSecondBrain(rootDir); } catch { /* non-critical */ }

    // Build Dependency Graph + update embeddings (non-critical, runs after nodes are populated)
    try { await buildDependencyGraph(rootDir); } catch { /* non-critical */ }
    try { await updateCodeEmbeddings(rootDir); } catch { /* non-critical */ }

    // Queue Zero: Auto-implement approved proposals
    // Req 6: Scan 100% first, then Upgrade — UNLESS there are pending Auto-Fix tasks
    //   - In Auto-Fix mode (!DRY_RUN): if there are approved tasks pre-existing before scan,
    //     implement them FIRST, then restart scan from 0%.
    //   - In Propose mode (DRY_RUN): never auto-implement, just scan.
    //   - When _paused is true (continuous scan mode): skip auto-implement to let scan complete.
    const scanComplete = _fileIndex.length > 0 && _scanCursor >= _fileIndex.length;

    if (!DRY_RUN) {
      // Check if there are pre-existing approved proposals (from before this scan cycle)
      let approvedCount = 0;
      try {
        const db = getDb();
        const row = db.prepare(`SELECT COUNT(*) as cnt FROM upgrade_proposals WHERE status = 'approved'`).get() as { cnt: number };
        approvedCount = row?.cnt || 0;
      } catch { /* ignore */ }

      if (approvedCount > 0 && !_isManualScanActive) {
        // Auto-Fix with pending approved tasks (from timer-based auto cycle): implement first
        const implemented = await implementPendingProposals(rootDir);
        if (implemented > 0) {
          log.info(`[SelfUpgrade] Implemented ${implemented} pending tasks. Yielding scan to next cycle.`);
          isUpgrading = false;
          return;
        }
      } else if (scanComplete && approvedCount > 0) {
        // Scan reached 100% — now implement approved proposals
        log.info(`[SelfUpgrade] Scan 100% complete. Now implementing ${approvedCount} approved proposals...`);
        const implemented = await implementPendingProposals(rootDir);
        if (implemented > 0) {
          // Reset scan cursor to start fresh after implementation
          _scanCursor = 0;
          log.info(`[SelfUpgrade] Implemented ${implemented} tasks post-scan. Resetting scan cursor for next cycle.`);
          isUpgrading = false;
          return;
        }
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
export async function startSelfUpgrade(rootDir: string): Promise<void> {
  if (upgradeInterval) {
    log.warn('Self-upgrade already running');
    return;
  }

  ensureUpgradeTable();
  _currentRootDir = rootDir;
  _coldBootFlagPath = path.resolve(process.cwd(), 'COLD_BOOT.flag');

  // Load persisted configuration
  refreshConfig();
  
  log.info(`Self-Upgrade System initialized (Interval: ${Math.round(CHECK_INTERVAL_MS/60000)}m, Idle: ${Math.round(IDLE_THRESHOLD_MS/60000)}m, Dry-Run: ${DRY_RUN})`);

  // Initial activity stamp
  lastUserActivity = Date.now();

  // Use self-rescheduling setTimeout so the interval timer starts AFTER cycle completes,
  // not at a fixed cadence (Req 5: timer restarts after scan+upgrade 100% complete)
  const scheduleNextCycle = () => {
    upgradeInterval = setTimeout(async () => {
      try {
        await runUpgradeCycle(rootDir, false);
      } catch (err) {
        log.error('Upgrade cycle error', { error: String(err) });
      }
      // Re-schedule only after current cycle finishes
      if (upgradeInterval) scheduleNextCycle();
    }, CHECK_INTERVAL_MS);
  };
  scheduleNextCycle();

  // --- Persistent State Restoration ---
  try {
    // 0. Check for Cold Boot Flag (Session Safety)
    const isColdBoot = fs.existsSync(_coldBootFlagPath);
    if (isColdBoot) {
      _paused = true;
      setSetting('upgrade_paused', 'true');
      setSetting('upgrade_continuous_scan', 'false');
      log.info(`[SelfUpgrade] 🧊 Cold Boot detected (via flag file). System forced to PAUSED state.`);
    } else {
      // Normal Restore (Hot Reload / Atomic Restart)
      // 0. Restore Auto-Upgrade Pause State
      // Default: paused (OFF) unless DB explicitly says 'false'
      const isPaused = getSetting('upgrade_paused');
      if (isPaused === 'false') {
        _paused = false;
        log.info('[SelfUpgrade] Auto-Upgrade is running normally (restored from DB).');
      } else {
        _paused = true;
        log.info(`[SelfUpgrade] Auto-Upgrade is PAUSED (db=${isPaused ?? 'not set'}).`);
      }
    }

    // 0.5 Restore Auto-Fix State
      const autoFix = getSetting('upgrade_auto_fix');
      if (autoFix === 'false') {
        DRY_RUN = true;
        log.info('[SelfUpgrade] Auto-Fix is disabled. System will only propose changes.');
      } else {
        DRY_RUN = false; // By default, Auto-Fix is enabled
        log.info('[SelfUpgrade] Auto-Fix is ENABLED. System will autonomously implement pending fixes.');
      }

      // 1. Restore Continuous Scan State
      const isContinuous = getSetting('upgrade_continuous_scan');
      if (isContinuous === 'true') {
        log.info('[SelfUpgrade] Resuming Continuous Scan mode after server restart...');
        _paused = true;
        executeContinuousStart(rootDir);
      }

      // 2. Resume Batch Implementation (Queue Zero)
      const isBatching = getSetting('upgrade_implement_all');
      if (isBatching === 'true') {
        // Delay slightly to allow server to fully boot and recovery logic (ensureUpgradeTable) to finish transactions
        setTimeout(() => {
          resumeBatchImplementation(rootDir).catch(e => {
            log.error('[SelfUpgrade] Failed to resume batch implementation', { error: e.message });
          });
        }, 3000);
      }
    } catch (err: any) {
      log.warn(`[SelfUpgrade] Failed to restore state from DB: ${err.message}`);
    }
}

/** Stop the self-upgrade loop */
export function stopSelfUpgrade(): void {
  if (upgradeInterval) {
    clearTimeout(upgradeInterval);
    upgradeInterval = null;
    log.info('Self-Upgrade System stopped');
  }
  if (_continuousScanTimeout) {
    clearTimeout(_continuousScanTimeout);
    _continuousScanTimeout = null;
  }
  _isManualScanActive = false;
}

/** Toggle pause status of the self-upgrade loop (Master switch) */
export function setUpgradePaused(paused: boolean): void {
  _paused = paused;
  try { setSetting('upgrade_paused', paused ? 'true' : 'false'); } catch { /* ignore */ }
  log.info(`Self-Upgrade System ${paused ? 'PAUSED (OFF)' : 'RESUMED (ON)'}`);

  // When pausing: also stop any active continuous scan
  if (paused) {
    if (_continuousScanTimeout) {
      clearTimeout(_continuousScanTimeout);
      _continuousScanTimeout = null;
      _isManualScanActive = false;
      try { setSetting('upgrade_continuous_scan', 'false'); } catch { /* ignore */ }
      log.info('Continuous scan mode stopped via Master switch (OFF).');
    }
  }
  // When un-pausing: just set _paused=false and let the normal timer-based loop handle cycles.
  // Do NOT auto-start continuous scan — that's only triggered by the "เริ่ม Scan ทันที" button.
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
  isManualScanActive: boolean;
  isBatchActive: boolean;
  isUpgrading: boolean;
} {
  const idleMs = getOsIdleTimeMs();
  const total = _fileIndex.length || 1;

  // Check if batch implementation is currently active
  let batchActive = false;
  try {
    batchActive = getSetting('upgrade_implement_all') === 'true';
  } catch { /* ignore */ }

  return {
    running: !!upgradeInterval || !!_continuousScanTimeout,
    isContinuousActive: !!_continuousScanTimeout,
    isManualScanActive: _isManualScanActive,
    isUpgrading,
    paused: _paused,
    isIdle: _isManualScanActive ? false : isSystemIdle(),
    idleMinutes: _isManualScanActive ? 0 : Math.round(idleMs / 60000),
    idleThresholdMinutes: Math.round(IDLE_THRESHOLD_MS / 60000),
    checkIntervalMs: CHECK_INTERVAL_MS,
    scanProgress: {
      cursor: _scanCursor,
      total: _fileIndex.length,
      percent: Math.round((_scanCursor / total) * 100),
    },
    dryRun: DRY_RUN,
    isBatchActive: batchActive,
  };
}

/** Reset AI Token usage statistics */
export function resetUpgradeUsage(): void {
  resetUpgradeStats();
}

/** Approve all pending proposals in one go */
export function approveAllPendingProposals(): number {
  try {
    ensureUpgradeTable();
    const db = getDb();
    const result = db.prepare(`UPDATE upgrade_proposals SET status = 'approved', reviewed_at = datetime('now') WHERE status = 'pending'`).run();
    return result.changes || 0;
  } catch (err: any) {
    console.error('[SelfUpgrade] approveAllPendingProposals error:', err.message);
    return 0;
  }
}

/** Clear the cold boot safety flag to allow persistence */
function clearColdBootFlag(): void {
  if (_coldBootFlagPath && fs.existsSync(_coldBootFlagPath)) {
    try {
      fs.unlinkSync(_coldBootFlagPath);
      log.info('[SelfUpgrade] Cold Boot flag cleared. State will now persist through restarts.');
    } catch { /* ignore */ }
  }
}

/** Stop any active batch implementation by clearing the DB flag */
export function stopBatchImplementation(): boolean {
  try {
    setSetting('upgrade_implement_all', 'false');
    console.log('\x1b[33m[SelfUpgrade] Batch implementation stop requested by user.\x1b[0m');
    return true;
  } catch (err: any) {
    console.error('[SelfUpgrade] stopBatchImplementation error:', err.message);
    return false;
  }
}

/** Update scan configuration and restart loop if needed */
export async function updateUpgradeConfig(config: { intervalMs?: number, idleThresholdMs?: number, autoFix?: boolean }): Promise<void> {
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

  if (typeof config.autoFix === 'boolean') {
    DRY_RUN = !config.autoFix;
    setSetting('upgrade_auto_fix', config.autoFix ? 'true' : 'false');
    log.info(`Auto-Fix mode updated to ${config.autoFix}`);
    if (config.autoFix) clearColdBootFlag();
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
      _continuousScanTimeout = setTimeout(cycle, 5000);
      return;
    }

    try {
      await runUpgradeCycle(rootDir, true);

      // Req 8: After scan reaches 100%, check mode condition
      const scanDone = _fileIndex.length > 0 && _scanCursor >= _fileIndex.length;
      if (scanDone) {
        log.info('[SelfUpgrade] Continuous scan reached 100%.');

        if (!DRY_RUN) {
          // Auto-Fix mode: auto-approve all pending proposals, then implement
          const approved = approveAllPendingProposals();
          if (approved > 0) {
            log.info(`[SelfUpgrade] Auto-Fix: approved ${approved} pending proposals. Starting implementation...`);
          }
          // Implementation will happen in the next cycle via runUpgradeCycle's Queue Zero logic
        } else {
          // Propose mode: leave proposals as pending for user to manually approve
          log.info('[SelfUpgrade] Propose mode: scan complete. Proposals are pending for user review.');
        }
      }
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
  if (_continuousScanTimeout) {
    clearTimeout(_continuousScanTimeout);
    _continuousScanTimeout = null;
    _isManualScanActive = false;
    setSetting('upgrade_continuous_scan', 'false');
    log.info('Continuous scan mode stopped explicitly.');
    return false;
  }

  _paused = true;
  setSetting('upgrade_continuous_scan', 'true');
  
  clearColdBootFlag();
  
  log.info('Continuous scan mode requested');
  executeContinuousStart(rootDir);
  
  return true;
}

// ── Diff Review Approval ──

export function approveDiff(id: number): boolean {
  try {
    const db = getDb();
    const proposal = db.prepare('SELECT status FROM upgrade_proposals WHERE id = ?').get(id) as { status: string } | undefined;
    if (!proposal || proposal.status !== 'review_diff') return false;

    const historyDir = path.resolve(process.cwd(), '../data/upgrade_history');
    const jsonPath = path.join(historyDir, `proposal_${id}_approved.json`);
    
    if (!fs.existsSync(jsonPath)) {
      throw new Error('Approved state JSON not found');
    }

    const stateStr = fs.readFileSync(jsonPath, 'utf-8');
    const finalState: Array<{ fullPath: string; content: string }> = JSON.parse(stateStr);

    // Apply the saved state back to the real files
    for (const fileState of finalState) {
      log.info(`[SelfUpgrade] Applying diff to ${fileState.fullPath}`);
      fs.writeFileSync(fileState.fullPath, fileState.content, 'utf-8');
    }

    // Mark as implemented
    db.prepare(`UPDATE upgrade_proposals SET status = 'implemented', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    log.info(`[SelfUpgrade] Proposal #${id} diff approved and applied to ${finalState.length} files`);
    return true;
  } catch (err: any) {
    log.error(`[SelfUpgrade] Failed to approve diff for #${id}: ${err.message}`);
    return false;
  }
}

export function rejectDiff(id: number, reason: string = 'Human rejected diff'): boolean {
  try {
    const db = getDb();
    const proposal = db.prepare('SELECT status, title FROM upgrade_proposals WHERE id = ?').get(id) as { status: string, title?: string } | undefined;
    if (!proposal || proposal.status !== 'review_diff') return false;

    db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
      .run(`\n\n[Diff Rejected]: ${reason}`, id);
      
    addLearning('general', `User rejected the diff for "${proposal.title || id}": ${reason}`, 'user_feedback', 0.8);
    log.info(`[SelfUpgrade] Proposal #${id} diff rejected by user.`);
    return true;
  } catch (err: any) {
    log.error(`[SelfUpgrade] Failed to reject diff for #${id}: ${err.message}`);
    return false;
  }
}
