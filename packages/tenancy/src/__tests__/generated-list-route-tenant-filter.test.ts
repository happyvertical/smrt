/**
 * The emitted SvelteKit list and count route, executed against the real
 * tenant interceptor.
 *
 * Core's generator suites execute the emitted route with a stand-in for
 * tenancy, because core cannot depend on this package. Here the same emitted
 * source runs with the real `@happyvertical/smrt-core`, the real tenancy
 * exports and a real SQLite-backed collection, for a signed-in caller and for
 * an anonymous read of a publicly readable model: whatever spelling of the
 * tenant key the query string carries, the response holds the caller's rows
 * (or the rows without a tenant), or the request is refused.
 *
 * The route is generated into this package's ignored `.smrt/` folder and
 * imported through Vitest, so it shares one core and one tenancy instance with
 * the test. Only the SvelteKit runtime (`@sveltejs/kit`) and the application's
 * own config module (`$lib/server/smrt`) are stand-ins.
 */

import { AsyncResource } from 'node:async_hooks';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { generateSvelteKitRoutes } from '@happyvertical/smrt-core/vite-plugin';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  hasTenantContext,
  TenantIsolationError,
  withSuperAdminBypass,
  withTenant,
} from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';

const OURS = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const THEIRS = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';

// Signed-in model, default `required` mode.
@smrt({ api: { include: ['list'] } })
@TenantScoped()
class EmittedRouteOrder extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @field({ type: 'integer' })
  amount = 0;

  @tenantId({ nullable: true })
  tenantId: string | null = null;
}
class EmittedRouteOrderCollection extends SmrtCollection<EmittedRouteOrder> {
  static readonly _itemClass = EmittedRouteOrder;
}

// Publicly readable model, `optional` mode.
@smrt({ api: { include: ['list'], public: 'read' } })
@TenantScoped({ mode: 'optional' })
class EmittedRouteNotice extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;
}
class EmittedRouteNoticeCollection extends SmrtCollection<EmittedRouteNotice> {
  static readonly _itemClass = EmittedRouteNotice;
}

// Publicly readable, `optional` mode, owned through `organizationId`. Its
// `tenantId` is an ordinary nullable column with no say over ownership.
@smrt({
  api: {
    include: ['list', 'get', 'browse', 'readOrg', 'readTenant'],
    public: 'read',
    // Runtime REST serves these collection GET actions.
    routes: {
      browse: { method: 'GET', path: 'browse' },
      readOrg: { method: 'GET', path: 'readOrg' },
      readTenant: { method: 'GET', path: 'readTenant' },
    },
  },
})
@TenantScoped({ mode: 'optional', field: 'organizationId' })
class EmittedRouteBulletin extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @tenantId({ nullable: true })
  organizationId: string | null = null;

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  /** A custom item GET action: the route loads the row before calling it. */
  async summary() {
    return { title: this.title };
  }

  /** What an item GET action sees of ownership in its options. */
  async ownerSeen(options: Record<string, unknown> = {}) {
    return {
      organizationId:
        'organizationId' in options ? options.organizationId : 'absent',
      tenantId: 'tenantId' in options ? options.tenantId : 'absent',
    };
  }

  /** An item GET action taking the ownership field as a named parameter. */
  async ownerNamed(organizationId?: string | null) {
    return organizationId === undefined ? 'absent' : organizationId;
  }

  /** An item GET action that lists its model with its options as the filter. */
  async peers(options: Record<string, unknown> = {}) {
    const collection = await EmittedRouteBulletinCollection.create({
      db: (this as unknown as { db: never }).db,
    });
    return (await collection.list({ where: options }))
      .map((row) => row.title)
      .sort();
  }
}
class EmittedRouteBulletinCollection extends SmrtCollection<EmittedRouteBulletin> {
  static readonly _itemClass = EmittedRouteBulletin;

  /** A custom GET action taking no options: nothing scopes its reads. */
  async countAll() {
    return (await this.list({})).length;
  }

  /** A custom GET action that reads with its options as the filter. */
  async browse(options: Record<string, unknown> = {}) {
    return (await this.list({ where: options })).map((row) => row.title).sort();
  }

  /** Reads the ownership property directly. */
  async readOrg(options: Record<string, unknown> = {}) {
    return 'organizationId' in options ? options.organizationId : 'absent';
  }

  /** Takes the ownership field as a named parameter. */
  async readOrgNamed(organizationId?: string | null) {
    return organizationId === undefined ? 'absent' : organizationId;
  }

  /** Reads `tenantId` directly, as actions written to the old contract do. */
  async readTenant(options: Record<string, unknown> = {}) {
    return 'tenantId' in options ? options.tenantId : 'absent';
  }
}

