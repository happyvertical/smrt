/**
 * S5 security-audit regression tests (#1392).
 *
 * Covers:
 *  - room-membership authorization on sends and reads (IDOR within a tenant)
 *  - fail-closed agent tool-call whitelist enforcement
 *  - DM identity derived from the chat_participants join (not client metadata)
 *  - caller-scoped expireStale
 *  - generated CRUD surface cannot mutate internal chat models (the membership/
 *    owner checks live in ChatService, so generated create/update/delete on the
 *    raw collection routes would bypass them entirely)
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatService } from '../services/ChatService.js';

const MUTATING_OPS = ['create', 'update', 'delete'] as const;

/**
 * Resolve the registered `@smrt()` surface (`api` / `mcp` include lists) for a
 * chat model. Mirrors how the REST/MCP generators read the config: a list with
 * explicit `include` only emits those operations.
 */
type SurfaceConfig = {
  api?: boolean | { include?: string[] };
  mcp?: boolean | { include?: string[] };
};

/** Mirror how the REST/MCP generators read an `api`/`mcp` config value. */
function surfaceFromConfig(config: SurfaceConfig): {
  api: string[] | null;
  mcp: string[] | null;
} {
  const toInclude = (
    surface: boolean | { include?: string[] } | undefined,
  ): string[] | null => {
    if (surface === false || surface === undefined) return [];
    if (surface === true) return null; // generates the full CRUD surface
    return surface.include ?? null;
  };
  return { api: toInclude(config.api), mcp: toInclude(config.mcp) };
}

function generatedSurface(qualifiedName: string): {
  api: string[] | null;
  mcp: string[] | null;
} {
  const registered = ObjectRegistry.getClass(qualifiedName);
  if (!registered) {
    throw new Error(`Model not registered: ${qualifiedName}`);
  }
  return surfaceFromConfig(registered.config as SurfaceConfig);
}

