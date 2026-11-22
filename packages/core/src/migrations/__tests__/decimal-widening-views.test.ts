/**
 * Widening a legacy 4-byte decimal column to DOUBLE on DuckDB never touches a
 * view (P5a).
 *
 * DuckDB binds a view's result types when the view is created, so a view that
 * projects a widened column fails every later query. SMRT does not drop,
 * create or replace views: it changes the column, then asks DuckDB whether
 * every view still binds (one `SELECT * FROM "db"."schema"."view" LIMIT 0`
 * per view, after the last changing statement). If one does not, the whole
 * migration rolls back and the error names the view. A plan with a type
 * upgrade is refused while any view does not bind, and a saved plan stops
 * when a view, the target database or schema, or the source type changed
 * after planning.
 */
import {
  copyFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseInterface } from '@happyvertical/sql';
import { clearConnectionCache, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SchemaDefinition, SchemaDiff } from '../../schema/types.js';
import { isCommentOnlySql } from '../change-kinds.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { planDuckDbTableChanges } from '../duckdb-rebuild.js';
import { createMigrationDefinition } from '../generator.js';
import { MigrationTracker } from '../tracker.js';
import {
  asViewsChangedSincePlan,
  DependentViewCheckError,
  DependentViewTypeError,
  MigrationTransactionRequiredError,
  ViewInvalidatedAfterCommitWarning,
} from '../view-guard.js';

const VALUE = 16777217.25;
const VIEW_DDL =
  /^\s*(CREATE(\s+OR\s+REPLACE)?(\s+TEMP(ORARY)?)?\s+VIEW|DROP\s+VIEW|ALTER\s+VIEW)\b/i;

const prices = (extra: SchemaDefinition['columns'] = {}): SchemaDefinition => ({
  tableName: 'decimal_prices',
  columns: {
    id: { type: 'TEXT', primaryKey: true },
    amount: { type: 'REAL' },
    ...extra,
  },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '1',
});

let counter = 0;
const migrationName = () => `p5a_views_${Date.now()}_${counter++}`;

async function plan(
  db: DatabaseInterface,
  schemas: Record<string, SchemaDefinition>,
): Promise<SchemaDiff> {
  return new SchemaComparer(db, { engineHint: 'duckdb' }).compare(schemas);
}

const statementsOf = (diff: SchemaDiff) =>
  getSQLFromDiff(diff).filter((sql) => !isCommentOnlySql(sql));

async function apply(db: DatabaseInterface, statements: string[]) {
  const tracker = new MigrationTracker({ db, engineHint: 'duckdb' });
  await tracker.initialize();
  const [result] = await tracker.applyAll(
    [createMigrationDefinition(migrationName(), statements)],
    { atomic: true },
  );
  return result;
}

async function migrate(
  db: DatabaseInterface,
  schemas: Record<string, SchemaDefinition>,
) {
  return apply(db, statementsOf(await plan(db, schemas)));
}

async function columnType(
  db: DatabaseInterface,
  table: string,
  column = 'amount',
) {
  const { rows } = await db.query(
    `SELECT data_type FROM duckdb_columns() WHERE database_name = current_database() AND schema_name = 'main' AND table_name = ? AND column_name = ?`,
    table,
    column,
  );
  return String(rows[0]?.data_type ?? '');
}

async function viewOids(db: DatabaseInterface) {
  const { rows } = await db.query(
    'SELECT schema_name, view_name, CAST(view_oid AS VARCHAR) AS oid FROM duckdb_views() WHERE NOT internal ORDER BY schema_name, view_name',
  );
  return rows.map((row) => `${row.schema_name}.${row.view_name}:${row.oid}`);
}

async function stagingTables(db: DatabaseInterface) {
  const { rows } = await db.query(
    "SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '\\_smrt\\_rebuild%' ESCAPE '\\'",
  );
  return rows.map((row) => String(row.table_name));
}

async function binds(db: DatabaseInterface, qualified: string) {
  try {
    await db.query(`SELECT * FROM ${qualified} LIMIT 0`);
    return true;
  } catch {
    return false;
  }
}

