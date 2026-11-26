/**
 * Every collection call a request makes is held to the tenancy the request
 * was admitted under, including models the route did not resolve, with the
 * real tenant interceptor on a SQLite file.
 *
 * Rows R2.4 to R2.9 and R2.12 of the #5375 round-2 matrix.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  ObjectRegistry,
  runInRequestTenancy,
  SmrtCollection,
  SmrtObject,
  smrt,
  TenantPolicyChangedError,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemContext } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';
import {
  inRequestScope,
  keyOf,
  restCall,
  rowsOf,
  segmentOf,
  TENANT_A,
  TENANT_B,
} from './helpers/effective-tenancy-harness.js';

/** Collections of models the desk's actions reach (set in `beforeAll`). */
const reached: {
  logs?: SmrtCollection<SmrtObject>;
  vaults?: SmrtCollection<SmrtObject>;
} = {};

@smrt({
  api: {
    include: ['list', 'stampLogs', 'countLogs', 'countVaults'],
    routes: {
      stampLogs: { method: 'GET', path: 'stamp-logs' },
      countLogs: { method: 'GET', path: 'count-logs' },
      countVaults: { method: 'GET', path: 'count-vaults' },
    },
  },
})
class EffScopeDesk extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffScopeDeskCollection extends SmrtCollection<EffScopeDesk> {
  static readonly _itemClass = EffScopeDesk;
  /** A read action that writes another tenant-scoped model. */
  async stampLogs(_options?: unknown) {
    const rows = await (reached.logs as SmrtCollection<SmrtObject>).list({});
    for (const row of rows) {
      (row as unknown as { title: string }).title = 'stamped';
      await row.save();
    }
    return rows.length;
  }
  /** A read action that reads another optional-mode tenant-scoped model. */
  async countLogs(_options?: unknown) {
    return (await (reached.logs as SmrtCollection<SmrtObject>).list({})).length;
  }
  /** A read action that reads a required-mode tenant-scoped model. */
  async countVaults(_options?: unknown) {
    return (await (reached.vaults as SmrtCollection<SmrtObject>).list({}))
      .length;
  }
}

@smrt({})
@TenantScoped({ mode: 'optional' })
class EffScopeLog extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId({ nullable: true }) tenantId: string | null = null;
}
class EffScopeLogCollection extends SmrtCollection<EffScopeLog> {
  static readonly _itemClass = EffScopeLog;
}

@smrt({})
@TenantScoped({ mode: 'required' })
class EffScopeVault extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @tenantId() tenantId = '';
}
class EffScopeVaultCollection extends SmrtCollection<EffScopeVault> {
  static readonly _itemClass = EffScopeVault;
}

// An unscoped STI base with two subtypes of the same (no) tenancy.
@smrt({ tableStrategy: 'sti', api: { include: ['list', 'get'] } })
class EffScopeShelf extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffScopeShelfCollection extends SmrtCollection<EffScopeShelf> {
  static readonly _itemClass = EffScopeShelf;
}
@smrt({ api: { include: ['list', 'get'] } })
class EffScopeBook extends EffScopeShelf {}
@smrt({ api: { include: ['list', 'get'] } })
class EffScopeAtlas extends EffScopeShelf {}
/** A collection of the subtype alone (not registered as its route). */
class EffScopeBookCollection extends SmrtCollection<EffScopeBook> {
  static readonly _itemClass = EffScopeBook;
}

// An unscoped STI base keyed on `slug` across its types, and a scoped
// subtype: the subtype's rows are not admitted through the base.
@smrt({ tableStrategy: 'sti', conflictColumns: ['slug'] } as never)
class EffScopeCrate extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffScopeCrateCollection extends SmrtCollection<EffScopeCrate> {
  static readonly _itemClass = EffScopeCrate;
}
@smrt({})
@TenantScoped({ mode: 'optional' })
class EffScopeLockedCrate extends EffScopeCrate {}

const ROW = {
  lockedOfB: 'bbbbbbbb-0000-4000-8000-0000000000b2',
  bookOfA: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  bookOfB: 'bbbbbbbb-0000-4000-8000-0000000000b1',
  atlas: 'cccccccc-0000-4000-8000-0000000000c1',
};

const SESSIONS: Record<string, Record<string, unknown>> = {
  'user-of-a': { tenantId: TENANT_A },
  operator: { allowCrossTenant: true },
};
const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');
const as = (token: string) => ({
  headers: { authorization: `Bearer ${token}` },
});
const anonymous = { authenticated: false } as const;
/** Signed in with no tenant: the shelf's members are readable to it. */
const reader = { authenticated: true } as const;

