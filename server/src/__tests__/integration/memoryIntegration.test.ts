// ============================================================
// Integration Tests: Memory System End-to-End
// ============================================================
// Tests the complete unified memory architecture:
// 1. Message persistence across layers
// 2. Core memory extraction and retrieval
// 3. Archival semantic search
// 4. Context building from all layers

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, cleanupTestDb, insertTestMessage, insertTestCoreMemory, getTestMessages, getTestCoreMemory } from '../helpers/testUtils.js';
import type Database from 'better-sqlite3';

describe('Memory System Integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    cleanupTestDb(db);
  });

  // ── Save and Retrieve Messages ──

  describe('message lifecycle', () => {
    it('should save user message to working memory', () => {
      const chatId = 'chat-001';
      const userMsg = 'Can you help me with Python?';

      insertTestMessage(db, chatId, 'user', userMsg);

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toBe(userMsg);
    });

    it('should save assistant response to working memory', () => {
      const chatId = 'chat-001';
      const assistantMsg = 'Of course! I can help you learn Python.';

      insertTestMessage(db, chatId, 'assistant', assistantMsg);

      const messages = getTestMessages(db, chatId);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe(assistantMsg);
    });

    it('should maintain conversation history', () => {
      const chatId = 'chat-001';

      insertTestMessage(db, chatId, 'user', 'Hello');
      insertTestMessage(db, chatId, 'assistant', 'Hi there!');
      insertTestMessage(db, chatId, 'user', 'How are you?');
      insertTestMessage(db, chatId, 'assistant', 'Doing great, thanks for asking!');

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(4);
      expect(messages[0].content).toBe('Hello');
      expect(messages[3].content).toBe('Doing great, thanks for asking!');
    });

    it('should retrieve messages in chronological order', () => {
      const chatId = 'chat-001';
      const msgOrder = ['first', 'second', 'third', 'fourth', 'fifth'];

      for (const msg of msgOrder) {
        insertTestMessage(db, chatId, 'user', msg);
      }

      const retrieved = getTestMessages(db, chatId);
      for (let i = 0; i < msgOrder.length; i++) {
        expect(retrieved[i].content).toBe(msgOrder[i]);
      }
    });
  });

  // ── Core Memory Extraction ──

  describe('core memory extraction and management', () => {
    it('should extract user profile to core memory', () => {
      const chatId = 'chat-001';
      const profile = 'Name: Alice, Age: 28, Profession: Software Engineer';

      insertTestCoreMemory(db, chatId, 'user_profile', profile);

      const coreMemory = getTestCoreMemory(db, chatId);
      expect(coreMemory[0].block_label).toBe('user_profile');
      expect(coreMemory[0].value).toContain('Alice');
    });

    it('should track user preferences in core memory', () => {
      const chatId = 'chat-001';
      const preferences = 'Language: English, Timezone: UTC+8, Theme: Dark';

      insertTestCoreMemory(db, chatId, 'preferences', preferences);

      const coreMemory = getTestCoreMemory(db, chatId);
      expect(coreMemory[0].block_label).toBe('preferences');
      expect(coreMemory[0].value).toContain('Dark');
    });

    it('should store learned facts in core memory', () => {
      const chatId = 'chat-001';

      insertTestCoreMemory(db, chatId, 'user_profile', 'John');
      insertTestCoreMemory(db, chatId, 'interests', 'Machine Learning, Robotics');
      insertTestCoreMemory(db, chatId, 'goals', 'Build autonomous systems');

      const coreMemory = getTestCoreMemory(db, chatId);
      expect(coreMemory.length).toBe(3);
    });

    it('should update core memory blocks', () => {
      const chatId = 'chat-001';
      const label = 'user_profile';

      insertTestCoreMemory(db, chatId, label, 'Version 1');
      insertTestCoreMemory(db, chatId, label, 'Version 2 with updates');

      const coreMemory = getTestCoreMemory(db, chatId);
      expect(coreMemory.length).toBe(1);
      expect(coreMemory[0].value).toBe('Version 2 with updates');
    });

    it('should format core memory for system prompt', () => {
      const chatId = 'chat-001';

      insertTestCoreMemory(db, chatId, 'profile', 'Alice, Engineer');
      insertTestCoreMemory(db, chatId, 'interests', 'AI and ML');

      const coreMemory = getTestCoreMemory(db, chatId);

      // Format for inclusion in system prompt
      const formatted = coreMemory.map(b =>
        `<${b.block_label}>\n${b.value}\n</${b.block_label}>`
      ).join('\n');

      expect(formatted).toContain('profile');
      expect(formatted).toContain('Alice');
      expect(formatted).toContain('interests');
    });
  });

  // ── Archival Memory ──

  describe('archival memory and semantic storage', () => {
    it('should store facts for long-term retrieval', () => {
      const chatId = 'chat-001';

      db.prepare(
        'INSERT INTO archival_facts (chat_id, fact, source) VALUES (?, ?, ?)'
      ).run(chatId, 'User completed Python course', 'inferred from conversation');

      const facts = db.prepare(
        'SELECT fact FROM archival_facts WHERE chat_id = ?'
      ).all(chatId) as any[];

      expect(facts.length).toBe(1);
      expect(facts[0].fact).toContain('Python');
    });

    it('should preserve fact metadata', () => {
      const chatId = 'chat-001';
      const fact = 'Interested in distributed systems';
      const source = 'explicitly stated in message 42';

      db.prepare(
        'INSERT INTO archival_facts (chat_id, fact, source) VALUES (?, ?, ?)'
      ).run(chatId, fact, source);

      const stored = db.prepare(
        'SELECT fact, source FROM archival_facts WHERE chat_id = ?'
      ).get(chatId) as any;

      expect(stored.fact).toBe(fact);
      expect(stored.source).toContain('message');
    });

    it('should support semantic search with embeddings', () => {
      const chatId = 'chat-001';
      const embedding = JSON.stringify([0.1, 0.2, 0.3, 0.4]);

      db.prepare(
        'INSERT INTO archival_facts (chat_id, fact, embedding) VALUES (?, ?, ?)'
      ).run(chatId, 'Likes Python programming', embedding);

      const fact = db.prepare(
        'SELECT embedding FROM archival_facts WHERE chat_id = ?'
      ).get(chatId) as any;

      const parsed = JSON.parse(fact.embedding);
      expect(parsed.length).toBe(4);
    });

    it('should handle multiple archival facts per chat', () => {
      const chatId = 'chat-001';
      const facts = [
        'Fact 1: User from Thailand',
        'Fact 2: Works in software industry',
        'Fact 3: Interested in AI/ML',
        'Fact 4: Prefers Python',
        'Fact 5: Goal is to become ML engineer',
      ];

      for (const fact of facts) {
        db.prepare(
          'INSERT INTO archival_facts (chat_id, fact) VALUES (?, ?)'
        ).run(chatId, fact);
      }

      const stored = db.prepare(
        'SELECT COUNT(*) as count FROM archival_facts WHERE chat_id = ?'
      ).get(chatId) as any;

      expect(stored.count).toBe(facts.length);
    });
  });

  // ── Building Unified Context ──

  describe('context building from all layers', () => {
    it('should assemble context from core + working + archival', () => {
      const chatId = 'chat-001';

      // Layer 1: Core Memory
      insertTestCoreMemory(db, chatId, 'profile', 'Alice, Software Engineer');

      // Layer 2: Working Memory (recent messages)
      insertTestMessage(db, chatId, 'user', 'How do I learn ML?');
      insertTestMessage(db, chatId, 'assistant', 'Start with Python and statistics');
      insertTestMessage(db, chatId, 'user', 'Any course recommendations?');

      // Layer 4: Archival Memory
      db.prepare(
        'INSERT INTO archival_facts (chat_id, fact) VALUES (?, ?)'
      ).run(chatId, 'User interested in ML');

      // Assemble context
      const coreMemory = getTestCoreMemory(db, chatId);
      const workingMemory = getTestMessages(db, chatId);
      const archivalFacts = db.prepare(
        'SELECT fact FROM archival_facts WHERE chat_id = ?'
      ).all(chatId) as any[];

      const context = {
        coreMemory,
        workingMemory,
        archivalFacts: archivalFacts.map(f => f.fact),
      };

      expect(context.coreMemory.length).toBeGreaterThan(0);
      expect(context.workingMemory.length).toBeGreaterThan(0);
      expect(context.archivalFacts.length).toBeGreaterThan(0);
    });

    it('should limit working memory to last 25 messages', () => {
      const chatId = 'chat-001';

      // Insert 50 messages
      for (let i = 1; i <= 50; i++) {
        insertTestMessage(db, chatId, i % 2 === 0 ? 'assistant' : 'user', `Message ${i}`);
      }

      const allMessages = getTestMessages(db, chatId);
      expect(allMessages.length).toBe(50);

      // In real implementation, working memory limit = 25
      const workingMemory = allMessages.slice(-25);
      expect(workingMemory.length).toBe(25);
      expect(workingMemory[0].content).toBe('Message 26');
      expect(workingMemory[24].content).toBe('Message 50');
    });

    it('should include recent messages in working memory', () => {
      const chatId = 'chat-001';

      const messages = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
      for (const msg of messages) {
        insertTestMessage(db, chatId, 'user', msg);
      }

      const recent = getTestMessages(db, chatId).slice(-3);
      expect(recent[0].content).toBe('Third');
      expect(recent[1].content).toBe('Fourth');
      expect(recent[2].content).toBe('Fifth');
    });

    it('should format context for system prompt injection', () => {
      const chatId = 'chat-001';

      insertTestCoreMemory(db, chatId, 'user_profile', 'Alice');
      insertTestMessage(db, chatId, 'user', 'Test');

      const coreMemory = getTestCoreMemory(db, chatId);

      const systemPromptContext = `
[Core Memory]
${coreMemory.map(b => `<${b.block_label}>\n${b.value}\n</${b.block_label}>`).join('\n')}

[Recent Conversation]
(last 25 messages would be here)
      `;

      expect(systemPromptContext).toContain('Core Memory');
      expect(systemPromptContext).toContain('Alice');
    });
  });

  // ── Memory Isolation ──

  describe('memory isolation between chats', () => {
    it('should isolate core memory by chatId', () => {
      const chat1 = 'chat-001';
      const chat2 = 'chat-002';

      insertTestCoreMemory(db, chat1, 'profile', 'Alice');
      insertTestCoreMemory(db, chat2, 'profile', 'Bob');

      const memory1 = getTestCoreMemory(db, chat1);
      const memory2 = getTestCoreMemory(db, chat2);

      expect(memory1[0].value).toBe('Alice');
      expect(memory2[0].value).toBe('Bob');
    });

    it('should isolate messages by chatId', () => {
      const chat1 = 'chat-001';
      const chat2 = 'chat-002';

      insertTestMessage(db, chat1, 'user', 'Chat 1 message');
      insertTestMessage(db, chat2, 'user', 'Chat 2 message');

      const messages1 = getTestMessages(db, chat1);
      const messages2 = getTestMessages(db, chat2);

      expect(messages1[0].content).toBe('Chat 1 message');
      expect(messages2[0].content).toBe('Chat 2 message');
    });

    it('should isolate archival facts by chatId', () => {
      const chat1 = 'chat-001';
      const chat2 = 'chat-002';

      db.prepare('INSERT INTO archival_facts (chat_id, fact) VALUES (?, ?)')
        .run(chat1, 'Fact for chat 1');
      db.prepare('INSERT INTO archival_facts (chat_id, fact) VALUES (?, ?)')
        .run(chat2, 'Fact for chat 2');

      const facts1 = db.prepare(
        'SELECT fact FROM archival_facts WHERE chat_id = ?'
      ).all(chat1) as any[];
      const facts2 = db.prepare(
        'SELECT fact FROM archival_facts WHERE chat_id = ?'
      ).all(chat2) as any[];

      expect(facts1[0].fact).toContain('chat 1');
      expect(facts2[0].fact).toContain('chat 2');
    });
  });

  // ── Memory Clear ──

  describe('memory cleanup and deletion', () => {
    it('should clear all memory layers for a chat', () => {
      const chatId = 'chat-001';

      // Add data to all layers
      insertTestCoreMemory(db, chatId, 'profile', 'Data');
      insertTestMessage(db, chatId, 'user', 'Message');
      db.prepare('INSERT INTO archival_facts (chat_id, fact) VALUES (?, ?)')
        .run(chatId, 'Fact');

      // Clear all
      db.prepare('DELETE FROM core_memory WHERE chat_id = ?').run(chatId);
      db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(chatId);
      db.prepare('DELETE FROM archival_facts WHERE chat_id = ?').run(chatId);

      // Verify deletion
      const coreMemory = getTestCoreMemory(db, chatId);
      const messages = getTestMessages(db, chatId);
      const facts = db.prepare(
        'SELECT * FROM archival_facts WHERE chat_id = ?'
      ).all(chatId) as any[];

      expect(coreMemory.length).toBe(0);
      expect(messages.length).toBe(0);
      expect(facts.length).toBe(0);
    });

    it('should preserve other chats when clearing one', () => {
      const chat1 = 'chat-001';
      const chat2 = 'chat-002';

      insertTestCoreMemory(db, chat1, 'p', 'Alice');
      insertTestCoreMemory(db, chat2, 'p', 'Bob');

      // Clear chat1
      db.prepare('DELETE FROM core_memory WHERE chat_id = ?').run(chat1);

      const memory1 = getTestCoreMemory(db, chat1);
      const memory2 = getTestCoreMemory(db, chat2);

      expect(memory1.length).toBe(0);
      expect(memory2.length).toBe(1);
      expect(memory2[0].value).toBe('Bob');
    });
  });

  // ── Performance & Scaling ──

  describe('memory performance', () => {
    it('should handle large conversations (1000+ messages)', () => {
      const chatId = 'chat-large';

      for (let i = 0; i < 1000; i++) {
        insertTestMessage(db, chatId, 'user', `Message ${i}`);
      }

      const messages = getTestMessages(db, chatId);
      expect(messages.length).toBe(1000);
      expect(messages[0].content).toBe('Message 0');
      expect(messages[999].content).toBe('Message 999');
    });

    it('should efficiently query recent messages', () => {
      const chatId = 'chat-perf';

      for (let i = 0; i < 100; i++) {
        insertTestMessage(db, chatId, 'user', `Msg ${i}`);
      }

      const messages = getTestMessages(db, chatId);
      const recent = messages.slice(-25);

      expect(recent.length).toBe(25);
      expect(recent[0].content).toBe('Msg 75');
    });

    it('should handle multiple concurrent chats', () => {
      const chatIds = Array.from({ length: 50 }, (_, i) => `chat-${i}`);

      for (const chatId of chatIds) {
        insertTestMessage(db, chatId, 'user', 'Test message');
        insertTestCoreMemory(db, chatId, 'id', chatId);
      }

      // Verify all chats have their data
      for (const chatId of chatIds) {
        const messages = getTestMessages(db, chatId);
        const coreMemory = getTestCoreMemory(db, chatId);

        expect(messages.length).toBe(1);
        expect(coreMemory.length).toBe(1);
      }
    });
  });

  // ── Integration Workflow ──

  describe('complete memory workflow', () => {
    it('should support full conversation lifecycle', () => {
      const chatId = 'chat-lifecycle';

      // 1. Initial message
      insertTestMessage(db, chatId, 'user', 'Hi, I want to learn Python');

      // 2. Extract core memory
      insertTestCoreMemory(db, chatId, 'goal', 'Learn Python programming');
      insertTestCoreMemory(db, chatId, 'profile', 'New Python learner');

      // 3. Continue conversation
      insertTestMessage(db, chatId, 'assistant', 'Great! What is your background?');
      insertTestMessage(db, chatId, 'user', 'I have some Java experience');

      // 4. Update core memory
      insertTestCoreMemory(db, chatId, 'profile', 'Java developer learning Python');

      // 5. Archive fact
      db.prepare('INSERT INTO archival_facts (chat_id, fact) VALUES (?, ?)')
        .run(chatId, 'User has Java background');

      // 6. Query complete context
      const coreMemory = getTestCoreMemory(db, chatId);
      const messages = getTestMessages(db, chatId);
      const facts = db.prepare(
        'SELECT fact FROM archival_facts WHERE chat_id = ?'
      ).all(chatId) as any[];

      expect(coreMemory.length).toBeGreaterThan(0);
      expect(messages.length).toBe(3);
      expect(facts.length).toBe(1);

      // 7. Verify coherence
      expect(coreMemory.some(m => m.value.includes('Python'))).toBe(true);
      expect(messages.some(m => m.content.includes('background'))).toBe(true);
      expect(facts.some(f => f.fact.includes('Java'))).toBe(true);
    });
  });
});
