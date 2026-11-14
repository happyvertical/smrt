import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBuildSchema } from '../migrations/build-schema.js';
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
});
