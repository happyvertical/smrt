/**
 * Issue #2979: `conflictColumns` is an upsert IDENTITY, not a nullable
 * uniqueness constraint.
 *
 * The SDK's null-aware upsert matches conflict columns with
 * `IS NOT DISTINCT FROM` on every engine, and on PostgreSQL 15+ the framework
 * conflict index over a nullable column is emitted `NULLS NOT DISTINCT` so
 * `ON CONFLICT` agrees with that match (#1246, #2834). A second NEW object
 * whose nullable conflict column is NULL therefore resolves to the first
 * row — the documented contract, pinned here on both engines so it cannot be
 * silently changed.
 *
 * "At most one row per non-NULL value, any number of NULLs" is expressed with
 * a declared unique index (`@smrt({ indexes: [{ unique: true }] })`), which
 * is a plain UNIQUE index (NULLs distinct) on SQLite and PostgreSQL alike.
 *
 * SQLite runs always; PostgreSQL only when `SMRT_TEST_POSTGRES_URL` is set
 * (`pnpm test:postgres`).
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const IDENTITY = 'issue_2979_identity_rows';
const UNIQUE = 'issue_2979_unique_rows';
const UNIQUE_INDEX = 'issue_2979_unique_rows_amends_id_uidx';

@smrt({ tableName: 'issue_2979_identity_rows', conflictColumns: ['amends_id'] })
class Issue2979IdentityRow extends SmrtObject {
  @field({ type: 'text' })
  note: string = '';

  @field({ required: false, nullable: true })
  amendsId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.note === 'string') this.note = options.note;
    if (options.amendsId !== undefined) {
      this.amendsId = options.amendsId as string | null;
    }
  }
}

class Issue2979IdentityRowCollection extends SmrtCollection<Issue2979IdentityRow> {
  static readonly _itemClass = Issue2979IdentityRow;
}

@smrt({
  tableName: 'issue_2979_unique_rows',
  indexes: [
    {
      name: 'issue_2979_unique_rows_amends_id_uidx',
      columns: ['amendsId'],
      unique: true,
    },
  ],
})
class Issue2979UniqueRow extends SmrtObject {
  @field({ type: 'text' })
  note: string = '';

  @field({ required: false, nullable: true })
  amendsId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.note === 'string') this.note = options.note;
    if (options.amendsId !== undefined) {
      this.amendsId = options.amendsId as string | null;
    }
  }
}

class Issue2979UniqueRowCollection extends SmrtCollection<Issue2979UniqueRow> {
  static readonly _itemClass = Issue2979UniqueRow;
}

function schemaFor(ctor: typeof SmrtObject) {
  const registration = ObjectRegistry.getClassByConstructor(ctor);
  const className =
    registration?.qualifiedName || registration?.name || ctor.name;
  const schema = ObjectRegistry.getSchema(className);
  if (!schema) throw new Error(`Missing schema for ${className}`);
  return { className, schema };
}

type Engine = 'sqlite' | 'postgres';

async function openDb(engine: Engine): Promise<DatabaseInterface> {
  if (engine === 'postgres') {
    return (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-2979-${randomUUID()}`,
      max: 4,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
  }
  return (await getDatabase({
    type: 'sqlite',
    url: ':memory:',
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
}

async function createTable(
  db: DatabaseInterface,
  engine: Engine,
  ctor: typeof SmrtObject,
  table: string,
): Promise<void> {
  const { className, schema } = schemaFor(ctor);
  const ddl = ObjectRegistry.getSchemaDDL(className, engine);
  if (!ddl) throw new Error(`Missing DDL for ${className}`);
  await db.query(`DROP TABLE IF EXISTS "${table}"`);
  await db.query(ddl);
  for (const sql of getDDLStrategy(engine).generateIndexes(schema)) {
    await db.query(sql);
  }
}

async function rows(db: DatabaseInterface, table: string) {
  return (await db.list(table, {})) as Array<Record<string, unknown>>;
}

describe('issue #2979 schema flags', () => {
  it('marks only the nullable conflict identity NULL-equal; a declared unique index stays NULLs-distinct', () => {
    const identity = schemaFor(Issue2979IdentityRow).schema.indexes ?? [];
    const conflict = identity.find(
      (index) => index.unique && index.columns.join() === 'amends_id',
    );
    expect(conflict?.nullsNotDistinct).toBe(true);

    const declared = (schemaFor(Issue2979UniqueRow).schema.indexes ?? []).find(
      (index) => index.name === UNIQUE_INDEX,
    );
    if (!declared) throw new Error('declared unique index missing');
    expect(declared.unique).toBe(true);
    expect(declared.nullsNotDistinct).toBeFalsy();
    const pgSql = getDDLStrategy('postgres').generateIndexes({
      ...schemaFor(Issue2979UniqueRow).schema,
      indexes: [declared],
    });
    expect(pgSql.join('\n')).not.toMatch(/NULLS NOT DISTINCT/);
  });
});

const engines: Array<{ engine: Engine; enabled: boolean }> = [
  { engine: 'sqlite', enabled: true },
  { engine: 'postgres', enabled: Boolean(pgUrl) },
];

for (const { engine, enabled } of engines) {
  describe.skipIf(!enabled)(`nullable uniqueness on ${engine} (#2979)`, () => {
    let db: DatabaseInterface;

    beforeAll(async () => {
      db = await openDb(engine);
      await createTable(db, engine, Issue2979IdentityRow, IDENTITY);
      await createTable(db, engine, Issue2979UniqueRow, UNIQUE);
    }, 30_000);

    afterAll(async () => {
      if (!db) return;
      try {
        await db.query(`DROP TABLE IF EXISTS "${IDENTITY}"`);
        await db.query(`DROP TABLE IF EXISTS "${UNIQUE}"`);
      } finally {
        await db.close?.();
      }
    });

    beforeEach(async () => {
      await db.query(`DELETE FROM "${IDENTITY}"`);
      await db.query(`DELETE FROM "${UNIQUE}"`);
    });

    it('conflictColumns over a nullable column is a NULL-equal upsert identity (contract, unchanged)', async () => {
      const identity = await Issue2979IdentityRowCollection.create({ db });
      await identity.create({ note: 'first', slug: 'a' });
      await identity.create({ note: 'second', slug: 'b' });

      const all = await rows(db, IDENTITY);
      expect(all).toHaveLength(1);
      expect(all[0]?.note).toBe('second');

      await identity.create({ note: 'x', slug: 'c', amendsId: 'k1' });
      await identity.create({ note: 'y', slug: 'd', amendsId: 'k2' });
      expect(await rows(db, IDENTITY)).toHaveLength(3);
    });

    it('a declared unique index admits many NULLs and refuses a duplicate non-NULL value', async () => {
      const unique = await Issue2979UniqueRowCollection.create({ db });
      await unique.create({ note: 'orig-1', slug: 'o1' });
      await unique.create({ note: 'orig-2', slug: 'o2' });
      await unique.create({ note: 'orig-3', slug: 'o3' });
      await unique.create({ note: 'amend', slug: 'a1', amendsId: 'k1' });
      expect(await rows(db, UNIQUE)).toHaveLength(4);

      await expect(
        unique.create({ note: 'amend-again', slug: 'a2', amendsId: 'k1' }),
      ).rejects.toThrow();
      expect(await rows(db, UNIQUE)).toHaveLength(4);
    });

    it.skipIf(engine !== 'postgres')(
      'materializes the conflict index NULLS NOT DISTINCT and the declared index without it',
      async () => {
        const result = (await db.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = ANY($1)`,
          [[IDENTITY, UNIQUE]],
        )) as unknown as {
          rows?: Array<{ indexname: string; indexdef: string }>;
        };
        const indexes = Array.isArray(result) ? result : (result.rows ?? []);
        const conflict = indexes.find(
          (index) => index.indexname === `${IDENTITY}_amends_id_idx`,
        );
        expect(conflict?.indexdef).toMatch(/UNIQUE INDEX/);
        expect(conflict?.indexdef).toMatch(/NULLS NOT DISTINCT/);
        const declared = indexes.find(
          (index) => index.indexname === UNIQUE_INDEX,
        );
        expect(declared?.indexdef).toMatch(/UNIQUE INDEX/);
        expect(declared?.indexdef).not.toMatch(/NULLS NOT DISTINCT/);
      },
    );
  });
}
