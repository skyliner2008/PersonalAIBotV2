/**
 * Goal API Routes — CRUD for goal tracking
 */
import { Router } from 'express';
import { asyncHandler } from '../../utils/errorHandler.js';
import { requireAuth } from '../../utils/auth.js';
import {
  createGoal,
  getGoals,
  getGoalById,
  updateGoalProgress,
  updateSubGoal,
  addSubGoal,
  deleteGoal,
  getGoalStats,
  ensureGoalTables,
} from '../../memory/goalTracker.js';

const router = Router();

// Helper function to handle 'Goal not found' errors
const handleGoalNotFound = (res: any, msg = 'Goal not found') => {
  return res.status(404).json({ success: false, error: msg });
};

// Ensure tables exist on first import
// Tables are ensured during server startup in index.ts

// GET /api/goals?chatId=xxx&status=active
router.get('/goals', requireAuth, asyncHandler(async (req, res) => {
  const chatId = req.query.chatId ? String(req.query.chatId) : 'system';
  const status = req.query.status ? String(req.query.status) : undefined;
  const goals = getGoals(chatId, status);
  const stats = getGoalStats(chatId);
  res.json({ success: true, goals, stats });
}));

// GET /api/goals/:id
router.get('/goals/:id', requireAuth, asyncHandler(async (req, res) => {
  const goalId = String(req.params.id);
  const goal = getGoalById(goalId);
  if (!goal) return handleGoalNotFound(res);
  res.json({ success: true, goal });
}));

// POST /api/goals
router.post('/goals', requireAuth, asyncHandler(async (req, res) => {
  const { chatId = 'system', title, description, priority, subGoals } = req.body;
  if (!title) return res.status(400).json({ success: false, error: 'title is required' });

  const parsedSubGoals = Array.isArray(subGoals)
    ? subGoals.map((sg: any, i: number) => ({
        id: `sg_${Date.now()}_${i}`,
        title: String(sg.title || sg).replace(/<[^>]*>?/gm, ''),
        status: 'pending' as const,
        order: i + 1,
      }))
    : [];

  const goal = createGoal(chatId, title, description || '', priority || 3, parsedSubGoals);
  res.status(201).json({ success: true, goal });
}));

// PATCH /api/goals/:id/progress
router.patch('/goals/:id/progress', requireAuth, asyncHandler(async (req, res) => {
  const goalId = String(req.params.id);
  const { progress, status } = req.body;
  const goal = updateGoalProgress(goalId, progress, status);
  if (!goal) return handleGoalNotFound(res);
  res.json({ success: true, goal });
}));

// PATCH /api/goals/:goalId/subgoals/:subGoalId
router.patch('/goals/:goalId/subgoals/:subGoalId', requireAuth, asyncHandler(async (req, res) => {
  const goalId = String(req.params.goalId);
  const subGoalId = String(req.params.subGoalId);
  const { status } = req.body;
  if (!status) return res.status(400).json({ success: false, error: 'status is required' });
  const goal = updateSubGoal(goalId, subGoalId, { status });
  if (!goal) return handleGoalNotFound(res, 'Goal or sub-goal not found');
  res.json({ success: true, goal });
}));

// POST /api/goals/:id/subgoals
router.post('/goals/:id/subgoals', requireAuth, asyncHandler(async (req, res) => {
  const goalId = String(req.params.id);
  const { title, order } = req.body;
  if (!title) return res.status(400).json({ success: false, error: 'title is required' });
  const goal = addSubGoal(goalId, title, order);
  if (!goal) return handleGoalNotFound(res);
  res.json({ success: true, goal });
}));

// DELETE /api/goals/:id
router.delete('/goals/:id', requireAuth, asyncHandler(async (req, res) => {
  const goalId = String(req.params.id);
  const deleted = deleteGoal(goalId);
  if (!deleted) return handleGoalNotFound(res);
  res.json({ success: true });
}));

export default router;
