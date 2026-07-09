/**
 * Persona-bound conversation (#1891) — real in-memory SQLite; only the AI
 * boundary is mocked.
 *
 * Proves a conversation bound to a persona runs with that persona's PRINCIPAL
 * (its `runAsUserId`), TOOLS (its `allowedTools`), INSTRUCTIONS, and RECALLED
 * MEMORY — and that the assistant reply is authored into the bound chat session.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AIInterface,
  AIMessage,
  AIResponse,
  ChatOptions,
} from '@happyvertical/ai';
import type { PrincipalAuditEntry } from '@happyvertical/smrt-agents';
import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { personaLearningMemory } from '@happyvertical/smrt-personas';
import {
  MembershipCollection,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindPersonaToSession,
  type ConversationPersona,
  runPersonaConversationTurn,
} from './persona-conversation.js';
import { ChatService } from './services/index.js';
import { toolFunctionName } from './tool-loop.js';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  // Explicit collection so the permission slug matches the allow-list below.
  collection: 'conv_notes',
  tableName: 'conv_notes',
  tenantScoped: { field: 'tenantId', mode: 'optional' },
})
class ConvNote extends SmrtObject {
  tenantId: string | null = null;
  title = '';
}
void ConvNote;

interface Captured {
  messages: AIMessage[];
  options: ChatOptions | undefined;
}

function makeAI(handler: (call: number, offered: boolean) => AIResponse): {
  ai: AIInterface;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const ai = {
    async chat(messages: AIMessage[], options?: ChatOptions) {
      const offered =
        Array.isArray(options?.tools) &&
        options.tools.length > 0 &&
        options?.toolChoice !== 'none';
      captured.push({ messages, options });
      return handler(captured.length - 1, offered);
    },
  } as unknown as AIInterface;
  return { ai, captured };
}

function toolCall(name: string, args: Record<string, unknown>): AIResponse {
  return {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [
      {
        id: `tc_${Math.random().toString(36).slice(2)}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  };
}

const CONV_TOOLS = ['conv_notes.create', 'conv_notes.read'];

describe('persona-bound conversation', () => {
  let dbPath: string;
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let userId: string;
  let tenantId: string;
  let persona: ConversationPersona;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-persona-conv-${Date.now()}-${Math.random()}.db`,
    );
    db = await getDatabase({ type: 'sqlite', url: dbPath });
    const options = { db };

    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    const permissions = await PermissionCollection.create(options);
    const rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({ email: 'persona@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Persona Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Note Persona' });
    await role.save();
    await (
      await memberships.create({
        userId: user.id,
        tenantId: tenant.id,
        roleId: role.id,
      })
    ).save();

    userId = user.id as string;
    tenantId = tenant.id as string;

    for (const slug of CONV_TOOLS) {
      const permission = await permissions.create({ slug, name: slug });
      await permission.save();
      await rolePermissions.addPermission(
        role.id as string,
        permission.id as string,
      );
    }

    persona = {
      id: 'persona-1',
      tenantId,
      agentClass: '@happyvertical/smrt-agents:Praeco',
      runAsUserId: userId,
      allowedTools: CONV_TOOLS,
      instructions: 'Always cite sources first.',
      memoryScope: `conv:${tenantId}`,
    };
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  it('runs under the persona principal, with its tools, instructions, and recalled memory', async () => {
    // The persona has learned a confident preference.
    const memory = personaLearningMemory({ db, persona });
    await memory.capture(
      { scope: 'chat', key: 'style', value: 'lead with the citation' },
      { success: true },
    );

    const { ai, captured } = makeAI((call, offered) =>
      call === 0 && offered
        ? toolCall('conv_notes.create', { title: 'From chat', tenantId })
        : ({ content: 'Added your note.', finishReason: 'stop' } as AIResponse),
    );

    const audits: PrincipalAuditEntry[] = [];
    const turn = await runPersonaConversationTurn({
      ai,
      db,
      persona,
      tenantId,
      userMessage: 'add a note',
      recall: { scope: 'chat', key: 'style' },
      onBehalfOfUserId: 'human-7',
      audit: (entry) => {
        audits.push(entry);
      },
    });

    // Instructions + recalled memory were assembled into the system prompt.
    const systemMessage = captured[0]?.messages.find(
      (m) => m.role === 'system',
    );
    expect(systemMessage?.content).toContain('Always cite sources first.');
    expect(String(systemMessage?.content)).toContain('lead with the citation');
    expect(turn.recalled.map((r) => r.key)).toContain('style');

    // Exactly the persona's tools were offered (as provider-safe names).
    const offeredNames = (captured[0]?.options?.tools ?? []).map(
      (t) => t.function.name,
    );
    expect(offeredNames.sort()).toEqual(
      CONV_TOOLS.map(toolFunctionName).sort(),
    );

    // The turn ran AS the persona's bound user, on behalf of the originator.
    expect(audits[0]).toMatchObject({
      actorUserId: userId,
      onBehalfOfUserId: 'human-7',
    });

    // The tool actually executed under the principal (row created).
    const create = turn.result.invocations.find(
      (i) => i.slug === 'conv_notes.create',
    );
    expect(create?.ok).toBe(true);
    const notes = await ObjectRegistry.getCollection('ConvNote', { db });
    const rows = await notes.list({ where: { title: 'From chat' } });
    expect(rows).toHaveLength(1);

    expect(turn.result.content).toBe('Added your note.');
    expect(turn.correlationId).toBeTruthy();
  });

  it('fails fast when the persona has no bound run-as user', async () => {
    const unbound: ConversationPersona = { ...persona, runAsUserId: '' };
    const { ai } = makeAI(
      () => ({ content: 'x', finishReason: 'stop' }) as AIResponse,
    );
    await expect(
      runPersonaConversationTurn({
        ai,
        db,
        persona: unbound,
        tenantId,
        userMessage: 'hi',
        recall: false,
      }),
    ).rejects.toThrow(/run-as user/);
  });

  it('does not duplicate the instruction block already on the session prompt', async () => {
    const { ai, captured } = makeAI(
      () => ({ content: 'ok', finishReason: 'stop' }) as AIResponse,
    );
    // The bound session already carries the persona instructions.
    await runPersonaConversationTurn({
      ai,
      db,
      persona,
      tenantId,
      userMessage: 'hi',
      recall: false,
      session: {
        id: 's1',
        chatRoomId: 'r1',
        systemPrompt: persona.instructions,
      },
    });
    const system = captured[0]?.messages.find((m) => m.role === 'system');
    const occurrences =
      String(system?.content).split('Always cite sources first.').length - 1;
    expect(occurrences).toBe(1);
  });

  it('offers no tools for a persona with an empty allow-list (fail-closed)', async () => {
    const lockedDown: ConversationPersona = { ...persona, allowedTools: [] };
    const { ai, captured } = makeAI(
      () => ({ content: 'I cannot act.', finishReason: 'stop' }) as AIResponse,
    );

    const turn = await runPersonaConversationTurn({
      ai,
      db,
      persona: lockedDown,
      tenantId,
      userMessage: 'delete everything',
      recall: false,
    });

    expect(captured[0]?.options?.tools ?? []).toEqual([]);
    expect(turn.result.stoppedReason).toBe('no_tools');
    expect(turn.result.invocations).toHaveLength(0);
  });

  it('binds a session to the persona and authors the assistant reply', async () => {
    const chatService = await ChatService.create({ tenantId, db });
    await chatService.initialize();
    const { session } = await chatService.createAgentSession({
      tenantId,
      agentId: 'praeco-agent',
      actorProfileId: 'human-profile',
    });

    // Bind: mirror the persona's tools + instructions onto the session.
    const bound = await bindPersonaToSession({
      chatService,
      session,
      actorProfileId: 'human-profile',
      tenantId,
      persona,
    });
    expect(bound.getAllowedTools().sort()).toEqual([...CONV_TOOLS].sort());
    expect(bound.systemPrompt).toContain('Always cite sources first.');

    const { ai } = makeAI(
      () =>
        ({ content: 'Done and cited.', finishReason: 'stop' }) as AIResponse,
    );
    const turn = await runPersonaConversationTurn({
      ai,
      db,
      persona,
      tenantId,
      userMessage: 'help me',
      recall: false,
      chatService,
      session: bound,
    });

    expect(turn.result.content).toBe('Done and cited.');

    // The assistant reply was authored into the session's room.
    const messages = await chatService.getRoomMessages({
      roomId: bound.chatRoomId as string,
      actorProfileId: 'human-profile',
      tenantId,
      limit: 50,
    });
    const assistant = messages.find(
      (m) => m.role === 'assistant' && m.content === 'Done and cited.',
    );
    expect(assistant).toBeTruthy();
  });
});
