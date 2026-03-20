import type { TaskType } from './taskQueue.js';
import type { JarvisDelegationTask } from './swarmCoordinator.js';
import { getRootAdminSpecialistName } from '../system/rootAdmin.js';

type ObjectiveMode = 'research' | 'engineering' | 'operations' | 'general';
type WorkIntent =
  | 'fact_gathering'
  | 'structured_analysis'
  | 'risk_review'
  | 'execution_blueprint'
  | 'quality_gate'
  | 'scenario_mapping';

type CliSpecialistName = 'gemini-cli-agent' | 'codex-cli-agent' | 'claude-cli-agent';
const JARVIS_TERMINAL_DIRECT_MODE = process.env.JARVIS_TERMINAL_DIRECT_MODE !== '0';

export interface JarvisSpecialistHealthSignal {
  state?: 'healthy' | 'degraded' | 'unavailable' | 'idle';
  consecutiveFailures?: number;
  lastError?: string;
  lastFailureAt?: string;
}

export interface JarvisPlannerOptions {
  multipass?: boolean;
  health?: Partial<Record<CliSpecialistName, JarvisSpecialistHealthSignal>>;
  englishObjective?: string;
}

interface CliSpecialistProfile {
  specialist: CliSpecialistName;
  displayName: string;
  primaryCapabilities: TaskType[];
  secondaryCapabilities: TaskType[];
  intentStrength: Record<WorkIntent, number>;
  modeBias: Record<ObjectiveMode, number>;
  summaryFocus: string;
}

interface WorkPackage {
  id: string;
  title: string;
  intent: WorkIntent;
  taskType: TaskType;
  priority: number;
  instructions: string[];
  whyThisMatters: string;
}

interface AssignedPackage extends WorkPackage {
  specialist: CliSpecialistName;
  rationale: string;
}

interface ObjectiveSignals {
  requiresExternalEvidence: boolean;
  requiresScenarioAnalysis: boolean;
  requiresImplementationPlan: boolean;
  requiresRiskReview: boolean;
  requiresDecisionBrief: boolean;
  requiresTranslation: boolean;
  mentionsUrgency: boolean;
  mentionsConflict: boolean;
  simpleLookupIntent: boolean;
  complexityScore: number;
}

interface ExplicitLaneDirective {
  specialist: CliSpecialistName;
  objective: string;
  taskType: TaskType;
  title: string;
  workIntent: WorkIntent;
}

function isMultipassEnabled(explicit?: boolean): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return process.env.JARVIS_MULTIPASS === '1';
}

const CLI_PROFILES: CliSpecialistProfile[] = [
  {
    specialist: 'gemini-cli-agent',
    displayName: 'Gemini CLI',
    primaryCapabilities: ['web_search', 'translation', 'summarization', 'data_analysis'],
    secondaryCapabilities: ['general'],
    intentStrength: {
      fact_gathering: 5,
      structured_analysis: 3,
      risk_review: 3,
      execution_blueprint: 2,
      quality_gate: 2,
      scenario_mapping: 4,
    },
    modeBias: {
      research: 4,
      engineering: 1,
      operations: 2,
      general: 2,
    },
    summaryFocus: 'external evidence, recency confidence, and signal validation',
  },
  {
    specialist: 'codex-cli-agent',
    displayName: 'Codex CLI',
    primaryCapabilities: ['code_generation', 'data_analysis', 'summarization'],
    secondaryCapabilities: ['code_review', 'general'],
    intentStrength: {
      fact_gathering: 2,
      structured_analysis: 5,
      risk_review: 3,
      execution_blueprint: 5,
      quality_gate: 3,
      scenario_mapping: 4,
    },
    modeBias: {
      research: 2,
      engineering: 5,
      operations: 3,
      general: 3,
    },
    summaryFocus: 'decomposition, execution structure, and measurable decision criteria',
  },
  {
    specialist: 'claude-cli-agent',
    displayName: 'Claude CLI',
    primaryCapabilities: ['code_review', 'data_analysis', 'summarization'],
    secondaryCapabilities: ['translation', 'general'],
    intentStrength: {
      fact_gathering: 2,
      structured_analysis: 4,
      risk_review: 5,
      execution_blueprint: 3,
      quality_gate: 5,
      scenario_mapping: 4,
    },
    modeBias: {
      research: 2,
      engineering: 3,
      operations: 4,
      general: 3,
    },
    summaryFocus: 'risk control, edge-cases, failure modes, and challenge analysis',
  },
];

