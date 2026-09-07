/**
 * Runtime REST transport half of issue #2686.
 * https://github.com/happyvertical/smrt/issues/2686
 *
 * `dispatchCustomCollectionAction` used to iterate `api.routes` and nothing
 * else. The sweeps that follow this issue migrate those entries onto their
 * methods, so unless this transport reads the EFFECTIVE metadata, migrating a
 * class would silently delete its runtime REST route while the generated
 * SvelteKit route kept working — the two transports disagreeing about the same
 * decorator config.
 *
 * `isRestActionRoutable`, which browser-plane preflight uses to PREDICT this
 * dispatch, must move with it: a prediction that says "no route" for a route
 * that exists reports a false `deny` on a playbook the caller can run.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, method } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import {
  isRestActionRoutable,
  restMethodForApiAction,
} from './preflight-route';
import { APIGenerator } from './rest';

@smrt({
  api: {
    public: true,
    include: [
      'create',
      'list',
      'get',
      'decorated',
      'legacy',
      'hidden',
      'window',
      'forced',
      'weighted',
      'noted',
    ],
    // `legacy` keeps the historical class-map declaration; `decorated` and
    // `hidden` declare themselves on the method instead.
    routes: { legacy: { method: 'POST', path: 'legacy' } },
  },
})
class DecoratedWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }

  /**
   * A STATIC model method: collection-scoped by receiver, and the one shape in
   * this file whose parameter metadata the runtime transport can actually read
   * (a collection-hosted action's manifest entry lives under the collection
   * class, so its parameters are invisible here and it degrades to the legacy
   * options bag).
   */
  @method({ httpMethod: 'GET', path: 'window' })
  static async window(start: Date): Promise<{ iso: string; isDate: boolean }> {
    return {
      iso: start instanceof Date ? start.toISOString() : String(start),
      isDate: start instanceof Date,
    };
  }
}

class DecoratedWidgetCollection extends SmrtCollection<DecoratedWidget> {
  static readonly _itemClass = DecoratedWidget;

  @method({ httpMethod: 'POST', path: 'decorated', effect: 'write' })
  async decorated(options: { symbol?: string } = {}): Promise<{
    symbol: string;
  }> {
    return { symbol: options.symbol ?? 'none' };
  }

  async legacy(options: { symbol?: string } = {}): Promise<{ symbol: string }> {
    return { symbol: options.symbol ?? 'none' };
  }

  @method({ httpMethod: 'POST', path: 'hidden', expose: false })
  async hidden(): Promise<{ reached: true }> {
    return { reached: true };
  }

  /** `expose: true` alone — no route shape at all. */
  @method({ expose: true })
  async forced(): Promise<{ forced: true }> {
    return { forced: true };
  }

  /** Tool semantics only, the shape a migrated `routes: { m: { effect } }` takes. */
  @method({ effect: 'write' })
  async weighted(): Promise<{ weighted: true }> {
    return { weighted: true };
  }

  /** `description` migrates from `ai.descriptions`, not from a route entry. */
  @method({ description: 'not a route declaration' })
  async noted(): Promise<{ noted: true }> {
    return { noted: true };
  }
}

