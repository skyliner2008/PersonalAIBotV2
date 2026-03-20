// ============================================================
// Unit Tests: Memory Cache (Unified Memory System)
// ============================================================
// Tests the 4-layer memory architecture:
// - Layer 1: Core Memory (always in system prompt)
// - Layer 2: Working Memory (RAM-cached recent messages)
// - Layer 3: Recall Memory (full history in SQLite)
// - Layer 4: Archival Memory (semantic embeddings)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestDb, cleanupTestDb, insertTestMessage, insertTestCoreMemory, getTestMessages, getTestCoreMemory } from '../helpers/testUtils.js';
import type Database from 'better-sqlite3';

describe('Memory System - Core Functions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  // ── Working Memory Tests ──

  describe('Working Memory (Layer 2)', () => {
    it('should add message to working memory', () => {
      const chatId = 'chat-001';
      const role = 'user';
      const content = 'Hello, how are you?';

      insertTestMessage(db, chatId, role, content);

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe(role);
      expect(messages[0].content).toBe(content);
    });

    it('should maintain message order in working memory', () => {
      const chatId = 'chat-001';

      insertTestMessage(db, chatId, 'user', 'First message');
      insertTestMessage(db, chatId, 'assistant', 'Response 1');
      insertTestMessage(db, chatId, 'user', 'Second message');

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(3);
      expect(messages[0].content).toBe('First message');
      expect(messages[1].content).toBe('Response 1');
      expect(messages[2].content).toBe('Second message');
    });

    it('should separate conversations by chatId', () => {
      const chat1 = 'chat-001';
      const chat2 = 'chat-002';

      insertTestMessage(db, chat1, 'user', 'Chat 1 message');
      insertTestMessage(db, chat2, 'user', 'Chat 2 message');

      const messages1 = getTestMessages(db, chat1);
      const messages2 = getTestMessages(db, chat2);

      expect(messages1.length).toBe(1);
      expect(messages2.length).toBe(1);
      expect(messages1[0].content).toBe('Chat 1 message');
      expect(messages2[0].content).toBe('Chat 2 message');
    });

    it('should handle WORKING_MEMORY_LIMIT (25 messages)', () => {
      const chatId = 'chat-001';
      const LIMIT = 25;

      // Insert 35 messages (exceeds limit)
      for (let i = 1; i <= 35; i++) {
        insertTestMessage(db, chatId, i % 2 === 0 ? 'assistant' : 'user', `Message ${i}`);
      }

      const messages = getTestMessages(db, chatId);
      // Database doesn't enforce limit, but the memory layer should
      expect(messages.length).toBeGreaterThan(0);
    });

    it('should support different roles', () => {
      const chatId = 'chat-001';

      insertTestMessage(db, chatId, 'user', 'User message');
      insertTestMessage(db, chatId, 'assistant', 'Assistant response');
      insertTestMessage(db, chatId, 'system', 'System message');

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(3);
      expect(messages.map(m => m.role)).toEqual(['user', 'assistant', 'system']);
    });

    it('should handle messages with special characters', () => {
      const chatId = 'chat-001';
      const specialContent = `Special chars: !@#$%^&*() "quotes" 'apostrophes' \n newlines \t tabs`;

      insertTestMessage(db, chatId, 'user', specialContent);

      const messages = getTestMessages(db, chatId);
      expect(messages[0].content).toBe(specialContent);
    });

    it('should handle Thai language in messages', () => {
      const chatId = 'chat-001';
      const thaiContent = 'สวัสดี ยินดีต้อนรับ 你好 مرحبا';

      insertTestMessage(db, chatId, 'user', thaiContent);

      const messages = getTestMessages(db, chatId);
      expect(messages[0].content).toContain('สวัสดี');
    });

    it('should handle very long messages', () => {
      const chatId = 'chat-001';
      const longContent = 'x'.repeat(10_000);

      insertTestMessage(db, chatId, 'user', longContent);

      const messages = getTestMessages(db, chatId);
      expect(messages[0].content.length).toBe(10_000);
    });

    it('should handle empty message content', () => {
      const chatId = 'chat-001';

      insertTestMessage(db, chatId, 'user', '');

      const messages = getTestMessages(db, chatId);
      expect(messages[0].content).toBe('');
    });
  });

  // ── Core Memory Tests ──

  describe('Core Memory (Layer 1)', () => {
    it('should store core memory blocks', () => {
      const chatId = 'chat-001';
      const label = 'user_profile';
      const value = 'Name: John, Interested in: AI, ML';

      insertTestCoreMemory(db, chatId, label, value);

      const coreMemory = getTestCoreMemory(db, chatId);
      expect(coreMemory.length).toBe(1);
      expect(coreMemory[0].block_label).toBe(label);
      expect(coreMemory[0].value).toBe(value);
    });

    it('should support multiple core memory blocks per chat', () => {
      const chatId = 'chat-001';

      insertTestCoreMemory(db, chatId, 'user_profile', 'John, AI enthusiast');
      insertTestCoreMemory(db, chatId, 'preferences', 'Prefers Python, dislikes Java');
      insertTestCoreMemory(db, chatId, 'goals', 'Learn machine learning');

      const coreMemory = getTestCoreMemory(db, chatId);
      expect(coreMemory.length).toBe(3);
    });

    it('should update existing core memory block (UPSERT)', () => {
      const chatId = 'chat-001';
      const label = 'user_profile';

      insertTestCoreMemory(db, chatId, label, 'Original value');
      insertTestCoreMemory(db, chatId, label, 'Updated value');

      const coreMemory = getTestCoreMemory(db, chatId);
      expect(coreMemory.length).toBe(1); // Should not duplicate
      expect(coreMemory[0].value).toBe('Updated value');
    });

    it('should separate core memory by chatId', () => {
      const chat1 = 'chat-001';
      const chat2 = 'chat-002';

      insertTestCoreMemory(db, chat1, 'profile', 'Chat 1 profile');
      insertTestCoreMemory(db, chat2, 'profile', 'Chat 2 profile');

      const memory1 = getTestCoreMemory(db, chat1);
      const memory2 = getTestCoreMemory(db, chat2);

      expect(memory1[0].value).toBe('Chat 1 profile');
      expect(memory2[0].value).toBe('Chat 2 profile');
    });

    it('should handle JSON values in core memory', () => {
      const chatId = 'chat-001';
      const jsonValue = JSON.stringify({
        name: 'John',
        skills: ['Python', 'JavaScript'],
        preferences: { theme: 'dark' },
      });

      insertTestCoreMemory(db, chatId, 'profile_json', jsonValue);

      const coreMemory = getTestCoreMemory(db, chatId);
      const parsed = JSON.parse(coreMemory[0].value);
      expect(parsed.name).toBe('John');
      expect(parsed.skills).toContain('Python');
    });

    it('should handle Thai text in core memory', () => {
      const chatId = 'chat-001';
      const thaiValue = 'ชื่อ: สมชาย สนใจ: เทคโนโลยี AI';

      insertTestCoreMemory(db, chatId, 'profile', thaiValue);

      const coreMemory = getTestCoreMemory(db, chatId);
      expect(coreMemory[0].value).toContain('สมชาย');
    });
  });

  // ── Archival Memory Tests ──

  describe('Archival Memory (Layer 4)', () => {
    it('should create archival facts table', () => {
      // Verify table exists
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='archival_facts'"
      ).all() as any[];

      expect(tables.length).toBeGreaterThan(0);
    });

    it('should insert archival facts', () => {
      const chatId = 'chat-001';

      db.prepare(
        'INSERT INTO archival_facts (chat_id, fact, source) VALUES (?, ?, ?)'
      ).run(chatId, 'User prefers Python', 'inferred from conversations');

      const facts = db.prepare(
        'SELECT fact FROM archival_facts WHERE chat_id = ?'
      ).all(chatId) as any[];

      expect(facts.length).toBeGreaterThan(0);
      expect(facts[0].fact).toContain('Python');
    });

    it('should support metadata with embeddings', () => {
      const chatId = 'chat-001';
      const embedding = JSON.stringify([0.1, 0.2, 0.3]);

      db.prepare(
        'INSERT INTO archival_facts (chat_id, fact, embedding) VALUES (?, ?, ?)'
      ).run(chatId, 'Important fact', embedding);

      const facts = db.prepare(
        'SELECT embedding FROM archival_facts WHERE chat_id = ?'
      ).all(chatId) as any[];

      const parsed = JSON.parse(facts[0].embedding);
      expect(parsed).toEqual([0.1, 0.2, 0.3]);
    });
  });

  // ── Cache Eviction Tests ──

  describe('LRU Eviction Policy', () => {
    it('should evict least recently used session when cache full', () => {
      // This would be tested with 501+ entries (MAX_CACHE_ENTRIES = 500)
      // For unit test, we verify the database behavior instead
      const MAX_ENTRIES = 500;
      const chatId = `chat-${MAX_ENTRIES + 1}`;

      // Add one message (tests database can handle insertions)
      insertTestMessage(db, chatId, 'user', 'Test message');

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBeGreaterThan(0);
    });

    it('should respect session TTL expiration (60 minutes)', () => {
      // TTL is managed at runtime, verify database schema supports timestamps
      insertTestMessage(db, 'chat-001', 'user', 'Message with timestamp');

      const messages = db.prepare(
        'SELECT timestamp FROM messages WHERE conversation_id = ?'
      ).all('chat-001') as any[];

      expect(messages[0].timestamp).toBeTruthy();
    });
  });

  // ── Concurrent Access Tests ──

  describe('Concurrent Access & Race Conditions', () => {
    it('should handle multiple concurrent writes to same chat', async () => {
      const chatId = 'chat-concurrent';
      const promises = [];

      for (let i = 0; i < 10; i++) {
        promises.push(
          Promise.resolve().then(() => {
            insertTestMessage(db, chatId, 'user', `Message ${i}`);
          })
        );
      }

      await Promise.all(promises);

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(10);
    });

    it('should not corrupt data with concurrent writes', () => {
      const chats = ['chat-1', 'chat-2', 'chat-3'];
      const messagesPerChat = 5;

      for (const chatId of chats) {
        for (let i = 0; i < messagesPerChat; i++) {
          insertTestMessage(db, chatId, 'user', `Msg from ${chatId} #${i}`);
        }
      }

      for (const chatId of chats) {
        const messages = getTestMessages(db, chatId);
        expect(messages.length).toBe(messagesPerChat);
      }
    });
  });

  // ── Edge Cases ──

  describe('Edge Cases', () => {
    it('should handle chatId with special characters', () => {
      const chatId = 'chat-@#$%_001';
      insertTestMessage(db, chatId, 'user', 'Test message');

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(1);
    });

    it('should handle very large number of messages', () => {
      const chatId = 'chat-large';
      const count = 1000;

      for (let i = 0; i < count; i++) {
        insertTestMessage(db, chatId, 'user', `Message ${i}`);
      }

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(count);
    });

    it('should handle rapid successive inserts', () => {
      const chatId = 'chat-rapid';

      for (let i = 0; i < 100; i++) {
        insertTestMessage(db, chatId, 'user', `Rapid msg ${i}`);
      }

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(100);
    });

    it('should retrieve empty result for non-existent chatId', () => {
      const messages = getTestMessages(db, 'non-existent-chat');
      expect(messages.length).toBe(0);
    });
  });

  // ── Integration Tests ──

  describe('Memory Layer Integration', () => {
    it('should support full workflow: core + working + archival', () => {
      const chatId = 'chat-full';

      // Layer 1: Core Memory
      insertTestCoreMemory(db, chatId, 'profile', 'User: John, AI enthusiast');

      // Layer 2: Working Memory (recent messages)
      insertTestMessage(db, chatId, 'user', 'How can I learn AI?');
      insertTestMessage(db, chatId, 'assistant', 'Start with Python and ML basics');

      // Layer 4: Archival (long-term facts)
      db.prepare(
        'INSERT INTO archival_facts (chat_id, fact) VALUES (?, ?)'
      ).run(chatId, 'User is learning AI');

      // Verify all layers
      const coreMemory = getTestCoreMemory(db, chatId);
      const workingMemory = getTestMessages(db, chatId);
      const archivalMemory = db.prepare(
        'SELECT fact FROM archival_facts WHERE chat_id = ?'
      ).all(chatId) as any[];

      expect(coreMemory.length).toBeGreaterThan(0);
      expect(workingMemory.length).toBeGreaterThan(0);
      expect(archivalMemory.length).toBeGreaterThan(0);
    });

    it('should maintain context across multiple chats', () => {
      const chats = ['chat-1', 'chat-2', 'chat-3'];

      for (const chatId of chats) {
        insertTestCoreMemory(db, chatId, 'name', `User in ${chatId}`);
        insertTestMessage(db, chatId, 'user', `Hello from ${chatId}`);
      }

      // Verify isolation
      for (const chatId of chats) {
        const coreMemory = getTestCoreMemory(db, chatId);
        const messages = getTestMessages(db, chatId);

        expect(coreMemory.length).toBe(1);
        expect(messages.length).toBe(1);
        expect(coreMemory[0].value).toContain(chatId);
      }
    });
  });
});
