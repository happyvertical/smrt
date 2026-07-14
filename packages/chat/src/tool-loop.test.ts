/**
 * ToolLoop — the bounded `tool_call → observe → respond` loop over the manifest
 * operation surface (#1891).
 *
 * Real in-memory SQLite (a temp file so the principal context's re-resolved
 * database handle points at the same rows); only the AI boundary is mocked.
 * Proves the two fail-closed gates and the ceiling:
 *   - available tools are exactly the manifest operations filtered by the
 *     persona's allow-list; a tool outside it is neither offered nor executed;
 *   - a tool call executes inside the persona's session-permission context, so
 *     an operation the bound user isn't permitted is denied (catalog assert);
 *   - the loop terminates at the max-steps ceiling.
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
import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  MembershipCollection,
  PermissionCollection,
  type PermissionDefinition,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  UserCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildManifestToolCatalog,
  type ManifestTool,
  runToolLoop,
  type ToolExecutionContext,
} from './tool-loop.js';

// A real, dispatchable manifest object the loop can operate. Defined in a
// `.test.ts` so it lands in the locally-generated test manifest (its CRUD +
// custom-action permission slugs then appear in the catalog).
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete', 'archive'] },
  // Explicit collection so the permission slug matches the allow-list below.
  collection: 'tool_loop_notes',
  tableName: 'tool_loop_notes',
  tenantScoped: { field: 'tenantId', mode: 'optional' },
})
class ToolLoopNote extends SmrtObject {
  tenantId: string | null = null;

  @field()
  title = '';

  @field()
  body = '';

  /** A public custom action → a `tool_loop_notes.archive` catalog tool. */
  async archive(): Promise<{ archived: boolean }> {
    this.body = `[archived] ${this.body}`;
    await this.save();
    return { archived: true };
  }
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

function textResponse(content: string): AIResponse {
  return { content, finishReason: 'stop' };
}

/** Build a mock AI directly (the helper above tripped a typing quirk). */
function makeAI(
  handler: (
    messages: AIMessage[],
    options: ChatOptions | undefined,
    call: number,
  ) => AIResponse,
): AIInterface {
  let calls = 0;
  return {
    async chat(messages: AIMessage[], options?: ChatOptions) {
      const response = handler(messages, options, calls);
      calls += 1;
      return response;
    },
  } as unknown as AIInterface;
}

function toolsOffered(options: ChatOptions | undefined): boolean {
  return (
    Array.isArray(options?.tools) &&
    options.tools.length > 0 &&
    options?.toolChoice !== 'none'
  );
}

describe('buildManifestToolCatalog (offer gate)', () => {
  const catalog: PermissionDefinition[] = [
    { slug: 'articles.read', collection: 'articles', className: 'Article' },
    { slug: 'articles.create', collection: 'articles', className: 'Article' },
    { slug: 'articles.publish', collection: 'articles', className: 'Article' },
    { slug: 'orders.read', collection: 'orders', className: 'Order' },
    // A definition with no backing class is not a dispatchable operation.
    { slug: 'floating.perm', collection: 'floating' },
  ];

  it('returns exactly the manifest operations named in the allow-list', () => {
    const tools = buildManifestToolCatalog({
      catalog,
      allowedTools: ['articles.read', 'articles.publish'],
    });
    expect(tools.map((t) => t.slug).sort()).toEqual([
      'articles.publish',
      'articles.read',
    ]);
    const publish = tools.find((t) => t.slug === 'articles.publish');
    expect(publish).toMatchObject({
      collection: 'articles',
      className: 'Article',
      action: 'publish',
    });
  });

  it('fails closed: an empty allow-list offers no tools', () => {
    expect(buildManifestToolCatalog({ catalog, allowedTools: [] })).toEqual([]);
  });

  it('fails closed: an omitted allow-list offers no tools', () => {
    expect(buildManifestToolCatalog({ catalog })).toEqual([]);
  });

  it('offers the full surface only with the explicit all flag', () => {
    const tools = buildManifestToolCatalog({ catalog, all: true });
    expect(tools.map((t) => t.slug).sort()).toEqual([
      'articles.create',
      'articles.publish',
      'articles.read',
      'orders.read',
    ]);
  });

  it('never offers a tool outside the allow-list', () => {
    const tools = buildManifestToolCatalog({
      catalog,
      allowedTools: ['articles.read'],
    });
    expect(tools.some((t) => t.slug === 'articles.create')).toBe(false);
    expect(tools.some((t) => t.slug === 'orders.read')).toBe(false);
  });

  it('skips catalog entries with no dispatchable backing class', () => {
    const tools = buildManifestToolCatalog({
      catalog,
      allowedTools: ['floating.perm'],
    });
    expect(tools).toEqual([]);
  });
});

