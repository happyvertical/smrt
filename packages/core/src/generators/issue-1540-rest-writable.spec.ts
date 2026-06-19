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

@smrt({ api: { include: ['list', 'get', 'create', 'update'] } })
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
