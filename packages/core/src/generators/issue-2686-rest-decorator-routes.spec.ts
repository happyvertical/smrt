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

  @method({ httpMethod: 'GET', path: 'window' })
  async window(start: Date): Promise<{ iso: string; isDate: boolean }> {
    return {
      iso: start instanceof Date ? start.toISOString() : String(start),
      isDate: start instanceof Date,
    };
  }
}

describe('#2686 runtime REST reads decorator-declared routes', () => {
  ObjectRegistry.registerCollection(
    'DecoratedWidget',
    DecoratedWidgetCollection,
  );
  // Stand in for the manifest the scanner would supply at build time: the
  // registry is where the runtime transport reads method metadata from.
  const methods = ObjectRegistry.getMethods('DecoratedWidget');
  methods.set('decorated', {
    name: 'decorated',
    async: true,
    isPublic: true,
    isStatic: false,
    returnType: 'object',
    parameters: [{ name: 'options', type: 'object', optional: true }],
    decoratorConfig: { httpMethod: 'POST', path: 'decorated', effect: 'write' },
  });
  methods.set('hidden', {
    name: 'hidden',
    async: true,
    isPublic: true,
    isStatic: false,
    returnType: 'object',
    parameters: [],
    decoratorConfig: { httpMethod: 'POST', path: 'hidden', expose: false },
  });
  methods.set('window', {
    name: 'window',
    async: true,
    isPublic: true,
    isStatic: false,
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

  it('refuses a method withheld by @method({ expose: false })', async () => {
    const response = await post('hidden');
    // Falls through to CRUD handling rather than invoking the action: the
    // segment is not a known id, so it is not a successful action response.
    expect(await response.json()).not.toMatchObject({ action: 'hidden' });
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

  it('predicts the decorator-declared route and its verb for preflight', () => {
    expect(isRestActionRoutable('DecoratedWidget', 'decorated')).toBe(true);
    expect(isRestActionRoutable('DecoratedWidget', 'legacy')).toBe(true);
    expect(isRestActionRoutable('DecoratedWidget', 'missing')).toBe(false);
    expect(restMethodForApiAction('window', 'DecoratedWidget')).toBe('GET');
    expect(restMethodForApiAction('legacy', 'DecoratedWidget')).toBe('POST');
  });
});
