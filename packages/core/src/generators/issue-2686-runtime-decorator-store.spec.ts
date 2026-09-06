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
 * file deliberately seeds NOTHING.
 *
 * The same gap reaches a fully SCANNED project: the dispatcher looks methods up
 * by the item object name, while a collection-hosted action's manifest entry
 * lives under the collection class — so `getMethods(itemName)` never carries it
 * either way. `beforeAll` asserts exactly that, rather than an empty method map,
 * because core's own test manifest scans this file.
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
    include: ['create', 'list', 'get', 'concealed', 'shaped', 'reviewed'],
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

  /**
   * The decorator's MOST COMMON shape: an item-scoped declaration on a model
   * instance method. This transport serves only collection-scoped custom
   * actions, so it has no receiver for it.
   */
  @method({ httpMethod: 'POST', path: 'reviewed' })
  async reviewed(): Promise<{ reviewed: true }> {
    return { reviewed: true };
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

/**
 * A second class whose simple NAME collides with the decorated one. Nothing
 * decorates it, so a name-keyed store would still hand it the collection's
 * `expose: false`.
 */
class SameNameDecoy {
  async concealed(): Promise<unknown> {
    return {};
  }
}
Object.defineProperty(SameNameDecoy, 'name', {
  value: 'UnscannedWidgetCollection',
});

describe('#2686 @method() is honored without a manifest', () => {
  ObjectRegistry.registerCollection(
    'UnscannedWidget',
    UnscannedWidgetCollection,
  );

  let db: any;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    // The premise of this file, stated per method rather than as an empty map:
    // the runtime dispatcher looks methods up by the ITEM object name, and a
    // collection-hosted action's manifest entry lives under the COLLECTION
    // class — so the config for these two can only come from the live store.
    // (Core's own test manifest scans this file, so asserting an empty map
    // would only be testing the scanner's include globs.)
    const itemMethods = ObjectRegistry.getMethods('UnscannedWidget');
    expect(itemMethods.get('concealed')).toBeUndefined();
    expect(itemMethods.get('shaped')).toBeUndefined();

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

  it('registers the decorator config against the collection CONSTRUCTOR', () => {
    // Constructor identity, not simple name: `Account` exists in both
    // `smrt-ledgers` and `smrt-messages`, and a name-keyed store would let one
    // package's `expose: false` withhold the other's identically-named action.
    expect(
      ObjectRegistry.getMethodDecorator(UnscannedWidgetCollection, 'concealed'),
    ).toMatchObject({ expose: false });
    expect(
      ObjectRegistry.getMethodDecorator(SameNameDecoy, 'concealed'),
    ).toBeUndefined();
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

  it('predicts an item-scoped declaration as unroutable', () => {
    // Dispatch answers 404 for it (next test), so predicting `allow` would be
    // the false-`allow` browser-plane preflight exists to prevent. The receiver
    // survives only because the decorator recorded it — an unscanned runtime
    // has no manifest to recover `isStatic` from.
    expect(isRestActionRoutable('UnscannedWidget', 'reviewed')).toBe(false);
  });

  it('refuses an item-scoped declaration instead of creating a row', async () => {
    // Before #2686 closed it, this fell through to CRUD handling and
    // `POST /<collection>/reviewed` resolved to `create`: an authenticated
    // caller aiming at a custom action silently inserted a row and got 201.
    const response = await post('reviewed', { name: 'should-not-persist' });
    expect(response.status).toBe(404);

    const listed = (await (
      await handler(new Request('http://localhost/api/v1/unscannedwidgets'))
    ).json()) as { data?: unknown[] };
    expect(listed.data ?? []).toHaveLength(0);
  });
});
