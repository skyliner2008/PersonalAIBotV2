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
  let totalApproved = db.prepare(`SELECT COUNT(*) as count FROM upgrade_proposals WHERE status = 'approved'`).get() as { count: number };
  let currentTaskNumber = 1;
  const initialApprovedCount = totalApproved ? totalApproved.count : 0;
  
  if (initialApprovedCount > 0) {
    console.log(`\n\x1b[36m[SelfUpgrade] In progress Upgrade ${currentTaskNumber} / ${initialApprovedCount} approved\x1b[0m`);
  }

  while (dbModule.getSetting('upgrade_implement_all') === 'true') {
    const nextProposal = db.prepare(`
      SELECT id FROM upgrade_proposals 
      WHERE status = 'approved' 
      ORDER BY CASE priority WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END DESC, created_at ASC 
      LIMIT 1
    `).get() as { id: number } | undefined;

    if (!nextProposal) {
      dbModule.setSetting('upgrade_implement_all', 'false');
      console.log('\n\x1b[36m[SelfUpgrade] Batch implementation complete. No approved proposals left.\x1b[0m');
      break;
    }

    if (currentTaskNumber > 1) {
       console.log(`\n\x1b[36m[SelfUpgrade] In progress Upgrade ${currentTaskNumber} / ${initialApprovedCount} approved\x1b[0m`);
    }
    updateProposalStatus(nextProposal.id, 'implementing');
    
    try {
      const success = await implementProposalById(nextProposal.id, rootDir);
      if (!success) {
        console.log(`\x1b[31m[SelfUpgrade] Proposal #${nextProposal.id} : Rejected\x1b[0m`);
      } else {
        console.log(`\x1b[32m[SelfUpgrade] Proposal #${nextProposal.id} : Succeed\x1b[0m`);
      }
      currentTaskNumber++;
    } catch (err: any) {
      console.log(`\x1b[31m[SelfUpgrade] Proposal #${nextProposal.id} : Rejected (Error)\x1b[0m`);
      currentTaskNumber++;
    }
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
      log.info('Migrating upgrade_proposals table to support implementing status...');
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
          reviewed_at DATETIME
        );
        INSERT INTO upgrade_proposals_new SELECT * FROM upgrade_proposals;
        DROP TABLE upgrade_proposals;
        ALTER TABLE upgrade_proposals_new RENAME TO upgrade_proposals;
      `);
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
    
    // Auto-recovery: If the server crashed while 'implementing', reset them to 'approved' so they can be retried.
    const resetCount = db.prepare("UPDATE upgrade_proposals SET status = 'approved' WHERE status = 'implementing'").run().changes;
    if (resetCount > 0) log.info(`Recovered ${resetCount} stuck proposals from 'implementing' back to 'approved'`);
    
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
  ]);
  const SCAN_EXTENSIONS = new Set([
    '.ts', '.tsx', '.js', '.jsx', '.json', '.sql', '.md',
    '.css', '.html', '.yaml', '.yml', '.env.example',
  ]);
  
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
    'api/upgradeRoutes.ts'
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
    const existing = db.prepare(
      `SELECT id FROM upgrade_proposals WHERE file_path = ? AND title = ? AND status = 'pending' LIMIT 1`
    ).get(normalizedPath, proposal.title);
    if (existing) return { id: (existing as any).id, isNew: false };

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
  total: number; pending: number; approved: number; rejected: number; implemented: number;
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

    const typeRows = db.prepare('SELECT type, COUNT(*) as c FROM upgrade_proposals GROUP BY type').all() as any[];
    const byType: Record<string, number> = {};
    for (const r of typeRows) byType[r.type] = r.c;

    const prioRows = db.prepare('SELECT priority, COUNT(*) as c FROM upgrade_proposals GROUP BY priority').all() as any[];
    const byPriority: Record<string, number> = {};
    for (const r of prioRows) byPriority[r.priority] = r.c;

    const tokensIn = parseFloat(getSetting('upgrade_tokens_in') || '0');
    const tokensOut = parseFloat(getSetting('upgrade_tokens_out') || '0');
    const costUsd = parseFloat(getSetting('upgrade_cost_usd') || '0');

    return { total, pending, approved, rejected, implemented, byType, byPriority, tokensIn, tokensOut, costUsd };
  } catch {
    return { total: 0, pending: 0, approved: 0, rejected: 0, implemented: 0, byType: {}, byPriority: {}, tokensIn: 0, tokensOut: 0, costUsd: 0 };
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

      const prompt = `You are an expert AI code reviewer. Analyze the following code for bugs, security vulnerabilities, optimization opportunities, and refactoring needs.
For each issue found, provide a fix.

Respond in pure JSON format (an array of objects).
[
  {
    "type": "bug" | "feature" | "optimization" | "refactor" | "tool" | "security",
    "title": "Short title",
    "description": "Detailed explanation",
    "line_range": "line number or range (e.g., '10-15')",
    "suggested_fix": "Complete corrected code snippet to replace the old code",
    "priority": "low" | "medium" | "high" | "critical",
    "confidence": 0.8
  }
]

