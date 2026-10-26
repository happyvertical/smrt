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
  ValidationError,
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
  appendClientToolResults,
  buildManifestToolCatalog,
  classifyToolError,
  MAX_CLIENT_TOOL_RESULT_CHARS,
  MAX_SERVER_TOOL_OBSERVATION_CHARS,
  type ManifestTool,
  manifestToolToAITool,
  runToolLoop,
  SERVER_TOOL_OBSERVATION_TRUNCATED_MARKER,
  TOOL_EXECUTION_ERROR_HINT,
  TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
  type ToolExecutionContext,
} from './tool-loop.js';

// A real, dispatchable manifest object the loop can operate. Defined in a
// `.test.ts` so it lands in the locally-generated test manifest (its CRUD +
// custom-action permission slugs then appear in the catalog).
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete', 'archive'],
    writable: ['title', 'body', 'estimatedHours', 'isPinned', 'state'],
  },
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

  @field({ description: 'Estimated effort in decimal hours.' })
  estimatedHours = 0.0;

  @field({ description: 'Whether to pin this note for the team.' })
  isPinned = false;

  @field({
    description:
      'Workflow state. Use draft while editing and published when ready.',
    enum: ['draft', 'published'],
  })
  state = 'draft';

  @field({ readonly: true, description: 'Calculated server-side total.' })
  calculatedTotal = 0.0;

  @field({
    description: 'Internal score, maintained only by application code.',
  })
  internalScore = 0;

  @field({ sensitive: true })
  internalMemo = '';

  /** A public custom action → a `tool_loop_notes.archive` catalog tool. */
  async archive(): Promise<{ archived: boolean }> {
    this.body = `[archived] ${this.body}`;
    await this.save();
    return { archived: true };
  }
}

// Covers the registry-provided dynamic MCP get serializer without importing a
// domain package. The fixture is local so Chat never gains a dependency edge to
// Commerce merely to test generic dispatcher behavior.
@smrt({
  api: { include: ['get'] },
  mcp: {
    include: ['get'],
    serializers: {
      get: {
        importPath: './tool-loop-mcp-serializer.test-support.js',
        exportName: 'serializeToolLoopMcpGet',
      },
    },
  },
  collection: 'tool_loop_serialized_notes',
  tableName: 'tool_loop_serialized_notes',
  tenantScoped: { field: 'tenantId', mode: 'optional' },
})
class ToolLoopSerializedNote extends SmrtObject {
  tenantId: string | null = null;

  @field()
  title = '';
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

  it('uses qualified registry metadata for typed writable create parameters', () => {
    const qualifiedName =
      ObjectRegistry.getClassByConstructor(ToolLoopNote)?.qualifiedName;
    expect(qualifiedName).toBeTruthy();

    const tool: ManifestTool = {
      slug: 'tool_loop_notes.create',
      collection: 'tool_loop_notes',
      className: 'ToolLoopNote',
      qualifiedName,
      action: 'create',
    };
    const parameters = manifestToolToAITool(tool).function.parameters as {
      properties: Record<string, Record<string, unknown>>;
    };

    expect(parameters.properties.estimatedHours).toMatchObject({
      type: 'number',
      description: 'Estimated effort in decimal hours.',
    });
    expect(parameters.properties.isPinned).toMatchObject({
      type: 'boolean',
      description: 'Whether to pin this note for the team.',
    });
    expect(parameters.properties.state).toMatchObject({
      type: 'string',
      enum: ['draft', 'published'],
      description:
        'Workflow state. Use draft while editing and published when ready.',
    });
    // These fields are absent before the model can call the operation because
    // they are not writable through the generated CRUD policy.
    expect(parameters.properties.calculatedTotal).toBeUndefined();
    expect(parameters.properties.internalScore).toBeUndefined();
  });
});

