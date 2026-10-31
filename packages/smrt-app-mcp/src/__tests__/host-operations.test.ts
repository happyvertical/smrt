import { describe, expect, it, vi } from 'vitest';
import { McpAccessError } from '../errors.js';
import {
  createSameOriginSessionCaller,
  defineHostOperationTool,
  executeHostOperation,
  HostOperationError,
  McpToolError,
  toMcpWorkflowTool,
  toWebMcpSpec,
} from '../host-operations.js';
import {
  createMcpAppServer,
  type McpAppPrincipal,
  type McpToolCallAuditEvent,
} from '../server.js';

const principal: McpAppPrincipal = {
  id: 'guardian-1',
  tenantId: 'tenant-a',
  scopes: ['ops.write'],
  identity: {
    issuer: 'https://issuer.example',
    subject: 'sub-1',
    clientId: 'client-9',
  },
};

function operation(
  handler: (...args: never[]) => unknown = () => ({ done: true }),
  extra: Record<string, unknown> = {},
) {
  return defineHostOperationTool({
    name: 'review_apply',
    description: 'Apply a review',
    effect: 'write',
    idempotent: false,
    openWorld: false,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    outputSchema: { type: 'object' },
    handler: handler as never,
    ...extra,
  });
}

function server(
  def: ReturnType<typeof operation>,
  options: Record<string, unknown> = {},
) {
  const events: McpToolCallAuditEvent[] = [];
  const app = createMcpAppServer({
    smrtOptions: () => ({}),
    serverInfo: { name: 'host-ops', version: '1' },
    allowedClassNames: [],
    workflowTools: [toMcpWorkflowTool(def)],
    onToolCall: (event) => {
      events.push(event);
    },
    ...options,
  });
  return { app, events };
}

describe('audit hook', () => {
  it('fires once for ok with principal and identity', async () => {
    const handler = vi.fn(() => ({ done: true }));
    const { app, events } = server(operation(handler));
    const result = await app.callTool({
      name: 'review_apply',
      arguments: {},
      principal,
    });
    expect(result.isError).toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tool: 'review_apply',
      outcome: 'ok',
      principal: { id: 'guardian-1', tenantId: 'tenant-a' },
      identity: {
        issuer: 'https://issuer.example',
        subject: 'sub-1',
        clientId: 'client-9',
      },
    });
    expect(events[0].error).toBeUndefined();
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it('fires once for a handler error with only safe info', async () => {
    const { app, events } = server(
      operation(() => {
        throw new Error('db password=hunter2 at /srv/app.ts');
      }),
    );
    const result = await app.callTool({ name: 'review_apply', principal });
    expect(result.isError).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('error');
    expect(events[0].error).toEqual({
      code: 'mcp_tool_execution_failed',
      message: 'Workflow execution failed.',
    });
    expect(JSON.stringify(events[0])).not.toMatch(/hunter2|app\.ts|stack/);
  });

  it('fires for a policy denial that never reaches the handler', async () => {
    const handler = vi.fn(() => ({}));
    const { app, events } = server(operation(handler), {
      toolPolicy: () => false,
    });
    await expect(
      app.callTool({ name: 'review_apply', principal }),
    ).rejects.toBeInstanceOf(McpAccessError);
    expect(handler).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'denied',
      identity: { subject: 'sub-1' },
      error: { code: 'mcp_tool_access_denied' },
    });
  });

  it('fires for an unknown tool and an unauthenticated call', async () => {
    const { app, events } = server(operation());
    await expect(
      app.callTool({ name: 'nope', principal }),
    ).rejects.toBeInstanceOf(McpAccessError);
    await expect(app.callTool({ name: 'review_apply' })).rejects.toBeInstanceOf(
      McpAccessError,
    );
    expect(events.map((e) => [e.tool, e.outcome, e.error?.code])).toEqual([
      ['nope', 'denied', 'mcp_tool_not_found'],
      ['review_apply', 'denied', 'mcp_authentication_required'],
    ]);
    expect(events[1].principal).toBeNull();
    expect(events[1].identity).toBeNull();
  });

  it('audits a task-creating call on a workflow tool as denied', async () => {
    const { app, events } = server(operation());
    await expect(
      app.callTask?.({ name: 'review_apply', principal }),
    ).rejects.toBeInstanceOf(McpAccessError);
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toBe('denied');
  });

  it('fires for a workflow assertion denial', async () => {
    const { app, events } = server(operation(), {
      workflowAssertions: {
        review_apply: () => {
          throw new McpAccessError(403, 'No.', { code: 'custom_denied' });
        },
      },
    });
    await expect(
      app.callTool({ name: 'review_apply', principal }),
    ).rejects.toBeInstanceOf(McpAccessError);
    expect(events[0]).toMatchObject({
      outcome: 'denied',
      error: { code: 'custom_denied' },
    });
  });

  it('never lets a throwing or rejecting hook change the result', async () => {
    const reported: unknown[] = [];
    for (const hook of [
      () => {
        throw new Error('sync boom');
      },
      async () => {
        throw new Error('async boom');
      },
    ]) {
      const { app } = server(operation(), {
        onToolCall: hook,
        onToolCallHookError: (e: unknown) => reported.push(e),
      });
      const result = await app.callTool({ name: 'review_apply', principal });
      expect(result.isError).toBeUndefined();
      expect(result.structuredContent).toEqual({ done: true });
    }
    expect(reported).toHaveLength(2);
    // A throwing reporter is swallowed too, and a denial still denies.
    const { app } = server(operation(), {
      toolPolicy: () => false,
      onToolCall: () => {
        throw new Error('x');
      },
      onToolCallHookError: () => {
        throw new Error('y');
      },
    });
    await expect(
      app.callTool({ name: 'review_apply', principal }),
    ).rejects.toBeInstanceOf(McpAccessError);
  });
});

