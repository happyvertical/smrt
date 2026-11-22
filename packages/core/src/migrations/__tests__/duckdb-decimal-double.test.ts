/**
 * DuckDB (and the JSON adapter that inherits its strategy) store `decimal`
 * fields as DOUBLE, not the 4-byte REAL that a bare `REAL` means on DuckDB.
 *
 * Real DuckDB: a fresh table round-trips a value a 4-byte float cannot hold,
 * and an existing 4-byte column converges through the differ's type upgrade,
 * which on DuckDB is always the guarded table rebuild.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DatabaseInterface } from '@happyvertical/sql';
import { clearConnectionCache, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckDBStrategy } from '../../schema/ddl/duckdb-strategy.js';
import { JsonDuckDBStrategy } from '../../schema/ddl/json-duckdb-strategy.js';
import { checkLiveSchemaParity } from '../../schema/live-parity.js';
import type { SchemaDefinition } from '../../schema/types.js';
import { isCommentOnlySql } from '../change-kinds.js';
import { getSQLFromDiff, SchemaComparer } from '../differ.js';
import { createMigrationDefinition } from '../generator.js';
import { MigrationTracker } from '../tracker.js';
import { DependentViewTypeError } from '../view-guard.js';

// 2^24 + 1 plus a fraction: not representable in a 4-byte float.
const VALUE = 16777217.25;

const prices = (): SchemaDefinition => ({
  tableName: 'decimal_prices',
  columns: {
    id: { type: 'TEXT', primaryKey: true },
    amount: { type: 'REAL' },
  },
  indexes: [],
  triggers: [],
  foreignKeys: [],
  dependencies: [],
  version: '1',
});

const columnType = async (
  db: DatabaseInterface,
  table: string,
  column: string,
) =>
  String(
    (
      await db.query(
        'SELECT data_type FROM duckdb_columns() WHERE table_name = ? AND column_name = ?',
        table,
        column,
      )
    ).rows[0]?.data_type,
  );

const indexNames = async (db: DatabaseInterface, table: string) =>
  (
    await db.query(
      'SELECT index_name FROM duckdb_indexes() WHERE table_name = ? AND sql IS NOT NULL ORDER BY index_name',
      table,
    )
  ).rows.map((row) => String(row.index_name));

async function migrate(
  db: DatabaseInterface,
  schemas: Record<string, SchemaDefinition>,
) {
  const diff = await new SchemaComparer(db, { engineHint: 'duckdb' }).compare(
    schemas,
  );
  const tracker = new MigrationTracker({ db, engineHint: 'duckdb' });
  await tracker.initialize();
  const [result] = await tracker.applyAll(
    [
      createMigrationDefinition(
        `decimal_${Math.random().toString(36).slice(2)}`,
        getSQLFromDiff(diff).filter((sql) => !isCommentOnlySql(sql)),
      ),
    ],
    { atomic: true },
  );
  return { diff, result };
}

describe('DuckDB decimal columns are DOUBLE', () => {
  let db: DatabaseInterface;
  beforeEach(async () => {
    db = await getDatabase({ type: 'duckdb', url: ':memory:' });
  });
  afterEach(async () => {
    await db.close?.();
  });

  it('maps REAL to DOUBLE in the DuckDB and JSON strategies', () => {
    expect(new DuckDBStrategy().mapType('REAL')).toBe('DOUBLE');
    expect(new JsonDuckDBStrategy().mapType('REAL')).toBe('DOUBLE');
  });

  it('round-trips a value a 4-byte float cannot hold on a fresh table', async () => {
    await db.query(new DuckDBStrategy().generateCreateTable(prices()));
    expect(await columnType(db, 'decimal_prices', 'amount')).toBe('DOUBLE');
    await db.query(
      "INSERT INTO decimal_prices (id, amount) VALUES ('a', ?)",
      VALUE,
    );
    const rows = (await db.query('SELECT amount FROM decimal_prices')).rows;
    expect(Number(rows[0].amount)).toBe(VALUE);
  });

  it('converges an existing 4-byte column with no index through the rebuild', async () => {
    await db.query(
      'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, amount REAL)',
    );
    await db.query("INSERT INTO decimal_prices VALUES ('old', 1.5)");

    const { diff, result } = await migrate(db, { decimal_prices: prices() });
    expect(result.error).toBeUndefined();
    const upgrade = diff.changes.find(
      (change) => change.type === 'type_upgrade',
    );
    // One route for a DuckDB type upgrade: the guarded rebuild.
    expect(
      upgrade?.sqlStatements?.some((sql) => /_smrt_rebuild_/.test(sql)),
    ).toBe(true);
    expect(await columnType(db, 'decimal_prices', 'amount')).toBe('DOUBLE');

    const again = await new SchemaComparer(db, {
      engineHint: 'duckdb',
    }).compare({ decimal_prices: prices() });
    expect(again.changes).toEqual([]);
    await db.query(
      "INSERT INTO decimal_prices (id, amount) VALUES ('new', ?)",
      VALUE,
    );
    const rows = (
      await db.query('SELECT id, amount FROM decimal_prices ORDER BY id')
    ).rows;
    expect(rows.map((row) => [row.id, Number(row.amount)])).toEqual([
      ['new', VALUE],
      ['old', 1.5],
    ]);
  });

  it('converges a 4-byte column that a CHECK constraint references', async () => {
    await db.query(
      'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, amount REAL CHECK (amount >= 0))',
    );
    await db.query("INSERT INTO decimal_prices VALUES ('old', 1.5)");

    const { result } = await migrate(db, { decimal_prices: prices() });
    expect(result.error).toBeUndefined();
    expect(await columnType(db, 'decimal_prices', 'amount')).toBe('DOUBLE');
    await expect(
      db.query("INSERT INTO decimal_prices VALUES ('neg', -1)"),
    ).rejects.toThrow();
  });

  it.each([
    ['without an index', false],
    ['with an index on the column', true],
  ])('refuses to widen a 4-byte column a view projects, and changes nothing (%s)', async (_label, indexed) => {
    await db.query(
      'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, amount REAL)',
    );
    if (indexed)
      await db.query(
        'CREATE INDEX decimal_prices_amount ON decimal_prices (amount)',
      );
    await db.query("INSERT INTO decimal_prices VALUES ('old', 1.5)");
    await db.query(
      'CREATE VIEW decimal_price_view AS SELECT id, amount FROM decimal_prices',
    );
    await db.query(
      'CREATE VIEW decimal_price_totals AS SELECT sum(amount) AS total FROM decimal_price_view',
    );
    const schema: SchemaDefinition = indexed
      ? {
          ...prices(),
          indexes: [{ name: 'decimal_prices_amount', columns: ['amount'] }],
        }
      : prices();

    const { result } = await migrate(db, { decimal_prices: schema });
    expect(result.error).toBeInstanceOf(DependentViewTypeError);
    expect(await columnType(db, 'decimal_prices', 'amount')).toBe('FLOAT');
    const rows = (
      await db.query('SELECT id, amount FROM decimal_price_view ORDER BY id')
    ).rows;
    expect(rows.map((row) => [row.id, Number(row.amount)])).toEqual([
      ['old', 1.5],
    ]);
    if (indexed)
      expect(await indexNames(db, 'decimal_prices')).toEqual([
        'decimal_prices_amount',
      ]);
  });
});

describe('DuckDB decimal widening in a database file', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'smrt-decimal-file-'));
    file = path.join(dir, 'prices.db');
    await clearConnectionCache();
  });
  afterEach(async () => {
    await clearConnectionCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a unique index through a widening in a file database', async () => {
    const db = await getDatabase({ type: 'duckdb', url: file });
    try {
      await db.query(
        'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, sku TEXT, amount REAL)',
      );
      await db.query(
        'CREATE UNIQUE INDEX decimal_prices_sku ON decimal_prices (sku)',
      );
      await db.query("INSERT INTO decimal_prices VALUES ('old', 's1', 1.5)");
      await db.query('CHECKPOINT');
      const schema: SchemaDefinition = {
        ...prices(),
        columns: { ...prices().columns, sku: { type: 'TEXT' } },
        indexes: [
          { name: 'decimal_prices_sku', columns: ['sku'], unique: true },
        ],
      };

      const { result } = await migrate(db, { decimal_prices: schema });
      expect(result.error).toBeUndefined();
      expect(await columnType(db, 'decimal_prices', 'amount')).toBe('DOUBLE');
      expect(await indexNames(db, 'decimal_prices')).toEqual([
        'decimal_prices_sku',
      ]);
      await expect(
        db.query("INSERT INTO decimal_prices VALUES ('dup', 's1', 2)"),
      ).rejects.toThrow();
    } finally {
      await db.close?.();
    }
  });

  it('leaves the old table when the process is killed after the drop', async () => {
    let db = await getDatabase({ type: 'duckdb', url: file });
    let statements: string[];
    try {
      await db.query(
        'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, amount REAL)',
      );
      await db.query("INSERT INTO decimal_prices VALUES ('old', 1.5)");
      await db.query('CHECKPOINT');
      const diff = await new SchemaComparer(db, {
        engineHint: 'duckdb',
      }).compare({ decimal_prices: prices() });
      statements = getSQLFromDiff(diff).filter((sql) => !isCommentOnlySql(sql));
    } finally {
      await db.close?.();
      await clearConnectionCache();
    }
    const drop = statements.findIndex((sql) =>
      /^DROP TABLE "prices"\."main"\."decimal_prices"$/.test(sql),
    );
    expect(drop).toBeGreaterThan(-1);

    // A child process runs the plan in one transaction and reports a barrier
    // right after the drop; it is then killed by its pid, never committing.
    const sqlPackage = realpathSync(
      fileURLToPath(
        new URL('../../../node_modules/@happyvertical/sql', import.meta.url),
      ),
    );
    const script = path.join(dir, 'run-plan.mjs');
    writeFileSync(
      script,
      `const { getDatabase } = await import(${JSON.stringify(
        pathToFileURL(path.join(sqlPackage, 'dist', 'index.js')).href,
      )});
const statements = ${JSON.stringify(statements.slice(0, drop + 1))};
const db = await getDatabase({ type: 'duckdb', url: ${JSON.stringify(file)} });
await db.query('BEGIN TRANSACTION');
for (const sql of statements) await db.query(sql);
process.stdout.write('BARRIER\\n');
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no barrier: ${stderr}`)),
        60_000,
      );
      child.stdout.on('data', (chunk) => {
        if (String(chunk).includes('BARRIER')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`child exited early (${code}): ${stderr}`));
      });
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    process.kill(child.pid as number, 'SIGKILL');
    await exited;

    db = await getDatabase({ type: 'duckdb', url: file });
    try {
      expect(await columnType(db, 'decimal_prices', 'amount')).toBe('FLOAT');
      const rows = (await db.query('SELECT id, amount FROM decimal_prices'))
        .rows;
      expect(rows.map((row) => [row.id, Number(row.amount)])).toEqual([
        ['old', 1.5],
      ]);
      const staging = await db.query(
        "SELECT table_name FROM duckdb_tables() WHERE table_name LIKE '%rebuild%'",
      );
      expect(staging.rows).toEqual([]);
    } finally {
      await db.close?.();
    }
  }, 90_000);
});

describe('JSON adapter float width', () => {
  let dir: string;
  let json: DatabaseInterface | undefined;
  afterEach(async () => {
    await json?.close?.();
    json = undefined;
    await clearConnectionCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a 4-byte decimal column on a JSON table as drift and executes nothing', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'smrt-adapter-width-'));
    await clearConnectionCache();
    json = await getDatabase({
      type: 'json',
      url: dir,
      writeStrategy: 'immediate',
    } as never);
    await json.query(
      'CREATE TABLE decimal_prices (id TEXT PRIMARY KEY, amount REAL)',
    );
    await json.insert('decimal_prices', { id: 'a', amount: 1.5 });

    const diff = await new SchemaComparer(json, { engineHint: 'json' }).compare(
      { decimal_prices: prices() },
    );
    expect(
      diff.changes.map((change) => [change.type, change.name, change.kindHint]),
    ).toEqual([['type_upgrade', 'amount', 'json.ddl-not-durable']]);
    expect(getSQLFromDiff(diff)).toEqual([]);

    const report = await checkLiveSchemaParity({
      db: json,
      schemas: { decimal_prices: prices() },
      includeSystemTables: false,
      engineHint: 'json',
    });
    const drift = report.findings.find(
      (finding) =>
        finding.kind === 'column_type_drift' && finding.target === 'amount',
    );
    expect(drift?.severity).toBe('error');
    expect(report.ok).toBe(false);
  });
});
