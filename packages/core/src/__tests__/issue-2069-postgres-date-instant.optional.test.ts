/**
 * PostgreSQL Date instant contract for issue #2069.
 *
 * Runs only in the dedicated PostgreSQL shard. The database must be disposable:
 * this suite creates and drops its own issue-prefixed tables.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { createDispatchBus } from '../dispatch/bus.js';
import { BackfillTracker } from '../migrations/backfill-tracker.js';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { MigrationTracker } from '../migrations/tracker.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import type { SchemaDefinition } from '../schema/types.js';
import { migratePostgresSystemTimestamps } from '../system/compatibility.js';
import {
  CREATE_SMRT_BACKFILLS_TABLE,
  CREATE_SMRT_DISPATCH_TABLE,
  CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE,
  getSystemTableDDLForEngine,
  LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY,
  POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY,
} from '../system/schema.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_2069_date_instants';
const LEGACY_TABLE = 'issue_2069_legacy_date_instants';
const originalTimezone = process.env.TZ;

@smrt({ tableName: 'issue_2069_date_instants' })
class Issue2069DateInstant extends SmrtObject {
  occurredAt: Date = new Date(0);
  label: string = '';
}

class Issue2069DateInstantCollection extends SmrtCollection<Issue2069DateInstant> {
  static readonly _itemClass = Issue2069DateInstant;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Record<string, unknown>[];
  }
  return [];
}

function epoch(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return new Date(String(value)).getTime();
}

function restoreTimezone(): void {
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
}

async function createLegacyPostgresSystemTable(
  db: DatabaseInterface,
  abstractDdl: string,
): Promise<void> {
  const legacyDdl = getSystemTableDDLForEngine(
    abstractDdl,
    'postgres',
  ).replaceAll('TIMESTAMPTZ', 'TIMESTAMP');
  for (const statement of legacyDdl.split(';')) {
    if (statement.trim()) await db.query(statement);
  }
}

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('PostgreSQL Date instant persistence (#2069)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-date-instant-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    await db.query(`DROP TABLE IF EXISTS "${LEGACY_TABLE}"`);

    const registration =
      ObjectRegistry.getClassByConstructor(Issue2069DateInstant);
    const className =
      registration?.qualifiedName ||
      registration?.name ||
      Issue2069DateInstant.name;
    const schema = ObjectRegistry.getSchema(className);
    const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
    if (!schema || !ddl) {
      throw new Error(`Missing registered schema for ${className}`);
    }

    // Exercise the published registry DDL surface, not a test-only direct
    // SchemaGenerator call. The target engine must materialize manifest types.
    await db.query(ddl);
    expect(ObjectRegistry.getAllSchemas('postgres')[TABLE]?.ddl).toContain(
      'TIMESTAMPTZ',
    );
    for (const indexSql of getDDLStrategy('postgres').generateIndexes(schema)) {
      await db.query(indexSql);
    }
  });

  afterEach(() => {
    restoreTimezone();
  });

  afterAll(async () => {
    restoreTimezone();
    try {
      await db?.query(`DROP TABLE IF EXISTS "${LEGACY_TABLE}"`);
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await db?.close?.();
    }
  });

  for (const timezone of ['UTC', 'America/Edmonton']) {
    it(`preserves create, save/update, reload, and insert-only epochs under TZ=${timezone}`, async () => {
      process.env.TZ = timezone;
      await db.query(`TRUNCATE TABLE "${TABLE}"`);

      await db.transaction(async (tx) => {
        await tx.query(`SET LOCAL TIME ZONE '${timezone}'`);
        const sessionTimezone = rowsOf(await tx.query('SHOW TimeZone'))[0];
        expect(sessionTimezone?.TimeZone ?? sessionTimezone?.timezone).toBe(
          timezone,
        );
        const instants = await Issue2069DateInstantCollection.create({
          db: tx,
        });

        const createdInstant = new Date('2026-07-19T12:03:04.567Z');
        const created = await instants.create({
          label: `upsert-${timezone}`,
          occurredAt: createdInstant,
        });
        const createdReload = await instants.get(created.id);
        expect(epoch(createdReload?.occurredAt)).toBe(createdInstant.getTime());

        const updatedInstant = new Date('2026-11-01T08:30:45.123Z');
        created.occurredAt = updatedInstant;
        await created.save();
        const updatedReload = await instants.get(created.id);
        expect(epoch(updatedReload?.occurredAt)).toBe(updatedInstant.getTime());

        const insertInstant = new Date('2026-03-08T09:59:59.999Z');
        const inserted = await instants.create({
          id: randomUUID(),
          label: `insert-${timezone}`,
          occurredAt: insertInstant,
          _insertOnly: true,
        });
        const insertReload = await instants.get(inserted.id);
        expect(epoch(insertReload?.occurredAt)).toBe(insertInstant.getTime());
      });
    });
  }

  it('creates timezone-aware PostgreSQL columns for every SMRT Date field', async () => {
    const columns = rowsOf(
      await db.query(
        `SELECT column_name, data_type
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = '${TABLE}'`,
      ),
    );
    const types = new Map(
      columns.map((row) => [String(row.column_name), String(row.data_type)]),
    );

    expect(types.get('occurred_at')).toBe('timestamp with time zone');
    expect(types.get('created_at')).toBe('timestamp with time zone');
    expect(types.get('updated_at')).toBe('timestamp with time zone');
  });

  it('migrates legacy timezone-naive ISO wall times as UTC and reaches a clean re-diff', async () => {
    process.env.TZ = 'America/Edmonton';
    await db.query(
      `CREATE TABLE "${LEGACY_TABLE}" (
        "id" uuid PRIMARY KEY,
        "occurred_at" TIMESTAMP,
        "nullable_at" TIMESTAMP,
        "defaulted_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )`,
    );

    const id = randomUUID();
    const instant = new Date('2026-07-19T12:03:04.567Z');
    const sessionTimezone = rowsOf(await db.query('SHOW TimeZone'))[0];
    expect(sessionTimezone?.TimeZone ?? sessionTimezone?.timezone).toBe('UTC');
    // Match the SDK serializer used by legacy SMRT persistence before
    // PostgreSQL discarded the offset in a timezone-naive column.
    await db.insert(LEGACY_TABLE, { id, occurred_at: instant });

    // The legacy column drops the ISO offset. A non-UTC runtime therefore
    // demonstrates the old shifted hydration before the migration runs.
    const before = rowsOf(
      await db.query(
        `SELECT
           "occurred_at",
           to_char("occurred_at", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS occurred_wall_time,
           "nullable_at",
           EXTRACT(EPOCH FROM "defaulted_at" AT TIME ZONE 'UTC') * 1000 AS default_epoch
         FROM "${LEGACY_TABLE}"
         WHERE "id" = '${id}'`,
      ),
    )[0];
    // The legacy column retains the UTC wall clock but has discarded the
    // offset. Adapter parsing may already compensate, so assert the stored
    // database representation directly rather than depending on pg parser TZ.
    expect(before?.occurred_wall_time).toBe('2026-07-19T12:03:04.567');
    expect(before?.nullable_at).toBeNull();
    const defaultEpoch = Number(before?.default_epoch);
    expect(Number.isFinite(defaultEpoch)).toBe(true);

    const manifest: Record<string, SchemaDefinition> = {
      [LEGACY_TABLE]: {
        tableName: LEGACY_TABLE,
        ddl: '',
        columns: {
          id: { type: 'UUID', primaryKey: true },
          occurred_at: { type: 'TIMESTAMP' },
          nullable_at: { type: 'TIMESTAMP' },
          defaulted_at: { type: 'TIMESTAMP' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1.0.0',
      },
    };

    const comparer = new SchemaComparer(db, {
      ignoreTypeMismatches: false,
      postgresTimestampMigration: { legacyTimezone: 'UTC' },
    });
    const diff = await comparer.compare(manifest);
    expect(
      diff.changes.filter((change) => change.type === 'type_upgrade'),
    ).toHaveLength(3);
    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        type: 'type_upgrade',
        name: 'occurred_at',
        sql:
          `ALTER TABLE "${LEGACY_TABLE}" ALTER COLUMN "occurred_at" ` +
          `TYPE TIMESTAMPTZ USING "occurred_at" AT TIME ZONE 'UTC'`,
      }),
    );

    await db.transaction(async (tx) => {
      await tx.query(`SET LOCAL TIME ZONE 'UTC'`);
      for (const sql of getSQLFromDiff(diff)) {
        await tx.query(sql);
      }
    });

    const after = rowsOf(
      await db.query(
        `SELECT
           "occurred_at",
           "nullable_at",
           EXTRACT(EPOCH FROM "defaulted_at") * 1000 AS default_epoch
         FROM "${LEGACY_TABLE}"
         WHERE "id" = '${id}'`,
      ),
    )[0];
    expect(epoch(after?.occurred_at)).toBe(instant.getTime());
    expect(after?.nullable_at).toBeNull();
    expect(Number(after?.default_epoch)).toBeCloseTo(defaultEpoch, 3);
    expect((await comparer.compare(manifest)).has_changes).toBe(false);
  });

  it('upgrades the legacy change-feed timestamp and helper ABI atomically', async () => {
    await db.query(
      `DROP FUNCTION IF EXISTS ${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}`,
    );
    await db.query(
      `DROP FUNCTION IF EXISTS ${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}`,
    );
    await db.query('DROP TABLE IF EXISTS _smrt_changes');
    await db.query(`
      CREATE TABLE _smrt_changes (
        seq BIGSERIAL PRIMARY KEY,
        id TEXT NOT NULL,
        table_name TEXT NOT NULL,
        row_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        tenant_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await db.query(`
      CREATE FUNCTION _smrt_append_change(
        p_id TEXT,
        p_table_name TEXT,
        p_row_id TEXT,
        p_operation TEXT,
        p_created_at TIMESTAMP
      ) RETURNS TABLE(allocated_seq BIGINT, created_at TIMESTAMP)
      LANGUAGE SQL AS $$ SELECT 1::BIGINT, p_created_at $$
    `);

    await migratePostgresSystemTimestamps(
      db,
      { legacyTimezone: 'UTC' },
      'postgres',
    );

    const state = rowsOf(
      await db.query(`
        SELECT
          (SELECT data_type FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = '_smrt_changes'
             AND column_name = 'created_at') AS created_at_type,
          to_regprocedure('${LEGACY_POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}') AS legacy_helper,
          to_regprocedure('${POSTGRES_CHANGE_FEED_APPEND_FUNCTION_IDENTITY}') AS current_helper
      `),
    )[0];
    expect(state).toEqual(
      expect.objectContaining({
        created_at_type: 'timestamp with time zone',
        legacy_helper: null,
      }),
    );
    expect(state?.current_helper).toBeTruthy();
  });

  it('fails closed outside UTC and rolls back every system-table ALTER on failure', async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.query("SET LOCAL TIME ZONE 'America/Edmonton'");
        await migratePostgresSystemTimestamps(
          tx,
          { legacyTimezone: 'UTC' },
          'postgres',
        );
      }),
    ).rejects.toThrow('outside a UTC PostgreSQL session');

    await db.query('DROP VIEW IF EXISTS _smrt_atomic_z_view');
    await db.query('DROP TABLE IF EXISTS _smrt_atomic_a');
    await db.query('DROP TABLE IF EXISTS _smrt_atomic_z');
    await db.query(
      'CREATE TABLE _smrt_atomic_a (created_at TIMESTAMP NOT NULL)',
    );
    await db.query(
      'CREATE TABLE _smrt_atomic_z (created_at TIMESTAMP NOT NULL)',
    );
    await db.query(
      'CREATE VIEW _smrt_atomic_z_view AS SELECT created_at FROM _smrt_atomic_z',
    );

    await expect(
      migratePostgresSystemTimestamps(
        db,
        { legacyTimezone: 'UTC' },
        'postgres',
      ),
    ).rejects.toThrow();

    const types = rowsOf(
      await db.query(`
        SELECT table_name, data_type
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('_smrt_atomic_a', '_smrt_atomic_z')
          AND column_name = 'created_at'
        ORDER BY table_name
      `),
    );
    expect(types).toEqual([
      {
        table_name: '_smrt_atomic_a',
        data_type: 'timestamp without time zone',
      },
      {
        table_name: '_smrt_atomic_z',
        data_type: 'timestamp without time zone',
      },
    ]);

    await db.query('DROP VIEW _smrt_atomic_z_view');
    await db.query('DROP TABLE _smrt_atomic_a');
    await db.query('DROP TABLE _smrt_atomic_z');
  });

  it('materializes standalone PostgreSQL system-table initialization as TIMESTAMPTZ', async () => {
    await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
    await db.query('DROP TABLE IF EXISTS _smrt_dispatch');
    await db.query('DROP TABLE IF EXISTS _smrt_schema_migrations');
    await db.query('DROP TABLE IF EXISTS _smrt_backfills');

    await createDispatchBus({ db });
    await new MigrationTracker({ db, engineHint: 'postgres' }).initialize();
    await new BackfillTracker({ db }).initialize();

    const columns = rowsOf(
      await db.query(`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN (
            '_smrt_dispatch',
            '_smrt_dispatch_subscriptions',
            '_smrt_schema_migrations',
            '_smrt_backfills'
          )
          AND data_type LIKE 'timestamp%'
      `),
    );

    expect(columns.length).toBeGreaterThan(0);
    expect(columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table_name: '_smrt_backfills',
          column_name: 'applied_at',
        }),
      ]),
    );
    expect(new Set(columns.map((column) => column.data_type))).toEqual(
      new Set(['timestamp with time zone']),
    );
  });

  it('fails closed when standalone initializers encounter legacy system timestamps', async () => {
    await db.query('DROP TABLE IF EXISTS _smrt_dispatch_subscriptions');
    await db.query('DROP TABLE IF EXISTS _smrt_dispatch');
    await db.query('DROP TABLE IF EXISTS _smrt_schema_migrations');
    await db.query('DROP TABLE IF EXISTS _smrt_backfills');

    await createLegacyPostgresSystemTable(
      db,
      CREATE_SMRT_SCHEMA_MIGRATIONS_TABLE,
    );
    await expect(
      new MigrationTracker({ db, engineHint: 'postgres' }).initialize(),
    ).rejects.toThrow('_smrt_schema_migrations.applied_at');
    await db.query('DROP TABLE _smrt_schema_migrations');

    BackfillTracker.invalidateInitialization(db);
    await createLegacyPostgresSystemTable(db, CREATE_SMRT_BACKFILLS_TABLE);
    await expect(new BackfillTracker({ db }).initialize()).rejects.toThrow(
      '_smrt_backfills.applied_at',
    );
    await db.query('DROP TABLE _smrt_backfills');
    BackfillTracker.invalidateInitialization(db);

    await createLegacyPostgresSystemTable(db, CREATE_SMRT_DISPATCH_TABLE);
    await expect(createDispatchBus({ db })).rejects.toThrow(
      '_smrt_dispatch.created_at',
    );
    await db.query('DROP TABLE _smrt_dispatch');
  });
});