export const JARVIS_SPECIALIST_SKILL_MAP: Record<CliSpecialistName, {
  bestFor: string[];
  primaryCapabilities: TaskType[];
  summaryFocus: string;
}> = {
  'gemini-cli-agent': {
    bestFor: ['fact gathering', 'research', 'external context collection'],
    primaryCapabilities: ['web_search', 'translation', 'summarization', 'data_analysis'],
    summaryFocus: 'evidence and recency-aware context',
  },
  'codex-cli-agent': {
    bestFor: ['structured analysis', 'implementation planning', 'technical breakdown'],
    primaryCapabilities: ['code_generation', 'data_analysis', 'summarization'],
    summaryFocus: 'execution path and structure',
  },
  'claude-cli-agent': {
    bestFor: ['risk review', 'quality gate', 'critical challenge'],
    primaryCapabilities: ['code_review', 'data_analysis', 'summarization'],
    summaryFocus: 'risks, gaps, and safeguards',
  },
};

function containsThaiScript(value: string): boolean {
  return /[\u0E00-\u0E7F]/.test(value);
}

function containsNonAscii(value: string): boolean {
  return /[^\x00-\x7F]/.test(value);
}

function detectObjectiveMode(objective: string): ObjectiveMode {
  const text = objective.toLowerCase();
  const hasThaiScript = containsThaiScript(objective);

  const engineeringHints = [
    'code', 'coding', 'bug', 'refactor', 'api', 'backend', 'frontend', 'deploy',
    'test', 'fix', 'debug', 'typescript', 'node', 'react', 'python', 'java',
  ];
  if (engineeringHints.some((hint) => text.includes(hint))) return 'engineering';

  const researchHints = [
    'analyze', 'analysis', 'market', 'trend', 'research', 'study', 'report',
    'forecast', 'sector', 'sentiment', 'macro', 'geopolitical', 'economy',
    'war', 'impact', 'signal',
  ];
  if (researchHints.some((hint) => text.includes(hint))) return 'research';

  const opsHints = [
    'workflow', 'pipeline', 'automation', 'process', 'ops', 'runbook',
    'monitoring', 'incident', 'reliability', 'operations',
  ];
  if (opsHints.some((hint) => text.includes(hint))) return 'operations';

  if (hasThaiScript) return 'research';

  return 'general';
}

function defaultTaskTypeForIntent(intent: WorkIntent, mode: ObjectiveMode): TaskType {
  if (intent === 'fact_gathering') return 'web_search';
  if (intent === 'structured_analysis') return mode === 'engineering' ? 'code_generation' : 'data_analysis';
  if (intent === 'risk_review') return mode === 'engineering' ? 'code_review' : 'data_analysis';
  if (intent === 'execution_blueprint') return mode === 'engineering' ? 'code_generation' : 'summarization';
  if (intent === 'scenario_mapping') return 'data_analysis';
  return mode === 'engineering' ? 'code_review' : 'summarization';
}

function capabilityFitScore(profile: CliSpecialistProfile, taskType: TaskType): number {
  if (profile.primaryCapabilities.includes(taskType)) return 3;
  if (profile.secondaryCapabilities.includes(taskType)) return 1;
  return 0;
}

function healthPenalty(
  specialist: CliSpecialistName,
  health: JarvisPlannerOptions['health'],
): number {
  const signal = health?.[specialist];
  if (!signal) return 0;

  const failurePenalty = Math.max(0, signal.consecutiveFailures || 0) * 4;
  if (signal.state === 'unavailable') return 40 + failurePenalty;
  if (signal.state === 'degraded') return 10 + failurePenalty;
  if (signal.state === 'healthy') return -2;
  return failurePenalty;
}

function specialistScore(
  profile: CliSpecialistProfile,
  workIntent: WorkIntent,
  taskType: TaskType,
  mode: ObjectiveMode,
  usageCount: number,
  health: JarvisPlannerOptions['health'],
): number {
  const intentScore = profile.intentStrength[workIntent] * 4;
  const modeScore = profile.modeBias[mode] * 2;
  const capabilityScore = capabilityFitScore(profile, taskType) * 3;
  const loadPenalty = usageCount * 2.5;
  const runtimePenalty = healthPenalty(profile.specialist, health);
  return intentScore + modeScore + capabilityScore - loadPenalty - runtimePenalty;
}