describe('typed error mapping', () => {
  async function run(def: ReturnType<typeof operation>) {
    const { app, events } = server(def);
    return {
      result: await app.callTool({ name: 'review_apply', principal }),
      events,
    };
  }

  it('delivers a thrown McpToolError code and message to the agent', async () => {
    const { result, events } = await run(
      operation(() => {
        throw new McpToolError('review_not_current', 'The review changed.', {
          reason: 'stale',
        });
      }),
    );
    expect(result).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'The review changed.' }],
      structuredContent: {
        error: {
          code: 'review_not_current',
          message: 'The review changed.',
          details: { reason: 'stale' },
        },
      },
    });
    expect(events[0]).toMatchObject({
      outcome: 'error',
      error: { code: 'review_not_current' },
    });
  });

  it('uses mapError and never leaks the raw error', async () => {
    class Domain extends Error {
      reason = 'stale';
    }
    const { result } = await run(
      operation(
        () => {
          throw new Domain('secret internals /srv/x.ts');
        },
        {
          mapError: (e: unknown) =>
            e instanceof Domain
              ? { code: e.reason, message: 'Not current.' }
              : null,
        },
      ),
    );
    expect(result.structuredContent).toEqual({
      error: { code: 'stale', message: 'Not current.' },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|x\.ts|stack/);
  });

  it('keeps unmapped errors generic, and a throwing or malformed mapper too', async () => {
    const generic = {
      isError: true,
      content: [{ type: 'text', text: 'Workflow execution failed.' }],
      structuredContent: {
        error: {
          code: 'mcp_tool_execution_failed',
          message: 'Workflow execution failed.',
        },
      },
    };
    const boom = () => {
      throw new Error('leak me');
    };
    for (const extra of [
      {},
      { mapError: () => undefined },
      {
        mapError: () => {
          throw new Error('mapper leak');
        },
      },
      { mapError: () => ({ code: 'bad code!', message: 'x' }) },
    ]) {
      const { result } = await run(operation(boom, extra));
      expect(result).toEqual(generic);
    }
  });

  it('rejects an unsafe McpToolError code as generic', async () => {
    const { result } = await run(
      operation(() => {
        throw new McpToolError('has spaces', 'x');
      }),
    );
    expect(result.structuredContent).toMatchObject({
      error: { code: 'mcp_tool_execution_failed' },
    });
  });
});

