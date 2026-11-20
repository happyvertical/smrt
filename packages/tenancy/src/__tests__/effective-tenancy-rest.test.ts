/**
 * Runtime REST applies the tenancy each model has when the request is
 * served, with the real tenant interceptor on a SQLite file.
 *
 * Rows 2, 3, 5, 7, 10, 13, 14, 30 and 33 of the #5375 test-design contract.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemContext, withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';
import {
  keyOf,
  restCall,
  segmentOf,
  TENANT_A,
  TENANT_B,
  titlesOf,
} from './helpers/effective-tenancy-harness.js';

async function retitle<T extends SmrtObject>(
  collection: SmrtCollection<T>,
  title: string,
) {
  const rows = await collection.list({});
  for (const row of rows) {
    (row as unknown as { title: string }).title = title;
    await row.save();
  }
  return rows.length;
}

@smrt({
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'countAll',
      'tally',
      'touchAll',
      'retitleAll',
    ],
    routes: {
      countAll: { method: 'GET', path: 'count-all' },
      tally: { method: 'GET', path: 'tally' },
      touchAll: { method: 'GET', path: 'touch-all' },
      retitleAll: { method: 'POST', path: 'retitle-all' },
    },
  },
})
class EffRestFlyer extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffRestFlyerCollection extends SmrtCollection<EffRestFlyer> {
  static readonly _itemClass = EffRestFlyer;
  async countAll() {
    return (await this.list({})).length;
  }
  async tally(_options?: unknown) {
    return (await this.list({})).length;
  }
  async touchAll(_options?: unknown) {
    return retitle(this, 'touched');
  }
  async retitleAll(_options?: unknown) {
    return retitle(this, 'retitled');
  }
}

@smrt({
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'countAll',
      'tally',
      'touchAll',
      'retitleAll',
    ],
    routes: {
      countAll: { method: 'GET', path: 'count-all' },
      tally: { method: 'GET', path: 'tally' },
      touchAll: { method: 'GET', path: 'touch-all' },
      retitleAll: { method: 'POST', path: 'retitle-all' },
    },
  },
})
@TenantScoped({ mode: 'optional' })
class EffRestNotice extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId({ nullable: true }) tenantId: string | null = null;
}
class EffRestNoticeCollection extends SmrtCollection<EffRestNotice> {
  static readonly _itemClass = EffRestNotice;
  async countAll() {
    return (await this.list({})).length;
  }
  async tally(_options?: unknown) {
    return (await this.list({})).length;
  }
  async touchAll(_options?: unknown) {
    return retitle(this, 'touched');
  }
  async retitleAll(_options?: unknown) {
    return retitle(this, 'retitled');
  }
}

// An STI base with no tenancy, and a subtype whose tenancy is registered at
// run time.
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
class EffPin extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffPinCollection extends SmrtCollection<EffPin> {
  static readonly _itemClass = EffPin;
}
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class EffOwnedPin extends EffPin {
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}

/** Same-named models of two packages, registered in the order given. */
function defineTwin(
  packageName: string,
  name: 'EffTwin' | 'EffPair' | 'EffFaulty',
) {
  const table = `eff_${name.toLowerCase()}_${packageName.split('/')[1]}`;
  const config = {
    packageName,
    tableName: table,
    collection: table.replace(/_/g, '-'),
    api: { include: ['list', 'get', 'update'] },
  } as never;
  if (name === 'EffTwin') {
    @smrt(config)
    class EffTwin extends SmrtObject {
      @field({ type: 'text' }) title = '';
      @field({ type: 'text', nullable: true }) tenantId: string | null = null;
    }
    return EffTwin;
  }
  if (name === 'EffPair') {
    @smrt(config)
    class EffPair extends SmrtObject {
      @field({ type: 'text' }) title = '';
      @field({ type: 'text', nullable: true }) tenantId: string | null = null;
    }
    return EffPair;
  }
  @smrt(config)
  class EffFaulty extends SmrtObject {
    @field({ type: 'text' }) title = '';
    @field({ type: 'text', nullable: true }) tenantId: string | null = null;
  }
  return EffFaulty;
}
// Scoped package registered first, then the unscoped one; and the reverse.
const TwinScoped = defineTwin('@eff-fixture/left', 'EffTwin');
const TwinOpen = defineTwin('@eff-fixture/right', 'EffTwin');
const PairOpen = defineTwin('@eff-fixture/right', 'EffPair');
const PairScoped = defineTwin('@eff-fixture/left', 'EffPair');
const FaultyLeft = defineTwin('@eff-fixture/left', 'EffFaulty');
const FaultyRight = defineTwin('@eff-fixture/right', 'EffFaulty');

