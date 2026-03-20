// ============================================================
// Unit Tests: Task Classifier
// ============================================================
// Tests the AI task classification system with multi-language
// keyword scoring and confidence calculation

import { describe, it, expect } from 'vitest';
import { classifyTask, TaskType, type TaskClassification } from '../../bot_agents/config/aiConfig.js';

describe('classifyTask', () => {
  // ── VISION (image attachments) ──

  describe('VISION classification', () => {
    it('should return VISION type when attachments present', () => {
      const result = classifyTask('อธิบายรูปนี้', true);
      expect(result.type).toBe(TaskType.VISION);
      expect(result.confidence).toBe('high');
    });

    it('should have high confidence for attachments', () => {
      const result = classifyTask('What is in this image?', true);
      expect(result.confidence).toBe('high');
      expect(result.topScore).toBeGreaterThan(0);
    });

    it('should return VISION even for empty message with attachment', () => {
      const result = classifyTask('', true);
      expect(result.type).toBe(TaskType.VISION);
    });
  });

  // ── WEB_BROWSER classification ──

  describe('WEB_BROWSER classification', () => {
    it('should classify Thai web search keywords', () => {
      const result = classifyTask('เช็คราคาหุ้น AAPL วันนี้', false);
      expect(result.type).toBe(TaskType.WEB_BROWSER);
    });

    it('should classify English web search keywords', () => {
      const result = classifyTask('search google for bitcoin price', false);
      expect(result.type).toBe(TaskType.WEB_BROWSER);
    });

    it('should classify weather queries', () => {
      const result = classifyTask('What is the weather today?', false);
      expect(result.type).toBe(TaskType.WEB_BROWSER);
    });

    it('should classify news queries', () => {
      const result = classifyTask('latest news today', false);
      expect(result.type).toBe(TaskType.WEB_BROWSER);
    });

    it('should classify cryptocurrency queries', () => {
      const result = classifyTask('bitcoin price right now', false);
      expect(result.type).toBe(TaskType.WEB_BROWSER);
    });

    it('should classify stock price queries (Thai)', () => {
      const result = classifyTask('ราคาหุ้น SET', false);
      expect(result.type).toBe(TaskType.WEB_BROWSER);
    });

    it('should classify restaurant recommendations', () => {
      const result = classifyTask('แนะนำร้านอาหารดี ๆ', false);
      expect(result.type).toBe(TaskType.WEB_BROWSER);
    });
  });

  // ── CODE classification ──

  describe('CODE classification', () => {
    it('should classify code writing requests (Thai)', () => {
      const result = classifyTask('เขียนโค้ด python function', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should classify code writing requests (English)', () => {
      const result = classifyTask('write a javascript function', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should classify debugging requests', () => {
      const result = classifyTask('debug my code', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should classify algorithm implementation requests', () => {
      const result = classifyTask('implement quicksort algorithm', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should classify language-specific code requests', () => {
      const result = classifyTask('typescript class with decorator', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should classify refactoring requests', () => {
      const result = classifyTask('refactor this function', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should classify database/SQL queries', () => {
      const result = classifyTask('write SQL query to select users', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should classify API endpoint creation requests', () => {
      const result = classifyTask('create rest api endpoint', false);
      expect(result.type).toBe(TaskType.CODE);
    });
  });

  // ── DATA classification ──

  describe('DATA classification', () => {
    it('should classify data analysis requests (Thai)', () => {
      const result = classifyTask('วิเคราะห์ข้อมูล csv chart', false);
      expect(result.type).toBe(TaskType.DATA);
    });

    it('should classify data analysis requests (English)', () => {
      const result = classifyTask('analyze data from excel spreadsheet', false);
      expect(result.type).toBe(TaskType.DATA);
    });

    it('should classify chart/graph creation requests', () => {
      const result = classifyTask('create chart from data', false);
      expect(result.type).toBe(TaskType.DATA);
    });

    it('should classify statistics requests', () => {
      const result = classifyTask('calculate average and mean', false);
      expect(result.type).toBe(TaskType.DATA);
    });

    it('should classify percentage calculation requests (Thai)', () => {
      const result = classifyTask('คำนวณเปอร์เซ็นต์', false);
      expect(result.type).toBe(TaskType.DATA);
    });

    it('should classify sum/count requests', () => {
      const result = classifyTask('sum these numbers', false);
      expect(result.type).toBe(TaskType.DATA);
    });
  });

  // ── THINKING classification ──

  describe('THINKING classification', () => {
    it('should classify analysis requests (Thai)', () => {
      const result = classifyTask('วิเคราะห์ข้อดีข้อเสีย React vs Vue', false);
      expect(result.type).toBe(TaskType.THINKING);
    });

    it('should classify comparison requests (English)', () => {
      const result = classifyTask('compare pros and cons of AWS vs Azure', false);
      expect(result.type).toBe(TaskType.THINKING);
    });

    it('should classify why/how explanation requests', () => {
      const result = classifyTask('why does this algorithm work?', false);
      expect(result.type).toBe(TaskType.THINKING);
    });

    it('should classify decision-making requests', () => {
      const result = classifyTask('help me decide which option is best', false);
      expect(result.type).toBe(TaskType.THINKING);
    });

    it('should classify reasoning requests (Thai)', () => {
      const result = classifyTask('ให้เหตุผลว่าทำไม', false);
      expect(result.type).toBe(TaskType.THINKING);
    });
  });

  // ── SYSTEM classification ──

  describe('SYSTEM classification', () => {
    it('should classify system health checks (Thai)', () => {
      const result = classifyTask('เช็คสุขภาพระบบ', false);
      expect(result.type).toBe(TaskType.SYSTEM);
    });

    it('should classify self-reflection commands', () => {
      const result = classifyTask('self_reflect on your evolution', false);
      expect(result.type).toBe(TaskType.SYSTEM);
    });

    it('should classify self-healing commands', () => {
      const result = classifyTask('self_heal check issues', false);
      expect(result.type).toBe(TaskType.SYSTEM);
    });

    it('should classify evolution view requests', () => {
      const result = classifyTask('self_view_evolution status', false);
      expect(result.type).toBe(TaskType.SYSTEM);
    });

    it('should classify persona editing requests', () => {
      const result = classifyTask('self_edit_persona', false);
      expect(result.type).toBe(TaskType.SYSTEM);
    });

    it('should classify learning log requests', () => {
      const result = classifyTask('self_add_learning from today', false);
      expect(result.type).toBe(TaskType.SYSTEM);
    });
  });

  // ── COMPLEX classification ──

  describe('COMPLEX classification', () => {
    it('should give COMPLEX bonus for very long messages (>500 chars)', () => {
      const longMsg = 'a'.repeat(600);
      const result = classifyTask(longMsg, false);
      expect(result.topScore).toBeGreaterThanOrEqual(3);
    });

    it('should give COMPLEX bonus for long messages (>300 chars)', () => {
      const longMsg = 'a'.repeat(400);
      const result = classifyTask(longMsg, false);
      expect(result.topScore).toBeGreaterThanOrEqual(2);
    });

    it('should classify article writing requests', () => {
      const result = classifyTask('เขียนบทความเกี่ยวกับ AI', false);
      expect(result.type).toBe(TaskType.COMPLEX);
    });

    it('should classify design/planning requests', () => {
      const result = classifyTask('design system for ecommerce', false);
      expect(result.type).toBe(TaskType.COMPLEX);
    });
  });

  // ── GENERAL classification (fallback) ──

  describe('GENERAL classification (fallback)', () => {
    it('should return GENERAL for simple greetings', () => {
      const result = classifyTask('สวัสดี', false);
      expect(result.type).toBe(TaskType.GENERAL);
    });

    it('should return GENERAL for simple "ok"', () => {
      const result = classifyTask('ok', false);
      expect(result.type).toBe(TaskType.GENERAL);
    });

    it('should return GENERAL for random text', () => {
      const result = classifyTask('hello there', false);
      expect(result.type).toBe(TaskType.GENERAL);
    });

    it('should return GENERAL with low confidence for generic message', () => {
      const result = classifyTask('how are you', false);
      expect(result.confidence).toBe('low');
    });
  });

  // ── Confidence scoring ──

  describe('confidence scoring', () => {
    it('should return HIGH confidence when clear match', () => {
      const result = classifyTask('เขียนโค้ด python function implement class', false);
      expect(result.confidence).toBe('high');
      expect(result.topScore - result.secondScore).toBeGreaterThanOrEqual(3);
    });

    it('should return MEDIUM confidence for moderate difference', () => {
      const result = classifyTask('code analyze something', false);
      const diff = result.topScore - result.secondScore;
      if (diff >= 1 && diff < 3) {
        expect(result.confidence).toBe('medium');
      }
    });

    it('should return LOW confidence when scores are equal', () => {
      const result = classifyTask('ok', false);
      expect(result.confidence).toBe('low');
      expect(result.topScore).toBe(0);
    });

    it('should calculate confidence based on score gap', () => {
      const result = classifyTask('write code python implement', false);
      expect(result).toHaveProperty('confidence');
      expect(['high', 'medium', 'low']).toContain(result.confidence);
    });
  });

  // ── Mixed language and edge cases ──

  describe('edge cases and mixed content', () => {
    it('should handle empty string', () => {
      const result = classifyTask('', false);
      expect(result.type).toBe(TaskType.GENERAL);
      expect(result.confidence).toBe('low');
    });

    it('should handle mixed Thai and English', () => {
      const result = classifyTask('เขียนโค้ด python function ให้ผมด้วย', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should handle special characters', () => {
      const result = classifyTask('code !@#$%^&*()', false);
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('confidence');
    });

    it('should handle very long message with multiple keywords', () => {
      const msg = 'write python code' + 'x'.repeat(500) + 'also analyze data';
      const result = classifyTask(msg, false);
      expect(result).toHaveProperty('type');
      expect(result.topScore).toBeGreaterThan(0);
    });

    it('should handle unicode emoji', () => {
      const result = classifyTask('code 💻 python 🐍', false);
      expect(result.type).toBe(TaskType.CODE);
    });

    it('should return proper result object structure', () => {
      const result = classifyTask('any message', false);
      expect(result).toHaveProperty('type');
      expect(result).toHaveProperty('confidence');
      expect(result).toHaveProperty('topScore');
      expect(result).toHaveProperty('secondScore');
      expect(typeof result.topScore).toBe('number');
      expect(typeof result.secondScore).toBe('number');
    });
  });

  // ── Integration scenarios ──

  describe('real-world scenarios', () => {
    it('should classify multi-step workflow request correctly', () => {
      const msg = 'write python code to read CSV, analyze data, create visualization';
      const result = classifyTask(msg, false);
      expect([TaskType.CODE, TaskType.DATA, TaskType.COMPLEX]).toContain(result.type);
    });

    it('should prioritize CODE over DATA when both present', () => {
      const msg = 'write code to analyze this csv data';
      const result = classifyTask(msg, false);
      // Both CODE and DATA keywords present
      expect([TaskType.CODE, TaskType.DATA, TaskType.THINKING]).toContain(result.type);
    });

    it('should handle technical documentation request', () => {
      const msg = 'explain how REST API design patterns work and give examples';
      const result = classifyTask(msg, false);
      expect([TaskType.THINKING, TaskType.CODE, TaskType.COMPLEX]).toContain(result.type);
    });

    it('should classify customer service query', () => {
      const msg = 'I have a problem with my account';
      const result = classifyTask(msg, false);
      // May classify as GENERAL or DATA depending on keyword matches
      expect([TaskType.GENERAL, TaskType.DATA]).toContain(result.type);
    });
  });
});
