/**
 * A token may carry fewer scopes than the resource advertises (#5110): consent
 * narrows to what the user holds. The resource then needs at least one of its
 * scopes, and each tool needs only its own (`toolScopes`). Real resource auth
 * and route; only token verification is stubbed.
 */
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createInMemoryMcpAuditSink } from '../audit.js';
import { createMcpResourceAuth } from '../auth.js';
import { MCP_TOOL_ACCESS_DENIED_CODE } from '../errors.js';
import { mountMcpAppRoute } from '../sveltekit.js';

const RESOURCE = 'https://app.example/api/mcp';
const ISSUER = 'https://app.example/oauth';
const ALL = ['notes.read', 'notes.write', 'notes.delete'];

function setup(revoked = new Set<string>()) {
  // 'x.<base64url scopes>.y' tokens: the stub "verifies" them into a payload.
  const payloadOf = (token: string) => ({
    sub: 'user-1',
    scope: Buffer.from(token.split('.')[1], 'base64url').toString(),
  });
  const auth = createMcpResourceAuth({
    profile: 'self-hosted',
    resource: RESOURCE,
    issuer: ISSUER,
    scopes: ALL,
    algorithms: ['ES256'],
    selfIssuer: {
      issuer: ISSUER,
      verifyAccessToken: async (token) => payloadOf(token),
      validateGrant: async () => !revoked.has('grant'),
    },
    resolvePrincipal: async () => ({
      id: 'user-1',
      tenantId: 'tenant-a',
      kind: 'agent',
    }),
  });
  const sink = createInMemoryMcpAuditSink();
  const route = mountMcpAppRoute({
    models: [],
    requiredScopes: [],
    principalKinds: ['agent'],
    toolScopes: {
      note_list: ['notes.read'],
      note_create: ['notes.write'],
      note_delete: ['notes.delete'],
    },
    workflowTools: ['note_list', 'note_create', 'note_delete'].map((name) => ({
      name,
      description: name,
      inputSchema: { type: 'object' as const, properties: {} },
      outputSchema: { type: 'object' as const, properties: {} },
      effect: name === 'note_list' ? ('read' as const) : ('write' as const),
      idempotent: name === 'note_list',
      openWorld: false,
      execute: () => ({ content: [{ type: 'text' as const, text: name }] }),
    })),
    auditSink: sink,
    smrtOptions: () => ({}),
    auth,
    checkOrigin: false,
  });
  return { auth, route, sink };
}

const tokenFor = (scopes: string[]) =>
  `x.${Buffer.from(scopes.join(' ')).toString('base64url') || 'e'}.y`;
function rpc(token: string, method: string, params: Record<string, unknown>) {
  const url = new URL(RESOURCE);
  return {
    locals: {},
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        authorization: `Bearer ${token}`,
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: { name: 'narrowed', version: '0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  };
}
async function list(app: ReturnType<typeof setup>, token: string) {
  const body = await (await app.route(rpc(token, 'tools/list', {}))).json();
  return (body.result.tools as Array<{ name: string }>)
    .map((tool) => tool.name)
    .sort();
}
async function call(
  app: ReturnType<typeof setup>,
  token: string,
  name: string,
) {
  const response = await app.route(
    rpc(token, 'tools/call', { name, arguments: {} }),
  );
  return { status: response.status, body: await response.json() };
}

describe('tokens narrower than the advertised scopes (#5110)', () => {
  it('authenticates a token with a subset and passes only that subset on', async () => {
    const { auth } = setup();
    const result = await auth.authenticate(
      new Request(RESOURCE, {
        headers: { authorization: `Bearer ${tokenFor(['notes.read'])}` },
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      principal: { id: 'user-1', scopes: ['notes.read'] },
    });
  });

  it('lists and runs only the tools the token scopes cover', async () => {
    const app = setup();
    const read = tokenFor(['notes.read']);
    expect(await list(app, read)).toEqual(['note_list']);
    expect((await call(app, read, 'note_list')).status).toBe(200);
    expect(await list(app, tokenFor(ALL))).toEqual([
      'note_create',
      'note_delete',
      'note_list',
    ]);
    expect(await list(app, tokenFor(['notes.read', 'notes.write']))).toEqual([
      'note_create',
      'note_list',
    ]);
  });

  it('refuses a tool outside the token scopes exactly like an unknown tool', async () => {
    const app = setup();
    const read = tokenFor(['notes.read']);
    const forbidden = await call(app, read, 'note_delete');
    const unknown = await call(app, read, 'no_such_tool');
    expect(forbidden).toEqual(unknown);
    expect(forbidden.body.error).toMatchObject({
      message: 'Unknown MCP tool.',
    });
    expect(
      app.sink.records.map((record) => [record.tool, record.errorCode]),
    ).toContainEqual(['note_delete', MCP_TOOL_ACCESS_DENIED_CODE]);
  });

  it('answers 403 insufficient_scope with the resource scopes when none apply', async () => {
    const app = setup();
    for (const scopes of [[], ['unrelated.scope']]) {
      const result = await app.auth.authenticate(
        new Request(RESOURCE, {
          headers: { authorization: `Bearer ${tokenFor(scopes)}` },
        }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.response.status).toBe(403);
      const challenge = result.response.headers.get('www-authenticate') ?? '';
      expect(challenge).toContain('error="insufficient_scope"');
      expect(challenge).toContain(`scope="${ALL.join(' ')}"`);
      expect(challenge).toContain('resource_metadata=');
    }
    const routed = await app.route(rpc(tokenFor([]), 'tools/list', {}));
    expect(routed.status).toBe(403);
  });

  it('still refuses a revoked grant and keeps the advertised scopes unchanged', async () => {
    const revoked = new Set(['grant']);
    const app = setup(revoked);
    const result = await app.auth.authenticate(
      new Request(RESOURCE, {
        headers: { authorization: `Bearer ${tokenFor(['notes.read'])}` },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    const metadata = await app.auth.metadataResponse().json();
    expect(metadata.scopes_supported).toEqual(ALL);
  });
});
