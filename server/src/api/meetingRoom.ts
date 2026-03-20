/**
 * Meeting Room Orchestrator
 *
 * When @all is used, Jarvis acts as a **supervisor**:
 *   1. Receives the user's question
 *   2. Decomposes it into subtasks and assigns each to an appropriate CLI
 *   3. Dispatches subtasks in parallel
 *   4. Reviews CLI results — if incomplete, sends revision requests
 *   5. Produces a final synthesized summary
 *
 * Emits `voice:meeting_step` for real-time process tracking in UI.
 */

import { executeCommand } from '../terminal/terminalGateway.js';
import { createLogger } from '../utils/logger.js';
import type { Socket } from 'socket.io';

const log = createLogger('MeetingRoom');

// ── Types ──────────────────────────────────────────────────────────────────

export interface MeetingRoomOptions {
  /** Socket to emit progress events */
  socket: Socket;
  /** User's original message (after stripping @all) */
  message: string;
  /** Available CLI backends (e.g. ['gemini', 'claude', 'kilo']) */
  availableCLIs: string[];
  /** User ID for executeCommand */
  userId?: string;
  /** Max review iterations before force-summarise */
  maxReviewRounds?: number;
}

interface SubTask {
  cli: string;
  task: string;
}

interface CLIResult {
  cli: string;
  task: string;
  output: string;
  status: 'success' | 'error';
}

// CLI display icons
const CLI_ICONS: Record<string, string> = {
  jarvis: '👑', gemini: '🔷', claude: '🟡', codex: '🟢', kilo: '⚪', openai: '🔵', opencode: '📜',
};
function getIcon(cli: string): string {
  return CLI_ICONS[cli] || '⬜';
}

// ── Step Emitter ─────────────────────────────────────────────────────────
// Emits granular 1-line process steps for UI display

type StepStatus = 'working' | 'done' | 'error' | 'info';

function emitStep(socket: Socket, step: string, status: StepStatus = 'working'): void {
  socket.emit('voice:meeting_step', { step, status, ts: Date.now() });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Call Jarvis agent and return text response */
async function askJarvis(prompt: string, userId?: string): Promise<string> {
  const result = await executeCommand(`@agent ${prompt}`, 'web', userId);
  return String(result || '').trim();
}

/** Call a CLI backend and return text response */
async function askCLI(cli: string, prompt: string, userId?: string): Promise<string> {
  const result = await executeCommand(`@${cli} ${prompt}`, 'web', userId);
  return String(result || '').trim();
}

// ── Phase 1: Task Decomposition ────────────────────────────────────────────

const DECOMPOSE_PROMPT = (message: string, clis: string[]) => `
คุณคือ Jarvis — หัวหน้าห้องประชุม Meeting Room
มี CLI ผู้เชี่ยวชาญพร้อมใช้งาน: ${clis.join(', ')}

โจทย์จาก user: "${message}"

กรุณาวิเคราะห์โจทย์แล้วแบ่งงานให้ CLI แต่ละตัว โดยตอบเป็น JSON array เท่านั้น ห้ามมีข้อความอื่น:
[
  {"cli": "<ชื่อ cli>", "task": "<งานที่สั่งให้ทำ ภาษาเดียวกับโจทย์>"},
  ...
]

หลักการแบ่งงาน:
- แต่ละ CLI ควรได้งานที่แตกต่างกัน (ไม่ซ้ำกัน)
- ถ้าโจทย์เรียบง่าย อาจให้ CLI 2-3 ตัวก็พอ ไม่จำเป็นต้องใช้ทุกตัว
- gemini: เก่งเรื่อง search, ข้อมูล, วิเคราะห์
- claude: เก่งเรื่อง เขียน, สรุป, ตรรกะ, code review
- codex: เก่งเรื่อง code, programming
- kilo: เก่งเรื่อง code, project management
- opencode: เก่งเรื่อง open-source code, วิเคราะห์โค้ดสาธารณะ
- ถ้า CLI ไหนไม่เหมาะกับโจทย์ ไม่ต้องให้งาน

สำคัญมาก: ตอบเฉพาะ JSON array เท่านั้น ห้ามมีข้อความ/คำอธิบาย/markdown อื่นใด`;

function parseSubTasks(response: string, availableCLIs: string[]): SubTask[] {
  // Try to extract JSON array from response
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    log.warn('No JSON array found in Jarvis decomposition response', { responsePreview: response.slice(0, 200) });
    return [];
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Array<{ cli?: string; task?: string }>;
    return parsed
      .filter(item => item?.cli && item?.task && availableCLIs.includes(item.cli))
      .map(item => ({ cli: item.cli!, task: item.task! }));
  } catch (err) {
    log.warn('JSON parse error for subtasks', { error: String(err) });
    return [];
  }
}

