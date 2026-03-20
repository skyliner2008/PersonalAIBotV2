// ============================================================
// Self-Upgrade API Routes — CRUD สำหรับ upgrade proposals
// ============================================================

import { Router } from 'express';
import {
  getProposals,
  getProposalStats,
  updateProposalStatus,
  deleteProposal,
  getUpgradeStatus,
  forceScan,
  notifyUserActivity,
} from '../evolution/selfUpgrade.js';
import type { ProposalStatus, ProposalType } from '../evolution/selfUpgrade.js';
import { asyncHandler } from '../utils/errorHandler.js';
import { createLogger } from '../utils/logger.js';
import path from 'path';
import * as fs from 'fs';

const log = createLogger('UpgradeRoutes');
const router = Router();

// GET /api/upgrade/status — ดูสถานะระบบ self-upgrade
router.get('/status', asyncHandler(async (_req, res) => {
  const status = getUpgradeStatus();
  const stats = getProposalStats();
  res.json({ ok: true, status, stats });
}));

// GET /api/upgrade/proposals — ดูรายการ proposals
router.get('/proposals', asyncHandler(async (req, res) => {
  const status = (req.query.status as ProposalStatus) || undefined;
  const type = (req.query.type as ProposalType) || undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 2000);
  const offset = parseInt(req.query.offset as string) || 0;

  const proposals = getProposals(status, type, limit, offset);
  const stats = getProposalStats();
  res.json({ ok: true, proposals, stats, limit, offset });
}));

// PATCH /api/upgrade/proposals/:id — อัพเดทสถานะ proposal
router.patch('/proposals/:id', asyncHandler(async (req, res) => {
  const id = parseInt(String(req.params.id));
  const { status } = req.body as { status: ProposalStatus };

  if (!id || !status) {
    res.status(400).json({ ok: false, error: 'Missing id or status' });
    return;
  }

  const validStatuses: ProposalStatus[] = ['pending', 'approved', 'rejected', 'implemented', 'implementing'];
  if (!validStatuses.includes(status)) {
    res.status(400).json({ ok: false, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    return;
  }

  const success = updateProposalStatus(id, status);
  if (success) {
    log.info(`Proposal #${id} status updated to "${status}"`);
    res.json({ ok: true, id, status });
  } else {
    res.status(404).json({ ok: false, error: 'Proposal not found' });
  }
}));

// DELETE /api/upgrade/proposals/:id — ลบ proposal
router.delete('/proposals/:id', asyncHandler(async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (!id) {
    res.status(400).json({ ok: false, error: 'Missing id' });
    return;
  }

  const success = deleteProposal(id);
  if (success) {
    res.json({ ok: true, id });
  } else {
    res.status(404).json({ ok: false, error: 'Proposal not found' });
  }
}));

// GET /api/upgrade/proposals/:id/diff — Get before/after code diff for implemented proposals
router.get('/proposals/:id/diff', asyncHandler(async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (!id) {
    res.status(400).json({ ok: false, error: 'Missing id' });
    return;
  }

  const historyDir = path.resolve(process.cwd(), '../data/upgrade_history');
  const beforeFile = path.join(historyDir, `proposal_${id}_before.txt`);
  const afterFile = path.join(historyDir, `proposal_${id}_after.txt`);
  
  if (fs.existsSync(beforeFile) && fs.existsSync(afterFile)) {
    const beforeContent = fs.readFileSync(beforeFile, 'utf-8');
    const afterContent = fs.readFileSync(afterFile, 'utf-8');
    res.json({ ok: true, before: beforeContent, after: afterContent });
  } else {
    res.status(404).json({ ok: false, error: 'Diff not found for this proposal' });
  }
}));

// POST /api/upgrade/scan — บังคับสแกนรอบเดียว (สำหรับทดสอบ)
router.post('/scan', asyncHandler(async (_req, res) => {
  const rootDir = path.resolve(process.cwd(), 'src');
  try {
    const result = await forceScan(rootDir);
    res.json({ ok: true, findings: result.totalFindings, newFindings: result.newFindings, message: `Scanned batch, found ${result.totalFindings} issues` });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
}));

// POST /api/upgrade/implement-all — สั่ง implement ทุกรายการที่ approved
import { setSetting } from '../database/db.js';
import { implementProposalById, ensureUpgradeTable } from '../evolution/selfUpgrade.js';

router.post('/implement-all', asyncHandler(async (_req, res) => {
  const rootDir = path.resolve(process.cwd(), 'src');
  
  // Set flag in database so it resumes on restart
  setSetting('upgrade_implement_all', 'true');
  
  res.json({ ok: true, message: `Batch implementation started. The system will process approved proposals sequentially and survive server restarts.` });
  
  log.info(`[upgradeRoutes] API triggered batch implementation for ALL approved proposals`);
  
  process.nextTick(async () => {
    try {
      const { resumeBatchImplementation } = await import('../evolution/selfUpgrade.js');
      await resumeBatchImplementation(rootDir);
    } catch (err: any) {
      log.error(`[SelfUpgrade] Batch implementation failed: ${err.message}`);
    }
  });
}));

// POST /api/upgrade/implement/:id — สั่ง implement proposal เฉพาะตัว

router.post('/implement/:id', asyncHandler(async (req, res) => {
  const id = parseInt(String(req.params.id));
  if (!id) {
    res.status(400).json({ ok: false, error: 'Missing id' });
    return;
  }
  const rootDir = path.resolve(process.cwd(), 'src');
  
  updateProposalStatus(id, 'implementing');

  // Respond immediately so UI doesn't spin forever when server restarts
  res.json({ ok: true, message: `Implementation started softly for proposal #${id}. The server may restart upon completion.` });
  
  log.info(`[upgradeRoutes] API triggered background implementation for proposal #${id}`);

  // Run the 3-5 minute task in the background
  process.nextTick(() => {
    log.info(`[upgradeRoutes] Inside process.nextTick for proposal #${id}`);
    implementProposalById(id, rootDir).catch((err: any) => {
      log.error(`[SelfUpgrade] Background implementation failed for #${id}: ${err.message}`);
    });
  });
}));

// PATCH /api/upgrade/config — ปรับแต่งค่าระบบ
import { updateUpgradeConfig, setUpgradePaused } from '../evolution/selfUpgrade.js';

router.patch('/config', asyncHandler(async (req, res) => {
  const { intervalMs, idleThresholdMs } = req.body as { intervalMs?: number, idleThresholdMs?: number };
  
  if (!intervalMs && !idleThresholdMs) {
    res.status(400).json({ ok: false, error: 'Missing configuration parameters' });
    return;
  }

  await updateUpgradeConfig({ intervalMs, idleThresholdMs });
  res.json({ ok: true, message: 'Configuration updated successfully' });
}));

// PATCH /api/upgrade/toggle — เปิด/ปิด Auto-Upgrade
router.patch('/toggle', asyncHandler(async (req, res) => {
  const { paused } = req.body as { paused: boolean };
  if (typeof paused !== 'boolean') {
    res.status(400).json({ ok: false, error: 'Missing paused boolean' });
    return;
  }
  setUpgradePaused(paused);
  res.json({ ok: true, paused });
}));

// POST /api/upgrade/activity — แจ้งว่า user กำลังใช้งาน (สำหรับ dashboard ping)
router.post('/activity', (_req, res) => {
  notifyUserActivity();
  res.json({ ok: true });
});

export default router;
