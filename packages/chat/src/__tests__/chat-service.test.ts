/**
 * ChatService orchestration layer tests
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../services/ChatService.js';

describe('ChatService', () => {
  let dbPath: string;
  let chat: ChatService;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-chat-service-test-${Date.now()}.db`);
    chat = await ChatService.create({
      db: { type: 'sqlite', url: dbPath },
    });
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

  describe('Room Management', () => {
    it('should create a room and add creator as owner', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'General',
        roomType: 'public',
        createdByProfileId: 'profile-1',
      });

      expect(room.name).toBe('General');
      expect(room.roomType).toBe('public');

      // Creator should be added as owner participant
      const membership = await chat.participants.findMembership(
        room.id as string,
        'profile-1',
      );
      expect(membership).toBeDefined();
      expect(membership?.role).toBe('owner');
    });

    it('should create room with description and topic', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Engineering',
        roomType: 'private',
        createdByProfileId: 'profile-1',
        description: 'Engineering team discussion',
        topic: 'Sprint 42',
      });

      expect(room.description).toBe('Engineering team discussion');
      expect(room.topic).toBe('Sprint 42');
    });
  });

  describe('Messaging', () => {
    it('should send a message and update room timestamps', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Test Room',
        roomType: 'public',
        createdByProfileId: 'profile-1',
      });

      const message = await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        senderProfileId: 'profile-1',
        content: 'Hello, world!',
      });

      expect(message.content).toBe('Hello, world!');
      expect(message.messageType).toBe('text');
      expect(message.role).toBe('user');

      // Room's lastMessageAt should be updated
      const updatedRoom = await chat.rooms.get({ id: room.id });
      expect(updatedRoom?.lastMessageAt).toBeDefined();
    });

    it('should send threaded messages and update thread stats', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Test Room',
        roomType: 'public',
        createdByProfileId: 'profile-1',
      });

      // Send root message
      const rootMsg = await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        senderProfileId: 'profile-1',
        content: 'Root message',
      });

      // Start a thread
      const thread = await chat.startThread({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        rootMessageId: rootMsg.id as string,
        title: 'Discussion',
      });

      expect(thread.messageCount).toBe(0);

      // Send message in thread
      await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        senderProfileId: 'profile-2',
        content: 'Thread reply',
        threadId: thread.id as string,
      });

      // Thread stats should be updated
      const updatedThread = await chat.threads.get({ id: thread.id });
      expect(updatedThread?.messageCount).toBe(1);
      expect(updatedThread?.lastMessageAt).toBeDefined();
    });
  });

  describe('Participants', () => {
    it('should add a participant to a room', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Test Room',
        roomType: 'public',
        createdByProfileId: 'profile-1',
      });

      const participant = await chat.addParticipant({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        profileId: 'profile-2',
      });

      expect(participant.profileId).toBe('profile-2');
      expect(participant.role).toBe('member');
    });

    it('should be idempotent when adding existing active participant', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Test Room',
        roomType: 'public',
        createdByProfileId: 'profile-1',
      });

      const p1 = await chat.addParticipant({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        profileId: 'profile-2',
      });

      const p2 = await chat.addParticipant({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        profileId: 'profile-2',
      });

      expect(p2.id).toBe(p1.id);
    });
  });

  describe('Direct Messages', () => {
    it('should get or create a DM room', async () => {
      const room = await chat.getOrCreateDM({
        tenantId: 'tenant-1',
        profileId1: 'profile-a',
        profileId2: 'profile-b',
      });

      expect(room.roomType).toBe('dm');

      // Both profiles should be participants
      const membership1 = await chat.participants.findMembership(
        room.id as string,
        'profile-a',
      );
      const membership2 = await chat.participants.findMembership(
        room.id as string,
        'profile-b',
      );
      expect(membership1).toBeDefined();
      expect(membership2).toBeDefined();
    });

    it('should return same DM room on repeated calls', async () => {
      const room1 = await chat.getOrCreateDM({
        tenantId: 'tenant-1',
        profileId1: 'profile-a',
        profileId2: 'profile-b',
      });

      const room2 = await chat.getOrCreateDM({
        tenantId: 'tenant-1',
        profileId1: 'profile-a',
        profileId2: 'profile-b',
      });

      expect(room2.id).toBe(room1.id);
    });
  });

  describe('Agent Sessions', () => {
    it('should create an agent session with linked room', async () => {
      const { session, room } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        allowedTools: ['search', 'calculate'],
        systemPrompt: 'You are a helpful assistant',
      });

      expect(session.agentId).toBe('agent-1');
      expect(session.getAllowedTools()).toEqual(['search', 'calculate']);
      expect(session.systemPrompt).toBe('You are a helpful assistant');
      expect(session.chatRoomId).toBe(room.id);

      expect(room.roomType).toBe('agent');

      // Profile should be a participant in the room
      const membership = await chat.participants.findMembership(
        room.id as string,
        'profile-1',
      );
      expect(membership).toBeDefined();
      expect(membership?.role).toBe('owner');
    });

    it('should return existing session when called twice', async () => {
      const result1 = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });

      const result2 = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });

      // Should return the same session and room (no orphaned rooms)
      expect(result2.session.id).toBe(result1.session.id);
      expect(result2.room.id).toBe(result1.room.id);

      // Verify only one agent room was created
      const agentRooms = await chat.rooms.findAgentRooms();
      expect(agentRooms).toHaveLength(1);
    });

    it('should send messages within an agent session', async () => {
      const { session, room } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });

      // User sends a message
      const userMsg = await chat.sendAgentMessage({
        tenantId: 'tenant-1',
        agentSessionId: session.id as string,
        senderProfileId: 'profile-1',
        content: 'What is the weather?',
        role: 'user',
      });

      expect(userMsg.roomId).toBe(room.id);
      expect(userMsg.agentSessionId).toBe(session.id);
      expect(userMsg.role).toBe('user');

      // Agent responds
      const agentMsg = await chat.sendAgentMessage({
        tenantId: 'tenant-1',
        agentSessionId: session.id as string,
        senderProfileId: 'agent-1',
        content: 'The weather is sunny.',
        role: 'assistant',
      });

      expect(agentMsg.role).toBe('assistant');
    });

    it('should reject messages to closed sessions', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });

      await session.close();

      await expect(
        chat.sendAgentMessage({
          tenantId: 'tenant-1',
          agentSessionId: session.id as string,
          senderProfileId: 'profile-1',
          content: 'Hello',
          role: 'user',
        }),
      ).rejects.toThrow('Agent session is not active');
    });

    it('should create session with max limits', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        maxTokens: 10000,
        maxMessages: 20,
      });

      expect(session.maxTokens).toBe(10000);
      expect(session.maxMessages).toBe(20);
    });
  });
});
