// The explicit SQLite-to-PostgreSQL move of a user app (#5193). PGlite stands in
// for the server (a real one is CI's `test:postgres` lane, not run here).

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import type { DatabaseConfig, PGliteClient } from './db/index.ts';
import {
  AppHost,
  exportUserApp,
  importUserApp,
  isMigratedToPostgres,
  MemoryVersionStore,
  migrateUserAppToPostgres,
  POSTGRES_MIGRATION_MARKER,
  readPostgresMigrationMarker,
} from './index.ts';

const A = { author: 't' };
let pg: PGliteClient;
const dirs: string[] = [];
let n = 0;

beforeAll(async () => {
  const { PGlite } = await importPGlite();
  pg = (await PGlite.create()) as PGliteClient;
});
afterAll(async () => {
  await pg.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'engine-sqlite-to-pg-'));
  dirs.push(d);
  return d;
};
const schemaConfig = async (): Promise<DatabaseConfig & { schema: string }> => {
  const schema = `app_m_${++n}_${Math.random().toString(36).slice(2, 8)}`;
  await pg.exec(`CREATE SCHEMA "${schema}"`);
  return { kind: 'pglite', schema, client: pg };
};
const count = async (schema: string, table: string) =>
  Number(
    (
      (await pg.query(`SELECT count(*) AS c FROM "${schema}"."${table}"`)) as {
        rows: { c: string }[];
      }
    ).rows[0].c,
  );

async function desktopApp(rows = 3) {
  const store = new MemoryVersionStore();
  const dataDir = dir();
  const host = await AppHost.open(dataDir, { allowUnfencedStore: true, store });
  await host.execute(
    hostOwner(host),
    {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text' }, points: { type: 'integer' } },
    },
    A,
  );
  for (let i = 0; i < rows; i++)
    await host.create(hostOwner(host), 'Chore', { title: `c${i}`, points: i });
  await host.close();
  return { store, dataDir, file: join(dataDir, 'app.db') };
}

async function importEmptyProbe(
  bundle: Awaited<ReturnType<typeof exportUserApp>>,
  database: DatabaseConfig,
): Promise<string> {
  const { importUserApp: imp } = await import('./index.ts');
  const completion = { key: 'sqlite-migration', value: '{}' };
  try {
    await imp({ dataDir: dir(), database, bundle });
  } catch {
    // an inconsistent digest is refused; the probe below is the real check
  }
  return (await imp({ dataDir: dir(), database, bundle, completion })).status;
}

