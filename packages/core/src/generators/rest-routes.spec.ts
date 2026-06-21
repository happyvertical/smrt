/**
 * Coverage for the REST API generator route map and request handling (#1500).
 *
 * These tests drive `APIGenerator.generateHandler()` with `Request` objects and
 * assert the produced `Response` artifacts — CRUD routing, include/exclude
 * action gating, REST query-operator translation, the count endpoint, the
 * mass-assignment writable policy, auth middleware, the fail-closed posture, and
 * the explicit-allowlist CORS behavior (#1540). No real HTTP server is bound;
 * the handler is exercised directly, mirroring `issue-1540-rest-writable.spec`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { APIGenerator } from './rest';

// Full-CRUD, public object so route dispatch is isolated from the auth gate.
@smrt({ api: { public: true } })
class RestRouteWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'integer' })
  price: number = 0;

  @field({ type: 'text', readonly: true })
  internalCode: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.price !== undefined) this.price = options.price;
    if (options.internalCode !== undefined)
      this.internalCode = options.internalCode;
  }
}

class RestRouteWidgetCollection extends SmrtCollection<RestRouteWidget> {
  static readonly _itemClass = RestRouteWidget;
}

// Object exposing only list/get — create/update/delete must be 405.
@smrt({ api: { include: ['list', 'get'], public: true } })
class RestReadOnlyWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class RestReadOnlyWidgetCollection extends SmrtCollection<RestReadOnlyWidget> {
  static readonly _itemClass = RestReadOnlyWidget;
}

// Object with an explicit exclude list — delete must be blocked (405).
@smrt({ api: { exclude: ['delete'], public: true } })
class RestExcludeWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class RestExcludeWidgetCollection extends SmrtCollection<RestExcludeWidget> {
  static readonly _itemClass = RestExcludeWidget;
}

describe('REST generator route map (#1500)', () => {
  ObjectRegistry.registerCollection(
    'RestRouteWidget',
    RestRouteWidgetCollection,
  );
  ObjectRegistry.registerCollection(
    'RestReadOnlyWidget',
    RestReadOnlyWidgetCollection,
  );
  ObjectRegistry.registerCollection(
    'RestExcludeWidget',
    RestExcludeWidgetCollection,
  );

  let db: any;
  let handler: (req: Request) => Promise<Response>;
  let collection: RestRouteWidgetCollection;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['RestRouteWidget', 'RestReadOnlyWidget', 'RestExcludeWidget'],
    });
    collection = await RestRouteWidgetCollection.create({ db });

    const api = new APIGenerator({ basePath: '/api/v1' });
    api.registerCollection('restroutewidgets', collection);
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  const post = (body: Record<string, any>) =>
    handler(
      new Request('http://local/api/v1/restroutewidgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  describe('full CRUD lifecycle', () => {
    let createdId: string;

    it('POST creates and returns 201 with the public payload', async () => {
      const res = await post({ name: 'Alpha', price: 10, internalCode: 'X' });
      expect(res.status).toBe(201);
      const json = (await res.json()) as any;
      expect(json.name).toBe('Alpha');
      // readonly field stripped by the writable policy.
      expect(json.internalCode).toBe('');
      createdId = json.id;
      expect(createdId).toBeTruthy();
    });

    it('GET /:id returns the object', async () => {
      const res = await handler(
        new Request(`http://local/api/v1/restroutewidgets/${createdId}`),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.id).toBe(createdId);
      expect(json.name).toBe('Alpha');
    });

    it('GET /:id returns 404 for a missing id', async () => {
      const res = await handler(
        new Request('http://local/api/v1/restroutewidgets/does-not-exist'),
      );
      expect(res.status).toBe(404);
    });

    it('GET list returns an array', async () => {
      const res = await handler(
        new Request('http://local/api/v1/restroutewidgets'),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any[];
      expect(Array.isArray(json)).toBe(true);
      expect(json.some((o) => o.id === createdId)).toBe(true);
    });

    it('PUT /:id updates the object', async () => {
      const res = await handler(
        new Request(`http://local/api/v1/restroutewidgets/${createdId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Alpha-2' }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.name).toBe('Alpha-2');
    });

    it('PATCH /:id updates the object', async () => {
      const res = await handler(
        new Request(`http://local/api/v1/restroutewidgets/${createdId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ price: 42 }),
        }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.price).toBe(42);
    });

    it('PUT without an id returns 400', async () => {
      const res = await handler(
        new Request('http://local/api/v1/restroutewidgets', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'no-id' }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it('PUT /:id returns 404 for a missing object', async () => {
      const res = await handler(
        new Request('http://local/api/v1/restroutewidgets/missing', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'nope' }),
        }),
      );
      expect(res.status).toBe(404);
    });

    it('DELETE /:id removes the object and returns 204', async () => {
      const res = await handler(
        new Request(`http://local/api/v1/restroutewidgets/${createdId}`, {
          method: 'DELETE',
        }),
      );
      expect(res.status).toBe(204);

      const after = await handler(
        new Request(`http://local/api/v1/restroutewidgets/${createdId}`),
      );
      expect(after.status).toBe(404);
    });

    it('DELETE without an id returns 400', async () => {
      const res = await handler(
        new Request('http://local/api/v1/restroutewidgets', {
          method: 'DELETE',
        }),
      );
      expect(res.status).toBe(400);
    });

    it('DELETE /:id returns 404 for a missing object', async () => {
      const res = await handler(
        new Request('http://local/api/v1/restroutewidgets/missing', {
          method: 'DELETE',
        }),
      );
      expect(res.status).toBe(404);
    });
  });

  describe('list filtering and count', () => {
    beforeAll(async () => {
      for (const [name, price] of [
        ['Filter-A', 5],
        ['Filter-B', 15],
        ['Filter-C', 25],
      ] as const) {
        const r = await post({ name, price });
        expect(r.status).toBe(201);
      }
    });

    it('translates the gt REST operator into a SQL filter', async () => {
      const res = await handler(
        new Request(
          'http://local/api/v1/restroutewidgets?price[gt]=10&orderBy=price ASC',
        ),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any[];
      const names = json.map((o) => o.name);
      expect(names).toContain('Filter-B');
      expect(names).toContain('Filter-C');
      expect(names).not.toContain('Filter-A');
    });

    it('translates the in REST operator into an array filter', async () => {
      const res = await handler(
        new Request(
          'http://local/api/v1/restroutewidgets?name[in]=Filter-A,Filter-C',
        ),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any[];
      const names = json.map((o) => o.name).sort();
      expect(names).toEqual(['Filter-A', 'Filter-C']);
    });

    it('honors limit + offset on list', async () => {
      const res = await handler(
        new Request('http://local/api/v1/restroutewidgets?limit=2&offset=0'),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as any[];
      expect(json.length).toBeLessThanOrEqual(2);
    });

    it('GET /count returns a count, honoring REST operators', async () => {
      const all = await handler(
        new Request('http://local/api/v1/restroutewidgets/count'),
      );
      expect(all.status).toBe(200);
      const allJson = (await all.json()) as { count: number };
      expect(typeof allJson.count).toBe('number');

      const filtered = await handler(
        new Request('http://local/api/v1/restroutewidgets/count?price[gte]=15'),
      );
      const filteredJson = (await filtered.json()) as { count: number };
      expect(filteredJson.count).toBeGreaterThanOrEqual(2);
      expect(filteredJson.count).toBeLessThan(allJson.count);
    });
  });

  describe('action gating via @smrt({ api })', () => {
    let readOnlyHandler: (req: Request) => Promise<Response>;
    let excludeHandler: (req: Request) => Promise<Response>;

    beforeAll(async () => {
      const roCollection = await RestReadOnlyWidgetCollection.create({ db });
      const roApi = new APIGenerator({ basePath: '/api/v1' });
      roApi.registerCollection('restreadonlywidgets', roCollection);
      readOnlyHandler = roApi.generateHandler();

      const exCollection = await RestExcludeWidgetCollection.create({ db });
      const exApi = new APIGenerator({ basePath: '/api/v1' });
      exApi.registerCollection('restexcludewidgets', exCollection);
      excludeHandler = exApi.generateHandler();
    });

    it('returns 405 for create when include omits it', async () => {
      const res = await readOnlyHandler(
        new Request('http://local/api/v1/restreadonlywidgets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'blocked' }),
        }),
      );
      expect(res.status).toBe(405);
    });

    it('allows list when include names it', async () => {
      const res = await readOnlyHandler(
        new Request('http://local/api/v1/restreadonlywidgets'),
      );
      expect(res.status).toBe(200);
    });

    it('returns 405 for delete when exclude lists it', async () => {
      const res = await excludeHandler(
        new Request('http://local/api/v1/restexcludewidgets/some-id', {
          method: 'DELETE',
        }),
      );
      expect(res.status).toBe(405);
    });
  });

  describe('routing edge cases', () => {
    it('returns 400 when no object type is given', async () => {
      const res = await handler(new Request('http://local/api/v1/'));
      expect(res.status).toBe(400);
    });

    it('returns 404 for an out-of-basePath path', async () => {
      const res = await handler(new Request('http://local/totally/elsewhere'));
      expect(res.status).toBe(404);
    });

    it('returns 404 for an unknown object type', async () => {
      const res = await handler(
        new Request('http://local/api/v1/nonexistentthings'),
      );
      expect(res.status).toBe(404);
    });

    it('returns 405 for an unsupported HTTP method', async () => {
      const res = await handler(
        new Request('http://local/api/v1/restroutewidgets', {
          method: 'OPTIONS',
        }),
      );
      // CORS is disabled by default, so OPTIONS falls through to the object
      // router, which has no handler for it → 405.
      expect(res.status).toBe(405);
    });
  });
});

// Object whose URL is resolved through auto-discovery (no explicit
// api.registerCollection) — exercises the ObjectRegistry fallback + pluralize.
@smrt({ api: { public: true } })
class RestDiscoveryWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class RestDiscoveryWidgetCollection extends SmrtCollection<RestDiscoveryWidget> {
  static readonly _itemClass = RestDiscoveryWidget;
}

// Non-public object resolved via auto-discovery — with no auth middleware the
// fail-closed gate must 401 (covers the discovery-path isRoutePublic branch).
@smrt({ api: { include: ['list', 'get'] } })
class RestDiscoveryPrivate extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class RestDiscoveryPrivateCollection extends SmrtCollection<RestDiscoveryPrivate> {
  static readonly _itemClass = RestDiscoveryPrivate;
}

describe('REST generator auto-discovery (#1500)', () => {
  ObjectRegistry.registerCollection(
    'RestDiscoveryWidget',
    RestDiscoveryWidgetCollection,
  );
  ObjectRegistry.registerCollection(
    'RestDiscoveryPrivate',
    RestDiscoveryPrivateCollection,
  );

  let db: any;
  let handler: (req: Request) => Promise<Response>;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['RestDiscoveryWidget', 'RestDiscoveryPrivate'],
    });
    // No api.registerCollection — the generator must resolve the class from the
    // ObjectRegistry by pluralized name and build the collection itself.
    const api = new APIGenerator({ basePath: '/api/v1' }, { db });
    handler = api.generateHandler();
  });

  afterAll(async () => {
    await db?.close?.();
  });

  it('resolves a registered class through the registry fallback (no 404)', async () => {
    // The discovery matcher pluralizes BOTH sides, so the registered simple
    // name `RestDiscoveryWidget` is matched by its singular URL segment. This
    // exercises the whole ObjectRegistry fallback path (class lookup + auth gate
    // + getCollection factory). The generator builds the auto-discovered
    // collection but does not call initialize() on it, so list() surfaces a 500
    // rather than a 200 — the resolution branch is what we assert here (it is
    // NOT a 404 "object type not found").
    const res = await handler(
      new Request('http://local/api/v1/restdiscoverywidget'),
    );
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(500);
  });

  it('returns 404 through the discovery path for an unknown type', async () => {
    const res = await handler(
      new Request('http://local/api/v1/unknowndiscoverywidgets'),
    );
    expect(res.status).toBe(404);
  });

  it('fail-closes a non-public discovered object with no auth middleware', async () => {
    // public is not set → isRoutePublic returns false → 401 on the discovery
    // path (no api.registerCollection, no authMiddleware).
    const api = new APIGenerator({ basePath: '/api/v1' }, { db });
    const h = api.generateHandler();
    const res = await h(
      new Request('http://local/api/v1/restdiscoveryprivate'),
    );
    expect(res.status).toBe(401);
  });

  it('applies auth middleware on the auto-discovery path', async () => {
    // No api.registerCollection → discovery path; the middleware short-circuits
    // with a Response before any collection work, covering lines 271-285.
    const api = new APIGenerator(
      {
        basePath: '/api/v1',
        authMiddleware: () => async () =>
          new Response('denied', { status: 401 }),
      },
      { db },
    );
    const denyHandler = api.generateHandler();
    const res = await denyHandler(
      new Request('http://local/api/v1/restdiscoverywidget'),
    );
    expect(res.status).toBe(401);
  });
});

// Auth-middleware + CORS behavior. Uses a non-public object so the middleware
// is the only thing standing between the request and the handler.
@smrt({ api: { include: ['list', 'get', 'create'] } })
class RestAuthWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class RestAuthWidgetCollection extends SmrtCollection<RestAuthWidget> {
  static readonly _itemClass = RestAuthWidget;
}

// api:false — every action is disabled by isApiActionEnabled (405).
@smrt({ api: false })
class RestApiFalseWidget extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
  }
}

class RestApiFalseWidgetCollection extends SmrtCollection<RestApiFalseWidget> {
  static readonly _itemClass = RestApiFalseWidget;
}

describe('REST generator auth middleware + CORS (#1500/#1540)', () => {
  ObjectRegistry.registerCollection('RestAuthWidget', RestAuthWidgetCollection);
  ObjectRegistry.registerCollection(
    'RestApiFalseWidget',
    RestApiFalseWidgetCollection,
  );

  let db: any;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['RestAuthWidget', 'RestApiFalseWidget'],
    });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  it('rejects the request when auth middleware returns a Response', async () => {
    const collection = await RestAuthWidgetCollection.create({ db });
    const api = new APIGenerator({
      basePath: '/api/v1',
      authMiddleware: () => async () =>
        new Response('forbidden', { status: 403 }),
    });
    api.registerCollection('restauthwidgets', collection);
    const handler = api.generateHandler();

    const res = await handler(
      new Request('http://local/api/v1/restauthwidgets'),
    );
    expect(res.status).toBe(403);
  });

  it('passes through when auth middleware returns the request', async () => {
    const collection = await RestAuthWidgetCollection.create({ db });
    const api = new APIGenerator({
      basePath: '/api/v1',
      authMiddleware: () => async (req) => req,
    });
    api.registerCollection('restauthwidgets', collection);
    const handler = api.generateHandler();

    const res = await handler(
      new Request('http://local/api/v1/restauthwidgets'),
    );
    expect(res.status).toBe(200);
  });

  it('echoes an allowlisted Origin on a CORS preflight and on responses', async () => {
    const collection = await RestAuthWidgetCollection.create({ db });
    const api = new APIGenerator({
      basePath: '/api/v1',
      enableCors: true,
      allowedOrigins: ['https://allowed.example'],
      authMiddleware: () => async (req) => req,
    });
    api.registerCollection('restauthwidgets', collection);
    const handler = api.generateHandler();

    // Preflight from an allowed origin echoes that origin (never `*`).
    const preflight = await handler(
      new Request('http://local/api/v1/restauthwidgets', {
        method: 'OPTIONS',
        headers: { origin: 'https://allowed.example' },
      }),
    );
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      'https://allowed.example',
    );
    expect(preflight.headers.get('vary')).toBe('Origin');

    // Actual GET response also carries the echoed origin.
    const res = await handler(
      new Request('http://local/api/v1/restauthwidgets', {
        headers: { origin: 'https://allowed.example' },
      }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://allowed.example',
    );
  });

  it('omits CORS headers for a non-allowlisted Origin', async () => {
    const collection = await RestAuthWidgetCollection.create({ db });
    const api = new APIGenerator({
      basePath: '/api/v1',
      enableCors: true,
      allowedOrigins: ['https://allowed.example'],
      authMiddleware: () => async (req) => req,
    });
    api.registerCollection('restauthwidgets', collection);
    const handler = api.generateHandler();

    const preflight = await handler(
      new Request('http://local/api/v1/restauthwidgets', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

    const res = await handler(
      new Request('http://local/api/v1/restauthwidgets', {
        headers: { origin: 'https://evil.example' },
      }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('returns 405 for an api:false object that passes auth middleware', async () => {
    // api:false makes isApiActionEnabled() return false → 405, but only once the
    // request is past the auth gate (covers the isApiActionEnabled false branch).
    const collection = await RestApiFalseWidgetCollection.create({ db });
    const api = new APIGenerator({
      basePath: '/api/v1',
      authMiddleware: () => async (req) => req,
    });
    api.registerCollection('restapifalsewidgets', collection);
    const handler = api.generateHandler();

    const res = await handler(
      new Request('http://local/api/v1/restapifalsewidgets'),
    );
    expect(res.status).toBe(405);
  });

  it('treats a non-object JSON create body as empty (no fields set)', async () => {
    const collection = await RestAuthWidgetCollection.create({ db });
    const api = new APIGenerator({
      basePath: '/api/v1',
      authMiddleware: () => async (req) => req,
    });
    api.registerCollection('restauthwidgets', collection);
    const handler = api.generateHandler();

    // A JSON primitive (not an object) → applyWritablePolicy returns {}.
    const res = await handler(
      new Request('http://local/api/v1/restauthwidgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify('just-a-string'),
      }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as any;
    expect(json.name).toBe('');
  });

  it('dispatches a configured custom route', async () => {
    const collection = await RestAuthWidgetCollection.create({ db });
    const api = new APIGenerator({
      basePath: '/api/v1',
      customRoutes: {
        '/ping': async () =>
          new Response(JSON.stringify({ pong: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
    });
    api.registerCollection('restauthwidgets', collection);
    const handler = api.generateHandler();

    const res = await handler(new Request('http://local/api/v1/ping'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { pong: boolean };
    expect(json.pong).toBe(true);
  });
});
