// The explicit SQLite-to-PostgreSQL move of a user app (#5193). PGlite stands in
// for the server (a real one is CI's `test:postgres` lane, not run here).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseConfig, PGliteClient } from './db/index.ts';
import {
  AppHost,
  exportUserApp,
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
    {
      type: 'defineModel',
      name: 'Chore',
      fields: { title: { type: 'text' }, points: { type: 'integer' } },
    },
    A,
  );
  for (let i = 0; i < rows; i++)
    await host.create('Chore', { title: `c${i}`, points: i });
  await host.close();
  return { store, dataDir, file: join(dataDir, 'app.db') };
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

  it('is rerunnable: a crash after the import leaves no duplicates and no marker, the rerun finishes', async () => {
    const { store, dataDir } = await desktopApp();
    const database = await schemaConfig();
    const versions = await store.list();
    await expect(
      migrateUserAppToPostgres({
        dataDir,
        database,
        versions,
        onPhase: (p) => {
          if (p === 'imported') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(readPostgresMigrationMarker(dataDir)).toBeNull();
    expect(await isMigratedToPostgres(dataDir, database)).toBe(false);
    const again = await migrateUserAppToPostgres({
      dataDir,
      database,
      versions,
    });
    expect(again.status).toBe('migrated');
    expect(await count(database.schema, 'u_chores')).toBe(3);
    const third = await migrateUserAppToPostgres({
      dataDir,
      database,
      versions,
    });
    expect(third.status).toBe('already-migrated');
    expect(await count(database.schema, 'u_chores')).toBe(3);
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
    ).rejects.toThrow(/different/);
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

  it('is not migrated when the schema is gone or a marker is forged', async () => {
    const { store, dataDir } = await desktopApp();
    const database = await schemaConfig();
    await migrateUserAppToPostgres({
      dataDir,
      database,
      versions: await store.list(),
    });
    await pg.exec(`DROP SCHEMA "${database.schema}" CASCADE`);
    await pg.exec(`CREATE SCHEMA "${database.schema}"`);
    expect(await isMigratedToPostgres(dataDir, database)).toBe(false);

    const fresh = await desktopApp();
    writeFileSync(
      join(fresh.dataDir, POSTGRES_MIGRATION_MARKER),
      JSON.stringify({ format: 1, schema: database.schema }),
    );
    expect(readPostgresMigrationMarker(fresh.dataDir)).toBeNull();
    expect(await isMigratedToPostgres(fresh.dataDir, database)).toBe(false);
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
