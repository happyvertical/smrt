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

  it('propagates declarations across pooled child transaction handles and nested savepoints without extra info logs', async () => {
    const logs: string[] = [];
    const spies = (['info', 'warn', 'log', 'debug', 'error'] as const).map(
      (m) =>
        vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
          logs.push(a.map(String).join(' '));
        }),
    );
    try {
      const pool = { kind: 'pg-pool' };
      const createSavepointTx = (parentClient: object): DatabaseInterface => {
        const spClient = { kind: 'pg-savepoint', parentClient };
        return {
          url: 'postgres://localhost:5432/app',
          client: spClient,
          query: async () => ({ rows: [] }),
          tableExists: async () => true,
        } as unknown as DatabaseInterface;
      };
      const pooledDb = {
        url: 'postgres://localhost:5432/app',
        client: pool,
        query: async () => ({ rows: [] }),
        tableExists: async () => true,
        async transaction<T>(
          cb: (tx: DatabaseInterface) => Promise<T>,
        ): Promise<T> {
          // Simulate pg.Pool checking out a distinct PoolClient object per transaction.
          const checkedOutPoolClient = { kind: 'pg-pool-client' };
          const txHandle = {
            url: 'postgres://localhost:5432/app',
            client: checkedOutPoolClient,
            query: async () => ({ rows: [] }),
            tableExists: async () => true,
            async transaction<U>(
              nestedCb: (spTx: DatabaseInterface) => Promise<U>,
            ): Promise<U> {
              return nestedCb(createSavepointTx(checkedOutPoolClient));
            },
          } as unknown as DatabaseInterface;
          return cb(txHandle);
        },
      } as unknown as DatabaseInterface;

      declareRuntimeManagedDatabase(pooledDb, DECLARATION);
      expect(logs.filter((l) => /runtime-managed/i.test(l))).toHaveLength(1);

      let observedOuter: unknown;
      let observedNested: unknown;
      let checkedOutClientRef: object | undefined;
      if (!pooledDb.transaction) {
        throw new Error('pooledDb mock must define transaction');
      }
      await pooledDb.transaction(async (tx) => {
        checkedOutClientRef = (tx as unknown as { client: object }).client;
        expect(checkedOutClientRef).not.toBe(pool);
        observedOuter = runtimeManagedDatabaseDeclaration(tx);
        await assertDatabaseMigratedForBuild(tx);
        if (!tx.transaction) {
          throw new Error('tx mock must define savepoint transaction');
        }
        await tx.transaction(async (savepointTx) => {
          observedNested = runtimeManagedDatabaseDeclaration(savepointTx);
          await assertDatabaseMigratedForBuild(savepointTx);
        });
      });

      expect(observedOuter).toEqual(DECLARATION);
      expect(observedNested).toEqual(DECLARATION);
      // Child transaction propagation must not re-log startup declaration lines.
      expect(logs.filter((l) => /runtime-managed/i.test(l))).toHaveLength(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('does not recurse when declared on a get-only Proxy wrapper around a raw handle (app-shell scopeDatabase)', async () => {
    const rawClient = { kind: 'raw-pg-pool' };
    const sharedScopedToken = { kind: 'scoped-client-token' };
    const rawTxMethod = async <T>(
      cb: (tx: DatabaseInterface) => Promise<T>,
    ): Promise<T> => {
      const innerTx = {
        url: 'postgres://localhost:5432/boxbones',
        client: { kind: 'checked-out' },
        query: async () => ({ rows: [], rowCount: 0 }),
      } as unknown as DatabaseInterface;
      return cb(innerTx);
    };
    const raw = {
      url: 'postgres://localhost:5432/boxbones',
      client: rawClient,
      transaction: rawTxMethod,
    } as unknown as DatabaseInterface;

    const members: Record<string, unknown> = {
      client: sharedScopedToken,
      transaction: <T>(cb: (tx: DatabaseInterface) => Promise<T>) => {
        if (!raw.transaction) throw new Error('missing raw.transaction');
        return raw.transaction(async (tx) => {
          const guarded = new Proxy(tx, {
            get(target, prop) {
              if (prop === 'client') return sharedScopedToken;
              const val = Reflect.get(target, prop, target);
              return typeof val === 'function' ? val.bind(target) : val;
            },
          });
          return cb(guarded);
        });
      },
      query: () => {
        if (!raw.transaction) throw new Error('missing raw.transaction');
        return raw.transaction(async (tx) => tx.query('SELECT 1'));
      },
    };

    const scopedProxy = new Proxy(raw, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && Object.hasOwn(members, prop)) {
          return members[prop];
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    declareRuntimeManagedDatabase(scopedProxy, DECLARATION);
    expect(raw.transaction).toBe(rawTxMethod);
    await expect(scopedProxy.query('SELECT 1')).resolves.toEqual({
      rows: [],
      rowCount: 0,
    });
    if (!scopedProxy.transaction) {
      throw new Error('scopedProxy must expose transaction');
    }
    await scopedProxy.transaction(async (tx) => {
      expect(runtimeManagedDatabaseDeclaration(tx)).toEqual(DECLARATION);
      await assertDatabaseMigratedForBuild(tx);
    });
  });
});