// Publicly readable and owned through `organizationId`, but with no tenancy
// in its manifest: optional tenancy is registered at runtime, after the
// routes were generated.
@smrt({
  api: {
    include: ['list', 'get', 'browse', 'readOrg', 'readTenant'],
    public: 'read',
    // Runtime REST serves these collection GET actions.
    routes: {
      browse: { method: 'GET', path: 'browse' },
      readOrg: { method: 'GET', path: 'readOrg' },
      readTenant: { method: 'GET', path: 'readTenant' },
    },
  },
})
class EmittedRouteFlyer extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @field({ type: 'text', nullable: true })
  organizationId: string | null = null;

  async summary() {
    return { title: this.title };
  }

  /** What an item GET action sees of ownership in its options. */
  async ownerSeen(options: Record<string, unknown> = {}) {
    return {
      organizationId:
        'organizationId' in options ? options.organizationId : 'absent',
      tenantId: 'tenantId' in options ? options.tenantId : 'absent',
    };
  }

  /** An item GET action taking the ownership field as a named parameter. */
  async ownerNamed(organizationId?: string | null) {
    return organizationId === undefined ? 'absent' : organizationId;
  }

  /** An item GET action that lists its model with its options as the filter. */
  async peers(options: Record<string, unknown> = {}) {
    const collection = await EmittedRouteFlyerCollection.create({
      db: (this as unknown as { db: never }).db,
    });
    return (await collection.list({ where: options }))
      .map((row) => row.title)
      .sort();
  }
}
class EmittedRouteFlyerCollection extends SmrtCollection<EmittedRouteFlyer> {
  static readonly _itemClass = EmittedRouteFlyer;

  async browse(options: Record<string, unknown> = {}) {
    return (await this.list({ where: options })).map((row) => row.title).sort();
  }

  /** Reads the ownership property directly. */
  async readOrg(options: Record<string, unknown> = {}) {
    return 'organizationId' in options ? options.organizationId : 'absent';
  }

  /** Takes the ownership field as a named parameter. */
  async readOrgNamed(organizationId?: string | null) {
    return organizationId === undefined ? 'absent' : organizationId;
  }

  /** Reads `tenantId` directly, as actions written to the old contract do. */
  async readTenant(options: Record<string, unknown> = {}) {
    return 'tenantId' in options ? options.tenantId : 'absent';
  }
}

type ItemRoute = {
  GET: (event: {
    locals: unknown;
    params: { id: string };
    request: Request;
  }) => Promise<Response>;
};

type ListRoute = {
  GET: (event: {
    locals: unknown;
    request: Request;
    url: URL;
  }) => Promise<Response>;
};

const projectRoot = join(
  import.meta.dirname,
  '../../.smrt/generated-list-route-tenant-filter',
);
const enc = encodeURIComponent;

