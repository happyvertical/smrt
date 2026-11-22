/**
 * Emitted SvelteKit routes apply the tenancy each model has when the request
 * is served, whether it was declared in the manifest or registered at run
 * time, with the real tenant interceptor on a SQLite file.
 *
 * Rows 1, 3, 4, 8, 10-12, 15, 16, 32 and 33 of the #5375 test-design
 * contract.
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
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  withSuperAdminBypass,
  withSystemContext,
  withTenant,
} from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';
import {
  collectionEntryFor,
  type EmittedApp,
  emitApp,
  keyOf,
  segmentOf,
  TENANT_A,
  TENANT_B,
  titlesOf,
} from './helpers/effective-tenancy-harness.js';

/** Collection actions shared by the fixtures. */
function actionsOf<T extends SmrtObject>(collection: SmrtCollection<T>) {
  return {
    /** Takes no scope argument. */
    countAll: async () => (await collection.list({})).length,
    /** Takes options and ignores them. */
    tally: async (_options?: unknown) => (await collection.list({})).length,
    /** Writes every row it can read. */
    retitleAll: async (_options?: unknown) => {
      const rows = await collection.list({});
      for (const row of rows) {
        (row as unknown as { title: string }).title = 'retitled';
        await row.save();
      }
      return rows.length;
    },
  };
}

// Tenancy registered at run time on `organizationId`; `tenantId` is an
// ordinary column.
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
      'retitleAll',
    ],
    public: 'read',
    routes: {
      countAll: { method: 'GET', path: 'count-all' },
      tally: { method: 'GET', path: 'tally' },
      retitleAll: { method: 'POST', path: 'retitle-all' },
    },
  },
})
class EffFlyer extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) organizationId: string | null = null;
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffFlyerCollection extends SmrtCollection<EffFlyer> {
  static readonly _itemClass = EffFlyer;
  countAll() {
    return actionsOf(this).countAll();
  }
  tally(options?: unknown) {
    return actionsOf(this).tally(options);
  }
  retitleAll(options?: unknown) {
    return actionsOf(this).retitleAll(options);
  }
}

// Tenancy declared on the model.
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
      'retitleAll',
    ],
    public: 'read',
    routes: {
      countAll: { method: 'GET', path: 'count-all' },
      tally: { method: 'GET', path: 'tally' },
      retitleAll: { method: 'POST', path: 'retitle-all' },
    },
  },
})
@TenantScoped({ mode: 'optional' })
class EffNotice extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId({ nullable: true }) tenantId: string | null = null;
}
class EffNoticeCollection extends SmrtCollection<EffNotice> {
  static readonly _itemClass = EffNotice;
  countAll() {
    return actionsOf(this).countAll();
  }
  tally(options?: unknown) {
    return actionsOf(this).tally(options);
  }
  retitleAll(options?: unknown) {
    return actionsOf(this).retitleAll(options);
  }
}

// Required-mode tenancy registered at run time.
@smrt({ api: { include: ['list', 'get', 'update'], public: 'read' } })
class EffLedger extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffLedgerCollection extends SmrtCollection<EffLedger> {
  static readonly _itemClass = EffLedger;
}

// Tenancy registered in the middle of the suite.
@smrt({ api: { include: ['list', 'get'], public: 'read' } })
class EffPoster extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffPosterCollection extends SmrtCollection<EffPoster> {
  static readonly _itemClass = EffPoster;
}

// Run-time tenancy that opts into the super-admin bypass.
@smrt({ api: { include: ['list', 'get', 'update'], public: 'read' } })
class EffBoard extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffBoardCollection extends SmrtCollection<EffBoard> {
  static readonly _itemClass = EffBoard;
}

const ROW = {
  ours: 'aaaaaaaa-0000-4000-8000-00000000000a',
  everyone: 'cccccccc-0000-4000-8000-00000000000c',
  theirs: 'bbbbbbbb-0000-4000-8000-00000000000b',
};

const WRITE_ACTIONS = ['create', 'update', 'delete', 'retitleAll'];
function writer(tenant?: string) {
  const permissions: string[] = [];
  for (const model of [EffFlyer, EffNotice, EffLedger, EffBoard]) {
    const segment = segmentOf(model);
    const simple = model.name.toLowerCase();
    for (const action of WRITE_ACTIONS) {
      permissions.push(`${segment}.${action}`, `${simple}.${action}`);
    }
  }
  return {
    user: { id: `writer-${tenant ?? 'none'}` },
    ...(tenant ? { tenantId: tenant } : {}),
    permissions,
  };
}

