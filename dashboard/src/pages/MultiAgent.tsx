import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Bot, CheckCircle2, Clock3, Loader2, MessageSquare, Play, RefreshCw, Users, XCircle, AlertTriangle, Sparkles, Timer } from 'lucide-react';
import { api } from '../services/api';

// ─── Types ───────────────────────────────────────────────────────────

type MeetingStatus = 'preparing' | 'discussing' | 'synthesizing' | 'done' | 'failed';

interface ParticipantResponse {
  participant: string;
  response: string;
  durationMs: number;
  status: 'success' | 'failed' | 'timeout' | 'unavailable';
  error?: string;
}

interface DiscussionRound {
  roundNumber: number;
  topic: string;
  responses: ParticipantResponse[];
  startedAt: number;
  completedAt?: number;
}

interface MeetingSession {
  id: string;
  objective: string;
  participants: string[];
  rounds: DiscussionRound[];
  transcript: string[];
  maxRounds: number;
  status: MeetingStatus;
  synthesis?: string;
  createdAt: number;
  completedAt?: number;
  totalDurationMs?: number;
}

interface MeetingSummary {
  id: string;
  objective: string;
  status: MeetingStatus;
  participants: string[];
  rounds: number;
  createdAt: number;
  completedAt?: number;
  totalDurationMs?: number;
}

interface LaneMetric {
  specialist: string;
  state: string;
  totalTasks: number;
  rates: { success: number; failure: number; timeout: number; reroute: number };
}

interface Props {
  on: (event: string, handler: (...args: any[]) => void) => () => void;
}

// ─── Constants ───────────────────────────────────────────────────────

const PARTICIPANT_COLORS: Record<string, { accent: string; bg: string; border: string; icon: string }> = {
  gemini: { accent: 'text-cyan-300', bg: 'bg-cyan-500/10', border: 'border-cyan-400/40', icon: '🔷' },
  codex: { accent: 'text-emerald-300', bg: 'bg-emerald-500/10', border: 'border-emerald-400/40', icon: '🟢' },
  claude: { accent: 'text-amber-200', bg: 'bg-amber-500/10', border: 'border-amber-300/40', icon: '🟡' },
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bgClass: string }> = {
  preparing: { label: '🔧 Preparing', color: 'text-slate-300', bgClass: 'bg-slate-600/30 border-slate-500/50' },
  discussing: { label: '💬 Discussing', color: 'text-cyan-300', bgClass: 'bg-cyan-500/20 border-cyan-400/50 animate-pulse' },
  synthesizing: { label: '🧠 Synthesizing', color: 'text-violet-300', bgClass: 'bg-violet-500/20 border-violet-400/50 animate-pulse' },
  done: { label: '✅ Complete', color: 'text-emerald-300', bgClass: 'bg-emerald-500/20 border-emerald-400/50' },
  failed: { label: '❌ Failed', color: 'text-rose-300', bgClass: 'bg-rose-500/20 border-rose-400/50' },
};

function getParticipantStyle(id: string) {
  return PARTICIPANT_COLORS[id] || { accent: 'text-slate-300', bg: 'bg-slate-500/10', border: 'border-slate-400/40', icon: '⚪' };
}

function formatDuration(ms?: number): string {
  if (!ms) return '0s';
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function formatTime(ts?: number): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleTimeString('th-TH');
}

// ─── Live Timer Hook ──────────────────────────────────────────────────