describe('migrateUserAppToPostgres', () => {
  it('moves every row, writes the marker and keeps the SQLite file and its user rows', async () => {
    const { store, dataDir, file } = await desktopApp();
    const database = await schemaConfig();
    expect(await isMigratedToPostgres(dataDir, database)).toBe(false);
    const res = await migrateUserAppToPostgres({
      dataDir,
      database,
      versions: await store.list(),
    });
    expect(res.status).toBe('migrated');
    expect(await count(database.schema, 'u_chores')).toBe(3);
    expect(existsSync(file)).toBe(true);
    // The source still exports to the very bundle that was moved.
    const after = await exportUserApp({
      dataDir,
      versions: await store.list(),
    });
    expect(after.digest).toBe(res.digest);
    expect(readPostgresMigrationMarker(dataDir)?.schema).toBe(database.schema);
    expect(await isMigratedToPostgres(dataDir, database)).toBe(true);
  });

  it('a failure inside the transaction is never complete: nothing is recorded, a plain rerun converges', async () => {
    const { store, dataDir } = await desktopApp();
    const database = await schemaConfig();
    const versions = await store.list();
    await expect(
      migrateUserAppToPostgres({
        dataDir,
        database,
        versions,
        onTransaction: () => {
          throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(readPostgresMigrationMarker(dataDir)).toBeNull();
    expect(await isMigratedToPostgres(dataDir, database)).toBe(false);
    expect(await count(database.schema, 'u_chores')).toBe(0);
    const again = await migrateUserAppToPostgres({
      dataDir,
      database,
      versions,
    });
    expect(again.status).toBe('migrated');
    expect(await count(database.schema, 'u_chores')).toBe(3);
    expect(await isMigratedToPostgres(dataDir, database)).toBe(true);
  });

  it('a crash after the commit but before the marker file finishes without duplicates', async () => {
    const { store, dataDir } = await desktopApp();
    const database = await schemaConfig();
    const versions = await store.list();
    await expect(
      migrateUserAppToPostgres({
        dataDir,
        database,
        versions,
        onPhase: (p) => {
          if (p === 'verified') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(readPostgresMigrationMarker(dataDir)).toBeNull();
    expect(await isMigratedToPostgres(dataDir, database)).toBe(true);
    const again = await migrateUserAppToPostgres({
      dataDir,
      database,
      versions,
    });
    expect(again.status).toBe('already-migrated');
    expect(readPostgresMigrationMarker(dataDir)?.schema).toBe(database.schema);
    expect(await count(database.schema, 'u_chores')).toBe(3);
  });

  it('stays complete after an undo below the original version and a dropped archived table', async () => {
    const { store, dataDir } = await desktopApp();
    const database = await schemaConfig();
    await migrateUserAppToPostgres({
      dataDir,
      database,
      versions: await store.list(),
    });
    const schema = database.schema;
    await pg.exec(
      `UPDATE "${schema}"._app_meta SET value = '0' WHERE key = 'version'`,
    );
    await pg.exec(`CREATE TABLE "${schema}".u_extra (id TEXT)`);
    await pg.exec(`DROP TABLE "${schema}".u_extra`);
    await pg.exec(`DROP TABLE "${schema}"._archive`);
    expect(await isMigratedToPostgres(dataDir, database)).toBe(true);
    expect(
      (
        await migrateUserAppToPostgres({
          dataDir,
          database,
          versions: await store.list(),
        })
      ).status,
    ).toBe('already-migrated');
  });

  it('refuses, importing nothing, when the schema was recreated or emptied under a stale marker', async () => {
    const { store, dataDir } = await desktopApp();
    const database = await schemaConfig();
    const versions = await store.list();
    await migrateUserAppToPostgres({ dataDir, database, versions });
    await pg.exec(`DROP SCHEMA "${database.schema}" CASCADE`);
    await pg.exec(`CREATE SCHEMA "${database.schema}"`);
    expect(await isMigratedToPostgres(dataDir, database)).toBe(false);
    await expect(
      migrateUserAppToPostgres({ dataDir, database, versions }),
    ).rejects.toThrow(/no completion record/);
    expect(
      (
        (await pg.query(
          `SELECT count(*) AS c FROM information_schema.tables WHERE table_schema = $1`,
          [database.schema],
        )) as { rows: { c: string }[] }
      ).rows[0].c,
    ).toEqual(0 as never);
  });

  it('refuses a schema that already matches but was not completed by this migration', async () => {
    const { store, dataDir } = await desktopApp();
    const database = await schemaConfig();
    const versions = await store.list();
    const bundle = await exportUserApp({ dataDir, versions });
    await importUserApp({ dataDir: dir(), database, bundle });
    await expect(
      migrateUserAppToPostgres({ dataDir, database, versions }),
    ).rejects.toThrow(/without a completion record/);
    expect(await isMigratedToPostgres(dataDir, database)).toBe(false);
    expect(readPostgresMigrationMarker(dataDir)).toBeNull();
  });

  it('refuses a schema holding different data and does not mark', async () => {
    const a = await desktopApp(3);
    const b = await desktopApp(1);
    const database = await schemaConfig();
    await migrateUserAppToPostgres({
      dataDir: a.dataDir,
      database,
      versions: await a.store.list(),
    });
    await expect(
      migrateUserAppToPostgres({
        dataDir: b.dataDir,
        database,
        versions: await b.store.list(),
      }),
    ).rejects.toThrow(/different app/);
    expect(readPostgresMigrationMarker(b.dataDir)).toBeNull();
    expect(await count(database.schema, 'u_chores')).toBe(3);
  });

  it('refuses to move an app already migrated into another schema', async () => {
    const { store, dataDir } = await desktopApp();
    const versions = await store.list();
    await migrateUserAppToPostgres({
      dataDir,
      database: await schemaConfig(),
      versions,
    });
    const other = await schemaConfig();
    await expect(
      migrateUserAppToPostgres({ dataDir, database: other, versions }),
    ).rejects.toThrow(/different schema/);
    expect(
      await pg.query(`SELECT 1 FROM pg_tables WHERE schemaname = $1`, [
        other.schema,
      ]),
    ).toMatchObject({ rows: [] });
  });

  it('a marker file alone never counts as migrated', async () => {
    const database = await schemaConfig();
    const fresh = await desktopApp();
    writeFileSync(
      join(fresh.dataDir, POSTGRES_MIGRATION_MARKER),
      JSON.stringify({ format: 1, schema: database.schema }),
    );
    expect(readPostgresMigrationMarker(fresh.dataDir)).toBeNull();
    await migrateUserAppToPostgres({
      dataDir: (await desktopApp()).dataDir,
      database,
      versions: [],
    }).catch(() => {});
    expect(await isMigratedToPostgres(fresh.dataDir, database)).toBe(false);
  });

  it('a row recorded for another schema is not migrated', async () => {
    const { store, dataDir } = await desktopApp();
    const a = await schemaConfig();
    const b = await schemaConfig();
    await migrateUserAppToPostgres({
      dataDir,
      database: a,
      versions: await store.list(),
    });
    rmSync(join(dataDir, POSTGRES_MIGRATION_MARKER)); // a crash before the hint
    await pg.exec(
      `CREATE TABLE "${b.schema}"._app_meta AS SELECT * FROM "${a.schema}"._app_meta`,
    );
    expect(await isMigratedToPostgres(dataDir, a)).toBe(true);
    expect(await isMigratedToPostgres(dataDir, b)).toBe(false);
    // The migrate path refuses it too, and writes no marker naming another schema.
    await expect(
      migrateUserAppToPostgres({
        dataDir,
        database: b,
        versions: await store.list(),
      }),
    ).rejects.toThrow(/another schema|different schema/);
    expect(readPostgresMigrationMarker(dataDir)).toBeNull();
  });

  it('a malformed completion row fails closed with its own message', async () => {
    const { store, dataDir } = await desktopApp();
    const database = await schemaConfig();
    await migrateUserAppToPostgres({
      dataDir,
      database,
      versions: await store.list(),
    });
    await pg.exec(
      `UPDATE "${database.schema}"._app_meta SET value = 'garbage' WHERE key = 'sqlite-migration'`,
    );
    await expect(isMigratedToPostgres(dataDir, database)).rejects.toThrow(
      /migration record .* unreadable/,
    );
  });

  it('a database that cannot be read throws a retryable error, a missing schema is just not migrated', async () => {
    const { dataDir } = await desktopApp();
    expect(
      await isMigratedToPostgres(dataDir, {
        kind: 'pglite',
        schema: 'app_never_created',
        client: pg,
      }),
    ).toBe(false);
    const broken = {
      kind: 'pglite',
      schema: 'app_broken',
      client: {
        query: async () => {
          throw new Error('lock timeout');
        },
        exec: async () => {
          throw new Error('lock timeout');
        },
        transaction: async () => {
          throw new Error('lock timeout');
        },
      },
    } as unknown as DatabaseConfig;
    await expect(isMigratedToPostgres(dataDir, broken)).rejects.toThrow(
      /could not read/,
    );
  });

  it('an empty bundle into an empty built schema is completed, not refused', async () => {
    const { store, dataDir } = await desktopApp(0);
    const database = await schemaConfig();
    const versions = await store.list();
    const bundle = await exportUserApp({ dataDir, versions });
    for (const t of bundle.tables) t.rows = [];
    const recomputed = await importEmptyProbe(bundle, database);
    expect(recomputed).toBe('imported');
  });

  it('refuses a SQLite target and a missing SQLite app', async () => {
    const { store, dataDir } = await desktopApp();
    await expect(
      migrateUserAppToPostgres({
        dataDir,
        database: { kind: 'sqlite' } as never,
        versions: await store.list(),
      }),
    ).rejects.toThrow(/not a PostgreSQL/);
    await expect(
      migrateUserAppToPostgres({
        dataDir: dir(),
        database: await schemaConfig(),
        versions: [],
      }),
    ).rejects.toThrow(/no SQLite user app/);
  });
});
