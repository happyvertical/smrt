/** Real PostgreSQL SQL in-process. Only discovery, registry, and the lock
 * transport are injected: PGlite has one backend and no pinned lock session. */
import { PGlite } from '@electric-sql/pglite';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  SchemaComparer,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
import { MigrationTracker } from '@happyvertical/smrt-core/migrations';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { parseCliCommandArgs } from '../../cli-generator.js';
import { utilityCommands } from '../utilities.js';

const h = vi.hoisted(() => ({
  db: undefined as DatabaseInterface | undefined,
}));
vi.mock('@happyvertical/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/sql')>();
  return {
    ...actual,
    getDatabase: (options: Parameters<typeof actual.getDatabase>[0]) =>
      options && 'type' in options && options.type === 'postgres'
        ? Promise.resolve(h.db)
        : actual.getDatabase(options),
  };
});
vi.mock('@happyvertical/smrt-core/migrations', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@happyvertical/smrt-core/migrations')
    >();
  return {
    ...actual,
    acquireMigrationLock: vi.fn(async () => ({
      held: false,
      waitedMs: 0,
      assertHeld: async () => {},
      release: async () => {},
    })),
  };
});
vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: vi.fn(async () => ({
    discovered: [
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 3 },
    ],
    totalObjects: 3,
  })),
}));

const url = 'postgresql://pglite/4927';
function postgresView(db: DatabaseInterface): DatabaseInterface {
  return {
    ...db,
    url,
    close: async () => {},
    transaction: async <T>(work: (tx: DatabaseInterface) => Promise<T>) => {
      if (!db.transaction) throw new Error('Transaction support required');
      return db.transaction((tx) => work(postgresView(tx)));
    },
  };
}
function schema(
  tableName: string,
  columns: SchemaDefinition['columns'],
): SchemaDefinition {
  return {
    tableName,
    columns,
    indexes: [],
    foreignKeys: [],
    triggers: [],
    dependencies: [],
    version: '4927',
  };
}

