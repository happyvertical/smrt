/**
 * Issue #3008: `db:migrate` could not add a required (NOT NULL) column
 * without a default to a table that already has rows — it added the column
 * nullable and exited 1, leaving the constraint half-applied.
 *
 * A field now declares a per-row SQL backfill
 * (`@field({ required: true, backfill: "'closed:' || id" })`). Migration adds
 * the column, fills every existing row from that expression, then enforces
 * NOT NULL and the unique conflict index, all inside the migration
 * transaction. Without a default or backfill the column is refused outright
 * with a message naming the table and column, and nothing is added.
 *
 * This pins the whole path from the decorator through
 * `getAllSchemasAsDefinitions()` and `migrateSmrtSchemas()` (the tracker's
 * transaction), with the claim-key shape from happyvertical/teamworks-os#49:
 * a derived non-null key under `conflictColumns`.
 *
 * SQLite runs in the default lane; PostgreSQL only when
 * `SMRT_TEST_POSTGRES_URL` is set (`pnpm test:postgres`).
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { field } from '../decorators/index.js';
import { REQUIRED_COLUMN_NOT_ADDED } from '../migrations/differ.js';
import { migrateSmrtSchemas } from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import type { SchemaDefinition } from '../schema/types.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const TABLE = 'issue_3008_punches';

@smrt({ tableName: 'issue_3008_punches', conflictColumns: ['open_key'] })
class Issue3008Punch extends SmrtObject {
  @field({ type: 'text' })
  worker: string = '';

  @field({ required: true, maxLength: 80, backfill: "'closed:' || id" })
  openKey: string = '';
}

@smrt({ tableName: 'issue_3008_punches_nobackfill' })
class Issue3008PunchNoBackfill extends SmrtObject {
  @field({ type: 'text' })
  worker: string = '';

  // No initializer, so no default either.
  @field({ required: true, maxLength: 80 })
  openKey!: string;
}

@smrt({ tableName: 'issue_3008_punches_nullish' })
class Issue3008PunchNullBackfill extends SmrtObject {
  @field({ type: 'text' })
  worker: string = '';

  // Yields NULL for rows whose worker is NULL.
  @field({ required: true, backfill: "'open:' || worker" })
  openKey!: string;
}

function schemaFor(ctor: typeof SmrtObject): SchemaDefinition {
  const registration = ObjectRegistry.getClassByConstructor(ctor);
  const className =
    registration?.qualifiedName || registration?.name || ctor.name;
  const schema =
    ObjectRegistry.getAllSchemasAsDefinitions()[
      ObjectRegistry.getTableName(className)
    ];
  if (!schema) throw new Error(`Missing schema for ${className}`);
  return schema;
}

type Engine = 'sqlite' | 'postgres';

async function openDb(engine: Engine): Promise<DatabaseInterface> {
  if (engine === 'postgres') {
    return (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-3008-${randomUUID()}`,
      max: 4,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
  }
  return (await getDatabase({
    type: 'sqlite',
    url: ':memory:',
  } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
}

/**
 * Create the table as it was BEFORE `open_key` existed (the v1 shape), and
 * seed it with rows written by the old model.
 */
/** Stable UUID ids (PostgreSQL stores `id` as uuid) that sort as p1, p2… */
const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function createV1(
  db: DatabaseInterface,
  engine: Engine,
  schema: SchemaDefinition,
  workers: Array<string | null>,
): Promise<void> {
  const { open_key: _dropped, ...columns } = schema.columns;
  const v1: SchemaDefinition = {
    ...schema,
    columns,
    indexes: (schema.indexes ?? []).filter(
      (index) => !index.columns.includes('open_key'),
    ),
  };
  const strategy = getDDLStrategy(engine);
  await db.query(`DROP TABLE IF EXISTS "${schema.tableName}"`);
  await db.query(strategy.generateCreateTable(v1));
  for (const sql of strategy.generateIndexes(v1)) await db.query(sql);
  for (const [index, worker] of workers.entries()) {
    await db.query(
      `INSERT INTO "${schema.tableName}" (id, slug, context, worker) VALUES (?, ?, '', ?)`,
      ID(index + 1),
      `p${index + 1}`,
      worker,
    );
  }
}

describe('issue #3008 schema metadata', () => {
  it('carries @field({ backfill }) into the migration schema column', () => {
    const column = schemaFor(Issue3008Punch).columns.open_key;
    expect(column).toMatchObject({
      notNull: true,
      backfill: "'closed:' || id",
    });
    expect(
      schemaFor(Issue3008PunchNoBackfill).columns.open_key.backfill,
    ).toBeUndefined();
  });

  it('never emits the backfill into CREATE TABLE DDL', () => {
    const ddl = getDDLStrategy('postgres').generateCreateTable(
      schemaFor(Issue3008Punch),
    );
    expect(ddl).not.toContain('closed:');
  });
});