function chooseSpecialist(
  workIntent: WorkIntent,
  taskType: TaskType,
  mode: ObjectiveMode,
  usage: Record<CliSpecialistName, number>,
  avoid: Set<CliSpecialistName>,
  health: JarvisPlannerOptions['health'],
): CliSpecialistProfile {
  const ranked = [...CLI_PROFILES].sort((a, b) => {
    const scoreB = specialistScore(b, workIntent, taskType, mode, usage[b.specialist], health);
    const scoreA = specialistScore(a, workIntent, taskType, mode, usage[a.specialist], health);
    return scoreB - scoreA;
  });

  const healthyUniquePick = ranked.find((profile) => {
    if (avoid.has(profile.specialist)) return false;
    return health?.[profile.specialist]?.state !== 'unavailable';
  });
  if (healthyUniquePick) return healthyUniquePick;

  const healthyReusePick = ranked.find((profile) => health?.[profile.specialist]?.state !== 'unavailable');
  if (healthyReusePick) return healthyReusePick;

  const uniquePick = ranked.find((profile) => !avoid.has(profile.specialist));
  return uniquePick || ranked[0];
}

function buildObjectiveSignals(objective: string, mode: ObjectiveMode): ObjectiveSignals {
  const text = objective.toLowerCase();
  const hasThaiScript = containsThaiScript(objective);
  const tokenCount = objective.trim().split(/\s+/).filter(Boolean).length;
  const hasAny = (hints: string[]) => hints.some((hint) => text.includes(hint));

  const externalHints = [
    'latest', 'recent', 'today', 'news', 'market', 'economy', 'sector', 'signal',
    'web', 'compare', 'benchmark', 'war', 'conflict', 'geopolitical', 'trend',
    'thailand', 'thai', 'cambodia', 'price', 'rate', 'quote',
  ];
  const riskHints = [
    'risk', 'risks', 'uncertainty', 'blind spot', 'challenge', 'failure', 'edge case',
    'downside', 'threat', 'stress', 'crisis', 'war', 'impact',
  ];
  const scenarioHints = [
    'scenario', 'outlook', 'forecast', 'impact', 'if', 'sensitivity',
    'direction', 'trajectory', 'what happens',
  ];
  const planHints = [
    'plan', 'roadmap', 'implement', 'execution', 'execute', 'build', 'fix', 'design',
    'steps', 'migration', 'rollout', 'decision',
  ];
  const decisionHints = [
    'recommend', 'recommendation', 'decide', 'decision', 'prioritize', 'choose', 'best option',
  ];
  const translationHints = ['translate', 'translation', 'localized', 'localization', 'thai to english', 'english to thai'];
  const urgencyHints = ['urgent', 'immediate', 'now', 'today', 'asap'];
  const conflictHints = ['war', 'conflict', 'sanction', 'border', 'military', 'geopolitical'];
  const simpleLookupHints = [
    'price', 'today', 'current', 'latest', 'rate', 'quote', 'how much', 'what is',
    'ราค', 'วันนี้', 'ตอนนี้', 'เท่าไหร่', 'อัตรา',
  ];
  const deepAnalysisHints = [
    'analyze', 'analysis', 'scenario', 'forecast', 'impact', 'strategy', 'roadmap', 'plan',
    'วิเคราะห์', 'สถานการณ์', 'แนวโน้ม', 'แผน', 'ความเสี่ยง',
  ];
  const likelyLongformAnalysis = hasThaiScript && mode !== 'engineering' && mode !== 'operations';
  const simpleLookupIntent = hasAny(simpleLookupHints)
    && !hasAny(deepAnalysisHints)
    && !hasAny(planHints)
    && !hasAny(riskHints)
    && !hasAny(scenarioHints)
    && tokenCount <= 18;

  const requiresExternalEvidence = mode === 'research' || hasAny(externalHints) || likelyLongformAnalysis;
  const requiresScenarioAnalysis = hasAny(scenarioHints) || hasAny(conflictHints) || likelyLongformAnalysis;
  const requiresImplementationPlan = mode === 'engineering' || mode === 'operations' || hasAny(planHints);
  const requiresRiskReview = hasAny(riskHints) || mode !== 'research';
  const requiresDecisionBrief = hasAny(decisionHints) || mode === 'operations';
  const requiresTranslation = hasAny(translationHints);
  const mentionsUrgency = hasAny(urgencyHints);
  const mentionsConflict = hasAny(conflictHints);

  let complexityScore = 1;
  if (requiresExternalEvidence) complexityScore += 1;
  if (requiresScenarioAnalysis) complexityScore += 1;
  if (requiresImplementationPlan) complexityScore += 1;
  if (requiresRiskReview) complexityScore += 1;
  if (requiresDecisionBrief) complexityScore += 1;
  if (mentionsConflict) complexityScore += 1;
  if (tokenCount >= 30) complexityScore += 1;
  if (simpleLookupIntent) complexityScore = 0;

  return {
    requiresExternalEvidence,
    requiresScenarioAnalysis,
    requiresImplementationPlan,
    requiresRiskReview,
    requiresDecisionBrief,
    requiresTranslation,
    mentionsUrgency,
    mentionsConflict,
    simpleLookupIntent,
    complexityScore,
  };
}

