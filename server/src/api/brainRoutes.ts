import { Router } from 'express';
import { asyncHandler } from '../utils/errorHandler.js';
import { getDb } from '../database/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_FILE = path.join(__dirname, '../../../data/brain_overrides.json');

export const router = Router();

// Dictionary for Thai translations of DB tables and their layers
const tableMeta: Record<string, { label: string; layer: 'active' | 'data' | 'infra'; desc: string }> = {
  // Brain 1 (Active/Process)
  'conversations': { label: 'Conversations', layer: 'active', desc: 'Chat sessions' },
  'messages': { label: 'Messages', layer: 'active', desc: 'Chat messages' },
  'episodes': { label: 'Episodes', layer: 'active', desc: 'Past context' },
  'core_memory': { label: 'Core Memory', layer: 'active', desc: 'Key user info' },
  'archival_memory': { label: 'Archival Memory', layer: 'active', desc: 'Long-term facts' },
  'knowledge': { label: 'Knowledge Base', layer: 'active', desc: 'Semantic knowledge' },
  'knowledge_nodes': { label: 'Knowledge Nodes', layer: 'active', desc: 'Data nodes' },
  'knowledge_edges': { label: 'Knowledge Edges', layer: 'active', desc: 'Relationships' },
  'user_profiles': { label: 'User Profiles', layer: 'active', desc: 'Behavior patterns' },
  'learning_journal': { label: 'Learning Journal', layer: 'active', desc: 'AI experience logs' },
  'agent_plans': { label: 'Agent Plans', layer: 'active', desc: 'Workflow steps' },
  'goals': { label: 'Goals', layer: 'active', desc: 'Long-term objectives' },
  'activity_logs': { label: 'Activity Logs', layer: 'active', desc: 'System events' },
  'usage_tracking': { label: 'Token Usage', layer: 'active', desc: 'LLM consumption' },
  
  // Brain 2 (Structure/Knowledge)
  'codebase_map': { label: 'Codebase Map', layer: 'data', desc: 'Project files' },
  'codebase_edges': { label: 'Codebase Edges', layer: 'data', desc: 'Dependencies' },
  'codebase_calls': { label: 'Func Calls', layer: 'data', desc: 'Caller/Callee' },
  'codebase_embeddings': { label: 'Code Vectors', layer: 'data', desc: 'Embeddings' },
  'evolution_log': { label: 'Evolution Log', layer: 'data', desc: 'Auto-fixes' },
  'upgrade_proposals': { label: 'Upgrade Proposals', layer: 'data', desc: 'Optimization' },
  'upgrade_scan_log': { label: 'Scan Log', layer: 'data', desc: 'Vulnerabilities' },

  // Infrastructure
  'settings': { label: 'Settings', layer: 'infra', desc: 'App configuration' },
  'api_keys': { label: 'API Keys', layer: 'infra', desc: 'Credentials' },
  'personas': { label: 'Personas', layer: 'infra', desc: 'AI profiles' },
  'bot_instances': { label: 'Bot Instances', layer: 'infra', desc: 'Active bots' },
  'tool_assignments': { label: 'Tool Assignments', layer: 'infra', desc: 'Agent tools' },
  'qa_pairs': { label: 'Q&A Repository', layer: 'infra', desc: 'Stored knowledge' },
  'cron_jobs': { label: 'Cron Jobs', layer: 'infra', desc: 'Scheduled tasks' },
  'scheduled_posts': { label: 'Scheduled Posts', layer: 'infra', desc: 'Future content' },
  'comment_watches': { label: 'Comment Watches', layer: 'infra', desc: 'Monitoring' },
  'replied_comments': { label: 'Replied Comments', layer: 'infra', desc: 'Responded' },
  'processed_messages': { label: 'Processed MSGs', layer: 'infra', desc: 'Handled' },
  'persistent_queue': { label: 'Task Queue', layer: 'infra', desc: 'Background jobs' },
  'provider_config': { label: 'LLM Config', layer: 'infra', desc: 'Providers' },
  'sqlite_sequence': { label: 'Sequence', layer: 'infra', desc: 'Auto-increment' }
};

// Define explicit data flow edges (English labels)
const logicalDataFlows = [
  // Brain 1 Flows
  { source: 'messages', target: 'episodes', label: 'Extract context' },
  { source: 'episodes', target: 'core_memory', label: 'Store short-term' },
  { source: 'episodes', target: 'archival_memory', label: 'Archive long-term' },
  { source: 'episodes', target: 'learning_journal', label: 'Reflect' },
  { source: 'messages', target: 'user_profiles', label: 'Update habits' },
  { source: 'conversations', target: 'messages', label: 'Receive chat' },
  
  // Brain 2 Flows
  { source: 'codebase_map', target: 'upgrade_scan_log', label: 'Scan vulnerabilities' },
  { source: 'upgrade_scan_log', target: 'upgrade_proposals', label: 'Propose fixes' },
  { source: 'upgrade_proposals', target: 'evolution_log', label: 'Implement' },
  { source: 'codebase_map', target: 'codebase_edges', label: 'Map dependencies' },
  { source: 'codebase_map', target: 'codebase_calls', label: 'Trace calls' },

  // Cross-Brain Flows
  { source: 'upgrade_proposals', target: 'activity_logs', label: 'Log actions' },
  { source: 'messages', target: 'activity_logs', label: 'Notify system' },
  { source: 'learning_journal', target: 'upgrade_proposals', label: 'Optimization request' }
];