const engines: Array<{ engine: Engine; enabled: boolean }> = [
  { engine: 'sqlite', enabled: true },
  { engine: 'postgres', enabled: Boolean(pgUrl) },
];

for (const { engine, enabled } of engines) {
  describe.skipIf(!enabled)(
    `adding a required column to a populated table on ${engine} (#3008)`,
    () => {
      let db: DatabaseInterface;
      const tables = [
        TABLE,
        'issue_3008_punches_nobackfill',
        'issue_3008_punches_nullish',
      ];

      beforeAll(async () => {
        db = await openDb(engine);
      }, 30_000);

      afterEach(() => {
        vi.restoreAllMocks();
      });

      beforeEach(async () => {
        for (const table of tables) {
          await db.query(`DROP TABLE IF EXISTS "${table}"`);
        }
      });

      afterAll(async () => {
        if (!db) return;
        try {
          for (const table of tables) {
            await db.query(`DROP TABLE IF EXISTS "${table}"`);
          }
        } finally {
          await db.close?.();
        }
      });

      function migrate(schema: SchemaDefinition) {
        vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
          [schema.tableName]: schema,
        });
        return migrateSmrtSchemas({
          db,
          packageName: 'issue-3008-test',
          name: `issue_3008_${randomUUID().slice(0, 8)}`,
          ...(engine === 'postgres' ? { engineHint: 'postgres' } : {}),
        });
      }

      it('backfills a derived claim key per row, then enforces NOT NULL and the conflict index', async () => {
        const schema = schemaFor(Issue3008Punch);
        await createV1(db, engine, schema, ['ann', 'bob']);

        const result = await migrate(schema);
        expect(result.hasManualDrift).toBe(false);
        expect(result.applied).toBe(true);

        const rows = (
          await db.query(`SELECT id, open_key FROM "${TABLE}" ORDER BY id`)
        ).rows;
        expect(rows).toEqual([
          { id: ID(1), open_key: `closed:${ID(1)}` },
          { id: ID(2), open_key: `closed:${ID(2)}` },
        ]);

        // NOT NULL enforced.
        await expect(
          db.query(
            `INSERT INTO "${TABLE}" (id, slug, context, worker, open_key) VALUES ('${ID(3)}', 'p3', '', 'cy', NULL)`,
          ),
        ).rejects.toThrow();
        // The conflict (unique) index was built over the backfilled values.
        await expect(
          db.query(
            `INSERT INTO "${TABLE}" (id, slug, context, worker, open_key) VALUES ('${ID(4)}', 'p4', '', 'cy', 'closed:${ID(1)}')`,
          ),
        ).rejects.toThrow();
        await db.query(
          `INSERT INTO "${TABLE}" (id, slug, context, worker, open_key) VALUES ('${ID(5)}', 'p5', '', 'cy', 'open:cy')`,
        );

        // Converged: a second run has nothing to do.
        const again = await migrate(schema);
        expect(again.applied).toBe(false);
        expect(again.hasManualDrift).toBe(false);
      });

      it('refuses a required column with no default or backfill, naming table and column, and adds nothing', async () => {
        const schema = schemaFor(Issue3008PunchNoBackfill);
        await createV1(db, engine, schema, ['ann']);

        const result = await migrate(schema);
        expect(result.hasManualDrift).toBe(true);
        const [blocked] = result.unactionableChanges;
        expect(blocked).toMatchObject({
          table: 'issue_3008_punches_nobackfill',
          name: 'open_key',
          mismatch: { actual: REQUIRED_COLUMN_NOT_ADDED },
        });
        expect(blocked.advisory?.message).toMatch(
          /^issue_3008_punches_nobackfill\.open_key was not added: .*backfill/,
        );

        const live = await db.getTableSchema?.('issue_3008_punches_nobackfill');
        expect(Object.keys(live?.columns ?? {})).not.toContain('open_key');
      });

      it('refuses the column, naming it, when the backfill yields NULL for a row', async () => {
        const schema = schemaFor(Issue3008PunchNullBackfill);
        await createV1(db, engine, schema, ['ann', null]);

        const result = await migrate(schema);
        expect(result.hasManualDrift).toBe(true);
        expect(result.unactionableChanges[0]?.advisory?.message).toMatch(
          /^issue_3008_punches_nullish\.open_key was not added: its declared backfill .* yields NULL/,
        );
        // Nothing half-applied.
        const live = await db.getTableSchema?.('issue_3008_punches_nullish');
        expect(Object.keys(live?.columns ?? {})).not.toContain('open_key');
        const rows = (
          await db.query(
            'SELECT id FROM "issue_3008_punches_nullish" ORDER BY id',
          )
        ).rows;
        expect(rows).toEqual([{ id: ID(1) }, { id: ID(2) }]);
      });
    },
  );
}
