/**
 * Acceptance coverage for issue #2367 on the MCP surfaces.
 * https://github.com/happyvertical/smrt/issues/2367
 *
 * The in-process generator capped `limit` at 1000 but reached it through
 * `(args.limit as number) || 50`, which turns a deliberate `limit: 0` into 50
 * and passes a non-numeric arg straight through to the driver as `LIMIT NaN` —
 * MCP arguments are untyped JSON, so that is caller-reachable. The emitted
 * stdio runtime (`mcp-runtime-template.ts`) had no cap at all: its handler read
 * `args.limit ?? 50` and handed the value to `collection.list()`.
 */

import { describe, expect, it, vi } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { MAX_LIST_LIMIT } from '../query-bounds';
import { smrt } from '../registry';
import { MCPGenerator } from './mcp';
import { generateRuntimeBootstrap } from './mcp-runtime-template';

@smrt({ mcp: { include: ['list'] } })
class McpBoundsWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

/**
 * Drive `mcpboundswidget_list` with the given tool arguments and return the
 * options the generator passed to `collection.list()`.
 */
async function callList(args: Record<string, unknown>) {
  // Authenticated context: the MCP auth gate runs before the bounds parser, so
  // an anonymous call would fail for an unrelated reason.
  const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
  const calls: Array<Record<string, unknown>> = [];
  const collection = {
    count: vi.fn().mockResolvedValue(0),
    list: vi.fn(async (options: Record<string, unknown>) => {
      calls.push(options);
      return [];
    }),
  };
  (generator as any).getCollection = vi.fn().mockResolvedValue(collection);
  (generator as any).collections = new Map([['McpBoundsWidget', collection]]);

  const response = await generator.handleToolCall({
    method: 'tools/call',
    params: { arguments: args, name: 'mcpboundswidget_list' },
  });

  return { calls, response };
}

describe('#2367 MCP list query bounds', () => {
  it('defaults the page size when the caller supplies none', async () => {
    const { calls, response } = await callList({});
    expect(response.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ limit: 50, offset: 0 });
  });

  it('clamps an oversized page to the ceiling', async () => {
    const { calls } = await callList({ limit: 100_000_000 });
    expect(calls[0]).toMatchObject({ limit: MAX_LIST_LIMIT });
  });

  it('honours an explicit limit of 0 instead of folding it into 50', async () => {
    const { calls } = await callList({ limit: 0 });
    expect(calls[0]).toMatchObject({ limit: 0 });
  });

  it.each([
    ['abc'],
    [1.5],
    [-1],
    [Number.NaN],
    [true],
  ])('rejects the malformed limit %j as a tool error, not a driver error', async (limit) => {
    const { calls, response } = await callList({ limit });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/limit/i);
    expect(calls).toHaveLength(0);
  });

  it('treats an explicit null as absent rather than malformed', async () => {
    const { calls, response } = await callList({ limit: null });
    expect(response.isError).toBeFalsy();
    expect(calls[0]).toMatchObject({ limit: 50 });
  });

  it('rejects a malformed offset the same way', async () => {
    const { calls, response } = await callList({ offset: 'abc' });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/offset/i);
    expect(calls).toHaveLength(0);
  });

  it('pages deterministically when the caller supplies no ordering', async () => {
    const { calls } = await callList({});
    expect(calls[0]).toMatchObject({
      orderBy: ['created_at DESC', 'id ASC'],
    });
  });

  it('lets an explicit orderBy win over the default', async () => {
    const { calls } = await callList({ orderBy: 'name ASC' });
    expect(calls[0]).toMatchObject({ orderBy: 'name ASC' });
  });
});

describe('#2367 emitted MCP stdio runtime bounds', () => {
  const source = generateRuntimeBootstrap({
    tools: [
      {
        description: 'List widgets',
        inputSchema: { properties: {}, type: 'object' },
        name: 'widget_list',
      },
    ],
  });

  it('emits the shared bounds guard', () => {
    expect(source).toContain('function resolveListBound(');
  });

  it('routes the list handler through it with the ceiling applied', () => {
    expect(source).toContain(
      `const limit = resolveListBound(args.limit, 'limit', 50, ${MAX_LIST_LIMIT});`,
    );
    expect(source).toContain(
      "const offset = resolveListBound(args.offset, 'offset', 0);",
    );
  });

  it('no longer takes the bound straight off the untyped argument bag', () => {
    expect(source).not.toContain('const limit = args.limit ?? 50;');
    expect(source).not.toContain('const offset = args.offset ?? 0;');
  });

  it('honours the advertised orderBy argument and defaults it', () => {
    // The tool schema advertises `orderBy`; the emitted handler used to build
    // `collection.list({ where, limit, offset })` and drop it silently.
    expect(source).toContain(
      'const orderBy = args.orderBy ?? ["created_at DESC","id ASC"];',
    );
    expect(source).toContain(
      'const items = await collection.list({ where, limit, offset, orderBy });',
    );
    expect(source).not.toContain(
      'const items = await collection.list({ where, limit, offset });',
    );
  });

  it('bakes in a per-object tiebreak for a custom primary key', () => {
    const custom = generateRuntimeBootstrap({
      listOrderBy: { widget: ['created_at DESC', 'sku ASC'] },
      tools: [
        {
          description: 'List widgets',
          inputSchema: { properties: {}, type: 'object' },
          name: 'widget_list',
        },
      ],
    });
    expect(custom).toContain(
      'const orderBy = args.orderBy ?? ["created_at DESC","sku ASC"];',
    );
  });
});
