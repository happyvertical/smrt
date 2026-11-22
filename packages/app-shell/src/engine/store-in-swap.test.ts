// The version store committed in the swap's transaction, on the claim (#5470,
// part of epic #5183). A publish and a snapshot restore write the shell's
// `App`/`AppVersion` rows in the SAME transaction as the schema swap, on the
// claim connection, so a host that lost its claim or the store commits
// neither. The store is the real `ShellVersionStore` on the same database as
// the app schemas (what #5418 puts the hosted shell on).
//
// Part of the registered `test:postgres` suite: every test runs on an
// in-process PGlite (its claim is a stand-in whose proof always passes; the
// ones that need a claim to die inject it) and, with
// `SMRT_TEST_POSTGRES_URL`, the ones marked [S] on a real server, where the
// claim's proof, a terminated session and the pool of one are real.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantCollection } from '@happyvertical/smrt-users';
import { importPGlite } from '@happyvertical/sql/pglite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppDraftCollection } from '../lib/objects/AppDraft.ts';
import { prepareShellSchema } from '../lib/server/schema.ts';
import {
  DraftVersionStore,
  ShellVersionStore,
} from '../lib/server/version-store.ts';
import { createClaim } from './db/claim.ts';
import type { AppClaim, DatabaseConfig, PGliteClient } from './db/index.ts';
import { withSchemaAdmin } from './db/index.ts';
import { appLockMatch, dumpSchema, readPublished } from './db/postgres-copy.ts';
import {
  AppHost,
  ClaimLostError,
  type Command,
  MemoryVersionStore,
  type PublishStage,
  StaleStoreError,
  type VersionRecord,
} from './index.ts';
import { JOURNAL_FILE } from './publish.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;
const OK = { author: 'tester', approved: true };

type Sql = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  transaction<T>(cb: (tx: Sql) => Promise<T>): Promise<T>;
  close?: () => Promise<void>;
};

/** The shell's schema helper tells the engine from the handle's `type`; a PGlite handle does not carry one. */
function asShell(db: Sql) {
  if (!(db as { type?: string }).type)
    Object.defineProperty(db, 'type', { value: 'pglite' });
  return db as never;
}

/**
 * A claim over `db` (one PGlite session) whose proof the test controls: after
 * `kill()` the next claim transaction fails its proof, so the claim is lost
 * through the real path (`onLost`, the host retires its worker). `breakWith`
 * makes every later claim transaction fail with a plain error instead (a
 * database that refuses work, not a lost claim).
 */
function killable(db: Sql) {
  let dead = false;
  let broken: Error | null = null;
  const inner = createClaim(
    db,
    '',
    { heartbeatMs: 0 },
    async () => {},
    async () => !dead,
  );
  const transaction = <T>(cb: (tx: any) => Promise<T>) =>
    broken ? Promise.reject(broken) : inner.transaction(cb);
  return new Proxy(inner, {
    get(target, prop) {
      if (prop === 'transaction') return transaction;
      if (prop === 'admin') return { transaction };
      if (prop === 'kill')
        return () => {
          dead = true;
        };
      if (prop === 'breakWith')
        return (e: Error) => {
          broken = e;
        };
      return Reflect.get(target, prop);
    },
  }) as AppClaim & { kill(): void; breakWith(e: Error): void };
}

