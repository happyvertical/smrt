import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDevPlane,
  DEV_PLANE_TOOL_NAMES,
  LIVE_REGISTRY_PROVENANCE,
} from './dev-plane.js';
import { resetRuntimeBootForTests } from './tools/runtime/boot.js';

const TOKEN = 'plane-secret';
const BASE = 'http://127.0.0.1:5173/api/_dev';
let projectRoot: string;

function req(
  path: string,
  init: RequestInit & { host?: string; auth?: boolean } = {},
) {
  const headers = new Headers(init.headers);
  headers.set('host', init.host ?? '127.0.0.1:5173');
  if (init.auth !== false) headers.set('authorization', `Bearer ${TOKEN}`);
  return new Request(`${BASE}${path}`, { ...init, headers });
}

beforeEach(() => {
  ObjectRegistry.clear();
  resetRuntimeBootForTests();
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-dev-plane-'));
  mkdirSync(join(projectRoot, '.smrt'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: '@acme/app' }),
  );
  writeFileSync(
    join(projectRoot, '.smrt', 'manifest.json'),
    JSON.stringify({
      version: '1',
      timestamp: 0,
      moduleType: 'smrt',
      packageName: '@acme/app',
      objects: {},
    }),
  );
  // The app's own imports registered this class; no manifest boot involved.
  ObjectRegistry.registerFromManifest(
    'Article',
    {
      className: 'Article',
      name: 'article',
      collection: 'articles',
      filePath: join(projectRoot, 'src', 'Article.ts'),
      fields: {
        title: { type: 'text', required: true },
        apiKey: { type: 'text', description: 'secret' },
      },
      methods: {},
      decoratorConfig: {},
    } as never,
    '@acme/app',
  );
});

afterEach(() => {
  ObjectRegistry.clear();
  resetRuntimeBootForTests();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('in-app dev-plane (#2782)', () => {
  it('requires a token and refuses non-loopback hosts and bad tokens before any tool runs', async () => {
    expect(() => createDevPlane({ token: '' })).toThrow(/token/);
    const plane = createDevPlane({ token: TOKEN, projectRoot });
    expect(plane.tools).toEqual(DEV_PLANE_TOOL_NAMES);
    expect(
      (
        await plane.handleRequest(
          req('', { host: 'evil.example' }),
          '/api/_dev',
        )
      ).status,
    ).toBe(403);
    expect(
      (await plane.handleRequest(req('', { auth: false }), '/api/_dev')).status,
    ).toBe(401);
    const wrong = new Request(`${BASE}`, {
      headers: { host: '127.0.0.1', authorization: 'Bearer nope' },
    });
    expect((await plane.handleRequest(wrong, '/api/_dev')).status).toBe(401);
    const badOrigin = req('', { headers: { origin: 'https://evil.example' } });
    expect((await plane.handleRequest(badOrigin, '/api/_dev')).status).toBe(
      403,
    );
  });

  it('serves the positive catalog and the live registry snapshot over JSON', async () => {
    const plane = createDevPlane({ token: TOKEN, projectRoot });
    const catalog = await (
      await plane.handleRequest(req(''), '/api/_dev')
    ).json();
    expect(catalog.tools.map((t: { name: string }) => t.name)).toEqual([
      ...DEV_PLANE_TOOL_NAMES,
    ]);
    expect(catalog.mcp).toBe('/api/_dev/mcp');
    const live = await (
      await plane.handleRequest(
        req('/registry-live?objects=Article'),
        '/api/_dev',
      )
    ).json();
    expect(live.ok).toBe(true);
    expect(live.data.provenance).toBe(LIVE_REGISTRY_PROVENANCE);
    expect(live.data.snapshot.objects[0].name).toBe('Article');
    expect(live.data.snapshot.objects[0].sourceFile).toBe('src/Article.ts');
    const text = JSON.stringify(live);
    expect(text).not.toContain(projectRoot);
    expect(text).not.toContain('secret');
    expect(
      (await plane.handleRequest(req('/generate-smrt-class'), '/api/_dev'))
        .status,
    ).toBe(404);
    expect(
      (
        await plane.handleRequest(
          req('/registry-live', { method: 'DELETE' }),
          '/api/_dev',
        )
      ).status,
    ).toBe(404);
  });

  it('pins every runtime call to the app root and database, ignoring caller overrides', async () => {
    const plane = createDevPlane({
      token: TOKEN,
      projectRoot,
      db: { url: ':memory:' },
    });
    const diff = await (
      await plane.handleRequest(
        req('/runtime-schema-diff', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectPath: '/',
            dbUrl: 'file:///tmp/other.db',
          }),
        }),
        '/api/_dev',
      )
    ).json();
    expect(diff.ok).toBe(true);
    // :memory: means not configured → static-only, and the override was dropped.
    expect(diff.data.connected).toBe(false);
    expect(diff.data.provenance).toBe('static');
    expect(JSON.stringify(diff)).not.toContain('other.db');
  });

  it('redacts unexpected tool errors before they reach the client', async () => {
    const plane = createDevPlane({ token: TOKEN, projectRoot });
    // runtime-object with a non-string name makes the tool throw internally
    // only in exotic cases; force the catch-all path via a bad body instead.
    const response = await plane.handleRequest(
      req('/runtime-object', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: { toString: null } }),
      }),
      '/api/_dev',
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(projectRoot);
  });

  it('answers MCP tools/list and tools/call on the mcp sub-path', async () => {
    const plane = createDevPlane({ token: TOKEN, projectRoot });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${BASE}/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${TOKEN}`, host: '127.0.0.1:5173' },
        },
        fetch: async (input, init) => {
          const request =
            input instanceof Request ? input : new Request(input, init);
          const headers = new Headers(request.headers);
          headers.set('host', '127.0.0.1:5173');
          return plane.handleRequest(
            new Request(request, { headers }),
            '/api/_dev',
          );
        },
      },
    );
    const client = new Client(
      { name: 'test', version: '0.0.0' },
      { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...DEV_PLANE_TOOL_NAMES].sort());
      const result = await client.callTool({
        name: 'registry-live',
        arguments: { objects: ['Article'] },
      });
      const parsed = JSON.parse(
        (result.content as Array<{ text: string }>)[0].text,
      );
      expect(parsed.data.snapshot.objects[0].name).toBe('Article');
      expect(
        (result.structuredContent as { data: { provenance: string } }).data
          .provenance,
      ).toBe(LIVE_REGISTRY_PROVENANCE);
    } finally {
      await client.close();
    }
  });
});