describe('#2686 runtime REST reads decorator-declared routes', () => {
  ObjectRegistry.registerCollection(
    'DecoratedWidget',
    DecoratedWidgetCollection,
  );
  // Only the STATIC item method is seeded, and only for its parameter
  // metadata: that is exactly what a real scan would put in the item class's
  // manifest entry, and it is what the Date-hydration assertion needs. The
  // collection-hosted methods are deliberately NOT seeded — their config comes
  // from the live `@method()` store, the way it does in a real project, where
  // their manifest entry lives under the COLLECTION class and never reaches
  // this map.
  ObjectRegistry.getMethods('DecoratedWidget').set('window', {
    name: 'window',
    async: true,
    isPublic: true,
    isStatic: true,
    returnType: 'object',
    parameters: [{ name: 'start', type: 'Date', optional: false }],
    decoratorConfig: { httpMethod: 'GET', path: 'window' },
  });

  let db: any;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['DecoratedWidget'],
    });
    const collection = await DecoratedWidgetCollection.create({ db });
    const api = new APIGenerator({ basePath: '/api/v1' }, { db });
    api.registerCollection('decoratedwidgets', collection);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  const post = (path: string, body?: unknown): Promise<Response> =>
    handler(
      new Request(`http://localhost/api/v1/decoratedwidgets/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it('dispatches a route declared only by @method()', async () => {
    const response = await post('decorated', { symbol: 'HV' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'decorated',
      result: { symbol: 'HV' },
    });
  });

  it('still dispatches a route declared only by the legacy class map', async () => {
    const response = await post('legacy', { symbol: 'OLD' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'legacy',
      result: { symbol: 'OLD' },
    });
  });

  it('refuses a withheld action without degrading into a CRUD create', async () => {
    // The dangerous shape: this router resolves `POST /<collection>/<segment>`
    // to `create` when nothing claims the segment, so falling through here
    // turned a request aimed at an explicitly withheld operation into a silent
    // row insert that answered 2xx. An `action`-shaped assertion alone passes
    // on a created object, which is how that masked itself -- so this asserts
    // the status AND that no row was written.
    const before = (await await handler(
      new Request('http://localhost/api/v1/decoratedwidgets'),
    ).then((r) => r.json())) as { data?: unknown[] };

    const response = await post('hidden', { name: 'should-not-persist' });
    expect(response.status).toBe(404);
    expect(await response.json()).not.toMatchObject({ action: 'hidden' });

    const after = (await (
      await handler(new Request('http://localhost/api/v1/decoratedwidgets'))
    ).json()) as { data?: unknown[] };
    expect(after.data ?? []).toHaveLength((before.data ?? []).length);
  });

  it('predicts the withheld action as unroutable for preflight', () => {
    // `expose: false` outranks the route declaration on the same method.
    // Dispatch refuses it, so a prediction of `allow` would be the exact
    // false-`allow` browser-plane preflight exists to prevent.
    expect(isRestActionRoutable('DecoratedWidget', 'hidden')).toBe(false);
  });

  it('hydrates a Date parameter from the query string', async () => {
    const response = await handler(
      new Request(
        'http://localhost/api/v1/decoratedwidgets/window?start=2026-09-05T00:00:00.000Z',
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'window',
      result: { iso: '2026-09-05T00:00:00.000Z', isDate: true },
    });
  });

  it('dispatches a route declared only by @method({ expose: true })', async () => {
    // `expose: true` carries no verb or path, but it is the strongest available
    // statement that the method is an action. Recognizing it only where a route
    // SHAPE was also supplied left the SvelteKit transport serving the method
    // while this one 404'd and preflight predicted denial.
    const response = await post('forced');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      action: 'forced',
      result: { forced: true },
    });
  });

  it('dispatches a route whose decorator supplies only tool semantics', async () => {
    // The migration shape that matters: `routes: { weighted: { effect: 'write' } }`
    // already dispatches at POST /<collection>/weighted with no path or verb, so
    // moving that option onto the method must not delete the endpoint.
    const response = await post('weighted');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ action: 'weighted' });
  });

  it('does not invent a runtime route for a description-only decorator', () => {
    // `description` migrates from `ai.descriptions`, not from `api.routes`;
    // counting it would hand this transport an endpoint it never served.
    expect(isRestActionRoutable('DecoratedWidget', 'noted')).toBe(false);
  });

  it('predicts the decorator-declared route and its verb for preflight', () => {
    expect(isRestActionRoutable('DecoratedWidget', 'decorated')).toBe(true);
    expect(isRestActionRoutable('DecoratedWidget', 'legacy')).toBe(true);
    expect(isRestActionRoutable('DecoratedWidget', 'forced')).toBe(true);
    expect(isRestActionRoutable('DecoratedWidget', 'weighted')).toBe(true);
    expect(isRestActionRoutable('DecoratedWidget', 'missing')).toBe(false);
    expect(restMethodForApiAction('window', 'DecoratedWidget')).toBe('GET');
    expect(restMethodForApiAction('legacy', 'DecoratedWidget')).toBe('POST');
  });
});
