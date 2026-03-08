export enum TaskType {
  GENERAL = 'general',      // งานทักทาย ถามตอบทั่วไป
  COMPLEX = 'complex',      // งานวิเคราะห์ลึก เขียนโค้ด
  VISION = 'vision',        // งานวิเคราะห์ภาพ
  WEB_BROWSER = 'web',      // งานค้นหาข้อมูล เปิดเว็บ
  THINKING = 'thinking',    // งานที่ต้องคิดเป็นขั้นตอนสูง
  CODE = 'code',            // งานเขียนโค้ดโดยเฉพาะ
  DATA = 'data',            // งานวิเคราะห์ข้อมูล
  SYSTEM = 'system',        // คำสั่งระบบ / self-evolution
}

export interface ModelConfig {
  provider: 'gemini' | 'openai' | 'minimax';
  modelName: string;
}

/**
 * Default model routing — สามารถ override ผ่าน Dashboard ได้
 */
export const modelRouting: Record<TaskType, ModelConfig> = {
  [TaskType.GENERAL]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
  [TaskType.COMPLEX]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
  [TaskType.VISION]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
  [TaskType.WEB_BROWSER]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
  [TaskType.THINKING]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
  [TaskType.CODE]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
  [TaskType.DATA]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
  [TaskType.SYSTEM]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
};

// ============================================================
// Keyword scoring system — ให้คะแนนทุกประเภทแล้วเลือกที่ได้สูงสุด
// ============================================================

interface KeywordRule {
  keywords: string[];
  score: number;
}

const taskKeywords: Record<TaskType, KeywordRule[]> = {
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

  [TaskType.VISION]: [],  // Handled by attachment check
  [TaskType.GENERAL]: [],  // Default fallback
};

/**
 * Classification result with confidence scoring
 */
export interface TaskClassification {
  type: TaskType;
  confidence: 'high' | 'medium' | 'low';
  topScore: number;
  secondScore: number;
}

/**
 * Smart task classification with keyword scoring + confidence
 */
export function classifyTask(message: string, hasAttachments: boolean): TaskClassification {
  if (hasAttachments) return { type: TaskType.VISION, confidence: 'high', topScore: 10, secondScore: 0 };

  const msg = message.toLowerCase();
  const scores: Record<TaskType, number> = {
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
          scores[taskType as TaskType] += rule.score;
        }
      }
    }
  }

  // Bonus: long messages are more likely complex
  if (message.length > 300) scores[TaskType.COMPLEX] += 2;
  if (message.length > 500) scores[TaskType.COMPLEX] += 1;

  // Sort scores descending to find top 2
  const sorted = Object.entries(scores).sort(([, a], [, b]) => (b as number) - (a as number));
  const bestType = (sorted[0][0] as TaskType) || TaskType.GENERAL;
  const topScore = sorted[0][1] as number;
  const secondScore = (sorted[1]?.[1] as number) ?? 0;

  // Compute confidence from gap between top two scores
  const confidence: TaskClassification['confidence'] =
    topScore === 0 ? 'low'
      : topScore - secondScore >= 3 ? 'high'
        : topScore - secondScore >= 1 ? 'medium'
          : 'low';

  return { type: bestType, confidence, topScore, secondScore };
}
