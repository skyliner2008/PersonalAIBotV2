// ============================================================
// Vector Store — Embedded vector database for semantic search
// ============================================================
// Uses vectra (file-based vector engine) for fast similarity search
// Stores embeddings alongside SQLite for backup and metadata preservation

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../database/db.js';
import { createLogger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const log = createLogger('VectorStore');

// ============================================================
// Types
// ============================================================

export interface VectorDocument {
  id: string;
  text: string;
  embedding: number[];
  metadata: {
    chatId: string;
    type: 'archival' | 'learning' | 'knowledge';
    source?: string;
    createdAt: string;
  };
}

export interface SearchResult extends VectorDocument {
  score: number;
}

interface VectorIndex {
  documents: Map<string, VectorDocument>;
  vectors: number[][];
  ids: string[];
}

// ============================================================
// Vectra Integration (File-based Vector Database)
// ============================================================

/**
 * Lightweight in-memory vector index with file persistence
 * Provides cosine similarity search without external dependencies
 */
class SimpleVectorIndex {
  private index: VectorIndex;
  private indexPath: string;
  private dirty: boolean = false;

  constructor(dataDir: string) {
    this.indexPath = path.join(dataDir, 'vector-index.json');
    this.index = {
      documents: new Map(),
      vectors: [],
      ids: [],
    };
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    try {
      if (fs.existsSync(this.indexPath)) {
        const data = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        this.index.vectors = data.vectors || [];
        this.index.ids = data.ids || [];
        if (data.documents) {
          for (const doc of data.documents) {
            this.index.documents.set(doc.id, doc);
          }
        }
        log.info(`Loaded vector index: ${this.index.ids.length} vectors`);
      }
    } catch (err) {
      log.warn('Failed to load vector index, starting fresh', { error: String(err) });
      this.index = { documents: new Map(), vectors: [], ids: [] };
    }
  }

  private saveToDisk(): void {
    if (!this.dirty) return;
    try {
      const data = {
        vectors: this.index.vectors,
        ids: this.index.ids,
        documents: Array.from(this.index.documents.values()),
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.indexPath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
      log.debug('Vector index persisted');
    } catch (err) {
      log.error('Failed to persist vector index', { error: String(err) });
    }
  }

  add(doc: VectorDocument): void {
    this.index.documents.set(doc.id, doc);
    this.index.ids.push(doc.id);
    this.index.vectors.push(doc.embedding);
    this.dirty = true;
  }

  delete(id: string): boolean {
    if (!this.index.documents.has(id)) return false;
    this.index.documents.delete(id);
    const idx = this.index.ids.indexOf(id);
    if (idx >= 0) {
      this.index.ids.splice(idx, 1);
      this.index.vectors.splice(idx, 1);
    }
    this.dirty = true;
    return true;
  }

  search(embedding: number[], topK: number): SearchResult[] {
    if (this.index.vectors.length === 0) return [];

    const scores = this.index.vectors
      .map((vec, idx) => ({
        idx,
        id: this.index.ids[idx],
        vec,
      }))
      .filter((item) => item.vec.length === embedding.length && item.vec.length > 0)
      .map((item) => ({
        idx: item.idx,
        id: item.id,
        score: this.cosineSimilarity(embedding, item.vec),
      }));

    if (scores.length === 0) return [];

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(s => {
        const doc = this.index.documents.get(s.id);
        return {
          ...doc!,
          score: s.score,
        };
      });
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  flush(): void {
    this.saveToDisk();
  }

  getStats(): { totalDocuments: number; indexSize: number } {
    return {
      totalDocuments: this.index.ids.length,
      indexSize: JSON.stringify(this.index).length,
    };
  }

  clear(): void {
    this.index = { documents: new Map(), vectors: [], ids: [] };
    this.dirty = true;
  }

  getAllDocuments(): VectorDocument[] {
    return Array.from(this.index.documents.values());
  }
}

// ============================================================
// VectorStore Class — Main API
// ============================================================

export class VectorStore {
  private index: SimpleVectorIndex;
  private dataDir: string;
  private initialized: boolean = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string = path.join(process.cwd(), 'data', 'vectors')) {
    this.dataDir = dataDir;
    this.index = new SimpleVectorIndex(dataDir);
  }

  /** Debounced flush — batches disk writes (5 second delay) */
  private debouncedFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.index.flush();
      this.flushTimer = null;
    }, 5000);
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Ensure data directory exists
      fs.mkdirSync(this.dataDir, { recursive: true });
      this.initialized = true;
      const stats = this.index.getStats();
      log.info('VectorStore initialized', {
        totalDocuments: stats.totalDocuments,
        indexSize: stats.indexSize
      });
    } catch (err) {
      log.error('Failed to initialize VectorStore', { error: String(err) });
      throw err;
    }
  }

  async upsert(doc: VectorDocument): Promise<void> {
    if (!this.initialized) await this.init();

    try {
      // Check if document exists
      const existing = this.index.getAllDocuments().find(d => d.id === doc.id);
      if (existing) {
        // Delete old version
        this.index.delete(doc.id);
      }
      this.index.add(doc);
      this.debouncedFlush();
      log.debug(`Upserted vector document: ${doc.id}`);
    } catch (err) {
      log.error('Failed to upsert vector document', {
        error: String(err),
        docId: doc.id
      });
      throw err;
    }
  }

  async search(
    embedding: number[],
    topK: number = 5,
    filter?: { chatId?: string; type?: string }
  ): Promise<SearchResult[]> {
    if (!this.initialized) await this.init();

    try {
      // Pull more candidates when filtering to compensate for filter loss
      const multiplier = filter ? 5 : 2;
      let results = this.index.search(embedding, Math.max(topK * multiplier, 20));

      // Apply filters
      if (filter) {
        if (filter.chatId) {
          results = results.filter(r => r.metadata.chatId === filter.chatId);
        }
        if (filter.type) {
          results = results.filter(r => r.metadata.type === filter.type);
        }
      }

      return results.slice(0, topK);
    } catch (err) {
      log.error('Search failed', { error: String(err) });
      return [];
    }
  }

  async delete(id: string): Promise<void> {
    if (!this.initialized) await this.init();

    try {
      this.index.delete(id);
      this.index.flush();
      log.debug(`Deleted vector document: ${id}`);
    } catch (err) {
      log.error('Failed to delete vector document', { error: String(err) });
    }
  }

  async deleteByFilter(filter: { chatId?: string }): Promise<number> {
    if (!this.initialized) await this.init();

    try {
      let deleted = 0;
      const docs = this.index.getAllDocuments();
      for (const doc of docs) {
        if (filter.chatId && doc.metadata.chatId === filter.chatId) {
          this.index.delete(doc.id);
          deleted++;
        }
      }
      if (deleted > 0) {
        this.index.flush();
      }
      log.info(`Deleted ${deleted} vector documents matching filter`);
      return deleted;
    } catch (err) {
      log.error('Failed to delete documents by filter', { error: String(err) });
      return 0;
    }
  }

  async getStats(): Promise<{ totalDocuments: number; indexSize: number }> {
    if (!this.initialized) await this.init();
    return this.index.getStats();
  }

  async rebuildFromSQLite(): Promise<{ migrated: number; errors: number }> {
    if (!this.initialized) await this.init();

    let migrated = 0;
    let errors = 0;

    try {
      log.info('Starting migration from SQLite to VectorStore');
      const db = getDb();
      const rows = db
        .prepare('SELECT id, chat_id, fact, embedding, created_at FROM archival_memory')
        .all() as any[];

      this.index.clear();

      for (const row of rows) {
        try {
          if (!row.embedding || row.embedding.length === 0) {
            log.warn(`Skipping archival_memory id=${row.id}: no embedding`);
            continue;
          }

          const embedding = new Float32Array(
            row.embedding.buffer,
            row.embedding.byteOffset,
            row.embedding.byteLength / 4
          );

          const doc: VectorDocument = {
            id: `archival_${row.id}`,
            text: row.fact,
            embedding: Array.from(embedding),
            metadata: {
              chatId: row.chat_id,
              type: 'archival',
              createdAt: row.created_at,
            },
          };

          this.index.add(doc);
          migrated++;
        } catch (err) {
          log.warn(`Failed to migrate archival_memory id=${row.id}`, {
            error: String(err),
          });
          errors++;
        }
      }

      this.index.flush();
      log.info(`Migration complete: ${migrated} documents migrated, ${errors} errors`);
      return { migrated, errors };
    } catch (err) {
      log.error('Migration from SQLite failed', { error: String(err) });
      return { migrated, errors };
    }
  }
}

// ============================================================
// Global VectorStore Instance
// ============================================================

let globalVectorStore: VectorStore | null = null;

export async function getVectorStore(): Promise<VectorStore> {
  if (!globalVectorStore) {
    globalVectorStore = new VectorStore();
    await globalVectorStore.init();
  }
  return globalVectorStore;
}

export async function initVectorStore(dataDir?: string): Promise<VectorStore> {
  globalVectorStore = new VectorStore(dataDir);
  await globalVectorStore.init();
  return globalVectorStore;
}
