/**
 * A delete cascade treats a referencing table this database never created as
 * empty, on every engine: on PostgreSQL the tolerated statement runs under a
 * savepoint, so it does not abort the delete's transaction. A missing column
 * in a table that does exist is not tolerated: the delete fails and nothing is
 * removed. Runs on SQLite by default and on PGlite under `pnpm test:pglite`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database';

@smrt({ tableName: 'cascade_missing_parents' })
class CascadeMissingParent extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class CascadeMissingParentCollection extends SmrtCollection<CascadeMissingParent> {
  static readonly _itemClass = CascadeMissingParent;
}

@smrt({ tableName: 'cascade_missing_children' })
class CascadeMissingChild extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @foreignKey('CascadeMissingParent', { onDelete: 'CASCADE' })
  parentId: string | null = null;
}
class CascadeMissingChildCollection extends SmrtCollection<CascadeMissingChild> {
  static readonly _itemClass = CascadeMissingChild;
}

@smrt({ tableName: 'cascade_missing_nulls' })
class CascadeMissingNull extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @foreignKey('CascadeMissingParent', { onDelete: 'SET NULL' })
  parentId: string | null = null;
}
class CascadeMissingNullCollection extends SmrtCollection<CascadeMissingNull> {
  static readonly _itemClass = CascadeMissingNull;
}

// Registered, but its table is never created in these databases.
@smrt({ tableName: 'cascade_missing_unmigrated' })
class CascadeMissingUnmigrated extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @foreignKey('CascadeMissingParent', { onDelete: 'RESTRICT' })
  parentId: string | null = null;
}

type Engine = 'sqlite' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite'];

describe.each(
  engines,
)('cascade with a missing referencing table on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let parents: CascadeMissingParentCollection;
  let children: CascadeMissingChildCollection;
  let nulls: CascadeMissingNullCollection;

  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.registerCollection(
      'CascadeMissingParent',
      CascadeMissingParentCollection,
    );
    ObjectRegistry.registerCollection(
      'CascadeMissingChild',
      CascadeMissingChildCollection,
    );
    ObjectRegistry.registerCollection(
      'CascadeMissingNull',
      CascadeMissingNullCollection,
    );
    void CascadeMissingUnmigrated;
    db = await getTestDatabase({
      type: engine,
      ...(engine === 'sqlite' ? { url: ':memory:' } : {}),
      classes: [
        'CascadeMissingParent',
        'CascadeMissingChild',
        'CascadeMissingNull',
      ],
      omitForeignKeyConstraints: true,
    });
    parents = (await CascadeMissingParentCollection.create({ db })) as never;
    children = (await CascadeMissingChildCollection.create({ db })) as never;
    nulls = (await CascadeMissingNullCollection.create({ db })) as never;
  });

  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  async function seed() {
    const parent = await parents.create({ title: 'parent' } as never);
    const child = await children.create({
      title: 'child',
      parentId: parent.id,
    } as never);
    const nulled = await nulls.create({
      title: 'nulled',
      parentId: parent.id,
    } as never);
    return { parent, child, nulled };
  }

  async function count(table: string, id: string): Promise<number> {
    const result = await db.query(
      `SELECT COUNT(*) AS n FROM ${table} WHERE CAST(id AS VARCHAR) = $1`,
      id,
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  it('deletes the parent and cascades when a referencing table was never created', async () => {
    const { parent, child, nulled } = await seed();

    await parents.delete(String(parent.id));

    expect(await count('cascade_missing_parents', String(parent.id))).toBe(0);
    expect(await count('cascade_missing_children', String(child.id))).toBe(0);
    const rows = await db.query(
      'SELECT parent_id FROM cascade_missing_nulls WHERE CAST(id AS VARCHAR) = $1',
      String(nulled.id),
    );
    expect(rows.rows).toEqual([{ parent_id: null }]);
  });

  it('refuses the delete when a referencing table lacks the reference column', async () => {
    const { parent, child } = await seed();
    await db.query(
      'ALTER TABLE cascade_missing_children RENAME COLUMN parent_id TO legacy_parent',
    );

    await expect(parents.delete(String(parent.id))).rejects.toThrow();

    expect(await count('cascade_missing_parents', String(parent.id))).toBe(1);
    expect(await count('cascade_missing_children', String(child.id))).toBe(1);
  });

  it('refuses the delete when a SET NULL table lacks a column the update writes', async () => {
    const { parent, nulled } = await seed();
    await db.query(
      'ALTER TABLE cascade_missing_nulls DROP COLUMN _sync_origin_device_id',
    );

    await expect(parents.delete(String(parent.id))).rejects.toThrow();

    expect(await count('cascade_missing_parents', String(parent.id))).toBe(1);
    const rows = await db.query(
      'SELECT CAST(parent_id AS VARCHAR) AS parent_id FROM cascade_missing_nulls WHERE CAST(id AS VARCHAR) = $1',
      String(nulled.id),
    );
    expect(rows.rows).toEqual([{ parent_id: parent.id }]);
  });
});
