/**
 * Integration test for issue #1540 (increment 2b): the runtime REST generator
 * (APIGenerator) must strip framework/server-managed fields from create/update
 * request bodies so callers cannot mass-assign `tenantId`, `id`, timestamps, or
 * `@field({ readonly: true })` fields.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

// `public: true` isolates the mass-assignment (2b) behavior from the
// fail-closed auth gate (2c), which is covered separately.
@smrt({ api: { include: ['list', 'get', 'create', 'update'], public: true } })
class RestWritableWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', readonly: true })
  internalCode: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.internalCode !== undefined)
      this.internalCode = options.internalCode;
  }
}

class RestWritableWidgetCollection extends SmrtCollection<RestWritableWidget> {
  static readonly _itemClass = RestWritableWidget;
}

describe('Issue #1540 (2b): REST runtime mass-assignment guard', () => {
  ObjectRegistry.registerCollection(
    'RestWritableWidget',
    RestWritableWidgetCollection,
  );

  let collection: RestWritableWidgetCollection;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['RestWritableWidget'],
    });
    collection = await RestWritableWidgetCollection.create({ db });

    const api = new APIGenerator({ basePath: '/api/v1' });
    api.registerCollection('restwritablewidgets', collection);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await collection.db?.close?.();
  });

  it('drops tenantId and read-only fields supplied in a create body', async () => {
    const res = await handler(
      new Request('http://local/api/v1/restwritablewidgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'legit',
          tenantId: 'attacker-tenant',
          internalCode: 'forged',
        }),
      }),
    );
    expect(res.status).toBe(201);

    const created = await collection.list({ where: { name: 'legit' } });
    expect(created).toHaveLength(1);
    // Forged framework/read-only fields were stripped before create.
    expect(created[0].tenantId).toBeNull();
    expect(created[0].internalCode).toBe('');
    expect(created[0].name).toBe('legit');
  });
});

@smrt({ api: { include: ['list', 'get', 'create'] } })
class RestPrivateWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

class RestPrivateWidgetCollection extends SmrtCollection<RestPrivateWidget> {
  static readonly _itemClass = RestPrivateWidget;
}

@smrt({ api: { include: ['list', 'get', 'create'], public: 'read' } })
class RestReadPublicWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

class RestReadPublicWidgetCollection extends SmrtCollection<RestReadPublicWidget> {
  static readonly _itemClass = RestReadPublicWidget;
}

describe('Issue #1540 (2c): REST runtime fail-closed authorization', () => {
  ObjectRegistry.registerCollection(
    'RestPrivateWidget',
    RestPrivateWidgetCollection,
  );
  ObjectRegistry.registerCollection(
    'RestReadPublicWidget',
    RestReadPublicWidgetCollection,
  );

  let privateHandler: (req: Request) => Promise<Response>;
  let readPublicHandler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['RestPrivateWidget', 'RestReadPublicWidget'],
    });

    const privateCollection = await RestPrivateWidgetCollection.create({ db });
    const privateApi = new APIGenerator({ basePath: '/api/v1' });
    privateApi.registerCollection('restprivatewidgets', privateCollection);
    privateHandler = privateApi.generateHandler();

    const readPublicCollection = await RestReadPublicWidgetCollection.create({
      db,
    });
    const readPublicApi = new APIGenerator({ basePath: '/api/v1' });
    readPublicApi.registerCollection(
      'restreadpublicwidgets',
      readPublicCollection,
    );
    readPublicHandler = readPublicApi.generateHandler();
  });

  it('returns 401 for a non-public object with no auth middleware', async () => {
    const res = await privateHandler(
      new Request('http://local/api/v1/restprivatewidgets'),
    );
    expect(res.status).toBe(401);
  });

  it('allows reads but blocks writes when public is "read"', async () => {
    const getRes = await readPublicHandler(
      new Request('http://local/api/v1/restreadpublicwidgets'),
    );
    expect(getRes.status).toBe(200);

    const postRes = await readPublicHandler(
      new Request('http://local/api/v1/restreadpublicwidgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'nope' }),
      }),
    );
    expect(postRes.status).toBe(401);
  });
});
