/**
 * A new object saved with an explicit id on a model whose conflict target is
 * `['id']` updates a stored row with that id only when both have the same
 * owner on every ownership column, as a natural-key adoption does. A row owned
 * by another tenant (or a global row, for a tenant's save, and the reverse) is
 * refused with `TENANT_ISOLATION_VIOLATION` and left unchanged. Runs on SQLite
 * by default and on PGlite under `pnpm test:pglite`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';

@smrt({ tableName: 'id_conflict_owned', conflictColumns: ['id'] })
class IdConflictOwned extends SmrtObject {
  @field({ type: 'text' }) body = '';
  @field({ type: 'text' }) tenantId: string | null = null;
}
class IdConflictOwnedCollection extends SmrtCollection<IdConflictOwned> {
  static readonly _itemClass = IdConflictOwned;
}

@smrt({ tableName: 'id_conflict_plain', conflictColumns: ['id'] })
class IdConflictPlain extends SmrtObject {
  @field({ type: 'text' }) body = '';
}
class IdConflictPlainCollection extends SmrtCollection<IdConflictPlain> {
  static readonly _itemClass = IdConflictPlain;
}

type Engine = 'sqlite' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite'];

describe.each(
  engines,
)('explicit-id create on an id conflict target on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let owned: IdConflictOwnedCollection;
  let plain: IdConflictPlainCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'IdConflictOwned',
      IdConflictOwnedCollection,
    );
    ObjectRegistry.registerCollection(
      'IdConflictPlain',
      IdConflictPlainCollection,
    );
    db = await getTestDatabase({
      type: engine,
      ...(engine === 'sqlite' ? { url: ':memory:' } : {}),
      classes: ['IdConflictOwned', 'IdConflictPlain'],
    });
    owned = (await IdConflictOwnedCollection.create({ db })) as never;
    plain = (await IdConflictPlainCollection.create({ db })) as never;
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  async function stored(table: string, id: string) {
    const result = await db.query(
      `SELECT body, CAST(tenant_id AS VARCHAR) AS tenant_id FROM ${table} WHERE CAST(id AS VARCHAR) = $1`,
      id,
    );
    return result.rows[0];
  }

  it("refuses a create that names another tenant's row id", async () => {
    const a = await owned.create({ body: 'A', tenantId: TENANT_A } as never);

    await expect(
      owned.create({ id: a.id, body: 'B', tenantId: TENANT_B } as never),
    ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });

    expect(await stored('id_conflict_owned', String(a.id))).toEqual({
      body: 'A',
      tenant_id: TENANT_A,
    });
  });

  it("refuses a global create that names a tenant's row id", async () => {
    const a = await owned.create({ body: 'A', tenantId: TENANT_A } as never);

    await expect(
      owned.create({ id: a.id, body: 'global' } as never),
    ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });

    expect(await stored('id_conflict_owned', String(a.id))).toEqual({
      body: 'A',
      tenant_id: TENANT_A,
    });
  });

  it("refuses a tenant create that names a global row's id", async () => {
    const global = await owned.create({ body: 'global' } as never);

    await expect(
      owned.create({ id: global.id, body: 'B', tenantId: TENANT_B } as never),
    ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });

    expect(await stored('id_conflict_owned', String(global.id))).toEqual({
      body: 'global',
      tenant_id: null,
    });
  });

  it('control: a same-tenant create with the id updates the row in place', async () => {
    const a = await owned.create({ body: 'A', tenantId: TENANT_A } as never);

    await owned.create({
      id: a.id,
      body: 'A again',
      tenantId: TENANT_A,
    } as never);

    expect(await stored('id_conflict_owned', String(a.id))).toEqual({
      body: 'A again',
      tenant_id: TENANT_A,
    });
  });

  it('control: a model without ownership columns still updates by id', async () => {
    const row = await plain.create({ body: 'first' } as never);

    await plain.create({ id: row.id, body: 'second' } as never);

    const result = await db.query(
      'SELECT body FROM id_conflict_plain WHERE CAST(id AS VARCHAR) = $1',
      String(row.id),
    );
    expect(result.rows).toEqual([{ body: 'second' }]);
  });
});
