export declare enum TaskType {
    GENERAL = "general",// งานทักทาย ถามตอบทั่วไป
    COMPLEX = "complex",// งานวิเคราะห์ลึก เขียนโค้ด
    VISION = "vision",// งานวิเคราะห์ภาพ
    WEB_BROWSER = "web",// งานค้นหาข้อมูล เปิดเว็บ
    THINKING = "thinking",// งานที่ต้องคิดเป็นขั้นตอนสูง
    CODE = "code",// งานเขียนโค้ดโดยเฉพาะ
    DATA = "data",// งานวิเคราะห์ข้อมูล
    SYSTEM = "system"
}
export interface ModelConfig {
    provider: string;
    modelName: string;
}
export interface MultiModelConfig {
    active: ModelConfig;
    fallbacks?: ModelConfig[];
}
/**
 * Default model routing — สามารถ override ผ่าน Dashboard ได้
 */
export declare const modelRouting: Record<TaskType, MultiModelConfig>;
export interface ModelPerformanceEntry {
    model: string;
    provider: string;
    taskType: string;
    successRate: number;
    avgDurationMs: number;
    totalRuns: number;
    score: number;
}
/**
 * ดึง model performance stats จาก usage_tracking (24h window)
 * คำนวณ composite score = successRate × 40 + speed × 30 + volume × 30
 */
export declare function getModelPerformance(taskType?: string): ModelPerformanceEntry[];
/**
 * หา model ที่ดีที่สุดสำหรับ task type ที่ระบุ (จาก historical performance)
 * Return null ถ้ายังไม่มีข้อมูลเพียงพอ (ใช้ default routing แทน)
 */
export declare function getBestModelForTask(taskType: string): ModelConfig | null;
/** Invalidate performance cache (เรียกตอน self-reflection update config) */
export declare function invalidatePerformanceCache(): void;
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
 * Smart task classification with keyword scoring + confidence + caching + input-size awareness
 */
export declare function classifyTask(message: string, hasAttachments: boolean): TaskClassification;