/** Local fallback decomposition — distributes the same task to all CLIs when agent is unavailable */
function localFallbackDecompose(message: string, clis: string[]): SubTask[] {
  log.info('[MeetingRoom] Using local fallback decomposition (agent unavailable)');
  return clis.map(cli => ({ cli, task: message }));
}

// ── Phase 2: Dispatch ──────────────────────────────────────────────────────

async function dispatchSubTasks(
  subtasks: SubTask[],
  socket: Socket,
  userId?: string,
): Promise<CLIResult[]> {
  const promises = subtasks.map(async (st): Promise<CLIResult> => {
    emitStep(socket, `${getIcon(st.cli)} กำลังส่งงานให้ @${st.cli}...`);
    socket.emit('voice:cli_reply', {
      agent: st.cli,
      reply: `⏳ กำลังทำงาน: ${st.task.slice(0, 100)}...`,
      status: 'working',
    });

    try {
      emitStep(socket, `${getIcon(st.cli)} @${st.cli} กำลังประมวลผล...`);
      const output = await askCLI(st.cli, st.task, userId);

      if (output) {
        emitStep(socket, `${getIcon(st.cli)} @${st.cli} ตอบกลับแล้ว ✓`, 'done');
      } else {
        emitStep(socket, `${getIcon(st.cli)} @${st.cli} ไม่มีคำตอบ`, 'error');
      }

      socket.emit('voice:cli_reply', {
        agent: st.cli,
        reply: output || '(no response)',
        status: output ? 'success' : 'error',
      });
      return { cli: st.cli, task: st.task, output: output || '', status: output ? 'success' : 'error' };
    } catch (err: any) {
      const errMsg = String(err?.message || err || 'error');
      emitStep(socket, `${getIcon(st.cli)} @${st.cli} error: ${errMsg.slice(0, 60)}`, 'error');
      socket.emit('voice:cli_reply', { agent: st.cli, reply: `❌ ${errMsg}`, status: 'error' });
      return { cli: st.cli, task: st.task, output: errMsg, status: 'error' };
    }
  });

  return Promise.all(promises);
}

// ── Phase 3: Review ────────────────────────────────────────────────────────

const REVIEW_PROMPT = (originalQuestion: string, results: CLIResult[]) => {
  const resultsSummary = results.map(r =>
    `[${r.cli}] งานที่สั่ง: ${r.task}\nผลลัพธ์ (${r.status}): ${r.output.slice(0, 1500)}`
  ).join('\n\n---\n\n');

  return `คุณคือ Jarvis — หัวหน้าห้องประชุม กำลังตรวจสอบงานจาก CLI

โจทย์เดิม: "${originalQuestion}"

ผลงานจาก CLI:
${resultsSummary}

กรุณาตรวจสอบแล้วตอบเป็น JSON object เท่านั้น:
{
  "approved": true/false,
  "revisions": [
    {"cli": "<ชื่อ>", "feedback": "<สิ่งที่ต้องแก้ไข/เพิ่มเติม>"}
  ],
  "notes": "<หมายเหตุสั้นๆ>"
}

- approved: true ถ้างานทั้งหมดสมบูรณ์เพียงพอ
- revisions: ถ้ายังไม่สมบูรณ์ ระบุว่า CLI ตัวไหนต้องทำอะไรเพิ่ม
- ถ้า CLI ตัวไหน error ให้ข้ามไป ไม่ต้องสั่งแก้
ตอบเป็น JSON object เท่านั้น:`;
};