function createWorkPackages(
  objective: string,
  mode: ObjectiveMode,
  signals: ObjectiveSignals,
): WorkPackage[] {
  const rawMaxLanes = Number.parseInt(String(process.env.JARVIS_MAX_STAGE_A_LANES || ''), 10);
  const maxLanes = Number.isFinite(rawMaxLanes) && rawMaxLanes > 0
    ? Math.min(6, Math.max(1, rawMaxLanes))
    : 5;
  const packages: WorkPackage[] = [];
  const laneBudget = signals.simpleLookupIntent
    ? 1
    : signals.complexityScore >= 6
      ? Math.min(maxLanes, 5)
      : signals.complexityScore >= 4
        ? Math.min(maxLanes, 4)
        : Math.min(maxLanes, 2);

  if (signals.simpleLookupIntent) {
    packages.push({
      id: 'A1',
      title: 'A1 - Fast fact lookup',
      intent: 'fact_gathering',
      taskType: defaultTaskTypeForIntent('fact_gathering', mode),
      priority: 10,
      whyThisMatters: 'This request is a direct lookup and should return fast without unnecessary lane splitting.',
      instructions: [
        `Objective: ${objective}`,
        'Return the direct answer first, then provide short supporting evidence points.',
        'Include timestamp/recency note and uncertainty only if data freshness is limited.',
      ],
    });
  }

  if (!signals.simpleLookupIntent && signals.requiresExternalEvidence) {
    packages.push({
      id: 'A1',
      title: signals.mentionsConflict ? 'A1 - Evidence and market signal scan' : 'A1 - Evidence gathering',
      intent: 'fact_gathering',
      taskType: defaultTaskTypeForIntent('fact_gathering', mode),
      priority: signals.mentionsUrgency ? 10 : 9,
      whyThisMatters: 'Jarvis needs a grounded fact base before weighting downstream arguments.',
      instructions: [
        `Objective: ${objective}`,
        'Collect only external facts, recent signals, and objective context that materially change the answer.',
        'Separate confirmed evidence from inference. Note recency and uncertainty for each bullet.',
      ],
    });
  }

  if (!signals.simpleLookupIntent && signals.requiresScenarioAnalysis) {
    packages.push({
      id: 'A2',
      title: signals.mentionsConflict ? 'A2 - Scenario and impact analysis' : 'A2 - Scenario mapping',
      intent: 'scenario_mapping',
      taskType: defaultTaskTypeForIntent('scenario_mapping', mode),
      priority: 8,
      whyThisMatters: 'Jarvis should compare plausible paths instead of forcing one static answer.',
      instructions: [
        `Objective: ${objective}`,
        'Build a scenario map with major drivers, causal links, and 2-3 plausible paths forward.',
        'Show what would make the base case change. Keep sections modular and decision-oriented.',
      ],
    });
  }

  const needsStructuredAnalysis = !signals.simpleLookupIntent && (
    mode === 'engineering'
    || mode === 'operations'
    || signals.requiresImplementationPlan
    || signals.requiresDecisionBrief
    || signals.requiresScenarioAnalysis
    || !signals.requiresExternalEvidence
  );
  if (needsStructuredAnalysis) {
    packages.push({
      id: packages.length === 0 ? 'A1' : `A${packages.length + 1}`,
      title: mode === 'engineering'
        ? 'A - System diagnosis and solution path'
        : signals.requiresDecisionBrief
          ? 'A - Structured decision analysis'
          : 'A - Structured analysis',
      intent: signals.requiresImplementationPlan ? 'execution_blueprint' : 'structured_analysis',
      taskType: defaultTaskTypeForIntent(
        signals.requiresImplementationPlan ? 'execution_blueprint' : 'structured_analysis',
        mode,
      ),
      priority: signals.requiresImplementationPlan ? 10 : 8,
      whyThisMatters: 'Jarvis needs a clear decomposition of the work before deciding next delegation steps.',
      instructions: [
        `Objective: ${objective}`,
        mode === 'engineering'
          ? 'Diagnose the problem, define assumptions, and propose the most credible implementation path.'
          : 'Build a structured analysis path with assumptions, decomposition, and decision criteria.',
        'Do not output one giant block. Use concise modular sections that Jarvis can reuse.',
      ],
    });
  }

  if (!signals.simpleLookupIntent && (signals.requiresRiskReview || signals.complexityScore >= 4)) {
    packages.push({
      id: `A${packages.length + 1}`,
      title: 'A - Risk and challenge review',
      intent: 'risk_review',
      taskType: defaultTaskTypeForIntent('risk_review', mode),
      priority: 8,
      whyThisMatters: 'Jarvis should know where the current plan can fail, not just what sounds plausible.',
      instructions: [
        `Objective: ${objective}`,
        'Stress-test assumptions and identify high-impact risks, blind spots, and edge cases.',
        'Return a concise table with: risk, impact, likelihood, mitigation, and trigger signal.',
      ],
    });
  }

  if (!signals.simpleLookupIntent && signals.complexityScore >= 5) {
    packages.push({
      id: `A${packages.length + 1}`,
      title: 'A - Quality coherence check',
      intent: 'quality_gate',
      taskType: 'summarization',
      priority: 6,
      whyThisMatters: 'Jarvis must detect contradictions before producing the final answer.',
      instructions: [
        `Objective: ${objective}`,
        'Cross-check likely conflicts between evidence, scenario assumptions, and risk claims.',
        'Return only contradiction candidates, missing links, and what should be verified first.',
      ],
    });
  }

  if (!signals.simpleLookupIntent && signals.requiresTranslation) {
    packages.push({
      id: `A${packages.length + 1}`,
      title: 'A - Translation and terminology check',
      intent: 'quality_gate',
      taskType: 'translation',
      priority: 5,
      whyThisMatters: 'The answer needs language fidelity before synthesis.',
      instructions: [
        `Objective: ${objective}`,
        'Flag terminology that may be ambiguous across languages and provide precise translation guidance.',
      ],
    });
  }

  return packages
    .sort((a, b) => b.priority - a.priority)
    .slice(0, laneBudget)
    .map((pkg, index) => ({
      ...pkg,
      id: `A${index + 1}`,
      title: pkg.title.replace(/^A\d?/, `A${index + 1}`),
    }));
}

