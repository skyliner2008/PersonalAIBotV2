import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { 
  Zap, Bug, Shield, Wrench, Sparkles, RefreshCcw, 
  Trash2, CheckCircle2, XCircle, Clock, Rocket, FileCode,
  Info, AlertTriangle, Search, ChevronRight, Activity, Bot, Eye, X
} from 'lucide-react';

// ── Types ──
interface UpgradeStatus {
  running: boolean;
  paused: boolean;
  isIdle: boolean;
  idleMinutes: number;
  idleThresholdMinutes: number;
  checkIntervalMs: number;
  scanProgress: { cursor: number; total: number; percent: number };
  dryRun: boolean;
}

interface ProposalStats {
  total: number;
  pending: number;
  approved: number;
  rejected: number;
  implemented: number;
  byType: Record<string, number>;
  byPriority: Record<string, number>;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
}

interface Proposal {
  id: number;
  type: string;
  title: string;
  description: string;
  file_path: string;
  line_range?: string;
  suggested_fix?: string;
  priority: string;
  status: string;
  model_used: string;
  confidence: number;
  created_at: string;
  reviewed_at?: string;
}

// const API = '/api/upgrade'; // Removed in favor of api service

const TYPE_META: Record<string, { icon: any, textColor: string, bgColor: string, label: string }> = {
  bug: { icon: Bug, textColor: 'text-red-400', bgColor: 'bg-red-400', label: 'บัค' },
  feature: { icon: Sparkles, textColor: 'text-blue-400', bgColor: 'bg-blue-400', label: 'ฟีเจอร์' },
  optimization: { icon: Zap, textColor: 'text-yellow-400', bgColor: 'bg-yellow-400', label: 'ประสิทธิภาพ' },
  refactor: { icon: Wrench, textColor: 'text-purple-400', bgColor: 'bg-purple-400', label: 'รีแฟคเตอร์' },
  security: { icon: Shield, textColor: 'text-orange-400', bgColor: 'bg-orange-400', label: 'ความปลอดภัย' },
  tool: { icon: Wrench, textColor: 'text-emerald-400', bgColor: 'bg-emerald-400', label: 'เครื่องมือ' },
};

const PRIORITY_THEMES: Record<string, string> = {
  critical: 'bg-red-500/10 text-red-500 border-red-500/20',
  high: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  medium: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20',
  low: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
};

const STATUS_THEMES: Record<string, string> = {
  pending: 'bg-indigo-500/10 text-indigo-400 border-indigo-500/20',
  approved: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  rejected: 'bg-rose-500/10 text-rose-400 border-rose-500/20',
  implemented: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  implementing: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/20 animate-pulse',
};