describe('runToolLoop', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let userId: string;
  let tenantId: string;
  let roleId: string;
  let permissions: PermissionCollection;
  let rolePermissions: RolePermissionCollection;

  const NOTE_TOOLS = [
    'tool_loop_notes.read',
    'tool_loop_notes.create',
    'tool_loop_notes.update',
    'tool_loop_notes.delete',
    'tool_loop_notes.archive',
  ];

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-tool-loop-${Date.now()}-${Math.random()}.db`);
    db = { type: 'sqlite', url: dbPath };
    const options = { db };

    const users = await UserCollection.create(options);
    const tenants = await TenantCollection.create(options);
    const roles = await RoleCollection.create(options);
    permissions = await PermissionCollection.create(options);
    rolePermissions = await RolePermissionCollection.create(options);
    const memberships = await MembershipCollection.create(options);

    const user = await users.create({ email: 'agent@example.com' });
    await user.save();
    const tenant = await tenants.create({ name: 'Notes Org' });
    await tenant.save();
    const role = await roles.create({ name: 'Notes Editor' });
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
    roleId = role.id as string;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort
      }
    }
  });

  async function grant(slug: string): Promise<void> {
    const permission = await permissions.create({ slug, name: slug });
    await permission.save();
    await rolePermissions.addPermission(roleId, permission.id as string);
  }

  function tools(slugs: string[]): ManifestTool[] {
    return buildManifestToolCatalog({ db, allowedTools: slugs });
  }

  it('stops with the final text when the model makes no tool call', async () => {
    const ai = makeAI(() => textResponse('nothing to do'));
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      audit: () => {},
    });
    expect(result.stoppedReason).toBe('stop');
    expect(result.content).toBe('nothing to do');
    expect(result.steps).toBe(0);
  });

  it('streams the model text deltas to onToken (#1936)', async () => {
    // The AI boundary streams via onProgress when the round runs with
    // stream:true. Assert the loop passes both through and forwards the deltas.
    const seenStream: Array<boolean | undefined> = [];
    const ai = {
      async chat(_messages: AIMessage[], options?: ChatOptions) {
        seenStream.push(options?.stream);
        for (const delta of ['Hel', 'lo ', 'there']) {
          options?.onProgress?.(delta);
        }
        return textResponse('Hello there');
      },
    } as unknown as AIInterface;

    const tokens: string[] = [];
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      audit: () => {},
      onToken: (chunk) => tokens.push(chunk),
    });

    expect(seenStream).toContain(true);
    expect(tokens.join('')).toBe('Hello there');
    expect(result.content).toBe('Hello there');
  });

  it('does not request streaming when no onToken sink is given', async () => {
    const seenStream: Array<boolean | undefined> = [];
    const ai = {
      async chat(_messages: AIMessage[], options?: ChatOptions) {
        seenStream.push(options?.stream);
        return textResponse('quiet');
      },
    } as unknown as AIInterface;

    await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      audit: () => {},
    });

    expect(seenStream.every((v) => v === undefined)).toBe(true);
  });

  it('reports no_tools when the persona has an empty allow-list', async () => {
    const ai = makeAI(() => textResponse('cannot act'));
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'do it' }],
      tools: tools([]),
      principal: { runAsUserId: userId, tenantId, allowedTools: [] },
      audit: () => {},
    });
    expect(result.stoppedReason).toBe('no_tools');
    expect(result.invocations).toHaveLength(0);
  });

  it('executes an allow-listed tool and observes the result (injected executor)', async () => {
    const executed: string[] = [];
    const executeTool = vi.fn(async (ctx: ToolExecutionContext) => {
      executed.push(ctx.tool.slug);
      return { ok: true };
    });
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'list notes' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool,
      audit: () => {},
    });
    expect(executed).toEqual(['tool_loop_notes.read']);
    expect(result.stoppedReason).toBe('stop');
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]).toMatchObject({ ok: true, rejected: false });
  });

  it('correlates each tool observation to its call via tool_call_id', async () => {
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'list' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool: async () => ({ ok: true }),
      audit: () => {},
    });
    const assistant = result.messages.find(
      (
        m,
      ): m is (typeof result.messages)[number] & {
        tool_calls?: Array<{ id: string }>;
      } =>
        m.role === 'assistant' &&
        Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
    );
    const callId = assistant?.tool_calls?.[0]?.id;
    const toolMessage = result.messages.find((m) => m.role === 'tool') as
      | { tool_call_id?: string }
      | undefined;
    expect(callId).toBeTruthy();
    expect(toolMessage?.tool_call_id).toBe(callId);
  });

  it('rejects a tool the persona was not offered — never executed', async () => {
    const executeTool = vi.fn(async () => ({ ok: true }));
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? // The model asks for a tool NOT in the offered set.
          toolCall('tool_loop_notes.delete', { id: 'x' })
        : textResponse('gave up'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'delete it' }],
      // Only read is offered; delete is withheld.
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool,
      audit: () => {},
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.invocations).toHaveLength(1);
    expect(result.invocations[0]).toMatchObject({
      slug: 'tool_loop_notes.delete',
      ok: false,
      rejected: true,
      error: 'not_permitted',
    });
  });

  it('terminates at the max-steps ceiling', async () => {
    let executed = 0;
    const executeTool = vi.fn(async () => {
      executed += 1;
      return { step: executed };
    });
    // The model always wants another tool call while tools are offered.
    const ai = makeAI((_m, options) =>
      toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('ceiling reached'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'loop forever' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      maxSteps: 3,
      executeTool,
      audit: () => {},
    });
    expect(result.stoppedReason).toBe('max_steps');
    expect(result.steps).toBe(3);
    expect(executed).toBe(3);
    expect(result.content).toBe('ceiling reached');
  });

  describe('end-to-end permission enforcement (catalog assert, RLS off)', () => {
    it('executes a permitted operation and denies an un-permitted one', async () => {
      await grant('tool_loop_notes.create');
      await grant('tool_loop_notes.read');
      // Note: tool_loop_notes.delete is deliberately NOT granted.

      // The model creates a note (permitted), then tries to delete one
      // (allow-listed as a TOOL, but the bound user lacks the permission).
      const ai = makeAI((_m, options, call) => {
        if (!toolsOffered(options)) {
          return textResponse('finished');
        }
        if (call === 0) {
          return toolCall('tool_loop_notes.create', {
            title: 'Hello',
            body: 'world',
            tenantId,
          });
        }
        if (call === 1) {
          return toolCall('tool_loop_notes.delete', { id: 'anything' });
        }
        return textResponse('finished');
      });

      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'make and delete a note' }],
        tools: tools(NOTE_TOOLS),
        principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
        audit: () => {},
      });

      const create = result.invocations.find(
        (i) => i.slug === 'tool_loop_notes.create',
      );
      const del = result.invocations.find(
        (i) => i.slug === 'tool_loop_notes.delete',
      );
      // Permitted op ran and produced a row.
      expect(create?.ok).toBe(true);
      expect(
        (create?.observation as { title?: string } | undefined)?.title,
      ).toBe('Hello');
      // Un-permitted op was denied by the catalog assert.
      expect(del?.ok).toBe(false);
      expect(del?.rejected).toBe(true);

      // The created row really exists.
      const notes = await ObjectRegistry.getCollection('ToolLoopNote', { db });
      const rows = await notes.list({ where: { title: 'Hello' } });
      expect(rows).toHaveLength(1);
    });

    it('invokes a permitted public custom action through the side door', async () => {
      await grant('tool_loop_notes.create');
      await grant('tool_loop_notes.archive');

      // Seed a note to archive.
      const notes = await ObjectRegistry.getCollection('ToolLoopNote', { db });
      const seeded = await notes.create({
        tenantId,
        title: 'Doc',
        body: 'keep',
      });
      await seeded.save();

      const ai = makeAI((_m, options, call) =>
        call === 0 && toolsOffered(options)
          ? toolCall('tool_loop_notes.archive', { id: seeded.id })
          : textResponse('archived'),
      );

      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'archive it' }],
        tools: tools(['tool_loop_notes.archive']),
        principal: {
          runAsUserId: userId,
          tenantId,
          allowedTools: ['tool_loop_notes.archive'],
        },
        audit: () => {},
      });

      const archive = result.invocations.find(
        (i) => i.slug === 'tool_loop_notes.archive',
      );
      expect(archive?.ok).toBe(true);
      expect(
        (archive?.observation as { archived?: boolean } | undefined)?.archived,
      ).toBe(true);
    });
  });
});
