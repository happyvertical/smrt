/**
 * `legacy: 'stateless'` (#5109): an explicit mount-time opt-in that lets
 * 2025-era JSON-RPC clients (an `initialize` handshake, or a request naming no
 * protocol version, as Paperclip sends) reach the SAME gates modern requests
 * do. Default `'reject'` keeps the modern-only `-32022` answer.
 *
 * Both mounts run with a self-issuer bearer adapter (per-call grant liveness),
 * a binder that caps token scopes at the live role permissions, `toolScopes`,
 * and an approvals gate.
 */

import { describe, expect, it, vi } from 'vitest';
import type { McpApprovalGate } from '../approval-gate.js';
import { createHostedMcpResourceAuth } from '../auth.js';
import { createDefaultMcpAppServer } from '../defaults.js';
import type { McpAppPrincipal } from '../server.js';
import {
  type McpBoundPrincipal,
  type McpSvelteKitHandler,
  mountMcpAppRoute,
  mountMcpRoute,
} from '../sveltekit.js';

const URL_ = 'https://app.example/api/mcp';
const READER = 'reader.token.aaaaaaaaaaaaaaaa';
const WRITER = 'writer.token.aaaaaaaaaaaaaaaa';
const READ = 'notes.read';
const WRITE = 'notes.write';

function tool(name: string, effect: 'read' | 'write', calls: string[]) {
  return {
    name,
    description: name,
    effect,
    idempotent: effect === 'read',
    openWorld: false,
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object' },
    async execute(context: { principal?: McpAppPrincipal | null }) {
      calls.push(`${name}:${context.principal?.id}`);
      const result = { ok: name };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  };
}

function fixture() {
  const calls: string[] = [];
  const state = {
    live: new Set([READER, WRITER]),
    // Live role permissions per subject: the binder caps token scopes by it.
    role: { reader: [READ], writer: [READ, WRITE] } as Record<string, string[]>,
    bound: [] as string[],
  };
  const tokens: Record<string, { sub: string; scope: string }> = {
    [READER]: { sub: 'reader', scope: `${READ} ${WRITE}` },
    [WRITER]: { sub: 'writer', scope: `${READ} ${WRITE}` },
  };
  const runtime = {
    mcpSelfIssuer: {
      issuer: 'https://app.example/oauth',
      resource: URL_,
      scopes: [READ],
      verifyAccessToken: async (token: string) => {
        const claims = tokens[token];
        if (!claims) throw new Error('bad token');
        return { ...claims, tenant_id: 't1' };
      },
      validateGrant: vi.fn(async (claims: { sub?: string }) =>
        [...state.live].some((token) => tokens[token]?.sub === claims.sub),
      ),
    },
    resolveMcpPrincipal: async (identity: { subject: string }) => ({
      id: identity.subject,
      tenantId: 't1',
      kind: 'human',
      tenantBinding: 'direct' as const,
    }),
  };
  const auth = createHostedMcpResourceAuth({ profile: 'cloud', runtime });
  const bindPrincipal = async <T>(
    principal: McpAppPrincipal & { id: string },
    run: (bound?: McpBoundPrincipal) => Promise<T>,
  ): Promise<T> => {
    state.bound.push(principal.id);
    const live = state.role[principal.id] ?? [];
    return run(
      Object.freeze({
        ...principal,
        scopes: Object.freeze(
          (principal.scopes ?? []).filter((scope) => live.includes(scope)),
        ),
      }),
    );
  };
  const approvals: McpApprovalGate = {
    check: async () => ({ state: 'pending', created: true, approvalId: 'a1' }),
  };
  const serverOptions = {
    models: [],
    requiredScopes: [READ],
    smrtOptions: () => ({}),
    workflowTools: [
      tool('note_list', 'read', calls),
      tool('note_create', 'write', calls),
      tool('note_wipe', 'write', calls),
    ],
    toolScopes: { note_create: [WRITE], note_wipe: [WRITE] },
    confirmTools: ['note_wipe'],
    approvals,
  };
  const shared = { auth, bindPrincipal, checkOrigin: false };
  const mount = (
    kind: 'app' | 'route',
    legacy?: 'reject' | 'stateless',
  ): McpSvelteKitHandler =>
    kind === 'app'
      ? mountMcpAppRoute({ ...serverOptions, ...shared, legacy } as never)
      : mountMcpRoute(createDefaultMcpAppServer(serverOptions as never), {
          ...shared,
          legacy,
        });
  return { calls, state, mount };
}

type Era = 'legacy' | 'modern';
function request(
  era: Era,
  method: string,
  params: Record<string, unknown>,
  token?: string,
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  let body: Record<string, unknown> = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  };
  if (era === 'modern') {
    headers['mcp-protocol-version'] = '2026-07-28';
    headers['mcp-method'] = method;
    if (typeof params.name === 'string') headers['mcp-name'] = params.name;
    body = {
      ...body,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 't', version: '0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    };
  }
  const url = new URL(URL_);
  return {
    locals: {},
    url,
    request: new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  } as never;
}

async function send(
  handler: McpSvelteKitHandler,
  era: Era,
  method: string,
  params: Record<string, unknown> = {},
  token?: string,
) {
  const response = await handler(request(era, method, params, token));
  const text = await response.text();
  // Stateless serving may answer as an SSE frame; take the JSON-RPC payload.
  const data = text.startsWith('event:')
    ? (text.split('\n').find((line) => line.startsWith('data:')) ?? 'data:')
        .slice(5)
        .trim()
    : text;
  return {
    status: response.status,
    headers: response.headers,
    json: data ? (JSON.parse(data) as Record<string, any>) : null,
  };
}

const INIT = {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'paperclip', version: '1' },
};
const names = (r: { json: Record<string, any> | null }) =>
  ((r.json?.result.tools ?? []) as Array<{ name: string }>)
    .map((t) => t.name)
    .sort();