describe.each(backends)('the version store in the swap (%s)', (backend) => {
  let shell: Sql;
  let pglite: PGliteClient | undefined;
  const dirs: string[] = [];
  const schemas: string[] = [];
  const hosts: AppHost[] = [];
  let createdTables: string[] = [];

  const rows = async (sql: string, params: unknown[] = []) =>
    (await shell.query(sql, params)).rows as Array<Record<string, any>>;
  /** Rehearsal, aside and restore schemas of `base` (an open draft's own schema is not one). */
  const sideSchemas = async (base: string) =>
    (
      await rows(
        `SELECT nspname FROM pg_namespace WHERE nspname LIKE ? AND nspname ~ '__[ron][a-z0-9]{16}$'`,
        [`${base}\\_\\_%`],
      )
    ).map((r) => r.nspname as string);
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'engine-store-swap-'));
    dirs.push(d);
    return d;
  };
  const config = (schema: string): DatabaseConfig =>
    backend === 'postgres'
      ? { kind: 'postgres', schema, connection: { url: serverUrl, max: 2 } }
      : { kind: 'pglite', schema, client: pglite as PGliteClient };

  beforeAll(async () => {
    const actual =
      await vi.importActual<typeof import('@happyvertical/sql')>(
        '@happyvertical/sql',
      );
    if (backend === 'postgres') {
      shell = (await actual.getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 2,
        cache: false,
      } as never)) as unknown as Sql;
    } else {
      const { PGlite } = await importPGlite();
      pglite = (await PGlite.create()) as PGliteClient;
      shell = (await actual.getDatabase({
        type: 'pglite',
        client: pglite,
      } as never)) as unknown as Sql;
    }
    createdTables = await prepareShellSchema(asShell(shell));
  });
  // One App row per shell: every test starts from empty shell tables.
  beforeEach(async () => {
    for (const t of ['app_versions', 'app_drafts', 'apps'])
      await shell.query(`DELETE FROM ${t}`);
  });
  afterEach(async () => {
    for (const h of hosts.splice(0).reverse()) await h.close().catch(() => {});
  });
  afterAll(async () => {
    for (const s of schemas)
      await shell.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {});
    for (const r of await rows(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_si\\_%'`,
    ))
      await shell
        .query(`DROP SCHEMA IF EXISTS "${r.nspname}" CASCADE`)
        .catch(() => {});
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    if (backend === 'postgres') {
      // A real server is shared: leave only what was there before this file.
      for (const t of createdTables)
        await shell.query(`DROP TABLE IF EXISTS ${t} CASCADE`).catch(() => {});
      await shell.close?.().catch(() => {});
    } else await pglite?.close();
  });

  const newSchema = async () => {
    const schema = `app_si_${Math.random().toString(36).slice(2, 8)}`;
    await shell.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return schema;
  };
  type Live = Awaited<ReturnType<typeof seeded>>;
  /** A live app with a model and three rows, on the real store; `claim` is the PGlite lane's stand-in. */
  const openOn = async (
    dir: string,
    schema: string,
    extra: {
      store?: ShellVersionStore;
      claim?: ReturnType<typeof killable>;
      workerUrl?: URL | string;
      claimOptions?: { heartbeatMs?: number; idleInTransactionMs?: number };
    } = {},
  ) => {
    const store = extra.store ?? new ShellVersionStore(shell as never);
    const claim =
      extra.claim ?? (backend === 'pglite' ? killable(shell) : undefined);
    const host = await AppHost.open(dir, {
      store,
      database: config(schema),
      ...(claim ? { claim } : {}),
      ...(extra.workerUrl ? { workerUrl: extra.workerUrl } : {}),
      claimOptions: { heartbeatMs: 0, ...extra.claimOptions },
    });
    hosts.push(host);
    return { host, dir, store, schema, claim };
  };
  const run = (host: AppHost, cmd: Command) => host.execute(cmd, OK);
  const seeded = async () => {
    const schema = await newSchema();
    const live = await openOn(tmp(), schema);
    await run(live.host, {
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text', required: true },
        points: { type: 'integer' },
      },
    });
    for (const [title, points] of [
      ['Bins', 3],
      ['Dishes', 5],
      ['Garage', 8],
    ] as const)
      await live.host.create('Chore', { title, points });
    return live;
  };
  const reopen = async (
    live: Live,
    extra: Parameters<typeof openOn>[2] = {},
  ) => {
    await live.host.close().catch(() => {});
    hosts.splice(hosts.indexOf(live.host), 1);
    return openOn(live.dir, live.schema, extra);
  };
  const titles = async (host: AppHost) =>
    (await host.list('Chore')).map((r) => String(r.title)).sort();
  const draftRow = async (id: string) =>
    (await (
      await AppDraftCollection.create({ db: shell as never })
    ).get(id)) as { status: string; publishedVersions: string };
  /** An open draft of `live` with two edits (a new field, a rename): publishing it makes two versions. */
  const drafted = async (live: Live) => {
    const drafts = await AppDraftCollection.create({ db: shell as never });
    const row = await drafts.create({
      name: 'Draft',
      status: 'open',
      createdBy: 't',
      createdAt: new Date().toISOString(),
    });
    await row.save();
    const id = row.id as string;
    const draft = await live.host.forkDraft(
      `${live.dir}-draft-${id.slice(0, 6)}`,
      {
        store: new DraftVersionStore(shell as never, id),
      },
    );
    hosts.push(draft);
    await run(draft, {
      type: 'addField',
      model: 'Chore',
      field: 'done',
      definition: { type: 'boolean' },
    });
    await run(draft, {
      type: 'renameField',
      model: 'Chore',
      from: 'points',
      to: 'score',
    });
    return { draft, id };
  };
  const publish = async (
    live: Live,
    d: Awaited<ReturnType<typeof drafted>>,
    onStage?: (s: PublishStage) => void | Promise<void>,
  ) => {
    live.host.setFrozen(true);
    const preview = await live.host.previewPublish(d.draft);
    live.store.publishing = { draftId: d.id };
    try {
      return await live.host.publishDraft(d.draft, {
        ...OK,
        expect: preview.digest,
        onStage,
      });
    } finally {
      live.store.publishing = null;
    }
  };
  const moveStore = async (store: ShellVersionStore) => {
    const next = (await store.maxVersion()) + 1;
    const base = (await store.get(
      (await store.current()) as number,
    )) as VersionRecord;
    await store.append({ ...base, version: next, parent: base.version });
    await store.setCurrent(next);
    return next;
  };
  const readiness = async (live: Live) =>
    readPublished(
      { transaction: (cb: any) => shell.transaction(cb) },
      live.schema,
    );

  it('1. a publish whose store moved first is refused; live, the aside and the store are untouched', async () => {
    const live = await seeded();
    const d = await drafted(live);
    live.host.setFrozen(true);
    const preview = await live.host.previewPublish(d.draft);
    const before = live.host.version;
    const moved = await moveStore(live.store);
    live.store.publishing = { draftId: d.id };
    const err = await live.host
      .publishDraft(d.draft, { ...OK, expect: preview.digest })
      .catch((e) => e);
    live.store.publishing = null;
    expect(err).toBeInstanceOf(StaleStoreError);
    expect(live.host.version).toBe(before);
    expect(await live.store.current()).toBe(moved);
    expect(await live.store.maxVersion()).toBe(moved);
    expect(await sideSchemas(live.schema)).toEqual([]);
    expect(await titles(live.host)).toEqual(['Bins', 'Dishes', 'Garage']);
    expect((await live.host.list('Chore'))[0]).toHaveProperty('points');
    expect((await draftRow(d.id)).status).toBe('open');
  });

  it('3. a spawn that fails after the swap puts back the data, the store and the draft; a retry publishes with new numbers', async () => {
    const live = await seeded();
    const d = await drafted(live);
    const before = live.host.version;
    await expect(
      publish(live, d, (s) => {
        if (s === 'respawned') throw new Error('the new worker did not start');
      }),
    ).rejects.toThrow(/did not start/);
    expect(live.host.version).toBe(before);
    expect(await live.store.current()).toBe(before);
    expect((await live.host.list('Chore'))[0]).toHaveProperty('points');
    expect(await sideSchemas(live.schema)).toEqual([]);
    const row = await draftRow(d.id);
    expect(row.status).toBe('open');
    expect(row.publishedVersions).toBe('');
    // The records of the failed attempt stay as never-current history.
    const kept = await live.store.maxVersion();
    expect(kept).toBeGreaterThan(before);
    const result = await publish(live, d);
    expect(result.versions[0]).toBeGreaterThan(kept);
    expect(await live.store.current()).toBe(result.version);
    expect((await draftRow(d.id)).status).toBe('published');
    expect((await live.host.list('Chore'))[0]).toHaveProperty('score');
  });

  it('4. two publishes in a row: the second readiness record replaces the one a fork copied', async () => {
    const live = await seeded();
    await publish(live, await drafted(live));
    const first = await readiness(live);
    expect(first).toBeTruthy();
    live.host.setFrozen(false);
    const drafts = await AppDraftCollection.create({ db: shell as never });
    const row = await drafts.create({
      name: 'Two',
      status: 'open',
      createdBy: 't',
      createdAt: new Date().toISOString(),
    });
    await row.save();
    const draft = await live.host.forkDraft(`${live.dir}-draft-two`, {
      store: new DraftVersionStore(shell as never, row.id as string),
    });
    hosts.push(draft);
    await run(draft, {
      type: 'addField',
      model: 'Chore',
      field: 'note',
      definition: { type: 'text' },
    });
    await publish(live, { draft, id: row.id as string });
    const second = await readiness(live);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(await sideSchemas(live.schema)).toEqual([]);
  });

  it('7. a journal that could not be marked finished, then an undo below the final version: a restart keeps the newer data', async () => {
    const live = await seeded();
    const result = await publish(live, await drafted(live), (s) => {
      if (s === 'committed') mkdirSync(join(live.dir, `${JOURNAL_FILE}.tmp`));
    });
    live.host.setFrozen(false);
    await run(live.host, { type: 'undo' });
    expect(live.host.version).toBeLessThan(result.version);
    await live.host.create('Chore', { title: 'Kept', points: 1 });
    rmSync(join(live.dir, `${JOURNAL_FILE}.tmp`), { recursive: true });
    const again = await reopen(live);
    expect(again.host.recovery).toBe('rolled-forward');
    expect(await titles(again.host)).toContain('Kept');
    expect(await sideSchemas(live.schema)).toEqual([]);
  });

  it('8. a restore whose store moved first is refused and swaps nothing; one on the right store restores', async () => {
    const live = await seeded();
    const file = join(
      live.dir,
      'snapshots',
      `${Date.now()}-0-method-si.pgdump`,
    );
    await withSchemaAdmin(config(live.schema), (db) =>
      dumpSchema(db, live.schema, file),
    );
    const name = file.split('/').pop() as string;
    await live.host.create('Chore', { title: 'After', points: 1 });
    const moved = await moveStore(live.store);
    const err = await live.host.restoreSnapshot(name, OK).catch((e) => e);
    expect(err).toBeInstanceOf(StaleStoreError);
    expect(await titles(live.host)).toContain('After');
    expect(await live.store.current()).toBe(moved);
    expect(await sideSchemas(live.schema)).toEqual([]);
    // The store back where the host has it: the restore goes through.
    await live.store.setCurrent(live.host.version);
    await live.host.restoreSnapshot(name, OK);
    expect(await titles(live.host)).toEqual(['Bins', 'Dishes', 'Garage']);
    expect(await live.store.current()).toBe(live.host.version);
  });

  it("16. a hosted store names its tenant in its raw SQL: another tenant's draft and app row are not reopened", async () => {
    const tenants = await TenantCollection.create({ db: shell as never });
    const ids: string[] = [];
    for (const slug of ['si-a', 'si-b']) {
      const t = await tenants.create({ name: slug, slug });
      await t.save();
      ids.push(t.id as string);
    }
    const [a, b] = ids;
    const storeA = new ShellVersionStore(shell as never, a);
    const storeB = new ShellVersionStore(shell as never, b);
    const base = {
      version: 0,
      parent: null,
      author: 'x',
      summary: 'v0',
      definition: { name: 'x', models: {}, recipes: [] },
      migration: null,
      createdAt: new Date().toISOString(),
    } as unknown as VersionRecord;
    await storeB.append(base);
    await storeB.setCurrent(0);
    await storeA.append({ ...base, version: 1 });
    await storeA.setCurrent(1);
    const row = await (
      await AppDraftCollection.create({ db: shell as never })
    ).create({
      name: 'B',
      status: 'published',
      publishedVersions: JSON.stringify([5, 6]),
      createdAt: new Date().toISOString(),
    });
    await row.save();
    const draftB = row.id as string;
    // This harness has no tenancy interceptor: stamp the row as it would be.
    await shell.query('UPDATE app_drafts SET tenant_id = ? WHERE id = ?', [
      b,
      draftB,
    ]);
    await shell.transaction(async (tx) => {
      // A's store, handed B's draft (a journal copied from another app).
      expect(await storeA.reopenDraftIn(tx, draftB, [5, 6])).toBe(false);
    });
    expect((await draftRow(draftB)).status).toBe('published');
    await shell.transaction(async (tx) => {
      expect(await storeB.reopenDraftIn(tx, draftB, [5, 6])).toBe(true);
    });
    expect((await draftRow(draftB)).status).toBe('open');
  });

  describe.skipIf(backend !== 'pglite')(
    'a lost claim and a worker call',
    () => {
      it('17. a call in flight says its outcome is unknown; a call refused up front says it wrote nothing', async () => {
        const live = await seeded();
        await live.claim?.transaction(async () => {});
        live.claim?.kill();
        await live.claim?.transaction(async () => {}).catch(() => {});
        expect(live.host.lostClaim).toBeTruthy();
        const refused = await live.host.list('Chore').catch((e) => e);
        expect(refused).toBeInstanceOf(ClaimLostError);
        expect(refused.message).toMatch(/wrote nothing/);
        // A worker call that was already running when the claim went.
        (live.host as any).app.call = async () => {
          throw new Error('the app stopped');
        };
        const inFlight = await (live.host as any)
          .callApp('list', 'Chore')
          .catch((e: Error) => e);
        expect(inFlight).toBeInstanceOf(ClaimLostError);
        expect(inFlight.message).toMatch(/unknown/);
        expect(inFlight.message).not.toMatch(/wrote nothing/);
        expect((inFlight as Error).cause).toBeInstanceOf(Error);
      });
    },
  );

  it('15. a failure after the store write rolls back the swap and the rows together', async () => {
    const live = await seeded();
    const d = await drafted(live);
    const before = live.host.version;
    const versionsBefore = await live.store.maxVersion();
    const original = live.store.commitIn.bind(live.store);
    live.store.commitIn = async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw new Error('fail after the store write');
    };
    await expect(publish(live, d)).rejects.toThrow(
      /fail after the store write/,
    );
    expect(live.host.version).toBe(before);
    expect(await live.store.current()).toBe(before);
    expect(await live.store.maxVersion()).toBe(versionsBefore);
    expect(await sideSchemas(live.schema)).toEqual([]);
    expect((await live.host.list('Chore'))[0]).toHaveProperty('points');
    expect((await draftRow(d.id)).status).toBe('open');
  });

  describe.skipIf(backend !== 'pglite')(
    'with a claim the test can kill',
    () => {
      const afterCrash = async (
        live: Live,
        d: Awaited<ReturnType<typeof drafted>>,
        killAt: PublishStage,
      ) => {
        await expect(
          publish(live, d, (s) => {
            if (s === killAt) live.claim?.kill();
          }),
        ).rejects.toBeInstanceOf(ClaimLostError);
        // The lost claim retired the worker: the host refuses every call.
        expect(live.claim?.lost).toBe(true);
        expect(live.host.appAlive).toBe(false);
        await expect(live.host.list('Chore')).rejects.toBeInstanceOf(
          ClaimLostError,
        );
        const journal = JSON.parse(
          readFileSync(join(live.dir, JOURNAL_FILE), 'utf8'),
        );
        return journal as {
          id: string;
          finalVersion: number;
          oldVersion: number;
        };
      };

      it('2. killed at the swap, a reopen readies the published data: the store and the data are final, readiness is written', async () => {
        const live = await seeded();
        const d = await drafted(live);
        const journal = await afterCrash(live, d, 'swapped');
        expect(await live.store.current()).toBe(journal.finalVersion);
        const again = await reopen(live);
        expect(again.host.recovery).toBe('rolled-forward');
        expect(again.host.version).toBe(journal.finalVersion);
        expect((await again.host.list('Chore'))[0]).toHaveProperty('score');
        expect(await readiness(again)).toBe(journal.id);
        expect(await sideSchemas(live.schema)).toEqual([]);
        expect((await draftRow(d.id)).status).toBe('published');
      });

      it('5. killed before the readiness record, with the published version unable to start: boot undoes the publish, reopens the draft and opens on the old definition', async () => {
        const live = await seeded();
        const d = await drafted(live);
        const journal = await afterCrash(live, d, 'respawned');
        expect(await readiness(live)).not.toBe(journal.id);
        // The published version cannot start: its stored definition is invalid.
        await shell.query(
          `UPDATE app_versions SET definition = '{}' WHERE version = ?`,
          [journal.finalVersion],
        );
        const again = await reopen(live);
        expect(again.host.recovery).toBe('rolled-back');
        expect(again.host.version).toBe(journal.oldVersion);
        expect(await again.store.current()).toBe(journal.oldVersion);
        expect(Object.keys(again.host.def.models.Chore.fields)).not.toContain(
          'done',
        );
        expect((await again.host.list('Chore'))[0]).toHaveProperty('points');
        const row = await draftRow(d.id);
        expect(row.status).toBe('open');
        expect(await sideSchemas(live.schema)).toEqual([]);
      });

      it('6. after the readiness record the old data cannot come back: writes on the published data survive a restart whose start fails', async () => {
        const live = await seeded();
        const d = await drafted(live);
        const result = await publish(live, d, (s) => {
          if (s === 'committed') {
            // The journal cannot be marked finished and the old data cannot be dropped.
            mkdirSync(join(live.dir, `${JOURNAL_FILE}.tmp`));
            live.claim?.breakWith(new Error('the database refuses work'));
          }
        });
        await live.host.create('Chore', { title: 'Later', score: 2 });
        rmSync(join(live.dir, `${JOURNAL_FILE}.tmp`), { recursive: true });
        await live.host.close();
        hosts.splice(hosts.indexOf(live.host), 1);
        await expect(
          openOn(live.dir, live.schema, {
            workerUrl: new URL('file:///nonexistent/worker.js'),
          }),
        ).rejects.toThrow();
        const again = await openOn(live.dir, live.schema);
        expect(again.host.version).toBe(result.version);
        expect(await titles(again.host)).toContain('Later');
        expect(await sideSchemas(live.schema)).toEqual([]);
      });

      it('9. a claim on another database, or on a store that cannot commit in it, refuses to open', async () => {
        const schema = await newSchema();
        const { PGlite } = await importPGlite();
        const otherClient = (await PGlite.create()) as PGliteClient;
        const actual =
          await vi.importActual<typeof import('@happyvertical/sql')>(
            '@happyvertical/sql',
          );
        const other = (await actual.getDatabase({
          type: 'pglite',
          client: otherClient,
        } as never)) as unknown as Sql;
        await prepareShellSchema(asShell(other));
        try {
          await expect(
            openOn(tmp(), schema, { claim: killable(other) }),
          ).rejects.toThrow(/another database/);
          const dir = tmp();
          const open = (extra: object) =>
            AppHost.open(dir, {
              store: new MemoryVersionStore(),
              database: config(schema),
              claim: killable(shell),
              ...extra,
            });
          await expect(open({})).rejects.toThrow(/cannot be fenced/);
          hosts.push(await open({ allowUnfencedStore: true }));
        } finally {
          await otherClient.close();
        }
      });
    },
  );
  // [S] The real proof: a real claim session, terminated from outside. Needs a
  // second session, so only `SMRT_TEST_POSTGRES_URL` runs it.
  describe.skipIf(backend !== 'postgres')('[S] a real claim', () => {
    const holders = async (schema: string) =>
      (
        await rows(`SELECT pid FROM pg_locks WHERE ${appLockMatch(schema)}`)
      ).map((r) => Number(r.pid));
    const terminateClaim = async (schema: string) => {
      for (const pid of await holders(schema))
        await shell.query(`SELECT pg_terminate_backend(?)`, [pid]);
    };
    const waitFree = async (schema: string) => {
      for (let i = 0; i < 100; i++) {
        if (!(await holders(schema)).length) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('the claim session did not end');
    };
    const gate = () => {
      let open!: () => void;
      const promise = new Promise<void>((r) => {
        open = r;
      });
      return { promise, open };
    };
    const fenceOf = async (schema: string) =>
      (
        await rows(
          `SELECT value FROM "${schema}"._app_meta WHERE key = 'fence'`,
        )
      )[0]?.value;

    it('11. a claim terminated with no takeover: the next publish writes nothing and the host is lost', async () => {
      const live = await seeded();
      const d = await drafted(live);
      live.host.setFrozen(true);
      const preview = await live.host.previewPublish(d.draft);
      const before = live.host.version;
      await terminateClaim(live.schema);
      live.store.publishing = { draftId: d.id };
      await expect(
        live.host.publishDraft(d.draft, { ...OK, expect: preview.digest }),
      ).rejects.toBeInstanceOf(ClaimLostError);
      live.store.publishing = null;
      expect(await live.store.current()).toBe(before);
      expect(await live.store.maxVersion()).toBe(before);
      expect((await draftRow(d.id)).status).toBe('open');
      await expect(
        live.host.create('Chore', { title: 'x' }),
      ).rejects.toBeInstanceOf(ClaimLostError);
    });

    it('12a. a host paused before the swap, its claim terminated, another host opened: nothing of the paused host lands', async () => {
      const live = await seeded();
      const d = await drafted(live);
      const before = live.host.version;
      const paused = gate();
      const result = publish(live, d, async (s) => {
        if (s === 'journaled') await paused.promise;
      }).catch((e) => e);
      // Let the publish reach the pause (its rehearsal takes a moment).
      await new Promise((r) => setTimeout(r, 1500));
      await terminateClaim(live.schema);
      await waitFree(live.schema);
      const b = await openOn(tmp(), live.schema);
      paused.open();
      expect(await result).toBeInstanceOf(Error);
      expect(await b.store.current()).toBe(before);
      expect(await b.store.maxVersion()).toBe(before);
      expect(await titles(b.host)).toEqual(['Bins', 'Dishes', 'Garage']);
      expect((await b.host.list('Chore'))[0]).toHaveProperty('points');
    });

    it('12b. a host paused inside the swap transaction: the server ends its idle session, another host opens, the COMMIT fails', async () => {
      const schema = await newSchema();
      class Pausing extends ShellVersionStore {
        paused = gate();
        async commitIn(...args: Parameters<ShellVersionStore['commitIn']>) {
          await this.paused.promise;
          return super.commitIn(...args);
        }
      }
      const store = new Pausing(shell as never);
      const live = await openOn(tmp(), schema, {
        store,
        claimOptions: { heartbeatMs: 0, idleInTransactionMs: 1000 },
      });
      await run(live.host, {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' }, points: { type: 'integer' } },
      });
      await live.host.create('Chore', { title: 'Bins', points: 1 });
      const d = await drafted(live);
      const before = live.host.version;
      const result = publish(live, d).catch((e) => e);
      await waitFree(schema);
      const b = await openOn(tmp(), schema);
      store.paused.open();
      expect(await result).toBeInstanceOf(Error);
      expect(await b.store.current()).toBe(before);
      expect(await titles(b.host)).toEqual(['Bins']);
    });

    it('13. the heartbeat notices a terminated claim: the host refuses and its worker is retired', async () => {
      const schema = await newSchema();
      const live = await openOn(tmp(), schema, {
        claimOptions: { heartbeatMs: 100 },
      });
      await run(live.host, {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
      await terminateClaim(schema);
      // Wait for the heartbeat to notice, then every call refuses with the
      // claim's error (a call in flight at that moment does too).
      for (let i = 0; i < 100 && !live.host.lostClaim; i++)
        await new Promise((r) => setTimeout(r, 100));
      const err = await live.host.create('Chore', { title: 'x' }).then(
        () => undefined,
        (e) => e,
      );
      expect(err).toBeInstanceOf(ClaimLostError);
      expect(live.host.appAlive).toBe(false);
    });

    it('14. a claim terminated right after it was taken: the host bumps and drops nothing, another host boots', async () => {
      const live = await seeded();
      await live.host.close();
      hosts.splice(hosts.indexOf(live.host), 1);
      const fence = await fenceOf(live.schema);
      class Killing extends ShellVersionStore {
        async current() {
          if (!this.killed) {
            this.killed = true;
            await terminateClaim(live.schema);
          }
          return super.current();
        }
        killed = false;
      }
      await expect(
        openOn(live.dir, live.schema, { store: new Killing(shell as never) }),
      ).rejects.toThrow();
      expect(await fenceOf(live.schema)).toBe(fence);
      await waitFree(live.schema);
      const b = await openOn(tmp(), live.schema);
      expect(await titles(b.host)).toEqual(['Bins', 'Dishes', 'Garage']);
    });
  });
});
