/**
 * ChatParticipant model and collection tests
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatParticipantCollection } from '../collections/ChatParticipantCollection.js';

describe('ChatParticipant', () => {
  let dbPath: string;
  let participants: ChatParticipantCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-chat-participant-test-${Date.now()}.db`);
    participants = (await ChatParticipantCollection.create({
      db: { type: 'sqlite', url: dbPath },
    })) as ChatParticipantCollection;
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
    it('should create a participant with defaults', async () => {
      const p = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'profile-1',
      });

      expect(p.id).toBeDefined();
      expect(p.roomId).toBe('room-1');
      expect(p.profileId).toBe('profile-1');
      expect(p.role).toBe('member');
      expect(p.status).toBe('active');
      expect(p.onlineStatus).toBe('offline');
      expect(p.isMuted).toBe(false);
      expect(p.isPinned).toBe(false);
    });

    it('should preserve data through save/load', async () => {
      const p = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'profile-1',
        role: 'admin',
        nickname: 'Alice',
        isMuted: true,
      });
      await p.save();

      const loaded = await participants.get({ id: p.id });
      expect(loaded?.role).toBe('admin');
      expect(loaded?.nickname).toBe('Alice');
      expect(loaded?.isMuted).toBe(true);
    });
  });

  describe('Role Helpers', () => {
    it('should identify owners and admins', async () => {
      const owner = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p1',
        role: 'owner',
      });
      const admin = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p2',
        role: 'admin',
      });
      const member = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p3',
        role: 'member',
      });

      expect(owner.isOwner()).toBe(true);
      expect(owner.isAdmin()).toBe(true); // Owner is also admin
      expect(admin.isOwner()).toBe(false);
      expect(admin.isAdmin()).toBe(true);
      expect(member.isOwner()).toBe(false);
      expect(member.isAdmin()).toBe(false);
    });
  });

  describe('Status Management', () => {
    it('should leave a room', async () => {
      const p = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p1',
      });
      await p.save();

      expect(p.isActive()).toBe(true);

      await p.leave();

      expect(p.status).toBe('left');
      expect(p.isActive()).toBe(false);

      const loaded = await participants.get({ id: p.id });
      expect(loaded?.status).toBe('left');
    });

    it('should update online status', async () => {
      const p = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p1',
      });
      await p.save();

      await p.setOnline('online');

      const loaded = await participants.get({ id: p.id });
      expect(loaded?.onlineStatus).toBe('online');
      expect(loaded?.lastSeenAt).toBeDefined();
    });

    it('should mark messages as read', async () => {
      const p = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p1',
      });
      await p.save();

      await p.markRead('msg-42');

      const loaded = await participants.get({ id: p.id });
      expect(loaded?.lastReadMessageId).toBe('msg-42');
      expect(loaded?.lastSeenAt).toBeDefined();
    });
  });

  describe('Collection Queries', () => {
    it('should find membership for a profile in a room', async () => {
      await (
        await participants.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          profileId: 'p1',
        })
      ).save();
      await (
        await participants.create({
          tenantId: 'tenant-1',
          roomId: 'room-2',
          profileId: 'p1',
        })
      ).save();

      const found = await participants.findMembership('room-1', 'p1');
      expect(found).toBeDefined();
      expect(found?.roomId).toBe('room-1');
      expect(found?.profileId).toBe('p1');

      const notFound = await participants.findMembership('room-3', 'p1');
      expect(notFound).toBeNull();
    });

    it('should get participants by room', async () => {
      await (
        await participants.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          profileId: 'p1',
        })
      ).save();
      await (
        await participants.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          profileId: 'p2',
        })
      ).save();
      await (
        await participants.create({
          tenantId: 'tenant-1',
          roomId: 'room-2',
          profileId: 'p3',
        })
      ).save();

      const roomParticipants = await participants.getByRoom('room-1');
      expect(roomParticipants).toHaveLength(2);
    });

    it('should count participants in a room', async () => {
      await (
        await participants.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          profileId: 'p1',
        })
      ).save();
      await (
        await participants.create({
          tenantId: 'tenant-1',
          roomId: 'room-1',
          profileId: 'p2',
        })
      ).save();

      const leftParticipant = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p3',
        status: 'left',
      });
      await leftParticipant.save();

      const count = await participants.countInRoom('room-1');
      expect(count).toBe(2); // Only active participants
    });

    it('should get online participants', async () => {
      const p1 = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p1',
        onlineStatus: 'online',
      });
      await p1.save();

      const p2 = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p2',
        onlineStatus: 'offline',
      });
      await p2.save();

      const p3 = await participants.create({
        tenantId: 'tenant-1',
        roomId: 'room-1',
        profileId: 'p3',
        onlineStatus: 'away',
      });
      await p3.save();

      const online = await participants.getOnlineInRoom('room-1');
      expect(online).toHaveLength(2); // online + away
    });
  });
});