import { buildAgentSnapshots } from './systemRouter.js';

// GET /api/brain/graph - Get nodes and edges for 3D visualization
router.get('/graph', asyncHandler(async (_req, res) => {
  const db = getDb();
  
  // 1. Get all tables
  const tableQuery = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name: string}[];
  
  const nodes: any[] = [];
  const tableNames = new Set<string>();

  // 2. Build nodes from actual DB tables (Active/Data layers only)
  for (const t of tableQuery) {
    const tableName = t.name;
    const meta = tableMeta[tableName] || { label: tableName, layer: 'infra', desc: 'ตารางระบบ' };
    
    // Skip system/infra tables to prioritize Unified Topology agents in the infra layer
    // EXCEPTION: allow important work-related tables to be visible
    if (meta.layer === 'infra' && !['persistent_queue', 'cron_jobs'].includes(tableName)) continue;
    
    tableNames.add(tableName);
    
    // Attempt to get row count safely
    let rowCount = 0;
    try {
      const countRow = db.prepare(`SELECT count(*) as count FROM [${tableName}]`).get() as {count: number};
      rowCount = countRow ? countRow.count : 0;
    } catch(e) { /* ignore sqlite sequence or protected tables */ }
    
    nodes.push({
      id: tableName,
      label: meta.label,
      summary: `${meta.desc} (${rowCount} รายการ)`,
      layer: meta.layer,
      activity: rowCount > 0 ? Math.min(1.0, 0.2 + (Math.log10(rowCount || 1) * 0.1)) : 0,
      rowCount: rowCount
    });
  }

  // 3. Add Unified Topology agents as infra nodes
  try {
    const agents = buildAgentSnapshots();
    for (const agent of agents) {
      nodes.push({
        id: agent.id,
        label: agent.name,
        summary: agent.description || agent.kind,
        layer: 'infra',
        status: agent.status, // active, degraded, offline
        kind: agent.kind,
        activity: agent.status === 'active' ? 0.8 : (agent.status === 'degraded' ? 0.4 : 0.1),
        rowCount: 1, // Fixed size for agent boxes
        isAgent: true
      });
    }
  } catch (err) {
    console.error('[BrainRoutes] Failed to build agent snapshots:', err);
  }

  // 4. Add Links from Agents to their related Tables 
  const agentLinks: any[] = [];
  const agentList = nodes.filter(n => n.isAgent);
  
  for (const agent of agentList) {
    let targets: string[] = [];
    
    if (agent.id === 'bot-manager') {
      targets = ['codebase_map', 'codebase_edges', 'codebase_calls', 'codebase_embeddings', 'upgrade_scan_log', 'upgrade_proposals', 'evolution_log'];
    } else if (['jarvis-root-admin', 'aider'].includes(agent.id)) {
      targets = ['conversations', 'messages', 'episodes', 'core_memory', 'archival_memory', 'knowledge', 'user_profiles', 'learning_journal'];
    } else if (['line-bot', 'telegram-bot', 'facebook-messenger'].includes(agent.id)) {
      targets = ['conversations', 'messages'];
    } else if (agent.id.endsWith('-cli')) {
      targets = ['activity_logs', 'usage_tracking', 'persistent_queue'];
    }

    for (const target of targets) {
      if (tableNames.has(target)) {
        agentLinks.push({
          source: agent.id,
          target: target,
          type: 'flows',
          label: 'ใช้งาน',
          weight: 0.5
        });
      }
    }
  }

  // 5. Filter valid logical data flows
  const links = [
    ...logicalDataFlows.filter(flow => tableNames.has(flow.source) && tableNames.has(flow.target)).map(flow => ({
      source: flow.source,
      target: flow.target,
      type: 'flows',
      label: flow.label,
      weight: 1
    })),
    ...agentLinks
  ];

  res.json({ nodes, links });
}));

// GET /api/brain/activity - Get recent neural activity (evolution logs)
router.get('/activity', asyncHandler(async (_req, res) => {
  const db = getDb();
  const logs = db.prepare(`
    SELECT * FROM evolution_log 
    ORDER BY created_at DESC 
    LIMIT 50
  `).all();
  
  res.json(logs);
}));

// GET /api/brain/overrides - Load saved brain visualization positions
router.get('/overrides', asyncHandler(async (_req, res) => {
  if (!fs.existsSync(CONFIG_FILE)) {
    return res.json({ overrides: {}, hemOverrides: {}, corpusOverride: [0,0,0] });
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    res.json(JSON.parse(raw));
  } catch (err) {
    console.error('[BrainRoutes] Failed to read overrides:', err);
    res.json({ overrides: {}, hemOverrides: {}, corpusOverride: [0,0,0] });
  }
}));

// POST /api/brain/overrides - Save brain visualization positions
router.post('/overrides', asyncHandler(async (req, res) => {
  try {
    const data = req.body;
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error('[BrainRoutes] Failed to save overrides:', err);
    res.status(500).json({ error: 'Failed to preserve brain configuration' });
  }
}));

export default router;
