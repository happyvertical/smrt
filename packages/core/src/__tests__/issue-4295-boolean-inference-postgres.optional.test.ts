/**
 * #4295 on PostgreSQL: a compiled model registered without a manifest infers
 * BOOLEAN from `@field({ required: true, default: false })`, so the runtime
 * DDL builds a native boolean column and a saved value round-trips as one.
 */
import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'issue_4295_postgres_boolean_rows';
const PKG = '@fixture/issue-4295-pg';

// Compiled legacy-decorator shape: no `@smrt()` syntax, so no manifest entry.
const Issue4295PgRow = class Issue4295PgRow extends SmrtObject {
  importedMarker = false;
};
field({ required: true, default: false })(
  Issue4295PgRow.prototype,
  'importedMarker',
);
smrt({ packageName: PKG, tableName: TABLE })(Issue4295PgRow);

const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('PostgreSQL runtime boolean inference (#4295)', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;

  beforeAll(async () => {
    db = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-4295-${randomUUID()}`,
    } as Parameters<typeof getDatabase>[0]);
    await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    // The registry (runtime) schema path, as `getAllSchemasAsDefinitions()`.
    const schema = ObjectRegistry.getAllSchemas('postgres')[TABLE];
    if (!schema?.ddl) throw new Error('Missing runtime DDL for Issue4295PgRow');
    await db.query(schema.ddl);
    for (const indexSql of schema.indexes ?? []) await db.query(indexSql);
  });

  afterAll(async () => {
    try {
      await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
    } finally {
      await db?.close?.();
    }
  });

  it('creates a native boolean column and round-trips true', async () => {
    const result = (await db.query(
      `SELECT data_type, column_default FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = '${TABLE}' AND column_name = 'imported_marker'`,
    )) as unknown;
    const columns = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] }).rows;
    expect(columns).toEqual([
      { data_type: 'boolean', column_default: 'false' },
    ]);

    const row = await new Issue4295PgRow({ db }).initialize();
    row.importedMarker = true;
    await row.save();
    const fresh = await new Issue4295PgRow({
      db,
      id: row.id ?? undefined,
    }).initialize();
    expect(fresh.importedMarker).toBe(true);
  });
});
