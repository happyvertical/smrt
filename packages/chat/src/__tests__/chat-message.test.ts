/**
 * ChatMessage model and collection tests
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatMessageCollection } from '../collections/ChatMessageCollection.js';

describe('ChatMessage', () => {
  let dbPath: string;
  let messages: ChatMessageCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-chat-msg-test-${Date.now()}.db`);
    messages = (await ChatMessageCollection.create({
      db: { type: 'sqlite', url: dbPath },
    })) as ChatMessageCollection;
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Basic CRUD', () => {
    it('should create a message with defaults', async () => {
      const msg = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: 'Hello, world!',
      });

      expect(msg.id).toBeDefined();
      expect(msg.content).toBe('Hello, world!');
      expect(msg.messageType).toBe('text');
      expect(msg.role).toBe('user');
      expect(msg.isEdited).toBe(false);
      expect(msg.isDeleted).toBe(false);
    });

    it('should preserve data through save/load cycle', async () => {
      const msg = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: 'Test message',
        messageType: 'text',
        role: 'assistant',
        agentSessionId: 'session-1',
      });
      await msg.save();

      const loaded = await messages.get({ id: msg.id });
      expect(loaded).toBeDefined();
      expect(loaded?.content).toBe('Test message');
      expect(loaded?.role).toBe('assistant');
      expect(loaded?.agentSessionId).toBe('session-1');
    });
  });

  describe('Message Type Helpers', () => {
    it('should identify tool calls and results', async () => {
      const toolCall = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: '',
        messageType: 'tool_call',
        role: 'assistant',
      });

      const toolResult = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: '{"result": true}',
        messageType: 'tool_result',
        role: 'tool',
      });

      expect(toolCall.isToolCall()).toBe(true);
      expect(toolCall.isToolResult()).toBe(false);
      expect(toolCall.isFromAgent()).toBe(true);

      expect(toolResult.isToolResult()).toBe(true);
      expect(toolResult.isToolCall()).toBe(false);
    });

    it('should identify system messages', async () => {
      const sys = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'system',
        content: 'User joined the room',
        messageType: 'system',
        role: 'system',
      });

      expect(sys.isSystemMessage()).toBe(true);
      expect(sys.isFromAgent()).toBe(false);
    });
  });

  describe('Edit and Delete', () => {
    it('should edit a message', async () => {
      const msg = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: 'Original text',
      });
      await msg.save();

      await msg.edit('Updated text');

      const loaded = await messages.get({ id: msg.id });
      expect(loaded?.content).toBe('Updated text');
      expect(loaded?.isEdited).toBe(true);
      expect(loaded?.editedAt).toBeDefined();
    });

    it('should soft-delete a message', async () => {
      const msg = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: 'Secret message',
      });
      await msg.save();

      await msg.softDelete();

      const loaded = await messages.get({ id: msg.id });
      expect(loaded?.isDeleted).toBe(true);
      expect(loaded?.content).toBe('');
    });
  });

  describe('Attachments', () => {
    it('should manage attachments as JSON', async () => {
      const msg = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: 'See attached',
      });

      expect(msg.hasAttachments()).toBe(false);

      msg.setAttachments([
        {
          id: 'att-1',
          filename: 'doc.pdf',
          contentType: 'application/pdf',
          size: 1024,
        },
      ]);

      expect(msg.hasAttachments()).toBe(true);
      expect(msg.getAttachments()).toHaveLength(1);
      expect(msg.getAttachments()[0].filename).toBe('doc.pdf');
    });
  });

  describe('Preview', () => {
    it('should truncate long content for preview', async () => {
      const msg = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: 'A'.repeat(200),
      });

      const preview = msg.getPreview(50);
      expect(preview).toHaveLength(53); // 50 + '...'
      expect(preview.endsWith('...')).toBe(true);
    });

    it('should return (deleted) for soft-deleted messages', async () => {
      const msg = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'profile-1',
        content: 'Secret',
      });
      await msg.save();
      await msg.softDelete();

      expect(msg.getPreview()).toBe('(deleted)');
    });
  });

  describe('Collection Queries', () => {
    it('should get messages by room excluding threads and deleted', async () => {
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p1',
          content: 'Root message 1',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p1',
          content: 'Thread message',
          threadId: 'thread-1',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p1',
          content: 'Root message 2',
        })
      ).save();

      const deletedMsg = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'Deleted',
      });
      await deletedMsg.save();
      await deletedMsg.softDelete();

      const roomMessages = await messages.getByRoom('room-1');
      // Should have 2 root messages (thread and deleted excluded)
      expect(roomMessages).toHaveLength(2);
    });

    it('should get messages by thread', async () => {
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p1',
          content: 'Thread reply 1',
          threadId: 'thread-1',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p2',
          content: 'Thread reply 2',
          threadId: 'thread-1',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p1',
          content: 'Different thread',
          threadId: 'thread-2',
        })
      ).save();

      const threadMsgs = await messages.getByThread('thread-1');
      expect(threadMsgs).toHaveLength(2);
    });

    it('should search messages with filters', async () => {
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p1',
          content: 'Hello from Alice',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p2',
          content: 'Hello from Bob',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-2',
          senderProfileId: 'p1',
          content: 'Different room',
        })
      ).save();

      const results = await messages.search({
        roomId: 'room-1',
        query: 'Alice',
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Hello from Alice');
    });
  });
});