describe('chat security (S5 #1392)', () => {
  let dbPath: string;
  let chat: ChatService;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-chat-security-test-${Date.now()}.db`);
    chat = await ChatService.create({ db: { type: 'sqlite', url: dbPath } });
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  describe('room-membership authorization on send', () => {
    it('allows an active member to send', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'General',
        roomType: 'public',
        createdByProfileId: 'owner',
      });

      const msg = await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        content: 'hi',
      });
      expect(msg.id).toBeDefined();
    });

    it('rejects a non-member sending into the room (IDOR)', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Private',
        roomType: 'private',
        createdByProfileId: 'owner',
      });

      await expect(
        chat.sendMessage({
          tenantId: 'tenant-1',
          roomId: room.id as string,
          actorProfileId: 'intruder',
          content: 'sneaking in',
        }),
      ).rejects.toThrow(/not an active member/i);
    });

    it('rejects a member who has left/been kicked', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });
      const participant = await chat.addParticipant({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        profileId: 'member',
      });

      // member can send while active
      await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'member',
        content: 'while active',
      });

      // kick them
      participant.status = 'kicked';
      await participant.save();

      await expect(
        chat.sendMessage({
          tenantId: 'tenant-1',
          roomId: room.id as string,
          actorProfileId: 'member',
          content: 'after kick',
        }),
      ).rejects.toThrow(/not an active member/i);
    });
  });

  describe('room-membership authorization on read', () => {
    it('lets a member read room messages', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });
      await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        content: 'secret',
      });

      const msgs = await chat.getRoomMessages({
        roomId: room.id as string,
        profileId: 'owner',
        tenantId: 'tenant-1',
      });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('secret');
    });

    it('rejects a non-member reading room messages', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });
      await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        content: 'secret',
      });

      await expect(
        chat.getRoomMessages({
          roomId: room.id as string,
          profileId: 'intruder',
          tenantId: 'tenant-1',
        }),
      ).rejects.toThrow(/not an active member/i);
    });

    it('rejects a non-member loading the room', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });

      await expect(
        chat.getRoomForMember(room.id as string, 'intruder', 'tenant-1'),
      ).rejects.toThrow(/not an active member/i);

      // member is fine
      const loaded = await chat.getRoomForMember(
        room.id as string,
        'owner',
        'tenant-1',
      );
      expect(loaded?.id).toBe(room.id);
    });
  });

  describe('agent tool whitelist (fail-closed)', () => {
    it('allows a whitelisted tool call', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        allowedTools: ['search'],
      });

      const msg = await chat.sendAgentReply({
        tenantId: 'tenant-1',
        agentSessionId: session.id as string,
        content: 'searching',
        kind: 'tool',
        messageType: 'tool_call',
        toolCallData: { name: 'search', args: { q: 'x' } },
      });
      expect(msg.id).toBeDefined();
    });

    it('rejects a tool call NOT on the whitelist', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        allowedTools: ['search'],
      });

      await expect(
        chat.sendAgentReply({
          tenantId: 'tenant-1',
          agentSessionId: session.id as string,
          content: 'rm -rf',
          kind: 'tool',
          messageType: 'tool_call',
          toolCallData: { name: 'exec_shell', args: {} },
        }),
      ).rejects.toThrow(/not allowed/i);
    });

    it('rejects ALL tool calls when the whitelist is empty (fail-closed)', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        // no allowedTools => empty whitelist
      });
      expect(session.getAllowedTools()).toEqual([]);
      expect(session.isToolAllowed('search')).toBe(false);

      await expect(
        chat.sendAgentReply({
          tenantId: 'tenant-1',
          agentSessionId: session.id as string,
          content: 'searching',
          kind: 'tool',
          messageType: 'tool_call',
          toolCallData: { name: 'search' },
        }),
      ).rejects.toThrow(/not allowed/i);
    });

    it('rejects a tool call missing a tool name', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        allowedTools: ['search'],
      });

      await expect(
        chat.sendAgentReply({
          tenantId: 'tenant-1',
          agentSessionId: session.id as string,
          content: 'no name',
          kind: 'tool',
          messageType: 'tool_call',
          toolCallData: { args: {} },
        }),
      ).rejects.toThrow(/missing a tool name/i);
    });

    it('does not gate ordinary assistant/user messages', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        // empty whitelist must NOT block plain text messages
      });

      const userMsg = await chat.sendAgentUserMessage({
        tenantId: 'tenant-1',
        agentSessionId: session.id as string,
        actorProfileId: 'profile-1',
        content: 'hello',
      });
      expect(userMsg.role).toBe('user');

      const agentMsg = await chat.sendAgentReply({
        tenantId: 'tenant-1',
        agentSessionId: session.id as string,
        content: 'hi there',
        kind: 'assistant',
      });
      expect(agentMsg.role).toBe('assistant');
    });
  });

  describe('caller cannot post as the agent through any public method', () => {
    it('sendMessage authors as the actor with role user, ignoring injected fields', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });

      // The public signature has no senderProfileId/role. Simulate an attacker
      // smuggling those fields via an untyped request body: they MUST be ignored
      // — the author is forced to the actor with role 'user'.
      const tampered = {
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        content: 'hi',
        senderProfileId: 'some-agent',
        role: 'assistant',
      } as unknown as Parameters<typeof chat.sendMessage>[0];

      const msg = await chat.sendMessage(tampered);

      expect(msg.senderProfileId).toBe('owner');
      expect(msg.role).toBe('user');
    });

    it('sendAgentUserMessage cannot impersonate the agent via the session', async () => {
      // Reproduces the round-2 finding: a caller passing senderProfileId =
      // session.agentId to post as the agent. The agent-session user path now
      // takes actorProfileId and always authors as the participant.
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });

      // A non-participant (e.g. the agent id itself) cannot post a user message.
      await expect(
        chat.sendAgentUserMessage({
          tenantId: 'tenant-1',
          agentSessionId: session.id as string,
          actorProfileId: 'agent-1',
          content: 'posing as agent',
        }),
      ).rejects.toThrow(/authorization denied/i);

      // The legitimate participant always authors as themselves with role user.
      const msg = await chat.sendAgentUserMessage({
        tenantId: 'tenant-1',
        agentSessionId: session.id as string,
        actorProfileId: 'profile-1',
        content: 'hello',
      });
      expect(msg.senderProfileId).toBe('profile-1');
      expect(msg.role).toBe('user');
    });
  });

  describe('addParticipant requires room owner/admin', () => {
    it('rejects a non-owner/non-member adding a participant', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });

      await expect(
        chat.addParticipant({
          tenantId: 'tenant-1',
          roomId: room.id as string,
          actorProfileId: 'intruder',
          profileId: 'intruder',
        }),
      ).rejects.toThrow(/owner\/admin|authorization denied/i);
    });

    it('rejects a plain member (non-admin) adding a participant', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });
      await chat.addParticipant({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        profileId: 'member',
      });

      await expect(
        chat.addParticipant({
          tenantId: 'tenant-1',
          roomId: room.id as string,
          actorProfileId: 'member',
          profileId: 'stranger',
        }),
      ).rejects.toThrow(/owner\/admin|authorization denied/i);
    });

    it('lets the owner add a participant', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });

      const p = await chat.addParticipant({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        profileId: 'invitee',
      });
      expect(p.profileId).toBe('invitee');
    });
  });

  describe('reactions are membership-gated and self-keyed', () => {
    it('rejects a reaction from a non-member', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });
      const msg = await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        content: 'react to me',
      });

      await expect(
        chat.addReaction({
          tenantId: 'tenant-1',
          messageId: msg.id as string,
          actorProfileId: 'intruder',
          emoji: '🔥',
        }),
      ).rejects.toThrow(/not an active member|authorization denied/i);
    });

    it('lets a member add a reaction authored as themselves', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'public',
        createdByProfileId: 'owner',
      });
      const msg = await chat.sendMessage({
        tenantId: 'tenant-1',
        roomId: room.id as string,
        actorProfileId: 'owner',
        content: 'react',
      });

      const r = await chat.addReaction({
        tenantId: 'tenant-1',
        messageId: msg.id as string,
        actorProfileId: 'owner',
        emoji: '👍',
      });
      expect(r.profileId).toBe('owner');

      // removeReaction only removes the caller's own reaction.
      const removed = await chat.removeReaction({
        tenantId: 'tenant-1',
        messageId: msg.id as string,
        actorProfileId: 'owner',
        emoji: '👍',
      });
      expect(removed).toBe(true);
    });
  });

  describe('getOrCreateDM requires the actor to be a participant', () => {
    it('rejects opening a DM between two other profiles', async () => {
      await expect(
        chat.getOrCreateDM({
          tenantId: 'tenant-1',
          actorProfileId: 'eavesdropper',
          profileId1: 'alice',
          profileId2: 'bob',
        }),
      ).rejects.toThrow(/authorization denied/i);
    });
  });

  describe('legacy agent session enrolls the agent participant', () => {
    it('re-creating a session whose agent was never enrolled fixes membership', async () => {
      const { session, room } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
        allowedTools: ['search'],
      });

      // Simulate a legacy session: remove the agent's participant row so the
      // existing-session path is exercised against a room missing agent
      // membership (the round-3 finding).
      const agentMembership = await chat.participants.findMembership(
        room.id as string,
        'agent-1',
        'tenant-1',
      );
      if (agentMembership) {
        agentMembership.status = 'left';
        await agentMembership.save();
      }

      // Re-create returns the SAME existing session/room and must re-enroll the
      // agent so sendAgentReply's membership check passes.
      const again = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });
      expect(again.session.id).toBe(session.id);
      expect(again.room.id).toBe(room.id);

      const reply = await chat.sendAgentReply({
        tenantId: 'tenant-1',
        agentSessionId: session.id as string,
        content: 'searching',
        kind: 'tool',
        messageType: 'tool_call',
        toolCallData: { name: 'search' },
      });
      expect(reply.role).toBe('tool');
    });
  });

  describe('agent session config is owner-restricted', () => {
    it('lets the owner update allowedTools/systemPrompt', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'owner',
      });

      const updated = await chat.updateAgentSessionConfig({
        agentSessionId: session.id as string,
        actorProfileId: 'owner',
        allowedTools: ['search', 'calc'],
        systemPrompt: 'be helpful',
      });
      expect(updated.getAllowedTools()).toEqual(['search', 'calc']);
      expect(updated.systemPrompt).toBe('be helpful');
    });

    it('rejects a non-owner updating the config', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'owner',
      });

      await expect(
        chat.updateAgentSessionConfig({
          agentSessionId: session.id as string,
          actorProfileId: 'attacker',
          allowedTools: ['exec_shell'],
        }),
      ).rejects.toThrow(/authorization denied/i);
    });
  });

  describe('DM identity derived from participants join, not metadata', () => {
    it('reuses the same DM and ignores spoofed metadata.participantIds', async () => {
      const dm = await chat.getOrCreateDM({
        tenantId: 'tenant-1',
        actorProfileId: 'alice',
        profileId1: 'alice',
        profileId2: 'bob',
      });

      // Tamper with client-mutable metadata to claim a different participant set.
      dm.setMetadata({ participantIds: ['mallory', 'bob'] });
      await dm.save();

      // Lookup still resolves by the authoritative participants join.
      const again = await chat.getOrCreateDM({
        tenantId: 'tenant-1',
        actorProfileId: 'bob',
        profileId1: 'bob',
        profileId2: 'alice',
      });
      expect(again.id).toBe(dm.id);

      // A genuinely different pair gets a different room.
      const other = await chat.getOrCreateDM({
        tenantId: 'tenant-1',
        actorProfileId: 'alice',
        profileId1: 'alice',
        profileId2: 'carol',
      });
      expect(other.id).not.toBe(dm.id);
    });
  });

  describe('expireStale caller-scoping', () => {
    it('only expires sessions within the given scope', async () => {
      const { session: s1 } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'p1',
      });
      const { session: s2 } = await chat.createAgentSession({
        tenantId: 'tenant-2',
        agentId: 'agent-2',
        participantProfileId: 'p2',
      });

      const future = new Date(Date.now() + 60_000);
      const expired = await chat.agentSessions.expireStale(future, {
        tenantId: 'tenant-1',
      });
      expect(expired).toBe(1);

      const reloaded1 = await chat.agentSessions.get({ id: s1.id });
      const reloaded2 = await chat.agentSessions.get({ id: s2.id });
      expect(reloaded1?.status).toBe('expired');
      expect(reloaded2?.status).toBe('active');
    });
  });

  describe('generated CRUD surface cannot bypass ChatService', () => {
    // The membership / owner / tool-whitelist checks all live in ChatService.
    // If the @smrt()-generated REST/MCP routes emitted create/update/delete on
    // these internal models, an authenticated caller could POST a message into
    // any room, forge a ChatParticipant row to grant themselves membership, or
    // PUT an AgentSession to rewrite its tool allow-list — bypassing every
    // service-layer check. These models must therefore expose READ ops only.
    // EVERY @smrt() model in the package must be read-only on api AND mcp.
    // Enumerated structurally below so a newly-added model with a default
    // (mutating) surface fails this test instead of silently shipping a hole.
    const internals = [
      '@happyvertical/smrt-chat:ChatMessage',
      '@happyvertical/smrt-chat:ChatParticipant',
      '@happyvertical/smrt-chat:ChatRoom',
      '@happyvertical/smrt-chat:ChatThread',
      '@happyvertical/smrt-chat:ChatReaction',
      '@happyvertical/smrt-chat:AgentSession',
    ];

    for (const qualifiedName of internals) {
      it(`does not generate mutating api/mcp ops for ${qualifiedName}`, () => {
        const { api, mcp } = generatedSurface(qualifiedName);

        // A `null` include means the full CRUD surface is generated — which
        // would expose mutations. The fix pins each model to an explicit
        // read-only include list.
        expect(api).not.toBeNull();
        expect(mcp).not.toBeNull();

        for (const op of MUTATING_OPS) {
          expect(api).not.toContain(op);
          expect(mcp).not.toContain(op);
        }
      });
    }

    it('every registered chat model is read-only (enumerated, not hard-coded)', () => {
      // Discover every @happyvertical/smrt-chat model from the registry so a
      // future model cannot be added with a default (mutating) surface without
      // tripping this assertion (defense against the round-by-round whack-a-mole
      // that produced this audit). This catches additions the static list above
      // would otherwise miss.
      const registered = ObjectRegistry.getClassesByPackage(
        '@happyvertical/smrt-chat',
      );

      // Discovery must surface at least the models we already know about.
      expect(registered.size).toBeGreaterThanOrEqual(internals.length);

      for (const [name, entry] of registered.entries()) {
        const { api, mcp } = surfaceFromConfig(
          (entry as { config: SurfaceConfig }).config,
        );
        expect(api, `${name} api`).not.toBeNull();
        expect(mcp, `${name} mcp`).not.toBeNull();
        for (const op of MUTATING_OPS) {
          expect(api, `${name} api`).not.toContain(op);
          expect(mcp, `${name} mcp`).not.toContain(op);
        }
      }
    });
  });

  describe('forged ChatParticipant cannot grant cross-tenant membership', () => {
    it('a participant row in another tenant does not satisfy the membership check', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Private',
        roomType: 'private',
        createdByProfileId: 'owner',
      });

      // Simulate a write that slipped past the (now read-only) generated
      // surface: a row for the same room/profile but tagged to another tenant.
      // It must NOT be honored as membership for tenant-1.
      await chat.participants.create({
        tenantId: 'tenant-2',
        roomId: room.id as string,
        profileId: 'intruder',
        role: 'owner',
        status: 'active',
        joinedAt: new Date(),
      });

      const isMemberOfTenant1 = await chat.participants.isActiveMember(
        room.id as string,
        'intruder',
        'tenant-1',
      );
      expect(isMemberOfTenant1).toBe(false);

      await expect(
        chat.sendMessage({
          tenantId: 'tenant-1',
          roomId: room.id as string,
          actorProfileId: 'intruder',
          content: 'forged membership',
        }),
      ).rejects.toThrow(/not an active member/i);
    });
  });

  describe('tenant-bound lookups do not cross tenants', () => {
    it('findActiveMembership is scoped to the requested tenant', async () => {
      const room = await chat.createRoom({
        tenantId: 'tenant-1',
        name: 'Room',
        roomType: 'private',
        createdByProfileId: 'owner',
      });

      // owner is an active member of tenant-1's room; tenant-2 must not see it.
      const inTenant1 = await chat.participants.findActiveMembership(
        room.id as string,
        'owner',
        'tenant-1',
      );
      expect(inTenant1).not.toBeNull();

      const inTenant2 = await chat.participants.findActiveMembership(
        room.id as string,
        'owner',
        'tenant-2',
      );
      expect(inTenant2).toBeNull();
    });

    it('findActiveSession is scoped to the requested tenant', async () => {
      const { session } = await chat.createAgentSession({
        tenantId: 'tenant-1',
        agentId: 'agent-1',
        participantProfileId: 'profile-1',
      });
      expect(session.id).toBeDefined();

      const sameTenant = await chat.agentSessions.findActiveSession(
        'agent-1',
        'profile-1',
        'tenant-1',
      );
      expect(sameTenant?.id).toBe(session.id);

      const otherTenant = await chat.agentSessions.findActiveSession(
        'agent-1',
        'profile-1',
        'tenant-2',
      );
      expect(otherTenant).toBeNull();
    });
  });
});
