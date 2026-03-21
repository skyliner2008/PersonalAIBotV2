import {
  getEnabledProviders,
  getProvider,
  getProvidersByCategory,
  type ProviderDefinition,
  type ProviderType,
} from './registry.js';
import { getProviderApiKey } from '../config/settingsSecurity.js';
import { GeminiProvider } from '../bot_agents/providers/geminiProvider.js';
import { OpenAICompatibleProvider } from '../bot_agents/providers/openaiCompatibleProvider.js';
import { AnthropicProvider } from '../bot_agents/providers/anthropicProvider.js';
import type { AIProvider as AgentRuntimeProvider } from '../bot_agents/providers/baseProvider.js';
import { CLIProvider } from '../bot_agents/providers/cliProvider.js';
import { refreshOAuthToken } from './oauthDetector.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AgentRuntime');

const SUPPORTED_AGENT_PROVIDER_TYPES = new Set<ProviderType>([
  'gemini',
  'openai-compatible',
  'anthropic',
]);

/** Provider IDs that use Vertex AI mode (OAuth Bearer token) */
const VERTEX_AI_PROVIDER_IDS = new Set([
  'vertex-ai', 'vertex-ai-sa', 'vertex-ai-adc',
]);

/** Provider IDs that use OAuth tokens which may need refresh */
const OAUTH_PROVIDER_IDS = new Set([
  'vertex-ai', 'vertex-ai-sa', 'vertex-ai-adc',
  'github-models', 'azure-openai', 'aws-bedrock',
]);

export function isAgentCompatibleProviderDef(
  provider: ProviderDefinition | undefined | null
): provider is ProviderDefinition {
  return !!provider
    && provider.category === 'llm'
    && SUPPORTED_AGENT_PROVIDER_TYPES.has(provider.type);
}

export function getAgentCompatibleProviders(options?: { enabledOnly?: boolean }): ProviderDefinition[] {
  const providers = options?.enabledOnly
    ? getEnabledProviders('llm')
    : getProvidersByCategory('llm');
  return providers.filter(isAgentCompatibleProviderDef);
}

export function getAgentCompatibleProvider(providerId: string): ProviderDefinition | null {
  const provider = getProvider(providerId);
  return isAgentCompatibleProviderDef(provider) ? provider : null;
}

export function getAgentCompatibleProviderIds(options?: { enabledOnly?: boolean }): string[] {
  return getAgentCompatibleProviders(options).map((provider) => provider.id);
}

export function hasAgentProviderCredentials(providerId: string): boolean {
  return !!getProviderApiKey(providerId);
}

export function getAgentProviderDefaultModel(providerId: string): string {
  const provider = getAgentCompatibleProvider(providerId);
  if (!provider) return '';
  return provider.defaultModel || provider.models?.find(Boolean) || '';
}

export function createAgentRuntimeProvider(
  providerId: string,
  apiKey?: string
): AgentRuntimeProvider | null {
  const provider = getAgentCompatibleProvider(providerId);
  if (!provider) {
    return null;
  }

  let resolvedKey = apiKey || getProviderApiKey(providerId);

  // For OAuth providers, try refreshing token if not available or might be expired
  if (!resolvedKey && OAUTH_PROVIDER_IDS.has(providerId)) {
    try {
      const refreshed = refreshOAuthToken(providerId);
      if (refreshed?.valid && refreshed.accessToken) {
        resolvedKey = refreshed.accessToken;
        log.info(`OAuth token refreshed for ${providerId}`);
      }
    } catch (err) {
      log.debug(`OAuth refresh skipped for ${providerId}`, { error: String(err) });
    }
  }

  // For providers that don't need auth (like CLI tools), inject a dummy key
  if (!resolvedKey && !provider.requiresAuth) {
    resolvedKey = 'sk-no-key-required';
  }

  if (!resolvedKey) {
    return null;
  }

  // Vertex AI providers use Gemini SDK in vertexai mode
  if (VERTEX_AI_PROVIDER_IDS.has(providerId)) {
    // Extract project and location from baseUrl or notes
    const urlMatch = provider.baseUrl?.match(/projects\/([^/]+)\/locations\/([^/]+)/);
    const project = urlMatch?.[1] || '';
    const location = urlMatch?.[2] || 'us-central1';
    return new GeminiProvider(resolvedKey, {
      providerId: provider.id,
      vertexai: true,
      project,
      location,
    });
  }

  // Intercept CLI tool providers before routing to REST handlers
  if (providerId.endsWith('-cli')) {
      const toolName = providerId.replace('-cli', '');
      return new CLIProvider(toolName, providerId) as any;
  }

  switch (provider.type) {
    case 'gemini':
      return new GeminiProvider(resolvedKey, { providerId: provider.id });
    case 'openai-compatible':
      return new OpenAICompatibleProvider(resolvedKey, provider.baseUrl, provider.id);
    case 'anthropic':
      return new AnthropicProvider(resolvedKey, provider.baseUrl);
    default:
      return null;
  }
}