function rationaleFor(
  profile: CliSpecialistProfile,
  workPackage: WorkPackage,
  mode: ObjectiveMode,
  health: JarvisPlannerOptions['health'],
): string {
  const capabilityLabel = profile.primaryCapabilities.includes(workPackage.taskType) ? 'primary' : 'secondary';
  const healthSignal = health?.[profile.specialist];
  const healthNote = healthSignal?.state === 'degraded'
    ? ` Runtime note: this lane is currently degraded, so keep output concise and high-signal.`
    : '';

  return [
    `Assigned to ${profile.displayName} for ${workPackage.intent.replace(/_/g, ' ')}.`,
    `Reason: ${workPackage.taskType} is in ${capabilityLabel} capability set and mode bias is ${mode}.`,
    `Focus area: ${profile.summaryFocus}.`,
    `Why now: ${workPackage.whyThisMatters}.${healthNote}`,
  ].join(' ');
}

function buildModeRules(mode: ObjectiveMode): string[] {
  if (mode === 'engineering') {
    return [
      'Optimize for correctness, implementation clarity, and verifiable output.',
      'Prefer concrete steps, checks, and rollback-safe decisions.',
    ];
  }
  if (mode === 'research') {
    return [
      'Optimize for evidence quality, recency, and confidence notes.',
      'Separate confirmed facts from inference.',
      'This is not a software engineering task. Ignore the current repository, files, tests, and implementation details.',
    ];
  }
  if (mode === 'operations') {
    return [
      'Optimize for sequencing, reliability, and operational safety.',
      'Keep the answer execution-ready and easy to hand off.',
    ];
  }
  return [
    'Optimize for practical actions, decision points, and clear next steps.',
  ];
}

function buildDirectTerminalDelegationMessage(
  assignment: AssignedPackage,
  objective: string,
): string {
  const taskLines = assignment.instructions.filter((line) => !/^Objective:/i.test(line));

  const roleHint = assignment.specialist === 'gemini-cli-agent'
    ? 'ค้นหาข้อมูลเชิงข้อเท็จจริงจากแหล่งอ้างอิงที่เชื่อถือได้'
    : assignment.specialist === 'codex-cli-agent'
      ? 'วิเคราะห์เชิงโครงสร้างและแผนตัดสินใจแบบเป็นขั้นตอน'
      : 'รีวิวความเสี่ยง ช่องโหว่ และสิ่งที่อาจผิดพลาด';

  return [
    `${assignment.title}`,
    `Objective: ${objective}`,
    `Role: ${roleHint}`,
    ...taskLines.map((line) => `- ${line}`),
    'Output now as final result. Do not ask follow-up questions.',
  ].join('\n');
}

