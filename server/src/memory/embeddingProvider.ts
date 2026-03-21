// ============================================================
// Embedding Provider - centralized embedding generation with caching and batching
// ============================================================
// Supports Gemini embedding model chain (primary + fallback) for safer upgrades.

import { GoogleGenAI } from '@google/genai';
import { createLogger } from '../utils/logger.js';

const log = createLogger('EmbeddingProvider');

// ============================================================
// Configuration
// ============================================================

const DEFAULT_PRIMARY_EMBEDDING_MODEL = 'gemini-embedding-001';
const DEFAULT_FALLBACK_MODELS = ['gemini-embedding-001', 'gemini-embedding-002'];
const CACHE_MAX_ENTRIES = 200;
const BATCH_SIZE = 10;
const BATCH_TIMEOUT_MS = 500;

function parseModelList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.map((model) => model.trim()).filter(Boolean)));
}

function resolveEmbeddingModelChain(): string[] {
  const explicitChain = parseModelList(process.env.GEMINI_EMBEDDING_MODELS);
  if (explicitChain.length > 0) {
    return uniqueModels(explicitChain);
  }

  const primaryModel =
    process.env.GEMINI_EMBEDDING_MODEL ||
    process.env.EMBEDDING_MODEL ||
    DEFAULT_PRIMARY_EMBEDDING_MODEL;

  const fallbackModels = parseModelList(process.env.GEMINI_EMBEDDING_FALLBACK_MODELS);
  const effectiveFallbacks = fallbackModels.length > 0 ? fallbackModels : DEFAULT_FALLBACK_MODELS;

  return uniqueModels([primaryModel, ...effectiveFallbacks]);
}

function toErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > 300 ? `${raw.substring(0, 300)}...` : raw;
}

// ============================================================
// LRU Cache Implementation
// ============================================================

interface CacheEntry {
  embedding: number[];
}

class LRUCache {
  private cache: Map<string, CacheEntry> = new Map();
  private maxSize: number;
  private accessOrder: string[] = [];

  constructor(maxSize: number = CACHE_MAX_ENTRIES) {
    this.maxSize = maxSize;
  }

  get(key: string): number[] | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const idx = this.accessOrder.indexOf(key);
    if (idx >= 0) {
      this.accessOrder.splice(idx, 1);
    }
    this.accessOrder.push(key);

    return entry.embedding;
  }

  set(key: string, embedding: number[]): void {
    if (this.cache.has(key)) {
      const idx = this.accessOrder.indexOf(key);
      if (idx >= 0) {
        this.accessOrder.splice(idx, 1);
      }
    }

    this.cache.set(key, { embedding });
    this.accessOrder.push(key);

    if (this.cache.size > this.maxSize) {
      const lruKey = this.accessOrder.shift();
      if (lruKey) {
        this.cache.delete(lruKey);
      }
    }
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
  }

  getStats(): { size: number; maxSize: number } {
    return { size: this.cache.size, maxSize: this.maxSize };
  }
}

// ============================================================
// Batch Queue
// ============================================================

interface BatchRequest {
  text: string;
  resolve: (embedding: number[]) => void;
  reject: (err: Error) => void;
}

export interface EmbeddingProviderStats {
  cacheSize: number;
  maxCacheSize: number;
  queuedRequests: number;
  configuredModels: string[];
  activeModel: string;
  failoverCount: number;
  modelErrors: Record<string, number>;
}

// ============================================================
// EmbeddingProvider Class
// ============================================================

export class EmbeddingProvider {
  private cache: LRUCache;
  private batchQueue: BatchRequest[] = [];
  private batchTimeout: NodeJS.Timeout | null = null;
  private processing = false;
  private modelChain: string[];
  private activeModel: string;
  private failoverCount = 0;
  private modelErrorCount: Record<string, number> = {};

  constructor(_apiKey: string, models?: string[]) {
    this.cache = new LRUCache(CACHE_MAX_ENTRIES);
    const mergedModels = uniqueModels([...(models || []), ...resolveEmbeddingModelChain()]);
    this.modelChain = mergedModels.length > 0 ? mergedModels : [DEFAULT_PRIMARY_EMBEDDING_MODEL];
    this.activeModel = this.modelChain[0];

    log.info('EmbeddingProvider initialized', {
      configuredModels: this.modelChain,
      activeModel: this.activeModel,
    });
  }

  async embed(text: string): Promise<number[]> {
    if (!text || text.trim().length === 0) {
      return [];
    }

    const cacheKey = this.hashText(text);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      log.debug('Cache hit for embedding');
      return cached;
    }