interface ReviewResult {
  approved: boolean;
  revisions: Array<{ cli: string; feedback: string }>;
  notes: string;
}

function parseReview(response: string): ReviewResult {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { approved: true, revisions: [], notes: 'Could not parse review — auto-approved' };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      approved: !!parsed.approved,
      revisions: Array.isArray(parsed.revisions) ? parsed.revisions : [],
      notes: parsed.notes || '',
    };
  } catch {
    return { approved: true, revisions: [], notes: 'JSON parse error — auto-approved' };
  }
}

// ── Phase 4: Revision Dispatch ─────────────────────────────────────────────

async function dispatchRevisions(
  revisions: Array<{ cli: string; feedback: string }>,
  originalResults: CLIResult[],
  socket: Socket,
  userId?: string,
): Promise<CLIResult[]> {
  const updatedResults = [...originalResults];

  const revisionPromises = revisions.map(async (rev) => {
    const originalTask = originalResults.find(r => r.cli === rev.cli);
    const prompt = originalTask
      ? `งานเดิม: ${originalTask.task}\nผลงานเดิม: ${originalTask.output.slice(0, 800)}\n\nFeedback จาก Jarvis: ${rev.feedback}\nกรุณาแก้ไข/เพิ่มเติมตาม feedback`
      : rev.feedback;

    emitStep(socket, `🔄 ส่ง feedback ให้ @${rev.cli} แก้ไข...`);
    socket.emit('voice:cli_reply', {
      agent: rev.cli,
      reply: `🔄 กำลังแก้ไข: ${rev.feedback.slice(0, 100)}...`,
      status: 'working',
    });

    try {
      const output = await askCLI(rev.cli, prompt, userId);
      if (output) {
        emitStep(socket, `${getIcon(rev.cli)} @${rev.cli} แก้ไขเสร็จแล้ว ✓`, 'done');
      } else {
        emitStep(socket, `${getIcon(rev.cli)} @${rev.cli} แก้ไขไม่สำเร็จ`, 'error');
      }
      socket.emit('voice:cli_reply', {
        agent: rev.cli,
        reply: output || '(no response)',
        status: output ? 'success' : 'error',
      });
      const revStatus: 'success' | 'error' = output ? 'success' : 'error';
      return { cli: rev.cli, output, status: revStatus };
    } catch (err: any) {
      emitStep(socket, `${getIcon(rev.cli)} @${rev.cli} revision error`, 'error');
      return { cli: rev.cli, output: String(err?.message || err), status: 'error' as 'error' };
    }
  });

  const revisionResults = await Promise.all(revisionPromises);

  // Merge revised results back
  for (const rev of revisionResults) {
    const idx = updatedResults.findIndex(r => r.cli === rev.cli);
    if (idx >= 0) {
      updatedResults[idx] = {
        ...updatedResults[idx],
        output: rev.output || updatedResults[idx].output,
        status: rev.status,
      };
    }
  }

  return updatedResults;
}

// ── Phase 5: Final Summary ─────────────────────────────────────────────────