function buildDelegationMessage(
  assignment: AssignedPackage,
  objective: string,
  mode: ObjectiveMode,
  health: JarvisPlannerOptions['health'],
  options?: {
    requestEnglishHandoff?: boolean;
    omitRawObjective?: boolean;
  },
): string {
  if (JARVIS_TERMINAL_DIRECT_MODE) {
    return buildDirectTerminalDelegationMessage(assignment, objective);
  }

  const profile = CLI_PROFILES.find((item) => item.specialist === assignment.specialist);
  const modeRules = buildModeRules(mode);
  const taskLines = assignment.instructions.filter((line) => !/^Objective:/i.test(line));
  const healthSignal = health?.[assignment.specialist];
  const healthNote = healthSignal?.state === 'degraded'
    ? ['Runtime note:', '- Your lane is degraded right now, so keep the output concise and high-signal.']
    : [];

  const objectiveLines = options?.omitRawObjective
    ? [
        ...(containsNonAscii(objective) ? [] : [`Objective: ${objective}`]),
        'Source note:',
        '- The original user request may contain non-English text.',
        '- Use the deliverable below plus any dependency context as the authoritative task brief.',
        '- Start from the available dependency context and complete the work directly.',
        '- Do not ask the user to resend the prompt because of encoding issues.',
      ]
    : [`Objective: ${objective}`];
  const englishHandoffRule = options?.requestEnglishHandoff
    ? [
        '- End with an "English handoff" section containing 2-4 concise English bullets for cross-lane sharing.',
      ]
    : [];

  if (assignment.specialist === 'codex-cli-agent') {
    const codexTopic = options?.omitRawObjective
      ? (containsNonAscii(objective) ? 'Use dependency context below as the source of truth.' : objective)
      : objective;
    return [
      `Topic: ${codexTopic}`,
      `Task: ${assignment.title}`,
      `Focus: ${profile?.summaryFocus || 'Build the strongest structured answer for this task.'}`,
      'Do this now:',
      ...taskLines.map((line) => `- ${line}`),
      'Output rules:',
      '- Return the finished analysis directly.',
      '- Use short modular sections with headings or bullets.',
      '- Include assumptions, key drivers, and what would change the base case.',
      '- Do not ask for more context, do not return a readiness update, and do not ask the user to resend the prompt.',
      ...modeRules.map((line) => `- ${line}`),
      ...healthNote,
    ].join('\n');
  }

  return [
    `Task brief for ${profile?.displayName || assignment.specialist}:`,
    `Lane: ${assignment.intent.replace(/_/g, ' ')}`,
    ...objectiveLines,
    `Focus: ${profile?.summaryFocus || 'Deliver the strongest answer for this slice of work.'}`,
    `Why this matters: ${assignment.whyThisMatters}`,
    'Deliverable:',
    ...taskLines.map((line) => `- ${line}`),
    'Working rules:',
    ...modeRules.map((line) => `- ${line}`),
    ...englishHandoffRule,
    ...healthNote,
  ].join('\n');
}

function buildFollowUpMessage(
  objective: string,
  mode: ObjectiveMode,
  assignment: AssignedPackage,
): string {
  const profile = CLI_PROFILES.find((item) => item.specialist === assignment.specialist);
  const modeRules = buildModeRules(mode);
  const followUpGoal = assignment.intent === 'risk_review'
    ? 'Condense your earlier review into a red-team brief with only the critical risks, trigger signals, and mitigations.'
    : 'Turn your earlier output into an execution-ready brief with explicit steps, checkpoints, and decision thresholds.';

  return [
    `Follow-up brief for ${profile?.displayName || assignment.specialist}:`,
    `Lane: ${assignment.intent.replace(/_/g, ' ')}`,
    `Objective: ${objective}`,
    'Follow-up goal:',
    `- ${followUpGoal}`,
    'Working rules:',
    ...modeRules.map((line) => `- ${line}`),
  ].join('\n');
}

