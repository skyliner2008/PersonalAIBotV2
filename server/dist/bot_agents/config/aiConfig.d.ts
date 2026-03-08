export declare enum TaskType {
    GENERAL = "general",// งานทักทาย ถามตอบทั่วไป
    COMPLEX = "complex",// งานวิเคราะห์ลึกซึ้ง
    VISION = "vision",// งานวิเคราะห์ภาพ
    WEB_BROWSER = "web",// งานคุมเว็บ
    THINKING = "thinking"
}
export interface ModelConfig {
    provider: 'gemini' | 'openai' | 'minimax';
    modelName: string;
}
/**
 * 🛠️ การตั้งค่าการกระจาย Token และเลือกใช้โมเดลตามความเหมาะสม
 * คุณสามารถเปลี่ยนเจ้าของ Provider และชื่อโมเดลได้ที่นี่
 */
export declare const modelRouting: Record<TaskType, ModelConfig>;
/**
 * วิเคราะห์คำสั่งเพื่อเลือกประเภทงาน
 */
export declare function classifyTask(message: string, hasAttachments: boolean): TaskType;
