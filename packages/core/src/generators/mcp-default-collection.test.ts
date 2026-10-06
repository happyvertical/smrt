/**
 * A model that declares no collection class is served by MCP tool calls with
 * the registry's default collection, as generated REST routes already are
 * (`ObjectRegistry.getCollection`). smrt-start's `Note` declares none, so its
 * `note_list` failed with "No valid collection constructor found" (#3490).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import { MCPGenerator } from './mcp.js';

@smrt({ mcp: { include: ['list', 'get'] } })
class CollectionlessMcpNote extends SmrtObject {
  title: string = '';
}

describe('MCP tool call for a model without a collection class (#3490)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    db = await getTestDatabase({ classes: ['CollectionlessMcpNote'] });
    await db.insert('collectionless_mcp_notes', {
      id: '00000000-0000-4000-8000-000000003490',
      slug: 'first',
      context: '',
      title: 'first note',
    });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  it('lists through the default collection', async () => {
    expect(
      ObjectRegistry.getClassByConstructor(CollectionlessMcpNote)
        ?.collectionConstructor,
    ).toBeUndefined();
    const response = await new MCPGenerator(
      { classNames: ['CollectionlessMcpNote'] },
      { db, user: { id: 'test-user' } },
    ).handleToolCall({
      method: 'tools/call',
      params: { name: 'collectionlessmcpnote_list', arguments: {} },
    });
    expect(response.content[0]?.text ?? '').not.toContain('collection');
    expect(response.isError).not.toBe(true);
    expect(JSON.stringify(response.structuredContent)).toContain('first note');
  });
});
