/**
 * The six DOUBLE PRECISION system columns are widened on start, outside the
 * schema version gate, and a known blocker defers the widening instead of
 * failing the start (P5a, E8).
 *
 * `_smrt_contexts.confidence`, `_smrt_ai_usage.estimated_cost`, the three
 * `_smrt_ai_runs` cost columns and `_smrt_ai_run_events.reserved_cost` were a
 * 4-byte REAL on older DuckDB installs. Each start probes their width; a
 * FLOAT column is widened through the guarded table rebuild in its own
 * transaction. A view that projects it, a dependency-tracked view or a table
 * group the rebuild cannot copy leaves the column as it is, with a warning,
 * and the next start tries again. Any other failure still fails the start.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { clearConnectionCache, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureSystemTables } from '../system/bootstrap.js';
import {
  SYSTEM_DECIMAL_COLUMNS,
  widenSystemDecimalColumns,
} from '../system/decimal-width.js';
import {
  CREATE_SMRT_AI_RUN_EVENTS_TABLE,
  CREATE_SMRT_AI_RUNS_TABLE,
  CREATE_SMRT_AI_USAGE_TABLE,
  CREATE_SMRT_CONTEXTS_TABLE,
  getSystemTableDDLForEngine,
} from '../system/schema.js';

const LEGACY: Array<[string, string, string[]]> = [
  ['_smrt_contexts', CREATE_SMRT_CONTEXTS_TABLE, ['confidence']],
  ['_smrt_ai_usage', CREATE_SMRT_AI_USAGE_TABLE, ['estimated_cost']],
  [
    '_smrt_ai_runs',
    CREATE_SMRT_AI_RUNS_TABLE,
    ['cost_used', 'inclusive_cost', 'reserved_cost'],
  ],
  ['_smrt_ai_run_events', CREATE_SMRT_AI_RUN_EVENTS_TABLE, ['reserved_cost']],
];

/** The four tables as an install older than the DOUBLE columns created them. */
async function createLegacyTables(
  db: DatabaseInterface,
  engine: 'duckdb' | 'json' = 'duckdb',
  edit: (table: string, ddl: string) => string = (_table, ddl) => ddl,
) {
  for (const [table, ddl, columns] of LEGACY) {
    let text = getSystemTableDDLForEngine(ddl, engine).replace(/--.*$/gm, '');
    for (const column of columns)
      text = text.replace(
        new RegExp(`(\\b${column}\\s+)(DOUBLE PRECISION|REAL)`),
        '$1REAL',
      );
    text = edit(table, text);
    for (const statement of text
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean))
      await db.query(statement);
  }
}

const typeOf = async (db: DatabaseInterface, table: string, column: string) =>
  String(
    (
      await db.query(
        'SELECT data_type FROM duckdb_columns() WHERE database_name = current_database() AND table_name = ? AND column_name = ?',
        table,
        column,
      )
    ).rows[0]?.data_type,
  );

const COLUMNS = SYSTEM_DECIMAL_COLUMNS.map(
  ({ table, column }) => [table, column] as const,
);