export default function SelfUpgrade() {
  const [status, setStatus] = useState<UpgradeStatus | null>(null);
  const [stats, setStats] = useState<ProposalStats | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [filterType, setFilterType] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [implementingId, setImplementingId] = useState<number | null>(null);

  const [diffData, setDiffData] = useState<{ before: string; after: string } | null>(null);
  const [showDiffModal, setShowDiffModal] = useState<{ id: number; title: string; filePath: string } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffViewMode, setDiffViewMode] = useState<'split' | 'unified'>('split');

  const fetchData = useCallback(async () => {
    try {
      const [statusData, proposalData] = await Promise.all([
        api.getUpgradeStatus(),
        api.getUpgradeProposals(filterStatus, filterType, 2000),
      ]);
      if (statusData) {
        setStatus(statusData.status);
        setStats(statusData.stats);
      }
      if (proposalData) {
        setProposals(proposalData.proposals);
        if (proposalData.stats) setStats(proposalData.stats);
      }
    } catch (err) {
      console.error('Failed to fetch upgrade data:', err);
    } finally {
      setLoading(false);
    }
  }, [filterStatus, filterType]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    const interval = setInterval(fetchData, 15000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const updateStatus = async (id: number, newStatus: string) => {
    try {
      await api.updateUpgradeProposalStatus(id, newStatus);
      fetchData();
    } catch (err) {
      console.error('Failed to update proposal:', err);
      alert('เกิดข้อผิดพลาดในการอัปเดตสถานะ');
    }
  };

  const implementProposal = async (id: number) => {
    try {
      setImplementingId(id);
      await api.implementUpgradeProposal(id);
      await fetchData();
      // DO NOT setImplementingId(null) here! 
      // Keep it spinning until the 15-second interval fetchData confirms the new status (implementing or implemented)
    } catch (err) {
      console.error('Failed to implement proposal:', err);
      setImplementingId(null);
    }
  };

  const implementAllApproved = async () => {
    const approvedCount = proposals.filter(p => p.status === 'approved').length;
    if (approvedCount === 0) return;
    if (!confirm(`ยืนยันการดำเนินการทั้งหมด (${approvedCount} รายการ)? ระบบจะค่อยๆ ทยอยแก้ไขทีละไฟล์และอาจมีการรีสตาร์ทเซิร์ฟเวอร์เป็นระยะ`)) return;
    
    try {
      await api.implementAllApprovedProposals();
      await fetchData();
      alert('เริ่มดำเนินการแบบชุดแล้ว กรุณารอสักครู่ (สถานะจะทยอยเปลี่ยนเป็น Implementing)');
    } catch (err) {
      console.error('Failed to implement all:', err);
      alert('เกิดข้อผิดพลาดในการสั่งการแบบชุด');
    }
  };

  const deleteProposal = async (id: number) => {
    if (!confirm('ลบ proposal นี้?')) return;
    try {
      await api.deleteUpgradeProposal(id);
      fetchData();
    } catch (err) {
      console.error('Failed to delete proposal:', err);
    }
  };

  const triggerScan = async () => {
    setScanning(true);
    try {
      const data = await api.triggerUpgradeScan();
      if (data) {
        alert(`สแกนเสร็จ: พบ ${data.findings} รายการ (รายการใหม่ ${data.newFindings || 0} รายการ)`);
        fetchData();
      }
    } finally {
      setScanning(false);
    }
  };

  const viewDiff = async (p: Proposal) => {
    setShowDiffModal({ id: p.id, title: p.title, filePath: p.file_path });
    setDiffLoading(true);
    setDiffData(null);
    try {
      const res = await api.getUpgradeProposalDiff(p.id);
      if (res && res.ok) {
        setDiffData({ before: res.before, after: res.after });
      }
    } catch (e: any) {
      console.error(e);
      setDiffData({ before: `Error loading backup logs. They might not exist.\n\n${e.message}`, after: '' });
    } finally {
      setDiffLoading(false);
    }
  };

  const handleIntervalChange = async (intervalMs: number) => {
    try {
      await api.updateUpgradeConfig({ intervalMs });
      // Refresh status to reflect change
      const newStatus = await api.getUpgradeStatus();
      setStatus(newStatus.status);
    } catch (err) {
      console.error('Failed to update interval:', err);
    }
  };

  const togglePause = async () => {
    if (!status) return;
    const newPaused = !status.paused;
    try {
      await api.toggleUpgradePaused(newPaused);
      setStatus(prev => prev ? { ...prev, paused: newPaused } : prev);
    } catch (err) {
      console.error('Failed to toggle pause:', err);
      alert('Failed to toggle Auto-Upgrade state.');
    }
  };

  if (loading || !status) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[400px]">
        <div className="flex flex-col items-center gap-4 text-gray-500">
          <RefreshCcw className="w-8 h-8 animate-spin opacity-20" />
          <p className="animate-pulse text-sm">กำลังโหลดข้อมูลระบบ...</p>
        </div>
      </div>
    );
  }

  const INTERVALS = [
    { label: '30M', value: 30 * 60 * 1000 },
    { label: '1H', value: 60 * 60 * 1000 },
    { label: '2H', value: 2 * 60 * 60 * 1000 },
    { label: '4H', value: 4 * 60 * 60 * 1000 },
    { label: '6H', value: 6 * 60 * 60 * 1000 },
    { label: '12H', value: 12 * 60 * 60 * 1000 },
    { label: '1D', value: 24 * 60 * 60 * 1000 },
  ];

  return (
    <div className="p-4 md:p-6 space-y-4 animate-in fade-in duration-700">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 bg-gradient-to-r from-blue-600/10 to-purple-600/10 px-4 py-2.5 rounded-xl border border-white/5 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Rocket className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white tracking-tight flex items-center gap-2 leading-none">
              Self-Upgrade System
              <span className="text-[9px] px-1.5 py-0.5 bg-blue-500/20 text-blue-400 rounded-full font-mono uppercase tracking-widest border border-blue-500/20">v2.1</span>
            </h1>
            <p className="text-gray-400 text-sm mt-0.5 max-w-md">
              ระบบตรวจสอบและพัฒนาตัวเองอัตโนมัติ สแกนโค้ดและเสนอแนวทางปรับปรุงผ่าน AI
            </p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <button
            onClick={togglePause}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg font-bold text-xs transition-all duration-300 shadow-sm border ${
              status?.paused 
                ? 'bg-rose-500/10 text-rose-400 border-rose-500/20 hover:bg-rose-500/20 shadow-rose-500/10' 
                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/20 shadow-emerald-500/10'
            }`}
          >
            {status?.paused ? '▶ เปิด Auto-Upgrade' : '⏸ พัก Auto-Upgrade'}
          </button>

          <div className="flex items-center gap-2 px-2.5 py-1 bg-gray-900/60 border border-white/5 rounded-lg">
            <Clock className="w-3 h-3 text-gray-500" />
            <select 
              className="bg-transparent text-[10px] text-gray-300 outline-none cursor-pointer"
              value={status.checkIntervalMs}
              onChange={(e) => handleIntervalChange(Number(e.target.value))}
            >
              {INTERVALS.map(opt => (
                <option key={opt.value} value={opt.value} className="bg-gray-900">{opt.label}</option>
              ))}
            </select>
          </div>

          <button
            onClick={triggerScan}
            disabled={scanning}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-bold text-xs transition-all duration-300 shadow-sm ${
              scanning 
                ? 'bg-gray-800 text-gray-500 ring-1 ring-white/10' 
                : 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-500/25 hover:scale-105 active:scale-95'
            }`}
          >
            {scanning ? <RefreshCcw className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            <span>{scanning ? 'กำลังสแกน...' : 'สแกนเดี๋ยวนี้'}</span>
          </button>
        </div>
      </div>

      {/* Status Region */}
      {status && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatusCard 
            label="สถานะเครื่องยนต์" 
            value={status.running ? (status.paused ? 'หยุดชั่วคราว' : status.isIdle ? 'พร้อมทำงาน' : 'พักเครื่อง (รอ Idle)') : 'ปิดการทำงาน'}
            icon={Activity}
            color={status.running ? (status.isIdle ? 'text-green-400' : 'text-yellow-400') : 'text-gray-500'}
          />
          <StatusCard 
            label="เวลาที่หยุดนิ่ง (Idle)" 
            value={`${status.idleMinutes} นาที`}
            icon={Zap}
            subValue={status.isIdle ? 'เงื่อนไขครบถ้วน ✅' : `ต้องการ 30 นาที`}
            color={status.isIdle ? 'text-blue-400' : 'text-gray-400'}
          />
          <div className="bg-gray-900/40 border border-white/5 rounded-lg px-3 py-2 backdrop-blur-sm relative overflow-hidden group flex flex-col justify-center">
            <div className="flex justify-between items-start mb-1">
              <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Scan Progress</span>
              <RefreshCcw className="w-3 h-3 text-indigo-400 group-hover:rotate-180 transition-transform duration-700" />
            </div>
            <div className="text-sm font-bold text-white mb-1.5">
              {status.scanProgress.percent}% <span className="text-[10px] font-normal text-gray-500 ml-1">({status.scanProgress.cursor}/{status.scanProgress.total})</span>
            </div>
            <div className="w-full bg-white/5 rounded-full h-2">
              <div 
                className="bg-gradient-to-r from-blue-500 to-indigo-600 h-2 rounded-full transition-all duration-1000 shadow-[0_0_8px_rgba(59,130,246,0.5)]"
                style={{ width: `${status.scanProgress.percent}%` }}
              />
            </div>
          </div>
          <StatusCard 
            label="โหมดการทำงาน" 
            value={status.dryRun ? 'Propose (เสนอแผน)' : 'Auto-Fix (แก้ทันที)'}
            icon={Sparkles}
            color={status.dryRun ? 'text-purple-400' : 'text-orange-400'}
          />
        </div>
      )}

      {/* Content Area */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        
        {/* Left: Proposal List */}
        <div className="lg:col-span-8 space-y-2">
          <div className="flex items-center justify-between pb-1 border-b border-white/5">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              รายการข้อเสนอทางเทคนิค
              <span className="text-[11px] font-normal text-gray-500 ml-2">พบ {proposals.length} รายการ</span>
            </h2>
            <div className="flex items-center gap-3">
              {proposals.some(p => p.status === 'approved') && (
                <button
                  onClick={implementAllApproved}
                  className="flex items-center gap-2 px-3 py-1.5 bg-fuchsia-600 hover:bg-fuchsia-500 text-white text-xs font-bold rounded-lg shadow-lg shadow-fuchsia-500/20 transition-all duration-300 hover:scale-105 active:scale-95"
                >
                  <Rocket className="w-3.5 h-3.5" />
                  ดำเนินการทันที (ทั้งหมด)
                </button>
              )}
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="bg-gray-900/60 border border-white/10 text-gray-300 text-xs rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">ทุกสถานะ</option>
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="implemented">Implemented</option>
              </select>
            </div>
          </div>

          <div className="space-y-4">
            {proposals.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 bg-gray-900/20 border border-dashed border-white/10 rounded-3xl text-gray-500">
                <Search className="w-12 h-12 mb-4 opacity-20" />
                <p>ยังไม่มีข้อเสนอในขณะนี้</p>
              </div>
            ) : (
              proposals.map((p) => {
                const typeMeta = TYPE_META[p.type] || { icon: FileCode, textColor: 'text-gray-400', bgColor: 'bg-gray-400', label: p.type };
                return (
                  <div key={p.id} className="group bg-gray-900/40 border border-white/5 p-3 rounded-xl hover:bg-gray-800/40 hover:border-white/10 transition-all duration-300 hover:shadow-xl hover:shadow-blue-500/5">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-2 flex-wrap">
                          <div className={`p-1.5 rounded-lg bg-white/5 ${typeMeta.textColor}`}>
                            <typeMeta.icon className="w-4 h-4" />
                          </div>
                          <h3 className="text-sm font-bold text-gray-100 group-hover:text-white transition-colors">
                            {p.title}
                          </h3>
                          <div className="flex items-center gap-2">
                            <span className={`text-[10px] px-2 py-0.5 rounded-md border font-bold uppercase tracking-wide ${PRIORITY_THEMES[p.priority] || ''}`}>
                              {p.priority}
                            </span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-md border font-bold uppercase tracking-wide ${STATUS_THEMES[p.status] || ''}`}>
                              {p.status}
                            </span>
                          </div>
                        </div>
                        <p className="text-gray-400 text-[10px] leading-relaxed mb-2 pl-1 border-l border-white/5 ml-3">
                          {p.description}
                        </p>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-gray-500 mt-1 pl-3">
                          <div className="flex items-center gap-1.5">
                            <FileCode className="w-3 h-3" />
                            <span className="hover:text-blue-400 cursor-pointer transition-colors max-w-[200px] truncate">{p.file_path}{p.line_range ? `:${p.line_range}` : ''}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Bot className="w-3 h-3" />
                            <span>{p.model_used}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <Sparkles className="w-3 h-3" />
                            <span>{(p.confidence * 100).toFixed(0)}% Confidence</span>
                          </div>
                          <div className="flex items-center gap-1.5 ml-auto opacity-60">
                            <span>{new Date(p.created_at).toLocaleString('th-TH', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}</span>
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-row gap-1.5 shrink-0 items-center">
                        {(p.status === 'pending' || p.status === 'rejected') && (
                          <>
                            <ActionButton 
                              onClick={() => updateStatus(p.id, 'approved')} 
                              icon={CheckCircle2} 
                              color="text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20" 
                              title={p.status === 'rejected' ? "อนุมัติ / ทดลองใหม่" : "อนุมัติ"}
                            />
                            {p.status === 'pending' && (
                              <ActionButton 
                                onClick={() => updateStatus(p.id, 'rejected')} 
                                icon={XCircle} 
                                color="text-rose-400 bg-rose-500/10 hover:bg-rose-500/20" 
                                title="ปฏิเสธ"
                              />
                            )}
                          </>
                        )}
                        {(p.status === 'approved' || p.status === 'implementing' || p.status === 'rejected') && (
                          <ActionButton 
                            onClick={() => (p.status === 'approved' || p.status === 'rejected') ? implementProposal(p.id) : null} 
                            icon={p.status === 'implementing' || implementingId === p.id ? RefreshCcw : Rocket} 
                            color={p.status === 'implementing' || implementingId === p.id 
                              ? "text-fuchsia-400 bg-fuchsia-500/20 cursor-wait" 
                              : "text-purple-400 bg-purple-500/10 hover:bg-purple-500/20"
                            } 
                            title={p.status === 'implementing' || implementingId === p.id ? "กำลังให้ AI แก้ไขโค้ด (รอประมาณ 1 นาที)..." : "ดำเนินการทันที"}
                            disabled={p.status === 'implementing' || implementingId !== null}
                            spin={p.status === 'implementing' || implementingId === p.id}
                          />
                        )}
                        {p.status === 'implemented' && (
                          <ActionButton 
                            onClick={() => viewDiff(p)} 
                            icon={Eye} 
                            color="text-cyan-400 bg-cyan-500/10 hover:bg-cyan-500/20" 
                            title="ดูการเปลี่ยนแปลงโค้ด (Diff)"
                          />
                        )}
                        <ActionButton 
                          onClick={() => deleteProposal(p.id)} 
                          icon={Trash2} 
                          color="text-gray-500 bg-white/5 hover:bg-white/10 hover:text-red-400" 
                          title="ลบ"
                        />
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right: Stats and Charts Placeholder */}
        <div className="lg:col-span-4 space-y-3">
          <div className="bg-gray-900/60 border border-white/5 rounded-xl p-3 backdrop-blur-md sticky top-6">
            <h2 className="text-xs font-bold text-white mb-3 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-yellow-400" />
              สรุปสถิติเชิงลึก
            </h2>
            
            {stats && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <StatBox label="รอดำเนินการ" value={stats.pending} color="text-indigo-400" />
                  <StatBox label="อนุมัติแล้ว" value={stats.approved} color="text-emerald-400" />
                  <StatBox label="ปฏิเสธ" value={stats.rejected} color="text-rose-400" />
                  <StatBox label="สำเร็จแล้ว" value={stats.implemented} color="text-purple-400" />
                </div>

                <div className="pt-3 border-t border-white/5">
                  <label className="text-[9px] text-gray-500 uppercase font-bold tracking-widest mb-2 block">แยกตามประเภท</label>
                  <div className="space-y-1.5">
                    {Object.entries(stats.byType).map(([type, count]) => {
                      const meta = TYPE_META[type] || { icon: Info, textColor: 'text-gray-400', bgColor: 'bg-gray-400', label: type };
                      const total = stats.total || 1;
                      const percent = (count / total) * 100;
                      return (
                        <div key={type} className="group">
                          <div className="flex justify-between items-center mb-1 text-sm">
                            <div className="flex items-center gap-2 text-gray-300">
                              <meta.icon className={`w-3.5 h-3.5 ${meta.textColor}`} />
                              <span>{meta.label}</span>
                            </div>
                            <div className="text-right">
                              <span className="font-mono font-bold text-white">{count}</span>
                              <span className="font-mono text-[10px] text-gray-500 ml-1">/ {total}</span>
                            </div>
                          </div>
                          <div className="w-full bg-white/5 rounded-full h-1.5 overflow-hidden">
                            <div 
                              className={`h-full rounded-full transition-all duration-1000 ${meta.bgColor}`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="pt-3 border-t border-white/5">
                  <label className="text-[9px] text-gray-500 uppercase font-bold tracking-widest mb-2 block flex items-center gap-1">
                    <Bot className="w-2.5 h-2.5 text-cyan-400" />
                    การใช้ AI Tokens (Self-Upgrade)
                  </label>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <div className="bg-white/5 rounded-lg p-2 border border-white/5">
                      <div className="text-[9px] text-gray-400 mb-0.5 flex items-center gap-1">
                        <Info className="w-2.5 h-2.5 text-gray-500" /> Input
                      </div>
                      <div className="font-mono text-xs text-blue-400 font-bold">{(stats.tokensIn || 0).toLocaleString()}</div>
                    </div>
                    <div className="bg-white/5 rounded-lg p-2 border border-white/5">
                      <div className="text-[9px] text-gray-400 mb-0.5 flex items-center gap-1">
                        <Sparkles className="w-2.5 h-2.5 text-gray-500" /> Output
                      </div>
                      <div className="font-mono text-xs text-purple-400 font-bold">{(stats.tokensOut || 0).toLocaleString()}</div>
                    </div>
                  </div>
                  <div className="bg-emerald-500/10 rounded-lg p-2.5 border border-emerald-500/20 flex flex-col gap-0.5">
                    <div className="flex justify-between items-center w-full">
                       <div className="text-[10px] font-bold text-emerald-500 flex items-center gap-1"><Zap className="w-3 h-3"/> ค่าใช้จ่าย</div>
                       <div className="font-mono font-bold text-emerald-400 text-sm">${(stats.costUsd || 0).toFixed(6)}</div>
                    </div>
                  </div>
                  <p className="text-[9px] text-gray-500/60 mt-1.5 text-center px-1">คำนวณแบบ Dynamic ตามโมเดลที่ตั้งค่าไว้ (Flash/Pro/Lite)</p>
                </div>

                <div className="pt-3 border-t border-white/5">
                  <div className="bg-blue-600/5 rounded-lg p-2.5 border border-blue-500/10">
                    <p className="text-[10px] text-gray-400 flex items-start gap-1.5 leading-relaxed">
                      <Info className="w-3 h-3 text-blue-400 shrink-0 mt-0.5" />
                      ระบบจะสแกนโค้ดโดยอัตโนมัติทุกๆ 30 นาทีเมื่อระบบอยู่ในโหมดว่าง (Idle) หรือกดปุ่มสแกนด้านบนเพื่อทำทันที
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

      </div>

      {/* Diff Modal */}
      {showDiffModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
          <div className="bg-gray-900 border border-white/10 rounded-2xl w-full max-w-6xl h-[85vh] flex flex-col shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-white/5 bg-white/5 shrink-0">
              <div className="flex flex-col">
                <h3 className="font-bold text-gray-100 flex items-center gap-2">
                  <FileCode className="w-4 h-4 text-cyan-400" />
                  {showDiffModal.title}
                </h3>
                <span className="text-xs text-gray-500 font-mono mt-1">{showDiffModal.filePath}</span>
              </div>
              <div className="flex items-center gap-4">
                 <button onClick={() => setDiffViewMode(m => m === 'split' ? 'unified' : 'split')} className="text-xs bg-white/5 hover:bg-white/10 px-3 py-1.5 rounded-lg border border-white/5 transition-colors font-bold text-gray-300">
                    {diffViewMode === 'split' ? 'Unified View' : 'Split View'}
                 </button>
                 <button onClick={() => setShowDiffModal(null)} className="p-2 hover:bg-white/10 rounded-xl transition-colors text-gray-400 hover:text-white">
                   <X className="w-5 h-5" />
                 </button>
              </div>
            </div>
            {/* Body */}
            <div className="flex-1 overflow-hidden p-4 flex flex-col gap-2">
              {diffLoading ? (
                <div className="animate-pulse flex items-center justify-center flex-1 h-full text-gray-500 gap-3">
                  <RefreshCcw className="w-5 h-5 animate-spin" /> โหลดข้อมูลการเปรียบเทียบ...
                </div>
              ) : diffData ? (
                 diffViewMode === 'split' ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 h-full">
                    <div className="flex flex-col h-full bg-black/40 border border-red-500/20 rounded-xl overflow-hidden min-h-0">
                      <div className="shrink-0 bg-red-500/10 text-red-400 text-[10px] font-bold py-2 px-3 border-b border-red-500/20 uppercase tracking-widest flex justify-between">
                         <span>Before (Original)</span>
                      </div>
                      <div className="flex-1 overflow-auto min-h-0">
                        <pre className="p-4 text-[11px] font-mono text-gray-300 w-max min-w-full">
                          {diffData.before}
                        </pre>
                      </div>
                    </div>
                    <div className="flex flex-col h-full bg-black/40 border border-emerald-500/20 rounded-xl overflow-hidden min-h-0">
                      <div className="shrink-0 bg-emerald-500/10 text-emerald-400 text-[10px] font-bold py-2 px-3 border-b border-emerald-500/20 uppercase tracking-widest flex justify-between">
                         <span>After (AI Modified)</span>
                      </div>
                      <div className="flex-1 overflow-auto min-h-0">
                        <pre className="p-4 text-[11px] font-mono text-gray-300 w-max min-w-full">
                          {diffData.after}
                        </pre>
                      </div>
                    </div>
                  </div>
                 ) : (
                   <div className="flex flex-col h-full bg-black/40 border border-white/10 rounded-xl overflow-hidden min-h-0">
                     <div className="shrink-0 bg-white/5 text-gray-300 text-[10px] font-bold py-2 px-3 border-b border-white/10 uppercase tracking-widest">
                       Unified View (After)
                     </div>
                     <div className="flex-1 overflow-auto min-h-0">
                       <pre className="p-4 text-[11px] font-mono text-gray-300 w-max min-w-full">
                          {diffData.after}
                       </pre>
                     </div>
                   </div>
                 )
              ) : (
                <div className="flex flex-col items-center justify-center flex-1 text-gray-500 bg-white/5 rounded-xl border border-dashed border-white/10">
                  <AlertTriangle className="w-8 h-8 mb-3 opacity-50 text-yellow-500" />
                  <span className="text-sm">ไม่พบข้อมูลไฟล์ Backup</span>
                  <span className="text-xs opacity-70 mt-1">ไฟล์อาจถูกดำเนินการก่อนที่ระบบ Diff Tracker จะติดตั้ง</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// ── Sub-components ──

function StatusCard({ label, value, subValue, icon: Icon, color }: any) {
  return (
    <div className="bg-gray-900/40 border border-white/5 rounded-lg px-3 py-2 backdrop-blur-sm group hover:border-white/10 transition-colors flex flex-col justify-center">
      <div className="flex justify-between items-start mb-1">
        <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">{label}</span>
        <Icon className={`w-3 h-3 ${color} opacity-70 group-hover:opacity-100 transition-opacity`} />
      </div>
      <div className={`text-xs font-bold tracking-tight ${color}`}>{value}</div>
      {subValue && <div className="text-[8px] text-gray-600 font-medium mt-0.5">{subValue}</div>}
    </div>
  );
}

function StatBox({ label, value, color }: any) {
  return (
    <div className="bg-white/5 rounded-lg px-2.5 py-1.5 border border-white/5">
      <div className="text-[8px] text-gray-500 uppercase font-black mb-0.5">{label}</div>
      <div className={`text-sm font-mono font-bold ${color}`}>{value}</div>
    </div>
  );
}

function ActionButton({ onClick, icon: Icon, color, title, disabled, spin }: any) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`p-2 rounded-lg transition-all duration-200 active:scale-95 flex items-center justify-center group ${color} ${disabled ? 'opacity-50 cursor-not-allowed hidden-hover' : ''}`}
      title={title}
    >
      <Icon className={`w-4 h-4 ${spin ? 'animate-spin' : ''}`} />
    </button>
  );
}

