/**
 * `_smrt_contexts` tenant partition upgrade (#5449): a database whose memory
 * identity is the tenant-blind `UNIQUE(owner_class, owner_id, scope, key,
 * version)` ends, unattended, with the fresh-install shape — a NOT NULL
 * `tenant_id` in the identity — every existing row carried into the global
 * partition, and two tenants able to hold the same owner/scope/key. Each step
 * is idempotent.
 *
 * Runs on real in-memory SQLite and DuckDB; PGlite joins when the lane sets
 * `SMRT_TEST_PGLITE=1` (`pnpm test:pglite`). Never mocks the database.
 */

import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { LearningMemory } from '../learning/memory';
import { ensureSystemTables } from '../system/bootstrap';
import { ensureContextsSystemTableCompatibility } from '../system/compatibility';
import {
  CREATE_SMRT_CONTEXTS_TABLE,
  getSystemTableDDLForEngine,
} from '../system/schema';
import { getTestDatabase } from '../testing/database';

type Engine = 'sqlite' | 'duckdb' | 'pglite';

const engines: Engine[] = [
  'sqlite',
  'duckdb',
  ...(process.env.SMRT_TEST_PGLITE === '1' ? (['pglite'] as const) : []),
];

/** `_smrt_contexts` as schema 1.20.0 and earlier created it. */
const LEGACY_CONTEXTS_DDL = `
CREATE TABLE _smrt_contexts (
  id TEXT PRIMARY KEY,
  owner_class TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  metadata TEXT,
  version INTEGER DEFAULT 1,
  confidence REAL DEFAULT 1.0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP,
  expires_at TIMESTAMP,
  UNIQUE(owner_class, owner_id, scope, key, version)
)`;

const TENANT_A = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e01';
const TENANT_B = '9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c02';

const open: DatabaseInterface[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) await db.close?.();
});

function engineOf(engine: Engine): 'sqlite' | 'duckdb' | 'postgres' {
  return engine === 'pglite' ? 'postgres' : engine;
}

