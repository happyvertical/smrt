/** Real databases; registry projections injected as in db-migrate-null-orphans. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  collectMigrateRecordInput,
  ObjectRegistry,
  OLDEST_SUPPORTED_RELEASE,
  type SchemaDefinition,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMigratePreview,
  formatMigratePreview,
  runDoctorMigratePreviewSection,
  runMigratePreview,
} from '../doctor-migrate-preview.js';

const discovery = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../../discovery/index.js', () => ({ autoDiscoverAndLoad: discovery }));

function schema(tableName = 'items'): SchemaDefinition {
  return {
    tableName,
    columns: { id: { type: 'TEXT', primaryKey: true }, code: { type: 'TEXT' } },
    indexes: [],
    foreignKeys: [],
    triggers: [],
    dependencies: [],
    version: '4934',
  };
}

describe('doctor next migrate (#4934)', () => {
  let db: DatabaseInterface;
  let client: PGlite | undefined;
  let schemas: Record<string, SchemaDefinition>;
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doctor-migrate-'));
    db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    schemas = { items: schema() };
    // No registry mutations: spies restore the original definitions, packages
    // and ordering after each case, without importing another core singleton.
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
      () => schemas,
    );
    vi.spyOn(ObjectRegistry, 'getInitializationOrder').mockImplementation(() =>
      Object.keys(schemas),
    );
    vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation(
      (name: string) => name,
    );
    vi.spyOn(ObjectRegistry, 'getAllClasses').mockReturnValue(new Map());
    clearCache();
    discovery.mockClear();
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT)');
  });
  afterEach(async () => {
    if (client) await client.close();
    else await db.close?.();
    client = undefined;
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    clearCache();
  });
  async function pg() {
    await db.close?.();
    client = new PGlite();
    db = await getDatabase({ type: 'pglite', client });
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT)');
  }
  async function preview(engine: 'sqlite' | 'postgres' | 'duckdb' = 'sqlite') {
    const report = await buildMigratePreview(db, engine);
    return { report, out: formatMigratePreview(report).join('\n') };
  }
  async function record(
    options: {
      release?: string;
      fingerprint?: string;
      packages?: string[];
    } = {},
  ) {
    await db.query(
      'CREATE TABLE _smrt_migrate_runs (id TEXT, release TEXT, packages TEXT, fingerprint TEXT, created_at TEXT)',
    );
    await db.query('INSERT INTO _smrt_migrate_runs VALUES (?, ?, ?, ?, ?)', [
      'one',
      options.release ?? OLDEST_SUPPORTED_RELEASE,
      JSON.stringify(options.packages ?? []),
      options.fingerprint ?? collectMigrateRecordInput().fingerprint,
      '2026-11-12',
    ]);
  }
  it('every empty group says none and no record explains packages, age and startup', async () => {
    const { out } = await preview();
    for (const label of [
      'Constraints made by hand that the next migrate removes',
      'Constraint relaxations kept until you opt in',
      'Rules in code the database is not enforcing',
      'What the next migrate applies',
      'What the next migrate stops on',
      'Held back',
    ])
      expect(out).toContain(`${label}:\n      none`);
    expect(out).toContain(
      'no earlier migrate record; the first migrate under this scheme writes one',
    );
    expect(out).toContain('age unknown: no earlier migrate record');
    expect(out).toContain(
      'found no migrate record. Run smrt db:migrate before starting this build.',
    );
  });
  it('lists live NOT NULL removal on PostgreSQL and opt-in default retention', async () => {
    await pg();
    await db.query(
      "ALTER TABLE items ALTER COLUMN code SET NOT NULL, ALTER COLUMN code SET DEFAULT 'old'",
    );
    const { report, out } = await preview('postgres');
    expect(report.removed.join()).toContain('items.code: removes NOT NULL');
    expect(out).toContain('To keep it, declare it in code.');
    expect(report.kept.join()).toContain('items.code: drop default');
    expect(report.warnings).toContain(
      'Next migrate removes constraints made by hand',
    );
  });
  it('SQLite now removes a hand-made NOT NULL, as PostgreSQL does', async () => {
    await db.query('DROP TABLE items');
    await db.query(
      'CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT NOT NULL)',
    );
    const { report } = await preview();
    expect(report.removed.join()).toContain('items.code');
    expect(report.stops).toEqual([]);
  });
  it('lists a hand-made redundant index not declared in code', async () => {
    await db.query('CREATE INDEX hand_idx ON items(id)');
    const { report } = await preview();
    expect(report.removed.join()).toContain('items.hand_idx: removes index');
  });
  it('reports required nullable column with no rows as sets NOT NULL', async () => {
    await pg();
    schemas.items.columns.code.notNull = true;
    const { report, out } = await preview('postgres');
    expect(report.rules.join()).toContain('the next migrate sets NOT NULL');
    expect(out).toContain('column.set-not-null: 1');
    expect(report.stops).toEqual([]);
  });
  it('SQLite tightens an existing nullable column with no rows', async () => {
    schemas.items.columns.code.notNull = true;
    const { report } = await preview();
    expect(report.rules.join()).toContain('the next migrate sets NOT NULL');
    expect(report.stops).toEqual([]);
  });
  it('DuckDB subclass rules stay enforced at save time', async () => {
    await db.close?.();
    db = await getDatabase({
      type: 'duckdb',
      url: join(dir, 'preview.duckdb'),
    });
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT)');
    schemas.items.checks = [check];
    expect((await preview('duckdb')).out).toContain(
      'this engine cannot enforce a rule for one subclass; smrt checks it when saving',
    );
  });
  it('counts only NULL rows in an existing required column', async () => {
    schemas.items.columns.code.notNull = true;
    await db.query(
      "INSERT INTO items VALUES ('1', NULL), ('2', 'yes'), ('3', NULL)",
    );
    const { report } = await preview();
    expect(report.rules.join()).toContain(
      'existing rows have no value; the next migrate stops',
    );
    expect(report.stops.join()).toContain(
      'column.required-nulls (invents-data)',
    );
    expect(report.stops.join()).toContain('2 row(s)');
  });
  it('#4920 missing required column counts existing rows and holds unrelated changes', async () => {
    schemas.items.columns.required_value = { type: 'TEXT', notNull: true };
    schemas.new_table = schema('new_table');
    await db.query(
      "INSERT INTO items VALUES ('1', 'a'), ('2', 'b'), ('3', NULL)",
    );
    const { report, out } = await preview();
    expect(report.stops.join()).toContain(
      'column.required-missing (invents-data): items.required_value',
    );
    expect(report.stops.join()).toContain('3 row(s)');
    expect(report.issues.length).toBeGreaterThan(0);
    expect(out).toContain(
      'Held back: nothing is applied while any stop stands',
    );
    expect(out).toContain('Create table new_table');
    expect(report.rules.join()).toContain('items.required_value');
  });
  it('keeps a stop if its row count cannot be read and redacts the reason', async () => {
    schemas.items.columns.required_value = { type: 'TEXT', notNull: true };
    await db.query("INSERT INTO items VALUES ('1', NULL)");
    const original = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql, ...args) => {
      if (typeof sql === 'string' && sql.includes('AS row_count'))
        throw new Error(
          'failed postgres://owner:secret@host/app?token=private',
        );
      return original(sql, ...args);
    });
    const { report, out } = await preview();
    expect(report.issues.join()).toContain('column.required-missing');
    expect(out).toContain('row count unavailable:');
    expect(out).not.toMatch(/secret|private/);
  });
  it('groups applied changes, lists new tables and caps names at ten', async () => {
    for (let n = 0; n < 12; n++)
      schemas.items.columns[`extra_${n}`] = { type: 'TEXT' };
    schemas.fresh = schema('fresh');
    const { out } = await preview();
    expect(out).toContain('column.add: 12');
    expect(out).toContain('2 more');
    expect(out).not.toContain('items.extra_11');
    expect(out).toContain('Tables to create:\n      fresh');
  });
  it('compares missing/new packages without confirmations', async () => {
    await record({ packages: ['@old/pkg'] });
    vi.mocked(ObjectRegistry.getAllClasses).mockReturnValue(
      new Map([
        [
          '@new/pkg:Item',
          {
            name: 'Item',
            constructor: SmrtObject,
            qualifiedName: '@new/pkg:Item',
            config: {},
            fields: new Map(),
            methods: new Map(),
          },
        ],
      ]) as ReturnType<typeof ObjectRegistry.getAllClasses>,
    );
    const { report, out } = await preview();
    expect(report.missingPackages).toEqual(['@old/pkg']);
    expect(out).toContain('--confirm-removed-package @old/pkg');
    expect(out).toContain('New: @new/pkg');
    expect(report.issues.join()).toContain('@old/pkg');
  });
  it.each([
    '0.0.1',
    OLDEST_SUPPORTED_RELEASE,
    '999.0.0',
  ])('compares recorded release %s with oldest supported', async (release) => {
    await record({ release });
    const { report, out } = await preview();
    expect(out).toContain(release);
    expect(out).toContain(OLDEST_SUPPORTED_RELEASE);
    if (release === '0.0.1') {
      expect(report.warnings.join()).toContain('First upgrade the database');
      expect(out).toContain('nothing is applied while any stop stands');
    } else expect(out).toContain(`ok: ${release}; oldest supported`);
  });
  it.each([
    true,
    false,
  ])('fingerprint matches=%s; verbose includes full hashes', async (matches) => {
    const fingerprint = matches
      ? collectMigrateRecordInput().fingerprint
      : 'a'.repeat(64);
    await record({ fingerprint });
    const { report, out } = await preview();
    expect(out).toContain(`database: ${fingerprint.slice(0, 12)}`);
    if (matches) expect(out).toContain('matches');
    else
      expect(report.warnings.join()).toContain(
        'this build will refuse to start in production until `smrt db:migrate` runs',
      );
    expect(formatMigratePreview(report, { verbose: true }).join()).toContain(
      `(${fingerprint})`,
    );
  });
  const check = {
    name: 'smrt_ck_strict_code',
    columns: ['code'],
    expression: `_meta_type NOT IN ('@app/pkg:Strict') OR "code" IS NOT NULL`,
  };
  it.each([
    false,
    true,
  ])('missing PostgreSQL STI check, violating rows=%s', async (violated) => {
    await pg();
    await db.query('ALTER TABLE items ADD COLUMN _meta_type TEXT');
    schemas.items.columns._meta_type = { type: 'TEXT' };
    schemas.items.checks = [check];
    if (violated)
      await db.query("INSERT INTO items VALUES ('1', NULL, '@app/pkg:Strict')");
    const { report } = await preview('postgres');
    expect(report.rules.join()).toContain(
      violated ? 'rows already break it' : 'the next migrate adds it',
    );
    // The shared table of change kinds decides: adding the rule applies, and
    // rows that already break it stop the run.
    if (violated) {
      expect(report.stops.join()).toContain('check.violated');
    } else {
      expect(report.stops).toEqual([]);
      expect(Object.keys(report.apply)).toContain('check.add');
    }
    if (!violated) {
      await db.query(
        `ALTER TABLE items ADD CONSTRAINT ${check.name} CHECK (${check.expression})`,
      );
      expect((await preview('postgres')).report.rules).toEqual([]);
    }
  });
  it('lists stale smrt CHECK removal as an applied change', async () => {
    await pg();
    await db.query(
      'ALTER TABLE items ADD CONSTRAINT smrt_ck_old CHECK (code IS NOT NULL)',
    );
    const { report } = await preview('postgres');
    expect(report.removed.join()).toContain('items.smrt_ck_old: removes CHECK');
    expect(report.stops).toEqual([]);
  });
  it('SQLite subclass rules stay enforced at save time', async () => {
    schemas.items.checks = [check];
    expect((await preview()).out).toContain(
      'this engine cannot enforce a rule for one subclass; smrt checks it when saving',
    );
  });
  it('counts FK orphan rows with the differ detector', async () => {
    await pg();
    await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
    schemas.parents = schema('parents');
    delete schemas.parents.columns.code;
    schemas.items.foreignKeys = [
      { column: 'code', referencesTable: 'parents', referencesColumn: 'id' },
    ];
    schemas.items.columns.code.foreignKey = { table: 'parents', column: 'id' };
    await db.query("INSERT INTO parents VALUES ('yes')");
    await db.query(
      "INSERT INTO items VALUES ('1', 'missing'), ('2', 'yes'), ('3', NULL)",
    );
    const { report } = await preview('postgres');
    expect(report.stops.join()).toContain('foreign-key.orphans (loses-data)');
    expect(report.stops.join()).toContain('1 row(s)');
    const query = db.query.bind(db);
    const failingCount = vi
      .spyOn(db, 'query')
      .mockImplementation(async (sql, ...args) => {
        if (typeof sql === 'string' && sql.includes('AS smrt_orphan_probe'))
          throw new Error('orphan count unavailable');
        return query(sql, ...args);
      });
    expect((await preview('postgres')).report.stops.join()).toContain(
      'row count unavailable: orphan count unavailable',
    );
    failingCount.mockRestore();
    await db.query("DELETE FROM items WHERE code = 'missing'");
    expect((await preview('postgres')).report.stops).toEqual([]);
  });
  async function sqliteSnapshot() {
    const schemaRows = (
      await db.query('SELECT * FROM sqlite_master ORDER BY type, name')
    ).rows;
    const tables = schemaRows.filter((row) => row.type === 'table');
    const rows: Array<{ name: unknown; count: unknown; rows: unknown }> = [];
    for (const table of tables) {
      const quoted = `"${String(table.name).replaceAll('"', '""')}"`;
      rows.push({
        name: table.name,
        count: (await db.query(`SELECT COUNT(*) AS n FROM ${quoted}`)).rows,
        rows: (await db.query(`SELECT * FROM ${quoted} ORDER BY rowid`)).rows,
      });
    }
    return { schemaRows, rows };
  }
  it.each([
    false,
    true,
  ])('is read-only including schema, names, counts and data; record exists=%s', async (hasRecord) => {
    if (hasRecord) await record();
    await db.query("INSERT INTO items VALUES ('1', NULL)");
    schemas.items.columns.required_value = { type: 'TEXT', notNull: true };
    const before = await sqliteSnapshot();
    await db.query('PRAGMA query_only = ON');
    await preview();
    expect(await sqliteSnapshot()).toEqual(before);
  });
  it('PostgreSQL preview runs inside a read-only transaction with no record table', async () => {
    await pg();
    schemas.items.columns.required_value = { type: 'TEXT', notNull: true };
    await db.query("INSERT INTO items VALUES ('1', NULL)");
    await db.query('BEGIN READ ONLY');
    const snapshot = async () => ({
      schema: (
        await db.query(
          "SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
        )
      ).rows,
      rows: (await db.query('SELECT * FROM items ORDER BY id')).rows,
      counts: (await db.query('SELECT COUNT(*) FROM items')).rows,
    });
    const before = await snapshot();
    expect((await preview('postgres')).report.stops.join()).toContain(
      '1 row(s)',
    );
    expect(await snapshot()).toEqual(before);
    await db.query('ROLLBACK');
  });
  it('fails closed when PostgreSQL CHECK metadata is unreadable', async () => {
    await pg();
    schemas.items.checks = [check];
    const query = db.query.bind(db);
    vi.spyOn(db, 'query').mockImplementation(async (sql, ...args) => {
      if (typeof sql === 'string' && sql.includes('FROM pg_constraint AS con'))
        throw new Error('catalog denied');
      return query(sql, ...args);
    });
    await expect(buildMigratePreview(db, 'postgres')).rejects.toThrow(
      'catalog denied',
    );
  });
  it('reports doctor pass only when no issues or warnings remain', async () => {
    await db.close?.();
    const url = join(dir, 'clean.db');
    db = await getDatabase({ type: 'sqlite', url });
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT)');
    await record();
    setConfig({ packages: { cli: { database: { type: 'sqlite', url } } } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const buckets = {
      issues: [] as string[],
      warnings: [] as string[],
      passed: [] as string[],
    };
    await runDoctorMigratePreviewSection(buckets, vi.fn());
    expect(buckets).toEqual({
      issues: [],
      warnings: [],
      passed: ['Next migrate'],
    });
    // The wrapper's default performs discovery; the section deliberately doesn't.
    const outcome = await runMigratePreview();
    expect(outcome.error).toBeNull();
    expect(discovery).toHaveBeenCalledOnce();
  });
  it('fails closed with missing config and unreachable URL without leaking credentials', async () => {
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    });
    expect((await runMigratePreview()).error).toContain(
      'No persistent database',
    );
    clearCache();
    setConfig({
      packages: {
        cli: {
          database: {
            type: 'sqlite',
            url: 'postgres://owner:secret@invalid.invalid/app?token=private',
          },
        },
      },
    });
    const outcome = await runMigratePreview({ discover: false });
    expect(outcome.report).toBeNull();
    expect(outcome.error).toBeTruthy();
    expect(outcome.error).not.toMatch(/secret|private/);
  });
  it('doctor section uses real configured database, reports stops, and closes it', async () => {
    await db.close?.();
    const url = join(dir, 'doctor.db');
    db = await getDatabase({ type: 'sqlite', url });
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, code TEXT)');
    await db.query("INSERT INTO items VALUES ('1', NULL)");
    schemas.items.columns.required_value = { type: 'TEXT', notNull: true };
    setConfig({ packages: { cli: { database: { type: 'sqlite', url } } } });
    const buckets = {
      issues: [] as string[],
      warnings: [] as string[],
      passed: [] as string[],
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const checkResult = vi.fn();
    await runDoctorMigratePreviewSection(buckets, checkResult);
    expect(buckets.issues.join()).toContain('items.required_value');
    expect(log.mock.calls.flat().join()).toContain('Next migrate');
    expect(checkResult).not.toHaveBeenCalled();
    expect(discovery).not.toHaveBeenCalled();
    clearCache();
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: ':memory:' } } },
    });
    await runDoctorMigratePreviewSection(buckets, checkResult);
    expect(checkResult).toHaveBeenCalledWith(
      'Next migrate',
      false,
      expect.stringContaining('No persistent database'),
    );
  });
});
