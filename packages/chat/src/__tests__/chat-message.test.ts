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

      const roomMessages = await messages.getByRoom('room-1', 'tenant-1');
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

      const threadMsgs = await messages.getByThread('thread-1', 'tenant-1');
      expect(threadMsgs).toHaveLength(2);
    });

    it('should count unread messages excluding thread replies', async () => {
      const msg1 = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'Root message 1',
      });

      // Small delay to ensure distinct created_at timestamps
      await new Promise((r) => setTimeout(r, 10));

      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'Root message 2',
      });

      // Thread reply should NOT count toward unread
      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p2',
        content: 'Thread reply',
        threadId: 'thread-1',
      });

      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p2',
        content: 'Root message 3',
      });

      // Unread since msg1 — should be 2 (msg2 + msg3, not thread reply)
      const unread = await messages.getUnreadCount(
        'room-1',
        'tenant-1',
        msg1.id as string,
      );
      expect(unread).toBe(2);
    });

    it('should return total count when no lastReadMessageId', async () => {
      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'Message 1',
      });
      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'Message 2',
      });
      // Thread reply should still be excluded
      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p2',
        content: 'Thread reply',
        threadId: 'thread-1',
      });

      const unread = await messages.getUnreadCount('room-1', 'tenant-1', null);
      expect(unread).toBe(2);
    });

    it('should get latest message per room', async () => {
      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'First in room 1',
      });

      // Small delay to ensure distinct created_at timestamps
      await new Promise((r) => setTimeout(r, 10));

      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'Latest in room 1',
      });
      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-2',
        senderProfileId: 'p1',
        content: 'Only in room 2',
      });

      const latest = await messages.getLatestPerRoom(
        ['room-1', 'room-2'],
        'tenant-1',
      );
      expect(latest.size).toBe(2);
      expect(latest.get('room-1')?.content).toBe('Latest in room 1');
      expect(latest.get('room-2')?.content).toBe('Only in room 2');
    });

    it('should filter by hasAttachments in search', async () => {
      const withAtt = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'Has attachment',
      });
      withAtt.setAttachments([
        {
          id: 'att-1',
          filename: 'file.txt',
          contentType: 'text/plain',
          size: 100,
        },
      ]);
      await withAtt.save();

      await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'No attachment',
      });

      const withAttResults = await messages.search({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        hasAttachments: true,
      });
      expect(withAttResults).toHaveLength(1);
      expect(withAttResults[0].content).toBe('Has attachment');

      const noAttResults = await messages.search({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        hasAttachments: false,
      });
      expect(noAttResults).toHaveLength(1);
      expect(noAttResults[0].content).toBe('No attachment');
    });

    // Regression (S5 #1392): the attachment predicate MUST be pushed into SQL so
    // the LIMIT applies to the FILTERED set. Previously the limit truncated the
    // newest-N window first and the JS attachment filter ran afterwards, so a
    // room whose newest messages all lacked attachments returned ZERO
    // attachment-bearing rows even though older ones existed.
    it('applies limit to the attachment-filtered set, not the raw window', async () => {
      // One old message WITH an attachment, then many newer ones WITHOUT.
      const withAtt = await messages.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        senderProfileId: 'p1',
        content: 'Old message with attachment',
      });
      withAtt.setAttachments([
        {
          id: 'att-1',
          filename: 'file.txt',
          contentType: 'text/plain',
          size: 100,
        },
      ]);
      await withAtt.save();

      // 5 newer attachment-free messages so any small limit, applied before the
      // filter, would consume only these and miss the older bearing row.
      for (let i = 0; i < 5; i++) {
        await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p1',
          content: `Newer message ${i}`,
        });
      }

      const results = await messages.search({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        hasAttachments: true,
        limit: 2,
      });

      // The single attachment-bearing message must surface despite the limit.
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Old message with attachment');
    });

    it('caps the attachment-filtered result at the requested limit', async () => {
      // 3 attachment-bearing messages; limit 2 must return exactly 2.
      for (let i = 0; i < 3; i++) {
        const m = await messages.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          senderProfileId: 'p1',
          content: `Attachment ${i}`,
        });
        m.setAttachments([
          {
            id: `att-${i}`,
            filename: `file-${i}.txt`,
            contentType: 'text/plain',
            size: 10,
          },
        ]);
        await m.save();
      }

      const results = await messages.search({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        hasAttachments: true,
        limit: 2,
      });

      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r.hasAttachments()).toBe(true);
      }
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
        tenantId: 'tenant-1',
        roomId: 'room-1',
        query: 'Alice',
      });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('Hello from Alice');
    });
  });

  // Regression (S5 #1392): room/thread/session ids are NOT globally unique, so
  // the read helpers MUST bind tenantId. Two tenants sharing the SAME room id
  // must never see each other's messages.
  describe('Tenant-bound reads', () => {
    async function seedSameRoomTwoTenants() {
      // Same roomId 'room-shared' in two tenants; same threadId / sessionId too.
      // Each tenant gets exactly ONE root message (threadId null) plus one
      // thread reply and one threaded session message so the root-only helpers
      // (getByRoom / getUnreadCount) see a single root per tenant.
      await (
        await messages.create({
          tenantId: 'tenant-a',
          roomId: 'room-shared',
          senderProfileId: 'pa',
          content: 'A root',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-a',
          roomId: 'room-shared',
          senderProfileId: 'pa',
          content: 'A thread',
          threadId: 'thread-shared',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-a',
          roomId: 'room-shared',
          senderProfileId: 'pa',
          content: 'A session',
          threadId: 'thread-shared',
          agentSessionId: 'session-shared',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-b',
          roomId: 'room-shared',
          senderProfileId: 'pb',
          content: 'B root',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-b',
          roomId: 'room-shared',
          senderProfileId: 'pb',
          content: 'B thread',
          threadId: 'thread-shared',
        })
      ).save();
      await (
        await messages.create({
          tenantId: 'tenant-b',
          roomId: 'room-shared',
          senderProfileId: 'pb',
          content: 'B session',
          threadId: 'thread-shared',
          agentSessionId: 'session-shared',
        })
      ).save();
    }

    it('getByRoom never returns another tenant messages for a same-id room', async () => {
      await seedSameRoomTwoTenants();

      const aRoom = await messages.getByRoom('room-shared', 'tenant-a');
      expect(aRoom).toHaveLength(1);
      expect(aRoom[0].content).toBe('A root');

      const bRoom = await messages.getByRoom('room-shared', 'tenant-b');
      expect(bRoom).toHaveLength(1);
      expect(bRoom[0].content).toBe('B root');
    });

    it('getByThread, getByAgentSession, search, getUnreadCount, getLatestPerRoom are tenant-bound', async () => {
      await seedSameRoomTwoTenants();

      const aThread = await messages.getByThread('thread-shared', 'tenant-a');
      expect(aThread.every((m) => m.tenantId === 'tenant-a')).toBe(true);
      expect(aThread.map((m) => m.content).sort()).toEqual([
        'A session',
        'A thread',
      ]);

      const aSession = await messages.getByAgentSession(
        'session-shared',
        'tenant-a',
      );
      expect(aSession.map((m) => m.content)).toEqual(['A session']);

      const aSearch = await messages.search({
        tenantId: 'tenant-a',
        roomId: 'room-shared',
      });
      expect(aSearch.every((m) => m.tenantId === 'tenant-a')).toBe(true);
      expect(aSearch.map((m) => m.content).sort()).toEqual([
        'A root',
        'A session',
        'A thread',
      ]);

      // tenant-a has only the single root message (threadId null) in the room
      const aUnread = await messages.getUnreadCount(
        'room-shared',
        'tenant-a',
        null,
      );
      expect(aUnread).toBe(1);

      const latest = await messages.getLatestPerRoom(
        ['room-shared'],
        'tenant-b',
      );
      expect(latest.get('room-shared')?.content).toBe('B root');
    });
  });
});