describe('emitted routes apply the tenancy a model has when it is served', () => {
  let dir: string;
  let db: DatabaseInterface;
  let app: EmittedApp;
  const collections = new Map<string, unknown>();
  const stores: Record<string, SmrtCollection<SmrtObject>> = {};
  let flyer = '';
  let ledger = '';
  let board = '';

  const titles = async (store: SmrtCollection<SmrtObject>) =>
    (
      await db.query(`SELECT title FROM ${store.tableName} ORDER BY title`)
    ).rows.map((row) => String(row.title));

  beforeAll(async () => {
    const pairs = [
      [EffFlyer, EffFlyerCollection],
      [EffNotice, EffNoticeCollection],
      [EffLedger, EffLedgerCollection],
      [EffPoster, EffPosterCollection],
      [EffBoard, EffBoardCollection],
    ] as const;
    for (const [model, collection] of pairs) {
      ObjectRegistry.registerCollection(model.name, collection as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-emitted-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: pairs.map(([model]) => model.name),
    });
    for (const [model, collection] of pairs) {
      const store = (await (
        collection as unknown as {
          create(options: unknown): Promise<SmrtCollection<SmrtObject>>;
        }
      ).create({ db })) as SmrtCollection<SmrtObject>;
      stores[model.name] = store;
      collections.set(keyOf(model), store);
      collections.set(model.name, store);
      collections.set(`${keyOf(model)}Collection`, store);
      collections.set(`${model.name}Collection`, store);
    }
    enableTenancy();
    app = await emitApp(
      'effective-tenancy-emitted',
      pairs.map(([model]) => model),
      collections,
      Object.fromEntries([
        collectionEntryFor(EffFlyer, {
          countAll: [],
          tally: ['options'],
          retitleAll: ['options'],
        }),
        collectionEntryFor(EffNotice, {
          countAll: [],
          tally: ['options'],
          retitleAll: ['options'],
        }),
      ]),
    );
    // Run-time registrations, after the routes were generated.
    flyer = keyOf(EffFlyer);
    ledger = keyOf(EffLedger);
    board = keyOf(EffBoard);
    registerTenantScopedClass(flyer, {
      mode: 'optional',
      field: 'organizationId',
    });
    registerTenantScopedClass(ledger, { mode: 'required' });
    registerTenantScopedClass(board, {
      mode: 'optional',
      allowSuperAdminBypass: true,
    });
  }, 120_000);

  afterAll(async () => {
    for (const key of [flyer, ledger, board]) {
      if (key) unregisterTenantScopedClass(key);
    }
    disableTenancy();
    app?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      for (const store of Object.values(stores)) {
        await db.query(`DELETE FROM ${store.tableName}`);
      }
      await stores.EffFlyer.create({
        id: ROW.ours,
        title: 'ours',
        organizationId: TENANT_A,
        tenantId: TENANT_B,
      } as never);
      await stores.EffFlyer.create({
        id: ROW.everyone,
        title: 'everyone',
      } as never);
      await stores.EffFlyer.create({
        id: ROW.theirs,
        title: 'theirs',
        organizationId: TENANT_B,
        tenantId: TENANT_A,
      } as never);
      for (const name of ['EffNotice', 'EffLedger', 'EffPoster', 'EffBoard']) {
        await stores[name].create({
          id: ROW.ours,
          title: 'ours',
          tenantId: TENANT_A,
        } as never);
        await stores[name].create({
          id: ROW.everyone,
          title: 'everyone',
        } as never);
        await stores[name].create({
          id: ROW.theirs,
          title: 'theirs',
          tenantId: TENANT_B,
        } as never);
      }
    });
  });

  const flyers = () => segmentOf(EffFlyer);
  const notices = () => segmentOf(EffNotice);

  describe('collection actions (rows 1, 3, 32)', () => {
    it('a collection read with no scope argument is refused to a caller with no tenant under tenancy registered at run time', async () => {
      const anonymous = await app.call('GET', `${flyers()}/count-all`);
      expect(anonymous.status).toBe(401);
      const tenantless = await app.call('GET', `${flyers()}/count-all`, {
        locals: { user: { id: 'reader' }, permissions: [] },
      });
      expect(tenantless.status).toBe(403);
      const ours = await app.call('GET', `${flyers()}/count-all`, {
        locals: { user: { id: 'reader' }, tenantId: TENANT_A },
      });
      expect(ours.status).toBe(200);
      expect((ours.body as { result: unknown }).result).toBe(1);
    });

    it('an action that ignores its options counts only rows without an owner', async () => {
      for (const segment of [flyers(), notices()]) {
        const answer = await app.call('GET', `${segment}/tally`);
        expect(answer.status).toBe(200);
        expect((answer.body as { result: unknown }).result).toBe(1);
      }
    });

    it('a collection-hosted action resolves its item model tenancy', async () => {
      const answer = await app.call('GET', `${notices()}/count-all`);
      expect(answer.status).toBe(401);
    });
  });

  describe('modes and fields (rows 8, 15, 16)', () => {
    it('a run-time required registration refuses a read with no tenant', async () => {
      expect((await app.call('GET', segmentOf(EffLedger))).status).toBe(401);
      expect(
        (
          await app.call('GET', `${segmentOf(EffLedger)}/[id]`, {
            params: { id: ROW.everyone },
          })
        ).status,
      ).toBe(401);
    });

    it('required mode refuses a caller with no tenant; optional mode serves only rows without an owner', async () => {
      const required = await app.call('GET', segmentOf(EffLedger), {
        locals: { user: { id: 'reader' } },
      });
      expect(required.status).toBe(403);
      const optional = await app.call('GET', flyers());
      expect(optional.status).toBe(200);
      expect(titlesOf(optional.body)).toEqual(['everyone']);
    });

    it('the registered ownership field scopes reads and actions', async () => {
      const locals = { user: { id: 'reader' }, tenantId: TENANT_A };
      const listed = await app.call('GET', flyers(), { locals });
      expect(titlesOf(listed.body)).toEqual(['ours']);
      const theirs = await app.call('GET', `${flyers()}/[id]`, {
        params: { id: ROW.theirs },
        locals,
      });
      expect(theirs.status).toBe(404);
      const tally = await app.call('GET', `${flyers()}/tally`, { locals });
      expect((tally.body as { result: unknown }).result).toBe(1);
    });
  });

  describe('writes (rows 10, 11, 12)', () => {
    it('a writer with no tenant changes no row of a tenant-scoped model', async () => {
      for (const store of [stores.EffFlyer, stores.EffNotice]) {
        const segment = segmentOf(
          store === stores.EffFlyer ? EffFlyer : EffNotice,
        );
        const before = await titles(store);
        for (const id of [ROW.ours, ROW.everyone, ROW.theirs]) {
          const put = await app.call('PUT', `${segment}/[id]`, {
            params: { id },
            locals: writer(),
            body: { title: 'changed' },
          });
          expect(put.status).toBe(403);
          const del = await app.call('DELETE', `${segment}/[id]`, {
            params: { id },
            locals: writer(),
          });
          expect(del.status).toBe(403);
        }
        const post = await app.call('POST', segment, {
          locals: writer(),
          body: { title: 'created without a tenant' },
        });
        expect(post.status).toBe(403);
        const action = await app.call('POST', `${segment}/retitle-all`, {
          locals: writer(),
          body: {},
        });
        expect(action.status).toBe(403);
        expect(await titles(store)).toEqual(before);
      }
    });

    it('a writer of another tenant leaves the row unchanged', async () => {
      const put = await app.call('PUT', `${flyers()}/[id]`, {
        params: { id: ROW.ours },
        locals: writer(TENANT_B),
        body: { title: 'changed by b' },
      });
      expect(put.status).not.toBe(200);
      expect(await titles(stores.EffFlyer)).not.toContain('changed by b');
      const own = await app.call('PUT', `${flyers()}/[id]`, {
        params: { id: ROW.ours },
        locals: writer(TENANT_A),
        body: { title: 'changed by a' },
      });
      expect(own.status).toBe(200);
      expect(await titles(stores.EffFlyer)).toContain('changed by a');
    });

    it('a system context writes; a bypass writes only where the model allows it', async () => {
      const system = await withSystemContext(() =>
        app.call('PUT', `${flyers()}/[id]`, {
          params: { id: ROW.theirs },
          locals: writer(),
          body: { title: 'changed by system' },
        }),
      );
      expect(system.status).toBe(200);
      expect(await titles(stores.EffFlyer)).toContain('changed by system');

      const asBypass = (path: string, body: unknown) =>
        withTenant({ tenantId: TENANT_A }, () =>
          withSuperAdminBypass(() =>
            app.call('PUT', path, {
              params: { id: ROW.theirs },
              locals: writer(),
              body,
            }),
          ),
        );
      const allowed = await asBypass(`${segmentOf(EffBoard)}/[id]`, {
        title: 'changed by bypass',
      });
      expect(allowed.status).toBe(200);
      expect(await titles(stores.EffBoard)).toContain('changed by bypass');
      const refused = await asBypass(`${flyers()}/[id]`, {
        title: 'changed by bypass',
      });
      expect(refused.status).not.toBe(200);
      expect(await titles(stores.EffFlyer)).not.toContain('changed by bypass');
    });
  });

  describe('registration after a served request (row 4)', () => {
    it('tenancy registered after a served request applies to the next request and its validator', async () => {
      const posters = segmentOf(EffPoster);
      const first = await app.call('GET', posters);
      expect(first.status).toBe(200);
      expect(titlesOf(first.body)).toEqual(['everyone', 'ours', 'theirs']);
      const etag = first.headers.get('etag');
      expect(etag).toBeTruthy();
      const key = keyOf(EffPoster);
      registerTenantScopedClass(key, { mode: 'optional' });
      try {
        const next = await app.call('GET', posters, {
          headers: { 'if-none-match': String(etag) },
        });
        expect(next.status).toBe(200);
        expect(titlesOf(next.body)).toEqual(['everyone']);
      } finally {
        unregisterTenantScopedClass(key);
      }
    });
  });

  describe('the request tenant (row 33)', () => {
    it('a host-entered tenant is the request tenant', async () => {
      const locals = { user: { id: 'reader' } };
      const listed = await withTenant({ tenantId: TENANT_A }, () =>
        app.call('GET', flyers(), { locals }),
      );
      expect(listed.status).toBe(200);
      expect(titlesOf(listed.body)).toEqual(['ours']);
      const conflicting = await withTenant({ tenantId: TENANT_A }, () =>
        app.call('GET', flyers(), {
          locals: { ...locals, tenantId: TENANT_B },
        }),
      );
      expect(conflicting.status).toBe(403);
    });
  });
});
