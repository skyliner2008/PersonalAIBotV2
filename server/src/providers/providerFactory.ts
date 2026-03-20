/**
 * Provider Factory - Dynamic provider instantiation
 */

import { createLogger } from '../utils/logger.js';
import {
  getProvider,
  getEnabledProviders,
  getProvidersByCategory,
  type ProviderCategory,
} from './registry.js';
import { KeyManager } from './keyManager.js';
import { GeminiProvider } from '../bot_agents/providers/geminiProvider.js';
import { OpenAICompatibleProvider } from '../bot_agents/providers/openaiCompatibleProvider.js';
import { AnthropicProvider } from '../bot_agents/providers/anthropicProvider.js';

const log = createLogger('ProviderFactory');

export class ProviderFactory {
  /**
   * Create a provider instance based on registry definition
   */
  static async createProvider(
    providerId: string,
    apiKey?: string
  ): Promise<any | null> {
    try {
      const provider = getProvider(providerId);
      if (!provider) {
        log.warn('Provider not found', { providerId });
        return null;
      }

      if (!provider.enabled) {
        return null;
      }

      let key: string | undefined;
      if (apiKey) {
        key = apiKey;
      } else {
        const dbKey = await KeyManager.getKey(providerId);
        if (!dbKey) {
          log.warn('No API key for provider', { providerId });
          return null;
        }
        key = dbKey;
      }

      // Create instance based on provider type
      switch (provider.type) {
        case 'gemini':
          return new GeminiProvider(key, {
            providerId: provider.id,
            includeEmbeddingsInList: provider.category === 'embedding',
          });

        case 'openai-compatible':
          return new OpenAICompatibleProvider(key, provider.baseUrl, providerId);

        case 'anthropic':
          return new AnthropicProvider(key, provider.baseUrl);

        case 'rest-api':
          log.warn('Rest API not implemented', { providerId });
          return null;

        case 'platform':
          return null;

        default:
          log.warn('Unknown provider type', {
            providerId,
            type: provider.type,
          });
          return null;
      }
    } catch (error) {
      log.error('Failed to create provider', { providerId, error: String(error) });
      return null;
    }
  }

  /**
   * Get all configured LLM providers
   */
  static async getConfiguredLLMs(): Promise<any[]> {
    const providers = getProvidersByCategory('llm');
    const instances: any[] = [];

    for (const provider of providers) {
      const instance = await this.createProvider(provider.id);
      if (instance) {
        instances.push({ id: provider.id, instance });
      }
    }

    return instances;
  }

  /**
   * Get all configured providers by category
   */
  static async getConfiguredProviders(
    category: ProviderCategory
  ): Promise<any[]> {
    const providers = getProvidersByCategory(category);
    const instances: any[] = [];

    for (const provider of providers) {
      const instance = await this.createProvider(provider.id);
      if (instance) {
        instances.push({ id: provider.id, instance });
      }
    }

    return instances;
  }

  /**
   * Get primary provider for category with fallback support
   */
  static async getPrimaryProvider(category: ProviderCategory): Promise<any | null> {
    const enabledProviders = getEnabledProviders(category);
    if (enabledProviders.length === 0) {
      log.warn('No enabled providers', { category });
      return null;
    }

    for (const provider of enabledProviders) {
      const instance = await this.createProvider(provider.id);
      if (instance) {
        log.info('Primary provider', {
          category,
          provider: provider.id,
        });
        return { id: provider.id, instance };
      }
    }

    log.error('No valid provider', { category });
    return null;
  }

  /**
   * Get fallback provider chain for a category
   */
  static async getProviderChain(
    category: ProviderCategory
  ): Promise<Array<{ id: string; instance: any }>> {
    const enabledProviders = getEnabledProviders(category);
    const chain: Array<{ id: string; instance: any }> = [];

    for (const provider of enabledProviders) {
      const instance = await this.createProvider(provider.id);
      if (instance) {
        chain.push({ id: provider.id, instance });
      }
    }

    if (chain.length === 0) {
      log.warn('No providers in chain', { category });
    }

    return chain;
  }

  /**
   * Initialize all available providers
   */
  static async initializeAll(): Promise<void> {
    try {
      await KeyManager.importEnvKeys();

      const categories = ['llm', 'embedding', 'search', 'tts', 'image'] as const;
      for (const category of categories) {
        const providers = getEnabledProviders(category as ProviderCategory);
        log.info(`✓ ${category}`, {
          count: providers.length,
          providers: providers.map((p) => p.name),
        });
      }
    } catch (error) {
      log.error('Failed to initialize providers', { error: String(error) });
    }
  }
}

export default ProviderFactory;
