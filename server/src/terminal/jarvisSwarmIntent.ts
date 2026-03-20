export interface JarvisSwarmRequest {
  kind: 'explicit_command' | 'natural_language_objective';
  text: string;
  originalText: string;
}

const EXPLICIT_SWARM_COMMAND = /^(\/?swarm|multi-agent|ma)\b/i;

const ROLE_HINTS = [
  'สวมบทบาท',
  'หัวหน้า',
  'หัวหน้าทีม',
  'ผู้จัดการ',
  'leader',
  'team lead',
  'manager',
  'supervisor',
  'boss',
];

const TEAM_HINTS = [
  'ทีม',
  'ลูกน้อง',
  'specialist',
  'specialists',
  'team',
  'crew',
  'agents',
  'subordinate',
  'subordinates',
];

const DELEGATION_HINTS = [
  'มอบหมาย',
  'กระจายงาน',
  'แบ่งงาน',
  'แบ่งหน้าที่',
  'สั่งงาน',
  'assign',
  'delegate',
  'distribute',
  'break down the work',
  'split the work',
];

const SUPERVISION_HINTS = [
  'ตรวจสอบ',
  'ติดตาม',
  'ทวน',
  'ถามเพิ่ม',
  'ให้แก้',
  'ปรับปรุง',
  'review',
  'follow up',
  'follow-up',
  'check their work',
  'challenge',
  'revise',
  'ask follow-up',
];

const SUMMARY_HINTS = [
  'สรุป',
  'รวบรวม',
  'รายงานผล',
  'summary',
  'summarize',
  'final answer',
  'final synthesis',
];

const TOPIC_HINTS = [
  'หัวข้อ',
  'หัวข้อของงาน',
  'หัวข้อของงานครั้งนี้',
  'topic',
  'objective',
  'task',
  'งานครั้งนี้',
  'เรื่องนี้',
  'ประเด็นนี้',
];

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function countMatches(text: string, hints: string[]): number {
  return hints.reduce((count, hint) => count + (text.includes(hint) ? 1 : 0), 0);
}

function countNamedSpecialists(text: string): number {
  const names = [
    { id: 'gemini', patterns: ['gemini cli', 'gemini-cli', 'gemini'] },
    { id: 'codex', patterns: ['codex cli', 'codex-cli', 'codex'] },
    { id: 'claude', patterns: ['claude cli', 'claude-cli', 'claude'] },
  ];

  return names.filter((name) => name.patterns.some((pattern) => text.includes(pattern))).length;
}

export function looksLikeJarvisSwarmRequest(input: string): boolean {
  const text = normalizeWhitespace(input).toLowerCase();
  if (!text) return false;
  if (EXPLICIT_SWARM_COMMAND.test(text)) return true;

  const specialistCount = countNamedSpecialists(text);
  const roleHits = countMatches(text, ROLE_HINTS);
  const teamHits = countMatches(text, TEAM_HINTS);
  const delegationHits = countMatches(text, DELEGATION_HINTS);
  const supervisionHits = countMatches(text, SUPERVISION_HINTS);
  const summaryHits = countMatches(text, SUMMARY_HINTS);

  if (specialistCount >= 2 && delegationHits > 0 && (supervisionHits > 0 || summaryHits > 0)) {
    return true;
  }

  if (specialistCount >= 2 && roleHits > 0 && teamHits > 0) {
    return true;
  }

  if (specialistCount === 3 && (delegationHits > 0 || supervisionHits > 1 || summaryHits > 0)) {
    return true;
  }

  return false;
}

function stripEdgeQuotes(value: string): string {
  return value.replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, '').trim();
}

export function extractJarvisSwarmObjective(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const quotedTopicPatterns = [
    /(?:หัวข้อ(?:ของงาน)?(?:ครั้งนี้)?|topic|objective|task|เรื่อง(?:งาน)?ครั้งนี้)\s*(?:คือ|is|:)\s*[`"'“”‘’]([^`"'“”‘’]{8,400})[`"'“”‘’]/i,
    /(?:หัวข้อ(?:ของงาน)?(?:ครั้งนี้)?|topic|objective|task|เรื่อง(?:งาน)?ครั้งนี้)\s*(?:คือ|is|:)\s*(.+)$/i,
  ];

  for (const pattern of quotedTopicPatterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return stripEdgeQuotes(match[1].split(/\r?\n/)[0] || match[1]);
    }
  }

  const quotedSegments = Array.from(trimmed.matchAll(/[`"'“”‘’]([^`"'“”‘’]{8,400})[`"'“”‘’]/g))
    .map((match) => stripEdgeQuotes(match[1]))
    .filter(Boolean);
  if (quotedSegments.length > 0) {
    const topicAdjacentPattern = new RegExp(`(?:${TOPIC_HINTS.join('|')})`, 'i');
    if (topicAdjacentPattern.test(trimmed)) {
      return quotedSegments[quotedSegments.length - 1];
    }
  }

  const cleaned = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lower = line.toLowerCase();
      return !ROLE_HINTS.some((hint) => lower.includes(hint))
        && !TEAM_HINTS.some((hint) => lower.includes(hint))
        && !DELEGATION_HINTS.some((hint) => lower.includes(hint))
        && !SUPERVISION_HINTS.some((hint) => lower.includes(hint))
        && !SUMMARY_HINTS.some((hint) => lower.includes(hint));
    })
    .join(' ')
    .trim();

  return cleaned || trimmed;
}

export function resolveJarvisSwarmRequest(input: string): JarvisSwarmRequest | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (EXPLICIT_SWARM_COMMAND.test(trimmed)) {
    return {
      kind: 'explicit_command',
      text: trimmed,
      originalText: trimmed,
    };
  }

  if (!looksLikeJarvisSwarmRequest(trimmed)) {
    return null;
  }

  const objective = extractJarvisSwarmObjective(trimmed);
  if (!objective) return null;

  return {
    kind: 'natural_language_objective',
    text: objective,
    originalText: trimmed,
  };
}