describe('system decimal columns on DuckDB', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
  });
  afterEach(async () => {
    await db.close?.();
  });

  it('lists the six DOUBLE PRECISION system columns', () => {
    expect(COLUMNS).toEqual([
      ['_smrt_contexts', 'confidence'],
      ['_smrt_ai_usage', 'estimated_cost'],
      ['_smrt_ai_runs', 'cost_used'],
      ['_smrt_ai_runs', 'inclusive_cost'],
      ['_smrt_ai_runs', 'reserved_cost'],
      ['_smrt_ai_run_events', 'reserved_cost'],
    ]);
  });

  it('widens every legacy column, keeps the indexes and is idempotent', async () => {
    await createLegacyTables(db);
    await db.query(
      'CREATE UNIQUE INDEX ops_contexts_key ON _smrt_contexts (key, owner_id)',
    );
    await db.query(
      "INSERT INTO _smrt_contexts (id, owner_class, owner_id, scope, key, confidence) VALUES ('c1', 'O', 'o1', 's', 'k', 0.5)",
    );
    const indexes = async () =>
      (
        await db.query(
          "SELECT index_name FROM duckdb_indexes() WHERE table_name = '_smrt_contexts' ORDER BY index_name",
        )
      ).rows.map((row) => row.index_name);
    const before = await indexes();

    const first = await widenSystemDecimalColumns(db, 'duckdb');
    expect(first.map((item) => item.outcome)).toEqual(
      COLUMNS.map(() => 'widened'),
    );
    for (const [table, column] of COLUMNS)
      expect(await typeOf(db, table, column)).toBe('DOUBLE');
    expect(await indexes()).toEqual(before);
    const second = await widenSystemDecimalColumns(db, 'duckdb');
    expect(second.map((item) => item.outcome)).toEqual(
      COLUMNS.map(() => 'current'),
    );
    const row = await db.query('SELECT confidence FROM _smrt_contexts');
    expect(Number(row.rows[0]?.confidence)).toBe(0.5);
  });

  const blockers = [
    [
      'a view that projects it',
      async (db: DatabaseInterface, table: string, column: string) => {
        await db.query(
          `CREATE VIEW ops_blocker AS SELECT ${column} FROM ${table}`,
        );
      },
      'ops_blocker',
    ],
    [
      'a dependency-tracked view',
      async (db: DatabaseInterface, table: string, column: string) => {
        await db.query('SET enable_view_dependencies = true');
        await db.query(
          `CREATE VIEW ops_tracked AS SELECT ${column} FROM ${table}`,
        );
        await db.query('SET enable_view_dependencies = false');
      },
      'ops_tracked',
    ],
  ] as const;

  for (const [table, column] of COLUMNS) {
    for (const [kind, block, blocker] of blockers) {
      it(`defers each system column a blocker holds, warns, and widens once it is gone (${table}.${column}, ${kind})`, async () => {
        await createLegacyTables(db);
        await block(db, table, column);

        const deferred = await widenSystemDecimalColumns(db, 'duckdb');
        const held = deferred.find(
          (item) => item.table === table && item.column === column,
        );
        expect(held?.outcome).toBe('deferred');
        expect(held?.reason).toContain(blocker);
        expect(await typeOf(db, table, column)).toBe('FLOAT');
        // Other tables are not held back by this one.
        for (const item of deferred)
          if (item.table !== table) expect(item.outcome).toBe('widened');
        // The start itself goes on.
        await expect(ensureSystemTables(db, 'duckdb')).resolves.toBeUndefined();
        expect(await typeOf(db, table, column)).toBe('FLOAT');

        await db.query(`DROP VIEW ${blocker}`);
        const widened = await widenSystemDecimalColumns(db, 'duckdb');
        expect(
          widened.find((item) => item.table === table && item.column === column)
            ?.outcome,
        ).toBe('widened');
        expect(await typeOf(db, table, column)).toBe('DOUBLE');
      });
    }
  }

  it('defers each system column a blocker holds, warns, and widens once it is gone (cyclic table group)', async () => {
    await createLegacyTables(db, 'duckdb', (table, ddl) =>
      table === '_smrt_contexts'
        ? ddl.replace(
            'id TEXT PRIMARY KEY,',
            'id TEXT PRIMARY KEY, parent_id TEXT REFERENCES _smrt_contexts(id),',
          )
        : ddl,
    );
    const result = await widenSystemDecimalColumns(db, 'duckdb');
    const held = result.find((item) => item.table === '_smrt_contexts');
    expect(held?.outcome).toBe('deferred');
    expect(held?.reason).toContain('references itself');
    expect(await typeOf(db, '_smrt_contexts', 'confidence')).toBe('FLOAT');
    await expect(ensureSystemTables(db, 'duckdb')).resolves.toBeUndefined();
  });

  it('defers a column that a temporary view projects, naming it by three-part name', async () => {
    await createLegacyTables(db);
    await db.query(
      'CREATE TEMP VIEW ops_session AS SELECT confidence FROM _smrt_contexts',
    );
    const result = await widenSystemDecimalColumns(db, 'duckdb');
    const held = result.find((item) => item.table === '_smrt_contexts');
    expect(held?.outcome).toBe('deferred');
    expect(held?.reason).toContain('"temp"."main"."ops_session"');
  });

  it('fails the start on a failure that is not a known blocker, and leaves the table', async () => {
    await createLegacyTables(db);
    await db.query(
      "INSERT INTO _smrt_ai_usage (id, provider, model, operation, estimated_cost, duration) VALUES ('u', 'p', 'm', 'chat', 0.5, 1)",
    );
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
                      /^INSERT INTO "memory"\."main"\."_smrt_ai_usage"/.test(
                        sql,
                      )
                    )
                      throw new Error('disk full');
                    return inner.query(sql, ...args);
                  };
                },
              }),
            ),
          );
      },
    }) as DatabaseInterface;
    await expect(widenSystemDecimalColumns(failing, 'duckdb')).rejects.toThrow(
      'disk full',
    );
    expect(await typeOf(db, '_smrt_ai_usage', 'estimated_cost')).toBe('FLOAT');
    const rows = await db.query(
      'SELECT id, estimated_cost FROM _smrt_ai_usage',
    );
    expect(rows.rows).toEqual([{ id: 'u', estimated_cost: 0.5 }]);
  });

  it('does not attempt the system widening on an adapter without transactions', async () => {
    await createLegacyTables(db);
    const noTransactions = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction' || property === 'beginTransaction')
          return undefined;
        return Reflect.get(target, property, receiver);
      },
    }) as DatabaseInterface;
    const result = await widenSystemDecimalColumns(noTransactions, 'duckdb');
    expect(new Set(result.map((item) => item.outcome))).toEqual(
      new Set(['not-attempted']),
    );
    expect(await typeOf(db, '_smrt_contexts', 'confidence')).toBe('FLOAT');
  });

  it("does not attempt the system widening inside a caller's transaction", async () => {
    await createLegacyTables(db);
    // A callback handle.
    await db.transaction?.(async (tx) => {
      const result = await widenSystemDecimalColumns(tx, 'duckdb');
      expect(new Set(result.map((item) => item.outcome))).toEqual(
        new Set(['not-attempted']),
      );
      await tx.query(
        "INSERT INTO _smrt_contexts (id, owner_class, owner_id, scope, key) VALUES ('t1', 'O', 'o', 's', 'k1')",
      );
    });
    // A beginTransaction handle.
    const tx = await db.beginTransaction?.();
    if (!tx) throw new Error('expected beginTransaction');
    try {
      const result = await widenSystemDecimalColumns(
        tx as unknown as DatabaseInterface,
        'duckdb',
      );
      expect(new Set(result.map((item) => item.outcome))).toEqual(
        new Set(['not-attempted']),
      );
      await tx.query(
        "INSERT INTO _smrt_contexts (id, owner_class, owner_id, scope, key) VALUES ('t2', 'O', 'o', 's', 'k2')",
      );
      await tx.commit();
    } catch (error) {
      await tx.rollback().catch(() => undefined);
      throw error;
    }
    const kept = await db.query('SELECT id FROM _smrt_contexts ORDER BY id');
    expect(kept.rows).toEqual([{ id: 't1' }, { id: 't2' }]);
    expect(await typeOf(db, '_smrt_contexts', 'confidence')).toBe('FLOAT');
  });
});

describe('system decimal columns on the JSON adapter', () => {
  let dir: string;
  let json: DatabaseInterface;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'smrt-system-width-'));
    await clearConnectionCache();
    json = await getDatabase({
      type: 'json',
      url: dir,
      writeStrategy: 'immediate',
    } as never);
  });
  afterEach(async () => {
    await json?.close?.();
    await clearConnectionCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('widens a system column on a JSON-adapter handle', async () => {
    await createLegacyTables(json, 'json');
    const result = await widenSystemDecimalColumns(json, 'json');
    expect(result.map((item) => item.outcome)).toEqual(
      COLUMNS.map(() => 'widened'),
    );
    expect(await typeOf(json, '_smrt_contexts', 'confidence')).toBe('DOUBLE');
  });

  it("does not attempt the system widening inside a caller's transaction (JSON adapter)", async () => {
    await createLegacyTables(json, 'json');
    await json.transaction?.(async (tx) => {
      const result = await widenSystemDecimalColumns(tx, 'json');
      expect(new Set(result.map((item) => item.outcome))).toEqual(
        new Set(['not-attempted']),
      );
    });
    expect(await typeOf(json, '_smrt_contexts', 'confidence')).toBe('FLOAT');
  });
});
