/**
 * A request that reads an STI family other than its route's is held to that
 * family's tenancy too: rows of a member whose tenancy differs from the base
 * it reads through are not served, as on the family's own routes. Runtime
 * REST with the real tenant interceptor on a SQLite file.
 *
 * Row R3.6 of the #5375 round-3 matrix.
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
import { withSystemContext } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  keyOf,
  restCall,
  segmentOf,
  TENANT_A,
  TENANT_B,
} from './helpers/effective-tenancy-harness.js';

/** The crate collection the desk's actions read (set in `beforeAll`). */
const reached: { crates?: SmrtCollection<SmrtObject> } = {};

const ROW = {
  crate: 'cccccccc-0000-4000-8000-0000000000c1',
  lockedOfA: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  lockedOfB: 'bbbbbbbb-0000-4000-8000-0000000000b1',
};

// An unscoped model whose read actions read another STI family.
@smrt({
  api: {
    include: ['list', 'crateTitles', 'crateById', 'makeCrate', 'retypeCrate'],
    routes: {
      retypeCrate: { method: 'GET', path: 'retype-crate' },
      makeCrate: { method: 'GET', path: 'make-crate' },
      crateTitles: { method: 'GET', path: 'crate-titles' },
      crateById: { method: 'GET', path: 'crate-by-id' },
    },
  },
})
class EffOtherDesk extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffOtherDeskCollection extends SmrtCollection<EffOtherDesk> {
  static readonly _itemClass = EffOtherDesk;
  /** Titles of every crate the request may read, through the base. */
  async crateTitles(_options?: unknown) {
    const rows = await (reached.crates as SmrtCollection<SmrtObject>).list({});
    return rows
      .map((row) => (row as unknown as { title: string }).title)
      .sort();
  }
  /** Writes a row of the tenant-scoped subtype through the base. */
  async makeCrate(_options?: unknown) {
    const row = await (reached.crates as SmrtCollection<SmrtObject>).create({
      title: 'made crate',
      _meta_type: keyOf(EffOtherLockedCrate),
    } as never);
    return (row as unknown as { tenantId: string | null }).tenantId;
  }
  /** Saves a base-class row typed as the tenant-scoped subtype. */
  async retypeCrate(_options?: unknown) {
    const crates = reached.crates as SmrtCollection<SmrtObject>;
    const row = await crates.create({ title: 'retyped crate' } as never);
    (row as unknown as { _meta_type: string })._meta_type =
      keyOf(EffOtherLockedCrate);
    await row.save();
    return 'retyped';
  }
  /** Each crate's title by id, or null where it is not served. */
  async crateById(_options?: unknown) {
    const crates = reached.crates as SmrtCollection<SmrtObject>;
    const titles: Record<string, string | null> = {};
    for (const [name, id] of Object.entries(ROW)) {
      const row = await crates.get(id);
      titles[name] = row ? (row as unknown as { title: string }).title : null;
    }
    return titles;
  }
}

// An unscoped STI base with a tenant-scoped subtype.
@smrt({ tableStrategy: 'sti' })
class EffOtherCrate extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffOtherCrateCollection extends SmrtCollection<EffOtherCrate> {
  static readonly _itemClass = EffOtherCrate;
}
@smrt({})
@TenantScoped({ mode: 'optional' })
class EffOtherLockedCrate extends EffOtherCrate {
  @tenantId({ nullable: true }) tenantId: string | null = null;
}

const SESSIONS: Record<string, Record<string, unknown>> = {
  'user-of-a': { tenantId: TENANT_A },
  operator: { allowCrossTenant: true },
};
const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');

describe('a read of another STI family is held to that family', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let desks: SmrtCollection<SmrtObject>;
  const action = (path: string, token?: string) =>
    restCall(
      handler,
      'GET',
      `${segmentOf(EffOtherDesk)}/${path}`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffOtherDesk',
      EffOtherDeskCollection as never,
    );
    ObjectRegistry.register(EffOtherDeskCollection as never, {});
    ObjectRegistry.getMethods('EffOtherDeskCollection').clear();
    for (const name of [
      'crateTitles',
      'crateById',
      'makeCrate',
      'retypeCrate',
    ]) {
      ObjectRegistry.getMethods('EffOtherDeskCollection').set(name, {
        name,
        parameters: [{ name: 'options', type: 'any', optional: true }],
        returnType: 'Promise<any>',
        isPublic: true,
      } as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-other-family-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [EffOtherDesk, EffOtherCrate, EffOtherLockedCrate].map((model) =>
        keyOf(model),
      ),
    });
    desks = (await EffOtherDeskCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    reached.crates = (await EffOtherCrateCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    enableTenancy();
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
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      const crates = reached.crates as SmrtCollection<SmrtObject>;
      await db.query(`DELETE FROM ${desks.tableName}`);
      await db.query(`DELETE FROM ${crates.tableName}`);
      await desks.create({ title: 'desk' } as never);
      await crates.create({ id: ROW.crate, title: 'crate' } as never);
      for (const [id, title, owner] of [
        [ROW.lockedOfA, 'locked crate of a', TENANT_A],
        [ROW.lockedOfB, 'locked crate of b', TENANT_B],
      ] as const) {
        await crates.create({
          id,
          title,
          tenantId: owner,
          _meta_type: keyOf(EffOtherLockedCrate),
        } as never);
      }
    });
  });

  it('a read with no tenant through an unscoped base serves no row of a tenant-scoped subtype', async () => {
    const listed = await action('crate-titles');
    expect(listed.status).toBe(200);
    expect((listed.body as { result: unknown }).result).toEqual(['crate']);

    const byId = await action('crate-by-id');
    expect(byId.status).toBe(200);
    expect((byId.body as { result: unknown }).result).toEqual({
      crate: 'crate',
      lockedOfA: null,
      lockedOfB: null,
    });
  });

  it("a tenant's read through the base serves no row of the subtype either", async () => {
    const listed = await action('crate-titles', 'user-of-a');
    expect((listed.body as { result: unknown }).result).toEqual(['crate']);
  });

  it("a tenant's write of the subtype through the base is stamped with its tenant", async () => {
    const made = await action('make-crate', 'user-of-a');
    expect(made.status).toBe(200);
    expect((made.body as { result: unknown }).result).toBe(TENANT_A);
  });

  it('a request admitted under a read grant writes no row of the subtype through the base', async () => {
    const made = await action('make-crate', 'operator');
    expect(made.status).toBe(403);
    const rows = await withSystemContext(() =>
      (reached.crates as SmrtCollection<SmrtObject>).list({
        where: { title: 'made crate' },
      }),
    );
    expect(rows).toHaveLength(0);
  });

  it("a tenant's save of a base row typed as the subtype is decided by the interceptors, not refused as another family", async () => {
    const saved = await action('retype-crate', 'user-of-a');
    expect(saved.status).toBe(200);
  });
});
