// ============================================================
// Unit tests for aiConfig.ts — Task Classification
// ============================================================
import { describe, it, expect } from 'vitest';
import { classifyTask, TaskType } from '../bot_agents/config/aiConfig.js';

describe('classifyTask', () => {
    it('returns GENERAL for simple greetings', () => {
        const result = classifyTask('สวัสดี', false);
        expect(result.type).toBe(TaskType.GENERAL);
    });

    it('returns CODE for code-related messages', () => {
        const result = classifyTask('เขียนโค้ด python function', false);
        expect(result.type).toBe(TaskType.CODE);
    });

    it('returns WEB_BROWSER for price queries', () => {
        const result = classifyTask('ราคา bitcoin วันนี้', false);
        expect(result.type).toBe(TaskType.WEB_BROWSER);
    });

    it('returns THINKING for analysis requests', () => {
        const result = classifyTask('วิเคราะห์ข้อดีข้อเสียของ React vs Vue', false);
        expect(result.type).toBe(TaskType.THINKING);
    });

    it('returns VISION when attachments present', () => {
        const result = classifyTask('อธิบายรูปนี้', true);
        expect(result.type).toBe(TaskType.VISION);
        expect(result.confidence).toBe('high');
    });

    it('returns DATA for data analysis requests', () => {
        const result = classifyTask('วิเคราะห์ข้อมูล csv และสร้าง chart', false);
        expect(result.type).toBe(TaskType.DATA);
    });

    it('gives COMPLEX bonus for very long messages', () => {
        const longMsg = 'a'.repeat(600);
        const result = classifyTask(longMsg, false);
        // Long messages get +3 bonus to COMPLEX score
        expect(result.topScore).toBeGreaterThanOrEqual(3);
    });

    // Confidence scoring tests
    it('returns high confidence when clear match', () => {
        const result = classifyTask('เขียนโค้ด python function implement class', false);
        expect(result.confidence).toBe('high');
        expect(result.topScore).toBeGreaterThan(result.secondScore + 2);
    });

    it('returns low confidence for generic messages', () => {
        const result = classifyTask('ok', false);
        expect(result.confidence).toBe('low');
        expect(result.topScore).toBe(0);
    });

    it('returns classification object with all fields', () => {
        const result = classifyTask('search google for news', false);
        expect(result).toHaveProperty('type');
        expect(result).toHaveProperty('confidence');
        expect(result).toHaveProperty('topScore');
        expect(result).toHaveProperty('secondScore');
    });
});
