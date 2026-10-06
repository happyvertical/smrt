/**
 * #3490: an unrelated registry collision cannot take a mounted app route down.
 *
 * An app consuming smrt-chat ended up with smrt-agents' `AgentConfig`
 * registered twice (the real class under the app's package, a manifest stub
 * under smrt-agents). Core generated tools for every registered class before
 * this package applied its allow-list, so the duplicate `agentconfig_list`
 * failed every `tools/list` and `tools/call` on `/mcp` for every principal,
 * although the route publishes only `Note`. The catalog is now built from the
 * allow-listed models alone; a collision inside the allow-list still fails
 * closed.
 */

import {
  getTestDatabase,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpAppServer } from '../server.js';
import { mountMcpAppRoute } from '../sveltekit.js';

@smrt({ mcp: { include: ['list', 'get'] } })
class CollisionRouteNote extends SmrtObject {
  title: string = '';
}
class CollisionRouteNoteCollection extends SmrtCollection<CollisionRouteNote> {
  static readonly _itemClass = CollisionRouteNote;
}

/** The observed shape: one class, a real entry and a stub under two packages. */
@smrt({ tableName: 'collision_agent_configs', mcp: { include: ['list'] } })
class CollisionAgentConfig extends SmrtObject {
  agentId: string = '';
}

/**
 * Another package's class with the app model's simple name, on its own
 * table: the route holds the app's constructor, so it serves the app's class.
 */
const OtherRouteNote = class extends SmrtObject {};
Object.defineProperty(OtherRouteNote, 'name', { value: 'CollisionRouteNote' });
class OtherRouteNoteCollection extends SmrtCollection<SmrtObject> {
  static readonly _itemClass = OtherRouteNote;
}
const OTHER_NOTE = '@fixture/other3490:CollisionRouteNote';

let db: Awaited<ReturnType<typeof getTestDatabase>>;
beforeAll(async () => {
  ObjectRegistry.registerCollection(
    'CollisionRouteNote',
    CollisionRouteNoteCollection,
  );
  db = await getTestDatabase({ classes: ['CollisionRouteNote'] });
  await db.insert('collision_route_notes', {
    id: '00000000-0000-4000-8000-000000003490',
    slug: 'first',
    context: '',
    title: 'first note',
  });
  ObjectRegistry.register(OtherRouteNote, {
    packageName: '@fixture/other3490',
    tableName: 'other_route_notes',
    mcp: { include: ['list', 'get'] },
  });
  ObjectRegistry.registerCollection(OTHER_NOTE, OtherRouteNoteCollection);
  await getTestDatabase({ db, classes: [OTHER_NOTE] });
  await db.insert('other_route_notes', {
    id: '00000000-0000-4000-8000-0000000034ff',
    slug: 'other-package-note',
    context: '',
  });
  ObjectRegistry.registerPackageManifest({
    version: '1',
    timestamp: 0,
    packageName: '@fixture/agents3490',
    objects: {
      '@fixture/agents3490:CollisionAgentConfig': {
        name: 'collisionagentconfig',
        className: 'CollisionAgentConfig',
        qualifiedName: '@fixture/agents3490:CollisionAgentConfig',
        packageName: '@fixture/agents3490',
        filePath: '/home/runner/work/smrt/packages/agents/src/config.ts',
        collection: 'collision_agent_configs',
        extends: 'SmrtObject',
        fields: { agentId: { type: 'text' } },
        methods: {},
        decoratorConfig: {
          tableName: 'other_agent_configs',
          mcp: { include: ['list'] },
        },
      },
    },
  } as unknown as Parameters<typeof ObjectRegistry.registerPackageManifest>[0]);
  const collisions = [...ObjectRegistry.getAllClasses().values()].filter(
    (info) => info.name === 'CollisionAgentConfig',
  );
  // Precondition: the registry really holds the colliding pair.
  expect(collisions).toHaveLength(2);
  void CollisionAgentConfig;
});
afterAll(async () => {
  await db?.close?.();
});

const ownerLocals = {
  user: { id: 'owner-1' },
  tenantId: 'tenant-a',
  permissions: ['notes.read'],
  sessionId: 'sid-1',
};