describe('emitted SvelteKit list route with the real tenant interceptor', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let orderRoute: ListRoute;
  let noticeRoute: ListRoute;
  let bulletinRoute: ListRoute;
  let bulletinItemRoute: ItemRoute;
  let bulletinRest: (req: Request) => Promise<Response>;
  const bulletinIds: Record<string, string> = {};
  const flyerIds: Record<string, string> = {};
  let flyerName = '';
  /** Route modules by path below `src/routes/api/`. */
  const routes = new Map<string, Record<string, unknown>>();
  const collections = new Map<string, unknown>();

  /** Manifest entry for a registered fixture class, as the scanner emits it. */
  const manifestEntry = (
    name: string,
    collection: string,
    decoratorConfig: Record<string, unknown>,
  ) => {
    const info = ObjectRegistry.getClass(name);
    if (!info) throw new Error(`${name} is not registered`);
    return {
      name: name.toLowerCase(),
      className: name,
      qualifiedName: info.qualifiedName,
      collection,
      filePath: join(projectRoot, `src/lib/objects/${name}.ts`),
      fields: Object.fromEntries(info.fields),
      methods: {},
      decoratorConfig,
    };
  };

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EmittedRouteOrder',
      EmittedRouteOrderCollection,
    );
    ObjectRegistry.registerCollection(
      'EmittedRouteNotice',
      EmittedRouteNoticeCollection,
    );
    ObjectRegistry.registerCollection(
      'EmittedRouteBulletin',
      EmittedRouteBulletinCollection,
    );
    ObjectRegistry.registerCollection(
      'EmittedRouteFlyer',
      EmittedRouteFlyerCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'EmittedRouteOrder',
        'EmittedRouteNotice',
        'EmittedRouteBulletin',
        'EmittedRouteFlyer',
      ],
    });
    const orders = await EmittedRouteOrderCollection.create({ db });
    const notices = await EmittedRouteNoticeCollection.create({ db });
    const bulletins = await EmittedRouteBulletinCollection.create({ db });
    const flyers = await EmittedRouteFlyerCollection.create({ db });
    // Written before any tenancy is registered for the model, owner explicit.
    flyerIds.ours = (
      await flyers.create({ title: 'our flyer', organizationId: OURS })
    ).id as string;
    flyerIds.everyone = (await flyers.create({ title: 'flyer for everyone' }))
      .id as string;
    flyerIds.theirs = (
      await flyers.create({ title: 'their flyer', organizationId: THEIRS })
    ).id as string;

    enableTenancy();
    await withTenant({ tenantId: OURS }, async () => {
      await orders.create({ title: 'our order 1', amount: 1 });
      await orders.create({ title: 'our order 2', amount: 5 });
      await notices.create({ title: 'our notice' });
      // Owned by our organization; its ordinary `tenantId` column stays unset.
      bulletinIds.ours = (await bulletins.create({ title: 'our bulletin' }))
        .id as string;
    });
    await withTenant({ tenantId: THEIRS }, async () => {
      await orders.create({ title: 'their order 1', amount: 1 });
      await orders.create({ title: 'their order 2', amount: 5 });
      await notices.create({ title: 'their notice' });
      await bulletins.create({ title: 'their bulletin' });
    });
    await notices.create({ title: 'notice for everyone' });
    bulletinIds.everyone = (
      await bulletins.create({ title: 'bulletin for everyone' })
    ).id as string;
    // Owned by no organization; the unrelated `tenantId` column holds a value.
    bulletinIds.labelled = (
      await bulletins.create({
        title: 'bulletin for everyone, labelled',
        tenantId: THEIRS,
      })
    ).id as string;

    const order = manifestEntry('EmittedRouteOrder', 'emittedrouteorders', {
      api: { include: ['list'] },
      tenantScoped: { mode: 'required' },
    });
    const notice = manifestEntry('EmittedRouteNotice', 'emittedroutenotices', {
      api: { include: ['list'], public: 'read' },
      tenantScoped: { mode: 'optional' },
    });
    /** Manifest entries for a public model with a custom item and collection GET action. */
    const optionsMethod = (methodName: string, parameter = 'options') => ({
      name: methodName,
      parameters: [{ name: parameter, type: 'any' }],
      returnType: 'Promise<any>',
      isPublic: true,
    });
    const withActions = (
      name: string,
      collection: string,
      tenantScoped?: Record<string, unknown>,
      extraApi: Record<string, unknown> = {},
    ) => {
      const model = manifestEntry(name, collection, {
        api: {
          include: [
            'list',
            'get',
            'summary',
            'ownerSeen',
            'ownerNamed',
            'peers',
          ],
          public: 'read',
          routes: {
            summary: { method: 'GET', path: 'summary' },
            ownerSeen: { method: 'GET', path: 'owner-seen' },
            ownerNamed: { method: 'GET', path: 'owner-named' },
            peers: { method: 'GET', path: 'peers' },
          },
          ...extraApi,
        },
        ...(tenantScoped ? { tenantScoped } : {}),
      });
      model.methods = {
        summary: {
          name: 'summary',
          parameters: [],
          returnType: 'Promise<any>',
          isPublic: true,
        },
        ownerSeen: optionsMethod('ownerSeen'),
        ownerNamed: optionsMethod('ownerNamed', 'organizationId'),
        peers: optionsMethod('peers'),
      } as never;
      const collectionEntry = {
        name: `${name.toLowerCase()}collection`,
        className: `${name}Collection`,
        qualifiedName: `${model.qualifiedName}Collection`,
        collection,
        filePath: join(projectRoot, `src/lib/objects/${name}.ts`),
        fields: {},
        methods: {
          browse: optionsMethod('browse'),
          readOrg: optionsMethod('readOrg'),
          readTenant: optionsMethod('readTenant'),
          readOrgNamed: optionsMethod('readOrgNamed', 'organizationId'),
          countAll: {
            name: 'countAll',
            parameters: [],
            returnType: 'Promise<any>',
            isPublic: true,
          },
        },
        decoratorConfig: {
          api: {
            public: 'read',
            include: [
              'browse',
              'readOrg',
              'readTenant',
              'readOrgNamed',
              'countAll',
            ],
            routes: {
              countAll: { method: 'GET', path: 'count-all' },
              readOrgNamed: { method: 'GET', path: 'read-org-named' },
              browse: { method: 'GET', path: 'browse' },
              readOrg: { method: 'GET', path: 'read-org' },
              readTenant: { method: 'GET', path: 'read-tenant' },
            },
          },
        },
        extends: 'SmrtCollection',
        extendsTypeArg: name,
      };
      return [model, collectionEntry] as const;
    };
    const [bulletin, bulletinCollection] = withActions(
      'EmittedRouteBulletin',
      'emittedroutebulletins',
      { mode: 'optional', field: 'organizationId' },
    );
    // The flyer opts into shared caching at build time; once its tenancy is
    // registered at runtime its reads must be private all the same.
    const [flyer, flyerCollection] = withActions(
      'EmittedRouteFlyer',
      'emittedrouteflyers',
      undefined,
      { cache: { sMaxage: 60 } },
    );
    flyerName = String(flyer.qualifiedName);
    for (const [entry, instance] of [
      [order, orders],
      [notice, notices],
      [bulletin, bulletins],
      [bulletinCollection, bulletins],
      [flyer, flyers],
      [flyerCollection, flyers],
    ] as const) {
      collections.set(String(entry.qualifiedName), instance);
      collections.set(String(entry.className), instance);
    }

    rmSync(projectRoot, { recursive: true, force: true });
    mkdirSync(projectRoot, { recursive: true });
    await generateSvelteKitRoutes(
      projectRoot,
      {
        version: '1',
        timestamp: 0,
        packageName: '@happyvertical/smrt-tenancy',
        objects: {
          [String(order.qualifiedName)]: order,
          [String(notice.qualifiedName)]: notice,
          [String(bulletin.qualifiedName)]: bulletin,
          [String(bulletinCollection.qualifiedName)]: bulletinCollection,
          [String(flyer.qualifiedName)]: flyer,
          [String(flyerCollection.qualifiedName)]: flyerCollection,
        },
      } as never,
      {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      },
    );

    // The SvelteKit runtime: `error()` throws an object carrying the status.
    vi.doMock('@sveltejs/kit', () => ({
      error: (status: number, message: string) => {
        throw Object.assign(new Error(message), { status });
      },
      json: (body: unknown, init: ResponseInit = {}) =>
        new Response(JSON.stringify(body), init),
    }));
    // The application's config module: hands the route its real collections
    // through `runtime`. The two legacy accessors are declared and unset, as
    // in an application that exports only `runtime`.
    vi.doMock('$lib/server/smrt', () => ({
      getCollection: undefined,
      getSmrtConfig: undefined,
      runtime: {
        getCollection: async (name: string) => {
          const collection = collections.get(name);
          if (!collection) throw new Error(`No collection for ${name}`);
          return collection;
        },
        classOptions: () => ({}),
      },
    }));
    vi.doMock('$lib/server/smrt-register', () => ({}));
    // The emitted route imports the package by name; give it this source tree
    // so the route and the test share one tenant context and one interceptor.
    vi.doMock('@happyvertical/smrt-tenancy', () => import('../index.js'));

    const load = async (collection: string): Promise<ListRoute> =>
      (await import(
        /* @vite-ignore */ pathToFileURL(
          join(projectRoot, `src/routes/api/${collection}/+server.ts`),
        ).href
      )) as ListRoute;
    orderRoute = await load('emittedrouteorders');
    noticeRoute = await load('emittedroutenotices');
    bulletinRoute = await load('emittedroutebulletins');
    bulletinItemRoute = (await import(
      /* @vite-ignore */ pathToFileURL(
        join(
          projectRoot,
          'src/routes/api/emittedroutebulletins/[id]/+server.ts',
        ),
      ).href
    )) as ItemRoute;

    for (const path of [
      'emittedroutebulletins/browse',
      'emittedroutebulletins/count-all',
      'emittedroutebulletins/read-org',
      'emittedroutebulletins/read-tenant',
      'emittedroutebulletins/read-org-named',
      'emittedroutebulletins/[id]/owner-named',
      'emittedroutebulletins/[id]/summary',
      'emittedroutebulletins/[id]/owner-seen',
      'emittedroutebulletins/[id]/peers',
      'emittedrouteflyers',
      'emittedrouteflyers/[id]',
      'emittedrouteflyers/browse',
      'emittedrouteflyers/read-org',
      'emittedrouteflyers/read-tenant',
      'emittedrouteflyers/read-org-named',
      'emittedrouteflyers/[id]/owner-named',
      'emittedrouteflyers/[id]/summary',
      'emittedrouteflyers/[id]/owner-seen',
      'emittedrouteflyers/[id]/peers',
    ]) {
      routes.set(
        path,
        (await import(
          /* @vite-ignore */ pathToFileURL(
            join(projectRoot, `src/routes/api/${path}/+server.ts`),
          ).href
        )) as Record<string, unknown>,
      );
    }

    // The runtime REST transport over the same collection, anonymous.
    const rest = new APIGenerator({ basePath: '/api' }, { db });
    rest.registerCollection('bulletins', bulletins as never);
    rest.registerCollection('flyers', flyers as never);
    bulletinRest = rest.generateHandler();
  }, 60_000);

  afterAll(async () => {
    vi.doUnmock('@sveltejs/kit');
    vi.doUnmock('$lib/server/smrt');
    vi.doUnmock('$lib/server/smrt-register');
    vi.doUnmock('@happyvertical/smrt-tenancy');
    if (flyerName) unregisterTenantScopedClass(flyerName);
    disableTenancy();
    await db?.close?.();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /**
   * Run one request in its own async scope. The emitted route enters the
   * tenant context for the rest of its execution, as a SvelteKit request does;
   * the scope keeps that from reaching the next request or the test.
   */
  const request = (
    route: ListRoute,
    path: string,
    locals: Record<string, unknown>,
  ): Promise<Response> =>
    new AsyncResource('emitted-route-request').runInAsyncScope(() => {
      const url = new URL(`http://localhost/api/${path}`);
      return route.GET({ locals, request: new Request(url), url });
    });
  const signedIn = { tenantId: OURS, user: { id: 'reader' } };
  const asUs = (query = '') =>
    request(orderRoute, `emittedrouteorders${query}`, signedIn);
  const anonymous = (query = '') =>
    request(noticeRoute, `emittedroutenotices${query}`, {});
  const titlesOf = async (response: Response) => {
    const body = (await response.json()) as {
      items: Array<{ title: string }>;
      count: number;
    };
    return { titles: body.items.map((item) => item.title).sort(), body };
  };

  it('a request does not leave its tenant context behind', async () => {
    expect((await asUs()).status).toBe(200);
    expect(hasTenantContext()).toBe(false);
  });

  describe('signed-in caller', () => {
    it('lists and counts only the caller tenant', async () => {
      const { titles, body } = await titlesOf(await asUs());
      expect(titles).toEqual(['our order 1', 'our order 2']);
      expect(body.count).toBe(2);
    });

    it.each([
      `?tenantId=${OURS}&tenant_id=${THEIRS}`,
      `?tenant_id=${THEIRS}&tenantId=${OURS}`,
      `?tenantId=${OURS}&TenantId=${THEIRS}`,
      `?TenantId=${THEIRS}&tenantId=${OURS}`,
      `?tenantId=${OURS}&${enc('tenant_id =')}=${THEIRS}`,
      `?tenantId=${OURS}&${enc('tenant_id[=]')}=${THEIRS}`,
      `?tenant_id=${OURS}&tenantId=${THEIRS}`,
      `?tenant_id=${THEIRS}`,
      `?TenantId=${THEIRS}`,
      `?${enc('tenant_id[=]')}=${THEIRS}`,
    ])('refuses %s', async (query) => {
      // A filter outside the caller's tenant is a permission denial that
      // names neither tenant.
      const refusal = await asUs(query).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({
        status: 403,
        message: 'Permission denied.',
      });
    });

    it('refuses a required-mode read by a caller with no tenant with a 403', async () => {
      const refusal = await request(orderRoute, 'emittedrouteorders', {
        user: { id: 'reader' },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refusal).toMatchObject({ status: 403 });
    });

    it('answers 400 when two spellings both name the caller tenant', async () => {
      await expect(
        asUs(`?tenantId=${OURS}&tenant_id=${OURS}`),
      ).rejects.toMatchObject({ status: 400 });
    });

    it.each([
      'tenantId',
      'tenant_id',
      'TenantId',
    ])('serves an explicit own-tenant filter written as %s', async (key) => {
      const { titles, body } = await titlesOf(await asUs(`?${key}=${OURS}`));
      expect(titles).toEqual(['our order 1', 'our order 2']);
      expect(body.count).toBe(2);
    });

    it('serves a range on one column and keeps the tenant predicate beside operator filters', async () => {
      const ranged = await titlesOf(
        await asUs(`?${enc('amount[gte]')}=1&${enc('amount[lt]')}=5`),
      );
      expect(ranged.titles).toEqual(['our order 1']);
      expect(ranged.body.count).toBe(1);

      const narrowed = await titlesOf(
        await asUs(`?${enc('tenant_id[in]')}=${THEIRS}`),
      );
      expect(narrowed.titles).toEqual([]);
      expect(narrowed.body.count).toBe(0);
    });
  });

  describe('anonymous read of a publicly readable model', () => {
    it.each([
      '',
      `?tenantId=x&tenant_id=${THEIRS}`,
      `?tenant_id=${THEIRS}&tenantId=x`,
      `?TenantId=${THEIRS}`,
      `?${enc(' tenant_id')}=${THEIRS}`,
      `?${enc('tenant_id =')}=${THEIRS}`,
      `?${enc('tenant_id[=]')}=${THEIRS}`,
      `?${enc('tenant_id[ne]')}=x`,
      `?${enc('TenantId[in]')}=${THEIRS},${OURS}`,
    ])('serves only rows without a tenant for %j', async (query) => {
      const { titles, body } = await titlesOf(await anonymous(query));
      expect(titles).toEqual(['notice for everyone']);
      expect(body.count).toBe(1);
    });

    it('a signed-in caller of the same route sees its tenant and nothing else', async () => {
      const response = await request(
        noticeRoute,
        `emittedroutenotices?tenant_id=${OURS}`,
        signedIn,
      );
      const { titles } = await titlesOf(response);
      expect(titles).toEqual(['our notice']);
      await expect(
        request(
          noticeRoute,
          `emittedroutenotices?tenantId=${OURS}&tenant_id=${THEIRS}`,
          signedIn,
        ),
      ).rejects.toMatchObject({ status: 403, message: 'Permission denied.' });
    });
  });

  describe('anonymous read of a model owned through another field', () => {
    const everyone = [
      'bulletin for everyone',
      'bulletin for everyone, labelled',
    ];
    const itemGet = (id: string) =>
      new AsyncResource('emitted-route-request').runInAsyncScope(() =>
        bulletinItemRoute.GET({
          locals: {},
          params: { id },
          request: new Request(
            `http://localhost/api/emittedroutebulletins/${id}`,
          ),
        }),
      );
    const status = (read: () => Promise<Response>) =>
      read().then(
        (response) => response.status,
        (error: { status?: number }) => error.status,
      );

    it.each([
      '',
      `?tenantId=${THEIRS}`,
      `?organization_id=${OURS}`,
      `?${enc('organizationId[ne]')}=x`,
    ])('the emitted list route serves only rows without an owner for %j', async (query) => {
      const { titles, body } = await titlesOf(
        await request(bulletinRoute, `emittedroutebulletins${query}`, {}),
      );
      // `?tenantId=` filters the ordinary column and may narrow.
      const expected = query.startsWith('?tenantId=')
        ? ['bulletin for everyone, labelled']
        : everyone;
      expect(titles).toEqual(expected);
      expect(body.count).toBe(expected.length);
    });

    it('the emitted item route reads only rows without an owner', async () => {
      expect(await status(() => itemGet(bulletinIds.everyone))).toBe(200);
      expect(await status(() => itemGet(bulletinIds.labelled))).toBe(200);
      expect(await status(() => itemGet(bulletinIds.ours))).toBe(404);
    });

    it.each([
      '',
      `?tenantId=${THEIRS}`,
      `?organization_id=${OURS}`,
      `?${enc('organizationId[ne]')}=x`,
    ])('runtime REST lists and counts only rows without an owner for %j', async (query) => {
      const list = await bulletinRest(
        new Request(`http://local/api/bulletins${query}`),
      );
      expect(list.status).toBe(200);
      const rows = (await list.json()) as
        | Array<{ title: string }>
        | { items: Array<{ title: string }> };
      const items = Array.isArray(rows) ? rows : rows.items;
      const expected = query.startsWith('?tenantId=')
        ? ['bulletin for everyone, labelled']
        : everyone;
      expect(items.map((row) => row.title).sort()).toEqual(expected);
      const count = await bulletinRest(
        new Request(`http://local/api/bulletins/count${query}`),
      );
      expect(await count.json()).toEqual({ count: expected.length });
    });

    it('runtime REST reads only rows without an owner by id', async () => {
      const read = (id: string) =>
        bulletinRest(new Request(`http://local/api/bulletins/${id}`));
      expect((await read(bulletinIds.everyone)).status).toBe(200);
      expect((await read(bulletinIds.labelled)).status).toBe(200);
      expect((await read(bulletinIds.ours)).status).toBe(404);
    });
  });

  describe('custom GET actions and tenancy registered at runtime', () => {
    type Handler = (event: {
      locals: unknown;
      params: Record<string, string>;
      request: Request;
      url: URL;
    }) => Promise<Response>;
    /** Call a generated route (anonymously by default), in its own async scope. */
    const call = (
      path: string,
      params: Record<string, string> = {},
      query = '',
      init: { locals?: Record<string, unknown>; headers?: HeadersInit } = {},
    ) =>
      new AsyncResource('emitted-route-request').runInAsyncScope(async () => {
        const url = new URL(
          `http://localhost/api/${Object.entries(params).reduce(
            (out, [key, value]) => out.replace(`[${key}]`, value),
            path,
          )}${query}`,
        );
        const handler = routes.get(path)?.GET as Handler | undefined;
        if (!handler) throw new Error(`No GET route for ${path}`);
        try {
          return await handler({
            locals: init.locals ?? {},
            params,
            request: new Request(url, { headers: init.headers }),
            url,
          });
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (typeof status === 'number') return new Response(null, { status });
          throw error;
        }
      });
    const actionResult = async (response: Response) => {
      expect(response.status).toBe(200);
      return ((await response.json()) as { result: unknown }).result;
    };

    it('a collection GET action receives the ownership field as its scope', async () => {
      // `browse` lists with its options as the filter: the scope must name
      // `organizationId`, not the ordinary `tenantId` column.
      expect(
        await actionResult(
          await call('emittedroutebulletins/browse', {}, '', {
            locals: { tenantId: OURS, user: { id: 'reader' } },
          }),
        ),
      ).toEqual(['our bulletin']);
    });

    it('a collection GET action taking no options is refused to a caller with no tenant', async () => {
      expect((await call('emittedroutebulletins/count-all')).status).toBe(401);
    });

    it('a collection GET action taking options reads rows without an owner for a caller with no tenant', async () => {
      expect(
        await actionResult(await call('emittedroutebulletins/browse')),
      ).toEqual(['bulletin for everyone', 'bulletin for everyone, labelled']);
    });

    it('an item GET action loads only rows without an owner', async () => {
      const summary = 'emittedroutebulletins/[id]/summary';
      expect((await call(summary, { id: bulletinIds.everyone })).status).toBe(
        200,
      );
      expect((await call(summary, { id: bulletinIds.labelled })).status).toBe(
        200,
      );
      expect((await call(summary, { id: bulletinIds.ours })).status).toBe(404);
    });

    describe('ownership registered after the routes were generated', () => {
      beforeAll(() => {
        registerTenantScopedClass(flyerName, {
          mode: 'optional',
          field: 'organizationId',
          allowSuperAdminBypass: true,
        });
      });

      it('list and count serve only rows without an owner', async () => {
        const response = await call('emittedrouteflyers');
        const { titles, body } = await titlesOf(response);
        expect(titles).toEqual(['flyer for everyone']);
        expect(body.count).toBe(1);
        // A caller filter on the ownership column cannot widen the scope.
        const filtered = await titlesOf(
          await call('emittedrouteflyers', {}, `?organization_id=${OURS}`),
        );
        expect(filtered.titles).toEqual(['flyer for everyone']);
      });

      it('the item route reads only rows without an owner', async () => {
        expect(
          (await call('emittedrouteflyers/[id]', { id: flyerIds.everyone }))
            .status,
        ).toBe(200);
        expect(
          (await call('emittedrouteflyers/[id]', { id: flyerIds.ours })).status,
        ).toBe(404);
      });

      it('custom GET actions are scoped by the registered ownership field', async () => {
        expect(
          await actionResult(await call('emittedrouteflyers/browse')),
        ).toEqual(['flyer for everyone']);
        const summary = 'emittedrouteflyers/[id]/summary';
        expect((await call(summary, { id: flyerIds.everyone })).status).toBe(
          200,
        );
        expect((await call(summary, { id: flyerIds.ours })).status).toBe(404);
      });

      const signedInAs = (tenant: string) => ({
        locals: { tenantId: tenant, user: { id: `reader-${tenant}` } },
      });

      it('a signed-in caller reads its own tenant, from the locals alone', async () => {
        const own = await titlesOf(
          await call('emittedrouteflyers', {}, '', signedInAs(OURS)),
        );
        expect(own.titles).toEqual(['our flyer']);
        expect(own.body.count).toBe(1);
        const filtered = await titlesOf(
          await call(
            'emittedrouteflyers',
            {},
            `?organizationId=${OURS}`,
            signedInAs(OURS),
          ),
        );
        expect(filtered.titles).toEqual(['our flyer']);
      });

      it('a super-admin bypass reaches custom GET actions unnarrowed', async () => {
        const asSuperAdmin = <T>(read: () => Promise<T>) =>
          withTenant({ tenantId: OURS, userId: 'admin' }, () =>
            withSuperAdminBypass(read),
          );
        expect(
          await actionResult(
            await asSuperAdmin(() => call('emittedrouteflyers/browse')),
          ),
        ).toEqual(['flyer for everyone', 'our flyer', 'their flyer']);
        expect(
          await actionResult(
            await asSuperAdmin(() =>
              call(
                'emittedrouteflyers/read-org',
                {},
                `?organizationId=${THEIRS}`,
              ),
            ),
          ),
        ).toBe(THEIRS);
      });

      it('a super-admin bypass leaves options scoped on a model that has not opted in', async () => {
        // The bulletin's tenancy does not allow a super-admin bypass, so the
        // action still receives the caller's own tenant, as the interceptor
        // would scope its reads.
        const asSuperAdmin = <T>(read: () => Promise<T>) =>
          withTenant({ tenantId: OURS, userId: 'admin' }, () =>
            withSuperAdminBypass(read),
          );
        expect(
          await actionResult(
            await asSuperAdmin(() =>
              call(
                'emittedroutebulletins/read-org',
                {},
                `?organizationId=${THEIRS}`,
              ),
            ),
          ),
        ).toBe(OURS);
        // Runtime REST goes through the same helper.
        expect(
          await actionResult(
            await asSuperAdmin(() =>
              bulletinRest(
                new Request(
                  `http://local/api/bulletins/readOrg?organizationId=${THEIRS}`,
                ),
              ),
            ),
          ),
        ).toBe(OURS);
      });

      it('a cached list is never reused across a tenant switch or a sign-out', async () => {
        const ours = await call('emittedrouteflyers', {}, '', signedInAs(OURS));
        expect((await titlesOf(ours)).titles).toEqual(['our flyer']);
        const etag = ours.headers.get('etag');
        expect(etag).toBeTruthy();
        // Shared caching was requested at build time; the model is tenant-
        // scoped now, so its reads are private.
        expect(ours.headers.get('cache-control')).toMatch(/private/);
        expect(ours.headers.get('cache-control')).not.toMatch(/s-maxage/);

        const theirs = await call('emittedrouteflyers', {}, '', {
          ...signedInAs(THEIRS),
          headers: { 'if-none-match': String(etag) },
        });
        expect(theirs.status).toBe(200);
        expect((await titlesOf(theirs)).titles).toEqual(['their flyer']);

        const signedOut = await call('emittedrouteflyers', {}, '', {
          headers: { 'if-none-match': String(etag) },
        });
        expect(signedOut.status).toBe(200);
        expect((await titlesOf(signedOut)).titles).toEqual([
          'flyer for everyone',
        ]);
        expect(signedOut.headers.get('cache-control')).toMatch(/private/);
      });

      describe.each([
        {
          model: 'emittedroutebulletins',
          rest: 'bulletins',
          globalId: () => bulletinIds.everyone,
          globals: ['bulletin for everyone', 'bulletin for everyone, labelled'],
        },
        {
          model: 'emittedrouteflyers',
          rest: 'flyers',
          globalId: () => flyerIds.everyone,
          globals: ['flyer for everyone'],
        },
      ])('custom GET action options of $model never take ownership from the caller', ({
        model,
        rest,
        globalId,
        globals,
      }) => {
        const restAction = async (path: string) => {
          const response = await bulletinRest(
            new Request(`http://local/api/${rest}/${path}`),
          );
          return actionResult(response);
        };

        it('a collection action reading the ownership property gets the scope', async () => {
          for (const query of [
            `?organizationId=${THEIRS}`,
            `?organization_id=${THEIRS}`,
          ]) {
            expect(
              await actionResult(await call(`${model}/read-org`, {}, query)),
            ).toBeNull();
            expect(await restAction(`readOrg${query}`)).toBeNull();
          }
        });

        it('a collection action reading tenantId gets nothing from the caller', async () => {
          expect(
            await actionResult(
              await call(`${model}/read-tenant`, {}, `?tenantId=${THEIRS}`),
            ),
          ).toBe('absent');
          expect(await restAction(`readTenant?tenantId=${THEIRS}`)).toBe(
            'absent',
          );
        });

        it('a collection action forwarding its options lists rows without an owner', async () => {
          expect(
            await actionResult(
              await call(`${model}/browse`, {}, `?organizationId=${THEIRS}`),
            ),
          ).toEqual(globals);
          expect(await restAction(`browse?organizationId=${THEIRS}`)).toEqual(
            globals,
          );
        });

        it('a named ownership parameter gets the scope, not the caller, on collection and item actions', async () => {
          expect(
            await actionResult(
              await call(
                `${model}/read-org-named`,
                {},
                `?organizationId=${THEIRS}`,
              ),
            ),
          ).toBeNull();
          expect(
            await actionResult(
              await call(
                `${model}/[id]/owner-named`,
                { id: globalId() },
                `?organizationId=${THEIRS}`,
              ),
            ),
          ).toBeNull();
        });

        it('an item action sees the scope, not the caller, in its options', async () => {
          expect(
            await actionResult(
              await call(
                `${model}/[id]/owner-seen`,
                { id: globalId() },
                `?organizationId=${THEIRS}&tenantId=${THEIRS}`,
              ),
            ),
          ).toEqual({ organizationId: null, tenantId: 'absent' });
          expect(
            await actionResult(
              await call(
                `${model}/[id]/peers`,
                { id: globalId() },
                `?organizationId=${THEIRS}`,
              ),
            ),
          ).toEqual(globals);
        });
      });
    });
  });
});
