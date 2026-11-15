/** db:migrate and the retire step (#5005), on real PostgreSQL SQL in-process. */
import { PGlite } from '@electric-sql/pglite';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  ObjectRegistry,
  readConfirmedRetirements,
  type SchemaDefinition,
} from '@happyvertical/smrt-core';
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
      { path: '/fake/.smrt/manifest.json', source: 'project', objectCount: 1 },
    ],
    totalObjects: 1,
  })),
}));

const url = 'postgresql://pglite/5005';
const PKG = '@retire5005/cli';
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
const kept: SchemaDefinition = {
  tableName: 'kept',
  columns: { id: { type: 'UUID', primaryKey: true } },
  indexes: [],
  foreignKeys: [],
  triggers: [],
  dependencies: [],
  version: '5005',
};

describe('db:migrate retires declared tables (#5005)', () => {
  let db: DatabaseInterface;
  let client: PGlite;
  let logs: ReturnType<typeof vi.spyOn>;
  let errors: ReturnType<typeof vi.spyOn>;
  let schemas: Record<string, SchemaDefinition>;
  beforeEach(async () => {
    client = new PGlite();
    db = await getDatabase({ type: 'pglite', client });
    h.db = postgresView(db);
    clearCache();
    setConfig({ packages: { cli: { database: { type: 'postgres', url } } } });
    await db.query('CREATE TABLE kept (id UUID PRIMARY KEY)');
    await db.query('CREATE TABLE old_drafts (id UUID PRIMARY KEY)');
    await db.query(
      'INSERT INTO old_drafts VALUES (gen_random_uuid()), (gen_random_uuid())',
    );
    await db.query('CREATE TABLE undeclared (id UUID PRIMARY KEY)');
    schemas = { kept };
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
    ObjectRegistry.registerManifestRetiredTables({ packageName: PKG });
    await client?.close();
    h.db = undefined;
    clearCache();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  const declare = (rows?: 'discard') =>
    ObjectRegistry.registerManifestRetiredTables({
      packageName: PKG,
      retiredTables: [
        {
          table: 'old_drafts',
          lastOwner: `${PKG}:Draft`,
          since: '1.2.0',
          reason: 'Drafts live on the order.',
          ...(rows ? { rows } : {}),
          definitions: [
            {
              release: '1.1.0',
              columns: { id: { type: 'UUID', referenceKind: 'id' } },
            },
          ],
          packageName: PKG,
        },
      ],
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
  const exists = async (table: string) =>
    (
      await db.query(
        'SELECT 1 FROM information_schema.tables WHERE table_name = $1',
        [table],
      )
    ).rows.length > 0;

  it('--dry-run lists the table, its reason and the rows that go, and drops nothing', async () => {
    declare('discard');
    const out = await run('--dry-run');
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain('Tables to retire');
    expect(out).toContain('old_drafts');
    expect(out).toContain('Drafts live on the order.');
    expect(out).toContain('2 row(s) discarded');
    expect(out).toContain('DROP TABLE IF EXISTS "public"."old_drafts"');
    expect(await exists('old_drafts')).toBe(true);
  });

  it('drops the declared table, never an undeclared one, and a rerun is clean', async () => {
    declare('discard');
    const out = await run();
    expect(process.exitCode ?? 0, out).toBe(0);
    expect(out).toContain('declared retired by their package will be DROPPED');
    expect(out).toContain('Retired table old_drafts');
    expect(await exists('old_drafts')).toBe(false);
    expect(await exists('undeclared')).toBe(true);
    expect(await exists('kept')).toBe(true);
    const again = await run();
    expect(process.exitCode ?? 0, again).toBe(0);
    expect(again).not.toContain('Retired table');
  });

  it("stops on rows without rows: 'discard', naming the table and count", async () => {
    declare();
    schemas.fresh = { ...kept, tableName: 'fresh' };
    const out = await run();
    expect(process.exitCode).toBe(1);
    expect(out).toContain('Migrate stopped:');
    expect(out).toContain('old_drafts holds 2 row(s)');
    expect(out).toContain('Create table fresh');
    expect(await exists('old_drafts')).toBe(true);
    expect(await exists('fresh')).toBe(false);
  });

  it('stops on an undeclared dependent, one line each', async () => {
    declare('discard');
    await db.query(
      'CREATE TABLE child (id UUID PRIMARY KEY, d UUID REFERENCES old_drafts(id))',
    );
    await db.query('CREATE VIEW drafts_view AS SELECT id FROM old_drafts');
    const out = await run();
    expect(process.exitCode).toBe(1);
    expect(out).toContain('foreign key child.d');
    expect(out).toContain('view drafts_view');
    expect(await exists('old_drafts')).toBe(true);
  });

  it('counts again inside the batch: a row written after the plan rolls everything back (R2)', async () => {
    declare();
    await db.query('DELETE FROM old_drafts');
    schemas.fresh = { ...kept, tableName: 'fresh' };
    let wrote = false;
    const base = h.db as DatabaseInterface;
    h.db = {
      ...base,
      query: async (sql: string, ...args: unknown[]) => {
        const result = await (base.query as (...a: unknown[]) => unknown)(
          sql,
          ...args,
        );
        if (
          !wrote &&
          /COUNT\(\*\) AS n FROM/.test(sql) &&
          sql.includes('old_drafts')
        ) {
          wrote = true;
          await db.query('INSERT INTO old_drafts VALUES (gen_random_uuid())');
        }
        return result;
      },
    } as DatabaseInterface;
    const out = await run();
    expect(wrote).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(out).toContain('table.retire-rows');
    expect(await exists('old_drafts')).toBe(true);
    expect(await exists('fresh')).toBe(false);
  });

  it('stops when the live table is not the one the declaration describes (R3)', async () => {
    declare('discard');
    await db.query('ALTER TABLE old_drafts ADD COLUMN note TEXT');
    const out = await run();
    expect(process.exitCode).toBe(1);
    expect(out).toContain('column note is not in the definition');
    expect(out).toContain('rerun with --confirm-retire-table old_drafts');
    expect(await exists('old_drafts')).toBe(true);
  });

  it('--confirm-retire-table drops it, prints the differences and records the confirmation (M3)', async () => {
    declare('discard');
    await db.query('ALTER TABLE old_drafts ADD COLUMN note TEXT');
    const dry = await run('--dry-run', '--confirm-retire-table', 'old_drafts');
    expect(process.exitCode ?? 0, dry).toBe(0);
    expect(dry).toContain(
      'Confirmed by --confirm-retire-table old_drafts although the live table is not the one any listed release describes (release 1.1.0: column note is not in the definition)',
    );
    expect(await exists('old_drafts')).toBe(true);

    const out = await run('--confirm-retire-table', 'old_drafts');
    expect(process.exitCode ?? 0, out).toBe(0);
    expect(out).toContain('Retired table old_drafts');
    expect(await exists('old_drafts')).toBe(false);
    const [record] = await readConfirmedRetirements(db, {
      engineHint: 'postgres',
    });
    expect(record.retirements).toEqual([
      {
        table: 'old_drafts',
        packageName: PKG,
        lastOwner: `${PKG}:Draft`,
        since: '1.2.0',
        by: 'flag',
        differences: ['release 1.1.0: column note is not in the definition'],
      },
    ]);
  });

  it('--confirm-retire-table still stops on rows and dependents, and names an unused confirmation', async () => {
    declare();
    await db.query('ALTER TABLE old_drafts ADD COLUMN note TEXT');
    const rows = await run('--confirm-retire-table', 'old_drafts');
    expect(process.exitCode).toBe(1);
    expect(rows).toContain('old_drafts holds 2 row(s)');
    expect(await exists('old_drafts')).toBe(true);

    declare('discard');
    await db.query(
      'CREATE TABLE child (id UUID PRIMARY KEY, d UUID REFERENCES old_drafts(id))',
    );
    const deps = await run(
      '--confirm-retire-table',
      'old_drafts',
      '--confirm-retire-table',
      'old_%',
    );
    expect(process.exitCode).toBe(1);
    expect(deps).toContain('foreign key child.d');
    expect(deps).toContain(
      'Ignoring --confirm-retire-table old_%: no declared retirement of exactly this table stops on a definition mismatch.',
    );
    expect(await exists('old_drafts')).toBe(true);
  });
});