function rpc(
  method: string,
  params: Record<string, unknown>,
  locals: Record<string, unknown>,
) {
  const url = new URL('https://app.example/mcp');
  return {
    locals,
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
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
            [CLIENT_INFO_META_KEY]: { name: 'lane-3490', version: '0.0.0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  };
}

function route(models: Parameters<typeof mountMcpAppRoute>[0]['models']) {
  return mountMcpAppRoute({
    models,
    requiredScopes: ['notes.read'],
    effects: ['read'],
    smrtOptions: () => ({ db }),
  });
}

async function send(
  handler: ReturnType<typeof route>,
  method: string,
  params: Record<string, unknown>,
  locals: Record<string, unknown>,
) {
  const response = await handler(rpc(method, params, locals));
  expect(response.status).toBe(200);
  return response.json();
}

describe('mountMcpAppRoute with an unrelated registry collision (#3490)', () => {
  it('lists exactly the allow-listed model for an owner and for anonymous', async () => {
    const handler = route([CollisionRouteNote]);
    const owner = await send(handler, 'tools/list', {}, ownerLocals);
    expect(owner.error).toBeUndefined();
    expect(
      (owner.result.tools as Array<{ name: string }>).map(({ name }) => name),
    ).toEqual(['collisionroutenote_get', 'collisionroutenote_list']);

    const anonymous = await send(handler, 'tools/list', {}, {});
    expect(anonymous.error).toBeUndefined();
    expect(anonymous.result.tools).toEqual([]);
  });

  it('serves an allow-listed tool call', async () => {
    const body = await send(
      route([CollisionRouteNote]),
      'tools/call',
      { name: 'collisionroutenote_list', arguments: {} },
      ownerLocals,
    );
    expect(body.error).toBeUndefined();
    expect(body.result.isError).not.toBe(true);
    expect(JSON.stringify(body.result.structuredContent)).toContain(
      'first note',
    );
  });

  it('keeps a non-allow-listed colliding tool unknown', async () => {
    const body = await send(
      route([CollisionRouteNote]),
      'tools/call',
      { name: 'collisionagentconfig_list', arguments: {} },
      ownerLocals,
    );
    expect(body.error).toMatchObject({
      code: -32602,
      message: 'Unknown MCP tool.',
    });
  });

  it('serves the mounted constructor when its simple name is shared', async () => {
    for (const [model, slug, absent] of [
      [CollisionRouteNote, 'first', 'other-package-note'],
      [OtherRouteNote, 'other-package-note', 'first'],
    ] as const) {
      const handler = route([model as never]);
      const list = await send(handler, 'tools/list', {}, ownerLocals);
      expect(list.error).toBeUndefined();
      expect(
        (list.result.tools as Array<{ name: string }>).map(({ name }) => name),
      ).toEqual(['collisionroutenote_get', 'collisionroutenote_list']);
      const call = await send(
        handler,
        'tools/call',
        { name: 'collisionroutenote_list', arguments: {} },
        ownerLocals,
      );
      expect(call.error).toBeUndefined();
      const rows = JSON.stringify(call.result.structuredContent);
      expect(rows).toContain(slug);
      expect(rows).not.toContain(absent);
    }
  });

  it("publishes the mounted class, not another package's same-named stub", async () => {
    const body = await send(
      route([CollisionRouteNote, CollisionAgentConfig]),
      'tools/list',
      {},
      ownerLocals,
    );
    expect(body.error).toBeUndefined();
    expect(
      (body.result.tools as Array<{ name: string }>).map(({ name }) => name),
    ).toEqual([
      'collisionagentconfig_list',
      'collisionroutenote_get',
      'collisionroutenote_list',
    ]);
  });

  it('fails closed on a raw simple-name allow-list two classes share', async () => {
    const server = createMcpAppServer({
      serverInfo: { name: 'lane-3490', version: '0.0.0' },
      allowedClassNames: ['CollisionAgentConfig'],
      smrtOptions: () => ({ db }),
    });
    await expect(
      server.listTools({ principal: { id: 'owner-1', tenantId: 'tenant-a' } }),
    ).rejects.toThrow("MCP class scope 'collisionagentconfig' is ambiguous");
  });
});
