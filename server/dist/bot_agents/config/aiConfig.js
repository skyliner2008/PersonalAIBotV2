export var TaskType;
(function (TaskType) {
    TaskType["GENERAL"] = "general";
    TaskType["COMPLEX"] = "complex";
    TaskType["VISION"] = "vision";
    TaskType["WEB_BROWSER"] = "web";
    TaskType["THINKING"] = "thinking";
    TaskType["CODE"] = "code";
    TaskType["DATA"] = "data";
    TaskType["SYSTEM"] = "system";
})(TaskType || (TaskType = {}));
/**
 * Default model routing — สามารถ override ผ่าน Dashboard ได้
 */
export const modelRouting = {
    [TaskType.GENERAL]: {
        active: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
        fallbacks: [
            { provider: 'gemini', modelName: 'gemini-2.5-flash' },
            { provider: 'openai', modelName: 'gpt-4o-mini' }
        ]
    },
    [TaskType.COMPLEX]: {
        active: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
        fallbacks: [
            { provider: 'openai', modelName: 'gpt-4o' },
            { provider: 'gemini', modelName: 'gemini-2.0-flash' }
        ]
    },
    [TaskType.VISION]: {
        active: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
        fallbacks: [
            { provider: 'gemini', modelName: 'gemini-2.5-flash' }
        ]
    },
    [TaskType.WEB_BROWSER]: {
        active: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
        fallbacks: [
            { provider: 'gemini', modelName: 'gemini-2.5-flash' },
            { provider: 'openai', modelName: 'gpt-4o-mini' }
        ]
    },
    [TaskType.THINKING]: {
        active: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
        fallbacks: [
            { provider: 'openai', modelName: 'gpt-4o' }
        ]
    },
    [TaskType.CODE]: {
        active: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
        fallbacks: [
            { provider: 'openai', modelName: 'gpt-4o' }
        ]
    },
    [TaskType.DATA]: {
        active: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
        fallbacks: [
            { provider: 'openai', modelName: 'gpt-4o' }
        ]
    },
    [TaskType.SYSTEM]: {
        active: { provider: 'gemini', modelName: 'gemini-2.0-flash-lite' },
        fallbacks: [
            { provider: 'gemini', modelName: 'gemini-2.0-flash' }
        ]
    },
};
/** Cache สำหรับ performance data (refresh ทุก 10 นาที) */
let _perfCache = null;
let _perfCacheExpiry = 0;
const PERF_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
/**
 * ดึง model performance stats จาก usage_tracking (24h window)
 * คำนวณ composite score = successRate × 40 + speed × 30 + volume × 30
 */
export function getModelPerformance(taskType) {
    const now = Date.now();
    if (_perfCache && now < _perfCacheExpiry) {
        return taskType ? _perfCache.filter(p => p.taskType === taskType) : _perfCache;
    }
    try {
        // Dynamic import to avoid circular dependency
        let dbAll;
        try {
            const dbModule = require('../../database/db.js');
            dbAll = dbModule.dbAll;
        }
        catch {
            _perfCache = [];
            return taskType ? [] : [];
        }
        if (!dbAll) {
            _perfCache = [];
            return taskType ? [] : [];
        }
        const cutoff = new Date(now - 24 * 3600_000).toISOString();
        const rows = dbAll(`
      SELECT model, provider, task,
        COUNT(*) as total,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
        ROUND(AVG(duration_ms)) as avgMs
      FROM usage_tracking
      WHERE created_at >= ? AND task = 'agent'
      GROUP BY model, provider, task
      HAVING total >= 3
      ORDER BY total DESC
    `, [cutoff]);
        _perfCache = rows.map((r) => {
            const successRate = r.total > 0 ? r.successes / r.total : 0;
            // Speed score: faster = higher (normalize: 0-1 where 30s+ = 0)
            const speedScore = Math.max(0, 1 - (r.avgMs / 30_000));
            // Volume confidence: more runs = higher confidence (cap at 50 runs)
            const volumeScore = Math.min(r.total / 50, 1);
            // Composite score (0-100)
            const score = Math.round((successRate * 40) + (speedScore * 30) + (volumeScore * 30));
            return {
                model: r.model,
                provider: r.provider,
                taskType: r.task,
                successRate,
                avgDurationMs: r.avgMs,
                totalRuns: r.total,
                score,
            };
        });
        _perfCacheExpiry = now + PERF_CACHE_TTL_MS;
    }
    catch {
        _perfCache = [];
    }
    return taskType ? (_perfCache || []).filter(p => p.taskType === taskType) : (_perfCache || []);
}
/**
 * หา model ที่ดีที่สุดสำหรับ task type ที่ระบุ (จาก historical performance)
 * Return null ถ้ายังไม่มีข้อมูลเพียงพอ (ใช้ default routing แทน)
 */