const SUMMARIZE_PROMPT = (originalQuestion: string, results: CLIResult[]) => {
  const resultsSummary = results.map(r =>
    `[${getIcon(r.cli)} ${r.cli}] ${r.output.slice(0, 2000)}`
  ).join('\n\n---\n\n');

  return `คุณคือ Jarvis — หัวหน้าห้องประชุม

โจทย์เดิมจาก user: "${originalQuestion}"

ผลงานสุดท้ายจาก CLI ทุกตัว:
${resultsSummary}

กรุณาสรุปผลลัพธ์ทั้งหมดเป็นคำตอบเดียวที่สมบูรณ์ให้ user
- สรุปใจความสำคัญจากทุก CLI
- ถ้ามีข้อมูลขัดแย้ง ให้ระบุ
- ตอบภาษาเดียวกับโจทย์
- ห้ามใส่ JSON ในคำตอบ ตอบเป็นข้อความปกติ`;
};

// ── Main Orchestrator Helpers ──────────────────────────────────────────────

async function performDecomposition(
  message: string,
  clis: string[],
  socket: Socket,
  userId?: string,
): Promise<SubTask[]> {
  emitStep(socket, '👑 Jarvis กำลังวิเคราะห์โจทย์...');
  socket.emit('voice:meeting_status', { phase: 'planning', message: '👑 Jarvis กำลังวิเคราะห์โจทย์และแบ่งงาน...' });
  socket.emit('voice:agent_reply', { input: message, reply: '👑 Jarvis กำลังวิเคราะห์โจทย์และแบ่งงาน...' });

  let subtasks: SubTask[] = [];
  try {
    emitStep(socket, '👑 Jarvis คุยกับ Agent เพื่อแบ่งงาน...');

    let decomposition = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        decomposition = await askJarvis(DECOMPOSE_PROMPT(message, clis), userId);
        if (decomposition && decomposition.includes('[')) break;
        if (attempt < 2) {
          log.warn(`[MeetingRoom] Decomposition attempt ${attempt} returned non-JSON, retrying...`, { responsePreview: decomposition.slice(0, 100) });
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (innerErr) {
        log.warn(`[MeetingRoom] Decomposition attempt ${attempt} failed`, { error: String(innerErr) });
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
      }
    }

    subtasks = decomposition ? parseSubTasks(decomposition, clis) : [];

    if (subtasks.length > 0) {
      emitStep(socket, `👑 แบ่งงานได้ ${subtasks.length} ชิ้น → ${subtasks.map(s => '@' + s.cli).join(', ')}`, 'done');
    } else {
      emitStep(socket, '👑 แบ่งงานไม่สำเร็จ — ใช้โหมด broadcast', 'info');
      subtasks = localFallbackDecompose(message, clis);
    }

    log.info(`[MeetingRoom] Decomposed into ${subtasks.length} subtasks`, {
      subtasks: subtasks.map(s => `${s.cli}: ${s.task.slice(0, 60)}`),
    });
  } catch (err: any) {
    log.error('[MeetingRoom] Decomposition failed completely', { error: String(err) });
    emitStep(socket, '⚠️ วิเคราะห์ไม่สำเร็จ — ส่งให้ทุก CLI เหมือนกัน', 'error');
    subtasks = localFallbackDecompose(message, clis);
  }

  if (subtasks.length === 0) {
    subtasks = localFallbackDecompose(message, clis);
  }

  const assignmentText = subtasks.map(s => `${getIcon(s.cli)} @${s.cli}: ${s.task}`).join('\n');
  socket.emit('voice:meeting_status', { phase: 'dispatching', message: `📋 แบ่งงาน:\n${assignmentText}` });
  socket.emit('voice:text_recv', { text: `📋 **Meeting Room — แบ่งงาน:**\n${assignmentText}`, source: 'agent' });

  return subtasks;
}