describe.each([
  'app',
  'route',
] as const)('legacy protocol via %s mount', (kind) => {
  describe("opt-in legacy: 'stateless'", () => {
    it('serves the 2025 handshake and an unversioned tools/list', async () => {
      const { mount } = fixture();
      const handler = mount(kind, 'stateless');
      const init = await send(handler, 'legacy', 'initialize', INIT, WRITER);
      expect(init.status).toBe(200);
      expect(init.json?.result.protocolVersion).toBeTruthy();
      expect(init.headers.get('mcp-session-id')).toBeNull();
      const list = await send(handler, 'legacy', 'tools/list', {}, WRITER);
      expect(names(list)).toEqual(['note_create', 'note_list', 'note_wipe']);
    });

    it('lists only what the live role permits and runs permitted calls', async () => {
      const { mount, calls, state } = fixture();
      const handler = mount(kind, 'stateless');
      // The reader's token carries notes.write but the live role does not.
      const list = await send(handler, 'legacy', 'tools/list', {}, READER);
      expect(names(list)).toEqual(['note_list']);
      const ok = await send(
        handler,
        'legacy',
        'tools/call',
        { name: 'note_list', arguments: {} },
        READER,
      );
      expect(ok.json?.result.structuredContent).toEqual({ ok: 'note_list' });
      expect(calls).toEqual(['note_list:reader']);
      expect(state.bound).toContain('reader');
    });

    it('answers a forbidden tool exactly as an unknown one', async () => {
      const { mount, calls } = fixture();
      const handler = mount(kind, 'stateless');
      const call = (name: string) =>
        send(handler, 'legacy', 'tools/call', { name, arguments: {} }, READER);
      const forbidden = await call('note_create');
      const unknown = await call('note_nothing');
      expect(forbidden.status).toBe(unknown.status);
      expect(forbidden.json?.error.code).toBe(unknown.json?.error.code);
      expect(forbidden.json?.error.message.replace('note_create', 'X')).toEqual(
        unknown.json?.error.message.replace('note_nothing', 'X'),
      );
      expect(forbidden.json?.error.data).toEqual(unknown.json?.error.data);
      expect(calls).toEqual([]);
    });

    it('challenges an unauthenticated legacy request with 401', async () => {
      const { mount, calls } = fixture();
      const handler = mount(kind, 'stateless');
      for (const [method, params] of [
        ['initialize', INIT],
        ['tools/list', {}],
        ['tools/call', { name: 'note_list', arguments: {} }],
      ] as const) {
        const res = await send(handler, 'legacy', method, params);
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toMatch(/^Bearer/);
      }
      const bad = await send(handler, 'legacy', 'tools/list', {}, 'nope');
      expect(bad.status).toBe(401);
      expect(calls).toEqual([]);
    });

    it('fails the next legacy call once the grant is revoked', async () => {
      const { mount, state, calls } = fixture();
      const handler = mount(kind, 'stateless');
      const call = () =>
        send(
          handler,
          'legacy',
          'tools/call',
          { name: 'note_list', arguments: {} },
          WRITER,
        );
      expect((await call()).status).toBe(200);
      state.live.delete(WRITER);
      const revoked = await call();
      expect(revoked.status).toBe(401);
      expect(calls).toEqual(['note_list:writer']);
    });

    it('holds a gated legacy call as approval_pending', async () => {
      const { mount, calls } = fixture();
      const handler = mount(kind, 'stateless');
      const res = await send(
        handler,
        'legacy',
        'tools/call',
        { name: 'note_wipe', arguments: { confirm: true } },
        WRITER,
      );
      expect(res.json?.result.isError).toBe(true);
      expect(res.json?.result.structuredContent.error.code).toBe(
        'approval_pending',
      );
      expect(calls).toEqual([]);
    });

    it('still serves modern requests identically', async () => {
      const { mount } = fixture();
      const withOptIn = mount(kind, 'stateless');
      const withoutOptIn = mount(kind);
      const a = await send(withOptIn, 'modern', 'tools/list', {}, READER);
      const b = await send(withoutOptIn, 'modern', 'tools/list', {}, READER);
      expect(a.status).toBe(200);
      expect(names(a)).toEqual(['note_list']);
      expect({ status: a.status, json: a.json }).toEqual({
        status: b.status,
        json: b.json,
      });
    });

    it('rejects an unknown posture at mount time', () => {
      const { mount } = fixture();
      expect(() => mount(kind, 'sessions' as never)).toThrow(TypeError);
    });
  });

  describe.each([
    undefined,
    'reject',
  ] as const)('default (legacy: %s)', (legacy) => {
    it('answers legacy requests -32022 as before and never dispatches', async () => {
      const { mount, calls } = fixture();
      const handler = mount(kind, legacy);
      const list = await send(handler, 'legacy', 'tools/list', {}, WRITER);
      expect(list.status).toBe(400);
      expect(list.json?.error.code).toBe(-32022);
      expect(list.json?.error.message).toBe(
        'Unsupported protocol version: the request did not name a protocol version',
      );
      expect(list.json?.error.data.supported).toEqual(['2026-07-28']);
      const init = await send(handler, 'legacy', 'initialize', INIT, WRITER);
      expect(init.status).toBe(400);
      expect(init.json?.error.code).toBe(-32022);
      const call = await send(
        handler,
        'legacy',
        'tools/call',
        { name: 'note_list', arguments: {} },
        WRITER,
      );
      expect(call.json?.error.code).toBe(-32022);
      expect(calls).toEqual([]);
    });
  });
});