function useLiveTimer(startTime?: number, endTime?: number): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startTime || endTime) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [startTime, endTime]);

  if (!startTime) return '00:00';
  const elapsed = (endTime || now) - startTime;
  const secs = Math.floor(elapsed / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}:${String(mins % 60).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  return `${String(mins).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

// ─── Main Component ──────────────────────────────────────────────────

export function MultiAgent({ on }: Props) {
  const [meetings, setMeetings] = useState<MeetingSummary[]>([]);
  const [activeMeeting, setActiveMeeting] = useState<MeetingSession | null>(null);
  const [selectedMeetingId, setSelectedMeetingId] = useState<string | null>(null);
  const [objective, setObjective] = useState('');
  const [launching, setLaunching] = useState(false);
  const [laneMetrics, setLaneMetrics] = useState<LaneMetric[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load meeting list
  const fetchMeetings = useCallback(async () => {
    try {
      const res = await api.getMeetings();
      if (res?.meetings) setMeetings(res.meetings);
    } catch { /* ignore */ }
  }, []);

  // Poll active meeting status
  const pollMeeting = useCallback(async (meetingId: string) => {
    try {
      const res = await api.getMeeting(meetingId);
      if (res?.meeting) {
        setActiveMeeting(res.meeting);
        // Stop polling when done
        if (res.meeting.status === 'done' || res.meeting.status === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          fetchMeetings(); // refresh list
        }
      }
    } catch (err: any) {
      // If 404 (e.g. server restarted and memory wiped) or other error, STOP polling
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      console.warn('Stopped polling due to error:', err);
      // Optional: Set meeting to failed to reflect reality on UI
      setActiveMeeting((prev) => prev ? { ...prev, status: 'failed', synthesis: 'Meeting not found (server restarted?)' } : null);
    }
  }, [fetchMeetings]);

  // Start polling a meeting
  const startPolling = useCallback((meetingId: string) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollMeeting(meetingId);
    pollRef.current = setInterval(() => pollMeeting(meetingId), 2000);
  }, [pollMeeting]);

  // Lane metrics polling (15s)
  const fetchLaneMetrics = useCallback(async () => {
    try {
      const res = await api.getSwarmLaneMetrics();
      if (res?.metrics) setLaneMetrics(res.metrics);
    } catch { /* ignore */ }
  }, []);

  // Initial load
  useEffect(() => {
    fetchMeetings();
    fetchLaneMetrics();
    const laneTimer = setInterval(fetchLaneMetrics, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      clearInterval(laneTimer);
    };
  }, [fetchMeetings, fetchLaneMetrics]);

  // Listen for real-time meeting events via socket
  useEffect(() => {
    const offMeetingUpdate = on('meeting:update', (data: { meetingId?: string }) => {
      if (data?.meetingId && data.meetingId === selectedMeetingId) {
        pollMeeting(data.meetingId);
      }
      fetchMeetings();
    });
    const offMeetingDone = on('meeting:done', (data: { meetingId?: string }) => {
      if (data?.meetingId && data.meetingId === selectedMeetingId) {
        pollMeeting(data.meetingId);
      }
      fetchMeetings();
    });
    return () => { offMeetingUpdate(); offMeetingDone(); };
  }, [on, selectedMeetingId, pollMeeting, fetchMeetings]);

  // Select a meeting
  const handleSelectMeeting = useCallback(async (id: string) => {
    setSelectedMeetingId(id);
    try {
      const res = await api.getMeeting(id);
      if (res?.meeting) {
        setActiveMeeting(res.meeting);
        if (res.meeting.status !== 'done' && res.meeting.status !== 'failed') {
          startPolling(id);
        }
      }
    } catch { /* ignore */ }
  }, [startPolling]);

  // Launch new meeting
  const handleLaunch = async () => {
    const clean = objective.trim();
    if (!clean) return;

    setLaunching(true);
    try {
      const res = await api.startMeeting({ objective: clean });
      if (res?.meetingId) {
        setObjective('');
        setSelectedMeetingId(res.meetingId);
        startPolling(res.meetingId);
      }
    } catch (err) {
      console.error('Failed to start meeting:', err);
    } finally {
      setLaunching(false);
    }
  };

  const liveTimer = useLiveTimer(activeMeeting?.createdAt, activeMeeting?.completedAt);
  const isActive = activeMeeting && activeMeeting.status !== 'done' && activeMeeting.status !== 'failed';
  const statusConfig = STATUS_CONFIG[activeMeeting?.status || 'preparing'] || STATUS_CONFIG.preparing;

  // Counts for the active meeting
  const totalResponses = useMemo(() => {
    if (!activeMeeting) return { success: 0, failed: 0, total: 0 };
    let success = 0, failed = 0;
    for (const round of activeMeeting.rounds) {
      for (const r of round.responses) {
        if (r.status === 'success') success++;
        else failed++;
      }
    }
    return { success, failed, total: success + failed };
  }, [activeMeeting]);

  return (
    <div className="p-6 h-full flex flex-col gap-4">
      {/* ─── Header ─── */}
      <section className="relative overflow-hidden rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-900/30 via-slate-900 to-cyan-900/15 p-6">
        <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-violet-400/10 blur-3xl" />
        <div className="absolute -bottom-28 -left-20 h-72 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
        <div className="relative flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
          <div>
            <h2 className="text-3xl font-semibold text-white tracking-tight flex items-center gap-3">
              <Users className="w-8 h-8 text-violet-300" />
              Meeting Room
            </h2>
            <p className="text-sm text-violet-100/80 mt-2 max-w-2xl">
              ห้องประชุม Multi-Agent — Jarvis เป็นประธาน นำ Gemini, Codex, Claude ประชุมร่วมกัน แลกเปลี่ยนความเห็น สรุปผลการประชุมให้ผู้ใช้
            </p>
          </div>
          <button
            onClick={fetchMeetings}
            className="px-4 py-2 rounded-xl border border-violet-400/40 text-violet-100 bg-violet-500/10 hover:bg-violet-500/20 transition-colors text-sm flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Refresh
          </button>
        </div>
      </section>

      {/* ─── Agent Lane Health ─── */}
      {laneMetrics.length > 0 && (
        <section className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-slate-700 bg-slate-900/80">
          <Activity className="w-4 h-4 text-violet-300 shrink-0" />
          <span className="text-xs text-slate-400 shrink-0">Specialist Health</span>
          <div className="flex flex-wrap gap-2">
            {laneMetrics.map((lane) => {
              const isHealthy = lane.state === 'active' || lane.state === 'idle';
              const successPct = Math.round(lane.rates.success * 100);
              return (
                <div key={lane.specialist} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs ${
                  isHealthy ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-rose-500/30 bg-rose-500/10'
                }`} title={`${lane.specialist}: ${lane.totalTasks} tasks, ${successPct}% success`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${isHealthy ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                  <span className={`font-medium ${isHealthy ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {lane.specialist}
                  </span>
                  {lane.totalTasks > 0 && (
                    <span className="text-slate-400">{successPct}%</span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ─── Main Layout ─── */}
      <div className="grid grid-cols-1 2xl:grid-cols-[320px_minmax(0,1fr)] gap-4 flex-1 min-h-0">

        {/* ─── Sidebar: Meeting List + Launch ─── */}
        <aside className="bg-slate-900/90 border border-slate-700 rounded-2xl p-4 flex flex-col min-h-0">
          <h3 className="text-sm font-semibold text-slate-100 mb-3 flex items-center gap-2">
            <MessageSquare className="w-4 h-4 text-violet-300" />
            New Meeting
          </h3>

          <div className="space-y-2 mb-4">
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              className="w-full min-h-[96px] rounded-xl border border-slate-600 bg-slate-950/80 text-slate-100 p-3 text-sm outline-none focus:border-violet-400 placeholder-slate-500"
              placeholder="หัวข้อการประชุม เช่น วิเคราะห์แนวทางปรับปรุงระบบ..."
            />
            <button
              onClick={handleLaunch}
              disabled={launching || !objective.trim()}
              className="w-full px-4 py-2.5 rounded-xl bg-violet-500 text-white font-medium hover:bg-violet-400 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
            >
              {launching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {launching ? 'Starting Meeting...' : 'Start Meeting'}
            </button>
          </div>

          <h3 className="text-sm font-semibold text-slate-100 mb-2">Meeting History</h3>
          <div className="space-y-2 overflow-auto pr-1 min-h-0 flex-1">
            {meetings.length === 0 && <p className="text-xs text-slate-500 py-6 text-center">No meetings yet</p>}
            {meetings.map((m) => {
              const selected = selectedMeetingId === m.id;
              const sc = STATUS_CONFIG[m.status] || STATUS_CONFIG.preparing;
              return (
                <button
                  key={m.id}
                  onClick={() => handleSelectMeeting(m.id)}
                  className={`w-full text-left rounded-xl border p-3 transition-colors ${
                    selected ? 'border-violet-400/60 bg-violet-500/10' : 'border-slate-700 bg-slate-800/40 hover:border-slate-500'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-slate-400">{formatTime(m.createdAt)}</span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border ${sc.bgClass}`}>{sc.label}</span>
                  </div>
                  <p className="text-sm text-slate-100 mt-1 line-clamp-2">{m.objective}</p>
                  <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-400">
                    <span>{m.participants?.length || 0} agents</span>
                    <span>{m.rounds || 0} rounds</span>
                    {m.totalDurationMs && <span>{formatDuration(m.totalDurationMs)}</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ─── Main Content: Live Meeting Monitor ─── */}
        <section className="min-h-0 flex flex-col gap-4 overflow-auto">
          {!activeMeeting ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <Users className="w-16 h-16 text-slate-600 mx-auto mb-4" />
                <p className="text-slate-400 text-lg">Select a meeting or start a new one</p>
                <p className="text-slate-500 text-sm mt-1">ห้องประชุม Multi-Agent พร้อมใช้งาน</p>
              </div>
            </div>
          ) : (
            <>
              {/* ─── Meeting Header with Live Timer ─── */}
              <div className="bg-slate-900/90 border border-slate-700 rounded-2xl p-5">
                <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs uppercase tracking-wide text-slate-400 mb-1">Meeting Objective</p>
                    <h3 className="text-lg text-white font-medium leading-snug">{activeMeeting.objective}</h3>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs px-3 py-1.5 rounded-full border font-medium ${statusConfig.bgClass}`}>
                      {statusConfig.label}
                    </span>
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-600 bg-slate-800">
                      <Timer className={`w-4 h-4 ${isActive ? 'text-cyan-400 animate-pulse' : 'text-slate-400'}`} />
                      <span className={`text-sm font-mono font-bold ${isActive ? 'text-cyan-300' : 'text-slate-300'}`}>
                        {liveTimer}
                      </span>
                    </div>
                  </div>
                </div>

                {/* ─── Participant Cards ─── */}
                <div className="flex flex-wrap gap-2 mt-4">
                  {activeMeeting.participants.map((p) => {
                    const style = getParticipantStyle(p);
                    const hasResponded = activeMeeting.rounds.some((r) =>
                      r.responses.some((resp) => resp.participant === p && resp.status === 'success'),
                    );
                    return (
                      <div key={p} className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${style.border} ${style.bg}`}>
                        <span>{style.icon}</span>
                        <span className={`text-sm font-medium ${style.accent}`}>{p.toUpperCase()}</span>
                        {hasResponded ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : isActive ? (
                          <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />
                        ) : (
                          <XCircle className="w-3.5 h-3.5 text-slate-500" />
                        )}
                      </div>
                    );
                  })}
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-violet-400/40 bg-violet-500/10">
                    <span>👑</span>
                    <span className="text-sm font-medium text-violet-300">JARVIS</span>
                    <span className="text-[10px] text-violet-400">Chairman</span>
                  </div>
                </div>

                {/* Stats Row */}
                <div className="grid grid-cols-4 gap-3 mt-4">
                  <MiniStat label="Rounds" value={activeMeeting.rounds.length} icon={<MessageSquare className="w-3.5 h-3.5" />} color="text-violet-300" />
                  <MiniStat label="Responses" value={totalResponses.success} icon={<CheckCircle2 className="w-3.5 h-3.5" />} color="text-emerald-300" />
                  <MiniStat label="Failed" value={totalResponses.failed} icon={<AlertTriangle className="w-3.5 h-3.5" />} color="text-rose-300" />
                  <MiniStat label="Participants" value={activeMeeting.participants.length} icon={<Users className="w-3.5 h-3.5" />} color="text-cyan-300" />
                </div>
              </div>

              {/* ─── Discussion Rounds ─── */}
              {activeMeeting.rounds.map((round) => (
                <div key={round.roundNumber} className="bg-slate-900/90 border border-slate-700 rounded-2xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-violet-400" />
                      Round {round.roundNumber}
                      {round.roundNumber === 1 && <span className="text-[10px] text-slate-400 font-normal ml-1">— Initial Responses</span>}
                      {round.roundNumber >= 2 && <span className="text-[10px] text-slate-400 font-normal ml-1">— Cross-pollination</span>}
                    </h4>
                    {round.completedAt && (
                      <span className="text-[11px] text-slate-400">
                        {formatDuration(round.completedAt - round.startedAt)}
                      </span>
                    )}
                  </div>

                  <div className="space-y-3">
                    {round.responses.map((resp, i) => {
                      const style = getParticipantStyle(resp.participant);
                      return (
                        <div key={i} className={`rounded-xl border p-4 ${style.border} ${style.bg}`}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span>{style.icon}</span>
                              <span className={`text-sm font-semibold ${style.accent}`}>{resp.participant.toUpperCase()}</span>
                              {resp.status === 'success' ? (
                                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <XCircle className="w-3.5 h-3.5 text-rose-400" />
                              )}
                            </div>
                            <span className="text-[11px] text-slate-400">
                              {formatDuration(resp.durationMs)} · {resp.response?.length || 0} chars
                            </span>
                          </div>

                          {resp.status === 'success' ? (
                            <pre className="whitespace-pre-wrap text-xs text-slate-200 leading-relaxed max-h-64 overflow-auto">
                              {resp.response}
                            </pre>
                          ) : (
                            <div className="flex items-start gap-2">
                              <p className="text-xs text-rose-300">
                                {resp.status === 'timeout' ? '⏱ Timeout — Agent ใช้เวลานานเกินไป' :
                                  resp.status === 'unavailable' ? '🔌 Unavailable — Agent ไม่พร้อมใช้งาน' :
                                  `❌ Error: ${resp.error || 'unknown'}`}
                              </p>
                              {resp.durationMs > 0 && (
                                <span className="text-[10px] text-slate-500 shrink-0">({formatDuration(resp.durationMs)})</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* ─── Active indicator ─── */}
              {isActive && (
                <div className="flex items-center justify-center gap-3 py-6">
                  <Loader2 className="w-5 h-5 text-violet-400 animate-spin" />
                  <span className="text-sm text-violet-300">
                    {activeMeeting.status === 'discussing' && 'Agents are discussing...'}
                    {activeMeeting.status === 'synthesizing' && 'Jarvis is synthesizing the final answer...'}
                    {activeMeeting.status === 'preparing' && 'Preparing meeting room...'}
                  </span>
                </div>
              )}

              {/* ─── Jarvis Synthesis ─── */}
              {activeMeeting.synthesis && (
                <div className="bg-gradient-to-br from-violet-900/30 via-slate-900 to-slate-900 border border-violet-500/30 rounded-2xl p-5">
                  <h4 className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
                    <Bot className="w-4 h-4 text-violet-400" />
                    👑 Jarvis — Meeting Summary
                    {activeMeeting.totalDurationMs && (
                      <span className="text-[11px] text-slate-400 font-normal ml-2">
                        Total: {formatDuration(activeMeeting.totalDurationMs)}
                      </span>
                    )}
                  </h4>
                  <pre className="whitespace-pre-wrap text-sm text-slate-200 leading-relaxed max-h-[500px] overflow-auto">
                    {activeMeeting.synthesis}
                  </pre>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────

function MiniStat({ label, value, icon, color }: { label: string; value: number; icon: React.ReactNode; color: string }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-400">{label}</span>
        <span className={color}>{icon}</span>
      </div>
      <p className={`text-xl font-semibold mt-0.5 ${color}`}>{value}</p>
    </div>
  );
}
