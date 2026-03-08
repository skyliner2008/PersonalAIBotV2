import type { AIMessage } from '../types.js';

export function buildContentPrompt(
  topic: string,
  style: string = 'engaging',
  language: string = 'th',
  extraInstructions?: string
): AIMessage[] {
  const langMap: Record<string, string> = {
    th: 'ภาษาไทย',
    en: 'English',
  };

  return [
    {
      role: 'system',
      content: `คุณเป็นนักเขียน content สำหรับ Facebook ที่เชี่ยวชาญ
- เขียนเป็น ${langMap[language] || 'ภาษาไทย'}
- สไตล์: ${style}
- เขียนให้น่าสนใจ มี engagement สูง
- ใส่ emoji ตามความเหมาะสม
- ใส่ hashtag ที่เกี่ยวข้อง 3-5 อัน ท้ายโพส
- ความยาว: 100-300 คำ (ไม่สั้นเกินไป ไม่ยาวเกินไป)
- ห้ามใส่คำว่า "AI" หรือ "ChatGPT" หรือ "ฉันเป็น AI" ในเนื้อหา
${extraInstructions ? `\nคำแนะนำเพิ่มเติม: ${extraInstructions}` : ''}

ตอบกลับเฉพาะเนื้อหาโพสเท่านั้น ไม่ต้องมีคำอธิบายอื่น`,
    },
    {
      role: 'user',
      content: `สร้าง Facebook post เกี่ยวกับ: ${topic}`,
    },
  ];
}

export function buildCommentReplyPrompt(
  postContent: string,
  commentText: string,
  commenterName: string,
  replyStyle: string = 'friendly'
): AIMessage[] {
  return [
    {
      role: 'system',
      content: `คุณเป็นแอดมินเพจ Facebook กำลังตอบ comment
- สไตล์: ${replyStyle}
- ตอบสั้นกระชับ 1-2 ประโยค
- เรียกชื่อผู้ comment ได้ถ้าเหมาะสม
- ใส่ emoji ได้ตามธรรมชาติ
- ห้ามพูดว่าเป็น AI
- ถ้า comment เป็น spam ให้ตอบสุภาพหรือ skip`,
    },
    {
      role: 'user',
      content: `[โพส]: ${postContent}\n[Comment จาก ${commenterName}]: ${commentText}\n\nตอบ comment นี้:`,
    },
  ];
}
