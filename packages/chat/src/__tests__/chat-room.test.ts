/**
 * ChatRoom model and collection tests
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatParticipantCollection } from '../collections/ChatParticipantCollection.js';
import { ChatRoomCollection } from '../collections/ChatRoomCollection.js';

describe('ChatRoom', () => {
  let dbPath: string;
  let rooms: ChatRoomCollection;
  let participants: ChatParticipantCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-chat-room-test-${Date.now()}.db`);
    const db = { type: 'sqlite' as const, url: dbPath };
    rooms = (await ChatRoomCollection.create({ db })) as ChatRoomCollection;
    participants = (await ChatParticipantCollection.create({
      db,
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
    it('should create a room with defaults', async () => {
      const room = await rooms.create({
        tenantId: 'tenant-1',
        name: 'General',
        roomType: 'public',
        createdByProfileId: 'profile-1',
      });

      expect(room.id).toBeDefined();
      expect(room.name).toBe('General');
      expect(room.roomType).toBe('public');
      expect(room.status).toBe('active');
      expect(room.createdByProfileId).toBe('profile-1');
      expect(room.isArchived).toBe(false);
    });

    it('should preserve data through save/load cycle', async () => {
      const room = await rooms.create({
        tenantId: 'tenant-1',
        name: 'Engineering',
        description: 'Engineering team chat',
        roomType: 'private',
        topic: 'Sprint planning',
        createdByProfileId: 'profile-1',
        maxParticipants: 50,
      });
      await room.save();

      const loaded = await rooms.get({ id: room.id });
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Engineering');
      expect(loaded?.description).toBe('Engineering team chat');
      expect(loaded?.roomType).toBe('private');
      expect(loaded?.topic).toBe('Sprint planning');
      expect(loaded?.maxParticipants).toBe(50);
    });

    it('should update room fields', async () => {
      const room = await rooms.create({
        tenantId: 'tenant-1',
        name: 'Old Name',
        roomType: 'public',
        createdByProfileId: 'profile-1',
      });
      await room.save();

      room.name = 'New Name';
      room.topic = 'New topic';
      await room.save();

      const loaded = await rooms.get({ id: room.id });
      expect(loaded?.name).toBe('New Name');
      expect(loaded?.topic).toBe('New topic');
    });

    it('should delete a room', async () => {
      const room = await rooms.create({
        tenantId: 'tenant-1',
        name: 'To Delete',
        roomType: 'public',
        createdByProfileId: 'profile-1',
      });
      await room.save();

      await room.delete();

      const loaded = await rooms.get({ id: room.id });
      expect(loaded).toBeNull();
    });
  });

  describe('Room Type Helpers', () => {
    it('should identify room types correctly', async () => {
      const publicRoom = await rooms.create({
        tenantId: 'tenant-1',
        name: 'Public',
        roomType: 'public',
        createdByProfileId: 'p1',
      });
      const dmRoom = await rooms.create({
        tenantId: 'tenant-1',
        name: 'DM',
        roomType: 'dm',
        createdByProfileId: 'p1',
      });
      const agentRoom = await rooms.create({
        tenantId: 'tenant-1',
        name: 'Agent',
        roomType: 'agent',
        createdByProfileId: 'p1',
      });

      expect(publicRoom.isPublic()).toBe(true);
      expect(publicRoom.isDM()).toBe(false);
      expect(publicRoom.isAgentRoom()).toBe(false);

      expect(dmRoom.isDM()).toBe(true);
      expect(dmRoom.isPublic()).toBe(false);

      expect(agentRoom.isAgentRoom()).toBe(true);
      expect(agentRoom.isPublic()).toBe(false);
    });
  });

  describe('Archive/Unarchive', () => {
    it('should archive and unarchive a room', async () => {
      const room = await rooms.create({
        tenantId: 'tenant-1',
        name: 'Archivable',
        roomType: 'public',
        createdByProfileId: 'p1',
      });
      await room.save();

      expect(room.isActive()).toBe(true);

      await room.archive();
      expect(room.isArchived).toBe(true);
      expect(room.status).toBe('archived');
      expect(room.isActive()).toBe(false);

      const archived = await rooms.get({ id: room.id });
      expect(archived?.isArchived).toBe(true);
      expect(archived?.status).toBe('archived');

      await room.unarchive();
      expect(room.isArchived).toBe(false);
      expect(room.status).toBe('active');
      expect(room.isActive()).toBe(true);
    });
  });

  describe('Collection Queries', () => {
    it('should find rooms by type', async () => {
      await (
        await rooms.create({
          tenantId: 'tenant-1',
          name: 'Public 1',
          roomType: 'public',
          createdByProfileId: 'p1',
        })
      ).save();
      await (
        await rooms.create({
          tenantId: 'tenant-1',
          name: 'Public 2',
          roomType: 'public',
          createdByProfileId: 'p1',
        })
      ).save();
      await (
        await rooms.create({
          tenantId: 'tenant-1',
          name: 'DM 1',
          roomType: 'dm',
          createdByProfileId: 'p1',
        })
      ).save();

      const publicRooms = await rooms.findPublic();
      expect(publicRooms).toHaveLength(2);

      const dmRooms = await rooms.findDMs();
      expect(dmRooms).toHaveLength(1);
    });

    it('should search rooms by name/description/topic', async () => {
      await (
        await rooms.create({
          tenantId: 'tenant-1',
          name: 'Engineering',
          description: 'For the engineering team',
          roomType: 'public',
          createdByProfileId: 'p1',
        })
      ).save();
      await (
        await rooms.create({
          tenantId: 'tenant-1',
          name: 'Marketing',
          description: 'Marketing discussions',
          roomType: 'public',
          createdByProfileId: 'p1',
        })
      ).save();

      const results = await rooms.search('engineer');
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe('Engineering');
    });

    it('should find or create DM room (identity derived from participants)', async () => {
      const attach = async (roomId: string, profileId: string) => {
        await participants.create({
          tenantId: 'tenant-1',
          roomId,
          profileId,
          role: 'member',
          status: 'active',
          joinedAt: new Date(),
        });
      };

      const dm1 = await rooms.findOrCreateDM(
        'profile-a',
        'profile-b',
        'tenant-1',
        participants,
      );
      expect(dm1.roomType).toBe('dm');
      // Membership is established via the join (as ChatService.getOrCreateDM does).
      await attach(dm1.id as string, 'profile-a');
      await attach(dm1.id as string, 'profile-b');

      // Should return existing on second call
      const dm2 = await rooms.findOrCreateDM(
        'profile-a',
        'profile-b',
        'tenant-1',
        participants,
      );
      expect(dm2.id).toBe(dm1.id);

      // Reverse order should also find same room
      const dm3 = await rooms.findOrCreateDM(
        'profile-b',
        'profile-a',
        'tenant-1',
        participants,
      );
      expect(dm3.id).toBe(dm1.id);
    });
  });
});
