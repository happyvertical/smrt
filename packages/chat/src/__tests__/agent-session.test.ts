/**
 * AgentSession model and collection tests
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentSessionCollection } from '../collections/AgentSessionCollection.js';

describe('AgentSession', () => {
  let dbPath: string;
  let sessions: AgentSessionCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-agent-session-test-${Date.now()}.db`);
    sessions = (await AgentSessionCollection.create({
      db: { type: 'sqlite', url: dbPath },
    })) as AgentSessionCollection;
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
    it('should create a session with defaults', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });

      expect(session.id).toBeDefined();
      expect(session.agentId).toBe('agent-1');
      expect(session.participantProfileId).toBe('profile-1');
      expect(session.status).toBe('active');
      expect(session.messageCount).toBe(0);
      expect(session.totalTokensUsed).toBe(0);
    });

    it('should preserve data through save/load cycle', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        chatRoomId: 'room-1',
        systemPrompt: 'You are a helpful assistant',
        maxTokens: 100000,
        maxMessages: 50,
      });
      await session.save();

      const loaded = await sessions.get({ id: session.id });
      expect(loaded).toBeDefined();
      expect(loaded?.chatRoomId).toBe('room-1');
      expect(loaded?.systemPrompt).toBe('You are a helpful assistant');
      expect(loaded?.maxTokens).toBe(100000);
      expect(loaded?.maxMessages).toBe(50);
    });
  });

  describe('Tool Management', () => {
    it('should get and set allowed tools', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });

      expect(session.getAllowedTools()).toEqual([]);

      session.setAllowedTools(['search', 'calculate', 'browse']);
      expect(session.getAllowedTools()).toEqual([
        'search',
        'calculate',
        'browse',
      ]);

      await session.save();

      const loaded = await sessions.get({ id: session.id });
      expect(loaded?.getAllowedTools()).toEqual([
        'search',
        'calculate',
        'browse',
      ]);
    });

    it('should handle malformed tool JSON gracefully', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        allowedTools: 'not-valid-json',
      });

      expect(session.getAllowedTools()).toEqual([]);
    });
  });

  describe('Session Lifecycle', () => {
    it('should track active status', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });

      expect(session.isActive()).toBe(true);
    });

    it('should close a session', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });
      await session.save();

      await session.close();

      expect(session.status).toBe('closed');
      expect(session.closedAt).toBeDefined();
      expect(session.isActive()).toBe(false);

      const loaded = await sessions.get({ id: session.id });
      expect(loaded?.status).toBe('closed');
    });

    it('should expire a session', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });
      await session.save();

      await session.expire();

      expect(session.status).toBe('expired');
      expect(session.isActive()).toBe(false);
    });

    it('should enforce max messages limit', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        maxMessages: 3,
      });

      expect(session.isActive()).toBe(true);

      await session.recordMessage(100);
      await session.recordMessage(100);
      expect(session.isActive()).toBe(true);
      expect(session.messageCount).toBe(2);

      await session.recordMessage(100);
      expect(session.isActive()).toBe(false);
      expect(session.messageCount).toBe(3);
    });

    it('should enforce max tokens limit', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        maxTokens: 500,
      });

      await session.recordMessage(200);
      expect(session.isActive()).toBe(true);
      expect(session.totalTokensUsed).toBe(200);

      await session.recordMessage(300);
      expect(session.isActive()).toBe(false);
      expect(session.totalTokensUsed).toBe(500);
    });

    it('should detect expired sessions by date', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        expiresAt: new Date(Date.now() - 1000), // Already expired
      });

      expect(session.isExpired()).toBe(true);
      expect(session.isActive()).toBe(false);
    });
  });

  describe('Context Management', () => {
    it('should update session context with merging', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        sessionContext: JSON.stringify({ step: 1, topic: 'weather' }),
      });
      await session.save();

      await session.updateSessionContext({ step: 2, location: 'NYC' });

      const loaded = await sessions.get({ id: session.id });
      expect(loaded?.getSessionContext()).toEqual({
        step: 2,
        topic: 'weather',
        location: 'NYC',
      });
    });
  });

  describe('Message Recording', () => {
    it('should increment message count and tokens', async () => {
      const session = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });
      await session.save();

      await session.recordMessage(150);
      await session.recordMessage(200);

      const loaded = await sessions.get({ id: session.id });
      expect(loaded?.messageCount).toBe(2);
      expect(loaded?.totalTokensUsed).toBe(350);
      expect(loaded?.lastMessageAt).toBeDefined();
    });
  });

  describe('Collection Queries', () => {
    it('should find active sessions by participant', async () => {
      await (
        await sessions.create({
          agentId: 'agent-1',
          participantProfileId: 'profile-1',
          status: 'active',
        })
      ).save();
      await (
        await sessions.create({
          agentId: 'agent-2',
          participantProfileId: 'profile-1',
          status: 'closed',
        })
      ).save();
      await (
        await sessions.create({
          agentId: 'agent-1',
          participantProfileId: 'profile-2',
          status: 'active',
        })
      ).save();

      const active = await sessions.findActiveByParticipant('profile-1');
      expect(active).toHaveLength(1);
      expect(active[0].agentId).toBe('agent-1');
    });

    it('should find or create a session (idempotent)', async () => {
      const s1 = await sessions.findOrCreate({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        tenantId: 'tenant-1',
      });
      await s1.save();

      const s2 = await sessions.findOrCreate({
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        tenantId: 'tenant-1',
      });

      expect(s2.id).toBe(s1.id);
    });

    it('should expire stale sessions by lastMessageAt', async () => {
      const s1 = await sessions.create({
        agentId: 'agent-1',
        participantProfileId: 'p1',
        status: 'active',
      });
      // Simulate old message
      s1.lastMessageAt = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      await s1.save();

      const s2 = await sessions.create({
        agentId: 'agent-2',
        participantProfileId: 'p1',
        status: 'active',
      });
      s2.lastMessageAt = new Date(); // just now
      await s2.save();

      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const expired = await sessions.expireStale(oneHourAgo);

      expect(expired).toBe(1);

      const loaded = await sessions.get({ id: s1.id });
      expect(loaded?.status).toBe('expired');

      const loaded2 = await sessions.get({ id: s2.id });
      expect(loaded2?.status).toBe('active');
    });

    it('should expire sessions with no messages using created_at', async () => {
      // Session with no messages at all — should still be expirable
      await sessions.create({
        agentId: 'agent-old',
        participantProfileId: 'p1',
        status: 'active',
      });

      // Expire anything "older than 1 second from now in the future" — everything
      const future = new Date(Date.now() + 1000);
      const expired = await sessions.expireStale(future);

      expect(expired).toBe(1);
    });

    it('should find sessions by agent', async () => {
      await (
        await sessions.create({
          agentId: 'agent-1',
          participantProfileId: 'p1',
        })
      ).save();
      await (
        await sessions.create({
          agentId: 'agent-1',
          participantProfileId: 'p2',
        })
      ).save();
      await (
        await sessions.create({
          agentId: 'agent-2',
          participantProfileId: 'p1',
        })
      ).save();

      const found = await sessions.findByAgent('agent-1');
      expect(found).toHaveLength(2);
    });
  });
});