describe('every collection call of a request is held to its admitted tenancy', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let desks: SmrtCollection<SmrtObject>;
  let shelves: SmrtCollection<SmrtObject>;
  let crates: SmrtCollection<SmrtObject>;

  const titles = async (table: string) =>
    (await db.query(`SELECT title FROM ${table} ORDER BY title`)).rows.map(
      (row) => String(row.title),
    );

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffScopeDesk',
      EffScopeDeskCollection as never,
    );
    ObjectRegistry.registerCollection(
      'EffScopeShelf',
      EffScopeShelfCollection as never,
    );
    // A loaded manifest records a collection-hosted action's parameters under
    // the collection class; these actions take an options bag.
    ObjectRegistry.register(EffScopeDeskCollection as never, {});
    ObjectRegistry.getMethods('EffScopeDeskCollection').clear();
    for (const name of ['stampLogs', 'countLogs', 'countVaults']) {
      ObjectRegistry.getMethods('EffScopeDeskCollection').set(name, {
        name,
        parameters: [{ name: 'options', type: 'any', optional: true }],
        returnType: 'Promise<any>',
        isPublic: true,
      } as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-scope-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [
        EffScopeDesk,
        EffScopeLog,
        EffScopeVault,
        EffScopeShelf,
        EffScopeBook,
        EffScopeAtlas,
        EffScopeCrate,
        EffScopeLockedCrate,
      ].map((model) => keyOf(model)),
    });
    desks = (await EffScopeDeskCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    reached.logs = (await EffScopeLogCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    reached.vaults = (await EffScopeVaultCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    shelves = (await EffScopeShelfCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    crates = (await EffScopeCrateCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    enableTenancy();
    registerTenantScopedClass(keyOf(EffScopeDesk), { mode: 'optional' });
    handler = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (req: Request) => req,
        resolveTenant: (req: Request) => {
          const session = SESSIONS[tokenOf(req)];
          return session
            ? { ...session, authenticated: true }
            : { authenticated: false };
        },
      },
      { db },
    ).generateHandler();
  }, 60_000);

  afterAll(async () => {
    unregisterTenantScopedClass(keyOf(EffScopeDesk));
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      const logs = reached.logs as SmrtCollection<SmrtObject>;
      const vaults = reached.vaults as SmrtCollection<SmrtObject>;
      await db.query(`DELETE FROM ${desks.tableName}`);
      await db.query(`DELETE FROM ${logs.tableName}`);
      await db.query(`DELETE FROM ${vaults.tableName}`);
      await db.query(`DELETE FROM ${shelves.tableName}`);
      await db.query(`DELETE FROM ${crates.tableName}`);
      await crates.create({
        id: ROW.lockedOfB,
        slug: 'shared',
        title: 'locked crate of b',
        tenantId: TENANT_B,
        _meta_type: keyOf(EffScopeLockedCrate),
      } as never);
      await desks.create({ title: 'desk' } as never);
      await logs.create({ title: 'log of a', tenantId: TENANT_A } as never);
      await logs.create({ title: 'log of none' } as never);
      await logs.create({ title: 'log of b', tenantId: TENANT_B } as never);
      await vaults.create({ title: 'vault of a', tenantId: TENANT_A } as never);
      await shelves.create({ title: 'shelf' } as never);
      await shelves.create({
        id: ROW.bookOfA,
        title: 'book of a',
        tenantId: TENANT_A,
        _meta_type: keyOf(EffScopeBook),
      } as never);
      await shelves.create({
        id: ROW.bookOfB,
        title: 'book of b',
        tenantId: TENANT_B,
        _meta_type: keyOf(EffScopeBook),
      } as never);
      await shelves.create({
        id: ROW.atlas,
        title: 'atlas',
        _meta_type: keyOf(EffScopeAtlas),
      } as never);
    });
  });

  describe('models the route did not resolve (R2.4, R2.5)', () => {
    it('a cross-tenant read grant writes no row of another tenant-scoped model', async () => {
      const logs = reached.logs as SmrtCollection<SmrtObject>;
      const answer = await restCall(
        handler,
        'GET',
        `${segmentOf(EffScopeDesk)}/stamp-logs`,
        as('operator'),
      );
      expect(answer.status).toBe(403);
      expect(await titles(logs.tableName)).toEqual([
        'log of a',
        'log of b',
        'log of none',
      ]);
    });

    it('a read with no tenant sees only rows without an owner of another optional-mode model and none of a required-mode one', async () => {
      // Runtime REST refuses a caller with no tenant every custom collection
      // action of a tenant-scoped model (#5164), so the request is admitted
      // here through the core resolver directly.
      const read = await inRequestScope(() =>
        runInRequestTenancy(
          {
            model: keyOf(EffScopeDesk),
            operation: 'list',
            principal: anonymous,
          },
          async () => ({
            logs: (await (reached.logs as SmrtCollection<SmrtObject>).list({}))
              .length,
            vaults: (reached.vaults as SmrtCollection<SmrtObject>).list({}),
          }),
        ),
      );
      expect(read.logs).toBe(1);
      await expect(read.vaults).rejects.toMatchObject({
        code: 'TENANT_CONTEXT_REQUIRED',
      });
      for (const action of ['count-logs', 'count-vaults']) {
        const refused = await restCall(
          handler,
          'GET',
          `${segmentOf(EffScopeDesk)}/${action}`,
        );
        expect(refused.status).toBe(401);
      }
      // A tenant's read of the other model is its own tenant's rows (control).
      const ours = await restCall(
        handler,
        'GET',
        `${segmentOf(EffScopeDesk)}/count-logs`,
        as('user-of-a'),
      );
      expect((ours.body as { result: unknown }).result).toBe(1);
    });
  });

  describe('policy drift during a family read (R2.6, R2.7)', () => {
    it('a subtype whose tenancy changes during a base read refuses the read', async () => {
      const book = keyOf(EffScopeBook);
      try {
        const outcome = await inRequestScope(() =>
          runInRequestTenancy(
            {
              model: keyOf(EffScopeShelf),
              operation: 'list',
              principal: reader,
            },
            async () => {
              const before = (await shelves.list({})).length;
              registerTenantScopedClass(book, { mode: 'optional' });
              return { before, after: shelves.list({}) };
            },
          ),
        );
        expect(outcome.before).toBe(4);
        await expect(outcome.after).rejects.toBeInstanceOf(
          TenantPolicyChangedError,
        );
      } finally {
        unregisterTenantScopedClass(book);
      }
    });

    it('a request admitted while tenancy was off refuses once tenancy is turned on', async () => {
      const desk = keyOf(EffScopeDesk);
      disableTenancy();
      try {
        const read = await inRequestScope(() =>
          runInRequestTenancy(
            { model: desk, operation: 'list', principal: anonymous },
            async () => {
              enableTenancy();
              return desks.list({}).then(
                (rows) => rows.length,
                (cause: unknown) => cause,
              );
            },
          ),
        );
        expect(read).toBeInstanceOf(TenantPolicyChangedError);
      } finally {
        enableTenancy();
      }
    });
  });

  describe('the admitted policy is fixed for the request (R2.9)', () => {
    it('a create stamps its owner under the policy the request was admitted with', async () => {
      const desk = keyOf(EffScopeDesk);
      try {
        await inRequestScope(() =>
          runInRequestTenancy(
            {
              model: desk,
              operation: 'create',
              principal: { tenantId: TENANT_A },
            },
            async (t) => {
              expect(() =>
                (t.members as Map<string, unknown>).set(desk, t.route),
              ).toThrow(TypeError);
              registerTenantScopedClass(desk, {
                mode: 'optional',
                autoPopulate: false,
              });
              await desks.create({ title: 'stamped desk' } as never);
            },
          ),
        );
      } finally {
        registerTenantScopedClass(desk, { mode: 'optional' });
      }
      const stored = (
        await db.query(
          `SELECT tenant_id FROM ${desks.tableName} WHERE title = 'stamped desk'`,
        )
      ).rows;
      expect(stored.map((row) => row.tenant_id)).toEqual([TENANT_A]);
    });

    it('the admitted types of a family request cannot be changed', async () => {
      await inRequestScope(() =>
        runInRequestTenancy(
          {
            model: keyOf(EffScopeShelf),
            operation: 'list',
            principal: reader,
          },
          async (t) => {
            const admitted = t.admitted as Set<string>;
            expect(() => admitted.add('Elsewhere')).toThrow(TypeError);
            expect(() => admitted.delete(keyOf(EffScopeBook))).toThrow(
              TypeError,
            );
            expect(admitted.has(keyOf(EffScopeBook))).toBe(true);
          },
        ),
      );
    });
  });

  describe('point reads keep the caller filter (R2.8)', () => {
    it("a point read with a type filter returns only rows of the caller's types", async () => {
      const read = (filter: Record<string, unknown>) =>
        inRequestScope(() =>
          runInRequestTenancy(
            {
              model: keyOf(EffScopeShelf),
              operation: 'get',
              principal: reader,
            },
            () => shelves.get(filter),
          ),
        );
      const book = keyOf(EffScopeBook);
      expect(await read({ id: ROW.atlas, '_meta_type in': [book] })).toBeNull();
      const found = await read({ id: ROW.bookOfA, '_meta_type in': [book] });
      expect(found?.id).toBe(ROW.bookOfA);
    });
  });

  describe('lists keep the caller filter as the collection reads it (R2.8)', () => {
    const list = async (model: typeof EffScopeShelf, query: string) => {
      const answer = await restCall(
        handler,
        'GET',
        `${segmentOf(model)}?${query}`,
        as('user-of-a'),
      );
      return {
        status: answer.status,
        titles: rowsOf(answer.body)
          .map((row) => String(row.title))
          .sort(),
      };
    };
    const atlas = encodeURIComponent(keyOf(EffScopeAtlas));
    const book = encodeURIComponent(keyOf(EffScopeBook));

    it('a subtype list serves only its own type for every spelling of a discriminator equality', async () => {
      const books = (await EffScopeBookCollection.create({
        db,
      })) as unknown as SmrtCollection<SmrtObject>;
      const other = keyOf(EffScopeAtlas);
      for (const where of [
        { _meta_type: 'x', _metaType: other },
        { _metaType: other, _meta_type: 'x' },
        { _metaType: other },
        { '_meta_type =': other },
      ]) {
        const rows = await inRequestScope(() =>
          runInRequestTenancy(
            {
              model: keyOf(EffScopeBook),
              operation: 'list',
              principal: reader,
            },
            () => books.list({ where }),
          ),
        );
        expect(
          rows.map((row) => String((row as { title?: unknown }).title)).sort(),
        ).toEqual(['book of a', 'book of b']);
      }
    });

    it('the base list applies a discriminator filter and refuses two spellings of one operator', async () => {
      expect(await list(EffScopeShelf, `_metaType=${atlas}`)).toEqual({
        status: 200,
        titles: ['atlas'],
      });
      expect(
        await list(
          EffScopeShelf,
          `${encodeURIComponent('_metaType[in]')}=${book}`,
        ),
      ).toEqual({ status: 200, titles: ['book of a', 'book of b'] });
      const twice = await list(
        EffScopeShelf,
        `${encodeURIComponent('_metaType[in]')}=${book}&${encodeURIComponent('_meta_type[in]')}=${atlas}`,
      );
      expect(twice.status).toBe(400);
    });

    it('a list record with an own prototype key is refused as it is without a bound request', async () => {
      const where = JSON.parse(
        `{"__proto__": {"title": "shelf"}, "_metaType": ${JSON.stringify(keyOf(EffScopeAtlas))}}`,
      ) as Record<string, unknown>;
      await expect(shelves.list({ where })).rejects.toThrow();
      await expect(
        inRequestScope(() =>
          runInRequestTenancy(
            {
              model: keyOf(EffScopeShelf),
              operation: 'list',
              principal: reader,
            },
            () => shelves.list({ where }),
          ),
        ),
      ).rejects.toThrow();
    });
  });

  describe('a natural-key save never adopts a row of a type the request does not admit (R2.12)', () => {
    it('a base create whose key matches an excluded subtype row writes no change to it', async () => {
      const outcome = await inRequestScope(() =>
        runInRequestTenancy(
          {
            model: keyOf(EffScopeCrate),
            operation: 'create',
            principal: { tenantId: TENANT_A },
          },
          () =>
            crates
              .create({
                slug: 'shared',
                title: 'taken over',
                tenantId: TENANT_B,
              } as never)
              .then(
                () => 'saved',
                (cause: unknown) => cause,
              ),
        ),
      );
      expect(outcome).not.toBe('saved');
      const rows = (
        await db.query(
          `SELECT id, title, tenant_id, _meta_type FROM ${crates.tableName}`,
        )
      ).rows.map((row) => [row.id, row.title, row.tenant_id, row._meta_type]);
      expect(rows).toEqual([
        [
          ROW.lockedOfB,
          'locked crate of b',
          TENANT_B,
          keyOf(EffScopeLockedCrate),
        ],
      ]);
    });
  });
});