async function performReviewLoop(
  message: string,
  initialResults: CLIResult[],
  maxReviewRounds: number,
  socket: Socket,
  userId?: string,
): Promise<CLIResult[]> {
  let results = initialResults;

  for (let round = 0; round < maxReviewRounds; round++) {
    const successResults = results.filter(r => r.status === 'success' && r.output);
    if (successResults.length === 0) {
      emitStep(socket, '⚠️ ไม่มีผลลัพธ์ที่สำเร็จ — ข้ามการตรวจสอบ', 'error');
      log.warn('[MeetingRoom] No successful results to review');
      break;
    }

    emitStep(socket, `🔍 Jarvis กำลังตรวจสอบคำตอบ (รอบ ${round + 1})...`);
    socket.emit('voice:meeting_status', { phase: 'reviewing', message: `🔍 Jarvis กำลังตรวจสอบผลงาน (รอบ ${round + 1})...` });

    let review: ReviewResult;
    try {
      const reviewResponse = await askJarvis(REVIEW_PROMPT(message, results), userId);
      review = parseReview(reviewResponse);
      log.info(`[MeetingRoom] Review round ${round + 1}`, { approved: review.approved, revisions: review.revisions.length });

      if (review.approved) {
        emitStep(socket, '✅ Jarvis ตรวจแล้ว: ผ่าน!', 'done');
      } else {
        emitStep(socket, `🔄 Jarvis: ต้องแก้ไข ${review.revisions.length} รายการ`, 'info');
      }
    } catch (err: any) {
      log.error('[MeetingRoom] Review failed', { error: String(err) });
      emitStep(socket, '⚠️ ตรวจสอบไม่สำเร็จ — ใช้ผลลัพธ์เดิม', 'error');
      review = { approved: true, revisions: [], notes: 'Review failed — auto-approved' };
    }

    if (review.approved || review.revisions.length === 0) {
      if (review.notes) {
        socket.emit('voice:meeting_status', { phase: 'approved', message: `✅ Jarvis: ${review.notes}` });
      }
      break;
    }

    const revisionText = review.revisions.map(r => `${getIcon(r.cli)} @${r.cli}: ${r.feedback}`).join('\n');
    socket.emit('voice:meeting_status', { phase: 'revising', message: `🔄 Jarvis สั่งแก้ไข:\n${revisionText}` });
    socket.emit('voice:text_recv', { text: `🔄 **Meeting Room — สั่งแก้ไข:**\n${revisionText}`, source: 'agent' });

    results = await dispatchRevisions(review.revisions, results, socket, userId);

    const revisedSuccess = results.filter(r => r.status === 'success').length;
    emitStep(socket, `📊 หลังแก้ไข: ${revisedSuccess}/${results.length} สำเร็จ`, 'done');
  }

  return results;
}

async function performFinalSummary(
  message: string,
  results: CLIResult[],
  socket: Socket,
  userId?: string,
): Promise<string> {
  emitStep(socket, '📝 Jarvis กำลังรวบรวมและสรุปคำตอบ...');
  socket.emit('voice:meeting_status', { phase: 'summarizing', message: '📝 Jarvis กำลังสรุปผลลัพธ์...' });

  try {
    const summary = await askJarvis(SUMMARIZE_PROMPT(message, results), userId);
    emitStep(socket, '✅ สรุปเสร็จ — กำลังส่งคำตอบ', 'done');
    return summary;
  } catch (err: any) {
    log.error('[MeetingRoom] Summary failed', { error: String(err) });
    emitStep(socket, '⚠️ สรุปไม่สำเร็จ — ส่งผลดิบแทน', 'error');
    return results
      .filter(r => r.status === 'success')
      .map(r => `${getIcon(r.cli)} @${r.cli}:\n${r.output}`)
      .join('\n\n---\n\n') || 'ไม่มีผลลัพธ์';
  }
}

// ── Main Orchestrator ──────────────────────────────────────────────────────