export function getBestModelForTask(taskType) {
    const perf = getModelPerformance(taskType);
    if (perf.length === 0)
        return null;
    // เอาอันที่ score สูงสุด
    const best = perf.sort((a, b) => b.score - a.score)[0];
    // ต้องมี score >= 50 ถึงจะแนะนำ (ป้องกันการเปลี่ยนไปใช้ model ห่วย)
    if (best.score < 50)
        return null;
    return { provider: best.provider, modelName: best.model };
}
/** Invalidate performance cache (เรียกตอน self-reflection update config) */
export function invalidatePerformanceCache() {
    _perfCache = null;
    _perfCacheExpiry = 0;
}
const taskKeywords = {
    [TaskType.THINKING]: [
        { keywords: ['คิด', 'วิเคราะห์', 'ให้เหตุผล', 'เปรียบเทียบ', 'สรุปให้', 'ข้อดี', 'ข้อเสีย', 'ตัดสินใจ'], score: 3 },
        { keywords: ['analyze', 'reason', 'think step', 'compare', 'pros and cons', 'evaluate', 'decide'], score: 3 },
        { keywords: ['ทำไม', 'อย่างไร', 'why', 'how does', 'explain why'], score: 2 },
    ],
    [TaskType.SYSTEM]: [
        { keywords: ['self_heal', 'self_reflect', 'self_view_evolution', 'self_read_source', 'self_edit_persona', 'self_add_learning'], score: 10 },
        { keywords: ['เช็คสุขภาพระบบ', 'วิเคราะห์ตัวเอง', 'ดู evolution log', 'ดู log ตัวเอง', 'ปรับปรุงตัวเอง', 'ซ่อมตัวเอง', 'สถานะระบบ'], score: 5 },
        { keywords: ['system status', 'health check', 'check system', 'evolution', 'reflect', 'heal', 'config', 'models'], score: 4 },
    ],
    [TaskType.WEB_BROWSER]: [
        { keywords: ['เปิดเว็บ', 'เข้าเว็บ', 'ค้นหา', 'หาข้อมูล', 'search', 'google'], score: 3 },
        { keywords: ['ราคา', 'วันนี้', 'ล่าสุด', 'อัพเดท', 'อัปเดต', 'ตอนนี้', 'ข่าว', 'สภาพอากาศ', 'หุ้น', 'คริปโต', 'bitcoin'], score: 3 },
        { keywords: ['browse', 'navigate', 'website', 'url', 'link'], score: 3 },
        { keywords: ['price', 'today', 'latest', 'current', 'news', 'weather', 'stock'], score: 3 },
        { keywords: ['เช็ค', 'ดู', 'แนะนำร้าน', 'รีวิว', 'how much', 'what is the', 'who is'], score: 2 },
    ],
    [TaskType.CODE]: [
        { keywords: ['เขียนโค้ด', 'โค้ด', 'โปรแกรม', 'แก้บัค', 'debug', 'code', 'program', 'script', 'function'], score: 3 },
        { keywords: ['python', 'javascript', 'typescript', 'html', 'css', 'java', 'c++', 'sql', 'api'], score: 3 },
        { keywords: ['implement', 'refactor', 'algorithm', 'class', 'module', 'library', 'import'], score: 2 },
        { keywords: ['regex', 'json', 'xml', 'yaml', 'database', 'query', 'deploy'], score: 2 },
    ],
    [TaskType.DATA]: [
        { keywords: ['วิเคราะห์ข้อมูล', 'กราฟ', 'ตาราง', 'สถิติ', 'คำนวณ', 'chart', 'graph', 'plot'], score: 3 },
        { keywords: ['csv', 'excel', 'spreadsheet', 'data analysis', 'statistics', 'average', 'mean'], score: 3 },
        { keywords: ['จำนวน', 'เปอร์เซ็นต์', 'ผลรวม', 'เฉลี่ย', 'sum', 'count', 'percentage'], score: 2 },
    ],
    [TaskType.COMPLEX]: [
        { keywords: ['เขียนบทความ', 'แต่ง', 'ออกแบบ', 'วางแผน', 'สร้าง', 'design', 'plan', 'create'], score: 2 },
        { keywords: ['อธิบายละเอียด', 'สรุปยาว', 'detailed', 'comprehensive', 'in-depth'], score: 2 },
    ],
    [TaskType.VISION]: [], // Handled by attachment check
    [TaskType.GENERAL]: [], // Default fallback
};
import { classificationCache } from '../../utils/cache.js';
/**
 * Smart task classification with keyword scoring + confidence + caching + input-size awareness
 */