function buildFinalSynthesisMessage(objective: string, mode: ObjectiveMode): string {
  const modeRules = buildModeRules(mode);
  return [
    'Team lead brief for Jarvis:',
    `Objective: ${objective}`,
    'Task:',
    '- Review delegated outputs, challenge weak work, account for missing lanes, and produce the final decision-ready synthesis.',
    'Required sections:',
    '- Recommendation',
    '- Rationale',
    '- Execution plan',
    '- Assumptions',
    '- Missing evidence',
    '- Risks',
    'Working rules:',
    ...modeRules.map((line) => `- ${line}`),
    '- If a lane failed or timed out, explicitly say who is missing and continue with the available evidence.',
    '- Do not pretend a missing lane answered.',
  ].join('\n');
}

function buildAssignedStageA(
  objective: string,
  mode: ObjectiveMode,
  signals: ObjectiveSignals,
  health: JarvisPlannerOptions['health'],
): AssignedPackage[] {
  const usage: Record<CliSpecialistName, number> = {
    'gemini-cli-agent': 0,
    'codex-cli-agent': 0,
    'claude-cli-agent': 0,
  };
  const usedInStageA = new Set<CliSpecialistName>();
  const assigned: AssignedPackage[] = [];

  for (const pkg of createWorkPackages(objective, mode, signals)) {
    const profile = chooseSpecialist(pkg.intent, pkg.taskType, mode, usage, usedInStageA, health);
    usage[profile.specialist] += 1;
    usedInStageA.add(profile.specialist);

    assigned.push({
      ...pkg,
      specialist: profile.specialist,
      rationale: rationaleFor(profile, pkg, mode, health),
    });
  }
  return assigned;
}

function minimumCompletedDependencies(count: number): number {
  if (count <= 1) return 1;
  if (count === 2) return 1;
  return Math.max(2, Math.ceil(count * 0.6));
}

function parseExplicitLaneDirective(objective: string): ExplicitLaneDirective | null {
  const trimmed = objective.trim();
  if (!trimmed) return null;

  const candidates: Array<{
    specialist: CliSpecialistName;
    title: string;
    taskType: TaskType;
    workIntent: WorkIntent;
    patterns: RegExp[];
  }> = [
    {
      specialist: 'gemini-cli-agent',
      title: 'Direct - Gemini task',
      taskType: 'web_search',
      workIntent: 'fact_gathering',
      patterns: [
        /^@?gemini(?:\s*cli)?\s*[:\-]?\s+(.+)$/i,
      ],
    },
    {
      specialist: 'codex-cli-agent',
      title: 'Direct - Codex task',
      taskType: 'data_analysis',
      workIntent: 'structured_analysis',
      patterns: [
        /^@?codex(?:\s*cli)?\s*[:\-]?\s+(.+)$/i,
      ],
    },
    {
      specialist: 'claude-cli-agent',
      title: 'Direct - Claude task',
      taskType: 'data_analysis',
      workIntent: 'risk_review',
      patterns: [
        /^@?claude(?:\s*cli)?\s*[:\-]?\s+(.+)$/i,
      ],
    },
  ];

  for (const candidate of candidates) {
    for (const pattern of candidate.patterns) {
      const match = trimmed.match(pattern);
      if (!match?.[1]) continue;
      const directObjective = match[1].trim();
      if (!directObjective) continue;
      return {
        specialist: candidate.specialist,
        objective: directObjective,
        taskType: candidate.taskType,
        title: candidate.title,
        workIntent: candidate.workIntent,
      };
    }
  }

  return null;
}