async function newDatabase(engine: Engine): Promise<DatabaseInterface> {
  const db =
    engine === 'pglite'
      ? await getTestDatabase({
          type: 'pglite',
          classes: [],
          includeSystemTables: false,
        })
      : ((await getDatabase({
          type: engine,
          url: ':memory:',
        })) as DatabaseInterface);
  open.push(db);
  return db;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function legacyDatabase(engine: Engine): Promise<DatabaseInterface> {
  const db = await newDatabase(engine);
  await db.query(
    getSystemTableDDLForEngine(LEGACY_CONTEXTS_DDL, engineOf(engine)),
  );
  await db.query(
    `INSERT INTO _smrt_contexts
       (id, owner_class, owner_id, scope, key, value, version, confidence,
        success_count)
     VALUES ('legacy-1', 'Learner', 'shared-scope', 'parser', 'invoice',
             '"legacy"', 1, 0.95, 3)`,
  );
  return db;
}

async function contextColumns(
  db: DatabaseInterface,
  engine: Engine,
): Promise<Record<string, { notNull: boolean; default: unknown }>> {
  const columns: Record<string, { notNull: boolean; default: unknown }> = {};
  if (engine === 'pglite') {
    for (const row of rowsOf(
      await db.query(
        `SELECT column_name, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = '_smrt_contexts'`,
      ),
    )) {
      columns[String(row.column_name)] = {
        notNull: row.is_nullable === 'NO',
        default: row.column_default,
      };
    }
    return columns;
  }
  for (const row of rowsOf(
    await db.query('PRAGMA table_info(_smrt_contexts)'),
  )) {
    columns[String(row.name)] = {
      notNull: row.notnull === 1 || row.notnull === true,
      default: row.dflt_value,
    };
  }
  return columns;
}

describe.each(
  engines,
)('_smrt_contexts tenant partition upgrade (%s)', (engine) => {
  it('adds a NOT NULL tenant_id and carries every row into the global partition', async () => {
    const db = await legacyDatabase(engine);

    await ensureSystemTables(db, engineOf(engine));

    const columns = await contextColumns(db, engine);
    expect(columns.tenant_id?.notNull).toBe(true);
    const rows = rowsOf(
      await db.query(
        'SELECT id, tenant_id, value, success_count FROM _smrt_contexts',
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'legacy-1',
      tenant_id: '',
      value: '"legacy"',
    });
    expect(Number(rows[0]?.success_count)).toBe(3);
  });

  it('lets two tenants and the global partition hold the same owner, scope and key', async () => {
    const db = await legacyDatabase(engine);
    await ensureSystemTables(db, engineOf(engine));

    const memory = (tenantId?: string) =>
      new LearningMemory({
        db,
        ownerClass: 'Learner',
        ownerId: 'shared-scope',
        ...(tenantId ? { tenantId } : {}),
      });

    await memory(TENANT_A).capture(
      { scope: 'parser', key: 'invoice', value: 'a' },
      { success: true },
    );
    await memory(TENANT_B).capture(
      { scope: 'parser', key: 'invoice', value: 'b' },
      { success: true },
    );

    const rows = rowsOf(
      await db.query(
        'SELECT tenant_id, value FROM _smrt_contexts ORDER BY tenant_id',
      ),
    );
    expect(rows).toEqual([
      { tenant_id: '', value: '"legacy"' },
      { tenant_id: TENANT_A, value: '"a"' },
      { tenant_id: TENANT_B, value: '"b"' },
    ]);
    expect(
      (await memory().recall('parser', { key: 'invoice' }))[0]?.value,
    ).toBe('legacy');
    expect(
      (await memory(TENANT_A).recall('parser', { key: 'invoice' }))[0]?.value,
    ).toBe('a');
  });

  it('still rejects a second row with the same identity in one partition', async () => {
    const db = await legacyDatabase(engine);
    await ensureSystemTables(db, engineOf(engine));

    await expect(
      db.query(
        `INSERT INTO _smrt_contexts
           (id, tenant_id, owner_class, owner_id, scope, key, version)
         VALUES ('dup-1', '', 'Learner', 'shared-scope', 'parser', 'invoice', 1)`,
      ),
    ).rejects.toThrow();
  });

  it.skipIf(engine === 'pglite')(
    'finishes a rebuild interrupted after the old table was dropped',
    async () => {
      const db = await legacyDatabase(engine);
      // The state between "DROP TABLE _smrt_contexts" and the rename.
      await db.query(
        getSystemTableDDLForEngine(
          CREATE_SMRT_CONTEXTS_TABLE.split(';')[0] ?? '',
          engineOf(engine),
        ).replace('_smrt_contexts', '_smrt_contexts_new'),
      );
      await db.query(
        `INSERT INTO _smrt_contexts_new (id, owner_class, owner_id, scope, key, value)
         SELECT id, owner_class, owner_id, scope, key, value FROM _smrt_contexts`,
      );
      await db.query('DROP TABLE _smrt_contexts');

      await ensureSystemTables(db, engineOf(engine));

      expect(
        rowsOf(await db.query('SELECT id, tenant_id FROM _smrt_contexts')),
      ).toEqual([{ id: 'legacy-1', tenant_id: '' }]);
    },
  );

  it('is idempotent', async () => {
    const db = await legacyDatabase(engine);
    await ensureSystemTables(db, engineOf(engine));
    const before = rowsOf(
      await db.query('SELECT id, tenant_id FROM _smrt_contexts'),
    );

    await ensureContextsSystemTableCompatibility(db, engineOf(engine));
    await ensureSystemTables(db, engineOf(engine));

    expect(
      rowsOf(await db.query('SELECT id, tenant_id FROM _smrt_contexts')),
    ).toEqual(before);
    expect((await contextColumns(db, engine)).tenant_id?.notNull).toBe(true);
  });
});

/** Legacy rows with distinct contents, so a lost or duplicated row shows. */
async function seedLegacyRows(db: DatabaseInterface, count: number) {
  for (let index = 0; index < count; index++) {
    await db.query(
      `INSERT INTO _smrt_contexts
         (id, owner_class, owner_id, scope, key, value, version, confidence)
       VALUES (?, 'Learner', ?, 'parser', ?, ?, 1, 0.9)`,
      `legacy-${index}`,
      `owner-${index % 7}`,
      `key-${index}`,
      JSON.stringify({ n: index }),
    );
  }
}

async function contextContents(db: DatabaseInterface) {
  return rowsOf(
    await db.query(
      'SELECT id, tenant_id, owner_id, key, value FROM _smrt_contexts ORDER BY id',
    ),
  );
}

describe('_smrt_contexts rebuild transaction requirements', () => {
  it('refuses to rebuild a populated legacy table on a handle without transactions', async () => {
    const db = await legacyDatabase('sqlite');
    const noTransactions = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction' || property === 'beginTransaction') {
          return undefined;
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as DatabaseInterface;

    await expect(
      ensureContextsSystemTableCompatibility(noTransactions, 'sqlite'),
    ).rejects.toMatchObject({ name: 'SystemTableRebuildError' });
    // Nothing destructive ran: the legacy table and its row are intact.
    expect(await contextColumns(db, 'sqlite')).not.toHaveProperty('tenant_id');
    expect(
      rowsOf(await db.query('SELECT id FROM _smrt_contexts')).map((r) => r.id),
    ).toEqual(['legacy-1']);
  });

  it('rebuilds inside a caller-owned DuckDB transaction and rolls back with it', async () => {
    const db = await legacyDatabase('duckdb');
    const transaction = db.transaction?.bind(db);
    if (!transaction) throw new Error('DuckDB adapter has transactions');

    await expect(
      transaction(async (tx: DatabaseInterface) => {
        await ensureSystemTables(tx, 'duckdb');
        throw new Error('caller rolls back');
      }),
    ).rejects.toThrow('caller rolls back');
    expect(await contextColumns(db, 'duckdb')).not.toHaveProperty('tenant_id');
    expect(
      rowsOf(await db.query('SELECT id FROM _smrt_contexts')).map((r) => r.id),
    ).toEqual(['legacy-1']);

    await transaction(async (tx: DatabaseInterface) => {
      await ensureSystemTables(tx, 'duckdb');
    });
    expect(await contextColumns(db, 'duckdb')).toHaveProperty('tenant_id');
    expect(
      rowsOf(await db.query('SELECT id, tenant_id FROM _smrt_contexts')),
    ).toEqual([{ id: 'legacy-1', tenant_id: '' }]);
  });
});

describe('_smrt_contexts rebuild under concurrent starts (sqlite file)', () => {
  it('two handles starting together keep every legacy row exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contexts-concurrent-'));
    try {
      const url = join(dir, 'app.db');
      const open = (dbid: string) =>
        getDatabase({
          type: 'sqlite',
          url,
          dbid,
        } as never) as Promise<DatabaseInterface>;
      const seed = await open('contexts-seed');
      await seed.query(LEGACY_CONTEXTS_DDL);
      await seedLegacyRows(seed, 120);
      await seed.close?.();

      for (let round = 0; round < 3; round++) {
        const roundUrl = join(dir, `round-${round}.db`);
        copyFileSync(url, roundUrl);
        const a = (await getDatabase({
          type: 'sqlite',
          url: roundUrl,
          dbid: `contexts-a-${round}`,
        } as never)) as DatabaseInterface;
        const b = (await getDatabase({
          type: 'sqlite',
          url: roundUrl,
          dbid: `contexts-b-${round}`,
        } as never)) as DatabaseInterface;
        try {
          const results = await Promise.allSettled([
            ensureSystemTables(a, 'sqlite'),
            ensureSystemTables(b, 'sqlite'),
          ]);
          expect(results.map((r) => r.status)).toEqual([
            'fulfilled',
            'fulfilled',
          ]);
          const rows = await contextContents(a);
          expect(rows).toHaveLength(120);
          expect(new Set(rows.map((row) => row.id)).size).toBe(120);
          for (const row of rows) {
            const index = Number(String(row.id).slice('legacy-'.length));
            expect(row).toEqual({
              id: `legacy-${index}`,
              tenant_id: '',
              owner_id: `owner-${index % 7}`,
              key: `key-${index}`,
              value: JSON.stringify({ n: index }),
            });
          }
          expect(await contextContents(b)).toEqual(rows);
        } finally {
          await a.close?.();
          await b.close?.();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('_smrt_contexts upgrade on a persisted JSON store', () => {
  it('migrates a legacy store, keeps its rows and survives two more reopens', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contexts-json-'));
    const open = async (dbid: string) =>
      (await getDatabase({
        type: 'json',
        url: dir,
        dbid,
      } as never)) as DatabaseInterface;
    try {
      // The adapter persists a table (rows and DDL) on its own writes.
      const legacy = await open('contexts-json-1');
      await legacy.query(LEGACY_CONTEXTS_DDL);
      for (let index = 0; index < 5; index++) {
        await legacy.insert('_smrt_contexts', {
          id: `legacy-${index}`,
          owner_class: 'Learner',
          owner_id: `owner-${index % 7}`,
          scope: 'parser',
          key: `key-${index}`,
          value: JSON.stringify({ n: index }),
          version: 1,
          confidence: 0.9,
        });
      }
      await legacy.close?.();

      const upgraded = await open('contexts-json-2');
      await ensureSystemTables(upgraded, 'json');
      const rows = await contextContents(upgraded);
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.tenant_id === '')).toBe(true);
      await upgraded.close?.();

      for (const dbid of ['contexts-json-3', 'contexts-json-4']) {
        const reopened = await open(dbid);
        // The new shape was persisted: it is there before any bootstrap.
        expect(await contextColumns(reopened, 'duckdb')).toHaveProperty(
          'tenant_id',
        );
        await ensureSystemTables(reopened, 'json');
        expect(
          (await contextContents(reopened)).filter(
            (row) => row.tenant_id === '',
          ),
        ).toEqual(rows);
        await new LearningMemory({
          db: reopened,
          ownerClass: 'Learner',
          ownerId: 'owner-1',
          tenantId: TENANT_A,
        }).capture(
          { scope: 'parser', key: `key-${dbid}`, value: dbid },
          { success: true },
        );
        await reopened.close?.();
      }
      const last = await open('contexts-json-5');
      expect(
        rowsOf(
          await last.query(
            `SELECT key FROM _smrt_contexts WHERE tenant_id = '${TENANT_A}' ORDER BY key`,
          ),
        ).map((row) => row.key),
      ).toEqual(['key-contexts-json-3', 'key-contexts-json-4']);
      await last.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not write the export directory of a native DuckDB store in manual mode', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contexts-duck-manual-'));
    try {
      const db = (await getDatabase({
        type: 'duckdb',
        url: ':memory:',
        dataDir: dir,
        writeStrategy: 'manual',
        autoRegister: false,
      } as never)) as DatabaseInterface;
      await db.query(getSystemTableDDLForEngine(LEGACY_CONTEXTS_DDL, 'duckdb'));
      await seedLegacyRows(db, 3);

      await ensureContextsSystemTableCompatibility(db, 'duckdb');

      expect(await contextColumns(db, 'duckdb')).toHaveProperty('tenant_id');
      expect(readdirSync(dir)).toEqual([]);
      await db.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists a reinforcement of an existing memory and refuses one on a read-only store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'contexts-json-reinforce-'));
    const open = async (dbid: string, writeStrategy?: 'none') =>
      (await getDatabase({
        type: 'json',
        url: dir,
        dbid,
        ...(writeStrategy ? { writeStrategy } : {}),
      } as never)) as DatabaseInterface;
    const memoryOn = (db: DatabaseInterface) =>
      new LearningMemory({
        db,
        ownerClass: 'Learner',
        ownerId: 'owner-r',
        tenantId: TENANT_A,
      });
    const stored = async (db: DatabaseInterface) =>
      rowsOf(
        await db.query(
          `SELECT value, success_count, failure_count FROM _smrt_contexts WHERE owner_id = 'owner-r'`,
        ),
      );
    try {
      const first = await open('contexts-json-r1');
      await ensureSystemTables(first, 'json');
      const memory = memoryOn(first);
      await memory.capture(
        { scope: 'parser', key: 'k', value: 'v1' },
        { success: true },
      );
      // The second capture reinforces the existing row.
      await memory.capture(
        { scope: 'parser', key: 'k', value: 'v2' },
        { success: false },
      );
      await first.close?.();

      const reopened = await open('contexts-json-r2');
      await ensureSystemTables(reopened, 'json');
      const rows = await stored(reopened);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.value).toBe('"v2"');
      expect(Number(rows[0]?.success_count)).toBe(1);
      expect(Number(rows[0]?.failure_count)).toBe(1);
      await reopened.close?.();

      const readOnly = await open('contexts-json-r3', 'none');
      await expect(
        memoryOn(readOnly).capture(
          { scope: 'parser', key: 'k', value: 'v3' },
          { success: true },
        ),
      ).rejects.toThrow();
      // Recall still works on a read-only store.
      const [hit] = await memoryOn(readOnly).recall('parser', {
        key: 'k',
        minConfidence: 0,
      });
      expect(hit?.value).toBe('v2');
      await readOnly.close?.();

      const after = await open('contexts-json-r4');
      expect((await stored(after))[0]?.value).toBe('"v2"');
      await after.close?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