describe('defineHostOperationTool projections', () => {
  it('derives the same schemas, names and hints for both surfaces', async () => {
    for (const [effect, idempotent, openWorld] of [
      ['read', true, false],
      ['write', false, true],
      ['destructive', false, false],
    ] as const) {
      const def = operation(() => ({}), { effect, idempotent, openWorld });
      const mcp = toMcpWorkflowTool(def);
      const web = toWebMcpSpec(def, async () => ({}));
      expect(web.name).toBe(mcp.name);
      expect(web.inputSchema).toBe(mcp.inputSchema);
      expect(web.annotations).toEqual({
        readOnlyHint: effect === 'read',
        destructiveHint: effect === 'destructive',
        idempotentHint: idempotent,
        openWorldHint: openWorld,
      });
      const { app } = server(def);
      const listed = (await app.listTools({ principal })).find(
        (t) => t.name === def.name,
      );
      expect(listed?.annotations).toEqual(web.annotations);
    }
  });

  it('runs the handler once through either projection', async () => {
    const handler = vi.fn(
      ({ arguments: a }: { arguments: { id: string } }) => ({ id: a.id }),
    );
    const def = operation(handler as never);
    const { app } = server(def);
    await app.callTool({
      name: 'review_apply',
      arguments: { id: 'a' },
      principal,
    });
    expect(handler).toHaveBeenCalledTimes(1);
    const web = toWebMcpSpec(def, async (name, args) => {
      const outcome = await executeHostOperation(def, {
        arguments: args,
        principal,
      });
      expect(name).toBe('review_apply');
      if (!outcome.ok)
        throw new HostOperationError(outcome.error.code, outcome.error.message);
      return outcome.output;
    });
    expect(await web.execute({ id: 'b' })).toBe('{"id":"b"}');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('executeHostOperation maps failures with the definition mapper', async () => {
    const def = operation(() => {
      throw new McpToolError('x_code', 'Safe.');
    });
    expect(
      await executeHostOperation(def, { arguments: {}, principal }),
    ).toEqual({
      ok: false,
      error: { code: 'x_code', message: 'Safe.' },
    });
  });

  it('validates the definition', () => {
    expect(() =>
      defineHostOperationTool({ ...operation(), name: 'Bad Name' }),
    ).toThrow(/name/);
    expect(() =>
      defineHostOperationTool({ ...operation(), handler: undefined as never }),
    ).toThrow(/handler/);
  });
});

describe('same-origin session caller', () => {
  function fakeFetch(response: Response) {
    return vi.fn(async (_url: string, _init: RequestInit) => response);
  }

  it('uses same-origin credentials, host headers and strips authority keys', async () => {
    const fetchMock = fakeFetch(Response.json({ ok: 1 }));
    const call = createSameOriginSessionCaller({
      url: '/api/ops',
      fetch: fetchMock as never,
      headers: () => ({ 'x-csrf': 'tok' }),
    });
    const out = await call('review_apply', {
      id: 'a',
      tenantId: 'evil',
      Roles: ['owner'],
      user_id: 'u',
      principal: { id: 'x' },
    });
    expect(out).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/ops/review_apply');
    expect(init.credentials).toBe('same-origin');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-csrf']).toBe('tok');
    expect(JSON.parse(init.body as string)).toEqual({ arguments: { id: 'a' } });
    expect(init.headers).not.toHaveProperty('authorization');
  });

  it('throws typed errors carrying the server code and message', async () => {
    const call = createSameOriginSessionCaller({
      url: '/api/ops',
      fetch: fakeFetch(
        Response.json(
          {
            error: {
              code: 'review_not_current',
              message: 'Stale.',
              details: { a: 1 },
            },
          },
          { status: 409 },
        ),
      ) as never,
    });
    const error = await call('review_apply', {}).catch((e) => e);
    expect(error).toBeInstanceOf(HostOperationError);
    expect(error).toMatchObject({
      code: 'review_not_current',
      message: 'Stale.',
      status: 409,
      details: { a: 1 },
    });
  });

  it('falls back to a generic code for non-typed failures and network errors', async () => {
    const html = createSameOriginSessionCaller({
      url: '/api/ops',
      fetch: fakeFetch(
        new Response('<html>stack trace</html>', { status: 500 }),
      ) as never,
    });
    const error = await html('x', {}).catch((e) => e);
    expect(error).toMatchObject({
      code: 'host_operation_http_500',
      message: 'The operation failed.',
    });
    const net = createSameOriginSessionCaller({
      url: '/api/ops',
      fetch: (async () => {
        throw new TypeError('secret url');
      }) as never,
    });
    expect(await net('x', {}).catch((e) => e)).toMatchObject({
      code: 'host_operation_network_error',
    });
  });

  it('refuses cross-origin and tokenised URLs', async () => {
    const fetchMock = fakeFetch(Response.json({}));
    for (const url of [
      'https://evil.example/ops',
      '//evil.example/ops',
      '/ops?token=abc',
      '/ops#frag',
    ]) {
      const call = createSameOriginSessionCaller({
        url,
        fetch: fetchMock as never,
        origin: 'https://app.example',
      });
      await expect(call('x', {})).rejects.toThrow(TypeError);
    }
    const ok = createSameOriginSessionCaller({
      url: (name) => `https://app.example/ops/${name}`,
      fetch: fetchMock as never,
      origin: 'https://app.example',
    });
    await ok('x', {});
    expect(fetchMock.mock.calls[0][0]).toBe('/ops/x');
  });
});
