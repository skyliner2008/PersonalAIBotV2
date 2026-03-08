export enum TaskType {
  GENERAL   = 'general',    // งานทักทาย ถามตอบทั่วไป
  COMPLEX   = 'complex',    // งานวิเคราะห์ลึก เขียนเนื้อหายาว
  VISION    = 'vision',     // วิเคราะห์ภาพ/ไฟล์
  WEB       = 'web',        // คุมเบราว์เซอร์ / ค้นหา
  THINKING  = 'thinking',   // คิดเป็นขั้นตอนสูง คณิตศาสตร์ logic
  CODE      = 'code',       // เขียนโค้ด debug รันโปรแกรม
  DATA      = 'data',       // วิเคราะห์ข้อมูล Excel CSV คำนวณ
}

// For backward-compat with old key WEB_BROWSER
export { TaskType as default };

export interface ModelConfig {
  provider: 'gemini' | 'openai' | 'minimax';
  modelName: string;
}

/**
 * Routing config — เลือกโมเดลตามประเภทงาน
 * ปรับได้ผ่าน Dashboard หรือ api/config
 */
export const modelRouting: Record<string, ModelConfig> = {
  [TaskType.GENERAL]:  { provider: 'gemini',  modelName: 'gemini-2.0-flash' },       // อัพจาก lite → flash
  [TaskType.COMPLEX]:  { provider: 'gemini',  modelName: 'gemini-2.5-flash' },       // ใช้ Gemini 2.5 Flash (ดีกว่า MiniMax)
  [TaskType.VISION]:   { provider: 'gemini',  modelName: 'gemini-2.0-flash' },
  [TaskType.WEB]:      { provider: 'gemini',  modelName: 'gemini-2.0-flash' },
  [TaskType.THINKING]: { provider: 'gemini',  modelName: 'gemini-2.5-flash' },       // Gemini 2.5 Flash มี thinking built-in
  [TaskType.CODE]:     { provider: 'gemini',  modelName: 'gemini-2.5-flash' },       // อัพ → 2.5 Flash สำหรับ code
  [TaskType.DATA]:     { provider: 'gemini',  modelName: 'gemini-2.5-flash' },       // อัพ → 2.5 Flash สำหรับ data
};

// ==========================================
// Keyword Scoring — รองรับทั้งไทยและอังกฤษ
// ==========================================
const KEYWORD_RULES: Array<{ type: TaskType; keywords: string[]; weight: number }> = [
  // VISION
  {
    type: TaskType.VISION,
    keywords: ['รูป','ภาพ','ดูภาพ','image','photo','picture','screenshot','วิเคราะห์ภาพ','สแกน'],
    weight: 10
  },
  // CODE
  {
    type: TaskType.CODE,
    keywords: [
      'เขียนโค้ด','โปรแกรม','code','debug','bug','error','script','function','class','import',
      'python','javascript','typescript','java','c++','c#','golang','rust','php','sql',
      'api','git','npm','pip','dockerfile','รัน','compile','build','โค้ด','ฟังก์ชัน'
    ],
    weight: 8
  },
  // DATA
  {
    type: TaskType.DATA,
    keywords: [
      'excel','csv','ข้อมูล','คำนวณ','สถิติ','กราฟ','chart','วิเคราะห์ข้อมูล',
      'dataset','ตาราง','pivot','average','median','pandas','numpy',
      'data analysis','ค่าเฉลี่ย','ผลรวม','เปรียบเทียบข้อมูล','regression'
    ],
    weight: 7
  },
  // THINKING
  {
    type: TaskType.THINKING,
    keywords: [
      'ให้เหตุผล','วิเคราะห์เชิงลึก','logic','อธิบาย','เพราะอะไร',
      'คณิต','math','พิสูจน์','proof','ขั้นตอน','step by step','ช่วยคิด',
      'หลักการ','ปรัชญา','pros and cons','ข้อดีข้อเสีย','เปรียบเทียบ','คิด'
    ],
    weight: 6
  },
  // WEB / SEARCH
  {
    type: TaskType.WEB,
    keywords: [
      'เปิดเว็บ','เข้าเว็บ','ค้นหา','search','browse','google','เช็คราคา','ราคา',
      'ข่าว','news','ดาวน์โหลด','download','เว็บไซต์','website','url','http',
      'ราคาทอง','อัตราแลกเปลี่ยน','หุ้น','stock','สกุลเงิน','bitcoin','crypto',
      'ล่าสุด','อัปเดต','วันนี้','ตอนนี้','ปัจจุบัน'
    ],
    weight: 8
  },
  // COMPLEX
  {
    type: TaskType.COMPLEX,
    keywords: [
      'เขียน','สรุป','แปล','translate','draft','outline','report','รายงาน',
      'บทความ','article','essay','แผนธุรกิจ','business plan','proposal',
      'สรุปประชุม','จดหมาย','letter','email','ช่วยเขียน','ร่าง','วิเคราะห์'
    ],
    weight: 5
  },
];

/**
 * จำแนกประเภทงานด้วย Keyword Scoring
 * คืนค่า TaskType ที่มีคะแนนสูงสุด
 */
export function classifyTask(message: string, hasAttachments: boolean): TaskType {
  if (hasAttachments) return TaskType.VISION;

  const msg = message.toLowerCase();
  const scores: Record<string, number> = {};
  for (const t of Object.values(TaskType)) scores[t] = 0;

  for (const rule of KEYWORD_RULES) {
    for (const kw of rule.keywords) {
      if (msg.includes(kw)) {
        scores[rule.type] = (scores[rule.type] || 0) + rule.weight;
      }
    }
  }

  // Bonus: ข้อความยาวแสดงว่าซับซ้อน
  if (message.length > 400) scores[TaskType.COMPLEX] += 3;
  if (message.length > 800) scores[TaskType.THINKING] += 3;

  const winner = Object.entries(scores)
    .filter(([, s]) => s > 0)
    .sort(([, a], [, b]) => b - a)[0];

  const result = (winner ? winner[0] : TaskType.GENERAL) as TaskType;
  console.log(`[Classifier] "${message.substring(0, 50)}..." -> ${result} (scores: ${JSON.stringify(scores)})`);
  return result;
}