    return this.queueEmbedding(text);
  }

  async embedBatch(texts: string[]): Promise<(number[] | null)[]> {
    const validTexts = texts.filter((text) => text && text.trim().length > 0);
    if (validTexts.length === 0) {
      return texts.map(() => null);
    }

    try {
      const { embeddings } = await this.embedContentsWithFallback(validTexts);

      validTexts.forEach((text, idx) => {
        const embedding = embeddings[idx];
        if (embedding && embedding.length > 0) {
          const cacheKey = this.hashText(text);
          this.cache.set(cacheKey, embedding);
        }
      });

      const output: (number[] | null)[] = [];
      let validIdx = 0;
      for (const text of texts) {
        if (text && text.trim().length > 0) {
          output.push(embeddings[validIdx] || null);
          validIdx += 1;
        } else {
          output.push(null);
        }
      }

      return output;
    } catch (err) {
      log.error('Batch embedding failed', {
        error: toErrorMessage(err),
        count: validTexts.length,
      });
      return texts.map(() => null);
    }
  }

  private queueEmbedding(text: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
      this.batchQueue.push({ text, resolve, reject });

      if (this.batchQueue.length >= BATCH_SIZE) {
        this.processBatch();
      } else if (!this.batchTimeout) {
        this.batchTimeout = setTimeout(() => this.processBatch(), BATCH_TIMEOUT_MS);
      }
    });
  }

  private async processBatch(): Promise<void> {
    if (this.processing || this.batchQueue.length === 0) return;

    this.processing = true;
    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }

    const currentBatch = this.batchQueue.splice(0, BATCH_SIZE);

    try {
      const texts = currentBatch.map((request) => request.text);
      const { embeddings } = await this.embedContentsWithFallback(texts);

      currentBatch.forEach((request, idx) => {
        const embedding = embeddings[idx] || [];
        const cacheKey = this.hashText(request.text);
        this.cache.set(cacheKey, embedding);
        request.resolve(embedding);
      });

      if (this.batchQueue.length > 0) {
        setImmediate(() => this.processBatch());
      }
    } catch (err) {
      currentBatch.forEach((request) => {
        request.reject(err as Error);
      });
      log.error('Batch processing failed', { error: toErrorMessage(err) });
    } finally {
      this.processing = false;
    }
  }

  private getModelCandidates(): string[] {
    return uniqueModels([this.activeModel, ...this.modelChain]);
  }

  private async embedContentsWithFallback(texts: string[]): Promise<{ embeddings: number[][]; model: string }> {
    const candidates = this.getModelCandidates();
    let lastError: unknown = null;

    const { getProviderApiKey } = await import('../config/settingsSecurity.js');
    const ai = new GoogleGenAI({ apiKey: getProviderApiKey('gemini') || '' });

    for (const model of candidates) {
      try {
        const result = await ai.models.embedContent({
          model,
          contents: texts.map((text) => ({
            role: 'user',
            parts: [{ text }],
          })),
        });

        const embeddings = result.embeddings?.map((item) => item.values || []) || [];
        if (embeddings.length < texts.length || embeddings.some((vec) => vec.length === 0)) {
          throw new Error(`Model returned incomplete embeddings: ${model}`);
        }

        if (this.activeModel !== model) {
          this.failoverCount += 1;
          log.warn('Embedding model switched after fallback', {
            from: this.activeModel,
            to: model,
            failoverCount: this.failoverCount,
          });
          this.activeModel = model;
        }

        return { embeddings, model };
      } catch (err) {
        lastError = err;
        this.modelErrorCount[model] = (this.modelErrorCount[model] || 0) + 1;
        log.warn('Embedding model failed, trying next fallback', {
          model,
          failures: this.modelErrorCount[model],
          error: toErrorMessage(err),
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error('All embedding models failed');
  }

  private hashText(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `emb_${Math.abs(hash)}`;
  }

  clearCache(): void {
    this.cache.clear();
    log.info('Embedding cache cleared');
  }

  getStats(): EmbeddingProviderStats {
    const cacheStats = this.cache.getStats();
    return {
      cacheSize: cacheStats.size,
      maxCacheSize: cacheStats.maxSize,
      queuedRequests: this.batchQueue.length,
      configuredModels: [...this.modelChain],
      activeModel: this.activeModel,
      failoverCount: this.failoverCount,
      modelErrors: { ...this.modelErrorCount },
    };
  }
}

// ============================================================
// Global Instance & Convenience Functions
// ============================================================

let globalProvider: EmbeddingProvider | null = null;

export function initEmbeddingProvider(apiKey: string, preferredModels?: string[]): EmbeddingProvider {
  globalProvider = new EmbeddingProvider(apiKey, preferredModels);
  return globalProvider;
}

export function getEmbeddingProvider(): EmbeddingProvider {
  if (!globalProvider) {
    throw new Error('EmbeddingProvider not initialized. Call initEmbeddingProvider() first.');
  }
  return globalProvider;
}

export async function embedText(text: string): Promise<number[]> {
  try {
    const provider = getEmbeddingProvider();
    return await provider.embed(text);
  } catch (err) {
    log.error('Embedding failed', { error: toErrorMessage(err) });
    return [];
  }
}

export async function embedTexts(texts: string[]): Promise<(number[] | null)[]> {
  try {
    const provider = getEmbeddingProvider();
    return await provider.embedBatch(texts);
  } catch (err) {
    log.error('Batch embedding failed', { error: toErrorMessage(err) });
    return texts.map(() => null);
  }
}

export function getEmbeddingStats(): EmbeddingProviderStats {
  try {
    const provider = getEmbeddingProvider();
    return provider.getStats();
  } catch {
    const modelChain = resolveEmbeddingModelChain();
    return {
      cacheSize: 0,
      maxCacheSize: CACHE_MAX_ENTRIES,
      queuedRequests: 0,
      configuredModels: modelChain,
      activeModel: modelChain[0] || DEFAULT_PRIMARY_EMBEDDING_MODEL,
      failoverCount: 0,
      modelErrors: {},
    };
  }
}