describe('DuckDB decimal widening under views', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    await db.query(
      'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, amount REAL)',
    );
    await db.query("INSERT INTO decimal_prices VALUES ('a', 1.5), ('b', 2.25)");
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function expectUnchanged(oids: string[]) {
    expect(await columnType(db, 'decimal_prices')).toBe('FLOAT');
    expect(await viewOids(db)).toEqual(oids);
    expect(await stagingTables(db)).toEqual([]);
    const { rows } = await db.query(
      'SELECT id, amount FROM decimal_prices ORDER BY id',
    );
    expect(rows.map((row) => [row.id, Number(row.amount)])).toEqual([
      ['a', 1.5],
      ['b', 2.25],
    ]);
  }

  it('refuses the widening when a view projects the column, and changes nothing', async () => {
    await db.query(
      'CREATE VIEW price_view AS SELECT id, amount FROM decimal_prices',
    );
    const oids = await viewOids(db);

    const result = await migrate(db, { decimal_prices: prices() });

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(DependentViewTypeError);
    const error = result.error as DependentViewTypeError;
    expect(error.view).toEqual({
      database: 'memory',
      schema: 'main',
      name: 'price_view',
    });
    expect(error.message).toContain('"memory"."main"."price_view"');
    expect(error.message).toContain('nothing was changed');
    await expectUnchanged(oids);
    expect(await binds(db, 'price_view')).toBe(true);
  });

  it('refuses when a view in another schema projects the column', async () => {
    await db.query('CREATE SCHEMA reporting');
    await db.query(
      'CREATE VIEW reporting.price_view AS SELECT amount FROM main.decimal_prices',
    );
    const oids = await viewOids(db);

    const result = await migrate(db, { decimal_prices: prices() });

    expect(result.error).toBeInstanceOf(DependentViewTypeError);
    expect((result.error as Error).message).toContain(
      '"memory"."reporting"."price_view"',
    );
    await expectUnchanged(oids);
  });

  it('does not depend on view creation order', async () => {
    // A parent view replaced after its child holds a higher oid than it.
    await db.query(
      'CREATE VIEW price_parent AS SELECT id, amount FROM decimal_prices',
    );
    await db.query(
      'CREATE VIEW price_child AS SELECT amount FROM price_parent',
    );
    await db.query(
      'CREATE OR REPLACE VIEW price_parent AS SELECT id, amount FROM decimal_prices',
    );
    const oids = await viewOids(db);

    const result = await migrate(db, { decimal_prices: prices() });

    expect(result.error).toBeInstanceOf(DependentViewTypeError);
    await expectUnchanged(oids);
    expect(await binds(db, 'price_parent')).toBe(true);
    expect(await binds(db, 'price_child')).toBe(true);
  });

  it('leaves an unrelated view and its comments untouched', async () => {
    await db.query('CREATE TABLE other_things (id TEXT, label TEXT)');
    await db.query(
      'CREATE VIEW other_view AS SELECT id, label FROM other_things',
    );
    await db.query("COMMENT ON VIEW other_view IS 'it''s a view */ -- kept'");
    await db.query("COMMENT ON COLUMN other_view.label IS 'label comment'");
    const oids = await viewOids(db);

    const result = await migrate(db, { decimal_prices: prices() });

    expect(result.error).toBeUndefined();
    expect(await columnType(db, 'decimal_prices')).toBe('DOUBLE');
    expect(await viewOids(db)).toEqual(oids);
    const view = await db.query(
      "SELECT comment FROM duckdb_views() WHERE view_name = 'other_view'",
    );
    expect(view.rows[0]?.comment).toBe("it's a view */ -- kept");
    const column = await db.query(
      "SELECT comment FROM duckdb_columns() WHERE table_name = 'other_view' AND column_name = 'label'",
    );
    expect(column.rows[0]?.comment).toBe('label comment');
  });

  it('widens under views that still bind, and blocks planning on a view that does not bind', async () => {
    await db.query('CREATE VIEW price_ids AS SELECT id FROM decimal_prices');
    await db.query(
      'CREATE VIEW price_count AS SELECT count(*) AS n FROM decimal_prices',
    );
    // A view broken before the run: its join table is gone.
    await db.query('CREATE TABLE price_lookup (id TEXT)');
    await db.query(
      'CREATE VIEW price_joined AS SELECT p.amount FROM decimal_prices p JOIN price_lookup l ON l.id = p.id',
    );
    await db.query('DROP TABLE price_lookup');
    const oids = await viewOids(db);

    const blocked = await plan(db, { decimal_prices: prices() });
    const upgrade = blocked.changes.find(
      (change) => change.type === 'type_upgrade',
    );
    expect(upgrade?.kindHint).toBe('type.rebuild-unavailable');
    expect(upgrade?.sql).toContain('"memory"."main"."price_joined"');
    expect(statementsOf(blocked)).toEqual([]);
    await expectUnchanged(oids);

    // Restored, the view binds again, projects the column, and stops the run.
    await db.query('CREATE TABLE price_lookup (id TEXT)');
    const refused = await migrate(db, { decimal_prices: prices() });
    expect(refused.error).toBeInstanceOf(DependentViewTypeError);
    expect((refused.error as Error).message).toContain('price_joined');
    await expectUnchanged(oids);

    // Without the projecting view the widening applies under the others.
    await db.query('DROP VIEW price_joined');
    const applied = await migrate(db, { decimal_prices: prices() });
    expect(applied.error).toBeUndefined();
    expect(await columnType(db, 'decimal_prices')).toBe('DOUBLE');
    expect(await binds(db, 'price_ids')).toBe(true);
    expect(await binds(db, 'price_count')).toBe(true);
    expect(
      (await db.query('SELECT n FROM price_count')).rows[0]?.n,
    ).toBeDefined();
  });

  it('emits no view DDL for any type upgrade', async () => {
    await db.query(
      'CREATE INDEX decimal_prices_amount ON decimal_prices (amount)',
    );
    await db.query('CREATE VIEW price_ids AS SELECT id FROM decimal_prices');
    await db.query(
      'CREATE TABLE price_children (id TEXT PRIMARY KEY, price_id TEXT REFERENCES decimal_prices(id), share REAL)',
    );
    const diff = await plan(db, {
      decimal_prices: {
        ...prices(),
        indexes: [{ name: 'decimal_prices_amount', columns: ['amount'] }],
      },
      price_children: {
        tableName: 'price_children',
        columns: {
          id: { type: 'TEXT', primaryKey: true },
          price_id: { type: 'TEXT' },
          share: { type: 'REAL' },
        },
        indexes: [],
        triggers: [],
        foreignKeys: [],
        dependencies: [],
        version: '1',
      },
    });
    const statements = statementsOf(diff);
    expect(statements.length).toBeGreaterThan(0);
    expect(statements.filter((sql) => VIEW_DDL.test(sql))).toEqual([]);
    // The probes are the last statements of the plan.
    const probes = statements.filter((sql) =>
      /^SELECT \* FROM "[^"]+"\."[^"]+"\."[^"]+" LIMIT 0$/.test(sql),
    );
    expect(probes).toEqual([
      'SELECT * FROM "memory"."main"."price_ids" LIMIT 0',
    ]);
    expect(statements[statements.length - 1]).toBe(probes[0]);
  });

  it('probes quoted names, table macros and temporary views by three-part name', async () => {
    await db.query('CREATE SCHEMA "odd -- */ schema"');
    await db.query(
      'CREATE VIEW "odd -- */ schema"."we""ird */ -- view" AS SELECT amount FROM main.decimal_prices',
    );
    const quoted = await migrate(db, { decimal_prices: prices() });
    expect(quoted.error).toBeInstanceOf(DependentViewTypeError);
    expect((quoted.error as DependentViewTypeError).view).toEqual({
      database: 'memory',
      schema: 'odd -- */ schema',
      name: 'we"ird */ -- view',
    });
    expect(await columnType(db, 'decimal_prices')).toBe('FLOAT');
    await db.query('DROP VIEW "odd -- */ schema"."we""ird */ -- view"');

    await db.query(
      'CREATE MACRO price_rows() AS TABLE SELECT id, amount FROM decimal_prices',
    );
    await db.query('CREATE VIEW macro_view AS SELECT * FROM price_rows()');
    const macro = await migrate(db, { decimal_prices: prices() });
    expect(macro.error).toBeInstanceOf(DependentViewTypeError);
    expect((macro.error as Error).message).toContain('macro_view');
    await db.query('DROP VIEW macro_view');

    // A temporary view of the same name does not hide the persistent one.
    await db.query(
      'CREATE VIEW shadowed AS SELECT id, amount FROM decimal_prices',
    );
    await db.query(
      'CREATE TEMP VIEW shadowed AS SELECT id FROM decimal_prices',
    );
    const shadow = await migrate(db, { decimal_prices: prices() });
    expect(shadow.error).toBeInstanceOf(DependentViewTypeError);
    expect((shadow.error as DependentViewTypeError).view).toEqual({
      database: 'memory',
      schema: 'main',
      name: 'shadowed',
    });
    expect(await columnType(db, 'decimal_prices')).toBe('FLOAT');
  });

  it('documented recovery leaves inner and outer views binding', async () => {
    await db.query(
      'CREATE VIEW price_inner AS SELECT id, amount FROM decimal_prices',
    );
    await db.query('CREATE VIEW price_outer AS SELECT amount FROM price_inner');
    const refused = await migrate(db, { decimal_prices: prices() });
    expect(refused.error).toBeInstanceOf(DependentViewTypeError);

    // Dropping only the named inner view leaves the outer one unbound, and
    // planning names it.
    const inner = String(
      (
        await db.query(
          "SELECT sql FROM duckdb_views() WHERE view_name = 'price_inner'",
        )
      ).rows[0]?.sql,
    );
    await db.query('DROP VIEW price_inner');
    const blocked = await plan(db, { decimal_prices: prices() });
    expect(
      blocked.changes.find((change) => change.type === 'type_upgrade')?.sql,
    ).toContain('"memory"."main"."price_outer"');

    // The documented sequence: drop every view that reads it, migrate,
    // recreate them in order, keeping the published FLOAT with a cast.
    const outer = String(
      (
        await db.query(
          "SELECT sql FROM duckdb_views() WHERE view_name = 'price_outer'",
        )
      ).rows[0]?.sql,
    );
    expect(inner).toContain('price_inner');
    expect(outer).toContain('price_outer');
    await db.query('DROP VIEW price_outer');
    const applied = await migrate(db, { decimal_prices: prices() });
    expect(applied.error).toBeUndefined();
    expect(await columnType(db, 'decimal_prices')).toBe('DOUBLE');
    await db.query(
      'CREATE VIEW price_inner AS SELECT id, amount::FLOAT AS amount FROM decimal_prices',
    );
    await db.query(outer);
    expect(await binds(db, '"memory"."main"."price_inner"')).toBe(true);
    expect(await binds(db, '"memory"."main"."price_outer"')).toBe(true);
  });

  it('names the migration and every changed table, and separates check failures from staleness', async () => {
    await db.query('CREATE TABLE extra_items (id TEXT PRIMARY KEY)');
    await db.query('CREATE VIEW extra_view AS SELECT * FROM extra_items');
    const extra: SchemaDefinition = {
      tableName: 'extra_items',
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        label: { type: 'TEXT' },
      },
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1',
    };
    const oids = await viewOids(db);
    const result = await migrate(db, {
      decimal_prices: prices(),
      extra_items: extra,
    });
    expect(result.error).toBeInstanceOf(DependentViewTypeError);
    const error = result.error as DependentViewTypeError;
    expect(error.view.name).toBe('extra_view');
    expect(error.tables).toEqual(
      expect.arrayContaining(['decimal_prices', 'extra_items']),
    );
    expect(error.message).toContain('decimal_prices');
    expect(error.message).toContain('extra_items');
    expect(error.message).toContain(result.name);
    await expectUnchanged(oids);
    await db.query('DROP VIEW extra_view');

    // A view that bound at planning and cannot be checked at apply stops the
    // run with a different error: nothing about it says it is stale.
    const dir = mkdtempSync(path.join(tmpdir(), 'smrt-view-source-'));
    try {
      const file = path.join(dir, 'rates.csv');
      writeFileSync(file, 'code,rate\nx,1\n');
      await db.query(
        `CREATE VIEW rate_view AS SELECT * FROM read_csv('${file.replace(/'/g, "''")}')`,
      );
      const statements = statementsOf(
        await plan(db, { decimal_prices: prices() }),
      );
      rmSync(file);
      const failed = await apply(db, statements);
      expect(failed.error).toBeInstanceOf(DependentViewCheckError);
      expect((failed.error as Error).message).toContain('rate_view');
      expect(await columnType(db, 'decimal_prices')).toBe('FLOAT');
      expect(await stagingTables(db)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back when a statement of the plan fails', async () => {
    const statements = statementsOf(
      await plan(db, { decimal_prices: prices() }),
    );
    expect(statements.length).toBeGreaterThan(0);
    for (const mode of ['apply', 'applyAll'] as const) {
      let failed = false;
      const failing = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== 'transaction')
            return Reflect.get(target, property, receiver);
          return (callback: (tx: DatabaseInterface) => Promise<unknown>) =>
            target.transaction?.((tx) =>
              callback(
                new Proxy(tx, {
                  get(inner, key, innerReceiver) {
                    if (key !== 'query')
                      return Reflect.get(inner, key, innerReceiver);
                    return async (sql: string, ...args: unknown[]) => {
                      if (
                        !failed &&
                        /^INSERT INTO "memory"\."main"\."decimal_prices"/.test(
                          String(sql),
                        )
                      ) {
                        failed = true;
                        throw new Error('interrupted copy');
                      }
                      return inner.query(sql, ...args);
                    };
                  },
                }),
              ),
            );
        },
      }) as DatabaseInterface;
      const tracker = new MigrationTracker({
        db: failing,
        engineHint: 'duckdb',
      });
      await tracker.initialize();
      const definition = createMigrationDefinition(migrationName(), statements);
      const result =
        mode === 'apply'
          ? await tracker.apply(definition)
          : (await tracker.applyAll([definition], { atomic: true }))[0];
      expect(failed).toBe(true);
      expect(result.success).toBe(false);
      expect(String((result.error as Error)?.message)).toContain(
        'interrupted copy',
      );
      await expectUnchanged([]);
    }
  });

  it('refuses a plan on an adapter without transactions', async () => {
    const statements = statementsOf(
      await plan(db, { decimal_prices: prices() }),
    );
    const ran: string[] = [];
    const noTransactions = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction' || property === 'beginTransaction')
          return undefined;
        if (property === 'query')
          return (sql: string, ...args: unknown[]) => {
            ran.push(String(sql));
            return target.query(sql, ...args);
          };
        return Reflect.get(target, property, receiver);
      },
    }) as DatabaseInterface;
    const tracker = new MigrationTracker({
      db: noTransactions,
      engineHint: 'duckdb',
    });
    await tracker.initialize();
    ran.length = 0;
    const applied = await tracker.apply(
      createMigrationDefinition(migrationName(), statements),
    );
    expect(applied.error).toBeInstanceOf(MigrationTransactionRequiredError);
    const [batched] = await tracker.applyAll([
      createMigrationDefinition(migrationName(), statements),
    ]);
    expect(batched.error).toBeInstanceOf(MigrationTransactionRequiredError);
    expect(ran.filter((sql) => statements.includes(sql))).toEqual([]);
    await expectUnchanged([]);
  });
});

