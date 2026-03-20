# Vector Memory API Reference

## Table of Contents

1. [VectorStore API](#vectorstore-api)
2. [EmbeddingProvider API](#embeddingprovider-api)
3. [HTTP Endpoints](#http-endpoints)
4. [TypeScript Examples](#typescript-examples)

---

## VectorStore API

### Module: `server/src/memory/vectorStore.ts`

The VectorStore is a lightweight, file-based vector database.

#### Types

```typescript
interface VectorDocument {
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

interface SearchResult extends VectorDocument {
  score: number;  // Cosine similarity (0-1)
}
```

#### Initialization

```typescript
import { getVectorStore, initVectorStore } from './memory/vectorStore.js';

// Get the global instance (initializes on first call)
const vs = await getVectorStore();

// Or initialize with custom path
const vs = await initVectorStore('/custom/path/to/vectors');
```

#### Methods

##### `async upsert(doc: VectorDocument): Promise<void>`

Add or update a document in the index.

```typescript
const doc: VectorDocument = {
  id: 'archival_123',
  text: 'User prefers coffee over tea',
  embedding: [0.1, 0.2, 0.3, ...], // 384 dimensions
  metadata: {
    chatId: 'user_456',
    type: 'archival',
    createdAt: new Date().toISOString(),
  },
};

await vs.upsert(doc);
```

**Parameters**:
- `doc`: VectorDocument to add/update

**Returns**: Promise<void>

**Throws**: Error if document is invalid or disk write fails

**Notes**:
- Automatically replaces existing document with same ID
- Flushes to disk after upsert

##### `async search(embedding: number[], topK: number = 5, filter?: object): Promise<SearchResult[]>`

Search for similar documents by embedding.

```typescript
const results = await vs.search(
  queryEmbedding,
  topK=5,
  { chatId: 'user_456', type: 'archival' }
);

// Results are sorted by similarity score (highest first)
results.forEach(r => {
  console.log(`${r.text} (score: ${r.score})`);
});
```

**Parameters**:
- `embedding`: Query vector (number[])
- `topK`: Number of results to return (default: 5)
- `filter`: Optional filtering
  - `chatId?: string` - Filter by chat ID
  - `type?: string` - Filter by document type

**Returns**: Promise<SearchResult[]>

**Throws**: Error if search fails

**Complexity**: O(n) where n = total documents, optimized to ~1-5ms typical

**Filter Notes**:
- Both filters are AND'ed together
- Filtering happens after similarity scoring
- Requests 2x topK documents then filters, ensuring topK results

##### `async delete(id: string): Promise<void>`

Delete a document by ID.

```typescript
await vs.delete('archival_123');
```

**Parameters**:
- `id`: Document ID to delete

**Returns**: Promise<void>

**Notes**:
- Idempotent (safe to call multiple times)
- Flushes to disk after deletion

##### `async deleteByFilter(filter: { chatId?: string }): Promise<number>`

Delete all documents matching a filter.

```typescript
const deleted = await vs.deleteByFilter({ chatId: 'user_456' });
console.log(`Deleted ${deleted} documents`);
```

**Parameters**:
- `filter.chatId`: Optional - delete all documents for this chat

**Returns**: Promise<number> - number of deleted documents

**Notes**:
- Useful for clearing user data
- Logs detailed deletion count

##### `async getStats(): Promise<object>`

Get statistics about the index.

```typescript
const stats = await vs.getStats();
// { totalDocuments: 1234, indexSize: 1500000 }
```

**Returns**:
```typescript
{
  totalDocuments: number;  // Total indexed documents
  indexSize: number;       // Size in bytes
}
```

##### `async rebuildFromSQLite(): Promise<object>`

Rebuild the vector index from SQLite archival_memory table.

```typescript
const result = await vs.rebuildFromSQLite();
// { migrated: 1234, errors: 0 }
```

**Returns**:
```typescript
{
  migrated: number;  // Documents successfully migrated
  errors: number;    // Documents that failed
}
```

**When to Use**:
- Recovering from index corruption
- After large data imports
- Version upgrades
- Manual migration trigger

**Notes**:
- Clears existing index first
- Skips documents with no embedding
- Logs detailed progress
- Takes ~100ms per 1000 documents

---

## EmbeddingProvider API

### Module: `server/src/memory/embeddingProvider.ts`

Centralized embedding generation with LRU caching and batch processing.

#### Initialization

```typescript
import { initEmbeddingProvider, getEmbeddingProvider } from './memory/embeddingProvider.js';

// Initialize once on startup
const provider = initEmbeddingProvider(apiKey);

// Or get existing instance
const provider = getEmbeddingProvider();
```

#### Methods

##### `async embed(text: string): Promise<number[]>`

Generate embedding for a single text with automatic caching.

```typescript
const embedding = await provider.embed('hello world');
console.log(embedding.length); // 384 dimensions

// Second call uses cache (1ms instead of 200ms)
const embedding2 = await provider.embed('hello world');
```

**Parameters**:
- `text`: Text to embed (max ~2000 characters recommended)

**Returns**: Promise<number[]> - 384-dimensional vector

**Throws**: Error if text is empty or API fails

**Performance**:
- First call: ~200ms (Gemini API)
- Cached call: ~1ms
- Cache uses LRU eviction at 200 entries

##### `async embedBatch(texts: string[]): Promise<(number[] | null)[]>`

Generate embeddings for multiple texts in a single batch.

```typescript
const texts = ['text 1', 'text 2', 'text 3'];
const embeddings = await provider.embedBatch(texts);

embeddings.forEach((emb, i) => {
  if (emb) {
    console.log(`Text ${i}: ${emb.length} dimensions`);
  } else {
    console.log(`Text ${i}: failed to embed`);
  }
});
```

**Parameters**:
- `texts`: Array of strings to embed

**Returns**: Promise<(number[] | null)[]> - Embeddings or null for failures

**Throws**: No (returns nulls for failures instead)

**Performance**:
- Batches up to 10 texts per API call
- Timeout: 500ms (flushes earlier if batch full)
- 10 texts in one call vs 10 individual calls = ~10x fewer API calls

**Error Handling**:
- Empty text → null in results
- Invalid text → null in results
- API failure → null in results
- Partial failure → succeeds for valid texts

##### `clearCache(): void`

Clear the embedding cache.

```typescript
provider.clearCache();
console.log('Cache cleared');
```

**When to Use**:
- Free up memory
- Force recompute embeddings
- Debugging

**Notes**:
- Synchronous
- Next calls will hit Gemini API again

##### `getStats(): object`

Get cache and queue statistics.

```typescript
const stats = provider.getStats();
console.log(stats);
// {
//   cacheSize: 45,
//   maxCacheSize: 200,
//   queuedRequests: 2
// }
```

**Returns**:
```typescript
{
  cacheSize: number;       // Current cached embeddings
  maxCacheSize: number;    // Maximum cache size
  queuedRequests: number;  // Pending embedding requests
}
```

**Use Cases**:
- Monitor cache performance
- Check queue length
- Optimize settings based on usage

#### Convenience Functions

##### `async embedText(text: string): Promise<number[]>`

Shorthand wrapper (backward compatibility).

```typescript
import { embedText } from './memory/embeddingProvider.js';

const embedding = await embedText('hello');
```

##### `async embedTexts(texts: string[]): Promise<(number[] | null)[]>`

Shorthand batch wrapper.

```typescript
import { embedTexts } from './memory/embeddingProvider.js';

const embeddings = await embedTexts(['text1', 'text2']);
```

##### `function getEmbeddingStats(): object`

Get stats without initializing provider.

```typescript
import { getEmbeddingStats } from './memory/embeddingProvider.js';

const stats = getEmbeddingStats();
// Safe to call even if provider not initialized
```

---

## HTTP Endpoints

### GET /api/memory/vector-stats

Get vector store and embedding provider statistics.

**Request**:
```bash
curl http://localhost:3000/api/memory/vector-stats
```

**Response** (200 OK):
```json
{
  "success": true,
  "vectorStore": {
    "totalDocuments": 1234,
    "indexSizeBytes": 1524000
  },
  "embeddingProvider": {
    "cacheSize": 45,
    "maxCacheSize": 200,
    "queuedRequests": 0
  },
  "timestamp": "2026-03-07T12:34:56.789Z"
}
```

**Error** (500 Server Error):
```json
{
  "success": false,
  "error": "Vector store not initialized"
}
```

**Use Cases**:
- Monitor system health
- Check cache performance
- Verify vector store is working
- Debugging performance issues

---

### POST /api/memory/rebuild-index

Rebuild the vector index from SQLite.

**Request**:
```bash
curl -X POST http://localhost:3000/api/memory/rebuild-index
```

**Response** (200 OK):
```json
{
  "success": true,
  "migrated": 1234,
  "errors": 0,
  "message": "Rebuilt vector index: 1234 documents indexed, 0 errors"
}
```

**Error** (500 Server Error):
```json
{
  "success": false,
  "error": "Failed to rebuild index: disk space error"
}
```

**Use Cases**:
- Recover from index corruption
- After data import
- Manual index rebuild
- Version upgrades

**Estimated Duration**:
- 100ms per 1000 documents
- 1000 docs = ~100ms
- 10000 docs = ~1s

**Notes**:
- Synchronous (blocks until complete)
- Should be done during low-traffic periods
- Safe to call multiple times

---

## TypeScript Examples

### Example 1: Basic Search

```typescript
import { getVectorStore } from './memory/vectorStore.js';
import { embedText } from './memory/embeddingProvider.js';

async function searchFacts(chatId: string, query: string) {
  const vs = await getVectorStore();
  const embedding = await embedText(query);

  if (!embedding.length) {
    console.log('Failed to embed query');
    return [];
  }

  const results = await vs.search(embedding, topK=5, { chatId });

  results.forEach((result, i) => {
    console.log(`${i+1}. [${result.score.toFixed(2)}] ${result.text}`);
  });

  return results;
}

// Usage
await searchFacts('user_123', 'Tell me about coffee');
```

### Example 2: Add Learning to Vector Store

```typescript
import { getVectorStore } from './memory/vectorStore.js';
import { embedText } from './memory/embeddingProvider.js';

async function indexLearning(id: number, insight: string) {
  const embedding = await embedText(insight);

  if (!embedding.length) {
    console.warn('Could not embed learning');
    return;
  }

  const vs = await getVectorStore();
  await vs.upsert({
    id: `learning_${id}`,
    text: insight,
    embedding,
    metadata: {
      chatId: 'system',
      type: 'learning',
      createdAt: new Date().toISOString(),
    },
  });
}

// Usage
await indexLearning(42, 'Error handling with try-catch is important');
```

### Example 3: Batch Processing

```typescript
import { getEmbeddingProvider } from './memory/embeddingProvider.js';
import { getVectorStore } from './memory/vectorStore.js';

async function bulkIndex(items: { id: string; text: string }[]) {
  const provider = getEmbeddingProvider();
  const vs = await getVectorStore();

  // Batch embed all texts at once
  const embeddings = await provider.embedBatch(
    items.map(i => i.text)
  );

  // Index successful embeddings
  for (let i = 0; i < items.length; i++) {
    if (embeddings[i]) {
      await vs.upsert({
        id: items[i].id,
        text: items[i].text,
        embedding: embeddings[i]!,
        metadata: {
          chatId: 'bulk_import',
          type: 'archival',
          createdAt: new Date().toISOString(),
        },
      });
    }
  }

  console.log(`Indexed ${embeddings.filter(e => e).length}/${items.length} items`);
}

// Usage
await bulkIndex([
  { id: 'doc1', text: 'First document' },
  { id: 'doc2', text: 'Second document' },
  { id: 'doc3', text: 'Third document' },
]);
```

### Example 4: Monitor Cache Performance

```typescript
import { getEmbeddingProvider } from './memory/embeddingProvider.js';
import { embedText } from './memory/embeddingProvider.js';

async function monitorCache() {
  const provider = getEmbeddingProvider();

  // Embed some texts
  for (let i = 0; i < 5; i++) {
    await embedText('repeated query');
  }

  // Check stats
  const stats = provider.getStats();

  console.log(`Cache:`, stats);
  // Expected: cacheSize=1, queuedRequests=0
  // (all 5 requests used cache)
}

// Usage
await monitorCache();
```

### Example 5: Search with Fallback

```typescript
import { getVectorStore } from './memory/vectorStore.js';
import { embedText } from './memory/embeddingProvider.js';
import { getDb } from './database/db.js';

async function smartSearch(chatId: string, query: string) {
  try {
    // Try vector search first (fast)
    const embedding = await embedText(query);
    if (embedding.length > 0) {
      const vs = await getVectorStore();
      const results = await vs.search(embedding, topK=5, { chatId });
      if (results.length > 0) {
        console.log('Vector search succeeded');
        return results.map(r => r.text);
      }
    }
  } catch (err) {
    console.warn('Vector search failed:', err);
  }

  // Fallback to keyword search
  console.log('Using keyword fallback');
  const db = getDb();
  const results = db.prepare(`
    SELECT fact FROM archival_memory
    WHERE chat_id = ? AND fact LIKE ?
    LIMIT 5
  `).all(chatId, `%${query}%`) as any[];

  return results.map(r => r.fact);
}

// Usage
const facts = await smartSearch('user_123', 'coffee preferences');
```

---

## Error Handling

### Common Errors

**"Vector store not initialized"**
```typescript
// Solution: ensure initVectorStore() called on startup
import { initVectorStore } from './memory/vectorStore.js';
await initVectorStore();
```

**"Embedding provider not initialized"**
```typescript
// Solution: ensure initEmbeddingProvider() called with API key
import { initEmbeddingProvider } from './memory/embeddingProvider.js';
initEmbeddingProvider(apiKey);
```

**"Vector embedding is empty"**
```typescript
// Solution: check embedding result, handle null case
const embedding = await embedText(text);
if (!embedding || embedding.length === 0) {
  // Fallback to keyword search
}
```

**"Vector index file not found"**
```typescript
// Solution: auto-recreates on first use, or rebuild
POST /api/memory/rebuild-index
```

### Recovery Strategies

```typescript
// Graceful degradation pattern
async function safeSearch(chatId: string, query: string) {
  try {
    // Try vector search
    const vs = await getVectorStore();
    const embedding = await embedText(query);
    if (embedding.length > 0) {
      return await vs.search(embedding, topK=5, { chatId });
    }
  } catch (err) {
    console.warn('[Search] Vector search failed, using fallback', err);
  }

  // Fallback to SQLite
  const db = getDb();
  return db.prepare(`
    SELECT fact FROM archival_memory
    WHERE chat_id = ? LIMIT 5
  `).all(chatId);
}
```

---

## Performance Considerations

### Optimization Tips

1. **Batch Embeddings**
   ```typescript
   // Good: 1 API call
   const embeddings = await provider.embedBatch(texts);

   // Avoid: 10 API calls
   for (const text of texts) {
     await embedText(text);
   }
   ```

2. **Reuse Cached Embeddings**
   ```typescript
   // Same query twice → second uses cache
   const emb1 = await embedText('query');
   const emb2 = await embedText('query');  // ~200x faster!
   ```

3. **Adjust Cache Size**
   ```typescript
   // More documents → increase cache
   // Edit embeddingProvider.ts:
   const CACHE_MAX_ENTRIES = 500;  // was 200
   ```

4. **Monitor Vector Store Growth**
   ```typescript
   // Regular check
   GET /api/memory/vector-stats

   // If indexSize > 10MB, consider archiving old data
   ```

---

## Testing

### Unit Test Example

```typescript
import { VectorStore } from './memory/vectorStore.js';
import { EmbeddingProvider } from './memory/embeddingProvider.js';

describe('VectorStore', () => {
  it('should search similar documents', async () => {
    const vs = new VectorStore('./test-vectors');
    await vs.init();

    // Add documents
    await vs.upsert({
      id: 'test1',
      text: 'The cat sat on the mat',
      embedding: new Array(384).fill(0.1),
      metadata: { chatId: 'test', type: 'archival', createdAt: new Date().toISOString() },
    });

    // Search
    const results = await vs.search(
      new Array(384).fill(0.1),
      topK=5
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0.9);
  });
});
```

---

**Last Updated**: March 2026
**Version**: 1.0
**Status**: Production Ready