describe('appendClientToolResults truncation', () => {
  it('cuts a browser result on a code-point boundary (#4378)', () => {
    const result = `${'x'.repeat(MAX_CLIENT_TOOL_RESULT_CHARS - 1)}\u{1F600}tail`;
    const [message] = appendClientToolResults(
      [],
      [{ id: 'c1', name: 'page_read', args: {}, effect: 'read' }],
      [{ id: 'c1', ok: true, result }],
    );
    const kept = (JSON.parse(String(message?.content)) as { result: string })
      .result;
    expect(kept.endsWith('… [truncated]')).toBe(true);
    const body = kept.slice(0, -'… [truncated]'.length);
    expect(body).toBe('x'.repeat(MAX_CLIENT_TOOL_RESULT_CHARS - 1));
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

  it('projects ordinary side-door reads through public JSON permissions', async () => {
    await grant('tool_loop_notes.read');
    const notes = await ObjectRegistry.getCollection('ToolLoopNote', { db });
    const seeded = await notes.create({ title: 'Visible' });
    (seeded as ToolLoopNote).internalMemo = 'never expose this';
    await seeded.save();
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? toolCall('tool_loop_notes.read', { id: seeded.id })
        : textResponse('done'),
    );

    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'read note' }],
      tools: tools(['tool_loop_notes.read']),
      principal: {
        runAsUserId: userId,
        tenantId,
        allowedTools: ['tool_loop_notes.read'],
      },
      audit: () => {},
    });

    expect(result.invocations[0]?.observation).toMatchObject({
      title: 'Visible',
    });
    expect(result.invocations[0]?.observation).not.toHaveProperty(
      'internalMemo',
    );
  });

  it('uses the registered MCP get serializer after principal gates', async () => {
    await grant('tool_loop_serialized_notes.read');
    const notes = await ObjectRegistry.getCollection('ToolLoopSerializedNote', {
      db,
    });
    const seeded = await notes.create({ title: 'Serialized' });
    await seeded.save();
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? toolCall('tool_loop_serialized_notes.read', { id: seeded.id })
        : textResponse('done'),
    );

    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'read serialized note' }],
      tools: tools(['tool_loop_serialized_notes.read']),
      principal: {
        runAsUserId: userId,
        tenantId,
        allowedTools: ['tool_loop_serialized_notes.read'],
      },
      audit: () => {},
    });

    expect(result.invocations[0]?.observation).toEqual({
      serializer: 'test',
      title: 'Serialized',
    });
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

  it('reports a validation or 4xx tool error as invalid_request with its message', async () => {
    class RequestError extends Error {
      readonly status = 400;
      readonly code = 'DATA_SURFACE_REQUEST_INVALID';
    }
    const cases: Array<[Error, string, string | undefined]> = [
      [
        new RequestError(
          'Unknown field "nme"; filterable fields: name, status.',
        ),
        'Unknown field "nme"; filterable fields: name, status.',
        'DATA_SURFACE_REQUEST_INVALID',
      ],
      [
        new ValidationError('title is required', 'VALIDATION_REQUIRED_FIELD'),
        'title is required',
        'VALIDATION_REQUIRED_FIELD',
      ],
      [
        Object.assign(new Error('Invoice amount is frozen'), {
          name: 'MoneyValidationError',
          code: 'FROZEN_DOCUMENT',
        }),
        'Invoice amount is frozen',
        'FROZEN_DOCUMENT',
      ],
      [
        Object.assign(new Error('internal detail'), {
          statusCode: 422,
          publicMessage: 'date must be YYYY-MM-DD',
        }),
        'date must be YYYY-MM-DD',
        undefined,
      ],
    ];
    for (const [thrown, message, code] of cases) {
      const ai = makeAI((_m, options) =>
        toolsOffered(options)
          ? toolCall('tool_loop_notes.read', {})
          : textResponse('done'),
      );
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'read' }],
        tools: tools(['tool_loop_notes.read']),
        principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
        maxSteps: 1,
        executeTool: async () => {
          throw thrown;
        },
        audit: () => {},
      });
      const invocation = result.invocations[0];
      if (!invocation) throw new Error('expected one invocation');
      expect(invocation).toMatchObject({
        ok: false,
        rejected: false,
        error: 'invalid_request',
      });
      expect(invocation.observation).toMatchObject({
        error: message,
        kind: 'invalid_request',
      });
      expect((invocation.observation as { code?: string }).code).toBe(code);
      expect(classifyToolError(thrown)).toBe('invalid_request');
    }
  });

  it('reports a real tool failure as execution_error', async () => {
    const failures = [
      new Error('connection reset'),
      Object.assign(new Error('upstream failed'), { status: 502 }),
      // The data surface's generic failure keeps its stable code.
      Object.assign(new Error('Data surface query failed.'), {
        status: 502,
        code: 'DATA_SURFACE_QUERY_FAILED',
      }),
    ];
    for (const thrown of failures) {
      const ai = makeAI((_m, options) =>
        toolsOffered(options)
          ? toolCall('tool_loop_notes.read', {})
          : textResponse('done'),
      );
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'read' }],
        tools: tools(['tool_loop_notes.read']),
        principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
        maxSteps: 1,
        executeTool: async () => {
          throw thrown;
        },
        audit: () => {},
      });
      expect(result.invocations[0]).toMatchObject({
        ok: false,
        rejected: false,
        error: 'execution_error',
        observation: {
          error: thrown.message,
          kind: 'execution_error',
          hint: TOOL_EXECUTION_ERROR_HINT,
        },
      });
      expect(classifyToolError(thrown)).toBe('execution_error');
    }
  });

  it('classifies HTTP statuses: 401/403 not permitted, 400/404/409/422 invalid, 429 and others execution', async () => {
    const withStatus = (status: number) =>
      Object.assign(new Error(`status ${status}`), { status });
    for (const status of [401, 403]) {
      expect(classifyToolError(withStatus(status))).toBe('not_permitted');
    }
    for (const status of [400, 404, 409, 422]) {
      expect(classifyToolError(withStatus(status))).toBe('invalid_request');
    }
    for (const status of [405, 418, 429, 500, 503]) {
      expect(classifyToolError(withStatus(status))).toBe('execution_error');
    }
    expect(
      classifyToolError(
        Object.assign(new Error('forbidden'), { statusCode: 403 }),
      ),
    ).toBe('not_permitted');

    const ai = makeAI((_m, options) =>
      toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'read' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      maxSteps: 1,
      executeTool: async () => {
        throw withStatus(403);
      },
      audit: () => {},
    });
    expect(result.invocations[0]).toMatchObject({
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

  it('appends the answer-now instruction to the forced final call only (#4378)', async () => {
    const seen: Array<{ offered: boolean; messages: AIMessage[] }> = [];
    const ai = makeAI((messages, options) => {
      seen.push({ offered: toolsOffered(options), messages: [...messages] });
      return toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('answered');
    });
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'how many notes?' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      maxSteps: 2,
      executeTool: async () => ({ count: 3 }),
      audit: () => {},
    });
    expect(result.stoppedReason).toBe('max_steps');
    expect(seen).toHaveLength(3);
    // Tool-offering rounds carry no instruction.
    for (const round of seen.slice(0, 2)) {
      expect(round.offered).toBe(true);
      expect(
        round.messages.some(
          (m) => m.content === TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
        ),
      ).toBe(false);
    }
    const final = seen[2];
    expect(final?.offered).toBe(false);
    expect(final?.messages.at(-1)).toEqual({
      role: 'user',
      content: TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
    });
    // The instruction is per-call: the returned transcript never holds it.
    expect(
      result.messages.some(
        (m) => m.content === TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
      ),
    ).toBe(false);
  });

  it('appends the answer-now instruction when the token budget is spent (#4378)', async () => {
    let last: AIMessage | undefined;
    const ai = makeAI((messages, options) => {
      if (!toolsOffered(options)) {
        last = messages.at(-1);
        return textResponse('within budget');
      }
      return {
        ...toolCall('tool_loop_notes.read', {}),
        usage: { promptTokens: 90, completionTokens: 20, totalTokens: 110 },
      };
    });
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'count' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      maxTotalTokens: 100,
      executeTool: async () => ({ count: 1 }),
      audit: () => {},
    });
    expect(result.stoppedReason).toBe('budget');
    expect(last?.content).toBe(TOOL_LOOP_ANSWER_NOW_INSTRUCTION);
  });

  it('sends no answer-now instruction when no tools are configured', async () => {
    let last: AIMessage | undefined;
    const ai = makeAI((messages) => {
      last = messages.at(-1);
      return textResponse('hi');
    });
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'hello' }],
      tools: [],
      principal: { runAsUserId: userId, tenantId, allowedTools: [] },
      audit: () => {},
    });
    expect(result.stoppedReason).toBe('no_tools');
    expect(last?.content).toBe('hello');
  });

  it('caps a large server observation with the narrow-your-query marker (#4378)', async () => {
    const big = {
      rows: Array.from({ length: 2_000 }, (_, i) => ({
        i,
        text: 'x'.repeat(40),
      })),
    };
    const seenTool: string[] = [];
    const ai = makeAI((messages, options, call) => {
      for (const m of messages) {
        if (m.role === 'tool') seenTool.push(String(m.content));
      }
      return call === 0 && toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('done');
    });
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'everything' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool: async () => big,
      audit: () => {},
    });
    const toolMessage = result.messages.find((m) => m.role === 'tool');
    const content = String(toolMessage?.content);
    expect(content.length).toBe(
      MAX_SERVER_TOOL_OBSERVATION_CHARS +
        SERVER_TOOL_OBSERVATION_TRUNCATED_MARKER.length,
    );
    expect(content.endsWith(SERVER_TOOL_OBSERVATION_TRUNCATED_MARKER)).toBe(
      true,
    );
    expect(seenTool[0]).toBe(content);
    // The invocation log keeps the full observation (persistence unchanged).
    expect(result.invocations[0]?.observation).toBe(big);
  });

  it('keeps an observation of exactly the cap untruncated (#4378)', async () => {
    // JSON.stringify adds two quotes.
    const exact = 'x'.repeat(MAX_SERVER_TOOL_OBSERVATION_CHARS - 2);
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'q' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool: async () => exact,
      audit: () => {},
    });
    const content = String(
      result.messages.find((m) => m.role === 'tool')?.content,
    );
    expect(content).toHaveLength(MAX_SERVER_TOOL_OBSERVATION_CHARS);
    expect(content).toBe(JSON.stringify(exact));
  });

  it('never splits a surrogate pair at the observation cut (#4378)', async () => {
    // '"' + 15998 x's puts an emoji's high surrogate at index 15999, the
    // last unit kept.
    const value = `${'x'.repeat(MAX_SERVER_TOOL_OBSERVATION_CHARS - 2)}\u{1F600}tail`;
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'q' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool: async () => value,
      audit: () => {},
    });
    const content = String(
      result.messages.find((m) => m.role === 'tool')?.content,
    );
    const kept = content.slice(
      0,
      content.length - SERVER_TOOL_OBSERVATION_TRUNCATED_MARKER.length,
    );
    expect(kept).toHaveLength(MAX_SERVER_TOOL_OBSERVATION_CHARS - 1);
    expect(/[\uD800-\uDBFF]$/.test(kept)).toBe(false);
    expect(content.endsWith(SERVER_TOOL_OBSERVATION_TRUNCATED_MARKER)).toBe(
      true,
    );
  });

  it('leaves a small server observation untouched and observes undefined as null', async () => {
    let n = 0;
    const ai = makeAI((_m, options, call) =>
      call < 2 && toolsOffered(options)
        ? toolCall('tool_loop_notes.read', {})
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'small' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool: async () => {
        n += 1;
        return n === 1 ? { count: 2 } : undefined;
      },
      audit: () => {},
    });
    const contents = result.messages
      .filter((m) => m.role === 'tool')
      .map((m) => m.content);
    expect(contents).toEqual(['{"count":2}', 'null']);
  });

  function rawToolCall(name: string, rawArguments: string): AIResponse {
    return {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: `tc_${Math.random().toString(36).slice(2)}`,
          type: 'function',
          function: { name, arguments: rawArguments },
        },
      ],
    };
  }

  it('answers malformed tool-argument JSON with invalid_request, never running the tool (#4378)', async () => {
    const executeTool = vi.fn(async () => ({ rows: 'all of them' }));
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? rawToolCall('tool_loop_notes.read', '{"where": {"state": "open-xyz"')
        : textResponse('retrying'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'open notes?' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool,
      audit: () => {},
    });
    expect(executeTool).not.toHaveBeenCalled();
    expect(result.invocations[0]).toMatchObject({
      ok: false,
      rejected: false,
      error: 'invalid_request',
      observation: {
        kind: 'invalid_request',
        code: 'TOOL_ARGUMENTS_MALFORMED',
      },
    });
    const content = String(
      result.messages.find((m) => m.role === 'tool')?.content,
    );
    expect(content).toContain('not a valid JSON object');
    expect(content).not.toContain('open-xyz');
  });

  it('rejects non-object argument JSON but treats blank or null as no arguments', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const raws = ['[1,2]', '"text"', '', 'null'];
    const ai = makeAI((_m, options, call) =>
      call < raws.length && toolsOffered(options)
        ? rawToolCall('tool_loop_notes.read', raws[call] as string)
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'x' }],
      tools: tools(['tool_loop_notes.read']),
      principal: { runAsUserId: userId, tenantId, allowedTools: NOTE_TOOLS },
      executeTool: async (ctx) => {
        seen.push(ctx.args);
        return { ok: true };
      },
      audit: () => {},
    });
    expect(result.invocations.map((i) => i.error ?? 'ok')).toEqual([
      'invalid_request',
      'invalid_request',
      'ok',
      'ok',
    ]);
    expect(seen).toEqual([{}, {}]);
  });

  it('answers a browser tool call with malformed arguments instead of suspending (#4378)', async () => {
    const ai = makeAI((_m, options, call) =>
      call === 0 && toolsOffered(options)
        ? rawToolCall('page_fill', '{not json')
        : textResponse('fixed'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'fill it' }],
      tools: [],
      clientTools: [
        {
          name: 'page_fill',
          description: 'Fill the form',
          inputSchema: { type: 'object' },
          effect: 'write',
        },
      ],
      principal: { runAsUserId: userId, tenantId, allowedTools: [] },
      audit: () => {},
    });
    expect(result.stoppedReason).toBe('stop');
    expect(result.pendingClientToolCalls).toEqual([]);
    expect(
      String(result.messages.find((m) => m.role === 'tool')?.content),
    ).toContain('TOOL_ARGUMENTS_MALFORMED');
  });

  it('rejects a stray filter or a non-object where on the manifest read tool (#4378)', async () => {
    await grant('tool_loop_notes.read');
    const notes = await ObjectRegistry.getCollection('ToolLoopNote', { db });
    for (const state of ['open', 'closed']) {
      await (await notes.create({ tenantId, title: state, state })).save();
    }
    const bad: Array<Record<string, unknown>> = [
      { filter: { state: 'open-value-1' } },
      { where: 'state = open-value-2' },
      { where: ['open-value-3'] },
      { limit: '10' },
      { id: 42 },
    ];
    const good = { where: { state: 'open' } };
    const ai = makeAI((_m, options, call) =>
      call <= bad.length && toolsOffered(options)
        ? toolCall('tool_loop_notes.read', bad[call] ?? good)
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'open notes' }],
      tools: tools(['tool_loop_notes.read']),
      principal: {
        runAsUserId: userId,
        tenantId,
        allowedTools: ['tool_loop_notes.read'],
      },
      maxSteps: 10,
      audit: () => {},
    });
    const failed = result.invocations.slice(0, bad.length);
    for (const invocation of failed) {
      expect(invocation).toMatchObject({
        ok: false,
        rejected: false,
        error: 'invalid_request',
        observation: { code: 'TOOL_ARGUMENTS_INVALID' },
      });
      expect(JSON.stringify(invocation.observation)).not.toMatch(
        /open-value|"filter"|\b42\b/,
      );
    }
    expect(
      String((failed[0]?.observation as { error: string }).error),
    ).toContain('accepts only id, where, limit and offset');
    expect(
      String((failed[1]?.observation as { error: string }).error),
    ).toContain('where must be an object');
    const ok = result.invocations[bad.length];
    expect(ok?.ok).toBe(true);
    expect(
      (ok?.observation as Array<{ state: string }>).map((row) => row.state),
    ).toEqual(['open']);
  });

  it('pins the read argument bounds: limit >= 1, offset >= 0, integers only (#4378)', async () => {
    await grant('tool_loop_notes.read');
    const cases: Array<[Record<string, unknown>, boolean, string?]> = [
      [{ limit: 1 }, true],
      [{ offset: 0 }, true],
      [{ limit: 0 }, false, 'limit must be an integer of at least 1'],
      [{ offset: -1 }, false, 'offset must be an integer of at least 0'],
      [{ limit: 2.5 }, false, 'limit must be an integer of at least 1'],
      [{ offset: 1.5 }, false, 'offset must be an integer of at least 0'],
      [{ id: 7 }, false, 'id must be a string'],
      [{ unknownKey: true }, false, 'accepts only id, where, limit and offset'],
    ];
    let call = 0;
    const ai = makeAI((_m, options) =>
      call < cases.length && toolsOffered(options)
        ? toolCall(
            'tool_loop_notes.read',
            (cases[call++] as [Record<string, unknown>])[0],
          )
        : textResponse('done'),
    );
    const result = await runToolLoop({
      ai,
      db,
      messages: [{ role: 'user', content: 'q' }],
      tools: tools(['tool_loop_notes.read']),
      principal: {
        runAsUserId: userId,
        tenantId,
        allowedTools: ['tool_loop_notes.read'],
      },
      maxSteps: cases.length + 1,
      audit: () => {},
    });
    expect(result.invocations).toHaveLength(cases.length);
    cases.forEach(([, ok, message], index) => {
      const invocation = result.invocations[index];
      expect(invocation?.ok).toBe(ok);
      if (!ok) {
        expect(invocation?.error).toBe('invalid_request');
        expect(
          String((invocation?.observation as { error: string }).error),
        ).toContain(message);
      }
    });
  });

  it('offers the read tool a closed schema with integer limit/offset bounds (#4378)', () => {
    const [read] = tools(['tool_loop_notes.read']);
    const parameters = manifestToolToAITool(read as ManifestTool).function
      .parameters as {
      additionalProperties?: unknown;
      properties: Record<string, Record<string, unknown>>;
    };
    expect(parameters.additionalProperties).toBe(false);
    expect(Object.keys(parameters.properties).sort()).toEqual([
      'id',
      'limit',
      'offset',
      'where',
    ]);
    expect(parameters.properties.limit).toEqual({
      type: 'integer',
      minimum: 1,
    });
    expect(parameters.properties.offset).toEqual({
      type: 'integer',
      minimum: 0,
    });
    expect(parameters.properties.where?.type).toBe('object');
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

    it('uses the generated writable policy before assigning update fields', async () => {
      await grant('tool_loop_notes.update');
      const notes = await ObjectRegistry.getCollection('ToolLoopNote', { db });
      const seeded = await notes.create({
        tenantId,
        title: 'Before',
        body: 'unchanged',
        calculatedTotal: 120,
        internalScore: 7,
      });
      await seeded.save();

      const ai = makeAI((_messages, options, call) =>
        call === 0 && toolsOffered(options)
          ? toolCall('tool_loop_notes.update', {
              id: seeded.id,
              title: 'Allowed title',
              calculatedTotal: 0,
              internalScore: 999,
            })
          : textResponse('updated'),
      );
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'update the note' }],
        tools: tools(['tool_loop_notes.update']),
        principal: {
          runAsUserId: userId,
          tenantId,
          allowedTools: ['tool_loop_notes.update'],
        },
        audit: () => {},
      });

      expect(result.invocations[0]).toMatchObject({ ok: true });
      const updated = await notes.get(seeded.id as string);
      expect(updated?.title).toBe('Allowed title');
      // A model cannot mass-assign either a readonly calculated field or an
      // ordinary field excluded by api.writable.
      expect(updated?.calculatedTotal).toBe(120);
      expect(updated?.internalScore).toBe(7);
    });
  });
});
