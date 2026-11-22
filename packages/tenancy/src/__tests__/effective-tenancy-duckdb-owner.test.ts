/**
 * A request's save or delete of an STI row is decided against the stored
 * row's owner as persistence reads it. On native DuckDB a UUID owner column
 * comes back from a raw read as `{ hugeint }`; the decision uses the
 * canonical read, so a tenant writes and deletes its own row and still
 * cannot change another tenant's. Row R6.1 of the #5375 matrix.
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

const reached: { locked?: SmrtCollection<SmrtObject> } = {};

const ROW = {
  lockedOfA: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  lockedOfB: 'bbbbbbbb-0000-4000-8000-0000000000b1',
};

@smrt({
  api: {
    include: ['list', 'renameOwnLocked', 'dropOwnLocked', 'dropForeignLocked'],
    routes: {
      renameOwnLocked: { method: 'GET', path: 'rename-own-locked' },
      dropOwnLocked: { method: 'GET', path: 'drop-own-locked' },
      dropForeignLocked: { method: 'GET', path: 'drop-foreign-locked' },
    },
  },
})
class DuckOwnerDesk extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class DuckOwnerDeskCollection extends SmrtCollection<DuckOwnerDesk> {
  static readonly _itemClass = DuckOwnerDesk;
  async renameOwnLocked(_options?: unknown) {
    const row = await (reached.locked as SmrtCollection<SmrtObject>).get(
      ROW.lockedOfA,
    );
    if (!row) return null;
    (row as unknown as { title: string }).title = 'renamed crate of a';
    await row.save();
    return 'renamed';
  }
  async dropOwnLocked(_options?: unknown) {
    return (reached.locked as SmrtCollection<SmrtObject>).delete(ROW.lockedOfA);
  }
  async dropForeignLocked(_options?: unknown) {
    const locked = reached.locked as unknown as DuckOwnerLockedCollection;
    const row = await locked.unsaved({ id: ROW.lockedOfB });
    await row.delete();
    return 'dropped';
  }
}

@smrt({ tableStrategy: 'sti' })
class DuckOwnerCrate extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
@smrt({})
@TenantScoped({ mode: 'optional' })
class DuckOwnerLocked extends DuckOwnerCrate {
  @tenantId({ nullable: true }) tenantId: string | null = null;
}
class DuckOwnerLockedCollection extends SmrtCollection<DuckOwnerLocked> {
  static readonly _itemClass = DuckOwnerLocked;
  unsaved(values: Record<string, unknown>) {
    return this.createUnsaved(values as never);
  }
}

const tokenOf = (req: Request) =>
  (req.headers.get('authorization') ?? '').replace('Bearer ', '');

describe('a same-tenant STI write on native DuckDB with a UUID owner column', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let desks: SmrtCollection<SmrtObject>;

  const titles = async () => {
    const result = await db.query(
      `SELECT title FROM ${reached.locked?.tableName} ORDER BY title`,
    );
    return (result.rows as Array<{ title: string }>).map((row) => row.title);
  };
  const action = (path: string) =>
    restCall(handler, 'GET', `${segmentOf(DuckOwnerDesk)}/${path}`, {
      headers: { authorization: 'Bearer user-of-a' },
    });

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'DuckOwnerDesk',
      DuckOwnerDeskCollection as never,
    );
    ObjectRegistry.register(DuckOwnerDeskCollection as never, {});
    ObjectRegistry.getMethods('DuckOwnerDeskCollection').clear();
    for (const name of [
      'renameOwnLocked',
      'dropOwnLocked',
      'dropForeignLocked',
    ]) {
      ObjectRegistry.getMethods('DuckOwnerDeskCollection').set(name, {
        name,
        parameters: [{ name: 'options', type: 'any', optional: true }],
        returnType: 'Promise<any>',
        isPublic: true,
      } as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-duckdb-owner-'));
    db = await getTestDatabase({
      type: 'duckdb',
      url: ':memory:',
      classes: [DuckOwnerDesk, DuckOwnerCrate, DuckOwnerLocked].map((model) =>
        keyOf(model),
      ),
    });
    desks = (await DuckOwnerDeskCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    reached.locked = (await DuckOwnerLockedCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    enableTenancy();
    handler = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (req: Request) => req,
        resolveTenant: (req: Request) =>
          tokenOf(req) === 'user-of-a'
            ? { tenantId: TENANT_A, authenticated: true }
            : { authenticated: false },
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
      const locked = reached.locked as SmrtCollection<SmrtObject>;
      await db.query(`DELETE FROM ${desks.tableName}`);
      await db.query(`DELETE FROM ${locked.tableName}`);
      await desks.create({ title: 'desk' } as never);
      for (const [id, title, owner] of [
        [ROW.lockedOfA, 'locked crate of a', TENANT_A],
        [ROW.lockedOfB, 'locked crate of b', TENANT_B],
      ] as const) {
        await locked.create({
          id,
          title,
          tenantId: owner,
          _meta_type: keyOf(DuckOwnerLocked),
        } as never);
      }
    });
  });

  it("a tenant's save of its own row runs", async () => {
    const saved = await action('rename-own-locked');
    expect(saved.status).toBe(200);
    expect(await titles()).toEqual(['locked crate of b', 'renamed crate of a']);
  });

  it("a tenant's delete of its own row runs", async () => {
    const dropped = await action('drop-own-locked');
    expect(dropped.status).toBe(200);
    expect(await titles()).toEqual(['locked crate of b']);
  });

  it("another tenant's row is still refused on a delete", async () => {
    const dropped = await action('drop-foreign-locked');
    expect(dropped.status).toBe(403);
    expect(await titles()).toEqual(['locked crate of a', 'locked crate of b']);
  });
});
