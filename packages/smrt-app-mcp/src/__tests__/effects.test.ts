/**
 * Effect-restricted catalogs (#3373 combined review C1). A principal whose
 * complete scope set is `['items.read']` must not discover or invoke the
 * create/update/delete tools of a published model when the route is limited
 * to read-only effects; such tools are indistinguishable from unknown ones.
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
import { createDefaultMcpAppServer } from '../defaults.js';
import { createMcpAppServer } from '../server.js';
import { mountMcpAppRoute } from '../sveltekit.js';
import { mcpToolEffect } from '../tools.js';

@smrt({ mcp: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class LaneEffectItem extends SmrtObject {
  title: string = '';
}
class LaneEffectItemCollection extends SmrtCollection<LaneEffectItem> {
  static readonly _itemClass = LaneEffectItem;
}

let db: Awaited<ReturnType<typeof getTestDatabase>>;
let seededId = '';
beforeAll(async () => {
  ObjectRegistry.registerCollection('LaneEffectItem', LaneEffectItemCollection);
  db = await getTestDatabase({ classes: ['LaneEffectItem'] });
  const items = await LaneEffectItemCollection.create({ db });
  const seeded = await items.create({ title: 'Seeded' });
  await seeded.save();
  seededId = seeded.id as string;
});
afterAll(async () => {
  await db?.close?.();
});

/** The principal's complete scope set is exactly `['items.read']`. */
const readerLocals = {
  user: { id: 'reader-1' },
  tenantId: 'tenant-a',
  permissions: ['items.read'],
  sessionId: 'sid',
};

function rpc(method: string, params: Record<string, unknown> = {}) {
  const url = new URL('https://app.example/api/mcp');
  return {
    locals: readerLocals,
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
            [CLIENT_INFO_META_KEY]: { name: 'effects-test', version: '0' },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  };
}

const writeWorkflow = {
  name: 'items_touch',
  description: 'Mutating workflow',
  inputSchema: { type: 'object' as const, properties: {} },
  outputSchema: { type: 'object' as const, properties: {} },
  effect: 'write' as const,
  idempotent: false,
  openWorld: false,
  execute: () => ({ content: [{ type: 'text' as const, text: 'touched' }] }),
};
const readWorkflow = {
  ...writeWorkflow,
  name: 'items_overview',
  description: 'Read-only workflow',
  effect: 'read' as const,
  idempotent: true,
  execute: () => ({ content: [{ type: 'text' as const, text: 'overview' }] }),
};

function route(effects?: readonly ('read' | 'write' | 'destructive')[]) {
  return mountMcpAppRoute({
    models: [LaneEffectItem],
    requiredScopes: ['items.read'],
    smrtOptions: () => ({ db }),
    workflowTools: [writeWorkflow, readWorkflow],
    ...(effects ? { effects } : {}),
  });
}

async function toolNames(handler: ReturnType<typeof route>) {
  const body = await (await handler(rpc('tools/list'))).json();
  return (body.result.tools as Array<{ name: string }>).map(({ name }) => name);
}

async function rowTitles() {
  const result = await db.query(
    'SELECT title FROM lane_effect_items ORDER BY title',
  );
  return result.rows.map((row: { title: string }) => row.title);
}

describe('effects: read-only MCP catalogs', () => {
  it('lists only read tools to a principal holding just items.read', async () => {
    expect(await toolNames(route(['read']))).toEqual([
      'items_overview',
      'laneeffectitem_get',
      'laneeffectitem_list',
    ]);
  });

  it.each([
    ['create', { title: 'Injected' }],
    ['update', () => ({ id: seededId, title: 'Overwritten' })],
    ['delete', () => ({ id: seededId })],
  ])('makes %s indistinguishable from an unknown tool and never dispatches it', async (action, args) => {
    const handler = route(['read']);
    const before = await rowTitles();
    const name = `laneeffectitem_${action}`;
    const denied = await (
      await handler(
        rpc('tools/call', {
          name,
          arguments: typeof args === 'function' ? args() : args,
        }),
      )
    ).json();
    const unknown = await (
      await handler(
        rpc('tools/call', {
          name: 'laneeffectitem_nonexistent',
          arguments: {},
        }),
      )
    ).json();
    expect(denied.error).toEqual({
      code: -32602,
      message: 'Unknown MCP tool.',
      data: {},
    });
    expect(denied).toEqual(unknown);
    expect(await rowTitles()).toEqual(before);
  });

  it('hides a write workflow and keeps a read workflow callable', async () => {
    const handler = route(['read']);
    const write = await (
      await handler(rpc('tools/call', { name: 'items_touch', arguments: {} }))
    ).json();
    expect(write.error).toMatchObject({ code: -32602 });
    const read = await (
      await handler(
        rpc('tools/call', { name: 'items_overview', arguments: {} }),
      )
    ).json();
    expect(read.result.content).toEqual([{ type: 'text', text: 'overview' }]);
  });

  it('denies a direct core call with 404 semantics', async () => {
    const server = createDefaultMcpAppServer({
      models: [LaneEffectItem],
      requiredScopes: ['items.read'],
      smrtOptions: () => ({ db }),
      effects: ['read'],
    });
    await expect(
      server.callTool({
        name: 'laneeffectitem_delete',
        arguments: { id: seededId },
        principal: {
          id: 'reader-1',
          tenantId: 'tenant-a',
          kind: 'human',
          scopes: ['items.read'],
        },
      }),
    ).rejects.toMatchObject({ status: 404, message: 'Unknown MCP tool.' });
    expect(await rowTitles()).toContain('Seeded');
  });

  it('keeps today’s catalog when the option is not set', async () => {
    expect(await toolNames(route())).toEqual([
      'items_overview',
      'items_touch',
      'laneeffectitem_create',
      'laneeffectitem_delete',
      'laneeffectitem_get',
      'laneeffectitem_list',
      'laneeffectitem_update',
    ]);
  });

  it('can admit writes without destructive tools', async () => {
    expect(await toolNames(route(['read', 'write']))).toEqual([
      'items_overview',
      'items_touch',
      'laneeffectitem_create',
      'laneeffectitem_get',
      'laneeffectitem_list',
      'laneeffectitem_update',
    ]);
  });

  it.each([
    [['read', 'admin']],
    ['read'],
    [[null]],
  ])('rejects malformed effects %j', (effects) => {
    expect(() =>
      createMcpAppServer({
        smrtOptions: () => ({}),
        serverInfo: { name: 'a', version: '1' },
        allowedClassNames: [],
        effects: effects as never,
      }),
    ).toThrow(TypeError);
  });
});

describe('mcpToolEffect', () => {
  it('classifies from canonical annotations, falling back to the name rule', () => {
    expect(mcpToolEffect({ name: 'x_list' })).toBe('read');
    expect(mcpToolEffect({ name: 'x_get' })).toBe('read');
    expect(mcpToolEffect({ name: 'x_create' })).toBe('destructive');
    // MCP: destructiveHint defaults to true when a tool is not read-only.
    expect(
      mcpToolEffect({ name: 'x_create', annotations: { readOnlyHint: false } }),
    ).toBe('destructive');
    expect(
      mcpToolEffect({
        name: 'x_create',
        annotations: { readOnlyHint: false, destructiveHint: false },
      }),
    ).toBe('write');
    expect(
      mcpToolEffect({
        name: 'x_list',
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    ).toBe('destructive');
    expect(
      mcpToolEffect({ name: 'x_go', annotations: { readOnlyHint: true } }),
    ).toBe('read');
  });
});