const ROW = {
  ours: 'aaaaaaaa-0000-4000-8000-00000000000a',
  everyone: 'cccccccc-0000-4000-8000-00000000000c',
  theirs: 'bbbbbbbb-0000-4000-8000-00000000000b',
};

interface Session {
  tenantId?: string;
  allowCrossTenant?: boolean;
}
const SESSIONS: Record<string, Session> = {
  'reader-none': {},
  'user-of-a': { tenantId: TENANT_A },
  'user-of-b': { tenantId: TENANT_B },
  operator: { allowCrossTenant: true },
};
const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');
const as = (token?: string) =>
  token ? { headers: { authorization: `Bearer ${token}` } } : {};

function makeHandler(db: DatabaseInterface) {
  return new APIGenerator(
    {
      basePath: '/api',
      // Reads are open; a write needs a session.
      authMiddleware: () => async (req: Request) =>
        req.method === 'GET' || SESSIONS[tokenOf(req)]
          ? req
          : new Response('unauthorized', { status: 401 }),
      resolveTenant: (req: Request) => {
        const session = SESSIONS[tokenOf(req)];
        return session
          ? { ...session, authenticated: true }
          : { authenticated: false };
      },
    },
    { db },
  ).generateHandler();
}

describe('runtime REST applies the tenancy a model has when it is served', () => {
  let dir: string;
  let db: DatabaseInterface;
  let earlyHandler: (req: Request) => Promise<Response>;
  let handler: (req: Request) => Promise<Response>;
  const stores: Record<string, SmrtCollection<SmrtObject>> = {};
  const registered: string[] = [];

  const titles = async (store: SmrtCollection<SmrtObject>) =>
    (
      await db.query(`SELECT title FROM ${store.tableName} ORDER BY title`)
    ).rows.map((row) => String(row.title));
  const register = (key: string, config: Record<string, unknown>) => {
    registerTenantScopedClass(key, config);
    registered.push(key);
  };

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffRestFlyer',
      EffRestFlyerCollection as never,
    );
    ObjectRegistry.registerCollection(
      'EffRestNotice',
      EffRestNoticeCollection as never,
    );
    ObjectRegistry.registerCollection('EffPin', EffPinCollection as never);
    // A loaded manifest records a collection-hosted action's parameters under
    // the collection class, which is registered for them; it says these
    // actions take an options bag.
    for (const host of [EffRestFlyerCollection, EffRestNoticeCollection]) {
      ObjectRegistry.register(host as never, {});
      // Registration introspects the prototype; keep only what a manifest names.
      ObjectRegistry.getMethods(host.name).clear();
      for (const name of ['tally', 'touchAll', 'retitleAll']) {
        ObjectRegistry.getMethods(host.name).set(name, {
          name,
          parameters: [{ name: 'options', type: 'any', optional: true }],
          returnType: 'Promise<any>',
          isPublic: true,
        } as never);
      }
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-rest-'));
    const models = [
      EffRestFlyer,
      EffRestNotice,
      EffPin,
      EffOwnedPin,
      TwinScoped,
      TwinOpen,
      PairOpen,
      PairScoped,
      FaultyLeft,
      FaultyRight,
    ];
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: models.map((model) => keyOf(model)),
    });
    stores.flyer = (await EffRestFlyerCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    stores.notice = (await EffRestNoticeCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    stores.pin = (await EffPinCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    enableTenancy();
    // Generated before any run-time registration.
    earlyHandler = makeHandler(db);
    register(keyOf(EffRestFlyer), { mode: 'optional' });
    register(keyOf(TwinScoped), { mode: 'optional' });
    register(keyOf(PairScoped), { mode: 'optional' });
    handler = makeHandler(db);
  }, 60_000);

  afterAll(async () => {
    for (const key of registered) unregisterTenantScopedClass(key);
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const seedTable = async (table: string, extra = '') => {
    await db.query(`DELETE FROM ${table}`);
    for (const [title, id, owner] of [
      ['ours', ROW.ours, `'${TENANT_A}'`],
      ['everyone', ROW.everyone, 'NULL'],
      ['theirs', ROW.theirs, `'${TENANT_B}'`],
    ]) {
      await db.query(
        `INSERT INTO ${table} (id, slug, context, title, tenant_id${extra ? ', _meta_type' : ''}) VALUES ('${id}', '${title}', '', '${title}', ${owner}${extra ? `, '${extra}'` : ''})`,
      );
    }
  };

  beforeEach(async () => {
    await withSystemContext(async () => {
      await seedTable(stores.flyer.tableName);
      await seedTable(stores.notice.tableName);
      for (const model of [
        TwinScoped,
        TwinOpen,
        PairOpen,
        PairScoped,
        FaultyLeft,
        FaultyRight,
      ]) {
        await seedTable(
          String(ObjectRegistry.getClass(keyOf(model))?.schema?.tableName),
        );
      }
    });
  });

  const flyers = () => segmentOf(EffRestFlyer);
  const notices = () => segmentOf(EffRestNotice);

  describe('collection actions (rows 2, 3)', () => {
    it('a collection read with no scope argument is refused to a caller with no tenant under tenancy registered at run time, in either registration order', async () => {
      for (const serve of [earlyHandler, handler]) {
        expect(
          (await restCall(serve, 'GET', `${flyers()}/count-all`)).status,
        ).toBe(401);
        expect(
          (
            await restCall(
              serve,
              'GET',
              `${flyers()}/count-all`,
              as('reader-none'),
            )
          ).status,
        ).toBe(403);
        const ours = await restCall(
          serve,
          'GET',
          `${flyers()}/count-all`,
          as('user-of-a'),
        );
        expect(ours.status).toBe(200);
        expect((ours.body as { result: unknown }).result).toBe(1);
      }
    });

    it('an action that ignores its options counts only rows without an owner', async () => {
      for (const segment of [flyers(), notices()]) {
        const answer = await restCall(handler, 'GET', `${segment}/tally`);
        expect(answer.status).toBe(200);
        expect((answer.body as { result: unknown }).result).toBe(1);
      }
    });
  });

  describe('writes (rows 10, 13, 14)', () => {
    it('a writer with no tenant changes no row of a tenant-scoped model', async () => {
      for (const [segment, store] of [
        [flyers(), stores.flyer],
        [notices(), stores.notice],
      ] as const) {
        const before = await titles(store);
        for (const id of [ROW.ours, ROW.everyone, ROW.theirs]) {
          expect(
            (
              await restCall(handler, 'PUT', `${segment}/${id}`, {
                ...as('reader-none'),
                body: { title: 'changed' },
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await restCall(
                handler,
                'DELETE',
                `${segment}/${id}`,
                as('reader-none'),
              )
            ).status,
          ).toBe(403);
        }
        expect(
          (
            await restCall(handler, 'POST', segment, {
              ...as('reader-none'),
              body: { title: 'created without a tenant' },
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await restCall(handler, 'POST', `${segment}/retitle-all`, {
              ...as('reader-none'),
              body: {},
            })
          ).status,
        ).toBe(403);
        expect(await titles(store)).toEqual(before);
      }
    });

    it('a cross-tenant read grant cannot write; custom and CRUD reads agree for the operator', async () => {
      const listed = await restCall(handler, 'GET', flyers(), as('operator'));
      expect(titlesOf(listed.body)).toEqual(['everyone', 'ours', 'theirs']);
      const tally = await restCall(
        handler,
        'GET',
        `${flyers()}/tally`,
        as('operator'),
      );
      expect((tally.body as { result: unknown }).result).toBe(3);
      const touched = await restCall(
        handler,
        'GET',
        `${flyers()}/touch-all`,
        as('operator'),
      );
      expect(touched.status).toBe(403);
      expect(await titles(stores.flyer)).toEqual([
        'everyone',
        'ours',
        'theirs',
      ]);
      const written = await restCall(
        handler,
        'POST',
        `${flyers()}/retitle-all`,
        {
          ...as('operator'),
          body: {},
        },
      );
      expect(written.status).toBe(200);
      expect(await titles(stores.flyer)).toEqual([
        'retitled',
        'retitled',
        'retitled',
      ]);
    });

    it('a principal that disagrees with the active tenant is refused', async () => {
      const answer = await withTenant({ tenantId: TENANT_A }, () =>
        restCall(handler, 'GET', flyers(), as('user-of-b')),
      );
      expect(answer.status).toBe(403);
    });
  });

  describe('a subtype registered at run time (row 5)', () => {
    it('a subtype registered at run time changes the base list and its validator', async () => {
      const pins = segmentOf(EffPin);
      const owned = keyOf(EffOwnedPin);
      await withSystemContext(async () => {
        await db.query(`DELETE FROM ${stores.pin.tableName}`);
        await stores.pin.create({
          id: ROW.everyone,
          title: 'base pin',
        } as never);
        await stores.pin.create({
          id: ROW.ours,
          title: 'owned by a',
          tenantId: TENANT_A,
          _meta_type: owned,
        } as never);
        await stores.pin.create({
          id: ROW.theirs,
          title: 'owned by b',
          tenantId: TENANT_B,
          _meta_type: owned,
        } as never);
      });
      const first = await restCall(handler, 'GET', pins, as('user-of-a'));
      expect(titlesOf(first.body)).toEqual([
        'base pin',
        'owned by a',
        'owned by b',
      ]);
      const etag = first.headers.get('etag');
      register(owned, { mode: 'optional' });
      try {
        const next = await restCall(handler, 'GET', pins, {
          headers: {
            authorization: 'Bearer user-of-a',
            'if-none-match': String(etag),
          },
        });
        expect(next.status).toBe(200);
        expect(titlesOf(next.body)).toEqual(['base pin']);
      } finally {
        unregisterTenantScopedClass(owned);
        registered.splice(registered.indexOf(owned), 1);
      }
    });
  });

  describe('a failing tenancy policy (row 7)', () => {
    it('a failing tenancy policy provider refuses reads and writes', async () => {
      // A simple-name registration two packages' models both answer to:
      // looking either one up fails.
      registerTenantScopedClass('EffFaulty', { mode: 'optional' });
      try {
        for (const model of [FaultyLeft, FaultyRight]) {
          const segment = segmentOf(model);
          const table = String(
            ObjectRegistry.getClass(keyOf(model))?.schema?.tableName,
          );
          expect((await restCall(handler, 'GET', segment)).status).toBe(403);
          expect(
            (await restCall(handler, 'GET', segment, as('user-of-a'))).status,
          ).toBe(403);
          expect(
            (
              await restCall(handler, 'PUT', `${segment}/${ROW.ours}`, {
                ...as('user-of-a'),
                body: { title: 'changed' },
              })
            ).status,
          ).toBe(403);
          const stored = (
            await db.query(`SELECT title FROM ${table} ORDER BY title`)
          ).rows.map((row) => row.title);
          expect(stored).toEqual(['everyone', 'ours', 'theirs']);
        }
      } finally {
        unregisterTenantScopedClass('EffFaulty');
      }
    });
  });

  describe('identity (row 30)', () => {
    it('same-named models in two packages resolve to their own tenancy in either registration order', async () => {
      for (const [scoped, open] of [
        [TwinScoped, TwinOpen],
        [PairScoped, PairOpen],
      ]) {
        const scopedList = await restCall(handler, 'GET', segmentOf(scoped));
        expect(titlesOf(scopedList.body)).toEqual(['everyone']);
        const openList = await restCall(handler, 'GET', segmentOf(open));
        expect(titlesOf(openList.body)).toEqual(['everyone', 'ours', 'theirs']);
        const ours = await restCall(
          handler,
          'GET',
          segmentOf(scoped),
          as('user-of-a'),
        );
        expect(titlesOf(ours.body)).toEqual(['ours']);
      }
    });
  });

  describe('the request tenant (row 33)', () => {
    it('a host-entered tenant is the request tenant', async () => {
      const listed = await withTenant({ tenantId: TENANT_A }, () =>
        restCall(handler, 'GET', flyers(), as('reader-none')),
      );
      expect(listed.status).toBe(200);
      expect(titlesOf(listed.body)).toEqual(['ours']);
    });
  });
});
