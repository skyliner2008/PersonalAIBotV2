import { describe, expect, it } from 'vitest';
import {
  extractJarvisSwarmObjective,
  looksLikeJarvisSwarmRequest,
  resolveJarvisSwarmRequest,
} from '../../terminal/jarvisSwarmIntent.js';

describe('jarvisSwarmIntent', () => {
  it('detects natural-language delegation prompts for Jarvis team leadership', () => {
    const prompt = [
      'คุณ สวมบทบาท เป็นหัวหน้า ซึ่งมีลูกน้องในทีม 3 คน ได้แก่ Gemini CLI ,Codex CLI ,Claude CLI',
      'ซึ่งคุณต้องกระจายงานต่างๆ ให้ลูกน้องคุณทำ โดยต้องตรวจสอบสิ่งที่มอบหมายไป และติดตามงาน และทำสรุปผลการทำงาน',
      'หัวข้อของงานครั้งนี้คือ "วิเคราะห์ทิศทางเศรษฐกิจประเทศไทย ที่ได้รับผลกระทบจากสงคราม ไทย กัมพูชา"',
    ].join(' ');

    expect(looksLikeJarvisSwarmRequest(prompt)).toBe(true);

    const resolved = resolveJarvisSwarmRequest(prompt);
    expect(resolved).toEqual({
      kind: 'natural_language_objective',
      text: 'วิเคราะห์ทิศทางเศรษฐกิจประเทศไทย ที่ได้รับผลกระทบจากสงคราม ไทย กัมพูชา',
      originalText: prompt,
    });
  });

  it('extracts an explicit topic from English supervisor instructions', () => {
    const prompt = 'Act as the team lead for Gemini CLI, Codex CLI, and Claude CLI. Delegate, review, and summarize. Topic: "Analyze Thailand economic direction under Thailand-Cambodia war pressure"';

    expect(extractJarvisSwarmObjective(prompt)).toBe(
      'Analyze Thailand economic direction under Thailand-Cambodia war pressure',
    );
  });

  it('does not upgrade ordinary Jarvis chat into swarm mode', () => {
    const prompt = 'ช่วยสรุปข่าวเศรษฐกิจไทยวันนี้ให้หน่อย';

    expect(looksLikeJarvisSwarmRequest(prompt)).toBe(false);
    expect(resolveJarvisSwarmRequest(prompt)).toBeNull();
  });

  it('preserves explicit swarm commands', () => {
    const prompt = '/swarm status latest';
    expect(resolveJarvisSwarmRequest(prompt)).toEqual({
      kind: 'explicit_command',
      text: '/swarm status latest',
      originalText: '/swarm status latest',
    });
  });
});