describe('a saved DuckDB widening plan', () => {
  let dir: string;
  let db: DatabaseInterface;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'smrt-saved-plan-'));
    await clearConnectionCache();
    db = await getDatabase({
      type: 'duckdb',
      url: path.join(dir, 'plan_a.db'),
    });
    await db.query(
      'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, amount REAL)',
    );
    await db.query("INSERT INTO decimal_prices VALUES ('a', 1.5)");
    await db.query('CREATE VIEW price_ids AS SELECT id FROM decimal_prices');
  });

  afterEach(async () => {
    await db?.close?.();
    await clearConnectionCache();
    rmSync(dir, { recursive: true, force: true });
  });

  async function runSaved(target: DatabaseInterface, statements: string[]) {
    try {
      await target.transaction?.(async (tx) => {
        for (const sql of statements) await tx.query(sql);
      });
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it.each([
    [
      'a view was created',
      'CREATE VIEW price_late AS SELECT id FROM decimal_prices',
    ],
    [
      'a view was replaced',
      "CREATE OR REPLACE VIEW price_ids AS SELECT id, 'x' AS tag FROM decimal_prices",
    ],
    ['a view was dropped', 'DROP VIEW price_ids'],
    [
      'the source type changed',
      [
        'ALTER TABLE decimal_prices ALTER COLUMN amount TYPE BIGINT',
        'UPDATE decimal_prices SET amount = 9007199254740993',
      ],
    ],
    [
      'another schema is current',
      [
        'CREATE SCHEMA tenant_b',
        'CREATE TABLE tenant_b.decimal_prices (id TEXT PRIMARY KEY, amount REAL)',
        "INSERT INTO tenant_b.decimal_prices VALUES ('b', 2.5)",
        'CREATE VIEW tenant_b.price_ids AS SELECT id FROM tenant_b.decimal_prices',
        "SET schema = 'tenant_b'",
      ],
    ],
  ])('stops a saved plan when views, source type, schema or catalog changed after planning (%s)', async (_label, change) => {
    const statements = statementsOf(
      await plan(db, { decimal_prices: prices() }),
    );
    expect(statements.length).toBeGreaterThan(0);
    const types = async () =>
      (
        await db.query(
          "SELECT schema_name, data_type FROM duckdb_columns() WHERE table_name = 'decimal_prices' AND column_name = 'amount' ORDER BY schema_name",
        )
      ).rows.map((row) => `${row.schema_name}:${row.data_type}`);
    for (const sql of Array.isArray(change) ? change : [change])
      await db.query(sql);
    const before = await types();

    const error = await runSaved(db, statements);

    expect(asViewsChangedSincePlan(error)).not.toBeNull();
    expect(await types()).toEqual(before);
    await db.query("SET schema = 'main'");
    const amount = await db.query(
      'SELECT CAST(amount AS VARCHAR) AS amount FROM main.decimal_prices',
    );
    expect(String(amount.rows[0]?.amount)).toBe(
      _label === 'the source type changed' ? '9007199254740993' : '1.5',
    );
  });

  it('stops a saved plan when views, source type, schema or catalog changed after planning (another catalog)', async () => {
    const statements = statementsOf(
      await plan(db, { decimal_prices: prices() }),
    );
    await db.close?.();
    await clearConnectionCache();
    copyFileSync(path.join(dir, 'plan_a.db'), path.join(dir, 'plan_b.db'));
    db = await getDatabase({
      type: 'duckdb',
      url: path.join(dir, 'plan_b.db'),
    });

    const error = await runSaved(db, statements);

    expect(asViewsChangedSincePlan(error)).not.toBeNull();
    expect(await columnType(db, 'decimal_prices')).toBe('FLOAT');
  });

  it('warns after commit when a view appeared on another connection', async () => {
    // Two connections of one DuckDB instance: the migration's, and an
    // operator's that creates a projecting view after the plan guard ran.
    await db.close?.();
    await clearConnectionCache();
    // The DuckDB driver is a dependency of @happyvertical/sql, not of core.
    const sqlPackage = realpathSync(
      fileURLToPath(
        new URL('../../../node_modules/@happyvertical/sql', import.meta.url),
      ),
    );
    const { DuckDBInstance } = createRequire(
      path.join(sqlPackage, 'package.json'),
    )('@duckdb/node-api') as {
      DuckDBInstance: {
        create(path: string): Promise<{
          connect(): Promise<{
            runAndReadAll(
              sql: string,
              values?: never,
            ): Promise<{ getRowObjectsJS(): unknown[] }>;
            closeSync(): void;
          }>;
          closeSync(): void;
        }>;
      };
    };
    const instance = await DuckDBInstance.create(path.join(dir, 'plan_a.db'));
    const own = await instance.connect();
    const operator = await instance.connect();
    const run = async (
      connection: typeof own,
      sql: string,
      params: unknown[] = [],
    ) => {
      const reader = await connection.runAndReadAll(
        sql,
        params.map((value) =>
          value === null || value === undefined ? null : value,
        ) as never,
      );
      return { rows: reader.getRowObjectsJS() as Record<string, unknown>[] };
    };
    let created = false;
    const handle = {
      url: path.join(dir, 'plan_a.db'),
      query: (sql: string, ...params: unknown[]) => run(own, sql, params),
      transaction: async <T>(
        callback: (tx: DatabaseInterface) => Promise<T>,
      ): Promise<T> => {
        await run(own, 'BEGIN TRANSACTION');
        try {
          const result = await callback({
            ...handle,
            query: async (sql: string, ...params: unknown[]) => {
              if (!created && /^INSERT INTO "plan_a"/.test(sql)) {
                created = true;
                await run(
                  operator,
                  'CREATE VIEW price_late AS SELECT id, amount FROM main.decimal_prices',
                );
              }
              return run(own, sql, params);
            },
          } as unknown as DatabaseInterface);
          await run(own, 'COMMIT');
          return result;
        } catch (error) {
          await run(own, 'ROLLBACK').catch(() => undefined);
          throw error;
        }
      },
    } as unknown as DatabaseInterface;
    try {
      const planned = await planDuckDbTableChanges({
        db: handle,
        tableName: 'decimal_prices',
        changes: [
          {
            type: 'type_upgrade',
            table: 'decimal_prices',
            name: 'amount',
            column: { type: 'REAL' },
            sql: 'ALTER TABLE "decimal_prices" ALTER COLUMN "amount" TYPE DOUBLE USING "amount"::DOUBLE',
          },
        ],
        mapType: () => 'DOUBLE',
      });
      const statements = planned.changes.flatMap(
        (change) => change.sqlStatements ?? [],
      );
      expect(statements.length).toBeGreaterThan(0);
      const tracker = new MigrationTracker({
        db: handle,
        engineHint: 'duckdb',
      });
      await tracker.initialize();
      const result = await tracker.apply(
        createMigrationDefinition(migrationName(), statements),
      );
      expect(created).toBe(true);
      expect(result.success).toBe(true);
      expect(result.warnings?.[0]).toBeInstanceOf(
        ViewInvalidatedAfterCommitWarning,
      );
      expect(result.warnings?.[0]?.view.name).toBe('price_late');
      const type = await run(
        own,
        "SELECT data_type FROM duckdb_columns() WHERE table_name = 'decimal_prices' AND column_name = 'amount'",
      );
      expect(type.rows[0]?.data_type).toBe('DOUBLE');
    } finally {
      operator.closeSync();
      own.closeSync();
      instance.closeSync();
    }
  });
});

describe('a DuckDB widening applied by MigrationTracker', () => {
  it('round-trips a value a 4-byte float cannot hold after widening', async () => {
    const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    try {
      await db.query(
        'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, amount REAL)',
      );
      const result = await migrate(db, { decimal_prices: prices() });
      expect(result.error).toBeUndefined();
      await db.query("INSERT INTO decimal_prices VALUES ('n', ?)", VALUE);
      const { rows } = await db.query('SELECT amount FROM decimal_prices');
      expect(Number(rows[0]?.amount)).toBe(VALUE);
    } finally {
      await db.close?.();
    }
  });
});
