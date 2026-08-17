/**
 * Acceptance coverage for issue #2367 on the generated REST surface.
 * https://github.com/happyvertical/smrt/issues/2367
 *
 * `handleList` parsed its bounds with
 * `Number.parseInt(params.get('limit') || '50', 10)` and applied no ceiling, so
 * `?limit=abc` bound `LIMIT NaN` (a driver error surfaced as a 500) and
 * `?limit=100000000` was a full table scan plus a full hydration pass on a
 * public endpoint. `?orderBy=` reached the collection unchecked against the
 * sensitive-column set, making the ordering an oracle over a column the same
 * request may neither filter on (#1540) nor project (#1902).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { MAX_LIST_LIMIT } from '../query-bounds';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

@smrt({ api: { include: ['list'], public: true } })
class RestBoundsWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ sensitive: true, type: 'text' })
  apiSecret: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.apiSecret !== undefined) this.apiSecret = options.apiSecret;
  }
}

class RestBoundsWidgetCollection extends SmrtCollection<RestBoundsWidget> {
  static readonly _itemClass = RestBoundsWidget;
}

// A class that declares its own primary key: schema generation omits the
// synthetic `id`/`slug`/`context` columns for it, so the default list ordering
// must tiebreak on `sku` rather than on a column that does not exist.
@smrt({ api: { include: ['list'], public: true } })
class RestBoundsPkWidget extends SmrtObject {
  @field({ primaryKey: true, type: 'text' })
  sku: string = '';

  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.sku !== undefined) this.sku = options.sku;
    if (options.name !== undefined) this.name = options.name;
  }
}

class RestBoundsPkWidgetCollection extends SmrtCollection<RestBoundsPkWidget> {
  static readonly _itemClass = RestBoundsPkWidget;
}

describe('#2367 REST list query bounds', () => {
  ObjectRegistry.registerCollection(
    'RestBoundsWidget',
    RestBoundsWidgetCollection,
  );
  ObjectRegistry.registerCollection(
    'RestBoundsPkWidget',
    RestBoundsPkWidgetCollection,
  );

  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let handler: (req: Request) => Promise<Response>;
  let pkHandler: (req: Request) => Promise<Response>;
  let collection: RestBoundsWidgetCollection;
  let pkCollection: RestBoundsPkWidgetCollection;

  const listUrl = (query = '') =>
    new Request(`http://localhost/api/v1/restboundswidgets${query}`);

  beforeAll(async () => {
    db = await getTestDatabase({
      classes: ['RestBoundsWidget', 'RestBoundsPkWidget'],
      type: 'sqlite',
      url: ':memory:',
    });
    collection = await RestBoundsWidgetCollection.create({ db });
    pkCollection = await RestBoundsPkWidgetCollection.create({ db });
    for (let index = 0; index < 3; index++) {
      const widget = await collection.create({
        apiSecret: `sk-${index}`,
        name: `widget-${index}`,
      });
      await widget.save();
    }

    const api = new APIGenerator({ basePath: '/api/v1' });
    api.registerCollection(
      'restboundswidgets',
      collection as unknown as SmrtCollection<SmrtObject>,
    );
    handler = api.generateHandler();

    const pkApi = new APIGenerator({ basePath: '/api/v2' });
    pkApi.registerCollection(
      'restboundspkwidgets',
      pkCollection as unknown as SmrtCollection<SmrtObject>,
    );
    pkHandler = pkApi.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  /**
   * Run a request and return the options the handler passed to
   * `collection.list()`. The call history is snapshotted before `mockRestore()`,
   * which also resets it.
   */
  async function listOptionsFor(query: string): Promise<{
    options: Record<string, unknown> | undefined;
    response: Response;
  }> {
    const listSpy = vi.spyOn(collection, 'list');
    let response: Response;
    let options: Record<string, unknown> | undefined;
    try {
      response = await handler(listUrl(query));
    } finally {
      options = listSpy.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      listSpy.mockRestore();
    }
    return { options, response };
  }

  it('serves an unqualified list with the default page size', async () => {
    const { options, response } = await listOptionsFor('');
    expect(response.status).toBe(200);
    expect(options).toMatchObject({ limit: 50, offset: 0 });
  });

  it('pages deterministically by default', async () => {
    const { options } = await listOptionsFor('');
    expect(options).toMatchObject({
      orderBy: ['created_at DESC', 'id ASC'],
    });
  });

  it('lets an explicit ?orderBy win over the default', async () => {
    const { options } = await listOptionsFor('?orderBy=name%20ASC');
    expect(options).toMatchObject({ orderBy: 'name ASC' });
  });

  it('tiebreaks on the declared primary key, not a synthetic id', async () => {
    // Custom-primary-key classes have no `id` column at all, so an `id`
    // tiebreak would fail every unqualified list request for them.
    const listSpy = vi.spyOn(pkCollection, 'list');
    let options: Record<string, unknown> | undefined;
    try {
      await pkHandler(
        new Request('http://localhost/api/v2/restboundspkwidgets'),
      );
    } finally {
      options = listSpy.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      listSpy.mockRestore();
    }
    expect(options).toMatchObject({ orderBy: ['created_at DESC', 'sku ASC'] });
  });

  it.each([
    ['abc'],
    ['1.5'],
    ['-1'],
    ['1e3'],
  ])('rejects ?limit=%s with a 400 instead of binding it', async (raw) => {
    const res = await handler(listUrl(`?limit=${encodeURIComponent(raw)}`));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: { ok: false, status: 400 },
    });
  });

  it('rejects a malformed ?offset with a 400', async () => {
    const res = await handler(listUrl('?offset=abc'));
    expect(res.status).toBe(400);
  });

  it('clamps an oversized page to the ceiling', async () => {
    const { options, response } = await listOptionsFor('?limit=100000000');
    expect(response.status).toBe(200);
    expect(options).toMatchObject({ limit: MAX_LIST_LIMIT });
  });

  it('honours an explicit ?limit=0 as an empty page', async () => {
    const res = await handler(listUrl('?limit=0'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it('does not borrow a tiebreak from an unrelated class', async () => {
    // The tiebreak is resolved from this object's own + inherited fields only.
    // A helper that unions STI siblings/descendants would let another class's
    // primary key become this one's tiebreak — the query would still succeed
    // (STI variants share a table) while ordering on a mostly-NULL column.
    const { options } = await listOptionsFor('');
    expect(options).toMatchObject({ orderBy: ['created_at DESC', 'id ASC'] });
  });

  it('rejects ordering by a sensitive field at the API boundary', async () => {
    const res = await handler(listUrl('?orderBy=apiSecret%20DESC&limit=1'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/sensitive/i);
  });

  it('rejects the snake_case column form of the same oracle', async () => {
    const res = await handler(listUrl('?orderBy=api_secret%20ASC&limit=1'));
    expect(res.status).toBe(400);
  });

  it('rejects ordering by an unknown column without echoing the schema', async () => {
    const res = await handler(listUrl('?orderBy=not_a_column'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toMatch(/api_secret/);
  });

  it('still serves a valid ordering', async () => {
    const res = await handler(listUrl('?orderBy=name%20ASC&limit=2'));
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(['widget-0', 'widget-1']);
  });
});
