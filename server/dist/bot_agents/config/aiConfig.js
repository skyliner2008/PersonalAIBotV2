export var TaskType;
(function (TaskType) {
    TaskType["GENERAL"] = "general";
    TaskType["COMPLEX"] = "complex";
    TaskType["VISION"] = "vision";
    TaskType["WEB_BROWSER"] = "web";
    TaskType["THINKING"] = "thinking"; // งานที่ต้องคิดเป็นขั้นตอนสูง
})(TaskType || (TaskType = {}));
/**
 * 🛠️ การตั้งค่าการกระจาย Token และเลือกใช้โมเดลตามความเหมาะสม
 * คุณสามารถเปลี่ยนเจ้าของ Provider และชื่อโมเดลได้ที่นี่
 */
export const modelRouting = {
    // งานทั่วไป: ใช้ Gemini 2.0 Flash (ฉลาดพอ, เร็ว, ฟรี)
    [TaskType.GENERAL]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
    // งานซับซ้อน: ใช้ Gemini 2.5 Flash (ฉลาดมาก, มี thinking built-in)
    [TaskType.COMPLEX]: { provider: 'gemini', modelName: 'gemini-2.5-flash' },
    // งานภาพ: Gemini 2.0 Flash ทำได้ดีมาก
    [TaskType.VISION]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
    // งานคุมเว็บ: ใช้ Gemini เพราะรองรับ Function Calling ที่แม่นยำ
    [TaskType.WEB_BROWSER]: { provider: 'gemini', modelName: 'gemini-2.0-flash' },
    // งานใช้ความคิด: ใช้ Gemini 2.5 Flash (thinking mode)
    [TaskType.THINKING]: { provider: 'gemini', modelName: 'gemini-2.5-flash' }
};
/**
 * วิเคราะห์คำสั่งเพื่อเลือกประเภทงาน
 */
export function classifyTask(message, hasAttachments) {
    if (hasAttachments)
        return TaskType.VISION;
    const msg = message.toLowerCase();
    // Thinking tasks: require step-by-step reasoning
    const thinkingKeywords = ['คิด', 'วิเคราะห์', 'ให้เหตุผล', 'เปรียบเทียบ', 'สรุปให้', 'analyze', 'reason', 'think step', 'compare', 'pros and cons'];
    if (thinkingKeywords.some(k => msg.includes(k)))
        return TaskType.THINKING;
    // Web tasks: anything that needs current/real-time information
    const webKeywords = [
        // Thai - search & browse
        'เปิดเว็บ', 'เข้าเว็บ', 'ค้นหา', 'หาข้อมูล', 'search', 'google',
        // Thai - prices & current info
        'ราคา', 'วันนี้', 'ล่าสุด', 'อัพเดท', 'อัปเดต', 'ตอนนี้',
        // Thai - news & weather
        'ข่าว', 'สภาพอากาศ', 'พยากรณ์', 'ผลบอล', 'หุ้น', 'คริปโต', 'bitcoin',
        // Thai - lookup
        'เช็ค', 'ตรวจสอบ', 'ดู', 'บอก', 'แนะนำร้าน', 'รีวิว',
        // English
        'browse', 'open url', 'navigate', 'website',
        'price', 'today', 'latest', 'current', 'news', 'weather',
        'how much', 'what is the', 'who is', 'when is',
    ];
    if (webKeywords.some(k => msg.includes(k)))
        return TaskType.WEB_BROWSER;
    // Complex tasks: long messages, coding, or technical work
    const complexKeywords = ['เขียนโปรแกรม', 'โค้ด', 'แก้บัค', 'อธิบายละเอียด', 'ออกแบบ', 'code', 'program', 'debug', 'implement', 'refactor', 'algorithm'];
    if (message.length > 300 || complexKeywords.some(k => msg.includes(k)))
        return TaskType.COMPLEX;
    return TaskType.GENERAL;
}
//# sourceMappingURL=aiConfig.js.map