export function buildJarvisDelegationPlan(
  objective: string,
  options?: JarvisPlannerOptions,
): JarvisDelegationTask[] {
  const normalizedObjective = objective.trim();
  const explicitLaneDirective = parseExplicitLaneDirective(normalizedObjective);
  if (explicitLaneDirective) {
    const directMessage = [
      explicitLaneDirective.title,
      `Objective: ${explicitLaneDirective.objective}`,
      'Output now as final result. Do not ask follow-up questions.',
    ].join('\n');

    return [
      {
        title: explicitLaneDirective.title,
        specialist: explicitLaneDirective.specialist,
        taskType: explicitLaneDirective.taskType,
        priority: 5,
        maxRetries: 1,
        metadata: {
          batchStage: 'analysis',
          workIntent: explicitLaneDirective.workIntent,
          directLaneDispatch: true,
        },
        message: directMessage,
      },
      {
        title: 'C - Jarvis final synthesis',
        specialist: getRootAdminSpecialistName(),
        taskType: 'summarization',
        dependsOn: [0],
        dependencyMode: 'minimum_completed',
        minCompletedDependencies: 1,
        priority: 5,
        maxRetries: 0,
        metadata: {
          batchStage: 'synthesis',
          workIntent: 'quality_gate',
          allowPartialContext: true,
          directLaneDispatch: true,
        },
        message: buildFinalSynthesisMessage(explicitLaneDirective.objective, detectObjectiveMode(explicitLaneDirective.objective)),
      },
    ];
  }

  const delegationObjective = JARVIS_TERMINAL_DIRECT_MODE
    ? normalizedObjective
    : options?.englishObjective?.trim() || normalizedObjective;
  const mode = detectObjectiveMode(normalizedObjective);
  const enableMultipass = isMultipassEnabled(options?.multipass);
  const signals = buildObjectiveSignals(normalizedObjective, mode);
  const hasThaiObjective = containsThaiScript(normalizedObjective);

  const tasks: JarvisDelegationTask[] = [];
  const stageA = buildAssignedStageA(delegationObjective, mode, signals, options?.health);
  const hasCodexStageA = stageA.some((assignment) => assignment.specialist === 'codex-cli-agent');
  const requireCodexEnglishHandoff = !JARVIS_TERMINAL_DIRECT_MODE && hasThaiObjective && hasCodexStageA;
  const orderedStageA = requireCodexEnglishHandoff
    ? [...stageA].sort((a, b) => {
        const aCodex = a.specialist === 'codex-cli-agent' ? 1 : 0;
        const bCodex = b.specialist === 'codex-cli-agent' ? 1 : 0;
        return aCodex - bCodex;
      })
    : stageA;

  const stageATaskIndexes: number[] = [];
  const nonCodexStageIndexes: number[] = [];
  for (const assignment of orderedStageA) {
    const codexNeedsDependencyContext =
      requireCodexEnglishHandoff &&
      assignment.specialist === 'codex-cli-agent' &&
      nonCodexStageIndexes.length > 0;

    stageATaskIndexes.push(tasks.length);
    tasks.push({
      title: assignment.title,
      specialist: assignment.specialist,
      taskType: assignment.taskType,
      dependsOn: codexNeedsDependencyContext ? [...nonCodexStageIndexes] : undefined,
      dependencyMode: codexNeedsDependencyContext ? 'minimum_completed' : undefined,
      minCompletedDependencies: codexNeedsDependencyContext ? 1 : undefined,
      priority: 4,
      maxRetries: 1,
      metadata: {
        batchStage: 'analysis',
        workIntent: assignment.intent,
        omitRawBatchObjective: codexNeedsDependencyContext || undefined,
      },
      message: buildDelegationMessage(assignment, delegationObjective, mode, options?.health, {
        requestEnglishHandoff: requireCodexEnglishHandoff && assignment.specialist !== 'codex-cli-agent',
        omitRawObjective: codexNeedsDependencyContext,
      }),
    });

    if (assignment.specialist !== 'codex-cli-agent') {
      nonCodexStageIndexes.push(tasks.length - 1);
    }
  }

  const stageBIndexes: number[] = [];
  if (enableMultipass) {
    for (let i = 0; i < orderedStageA.length; i++) {
      const assignment = orderedStageA[i];
      const profile = CLI_PROFILES.find((item) => item.specialist === assignment.specialist);
      stageBIndexes.push(tasks.length);
      tasks.push({
        title: `B${i + 1} - ${profile?.displayName || assignment.specialist} follow-up`,
        specialist: assignment.specialist,
        taskType: assignment.intent === 'risk_review' ? 'summarization' : defaultTaskTypeForIntent('execution_blueprint', mode),
        dependsOn: [stageATaskIndexes[i]],
        priority: 3,
        maxRetries: 1,
        metadata: {
          batchStage: 'followup',
          workIntent: assignment.intent,
        },
        message: buildFollowUpMessage(delegationObjective, mode, assignment),
      });
    }
  }

  const finalDependencyIndexes = stageBIndexes.length > 0 ? stageBIndexes : stageATaskIndexes;
  tasks.push({
    title: 'C - Jarvis final synthesis',
    specialist: getRootAdminSpecialistName(),
    taskType: 'summarization',
    dependsOn: finalDependencyIndexes,
    dependencyMode: 'minimum_completed',
    minCompletedDependencies: minimumCompletedDependencies(finalDependencyIndexes.length),
    priority: 5,
    maxRetries: 0,
    metadata: {
      batchStage: 'synthesis',
      workIntent: 'quality_gate',
      allowPartialContext: true,
    },
    message: buildFinalSynthesisMessage(normalizedObjective, mode),
  });

  return tasks;
}
