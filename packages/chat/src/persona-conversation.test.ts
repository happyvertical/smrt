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
import type {
  PrincipalAuditEntry,
  PrincipalTool,
} from '@happyvertical/smrt-agents';
import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
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
  createDataSurfaceTools,
  DATA_INSPECT_FUNCTION_NAME,
  DATA_INSPECT_TOOL_SLUG,
  type DataSurfaceDefinition,
} from './data-surface-tools.js';
import type { ChatMessage } from './models/ChatMessage.js';
import {
  bindPersonaToSession,
  type ConversationPersona,
  runPersonaConversationTurn,
} from './persona-conversation.js';
import { ChatService } from './services/index.js';
import {
  DEFAULT_EMPTY_ANSWER_FALLBACK,
  isFallbackReply,
  TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
  toolFunctionName,
} from './tool-loop.js';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  // Explicit collection so the permission slug matches the allow-list below.
  collection: 'conv_notes',
  tableName: 'conv_notes',
  tenantScoped: { field: 'tenantId', mode: 'optional' },
})
class ConvNote extends SmrtObject {
  tenantId: string | null = null;

  @field()
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

  it('persists failed and rejected tool calls with the text the model saw, and audits them (#4383)', async () => {
    const probe: PrincipalTool = {
      slug: 'probe.query',
      aiTool: {
        type: 'function',
        function: {
          name: 'probe-query',
          description: 'Probe.',
          parameters: { type: 'object', properties: {} },
        },
      },
      async execute() {
        throw Object.assign(new Error('Field nope is not filterable.'), {
          status: 400,
          code: 'PROBE_REQUEST_INVALID',
        });
      },
    };
    const probePersona = {
      ...persona,
      allowedTools: [...CONV_TOOLS, 'probe.query'],
    };
    const chatService = await ChatService.create({ tenantId, db });
    await chatService.initialize();
    const { session } = await chatService.createAgentSession({
      tenantId,
      agentId: 'praeco-agent',
      actorProfileId: 'human-profile',
    });
    const bound = await bindPersonaToSession({
      chatService,
      session,
      actorProfileId: 'human-profile',
      tenantId,
      persona: probePersona,
    });
    const { ai } = makeAI((call, offered) => {
      if (offered && call === 0)
        return toolCall('probe-query', { field: 'nope' });
      if (offered && call === 1) return toolCall('secret-tool', { x: 1 });
      return {
        content: 'Could not count.',
        finishReason: 'stop',
      } as AIResponse;
    });
    const audits: PrincipalAuditEntry[] = [];
    const turn = await runPersonaConversationTurn({
      ai,
      db,
      persona: probePersona,
      tenantId,
      userMessage: 'how many?',
      recall: false,
      chatService,
      session: bound,
      extraTools: [probe],
      audit: (entry) => {
        audits.push(entry);
      },
    });
    expect(turn.result.invocations.map((i) => i.ok)).toEqual([false, false]);

    const messages = await chatService.getRoomMessages({
      roomId: bound.chatRoomId as string,
      actorProfileId: 'human-profile',
      tenantId,
      limit: 50,
    });
    const toolRows = messages.filter((m) => m.role === 'tool');
    // The denied call to an unoffered tool cannot be a tool row (the
    // session gate refuses its name); the failed allowed call is one.
    expect(toolRows).toHaveLength(1);
    const row = toolRows[0];
    expect(row?.content).toBe(turn.result.invocations[0]?.modelContent);
    expect(row?.content).toContain('Field nope is not filterable.');
    expect(row?.getMetadata()).toEqual({
      toolStatus: 'error',
      errorKind: 'invalid_request',
      errorCode: 'PROBE_REQUEST_INVALID',
      // A validation failure the model can fix (#4505).
      recoverable: true,
    });
    expect(row?.getToolCallData()).toMatchObject({
      name: 'probe.query',
      args: { field: 'nope' },
      status: 'error',
      errorCode: 'PROBE_REQUEST_INVALID',
      recoverable: true,
    });

    const failed = audits.filter((a) => a.action === 'chat.tool_call_failed');
    expect(failed.map((a) => a.metadata)).toEqual([
      expect.objectContaining({
        name: 'probe.query',
        status: 'error',
        errorCode: 'PROBE_REQUEST_INVALID',
      }),
      expect.objectContaining({
        name: 'secret-tool',
        status: 'rejected',
        errorCode: 'not_permitted',
      }),
    ]);
    // The audit sink gets no arguments or shown text (#4383).
    for (const entry of failed) {
      expect(entry.metadata).not.toHaveProperty('args');
      expect(entry.metadata).not.toHaveProperty('shown');
      expect(JSON.stringify(entry.metadata)).not.toContain('nope');
    }
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
  describe('blank answers (#4379)', () => {
    async function boundSession() {
      const chatService = await ChatService.create({ tenantId, db });
      await chatService.initialize();
      const { session } = await chatService.createAgentSession({
        tenantId,
        agentId: 'praeco-agent',
        actorProfileId: 'human-profile',
      });
      const bound = await bindPersonaToSession({
        chatService,
        session,
        actorProfileId: 'human-profile',
        tenantId,
        persona,
      });
      const assistantMessages = async () =>
        (
          await chatService.getRoomMessages({
            roomId: bound.chatRoomId as string,
            actorProfileId: 'human-profile',
            tenantId,
            limit: 50,
          })
        ).filter((m) => m.role === 'assistant');
      return { chatService, bound, assistantMessages };
    }

    it('stores the fallback, never an empty message, when the model stays blank', async () => {
      const { chatService, bound, assistantMessages } = await boundSession();
      const { ai, captured } = makeAI((call, offered) =>
        call === 0 && offered
          ? toolCall(toolFunctionName('conv_notes.read'), {})
          : ({ content: '', finishReason: 'stop' } as AIResponse),
      );
      const turn = await runPersonaConversationTurn({
        ai,
        db,
        persona,
        tenantId,
        userMessage: 'how many notes?',
        recall: false,
        chatService,
        session: bound,
      });
      expect(turn.result.stoppedReason).toBe('empty');
      expect(turn.result.content).toBe('');
      expect(turn.reply).toBe(DEFAULT_EMPTY_ANSWER_FALLBACK);
      // Tool round, blank answer, one retry with the answer-now instruction.
      expect(captured).toHaveLength(3);
      expect(captured[2]?.messages.at(-1)?.content).toBe(
        TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
      );
      expect(turn.replyFallback).toBe('empty');
      const stored = await assistantMessages();
      expect(stored.map((m) => m.content)).toEqual([
        DEFAULT_EMPTY_ANSWER_FALLBACK,
      ]);
      expect(stored[0]?.getMetadata()).toEqual({
        stoppedReason: 'empty',
        fallback: 'empty',
      });
      expect(isFallbackReply(stored[0] as ChatMessage)).toBe(true);
    });

    it('stores a host-configured fallback and keeps a real answer as produced', async () => {
      const { chatService, bound, assistantMessages } = await boundSession();
      const blank = makeAI(
        () => ({ content: '', finishReason: 'stop' }) as AIResponse,
      );
      const turn = await runPersonaConversationTurn({
        ai: blank.ai,
        db,
        persona,
        tenantId,
        userMessage: 'q',
        recall: false,
        chatService,
        session: bound,
        emptyAnswerFallback: 'No answer this time.',
      });
      expect(turn.reply).toBe('No answer this time.');

      const real = makeAI(
        () => ({ content: 'Four notes. ', finishReason: 'stop' }) as AIResponse,
      );
      const answered = await runPersonaConversationTurn({
        ai: real.ai,
        db,
        persona,
        tenantId,
        userMessage: 'q',
        recall: false,
        chatService,
        session: bound,
      });
      // Both paths trim the stored answer alike.
      expect(answered.reply).toBe('Four notes.');
      expect(answered.replyFallback).toBeUndefined();
      const stored = await assistantMessages();
      expect(stored.map((m) => m.content).sort()).toEqual([
        'Four notes.',
        'No answer this time.',
      ]);
      expect(
        stored.filter((m) => isFallbackReply(m)).map((m) => m.content),
      ).toEqual(['No answer this time.']);
      // Every authored reply records its stop reason (enum only).
      for (const message of stored) {
        expect(message.getMetadata().stoppedReason).toBe(
          isFallbackReply(message) ? 'empty' : 'stop',
        );
      }
    });

    it('persists capReason with the stop reason on a capped reply', async () => {
      const { chatService, bound, assistantMessages } = await boundSession();
      const { ai } = makeAI((call, offered) =>
        offered
          ? toolCall(toolFunctionName('conv_notes.read'), {})
          : ({ content: 'Capped answer.', finishReason: 'stop' } as AIResponse),
      );
      await runPersonaConversationTurn({
        ai,
        db,
        persona,
        tenantId,
        userMessage: 'q',
        recall: false,
        chatService,
        session: bound,
        maxSteps: 1,
      });
      const [reply] = await assistantMessages();
      expect(reply?.getMetadata()).toEqual({
        stoppedReason: 'max_steps',
        capReason: 'max_steps',
      });
    });

    it('persists repeated_calls and forwards maxRepeatedCalls (#4391)', async () => {
      const { chatService, bound, assistantMessages } = await boundSession();
      const { ai } = makeAI((_call, offered) =>
        offered
          ? toolCall(toolFunctionName('conv_notes.read'), {})
          : ({ content: 'No notes.', finishReason: 'stop' } as AIResponse),
      );
      const turn = await runPersonaConversationTurn({
        ai,
        db,
        persona,
        tenantId,
        userMessage: 'q',
        recall: false,
        chatService,
        session: bound,
        maxSteps: 6,
        maxRepeatedCalls: 1,
      });
      expect(turn.result).toMatchObject({
        stoppedReason: 'repeated_calls',
        capReason: 'repeated_calls',
        steps: 2,
      });
      const [reply] = await assistantMessages();
      expect(reply?.getMetadata()).toEqual({
        stoppedReason: 'repeated_calls',
        capReason: 'repeated_calls',
      });
    });

    it('forwards maxTotalTokens, deadline, toolChoice and requestTimeoutMs to the loop', async () => {
      const { ai, captured } = makeAI((call, offered) =>
        call === 0 && offered
          ? {
              ...toolCall(toolFunctionName('conv_notes.read'), {}),
              usage: {
                promptTokens: 50,
                completionTokens: 10,
                totalTokens: 60,
              },
            }
          : ({ content: 'ok', finishReason: 'stop' } as AIResponse),
      );
      const turn = await runPersonaConversationTurn({
        ai,
        db,
        persona,
        tenantId,
        userMessage: 'q',
        recall: false,
        maxTotalTokens: 50,
        toolChoice: 'required',
        requestTimeoutMs: 12_345,
      });
      expect(turn.result.stoppedReason).toBe('budget');
      expect(captured[0]?.options?.toolChoice).toBe('required');
      expect(
        captured.map((c) => (c.options as { timeout?: number }).timeout),
      ).toEqual([12_345, 12_345]);

      const late = makeAI(
        () => ({ content: 'late', finishReason: 'stop' }) as AIResponse,
      );
      const deadlined = await runPersonaConversationTurn({
        ai: late.ai,
        db,
        persona,
        tenantId,
        userMessage: 'q',
        recall: false,
        deadline: Date.now() - 1,
      });
      expect(deadlined.result.stoppedReason).toBe('budget');
      expect(late.captured[0]?.options?.tools).toBeUndefined();
    });
  });

  describe('permission snapshot (#2978)', () => {
    const GATED = 'conv_notes.update';
    const surface: DataSurfaceDefinition = {
      id: 'conv-notes',
      collection: 'conv_notes',
      schema: {
        version: 1,
        identityField: 'id',
        fields: [
          { id: 'id', type: 'string', projectable: true },
          { id: 'title', type: 'string', projectable: true },
          {
            id: 'price',
            type: 'number',
            projectable: true,
            readPermission: GATED,
          },
        ],
        defaultPageLimit: 10,
        maxPageLimit: 10,
        maxResultBytes: 10_000,
      },
    };

    async function grantLive(slugs: string[]): Promise<void> {
      const options = { db };
      const permissions = await PermissionCollection.create(options);
      const rolePermissions = await RolePermissionCollection.create(options);
      const memberships = await MembershipCollection.create(options);
      const [membership] = await memberships.list({ where: { userId } });
      for (const slug of slugs) {
        const permission = await permissions.create({ slug, name: slug });
        await permission.save();
        await rolePermissions.addPermission(
          membership?.roleId as string,
          permission.id as string,
        );
      }
    }

    async function inspectFields(
      permissions?: string[],
    ): Promise<{ fields: string[]; seen: string[] }> {
      const seen: string[] = [];
      const [inspect] = createDataSurfaceTools({ surfaces: [surface] }).filter(
        (tool) => tool.slug === DATA_INSPECT_TOOL_SLUG,
      );
      if (!inspect) throw new Error('inspect tool missing');
      const spy = {
        ...inspect,
        execute: async (ctx: Parameters<typeof inspect.execute>[0]) => {
          seen.push(...ctx.run.permissions);
          return inspect.execute(ctx);
        },
      };
      const { ai } = makeAI((call, offered) =>
        call === 0 && offered
          ? toolCall(DATA_INSPECT_FUNCTION_NAME, { surfaceId: surface.id })
          : ({ content: 'done', finishReason: 'stop' } as AIResponse),
      );
      const turn = await runPersonaConversationTurn({
        ai,
        db,
        persona: {
          ...persona,
          allowedTools: [...CONV_TOOLS, DATA_INSPECT_TOOL_SLUG],
        },
        tenantId,
        userMessage: 'what fields do notes have?',
        extraTools: [spy],
        ...(permissions ? { permissions } : {}),
      });
      const invocation = turn.result.invocations.find(
        (i) => i.slug === DATA_INSPECT_TOOL_SLUG,
      );
      expect(invocation?.ok).toBe(true);
      const observation = invocation?.observation as {
        fields?: Array<{ id: string }>;
      };
      return {
        fields: (observation.fields ?? []).map((field) => field.id),
        seen,
      };
    }

    beforeEach(async () => {
      await grantLive([DATA_INSPECT_TOOL_SLUG, GATED]);
    });

    it('resolves live permissions when no snapshot is passed', async () => {
      const { fields, seen } = await inspectFields();
      expect(seen).toContain(GATED);
      expect(fields).toContain('price');
    });

    it('runs tools with the narrowed snapshot, hiding a gated field the live user could read', async () => {
      const { fields, seen } = await inspectFields([
        'conv_notes.read',
        DATA_INSPECT_TOOL_SLUG,
      ]);
      expect([...seen].sort()).toEqual(
        ['conv_notes.read', DATA_INSPECT_TOOL_SLUG].sort(),
      );
      expect(fields).not.toContain('price');
      expect(fields).toEqual(expect.arrayContaining(['id', 'title']));
    });
  });
});