describe('db:migrate --null-orphans (#4927, PGlite)', () => {
  let db: DatabaseInterface;
  let client: PGlite;
  let schemas: Record<string, SchemaDefinition>;
  let logs: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  const fk = {
    column: 'parent_id',
    referencesTable: 'parents',
    referencesColumn: 'id',
  };
  beforeEach(async () => {
    client = new PGlite();
    db = await getDatabase({ type: 'pglite', client });
    h.db = postgresView(db);
    clearCache();
    setConfig({ packages: { cli: { database: { type: 'postgres', url } } } });
    await db.query('CREATE TABLE parents (id UUID PRIMARY KEY)');
    await db.query(
      'CREATE TABLE children (id UUID PRIMARY KEY, parent_id UUID)',
    );
    await db.query('CREATE TABLE unrelated (id UUID PRIMARY KEY, status TEXT)');
    await db.query('INSERT INTO parents VALUES (gen_random_uuid())');
    await db.query(
      'INSERT INTO children VALUES (gen_random_uuid(), gen_random_uuid()), (gen_random_uuid(), (SELECT id FROM parents LIMIT 1))',
    );
    schemas = {
      parents: schema('parents', { id: { type: 'UUID', primaryKey: true } }),
      children: {
        ...schema('children', {
          id: { type: 'UUID', primaryKey: true },
          parent_id: {
            type: 'UUID',
            foreignKey: { table: 'parents', column: 'id' },
          },
        }),
        foreignKeys: [fk],
        dependencies: ['parents'],
        indexes: [{ name: 'children_parent_idx', columns: ['parent_id'] }],
      },
      unrelated: {
        ...schema('unrelated', {
          id: { type: 'UUID', primaryKey: true },
          status: { type: 'TEXT' },
        }),
        indexes: [{ name: 'unrelated_status_idx', columns: ['status'] }],
      },
    };
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockImplementation(
      () => schemas,
    );
    vi.spyOn(ObjectRegistry, 'getInitializationOrder').mockReturnValue(
      Object.keys(schemas),
    );
    vi.spyOn(ObjectRegistry, 'getTableName').mockImplementation(
      (name: string) => name,
    );
    logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    await client?.close();
    h.db = undefined;
    clearCache();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  async function run(...flags: string[]) {
    process.exitCode = undefined;
    logs.mockClear();
    errors.mockClear();
    const command = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(['db:migrate', ...flags], [command]);
    await requireCommandHandler(command)(parsed.args, parsed.options);
    return [...logs.mock.calls, ...errors.mock.calls]
      .map((c) => c.join(' '))
      .join('\n');
  }
  const children = async () =>
    (await db.query('SELECT * FROM children ORDER BY id')).rows;
  const indexes = async () =>
    (
      await db.query(
        "SELECT indexname FROM pg_indexes WHERE tablename IN ('children', 'unrelated') ORDER BY indexname",
      )
    ).rows;
  const fkCount = async () =>
    (
      await db.query(
        "SELECT * FROM information_schema.table_constraints WHERE table_name = 'children' AND constraint_type = 'FOREIGN KEY'",
      )
    ).rows.length;

  it('an orphan stop holds both dependent and unrelated indexes', async () => {
    const before = await children();
    const beforeIndexes = await indexes();
    const out = await run();
    expect(process.exitCode).toBe(1);
    expect(out).toContain('Migrate stopped:');
    expect(out).toContain('children.parent_id');
    expect(out).toContain('Add index unrelated.unrelated_status_idx');
    expect(await children()).toEqual(before);
    expect(await indexes()).toEqual(beforeIndexes);
    expect(await fkCount()).toBe(0);
  });
  it('nulls only nullable orphan references and commits the FK and all indexes; retry is clean', async () => {
    const out = await run('--null-orphans');
    expect(process.exitCode ?? 0, out).toBe(0);
    expect(out).toContain('nulled 1 orphan reference(s)');
    expect(await fkCount()).toBe(1);
    const rows = await children();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.parent_id === null)).toHaveLength(1);
    expect(await indexes()).toEqual(
      expect.arrayContaining([
        { indexname: 'children_parent_idx' },
        { indexname: 'unrelated_status_idx' },
      ]),
    );
    await run('--null-orphans');
    expect(process.exitCode ?? 0).toBe(0);
  });
  it('a second unrelated stop holds the orphan UPDATE, FK, and indexes without tracker writes', async () => {
    schemas.unrelated.columns.status.notNull = true;
    await db.query('INSERT INTO unrelated VALUES (gen_random_uuid(), NULL)');
    await new MigrationTracker({ db: h.db as DatabaseInterface }).initialize();
    const before = await children();
    const beforeIndexes = await indexes();
    const tracking = (await db.query('SELECT * FROM _smrt_schema_migrations'))
      .rows;
    const preview = await run('--dry-run', '--null-orphans', '--repair-data');
    expect(process.exitCode).toBe(1);
    expect(preview).toContain('Dry-run: this migration would be refused');
    expect(preview).toContain('Add foreign key children.parent_id');
    expect(preview).toContain('Null orphan references children.parent_id');
    expect(await children()).toEqual(before);
    expect(await indexes()).toEqual(beforeIndexes);
    expect(await fkCount()).toBe(0);
    const out = await run('--null-orphans', '--repair-data');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('unrelated.status');
    expect(out).toContain('Add foreign key children.parent_id');
    expect(out).toContain('Null orphan references children.parent_id');
    expect(out).not.toContain('nulled 1 orphan');
    expect(await children()).toEqual(before);
    expect(await indexes()).toEqual(beforeIndexes);
    expect(await fkCount()).toBe(0);
    expect(
      (await db.query('SELECT * FROM _smrt_schema_migrations')).rows,
    ).toEqual(tracking);
  });
  it.each([
    false,
    true,
  ])('refuses a live NOT NULL child even when the manifest is nullable=%s', async (manifestNullable) => {
    await db.query('ALTER TABLE children ALTER COLUMN parent_id SET NOT NULL');
    schemas.children.columns.parent_id.notNull = !manifestNullable;
    const before = await children();
    const out = await run('--null-orphans');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('Migrate stopped:');
    expect(await children()).toEqual(before);
    expect(await fkCount()).toBe(0);
    expect(await indexes()).not.toContainEqual({
      indexname: 'unrelated_status_idx',
    });
  });
  it('dry-run previews the UPDATE and indexes without changing data, then the real run applies them', async () => {
    const before = await children();
    const out = await run('--dry-run', '--null-orphans');
    expect(process.exitCode ?? 0, out).toBe(0);
    expect(out).toContain('would null');
    expect(out).toContain('children_parent_idx');
    expect(await children()).toEqual(before);
    expect(await fkCount()).toBe(0);
    await run('--null-orphans');
    expect(process.exitCode ?? 0).toBe(0);
    expect(await fkCount()).toBe(1);
  });
  it('plans an INVALID index again so a concurrent-index rerun reaches the tracker', async () => {
    await db.query('CREATE INDEX unrelated_status_idx ON unrelated (status)');
    await db.query(
      "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'unrelated_status_idx'::regclass",
    );
    if (!h.db) throw new Error('Database not initialized');
    const comparer = new SchemaComparer(h.db);
    const diff = await comparer.compare(schemas);
    expect(diff.changes).toContainEqual(
      expect.objectContaining({
        type: 'drop_index',
        name: 'unrelated_status_idx',
      }),
    );
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'add_index',
          table: 'unrelated',
          name: 'unrelated_status_idx',
        }),
      ]),
    );
    await db.query(
      "UPDATE pg_index SET indisvalid = true WHERE indexrelid = 'unrelated_status_idx'::regclass",
    );
    expect((await comparer.compare(schemas)).changes).not.toContainEqual(
      expect.objectContaining({
        type: 'add_index',
        name: 'unrelated_status_idx',
      }),
    );
    await db.query(
      'ALTER INDEX unrelated_status_idx RENAME TO unrelated_legacy_idx',
    );
    await db.query(
      "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'unrelated_legacy_idx'::regclass",
    );
    expect((await comparer.compare(schemas)).changes).toContainEqual(
      expect.objectContaining({
        type: 'add_index',
        name: 'unrelated_status_idx',
      }),
    );
  });
  it('a failed count probe keeps the orphan stop and refuses every change', async () => {
    if (!h.db) throw new Error('Database not initialized');
    const query = h.db.query;
    const before = await children();
    const beforeIndexes = await indexes();
    h.db.query = async (sql, ...args) => {
      if (typeof sql === 'string' && sql.includes('AS smrt_orphan_probe'))
        throw new Error('count probe unavailable');
      return query(sql, ...args);
    };
    const out = await run('--null-orphans');
    expect(process.exitCode).toBe(1);
    expect(out).toContain('orphan-count probe failed');
    expect(out).toContain('Migrate stopped:');
    expect(await children()).toEqual(before);
    expect(await indexes()).toEqual(beforeIndexes);
    expect(await fkCount()).toBe(0);
  });
  it('rolls back the orphan UPDATE and FK if a later FK validation fails', async () => {
    // A concurrent writer is represented by an invalid extra constraint in the
    // same disposition batch; SQLite rollback has its own real handler test.
    const query = h.db?.query;
    if (!query || !h.db) throw new Error('Database not initialized');
    const before = await children();
    const realTransaction = h.db.transaction;
    if (!realTransaction) throw new Error('Transaction required');
    h.db.transaction = (work) =>
      realTransaction((tx) =>
        work({
          ...tx,
          query: async (sql, ...args) => {
            if (typeof sql === 'string' && sql.includes('VALIDATE CONSTRAINT'))
              throw new Error('validation failed');
            return tx.query(sql, ...args);
          },
        }),
      );
    const out = await run('--null-orphans');
    expect(process.exitCode).toBe(1);
    expect(out).not.toContain('nulled 1 orphan');
    expect(await children()).toEqual(before);
    expect(await fkCount()).toBe(0);
  });
});
