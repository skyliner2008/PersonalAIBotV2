import type { Content } from '@google/genai';
import type { JarvisPlannerOptions } from './jarvisPlanner.js';
import type { SpecialistRuntimeHealth } from './swarmCoordinator.js';
import { ProviderFactory } from '../providers/providerFactory.js';
import { getEnabledProviders } from '../providers/registry.js';

const JARVIS_ENABLE_ENGLISH_HANDOFF = process.env.JARVIS_ENABLE_ENGLISH_HANDOFF === '1';

export function containsNonAsciiText(value: string): boolean {
  return /[^\x00-\x7F]/.test(value);
}

export async function buildEnglishObjectiveHandoff(objective: string): Promise<string | undefined> {
  if (!containsNonAsciiText(objective)) return undefined;

  const providers = getEnabledProviders('llm');
  for (const provider of providers) {
    if (!provider.defaultModel) continue;

    try {
      const instance = await ProviderFactory.createProvider(provider.id);
      if (!instance || typeof instance.generateResponse !== 'function') continue;

      const contents: Content[] = [
        {
          role: 'user',
          parts: [
            {
              text: [
                'Restate this user objective in concise English for delegation to external specialist CLIs.',
                'Preserve meaning and scope exactly.',
                'Do not add assumptions, instructions, or explanations.',
                'Return one sentence only.',
                '',
                `Objective: ${objective}`,
              ].join('\n'),
            },
          ],
        },
      ];

      const response = await instance.generateResponse(
        provider.defaultModel,
        'You translate or restate user objectives into concise English handoff text.',
        contents,
      );

      const text = String(response?.text || '').trim().replace(/\s+/g, ' ');
      if (text) {
        return text;
      }
    } catch {
      // Try the next configured LLM provider.
    }
  }

  return undefined;
}

export async function buildRuntimeJarvisPlannerOptions(
  objective: string,
  runtimeHealth: SpecialistRuntimeHealth[],
  multipass?: boolean,
): Promise<JarvisPlannerOptions> {
  const englishObjective = JARVIS_ENABLE_ENGLISH_HANDOFF
    ? await buildEnglishObjectiveHandoff(objective)
    : undefined;
  const health: JarvisPlannerOptions['health'] = Object.fromEntries(
    runtimeHealth.map((item) => [
      item.specialist,
      {
        state: item.state,
        consecutiveFailures: item.consecutiveFailures,
        lastError: item.lastError,
        lastFailureAt: item.lastFailureAt,
      },
    ]),
  ) as JarvisPlannerOptions['health'];

  return {
    multipass,
    health,
    englishObjective,
  };
}
