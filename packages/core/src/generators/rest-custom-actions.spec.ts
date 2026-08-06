/**
 * Contract coverage for the runtime REST transport's decorator-declared
 * custom COLLECTION action dispatch (#2047).
 *
 * The generated SvelteKit/CLI/MCP transports already share one custom-action
 * contract via `./custom-action` (scope resolution, argument projection,
 * returned-failure normalization). These tests pin that the runtime
 * `APIGenerator` transport matches it, because a divergence here silently
 * degrades an action request into a CRUD write.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

// `scope` is OMITTED on every route below: it is optional and defaults to
// `collection` for statics / `item` for instance methods. Requiring a literal
// `scope: 'collection'` used to skip these routes entirely, letting
// `POST /<collection>/<action>` fall through into `create`.
@smrt({
  api: {
    public: true,
    include: ['create', 'list', 'get', 'quote', 'ping', 'refuse'],
    routes: {
      quote: { method: 'POST', path: 'quote' },
      ping: { method: 'POST', path: 'ping' },
      refuse: { method: 'POST', path: 'refuse' },
    },
  },
})
class ActionWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class ActionWidgetCollection extends SmrtCollection<ActionWidget> {
  static readonly _itemClass = ActionWidget;

  /** Single `options` bag — the common shape, passed straight through. */
  async quote(options: { symbol?: string } = {}): Promise<{ symbol: string }> {
    return { symbol: options.symbol ?? 'none' };
  }

  /** Zero parameters — must dispatch with NO request body at all. */
  async ping(): Promise<{ pong: true }> {
    return { pong: true };
  }

  /** Returns the shared `{ ok: false }` failure convention. */
  async refuse(): Promise<unknown> {
    return {
      ok: false,
      code: 'not_allowed',
      message: 'refused with token=supersecret in the text',
      status: 422,
    };
  }
}

describe('runtime REST custom collection actions (#2047)', () => {
  ObjectRegistry.registerCollection('ActionWidget', ActionWidgetCollection);

  let db: any;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['ActionWidget'],
    });
    const collection = await ActionWidgetCollection.create({ db });
    const api = new APIGenerator({ basePath: '/api/v1' }, { db });
    api.registerCollection('actionwidgets', collection);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  const post = (path: string, body?: unknown): Promise<Response> =>
    handler(
      new Request(`http://localhost/api/v1/actionwidgets/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it('dispatches an action whose route omits an explicit scope', async () => {
    const response = await post('quote', { symbol: 'HV' });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      action: string;
      result: { symbol: string };
    };
    expect(payload.action).toBe('quote');
    expect(payload.result.symbol).toBe('HV');

    // Critically, it must NOT have degraded into a create: `create` is
    // exposed on this object, so a fall-through would have persisted a row
    // (and returned 201) instead of invoking the action.
    const listed = await handler(
      new Request('http://localhost/api/v1/actionwidgets'),
    );
    const listedPayload = (await listed.json()) as { data?: unknown[] };
    expect(listedPayload.data ?? []).toHaveLength(0);
  });

  it('invokes a zero-parameter action without requiring a request body', async () => {
    const response = await post('ping');
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      action: string;
      result: { pong: boolean };
    };
    expect(payload.action).toBe('ping');
    expect(payload.result.pong).toBe(true);
  });

  it('maps a returned failure to its status and redacts the payload', async () => {
    const response = await post('refuse');
    expect(response.status).toBe(422);
    const payload = (await response.json()) as {
      error: { ok: boolean; code: string; message: string; status: number };
      action?: string;
    };
    // Never a 200 wrapping the raw failure object.
    expect(payload.action).toBeUndefined();
    expect(payload.error.ok).toBe(false);
    expect(payload.error.code).toBe('not_allowed');
    expect(payload.error.status).toBe(422);
    expect(payload.error.message).toContain('[REDACTED]');
    expect(payload.error.message).not.toContain('supersecret');
  });
});
