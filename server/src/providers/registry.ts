/**
 * Provider Registry - Type definitions and configuration loader
 * Centralized provider configuration
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '../utils/logger.js';

const log = createLogger('ProviderRegistry');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Type Definitions
export interface ProviderCapabilities {
  chat?: boolean;
  streaming?: boolean;
  functionCalling?: boolean;
  vision?: boolean;
  embedding?: boolean;
  search?: boolean;
  imageGeneration?: boolean;
  textToSpeech?: boolean;
  messaging?: boolean;
  fileUpload?: boolean;
}

export type ProviderType =
  | 'gemini'
  | 'openai-compatible'
  | 'anthropic'
  | 'rest-api'
  | 'platform';

export type ProviderCategory =
  | 'llm'
  | 'embedding'
  | 'search'
  | 'tts'
  | 'image'
  | 'platform';

export interface ProviderDefinition {
  id: string;
  name: string;
  category: ProviderCategory;
  type: ProviderType;
  baseUrl?: string;
  defaultModel?: string;
  models?: string[];
  capabilities: ProviderCapabilities;
  requiresAuth: boolean;
  apiKeyEnvVar: string;
  secretKeyEnvVar?: string;
  enabled: boolean;
  // Custom/advanced fields for non-standard providers
  customHeaders?: Record<string, string>;
  extraConfig?: Record<string, string>;
  endpointTemplate?: string; // e.g. "{baseUrl}/text/chatcompletion_v2?GroupId={groupId}"
  notes?: string;
}

export interface ProviderRegistry {
  version: string;
  lastUpdated: string;
  description: string;
  providers: Record<string, ProviderDefinition>;
  fallbackOrder: Record<string, string[]>;
  categories: ProviderCategory[];
}

// Registry Loader Class
class RegistryLoader {
  private registry: ProviderRegistry | null = null;
  private configPath: string;

  constructor() {
    this.configPath = path.join(__dirname, '../../provider-registry.json');
  }

  loadRegistry(): ProviderRegistry {
    if (this.registry) return this.registry;

    try {
      if (!fs.existsSync(this.configPath)) {
        throw new Error(`Registry not found: ${this.configPath}`);
      }
      const rawData = fs.readFileSync(this.configPath, 'utf-8');
      let parsed: unknown;
      try { parsed = JSON.parse(rawData); } catch (e) {
        throw new Error(`Invalid JSON in provider registry: ${(e as Error).message}`);
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Provider registry must be a JSON object');
      }
      this.registry = parsed as ProviderRegistry;
      log.info('✓ Provider registry loaded', {
        providerCount: Object.keys(this.registry.providers).length,
      });
      return this.registry;
    } catch (error) {
      log.error('Failed to load provider registry', { error: String(error) });
      throw error;
    }
  }

  getRegistry(): ProviderRegistry {
    return this.loadRegistry();
  }

  getProvider(providerId: string): ProviderDefinition | undefined {
    const registry = this.getRegistry();
    return registry.providers[providerId];
  }

  getProvidersByCategory(category: ProviderCategory): ProviderDefinition[] {
    const registry = this.getRegistry();
    return Object.values(registry.providers).filter((p) => p.category === category);
  }

  getEnabledProviders(category?: ProviderCategory): ProviderDefinition[] {
    const registry = this.getRegistry();
    return Object.values(registry.providers).filter(
      (p) => p.enabled && (!category || p.category === category)
    );
  }

  getFallbackOrder(category: ProviderCategory): string[] {
    const registry = this.getRegistry();
    return registry.fallbackOrder[category] || [];
  }

  addProvider(provider: ProviderDefinition): void {
    const registry = this.getRegistry();
    registry.providers[provider.id] = provider;
    this.saveRegistry();
    log.info('Provider added', { id: provider.id });
  }

  updateProvider(providerId: string, updates: Partial<ProviderDefinition>): boolean {
    const registry = this.getRegistry();
    const existing = registry.providers[providerId];
    if (!existing) return false;
    registry.providers[providerId] = { ...existing, ...updates, id: providerId };
    this.saveRegistry();
    log.info('Provider updated', { id: providerId });
    return true;
  }

  removeProvider(providerId: string): boolean {
    const registry = this.getRegistry();
    if (!registry.providers[providerId]) return false;
    delete registry.providers[providerId];
    this.saveRegistry();
    log.info('Provider removed', { id: providerId });
    return true;
  }

  toggleProvider(providerId: string, enabled?: boolean): boolean {
    const registry = this.getRegistry();
    const provider = registry.providers[providerId];
    if (!provider) return false;
    provider.enabled = enabled !== undefined ? enabled : !provider.enabled;
    this.saveRegistry();
    log.info('Provider toggled', { id: providerId, enabled: provider.enabled });
    return true;
  }

  private saveRegistry(): void {
    try {
      const registry = this.getRegistry();
      registry.lastUpdated = new Date().toISOString().split('T')[0];
      fs.writeFileSync(this.configPath, JSON.stringify(registry, null, 2), 'utf-8');
    } catch (error) {
      log.error('Failed to save registry', { error: String(error) });
    }
  }
}

let registryLoader: RegistryLoader | null = null;

export function initRegistry(): ProviderRegistry {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.getRegistry();
}

export function getRegistry(): ProviderRegistry {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.getRegistry();
}

export function getProvider(providerId: string): ProviderDefinition | undefined {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.getProvider(providerId);
}

export function getProvidersByCategory(category: ProviderCategory): ProviderDefinition[] {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.getProvidersByCategory(category);
}

export function getEnabledProviders(category?: ProviderCategory): ProviderDefinition[] {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.getEnabledProviders(category);
}

export function getFallbackOrder(category: ProviderCategory): string[] {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.getFallbackOrder(category);
}

export function addProvider(provider: ProviderDefinition): void {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  registryLoader.addProvider(provider);
}

export function updateProvider(providerId: string, updates: Partial<ProviderDefinition>): boolean {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.updateProvider(providerId, updates);
}

export function removeProvider(providerId: string): boolean {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.removeProvider(providerId);
}

export function toggleProvider(providerId: string, enabled?: boolean): boolean {
  if (!registryLoader) {
    registryLoader = new RegistryLoader();
  }
  return registryLoader.toggleProvider(providerId, enabled);
}