If no issues are found, return []. Do not wrap the JSON in Markdown (no \`\`\`json block).

File: ${relPath}
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
      log.warn(`LLM analysis failed for ${filePath}: ${err.message}`);
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

/** Helper to run TSC check */
async function verifyUpgrade(rootDir: string, proposalId: number): Promise<void> {
  log.debug(`Running tsc check for proposal #${proposalId}...`);
  const checkDir = path.resolve(rootDir, '..'); // Server project dir
  await execPromise('npx tsc --noEmit', { cwd: checkDir });
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
  
  // 🛡️ Immortal Core Sandbox Hard-Blocker
  // Failsafe in case a proposal targeting a core file was generated manually or pre-dates the blacklist
  const PROTECTED_CORE_FILES = new Set([
    'index.ts', 'config.ts', 'configValidator.ts', 'queue.js',
    'database/db.ts', 'database/db.js',
    'evolution/selfUpgrade.ts', 'evolution/selfReflection.ts',
    'terminal/terminalGateway.ts', 'api/socketHandlers.ts', 'api/upgradeRoutes.ts'
  ]);
  
  if (PROTECTED_CORE_FILES.has(relativePath)) {
    log.warn(`[SelfUpgrade] Hard-blocked implementation of proposal #${proposal.id} because "${relativePath}" is an Immortal Core Sandbox file.`);
    db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
      .run(`\n\n[System Failsafe]: Rejected. This file (${relativePath}) is part of the Protected Core Server Infrastructure and cannot be auto-upgraded to prevent unrecoverable Node.js crashes.`, id);
    return false;
  }

  console.log(`\x1b[36m[SelfUpgrade] Proposal #${proposal.id} : ${proposal.title}\x1b[0m`);

  const fullPath = path.resolve(rootDir, proposal.file_path);
  let originalContent = '';
  try {
    originalContent = fs.readFileSync(fullPath, 'utf-8');
  } catch (err: any) {
    log.error(`Could not read file for proposal #${proposal.id}`, { error: err.message });
    updateProposalStatus(id, 'rejected');
    return false;
  }

  const prompt = `You are an elite, senior Software Engineer AI autonomously upgrading your own codebase.
You have received an upgrade proposal that MUST be implemented in precisely ONE file.

CRITICAL RULES:
1. DO NOT rename, move, or hallucinate new file paths. You are ONLY authorized to edit the EXACT "File to Modify".
2. When replacing code, do NOT replace the entire file. Use surgical precision. Target only the relevant small blocks.
3. If fixing TypeScript errors or "any" types, you MUST match the existing imports. Do NOT define conflicting local interfaces if an interface is already imported from another file.
4. Code must compile via \`tsc\` perfectly. Ensure no mismatching signatures.
5. IF you are modifying an interface or changing required properties (e.g. from snake_case to camelCase), you MUST think about where else this interface is initialized. If you do not have visibility into the rest of the project, DO NOT RENAME PROPERTIES that will break the build (TS2345). Alternatively, make them optional if it's safe.

[STEP 1: PLAN & THINK]
Before modifying the code, output a <think> block explaining your surgical edit. Double-check your type definitions.

[STEP 2: SURGICAL EDIT]
You MUST use the \`replace_code_block\` tool to edit the file.
Identify the EXACT lines to replace and use \`replace_code_block(file_path, exact_old_string, new_string)\`.
WARNING: Do NOT use \`write_file_content\` to replace the entire file, as this is destructive and forbidden!

When you are done, reply with "DONE".

Proposal Title: ${proposal.title}
Description: ${proposal.description}
File to Modify: ${fullPath}
Suggested Fix snippet: ${proposal.suggested_fix || 'No snippet provided, you must infer the fix.'}

Current File Content:
\`\`\`typescript
${originalContent}
\`\`\``;

  try {
    const rootAdmin = getRootAdminIdentity();
    const swarmCoordinator = getSwarmCoordinator();
    const sortedSpecs = getSortedImplementationSpecialists(swarmCoordinator);

    let lastError = '';
    for (const specialistName of sortedSpecs) {
      log.info(`Attempting implementation of proposal #${proposal.id} using ${specialistName}...`);
      
      try {
        const taskId = await swarmCoordinator.delegateTask(
          {
            platform: 'system' as any,
            botId: rootAdmin.botId,
            botName: rootAdmin.botName,
            replyWithFile: async () => 'Not supported in autonomous mode'
          },
          'code_generation',
          { message: prompt, context: 'Self-Upgrade System Autonomous Execution' },
          {
            toSpecialist: specialistName,
            priority: 4,
            timeout: 300000,
            fromChatId: 'jarvis_self_upgrade',
            metadata: { proposalId: proposal.id }
          }
        );

        // Inject global synchronous hook interceptor
        (global as any).onFileWrittenByTool = (writtenPath: string) => {
          if (path.resolve(writtenPath) === path.resolve(fullPath)) {
            log.info(`[SelfUpgrade] Intercepted native file modification for proposal #${id}.`);
            updateProposalStatus(id, 'implemented');
            try {
               saveUpgradeDiff(id, originalContent, fs.readFileSync(fullPath, 'utf-8'));
            } catch {}
            logEvolution('self_upgrade_impl', `Successfully implemented proposal #${id}: ${proposal.title}`, {
              proposalId: id,
              specialist: specialistName
            });
            (global as any).onFileWrittenByTool = undefined;
          }
        };

        const result = await swarmCoordinator.waitForTaskResult(taskId, 300000);
        
        // Track API usage
        try {
          const inTokens = Math.floor(prompt.length / 3.5);
          const outTokens = Math.floor((result.result?.length || 0) / 3.5);
          let agentModel = getSetting('ai_task_code_generation_model') || getSetting('ai_task_agent_model') || getSetting('ai_model') || 'gemini-2.0-flash';
          trackUpgradeTokens(agentModel, inTokens, outTokens);
        } catch (e) { log.warn(`Token tracking estimation failed: ${String(e)}`); }
        
        (global as any).onFileWrittenByTool = undefined;

        if (result.status === 'completed') {
          let newContent = fs.readFileSync(fullPath, 'utf-8');

          // Fallback: extract code block if file wasn't modified by tool
          if (newContent === originalContent && result.result) {
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
              newContent = longestBlock;
            }
          }

          if (newContent === originalContent) {
            throw new Error(`${specialistName} completed the task but did not modify the target file.`);
          }

          log.info(`Successfully implemented proposal #${proposal.id} using ${specialistName}`);
          
          try {
            await verifyUpgrade(rootDir, id);
          } catch (tscErr: any) {
             const errMsg = typeof tscErr.stdout === 'string' ? tscErr.stdout : tscErr.message;
             
             // Write compiler error to log file instead of polluting standard output
             const logDir = path.resolve(process.cwd(), '../data/upgrade_logs');
             if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
             const logFilePath = path.join(logDir, `proposal_${proposal.id}_rejected.log`);
             fs.writeFileSync(logFilePath, errMsg, 'utf-8');
             
             fs.writeFileSync(fullPath, originalContent, 'utf-8');
             throw new Error(`Compiler rejected the fix. See log: data/upgrade_logs/proposal_${proposal.id}_rejected.log`);
          }

          updateProposalStatus(id, 'implemented');
          logEvolution('self_upgrade_impl', `Successfully implemented proposal #${id}: ${proposal.title}`, {
            proposalId: id,
            specialist: specialistName
          });
          return true;
        } else {
          lastError = result.error || 'Unknown error';
        }
      } catch (err: any) {
        lastError = err.message;
      }

      if (specialistName !== sortedSpecs[sortedSpecs.length - 1]) {
        log.info(`[Fallback Routing] Handing over proposal #${proposal.id} to the next specialist...`);
      }
    }

    throw new Error(`All implementation specialists failed for proposal #${proposal.id}. Last error: ${lastError}`);
  } catch (err: any) {
    fs.writeFileSync(fullPath, originalContent, 'utf-8');
    db.prepare(`UPDATE upgrade_proposals SET status = 'rejected', description = description || ? WHERE id = ?`)
      .run(`\n\nAuto-Implement Failed: ${err.message}`, id);
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
  
  // 1. Analyze rejected proposals
  const rejected = db.prepare(`SELECT * FROM upgrade_proposals WHERE status = 'rejected' LIMIT 5`).all() as UpgradeProposal[];
  for (const p of rejected) {
    addLearning('error_solutions', `Auto-implement failed for pattern: ${p.title}. Reason: ${p.description}`, 'self_upgrade', 0.8);
    // Mark as reviewed so we don't process it again for learning
    db.prepare(`UPDATE upgrade_proposals SET status = 'failed', priority = 'low', confidence = confidence - 0.2 WHERE id = ?`).run(p.id);
    learningsAdded++;
  }
  
  // 2. Analyze implemented proposals
  const implemented = db.prepare(`SELECT * FROM upgrade_proposals WHERE status = 'implemented' LIMIT 5`).all() as UpgradeProposal[];
  for (const p of implemented) {
    addLearning('performance', `Successfully auto-implemented pattern: ${p.title}`, 'self_upgrade', 0.9);
    // Mark as archived or leave it, maybe just decrease confidence so it's not processed again or we don't need to do anything.
    // Actually, just delete or keep.
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
    // Yield to bot interaction safely
    if (Date.now() - lastUserActivity < 60000 && !_isManualScanActive) {
      log.info('Continuous scan yielding gracefully due to user bot interaction');
      _continuousScanTimeout = null;
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