export function classifyTask(message, hasAttachments) {
    if (hasAttachments)
        return { type: TaskType.VISION, confidence: 'high', topScore: 10, secondScore: 0 };
    // Cache lookup — same message pattern → same classification
    const cacheKey = `cls:${message.substring(0, 200).toLowerCase()}`;
    const cached = classificationCache.get(cacheKey);
    if (cached) {
        try {
            return JSON.parse(cached);
        }
        catch { /* parse failed, recompute */ }
    }
    const result = _classifyCore(message);
    classificationCache.set(cacheKey, JSON.stringify(result));
    return result;
}
function _classifyCore(message) {
    const msg = message.toLowerCase();
    const scores = {
        [TaskType.GENERAL]: 0,
        [TaskType.COMPLEX]: 0,
        [TaskType.VISION]: 0,
        [TaskType.WEB_BROWSER]: 0,
        [TaskType.THINKING]: 0,
        [TaskType.CODE]: 0,
        [TaskType.DATA]: 0,
        [TaskType.SYSTEM]: 0,
    };
    for (const [taskType, rules] of Object.entries(taskKeywords)) {
        for (const rule of rules) {
            for (const keyword of rule.keywords) {
                if (msg.includes(keyword)) {
                    scores[taskType] += rule.score;
                }
            }
        }
    }
    // Bonus: long messages are more likely complex
    if (message.length > 300)
        scores[TaskType.COMPLEX] += 2;
    if (message.length > 500)
        scores[TaskType.COMPLEX] += 1;
    // Input-size awareness: very long messages → route to THINKING/COMPLEX for deeper models
    if (message.length > 2000) {
        scores[TaskType.THINKING] += 2;
        scores[TaskType.COMPLEX] += 2;
    }
    if (message.length > 5000) {
        scores[TaskType.THINKING] += 3;
    }
    // Sort scores descending to find top 2
    const sorted = Object.entries(scores).sort(([, a], [, b]) => b - a);
    const bestType = sorted[0][0] || TaskType.GENERAL;
    const topScore = sorted[0][1];
    const secondScore = sorted[1]?.[1] ?? 0;
    // Compute confidence from gap between top two scores
    const confidence = topScore === 0 ? 'low'
        : topScore - secondScore >= 3 ? 'high'
            : topScore - secondScore >= 1 ? 'medium'
                : 'low';
    return { type: bestType, confidence, topScore, secondScore };
}
//# sourceMappingURL=aiConfig.js.map