// The user app's portable export across databases (#5193, epic #5183): a
// desktop (SQLite) app moves to a hosted (PostgreSQL schema) one and back with
// every record, hidden field, timestamp, history record and undo point. A
// registered `test:postgres` suite: always on an in-process PGlite, and also on
// a real server when `SMRT_TEST_POSTGRES_URL` is set (CI's "Registered
// PostgreSQL Suites" lane); each case gets its own schema, created and dropped
// here as a host's provisioning would.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import type { DatabaseConfig, PGliteClient } from './db/index.ts';
import {
  AppHost,
  checkUserAppBundle,
  exportUserApp,
  importUserApp,
  inspectUserApp,
  MemoryVersionStore,
  type PortableUserApp,
  verifyUserApp,
} from './index.ts';
import { asEngine } from './pg-test-support.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;
const A = { author: 't' };
const OK = { author: 't', approved: true };
const viaJson = (b: PortableUserApp) => JSON.parse(JSON.stringify(b));

describe.each(
  backends,
)('portable user app across databases (%s)', (backend) => {
  let admin: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
    close?: () => Promise<void>;
  };
  let pglite: PGliteClient | undefined;
  const dirs: string[] = [];
  const schemas: string[] = [];

  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), 'engine-portable-pg-'));
    dirs.push(d);
    return d;
  };
  const newSchema = async (label: string) => {
    const schema = `app_pt_${label}_${Math.random().toString(36).slice(2, 8)}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return schema;
  };
  const config = (schema: string): DatabaseConfig =>
    backend === 'postgres'
      ? { kind: 'postgres', schema, connection: { url: serverUrl, max: 2 } }
      : { kind: 'pglite', schema, client: pglite as PGliteClient };
  const rows = async (sql: string, params: unknown[] = []) =>
    asEngine(admin as any, sql, params);

  beforeAll(async () => {
    if (backend === 'postgres') {
      admin = (await getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 2,
      } as any)) as any;
    } else {
      const { PGlite } = await importPGlite();
      pglite = (await PGlite.create()) as PGliteClient;
      admin = (await getDatabase({
        type: 'pglite',
        client: pglite,
      } as any)) as any;
    }
  });
  afterAll(async () => {
    for (const s of schemas)
      await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {});
    if (backend === 'postgres') await admin.close?.();
    else await pglite?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** A desktop app: every kind of column, a hidden field, a removed field (undo data). */
  async function desktopApp() {
    const store = new MemoryVersionStore();
    const dataDir = dir();
    const host = await AppHost.open(dataDir, {
      allowUnfencedStore: true,
      store,
    });
    await host.execute(
      hostOwner(host),
      {
        type: 'defineModel',
        name: 'Owner',
        fields: { name: { type: 'text' } },
      },
      A,
    );
    await host.execute(
      hostOwner(host),
      {
        type: 'defineModel',
        name: 'Chore',
        fields: {
          title: { type: 'text' },
          points: { type: 'integer' },
          done: { type: 'boolean' },
          due: { type: 'date' },
          extra: { type: 'json' },
          cost: { type: 'money', money: { currency: 'USD', scale: 2 } },
          ratio: { type: 'number' },
          owner: { type: 'reference', ref: 'Owner' },
          secret: { type: 'text' },
          notes: { type: 'text' },
        },
      },
      A,
    );
    const ann = await host.create(hostOwner(host), 'Owner', { name: 'Ann' });
    await host.create(hostOwner(host), 'Chore', {
      title: 'Bins',
      points: 3,
      done: true,
      due: '2026-01-02T03:04:05.000Z',
      extra: { b: 1, a: [1, 2] },
      cost: 1250,
      ratio: 0.5,
      owner: String(ann.id),
      secret: 's-1',
      notes: 'note 1',
    });
    await host.create(hostOwner(host), 'Chore', {
      title: 'Dishes',
      points: 0,
      done: false,
      ratio: 2,
      secret: null,
      notes: 'note 2',
    });
    await host.execute(
      hostOwner(host),
      { type: 'hideField', model: 'Chore', field: 'secret' },
      A,
    );
    await host.execute(
      hostOwner(host),
      { type: 'removeField', model: 'Chore', field: 'notes' },
      OK,
    );
    await host.close();
    return { store, dataDir };
  }

  const hostOn = async (
    bundle: PortableUserApp,
    dataDir: string,
    database?: DatabaseConfig,
  ) => {
    const store = new MemoryVersionStore();
    for (const v of bundle.versions) await store.append(v);
    await store.setCurrent(bundle.version);
    return AppHost.open(dataDir, {
      allowUnfencedStore: true,
      store,
      ...(database ? { database } : {}),
    });
  };

  it("installs over the engine's own untouched first start, and never over an app that was built in (#5193)", async () => {
    const { store, dataDir } = await desktopApp();
    const local = viaJson(
      await exportUserApp({ dataDir, versions: await store.list() }),
    ) as PortableUserApp;

    // A hosted tenant opened its app once: version 0, no model, no row.
    const fresh = await newSchema('untouched');
    const freshDir = dir();
    const first = await AppHost.open(freshDir, {
      allowUnfencedStore: true,
      store: new MemoryVersionStore(),
      database: config(fresh),
    });
    await first.close();
    const placed = await importUserApp({
      dataDir: freshDir,
      database: config(fresh),
      bundle: local,
    });
    expect(placed.status).toBe('imported');
    expect(
      (
        await verifyUserApp({
          dataDir: freshDir,
          database: config(fresh),
          bundle: local,
        })
      ).ok,
    ).toBe(true);

    // An app that was built in (a model, even with no row) is someone's: refused.
    const built = await newSchema('built');
    const builtDir = dir();
    const host = await AppHost.open(builtDir, {
      allowUnfencedStore: true,
      store: new MemoryVersionStore(),
      database: config(built),
    });
    await host.execute(
      hostOwner(host),
      { type: 'defineModel', name: 'Mine', fields: { n: { type: 'text' } } },
      A,
    );
    await host.close();
    await expect(
      importUserApp({
        dataDir: builtDir,
        database: config(built),
        bundle: local,
      }),
    ).rejects.toThrow(/different version|different user app/);
  });

  it('moves a desktop app to PostgreSQL and back: every record, hidden field, timestamp, history and undo point', async () => {
    const { store, dataDir } = await desktopApp();
    const local = viaJson(
      await exportUserApp({ dataDir, versions: await store.list() }),
    ) as PortableUserApp;
    expect(local.source).toBe('sqlite');
    expect(checkUserAppBundle(local)).toEqual([]);

    // To the hosted schema.
    const schema = await newSchema('rt');
    const database = config(schema);
    const hostedDir = dir();
    const imported = await importUserApp({
      dataDir: hostedDir,
      database,
      bundle: local,
    });
    expect(imported.status).toBe('imported');
    expect(
      (await verifyUserApp({ dataDir: hostedDir, database, bundle: local })).ok,
    ).toBe(true);

    // The hosted copy holds the very rows: hidden column and timestamps too,
    // in PostgreSQL's own types.
    const pg = await rows(
      `SELECT title, points, done, extra, cost, ratio, secret, created_at, updated_at, owner
         FROM "${schema}".u_chores ORDER BY title`,
    );
    expect(pg.map((r) => r.title)).toEqual(['Bins', 'Dishes']);
    expect(pg[0].secret).toBe('s-1');
    expect(pg[0].done).toBe(true);
    expect(String(pg[0].points)).toBe('3');
    expect(pg[0].extra).toEqual({ b: 1, a: [1, 2] });
    expect(pg[1].secret).toBeNull();
    const srcRows = local.tables.find((t) => t.name === 'u_chores')!.rows;
    const bins = srcRows.find((r) => r.title === 'Bins')!;
    expect(new Date(pg[0].created_at).toISOString()).toBe(bins.created_at);

    // Back out: the export from PostgreSQL has the same digest as the one
    // from SQLite (the digest does not depend on the database).
    const hosted = await exportUserApp({
      dataDir: hostedDir,
      database,
      versions: local.versions,
    });
    expect(hosted.source).toBe('postgres');
    expect(hosted.digest).toBe(local.digest);
    // Core's `_smrt_*` tables stay out of the comparison: SQLite carries
    // them, PostgreSQL's own boot makes them.
    const appTables = (b: typeof local) =>
      b.tables
        .filter((t) => !t.name.startsWith('_smrt_'))
        .map((t) => [t.name, t.digest]);
    expect(appTables(hosted)).toEqual(appTables(local));

    // And the hosted app works: records, and undo of the removed field.
    const h1 = await hostOn(local, hostedDir, database);
    expect(
      (await h1.list(hostOwner(h1), 'Chore')).map((r: any) => r.title).sort(),
    ).toEqual(['Bins', 'Dishes']);
    expect(await h1.execute(hostOwner(h1), { type: 'undo' }, OK)).toBeTruthy();
    expect(
      (await h1.list(hostOwner(h1), 'Chore')).map((r: any) => r.notes).sort(),
    ).toEqual(['note 1', 'note 2']);
    await h1.close();

    // Back to a desktop database.
    const back = dir();
    const result = await importUserApp({
      dataDir: back,
      bundle: viaJson(hosted),
    });
    expect(result.status).toBe('imported');
    expect((await verifyUserApp({ dataDir: back, bundle: local })).ok).toBe(
      true,
    );
    const again = await exportUserApp({
      dataDir: back,
      versions: local.versions,
    });
    expect(again.digest).toBe(local.digest);
    const h2 = await hostOn(local, back);
    expect(await h2.execute(hostOwner(h2), { type: 'undo' }, OK)).toBeTruthy();
    expect(
      (await h2.list(hostOwner(h2), 'Chore')).map((r: any) => r.notes).sort(),
    ).toEqual(['note 1', 'note 2']);
    await h2.close();
  });

  it('is idempotent, and refuses a schema that holds other data', async () => {
    const { store, dataDir } = await desktopApp();
    const bundle = viaJson(
      await exportUserApp({ dataDir, versions: await store.list() }),
    ) as PortableUserApp;
    const schema = await newSchema('idem');
    const database = config(schema);
    const target = dir();
    expect(
      (await importUserApp({ dataDir: target, database, bundle })).status,
    ).toBe('imported');
    expect(
      (await importUserApp({ dataDir: target, database, bundle })).status,
    ).toBe('already-imported');
    const count = async () =>
      Number(
        (await rows(`SELECT COUNT(*) AS n FROM "${schema}".u_chores`))[0].n,
      );
    expect(await count()).toBe(2);

    // Another app's data is never overwritten, and nothing of it is added.
    const other = await desktopApp();
    const otherBundle = viaJson(
      await exportUserApp({
        dataDir: other.dataDir,
        versions: await other.store.list(),
      }),
    ) as PortableUserApp;
    await expect(
      importUserApp({ dataDir: target, database, bundle: otherBundle }),
    ).rejects.toThrow(/different user app database/);
    expect(await count()).toBe(2);
    expect(
      (await verifyUserApp({ dataDir: target, database, bundle })).ok,
    ).toBe(true);
  });

  it('resumes an interrupted import without duplicates', async () => {
    const { store, dataDir } = await desktopApp();
    const bundle = viaJson(
      await exportUserApp({ dataDir, versions: await store.list() }),
    ) as PortableUserApp;
    const schema = await newSchema('resume');
    const database = config(schema);
    const target = dir();
    // The crash comes after every row is in but before the commit: all of it rolls back.
    await expect(
      importUserApp({
        dataDir: target,
        database,
        bundle,
        onPhase: (p) => {
          if (p === 'verified') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(
      Number(
        (await rows(`SELECT COUNT(*) AS n FROM "${schema}".u_chores`))[0].n,
      ),
    ).toBe(0);
    expect(
      (await verifyUserApp({ dataDir: target, database, bundle })).ok,
    ).toBe(false);

    const done = await importUserApp({ dataDir: target, database, bundle });
    expect(done.status).toBe('imported');
    const found = await verifyUserApp({ dataDir: target, database, bundle });
    expect(found.ok).toBe(true);
    expect(found.tables.every((t) => t.expectedRows === t.actualRows)).toBe(
      true,
    );
    expect(
      Number(
        (await rows(`SELECT COUNT(*) AS n FROM "${schema}".u_chores`))[0].n,
      ),
    ).toBe(2);
    // The archive's identity continues after the carried ids.
    const h = await hostOn(bundle, target, database);
    await h.execute(
      hostOwner(h),
      { type: 'removeField', model: 'Chore', field: 'title' },
      OK,
    );
    await h.close();
    const archive = await rows(
      `SELECT id FROM "${schema}"._archive ORDER BY id`,
    );
    expect(new Set(archive.map((r) => String(r.id))).size).toBe(archive.length);
  });

  it('writes only the host-chosen schema, and a bundle cannot name another', async () => {
    const { store, dataDir } = await desktopApp();
    const bundle = viaJson(
      await exportUserApp({ dataDir, versions: await store.list() }),
    ) as PortableUserApp;
    const mine = await newSchema('mine');
    const neighbour = await newSchema('neighbour');
    await admin.query(`CREATE TABLE "${neighbour}".keep (id TEXT)`);
    await admin.query(`INSERT INTO "${neighbour}".keep VALUES ('x')`);
    await importUserApp({
      dataDir: dir(),
      database: config(mine),
      bundle,
    });
    expect(await rows(`SELECT id FROM "${neighbour}".keep`)).toEqual([
      { id: 'x' },
    ]);
    expect(
      (
        await rows(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = ?`,
          [neighbour],
        )
      ).map((r) => r.table_name),
    ).toEqual(['keep']);

    for (const name of [`${neighbour}"."keep`, 'a b', 'x;DROP TABLE keep']) {
      const hostile = viaJson(bundle) as PortableUserApp;
      hostile.tables[0].name = name;
      expect(checkUserAppBundle(hostile).join(' ')).toMatch(/not usable/);
    }
    // A schema the host did not provision is refused, never created.
    await expect(
      importUserApp({
        dataDir: dir(),
        database: config('app_pt_never_made'),
        bundle,
      }),
    ).rejects.toThrow();
    expect(
      await rows(
        `SELECT 1 FROM pg_namespace WHERE nspname = 'app_pt_never_made'`,
      ),
    ).toEqual([]);
  });

  it('refuses an integer beyond 2^53 rather than rounding it, and inspects a hosted app', async () => {
    const { store, dataDir } = await desktopApp();
    const bundle = viaJson(
      await exportUserApp({ dataDir, versions: await store.list() }),
    ) as PortableUserApp;
    const schema = await newSchema('big');
    const database = config(schema);
    const target = dir();
    await importUserApp({ dataDir: target, database, bundle });
    const inspected = await inspectUserApp({ dataDir: target, database });
    expect(inspected).toMatchObject({ integrity: true, recorded: true });
    expect(inspected.rows).toBeGreaterThan(2);

    await rows(
      `UPDATE "${schema}".u_chores SET _sync_revision = 1152921504606846976 WHERE title = 'Bins'`,
    );
    await expect(
      exportUserApp({ dataDir: target, database, versions: bundle.versions }),
    ).rejects.toThrow(/2\^53/);
    // The digits a server pool returns (and a safe value) are read exactly.
    await rows(
      `UPDATE "${schema}".u_chores SET _sync_revision = 9007199254740991 WHERE title = 'Bins'`,
    );
    const ok = await exportUserApp({
      dataDir: target,
      database,
      versions: bundle.versions,
    });
    expect(
      ok.tables
        .find((t) => t.name === 'u_chores')!
        .rows.find((r) => r.title === 'Bins')!._sync_revision,
    ).toBe(9007199254740991);
  });

  it('takes column kinds from the definition: camelCase JSON, a hidden boolean', async () => {
    const store = new MemoryVersionStore();
    const dataDir = dir();
    const host = await AppHost.open(dataDir, {
      allowUnfencedStore: true,
      store,
    });
    await host.execute(
      hostOwner(host),
      {
        type: 'defineModel',
        name: 'Gadget',
        fields: {
          extraData: { type: 'json' },
          armed: { type: 'boolean' },
        },
      },
      A,
    );
    await host.create(hostOwner(host), 'Gadget', {
      extraData: { a: 1, b: [1, 2] },
      armed: true,
    });
    await host.execute(
      hostOwner(host),
      { type: 'hideField', model: 'Gadget', field: 'armed' },
      A,
    );
    await host.close();
    const bundle = viaJson(
      await exportUserApp({ dataDir, versions: await store.list() }),
    ) as PortableUserApp;
    const gadget = bundle.tables.find((t) => t.name === 'u_gadgets');
    const family = (n: string) =>
      gadget?.columns.find((c) => c.name === n)?.family;
    expect(family('extra_data')).toBe('json');
    expect(family('armed')).toBe('boolean');

    const schema = await newSchema('fam');
    const database = config(schema);
    const target = dir();
    await importUserApp({ dataDir: target, database, bundle });
    const type = (
      await rows(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = ? AND table_name = 'u_gadgets'`,
        [schema],
      )
    ).reduce((m, r) => ({ ...m, [r.column_name]: r.data_type }), {} as any);
    expect(type.extra_data).toBe('jsonb');
    expect(type.armed).toBe('boolean');
    // Un-hiding works: the column holds the kind the engine expects.
    const h = await hostOn(bundle, target, database);
    await h.execute(
      hostOwner(h),
      {
        type: 'addField',
        model: 'Gadget',
        field: 'armed',
        definition: { type: 'boolean' },
      },
      A,
    );
    await h.close();
  });
});
