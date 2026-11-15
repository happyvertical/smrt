import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as browserEntry from '../browser.js';
import * as rootEntry from '../index.js';
import { registerBuildSchema } from '../migrations/build-schema.js';
import * as migrationsEntry from '../migrations/index.js';
import {
  declareRuntimeManagedDatabase,
  runtimeManagedDatabaseDeclaration,
} from '../migrations/runtime-managed-database.js';
import { assertDatabaseMigratedForBuild } from '../migrations/startup-guard.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectDefinition } from '../scanner/types.js';
import { verifyPersistenceTable } from './table-verifier.js';

const PKG = '@test4927/runtime-managed';
const TABLE = 'managed4927';
const KEY = `${PKG}:Managed4927`;
const DECLARATION = {
  owner: '@test4927/engine',
  reason: 'The test engine builds this schema itself.',
};

function registerBuild() {
  const definition = {
    name: 'managed4927',
    className: 'Managed4927',
    collection: TABLE,
    filePath: 'src/managed.ts',
    extends: 'SmrtObject',
    fields: { name: { type: 'text' } },
    methods: {},
    decoratorConfig: { tableName: TABLE },
    packageName: PKG,
  } as SmartObjectDefinition;
  registerBuildSchema(
    new ManifestGenerator().generateManifest(
      [{ filePath: definition.filePath, objects: [definition], errors: [] }],
      { packageName: PKG },
    ),
  );
}

async function open(file: string): Promise<DatabaseInterface> {
  return getDatabase({
    type: 'sqlite',
    url: file,
    __smrtSkipVitestSchemaPreparation: true,
  } as Parameters<typeof getDatabase>[0]);
}

describe('runtime-managed databases and the startup check (#4927)', () => {
  let dir: string;
  let file: string;
  const handles: DatabaseInterface[] = [];
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SMRT_ALLOW_UNMIGRATED_START', '');
    dir = mkdtempSync(join(tmpdir(), 'smrt-4927-managed-'));
    file = join(dir, 'app.db');
    registerBuild();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    registerBuildSchema(undefined);
    for (const db of handles.splice(0)) await db.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses an undeclared handle under production settings', async () => {
    const db = await open(file);
    handles.push(db);
    await db.query(`CREATE TABLE ${TABLE} (id TEXT)`);
    await expect(verifyPersistenceTable(db, TABLE, KEY)).rejects.toMatchObject({
      code: 'DB_MIGRATION_REQUIRED',
    });
  });

  it('skips only the migrate comparison for a declared handle and its transactions', async () => {
    const db = await open(file);
    handles.push(db);
    declareRuntimeManagedDatabase(db, DECLARATION);
    expect(runtimeManagedDatabaseDeclaration(db)).toEqual(DECLARATION);
    await assertDatabaseMigratedForBuild(db);
    // Table existence is still verified.
    await expect(verifyPersistenceTable(db, TABLE, KEY)).rejects.toThrow(TABLE);
    await db.query(`CREATE TABLE ${TABLE} (id TEXT)`);
    await verifyPersistenceTable(db, TABLE, KEY);
    // A transaction handle shares the declared connection.
    if (!db.transaction) throw new Error('sqlite handles support transactions');
    await db.transaction(async (tx: DatabaseInterface) => {
      expect(runtimeManagedDatabaseDeclaration(tx)).toEqual(DECLARATION);
      await assertDatabaseMigratedForBuild(tx);
    });
    // Nothing was written to make the check pass.
    expect(await db.tableExists('_smrt_migrate_runs')).toBe(false);
  });

  it('does not cover another handle opened on the same file', async () => {
    const declared = await open(file);
    const other = await open(file);
    handles.push(declared, other);
    declareRuntimeManagedDatabase(declared, DECLARATION);
    expect(runtimeManagedDatabaseDeclaration(other)).toBeUndefined();
    await expect(assertDatabaseMigratedForBuild(other)).rejects.toMatchObject({
      code: 'DB_MIGRATION_REQUIRED',
    });
  });

  it('needs an owner and a reason', async () => {
    const db = await open(file);
    handles.push(db);
    expect(() =>
      declareRuntimeManagedDatabase(db, { owner: '', reason: 'x' }),
    ).toThrow(TypeError);
    expect(() =>
      declareRuntimeManagedDatabase(db, { owner: 'x', reason: '  ' }),
    ).toThrow(TypeError);
    expect(runtimeManagedDatabaseDeclaration(db)).toBeUndefined();
  });

  it('logs each declaration once per handle, naming owner, reason and database', async () => {
    const logs: string[] = [];
    const spies = (['info', 'warn', 'log', 'debug', 'error'] as const).map(
      (m) =>
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          logs.push(a.map(String).join(' '));
        }),
    );
    try {
      const db = await open(file);
      handles.push(db);
      declareRuntimeManagedDatabase(db, DECLARATION);
      declareRuntimeManagedDatabase(db, DECLARATION);
      await assertDatabaseMigratedForBuild(db);
      await assertDatabaseMigratedForBuild(db);
      const mine = logs.filter((l) => /runtime-managed/i.test(l));
      expect(mine).toHaveLength(1);
      expect(mine[0]).toContain(DECLARATION.owner);
      expect(mine[0]).toContain(DECLARATION.reason);
      expect(mine[0]).toContain(file);
      const other = await open(join(dir, 'other.db'));
      handles.push(other);
      declareRuntimeManagedDatabase(other, DECLARATION);
      expect(logs.filter((l) => /runtime-managed/i.test(l))).toHaveLength(2);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('does not put credentials from a connection URL in the log', async () => {
    const logs: string[] = [];
    const spies = (['info', 'warn', 'log', 'debug', 'error'] as const).map(
      (m) =>
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          logs.push(a.map(String).join(' '));
        }),
    );
    try {
      const db = await open(file);
      handles.push(db);
      (db as { url?: string }).url =
        'postgres://admin:s3cret@db.example.com:5432/app?password=s3cret';
      declareRuntimeManagedDatabase(db, DECLARATION);
      const text = logs.join('\n');
      expect(text).toContain('db.example.com');
      expect(text).not.toContain('s3cret');
      expect(text).not.toContain('admin');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('is exported from the migrations entry only', () => {
    for (const entry of [rootEntry, browserEntry] as Record<
      string,
      unknown
    >[]) {
      expect(entry.declareRuntimeManagedDatabase).toBeUndefined();
      expect(entry.runtimeManagedDatabaseDeclaration).toBeUndefined();
    }
    expect(typeof migrationsEntry.declareRuntimeManagedDatabase).toBe(
      'function',
    );
  });
});
