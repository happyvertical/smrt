/**
 * ChatThread model and collection tests
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatThreadCollection } from '../collections/ChatThreadCollection.js';

describe('ChatThread', () => {
  let dbPath: string;
  let threads: ChatThreadCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-chat-thread-test-${Date.now()}.db`);
    threads = (await ChatThreadCollection.create({
      db: { type: 'sqlite', url: dbPath },
    })) as ChatThreadCollection;
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
    it('should create a thread with defaults', async () => {
      const thread = await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-1',
      });

      expect(thread.id).toBeDefined();
      expect(thread.roomId).toBe('room-1');
      expect(thread.rootMessageId).toBe('msg-1');
      expect(thread.isResolved).toBe(false);
      expect(thread.messageCount).toBe(0);
      expect(thread.participantCount).toBe(0);
    });

    it('should preserve data through save/load cycle', async () => {
      const thread = await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-1',
        title: 'Bug Discussion',
        messageCount: 5,
        participantCount: 3,
      });

      const loaded = await threads.get({ id: thread.id });
      expect(loaded).toBeDefined();
      expect(loaded?.title).toBe('Bug Discussion');
      expect(loaded?.messageCount).toBe(5);
      expect(loaded?.participantCount).toBe(3);
    });
  });

  describe('Resolve/Reopen', () => {
    it('should resolve a thread', async () => {
      const thread = await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-1',
      });

      expect(thread.isResolved).toBe(false);

      await thread.resolve();

      expect(thread.isResolved).toBe(true);

      const loaded = await threads.get({ id: thread.id });
      expect(loaded?.isResolved).toBe(true);
    });

    it('should reopen a resolved thread', async () => {
      const thread = await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-1',
      });

      await thread.resolve();
      expect(thread.isResolved).toBe(true);

      await thread.reopen();
      expect(thread.isResolved).toBe(false);

      const loaded = await threads.get({ id: thread.id });
      expect(loaded?.isResolved).toBe(false);
    });
  });

  describe('Collection Queries', () => {
    it('should get threads by room', async () => {
      await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-1',
      });
      await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-2',
      });
      await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-2',
        rootMessageId: 'msg-3',
      });

      const roomThreads = await threads.getByRoom('room-1');
      expect(roomThreads).toHaveLength(2);
    });

    it('should get active (unresolved) threads for a room', async () => {
      const t1 = await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-1',
      });
      await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-2',
      });

      await t1.resolve();

      const active = await threads.getActive('room-1');
      expect(active).toHaveLength(1);
      expect(active[0].rootMessageId).toBe('msg-2');
    });

    it('should get all unresolved threads across rooms', async () => {
      await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-1',
      });
      const t2 = await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-2',
        rootMessageId: 'msg-2',
      });
      await threads.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        rootMessageId: 'msg-3',
      });

      await t2.resolve();

      const unresolved = await threads.getUnresolved();
      expect(unresolved).toHaveLength(2);
    });
  });
});