export async function runMeetingRoom(opts: MeetingRoomOptions): Promise<string> {
  const { socket, message, availableCLIs, userId, maxReviewRounds = 1 } = opts;
  const clis = availableCLIs.filter(c => c !== 'jarvis' && c !== 'agent' && c !== 'admin');

  if (clis.length === 0) {
    return 'ไม่มี CLI พร้อมใช้งานใน Meeting Room';
  }

  log.info(`[MeetingRoom] Starting — question: "${message.slice(0, 100)}" — CLIs: [${clis.join(',')}]`);

  // Clear previous steps
  socket.emit('voice:meeting_step', { step: null, status: 'clear', ts: Date.now() });

  // ── Phase 1: Jarvis decomposes task ──
  emitStep(socket, '👑 Jarvis กำลังวิเคราะห์โจทย์...');
  socket.emit('voice:meeting_status', { phase: 'planning', message: '👑 Jarvis กำลังวิเคราะห์โจทย์และแบ่งงาน...' });
  socket.emit('voice:agent_reply', { input: message, reply: '👑 Jarvis กำลังวิเคราะห์โจทย์และแบ่งงาน...' });

  let subtasks: SubTask[];
  try {
    emitStep(socket, '👑 Jarvis คุยกับ Agent เพื่อแบ่งงาน...');

    // Try decomposition with retry (max 2 attempts)
    let decomposition = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        decomposition = await askJarvis(DECOMPOSE_PROMPT(message, clis), userId);
        if (decomposition && decomposition.includes('[')) break; // Got JSON-like response
        if (attempt < 2) {
          log.warn(`[MeetingRoom] Decomposition attempt ${attempt} returned non-JSON, retrying...`, { responsePreview: decomposition.slice(0, 100) });
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch (innerErr) {
        log.warn(`[MeetingRoom] Decomposition attempt ${attempt} failed`, { error: String(innerErr) });
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
      }
    }

    subtasks = decomposition ? parseSubTasks(decomposition, clis) : [];

    if (subtasks.length > 0) {
      emitStep(socket, `👑 แบ่งงานได้ ${subtasks.length} ชิ้น → ${subtasks.map(s => '@' + s.cli).join(', ')}`, 'done');
    } else {
      emitStep(socket, '👑 แบ่งงานไม่สำเร็จ — ใช้โหมด broadcast', 'info');
      subtasks = localFallbackDecompose(message, clis);
    }

    log.info(`[MeetingRoom] Decomposed into ${subtasks.length} subtasks`, {
      subtasks: subtasks.map(s => `${s.cli}: ${s.task.slice(0, 60)}`),
    });
  } catch (err: any) {
    log.error('[MeetingRoom] Decomposition failed completely', { error: String(err) });
    emitStep(socket, '⚠️ วิเคราะห์ไม่สำเร็จ — ส่งให้ทุก CLI เหมือนกัน', 'error');
    subtasks = localFallbackDecompose(message, clis);
  }

  if (subtasks.length === 0) {
    subtasks = localFallbackDecompose(message, clis);
  }

  // Emit task assignments
  const assignmentText = subtasks.map(s => `${getIcon(s.cli)} @${s.cli}: ${s.task}`).join('\n');
  socket.emit('voice:meeting_status', { phase: 'dispatching', message: `📋 แบ่งงาน:\n${assignmentText}` });
  socket.emit('voice:text_recv', { text: `📋 **Meeting Room — แบ่งงาน:**\n${assignmentText}`, source: 'agent' });

  // ── Phase 2: Dispatch to CLIs ──
  emitStep(socket, `📡 กำลังส่งงานให้ CLI ${subtasks.length} ตัวพร้อมกัน...`);
  socket.emit('voice:meeting_status', { phase: 'working', message: '⚙️ CLI กำลังทำงาน...' });
  let results = await dispatchSubTasks(subtasks, socket, userId);

  // Summary of dispatch results
  const successCount = results.filter(r => r.status === 'success').length;
  const errorCount = results.filter(r => r.status === 'error').length;
  emitStep(socket, `📊 ได้ผลลัพธ์: ${successCount} สำเร็จ, ${errorCount} error`, successCount > 0 ? 'done' : 'error');

  // ── Phase 3: Review loop ──
  for (let round = 0; round < maxReviewRounds; round++) {
    const successResults = results.filter(r => r.status === 'success' && r.output);
    if (successResults.length === 0) {
      emitStep(socket, '⚠️ ไม่มีผลลัพธ์ที่สำเร็จ — ข้ามการตรวจสอบ', 'error');
      log.warn('[MeetingRoom] No successful results to review');
      break;
    }

    emitStep(socket, `🔍 Jarvis กำลังตรวจสอบคำตอบ (รอบ ${round + 1})...`);
    socket.emit('voice:meeting_status', { phase: 'reviewing', message: `🔍 Jarvis กำลังตรวจสอบผลงาน (รอบ ${round + 1})...` });

    let review: ReviewResult;
    try {
      const reviewResponse = await askJarvis(REVIEW_PROMPT(message, results), userId);
      review = parseReview(reviewResponse);
      log.info(`[MeetingRoom] Review round ${round + 1}`, { approved: review.approved, revisions: review.revisions.length });

      if (review.approved) {
        emitStep(socket, '✅ Jarvis ตรวจแล้ว: ผ่าน!', 'done');
      } else {
        emitStep(socket, `🔄 Jarvis: ต้องแก้ไข ${review.revisions.length} รายการ`, 'info');
      }
    } catch (err: any) {
      log.error('[MeetingRoom] Review failed', { error: String(err) });
      emitStep(socket, '⚠️ ตรวจสอบไม่สำเร็จ — ใช้ผลลัพธ์เดิม', 'error');
      review = { approved: true, revisions: [], notes: 'Review failed — auto-approved' };
    }

    if (review.approved || review.revisions.length === 0) {
      if (review.notes) {
        socket.emit('voice:meeting_status', { phase: 'approved', message: `✅ Jarvis: ${review.notes}` });
      }
      break;
    }

    // ── Phase 4: Send revisions ──
    const revisionText = review.revisions.map(r => `${getIcon(r.cli)} @${r.cli}: ${r.feedback}`).join('\n');
    socket.emit('voice:meeting_status', { phase: 'revising', message: `🔄 Jarvis สั่งแก้ไข:\n${revisionText}` });
    socket.emit('voice:text_recv', { text: `🔄 **Meeting Room — สั่งแก้ไข:**\n${revisionText}`, source: 'agent' });

    results = await dispatchRevisions(review.revisions, results, socket, userId);

    const revisedSuccess = results.filter(r => r.status === 'success').length;
    emitStep(socket, `📊 หลังแก้ไข: ${revisedSuccess}/${results.length} สำเร็จ`, 'done');
  }

  // ── Phase 5: Final summary ──
  emitStep(socket, '📝 Jarvis กำลังรวบรวมและสรุปคำตอบ...');
  socket.emit('voice:meeting_status', { phase: 'summarizing', message: '📝 Jarvis กำลังสรุปผลลัพธ์...' });

  let summary: string;
  try {
    summary = await askJarvis(SUMMARIZE_PROMPT(message, results), userId);
    emitStep(socket, '✅ สรุปเสร็จ — กำลังส่งคำตอบ', 'done');
  } catch (err: any) {
    log.error('[MeetingRoom] Summary failed', { error: String(err) });
    emitStep(socket, '⚠️ สรุปไม่สำเร็จ — ส่งผลดิบแทน', 'error');
    // Fallback: just concatenate results
    summary = results
      .filter(r => r.status === 'success')
      .map(r => `${getIcon(r.cli)} @${r.cli}:\n${r.output}`)
      .join('\n\n---\n\n') || 'ไม่มีผลลัพธ์';
  }

  socket.emit('voice:meeting_status', { phase: 'done', message: '✅ Meeting Room เสร็จสิ้น' });
  emitStep(socket, '🏁 Meeting Room เสร็จสิ้น', 'done');

  log.info(`[MeetingRoom] Complete — ${results.filter(r => r.status === 'success').length}/${results.length} succeeded`);
  return summary;
}
