/**
 * `@method()` in an UNSCANNED runtime (#2686).
 *
 * `startRestServer([Product], { db })` is a supported posture with no manifest
 * at all: `ObjectRegistry.getMethods()` is empty while the decorators did run.
 * Reading only the manifest therefore made `@method({ expose: false })`
 * invisible there, so a legacy `api.routes` entry alone still routed the
 * withheld action and preflight predicted `allow` for it. Absent exposure
 * metadata defaults OPEN in this framework, which makes that a silent widening.
 *
 * `issue-2686-rest-decorator-routes.spec.ts` seeds `ObjectRegistry.getMethods`
 * by hand to stand in for the manifest, which is exactly what hid this. This
 * file deliberately seeds NOTHING: every assertion below has to come from the
 * live decorator store.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, method } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { isRestActionRoutable } from './preflight-route';
import { APIGenerator } from './rest';

@smrt({
  api: {
    public: true,
    include: ['create', 'list', 'get', 'concealed', 'shaped'],
    // The legacy declaration that, on its own, would still route `concealed`.
    routes: { concealed: { path: 'concealed', method: 'POST' } },
  },
})
class UnscannedWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class UnscannedWidgetCollection extends SmrtCollection<UnscannedWidget> {
  static readonly _itemClass = UnscannedWidget;

  /** Withheld on the method while the class map still declares its route. */
  @method({ expose: false, reason: 'internal bookkeeping' })
  async concealed(): Promise<{ reached: true }> {
    return { reached: true };
  }

  /** Declared only by the decorator — no `api.routes` entry at all. */
  @method({ httpMethod: 'POST', path: 'shaped' })
  async shaped(options: { note?: string } = {}): Promise<{ note: string }> {
    return { note: options.note ?? 'none' };
  }
}

describe('#2686 @method() is honored without a manifest', () => {
  ObjectRegistry.registerCollection(
    'UnscannedWidget',
    UnscannedWidgetCollection,
  );

  let db: any;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    // The premise of this file: nothing seeds the methods map.
    expect(ObjectRegistry.getMethods('UnscannedWidget').size).toBe(0);

    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['UnscannedWidget'],
    });
    const collection = await UnscannedWidgetCollection.create({ db });
    const api = new APIGenerator({ basePath: '/api/v1' }, { db });
    api.registerCollection('unscannedwidgets', collection);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  const post = (path: string, body?: unknown): Promise<Response> =>
    handler(
      new Request(`http://localhost/api/v1/unscannedwidgets/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it('registers the decorator config on the collection class', () => {
    expect(
      ObjectRegistry.getMethodDecorator(
        'UnscannedWidgetCollection',
        'concealed',
      ),
    ).toMatchObject({ expose: false });
  });

  it('refuses a withheld action even though api.routes still declares it', async () => {
    const response = await post('concealed', { name: 'should-not-persist' });
    expect(response.status).toBe(404);

    const listed = (await (
      await handler(new Request('http://localhost/api/v1/unscannedwidgets'))
    ).json()) as { data?: unknown[] };
    expect(listed.data ?? []).toHaveLength(0);
  });

  it('predicts the withheld action as unroutable', () => {
    expect(isRestActionRoutable('UnscannedWidget', 'concealed')).toBe(false);
  });

  it('dispatches a route declared only by the decorator', async () => {
    const response = await post('shaped', { note: 'live' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'shaped',
      result: { note: 'live' },
    });
  });

  it('predicts the decorator-only route as routable', () => {
    expect(isRestActionRoutable('UnscannedWidget', 'shaped')).toBe(true);
  });
});
