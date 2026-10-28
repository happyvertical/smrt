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
import type {
  PrincipalAuditEntry,
  PrincipalTool,
} from '@happyvertical/smrt-agents';
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
  DEFAULT_EMPTY_ANSWER_FALLBACK,
  DEFAULT_MAX_REPEATED_CALLS,
  MAX_CLIENT_TOOL_RESULT_CHARS,
  MAX_DEDUPED_CALLS_PER_TURN,
  MAX_REPEATED_CALLS_LIMIT,
  MAX_SERVER_TOOL_OBSERVATION_CHARS,
  MAX_TOOL_FAILURE_ARGS_CHARS,
  MAX_TOOL_LOOP_REASONING_CHARS,
  type ManifestTool,
  manifestToolToAITool,
  replyContentFor,
  replyMetadataFor,
  resolveMaxRepeatedCalls,
  runToolLoop,
  SERVER_TOOL_OBSERVATION_TRUNCATED_MARKER,
  TOOL_CALL_DEDUPED_NOTE,
  TOOL_CALL_DEDUPED_REJECTED_NOTE,
  TOOL_EXECUTION_ERROR_HINT,
  TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
  TOOL_LOOP_REPEATED_CALLS_INSTRUCTION,
  type ToolExecutionContext,
  toolFailureAuditMetadata,
  toolFailureRecord,
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

  it('bounds a failed call record and keeps only stable codes (#4383)', () => {
    const big = toolFailureRecord({
      slug: 'x.read',
      args: { q: 'y'.repeat(MAX_TOOL_FAILURE_ARGS_CHARS) },
      ok: false,
      rejected: false,
      observation: { error: 'bad', code: 'lower case not stable' },
      error: 'invalid_request',
      modelContent: '{"error":"bad"}',
    });
    expect(big).toEqual({
      name: 'x.read',
      args: { truncated: true },
      argsChars: JSON.stringify({ q: 'y'.repeat(MAX_TOOL_FAILURE_ARGS_CHARS) })
        .length,
      status: 'error',
      errorKind: 'invalid_request',
      errorCode: 'invalid_request',
      shown: '{"error":"bad"}',
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(
      toolFailureRecord({
        slug: 'x.read',
        args: circular,
        ok: false,
        rejected: true,
        observation: { error: 'denied', code: 'DENIED_CODE' },
        error: 'not_permitted',
      }),
    ).toMatchObject({
      args: { unserializable: true },
      argsChars: 0,
      status: 'rejected',
      errorCode: 'DENIED_CODE',
    });
    expect(
      toolFailureRecord({
        slug: 'x.read',
        args: {},
        ok: true,
        rejected: false,
        observation: {},
      }),
    ).toBeNull();
  });

  it('audits the original argument size, not the truncation stand-in (#4383)', () => {
    const args = { q: 'y'.repeat(MAX_TOOL_FAILURE_ARGS_CHARS) };
    const record = toolFailureRecord({
      slug: 'x.read',
      args,
      ok: false,
      rejected: false,
      observation: { error: 'bad' },
      error: 'invalid_request',
      modelContent: '{"error":"bad"}',
    });
    expect(record && toolFailureAuditMetadata(record)).toEqual({
      name: 'x.read',
      status: 'error',
      errorKind: 'invalid_request',
      errorCode: 'invalid_request',
      argsChars: JSON.stringify(args).length,
      shownChars: '{"error":"bad"}'.length,
    });
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
    // The model always wants another (distinct) tool call while tools are
    // offered; identical reads would be deduped (#4382).
    let page = 0;
    const ai = makeAI((_m, options) =>
      toolsOffered(options)
        ? toolCall('tool_loop_notes.read', { offset: page++ })
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
        ? toolCall('tool_loop_notes.read', { offset: call })
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
    expect(result.invocations.slice(2).map((i) => i.args)).toEqual([{}, {}]);
    // Blank and null are the same no-argument read, so the repeat is
    // deduped (#4382) rather than run twice.
    expect(seen).toEqual([{}]);
    expect(result.invocations[3]?.deduped).toBe(true);
  });

  it('records and audits a malformed browser tool call (#4383)', async () => {
    const audits: PrincipalAuditEntry[] = [];
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
      audit: (entry) => {
        audits.push(entry);
      },
    });
    expect(result.invocations).toEqual([
      expect.objectContaining({
        slug: 'page_fill',
        ok: false,
        error: 'invalid_request',
      }),
    ]);
    expect(audits.filter((a) => a.action === 'chat.tool_call_failed')).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          name: 'page_fill',
          errorCode: 'TOOL_ARGUMENTS_MALFORMED',
        }),
      }),
    ]);
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
      String((failed[0]?.observation as { error: string } | undefined)?.error),
    ).toContain('accepts only id, where, limit and offset');
    expect(
      String((failed[1]?.observation as { error: string } | undefined)?.error),
    ).toContain('where must be an object');
    const ok = result.invocations[bad.length];
    expect(ok?.ok).toBe(true);
    expect(
      (ok?.observation as Array<{ state: string }> | undefined)?.map(
        (row) => row.state,
      ),
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
          String(
            (invocation?.observation as { error: string } | undefined)?.error,
          ),
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

  describe('dedupe of identical read-only calls (#4382)', () => {
    function queryTool(
      runs: Array<Record<string, unknown>>,
      fail?: () => Error | null,
    ): PrincipalTool {
      return {
        slug: 'data.query',
        aiTool: {
          type: 'function',
          function: {
            name: 'data-query',
            description: 'Query.',
            parameters: { type: 'object' },
          },
        },
        async execute({ args }) {
          runs.push(args);
          const error = fail?.();
          if (error) throw error;
          return { total: 3 };
        },
      };
    }
    const allow = () => ({
      runAsUserId: userId,
      tenantId,
      allowedTools: [...NOTE_TOOLS, 'data.query'],
    });

    it('runs an identical read-only call once, even with keys reordered, and audits the repeat', async () => {
      const runs: Array<Record<string, unknown>> = [];
      const sequence = [
        {
          surfaceId: 's',
          request: { mode: 'count', filter: { kind: 'all', filters: [] } },
        },
        {
          request: { filter: { filters: [], kind: 'all' }, mode: 'count' },
          surfaceId: 's',
        },
        { surfaceId: 's', request: { mode: 'count' } },
      ];
      let n = 0;
      const ai = makeAI((_m, options) =>
        toolsOffered(options) && n < sequence.length
          ? toolCall('data-query', sequence[n++] as Record<string, unknown>)
          : textResponse('3'),
      );
      const audits: PrincipalAuditEntry[] = [];
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'count' }],
        tools: [],
        extraTools: [queryTool(runs)],
        principal: allow(),
        audit: (entry) => {
          audits.push(entry);
        },
      });
      expect(runs).toHaveLength(2);
      expect(result.invocations.map((i) => Boolean(i.deduped))).toEqual([
        false,
        true,
        false,
      ]);
      expect(result.invocations[1]).toMatchObject({
        ok: true,
        observation: { deduped: true, note: TOOL_CALL_DEDUPED_NOTE },
      });
      expect(
        audits.filter((a) => a.action === 'chat.tool_call_deduped'),
      ).toHaveLength(1);
    });

    it('forgets remembered reads after a write: read, create, read runs fresh (#4382)', async () => {
      await grant('tool_loop_notes.read');
      await grant('tool_loop_notes.create');
      const read = { where: { title: 'Fresh' } };
      const sequence = [
        ['tool_loop_notes.read', read],
        ['tool_loop_notes.create', { title: 'Fresh', tenantId }],
        ['tool_loop_notes.read', read],
      ] as const;
      let n = 0;
      const ai = makeAI((_m, options) =>
        toolsOffered(options) && n < sequence.length
          ? toolCall(sequence[n][0], sequence[n++][1])
          : textResponse('done'),
      );
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: tools(['tool_loop_notes.read', 'tool_loop_notes.create']),
        principal: allow(),
        audit: () => {},
      });
      expect(result.invocations.map((i) => Boolean(i.deduped))).toEqual([
        false,
        false,
        false,
      ]);
      expect(result.invocations[0]?.observation).toEqual([]);
      expect(
        (
          result.invocations[2]?.observation as
            | Array<{ title: string }>
            | undefined
        )?.map((row) => row.title),
      ).toEqual(['Fresh']);
    });

    it('forgets remembered reads after any non-read-only extra tool (#4382)', async () => {
      const runs: Array<Record<string, unknown>> = [];
      const other: PrincipalTool = {
        slug: 'other.tool',
        aiTool: {
          type: 'function',
          function: {
            name: 'other-tool',
            description: 'Other.',
            parameters: { type: 'object' },
          },
        },
        async execute() {
          throw new Error('failed anyway');
        },
      };
      const sequence = [
        ['data-query', { surfaceId: 's' }],
        ['other-tool', {}],
        ['data-query', { surfaceId: 's' }],
      ] as const;
      let n = 0;
      const ai = makeAI((_m, options) =>
        toolsOffered(options) && n < sequence.length
          ? toolCall(sequence[n][0], sequence[n++][1])
          : textResponse('done'),
      );
      await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        extraTools: [queryTool(runs), other],
        principal: { ...allow(), allowedTools: ['data.query', 'other.tool'] },
        audit: () => {},
      });
      // The other tool failed, but it is not read-only: the cache is cleared.
      expect(runs).toHaveLength(2);
    });

    it('tells the model a deduped repeat of a rejected call will fail again (#4382)', async () => {
      const runs: Array<Record<string, unknown>> = [];
      const ai = makeAI((_m, options, call) =>
        toolsOffered(options) && call < 2
          ? toolCall('data-query', { request: { surfaceId: 's' } })
          : textResponse('done'),
      );
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        extraTools: [
          queryTool(runs, () =>
            Object.assign(new Error('bad request'), { status: 400 }),
          ),
        ],
        principal: allow(),
        audit: () => {},
      });
      expect(runs).toHaveLength(1);
      expect(result.invocations[1]).toMatchObject({
        ok: false,
        deduped: true,
        error: 'invalid_request',
        observation: { deduped: true, note: TOOL_CALL_DEDUPED_REJECTED_NOTE },
      });
    });

    it('bounds the cache at 64 calls and never keys oversized arguments (#4382)', async () => {
      const runs: Array<Record<string, unknown>> = [];
      const big = { surfaceId: 's', pad: 'z'.repeat(4_100) };
      const sequence: Array<Record<string, unknown>> = [
        ...Array.from({ length: MAX_DEDUPED_CALLS_PER_TURN + 1 }, (_, i) => ({
          surfaceId: `s${i}`,
        })),
        // The 65th distinct call was not remembered: it runs again.
        { surfaceId: `s${MAX_DEDUPED_CALLS_PER_TURN}` },
        // The first is still remembered: deduped.
        { surfaceId: 's0' },
        big,
        big,
      ];
      let n = 0;
      const ai = makeAI((_m, options) =>
        toolsOffered(options) && n < sequence.length
          ? toolCall('data-query', sequence[n++] as Record<string, unknown>)
          : textResponse('done'),
      );
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        extraTools: [queryTool(runs)],
        principal: allow(),
        maxSteps: sequence.length + 1,
        audit: () => {},
      });
      const deduped = result.invocations.map((i) => Boolean(i.deduped));
      expect(deduped.slice(0, MAX_DEDUPED_CALLS_PER_TURN + 1)).not.toContain(
        true,
      );
      expect(deduped.slice(MAX_DEDUPED_CALLS_PER_TURN + 1)).toEqual([
        false,
        true,
        false,
        false,
      ]);
      expect(runs).toHaveLength(sequence.length - 1);
    });

    it('never dedupes a mutating call, and retries after a server failure', async () => {
      await grant('tool_loop_notes.create');
      const sequence = [
        ['tool_loop_notes.create', { title: 'Same', tenantId }],
        ['tool_loop_notes.create', { title: 'Same', tenantId }],
        ['data-query', { surfaceId: 's' }],
        ['data-query', { surfaceId: 's' }],
      ] as const;
      let n = 0;
      const ai = makeAI((_m, options) =>
        toolsOffered(options) && n < sequence.length
          ? toolCall(sequence[n][0], sequence[n++][1])
          : textResponse('done'),
      );
      const runs: Array<Record<string, unknown>> = [];
      let failures = 1;
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: tools(['tool_loop_notes.create']),
        extraTools: [
          queryTool(runs, () =>
            failures-- > 0
              ? Object.assign(new Error('down'), { status: 503 })
              : null,
          ),
        ],
        principal: allow(),
        audit: () => {},
      });
      expect(result.invocations.map((i) => Boolean(i.deduped))).toEqual([
        false,
        false,
        false,
        false,
      ]);
      expect(runs).toHaveLength(2);
      const notes = await ObjectRegistry.getCollection('ToolLoopNote', { db });
      expect(await notes.list({ where: { title: 'Same' } })).toHaveLength(2);
    });

    it('counts deduped rounds toward the step cap and never dedupes across turns', async () => {
      const runs: Array<Record<string, unknown>> = [];
      const ai = () =>
        makeAI((_m, options) =>
          toolsOffered(options)
            ? toolCall('data-query', { surfaceId: 's' })
            : textResponse('stop'),
        );
      const options = {
        db,
        messages: [{ role: 'user' as const, content: 'loop' }],
        tools: [],
        extraTools: [queryTool(runs)],
        principal: allow(),
        maxSteps: 3,
        // The repeated-call stop (#4391) is off: this pins the step cap.
        maxRepeatedCalls: 0,
        audit: () => {},
      };
      const first = await runToolLoop({ ai: ai(), ...options });
      expect(first.stoppedReason).toBe('max_steps');
      expect(first.steps).toBe(3);
      expect(runs).toHaveLength(1);
      await runToolLoop({ ai: ai(), ...options });
      expect(runs).toHaveLength(2);
    });
  });

  describe('repeated deduped calls end the tool phase (#4391)', () => {
    const allow = () => ({
      runAsUserId: userId,
      tenantId,
      allowedTools: [...NOTE_TOOLS, 'data.query'],
    });
    function queryTool(runs: Array<Record<string, unknown>>): PrincipalTool {
      return {
        slug: 'data.query',
        aiTool: {
          type: 'function',
          function: {
            name: 'data-query',
            description: 'Query.',
            parameters: { type: 'object' },
          },
        },
        async execute({ args }) {
          runs.push(args);
          return { total: 3 };
        },
      };
    }
    /** A model that always calls `next()` while tools are offered. */
    function scripted(next: (round: number) => AIResponse) {
      const seen: Array<{ messages: AIMessage[]; tools: boolean }> = [];
      let round = 0;
      const ai = makeAI((messages, options) => {
        const tools = toolsOffered(options);
        seen.push({ messages: [...messages], tools });
        return tools ? next(round++) : textResponse('There are 3.');
      });
      return { ai, seen };
    }
    const count = { surfaceId: 's', request: { mode: 'count' } };

    it('makes the next call the answer-now call after two repeats', async () => {
      const runs: Array<Record<string, unknown>> = [];
      const { ai, seen } = scripted(() => toolCall('data-query', count));
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'open work orders?' }],
        tools: [],
        extraTools: [queryTool(runs)],
        principal: allow(),
        audit: () => {},
      });
      expect(result).toMatchObject({
        content: 'There are 3.',
        stoppedReason: 'repeated_calls',
        capReason: 'repeated_calls',
        steps: 3,
      });
      expect(runs).toHaveLength(1);
      expect(result.invocations.map((i) => Boolean(i.deduped))).toEqual([
        false,
        true,
        true,
      ]);
      expect(result.invocations[1]?.observation).toEqual({
        deduped: true,
        note: TOOL_CALL_DEDUPED_NOTE,
      });
      // Three tool rounds, then one no-tools call carrying the instruction.
      expect(seen.map((c) => c.tools)).toEqual([true, true, true, false]);
      const final = seen.at(-1)?.messages ?? [];
      // The repeated-calls path adds one sentence to the same instruction.
      expect(final.at(-1)).toEqual({
        role: 'user',
        content: `${TOOL_LOOP_ANSWER_NOW_INSTRUCTION} ${TOOL_LOOP_REPEATED_CALLS_INSTRUCTION}`,
      });
      expect(TOOL_LOOP_ANSWER_NOW_INSTRUCTION).toContain(
        'If they do not answer the question, say so.',
      );
      expect(TOOL_LOOP_REPEATED_CALLS_INSTRUCTION).toBe(
        'If the results above do not match what was asked (for example, a ' +
          'total where a filtered count was asked), say you could not get ' +
          'that figure rather than presenting the result as the answer.',
      );
      // The returned transcript stays valid: every call has its result, and
      // the instruction is not stored.
      const callIds = result.messages.flatMap((m) =>
        'tool_calls' in m && Array.isArray(m.tool_calls)
          ? m.tool_calls.map((c: { id: string }) => c.id)
          : [],
      );
      const answered = result.messages
        .filter((m) => m.role === 'tool')
        .map((m) => (m as { tool_call_id?: string }).tool_call_id);
      expect(callIds).toHaveLength(3);
      expect(answered).toEqual(callIds);
      expect(
        result.messages.some(
          (m) => m.content === TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
        ),
      ).toBe(false);
    });

    it('answers every call of a round that hits the limit before stopping', async () => {
      const runs: Array<Record<string, unknown>> = [];
      const triple: AIResponse = {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: ['a', 'b', 'c'].map((id) => ({
          id,
          type: 'function' as const,
          function: { name: 'data-query', arguments: JSON.stringify(count) },
        })),
      };
      const { ai, seen } = scripted(() => triple);
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        extraTools: [queryTool(runs)],
        principal: allow(),
        audit: () => {},
      });
      expect(result.stoppedReason).toBe('repeated_calls');
      expect(result.steps).toBe(1);
      expect(seen.map((c) => c.tools)).toEqual([true, false]);
      expect(
        result.messages
          .filter((m) => m.role === 'tool')
          .map((m) => (m as { tool_call_id?: string }).tool_call_id),
      ).toEqual(['a', 'b', 'c']);
    });

    it('keeps the plain instruction on the max_steps path', async () => {
      const { ai, seen } = scripted(() => toolCall('data-query', count));
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        extraTools: [queryTool([])],
        principal: allow(),
        maxSteps: 2,
        maxRepeatedCalls: 0,
        audit: () => {},
      });
      expect(result.capReason).toBe('max_steps');
      const content = String(seen.at(-1)?.messages.at(-1)?.content);
      expect(content).toBe(TOOL_LOOP_ANSWER_NOW_INSTRUCTION);
      expect(content).not.toContain(TOOL_LOOP_REPEATED_CALLS_INSTRUCTION);
    });

    it('does not count a call with different arguments as a repeat', async () => {
      const runs: Array<Record<string, unknown>> = [];
      const sequence = [
        count,
        count,
        { surfaceId: 's', request: { mode: 'count', filter: { open: 1 } } },
      ];
      const { ai } = scripted((round) =>
        round < sequence.length
          ? toolCall('data-query', sequence[round] as Record<string, unknown>)
          : textResponse('There are 2 open.'),
      );
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: [],
        extraTools: [queryTool(runs)],
        principal: allow(),
        audit: () => {},
      });
      expect(result.stoppedReason).toBe('stop');
      expect(result.capReason).toBeUndefined();
      expect(result.content).toBe('There are 2 open.');
      expect(runs).toHaveLength(2);
    });

    it('takes a configurable limit, and 0 turns it off', async () => {
      const run = async (maxRepeatedCalls: number) => {
        const { ai } = scripted(() => toolCall('data-query', count));
        return runToolLoop({
          ai,
          db,
          messages: [{ role: 'user', content: 'x' }],
          tools: [],
          extraTools: [queryTool([])],
          principal: allow(),
          maxSteps: 6,
          maxRepeatedCalls,
          audit: () => {},
        });
      };
      const one = await run(1);
      expect(one).toMatchObject({ stoppedReason: 'repeated_calls', steps: 2 });
      const three = await run(3);
      expect(three).toMatchObject({
        stoppedReason: 'repeated_calls',
        steps: 4,
      });
      const off = await run(0);
      expect(off).toMatchObject({ stoppedReason: 'max_steps', steps: 6 });
      expect(off.capReason).toBe('max_steps');
      // Bounded: a huge limit is capped, so it never outlives maxSteps here.
      expect(resolveMaxRepeatedCalls(1_000)).toBe(MAX_REPEATED_CALLS_LIMIT);
      expect(resolveMaxRepeatedCalls(undefined)).toBe(
        DEFAULT_MAX_REPEATED_CALLS,
      );
      expect(resolveMaxRepeatedCalls(Number.NaN)).toBe(
        DEFAULT_MAX_REPEATED_CALLS,
      );
      expect(resolveMaxRepeatedCalls(-1)).toBe(0);
      expect(resolveMaxRepeatedCalls(2.9)).toBe(2);
    });

    it('never counts a mutating call, and a write resets the counts', async () => {
      await grant('tool_loop_notes.create');
      const create = { title: 'Again', tenantId };
      const sequence = [
        ['tool_loop_notes.create', create],
        ['tool_loop_notes.create', create],
        ['tool_loop_notes.create', create],
        ['data-query', count],
        ['data-query', count],
        ['tool_loop_notes.create', create],
        ['data-query', count],
        ['data-query', count],
      ] as const;
      const runs: Array<Record<string, unknown>> = [];
      const { ai } = scripted((round) =>
        round < sequence.length
          ? toolCall(sequence[round][0], sequence[round][1])
          : textResponse('done'),
      );
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'x' }],
        tools: tools(['tool_loop_notes.create']),
        extraTools: [queryTool(runs)],
        principal: allow(),
        maxSteps: sequence.length + 1,
        audit: () => {},
      });
      // One deduped query before the write, one after: never two in a row.
      expect(result.stoppedReason).toBe('stop');
      expect(result.capReason).toBeUndefined();
      expect(result.invocations.map((i) => Boolean(i.deduped))).toEqual([
        false,
        false,
        false,
        false,
        true,
        false,
        false,
        true,
      ]);
      const notes = await ObjectRegistry.getCollection('ToolLoopNote', { db });
      expect(await notes.list({ where: { title: 'Again' } })).toHaveLength(4);
    });

    it('persists capReason in the stored reply metadata', () => {
      expect(
        replyMetadataFor(
          { stoppedReason: 'repeated_calls', capReason: 'repeated_calls' },
          { content: 'There are 3.' },
        ),
      ).toEqual({
        stoppedReason: 'repeated_calls',
        capReason: 'repeated_calls',
      });
      expect(
        replyMetadataFor(
          { stoppedReason: 'empty', capReason: 'repeated_calls' },
          { content: 'x', fallback: 'empty' },
        ),
      ).toEqual({
        stoppedReason: 'empty',
        capReason: 'repeated_calls',
        fallback: 'empty',
      });
    });
  });

  describe('blank answers and timeouts (#4379)', () => {
    const principal = () => ({
      runAsUserId: userId,
      tenantId,
      allowedTools: NOTE_TOOLS,
    });
    const hasInstruction = (messages: AIMessage[]) =>
      messages.at(-1)?.content === TOOL_LOOP_ANSWER_NOW_INSTRUCTION;

    it.each(
      [false, true].flatMap((offered) =>
        [false, true].flatMap((multipart) =>
          [false, true].map((blankAgain) => ({
            offered,
            multipart,
            blankAgain,
          })),
        ),
      ),
    )('keeps strict user-role alternation on first-blank retry ($offered/$multipart/$blankAgain)', async ({
      offered,
      multipart,
      blankAgain,
    }) => {
      const content: AIMessage['content'] = multipart
        ? [
            { type: 'text', text: 'What is shown?' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,cGljdHVyZQ==' },
            },
          ]
        : 'What is shown?';
      const input: AIMessage[] = [
        { role: 'system', content: 'Answer the question.' },
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content, name: 'subject' },
      ];
      const original = structuredClone(input);
      for (const message of input) Object.freeze(message);
      if (Array.isArray(content)) Object.freeze(content);
      Object.freeze(input);
      const seen: AIMessage[][] = [];
      const ai = makeAI((messages, options, call) => {
        const turns = messages.filter((message) => message.role !== 'system');
        for (let i = 1; i < turns.length; i++) {
          if (turns[i]?.role === turns[i - 1]?.role)
            throw new Error('strict template forbids consecutive user roles');
        }
        seen.push(structuredClone(messages));
        if (call === 0) return textResponse('');
        expect(toolsOffered(options)).toBe(false);
        expect(options?.toolChoice).toBe('none');
        return textResponse(blankAgain ? '' : 'The answer.');
      });
      const result = await runToolLoop({
        ai,
        db,
        messages: input,
        tools: offered ? tools(['tool_loop_notes.read']) : [],
        principal: principal(),
        audit: () => {},
      });
      expect(seen).toHaveLength(2);
      expect(seen[0]).toEqual(original);
      expect(seen[1]).toEqual([
        ...original.slice(0, -1),
        {
          ...original.at(-1),
          content: multipart
            ? [
                ...content,
                { type: 'text', text: TOOL_LOOP_ANSWER_NOW_INSTRUCTION },
              ]
            : `${content}\n\n${TOOL_LOOP_ANSWER_NOW_INSTRUCTION}`,
        },
      ]);
      expect(input).toEqual(original);
      expect(result.messages).toEqual(original);
      expect(result.emptyRetried).toBe(true);
      expect(replyContentFor(result)).toBe(
        blankAgain ? DEFAULT_EMPTY_ANSWER_FALLBACK : 'The answer.',
      );
    });

    it.each([
      'max_steps',
      'budget',
    ] as const)('keeps strict user-role alternation when %s forces the first call', async (cap) => {
      const input: AIMessage[] = [{ role: 'user', content: 'Question' }];
      const seen: AIMessage[][] = [];
      const ai = makeAI((messages, options) => {
        if (messages.length !== 1 || messages[0]?.role !== 'user')
          throw new Error('strict template forbids consecutive user roles');
        seen.push(structuredClone(messages));
        expect(toolsOffered(options)).toBe(false);
        return textResponse('The answer.');
      });
      const result = await runToolLoop({
        ai,
        db,
        messages: input,
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        ...(cap === 'max_steps' ? { maxSteps: 0 } : { maxTotalTokens: 0 }),
        audit: () => {},
      });
      expect(seen).toEqual([
        [
          {
            role: 'user',
            content: `Question\n\n${TOOL_LOOP_ANSWER_NOW_INSTRUCTION}`,
          },
        ],
      ]);
      expect(result.stoppedReason).toBe(cap);
      expect(result.messages).toEqual(input);
      expect(input).toEqual([{ role: 'user', content: 'Question' }]);
    });

    it('retries a blank answer after a tool round once, without tools, with the answer-now instruction', async () => {
      const calls: Array<{ offered: boolean; instructed: boolean }> = [];
      const ai = makeAI((messages, options, call) => {
        calls.push({
          offered: toolsOffered(options),
          instructed: hasInstruction(messages),
        });
        if (call === 0) return toolCall('tool_loop_notes.read', {});
        if (call === 1) return textResponse('');
        return textResponse('There are 3 open notes.');
      });
      const steps: string[] = [];
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'how many open notes?' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        executeTool: async () => ({ count: 3 }),
        onStep: (event) => steps.push(event.type),
        audit: () => {},
      });
      expect(calls).toEqual([
        { offered: true, instructed: false },
        { offered: true, instructed: false },
        { offered: false, instructed: true },
      ]);
      expect(result).toMatchObject({
        stoppedReason: 'stop',
        content: 'There are 3 open notes.',
        emptyRetried: true,
      });
      expect(steps.filter((type) => type === 'empty_round')).toHaveLength(1);
      expect(
        result.messages.some(
          (m) => m.content === TOOL_LOOP_ANSWER_NOW_INSTRUCTION,
        ),
      ).toBe(false);
    });

    it('reports empty when the retry is blank too, and retries only once', async () => {
      const chat = vi.fn(
        async (_m: AIMessage[], options?: ChatOptions): Promise<AIResponse> =>
          toolsOffered(options) && chat.mock.calls.length === 1
            ? toolCall('tool_loop_notes.read', {})
            : textResponse('   '),
      );
      const result = await runToolLoop({
        ai: { chat } as unknown as AIInterface,
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        executeTool: async () => ({ count: 0 }),
        audit: () => {},
      });
      expect(chat).toHaveBeenCalledTimes(3);
      expect(result).toMatchObject({
        stoppedReason: 'empty',
        content: '',
        emptyRetried: true,
      });
      expect(replyContentFor(result)).toBe(DEFAULT_EMPTY_ANSWER_FALLBACK);
      expect(replyContentFor(result, 'Nothing to report.')).toBe(
        'Nothing to report.',
      );
    });

    it('retries a blank forced final call whose tool calls were discarded', async () => {
      const instructed: boolean[] = [];
      const ai = makeAI((messages, _options, call) => {
        instructed.push(hasInstruction(messages));
        // Round 0 calls a tool; the forced final call (1) still emits a tool
        // call and no text; the retry (2) answers.
        if (call < 2) return toolCall('tool_loop_notes.read', {});
        return textResponse('Answer at the cap.');
      });
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        maxSteps: 1,
        executeTool: async () => ({ count: 1 }),
        audit: () => {},
      });
      expect(instructed).toEqual([false, true, true]);
      expect(result).toMatchObject({
        stoppedReason: 'max_steps',
        content: 'Answer at the cap.',
        emptyRetried: true,
      });
    });

    it('reads reasoning defensively, reports it, and never answers from it without the opt-in', async () => {
      const reasoningOnly = (): AIResponse =>
        ({
          content: '',
          finishReason: 'stop',
          reasoning: `The count is 4.${' pad'.repeat(2_000)}`,
        }) as AIResponse;
      const seen: string[] = [];
      const ai = makeAI(() => reasoningOnly());
      const result = await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        onReasoning: (text) => seen.push(text),
        audit: () => {},
      });
      expect(result.stoppedReason).toBe('empty');
      expect(result.content).toBe('');
      expect(result.reasoning?.startsWith('The count is 4.')).toBe(true);
      expect(result.reasoning?.length).toBe(MAX_TOOL_LOOP_REASONING_CHARS);
      expect(seen).toHaveLength(2);

      const optedIn = await runToolLoop({
        ai: makeAI(() => reasoningOnly()),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        answerFromReasoning: true,
        audit: () => {},
      });
      expect(optedIn).toMatchObject({
        stoppedReason: 'stop',
        contentFromReasoning: true,
      });
      expect(optedIn.content.startsWith('The count is 4.')).toBe(true);
    });

    it('works with an SDK that has no reasoning field', async () => {
      const result = await runToolLoop({
        ai: makeAI(() => ({ content: 'plain', finishReason: 'stop' })),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        audit: () => {},
      });
      expect(result.content).toBe('plain');
      expect(result).not.toHaveProperty('reasoning');
      expect(result).not.toHaveProperty('emptyRetried');
    });

    it('forwards requestTimeoutMs as the per-call timeout', async () => {
      const timeouts: Array<number | undefined> = [];
      await runToolLoop({
        ai: makeAI((_m, options) => {
          timeouts.push((options as { timeout?: number }).timeout);
          return textResponse('ok');
        }),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        requestTimeoutMs: 30_000,
        audit: () => {},
      });
      expect(timeouts).toEqual([30_000]);
    });

    it('turns a timed-out model call into stoppedReason timeout, not an error or empty success', async () => {
      for (const error of [
        Object.assign(new Error('Request timed out'), { code: 'AI_TIMEOUT' }),
        Object.assign(new Error('t'), { name: 'TimeoutError' }),
        Object.assign(new Error('aborted'), { name: 'AbortError' }),
      ]) {
        const ai = makeAI(() => {
          throw error;
        });
        const result = await runToolLoop({
          ai,
          db,
          messages: [{ role: 'user', content: 'q' }],
          tools: tools(['tool_loop_notes.read']),
          principal: principal(),
          audit: () => {},
        });
        expect(result).toMatchObject({ stoppedReason: 'timeout', content: '' });
      }
    });

    it('reports a caller abort as cancelled and rethrows other failures', async () => {
      const controller = new AbortController();
      const aborted = await runToolLoop({
        ai: makeAI(() => {
          controller.abort();
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        }),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        principal: principal(),
        signal: controller.signal,
        audit: () => {},
      });
      expect(aborted.stoppedReason).toBe('cancelled');
      await expect(
        runToolLoop({
          ai: makeAI(() => {
            throw new Error('boom');
          }),
          db,
          messages: [{ role: 'user', content: 'q' }],
          tools: [],
          principal: principal(),
          audit: () => {},
        }),
      ).rejects.toThrow('boom');
    });

    it('treats a quiet stream end twice as a timeout only for an SDK that reports finish reasons', async () => {
      const quiet = (): AIResponse => ({ content: '' });
      // A tool round (finishReason: tool_calls) shows this boundary populates
      // finish reasons; its quiet blank ends are then a suspected timeout.
      const reporting = (after: () => AIResponse) =>
        makeAI((_m, options, call) =>
          call === 0 && toolsOffered(options)
            ? toolCall('tool_loop_notes.read', {})
            : after(),
        );
      const run = (ai: AIInterface) =>
        runToolLoop({
          ai,
          db,
          messages: [{ role: 'user', content: 'q' }],
          tools: tools(['tool_loop_notes.read']),
          principal: principal(),
          executeTool: async () => ({ count: 1 }),
          onToken: () => {},
          audit: () => {},
        });
      expect(await run(reporting(quiet))).toMatchObject({
        stoppedReason: 'timeout',
        content: '',
        emptyRetried: true,
      });

      // Quiet once, then a finished blank reply (finishReason present): empty.
      let n = 0;
      expect(
        (await run(reporting(() => (n++ === 0 ? quiet() : textResponse('')))))
          .stoppedReason,
      ).toBe('empty');

      // Quiet once, then an answer: recovered.
      let m = 0;
      expect(
        await run(
          reporting(() => (m++ === 0 ? quiet() : textResponse('Here it is.'))),
        ),
      ).toMatchObject({ stoppedReason: 'stop', content: 'Here it is.' });
    });

    it('treats a blank reply with no finish reason as blank when the SDK never reports one', async () => {
      const result = await runToolLoop({
        ai: makeAI(() => ({ content: '' })),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        onToken: () => {},
        audit: () => {},
      });
      expect(result).toMatchObject({
        stoppedReason: 'empty',
        emptyRetried: true,
      });
    });

    it('a blank reply with finishReason present is empty, never timeout', async () => {
      const result = await runToolLoop({
        ai: makeAI(() => textResponse('')),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        onToken: () => {},
        audit: () => {},
      });
      expect(result.stoppedReason).toBe('empty');
    });

    it('skips the retry when the token budget is already spent, keeping capReason', async () => {
      const chat = vi.fn(
        async (_m: AIMessage[], options?: ChatOptions): Promise<AIResponse> =>
          toolsOffered(options)
            ? {
                ...toolCall('tool_loop_notes.read', {}),
                usage: {
                  promptTokens: 90,
                  completionTokens: 20,
                  totalTokens: 110,
                },
              }
            : textResponse(''),
      );
      const result = await runToolLoop({
        ai: { chat } as unknown as AIInterface,
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        maxTotalTokens: 100,
        executeTool: async () => ({ count: 1 }),
        audit: () => {},
      });
      // Tool round + the forced final call; no retry past the budget.
      expect(chat).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        stoppedReason: 'empty',
        capReason: 'budget',
      });
      expect(result).not.toHaveProperty('emptyRetried');
    });

    it('skips the retry when the deadline has passed', async () => {
      let clock = 1_000;
      const chat = vi.fn(async (): Promise<AIResponse> => {
        clock += 500;
        return textResponse('');
      });
      const result = await runToolLoop({
        ai: { chat } as unknown as AIInterface,
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        deadline: 1_200,
        now: () => clock,
        audit: () => {},
      });
      expect(chat).toHaveBeenCalledTimes(1);
      expect(result.stoppedReason).toBe('empty');
    });

    it('keeps capReason max_steps when the cap turn ends empty after its retry', async () => {
      const result = await runToolLoop({
        ai: makeAI((_m, options) =>
          toolsOffered(options)
            ? toolCall('tool_loop_notes.read', {})
            : textResponse(''),
        ),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        maxSteps: 1,
        executeTool: async () => ({ count: 1 }),
        audit: () => {},
      });
      expect(result).toMatchObject({
        stoppedReason: 'empty',
        capReason: 'max_steps',
        emptyRetried: true,
      });
    });

    it('classifies an AbortError as a timeout when the caller signal is not aborted', async () => {
      const controller = new AbortController();
      const result = await runToolLoop({
        ai: makeAI(() => {
          throw Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
          });
        }),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        principal: principal(),
        signal: controller.signal,
        audit: () => {},
      });
      expect(controller.signal.aborted).toBe(false);
      expect(result.stoppedReason).toBe('timeout');
    });

    it('ignores an onReasoning callback that throws', async () => {
      const result = await runToolLoop({
        ai: makeAI(
          () =>
            ({
              content: 'answer',
              finishReason: 'stop',
              reasoning: 'thinking',
            }) as AIResponse,
        ),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        principal: principal(),
        onReasoning: () => {
          throw new Error('logger down');
        },
        audit: () => {},
      });
      expect(result).toMatchObject({
        content: 'answer',
        reasoning: 'thinking',
      });
    });

    it('answers from the first round reasoning when the retry has none (opt-in), cut on code points', async () => {
      let n = 0;
      const emoji = '\u{1F600}';
      const result = await runToolLoop({
        ai: makeAI(() =>
          n++ === 0
            ? ({
                content: '',
                finishReason: 'stop',
                reasoning: emoji.repeat(MAX_TOOL_LOOP_REASONING_CHARS + 5),
              } as AIResponse)
            : textResponse(''),
        ),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        principal: principal(),
        answerFromReasoning: true,
        audit: () => {},
      });
      expect(result.contentFromReasoning).toBe(true);
      expect(Array.from(result.content)).toHaveLength(
        MAX_TOOL_LOOP_REASONING_CHARS,
      );
      expect(result.content).toBe(emoji.repeat(MAX_TOOL_LOOP_REASONING_CHARS));
    });

    it('keeps capReason when the forced final call times out', async () => {
      const result = await runToolLoop({
        ai: makeAI((_m, options) => {
          if (toolsOffered(options))
            return toolCall('tool_loop_notes.read', {});
          throw Object.assign(new Error('late'), { code: 'AI_TIMEOUT' });
        }),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        maxSteps: 1,
        executeTool: async () => ({ count: 1 }),
        audit: () => {},
      });
      expect(result).toMatchObject({
        stoppedReason: 'timeout',
        capReason: 'max_steps',
      });
    });

    it('checks for an abort before the retry and never retries a cancelled turn', async () => {
      const controller = new AbortController();
      const chat = vi.fn(async (): Promise<AIResponse> => {
        // The first call returns blank, and the user stops meanwhile.
        controller.abort();
        return textResponse('');
      });
      const result = await runToolLoop({
        ai: { chat } as unknown as AIInterface,
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        signal: controller.signal,
        audit: () => {},
      });
      expect(chat).toHaveBeenCalledTimes(1);
      expect(result.stoppedReason).toBe('cancelled');
    });

    it('sends the answer-now instruction once on a retried forced final call', async () => {
      const seen: AIMessage[][] = [];
      const ai = makeAI((messages, options) => {
        seen.push([...messages]);
        return toolsOffered(options)
          ? toolCall('tool_loop_notes.read', {})
          : textResponse('');
      });
      await runToolLoop({
        ai,
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        maxSteps: 1,
        executeTool: async () => ({ count: 1 }),
        audit: () => {},
      });
      // Tool round, forced final, retry: each no-tools call carries one.
      expect(seen).toHaveLength(3);
      for (const call of seen.slice(1)) {
        expect(
          call.filter((m) => m.content === TOOL_LOOP_ANSWER_NOW_INSTRUCTION),
        ).toHaveLength(1);
      }
    });

    it('reports a timeout on the retry call as timeout', async () => {
      let n = 0;
      const result = await runToolLoop({
        ai: makeAI(() => {
          if (n++ === 0) return textResponse('');
          throw Object.assign(new Error('late'), { code: 'AI_TIMEOUT' });
        }),
        db,
        messages: [{ role: 'user', content: 'q' }],
        tools: tools(['tool_loop_notes.read']),
        principal: principal(),
        audit: () => {},
      });
      expect(result).toMatchObject({
        stoppedReason: 'timeout',
        emptyRetried: true,
      });
    });
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
