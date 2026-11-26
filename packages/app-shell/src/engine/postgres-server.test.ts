// The engine on a database server (#5386, epic #5183): the registered
// `test:postgres` suite. It runs on an in-process PGlite everywhere (its twin),
// and ALSO on a real PostgreSQL server when `SMRT_TEST_POSTGRES_URL` is set
// (CI's "Registered PostgreSQL Suites" lane, via scripts/run-with-ci-postgres).
//
// What only a real server shows: BIGINT comes back from the pool as digits
// (PGlite returns numbers), every app worker opens its own pooled connection,
// and the schema is a real namespace on a shared database. Each app here gets
// its own schema, created and dropped by this file as a host's provisioning
// would; the engine never creates one.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import type { DatabaseConfig, PGliteClient } from './db/index.ts';
import {
  AppHost,
  type Command,
  EngineError,
  MemoryVersionStore,
} from './index.ts';
import { asEngine } from './pg-test-support.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;

describe.each(backends)('app engine on PostgreSQL (%s)', (backend) => {
  // `admin` runs the host's side of provisioning and the catalog assertions.
  let admin: {
    query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
    close?: () => Promise<void>;
  };
  let pglite: PGliteClient | undefined;
  const dirs: string[] = [];
  const schemas: string[] = [];
  const hosts: AppHost[] = [];
  const stores = new Map<string, MemoryVersionStore>();
  const dirOf = new Map<string, string>();

  const rows = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as Array<Record<string, any>>;
  /** Rows of an app's table: forced policies hide them from a raw owner (#5189). */
  const engineRows = (sql: string, params: unknown[] = []) =>
    asEngine(admin as any, sql, params);
  const tablesIn = async (schema: string) =>
    (
      await rows(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY 1`,
        [schema],
      )
    ).map((r) => r.table_name as string);

  const newSchema = async (label: string) => {
    const schema = `app_srv_${label}_${Math.random().toString(36).slice(2, 8)}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return schema;
  };
  const config = (schema: string): DatabaseConfig =>
    backend === 'postgres'
      ? { kind: 'postgres', schema, connection: { url: serverUrl, max: 2 } }
      : { kind: 'pglite', schema, client: pglite as PGliteClient };
  const open = async (schema: string) => {
    let dir = dirOf.get(schema);
    if (!dir) {
      dir = mkdtempSync(join(tmpdir(), 'engine-pg-server-'));
      dirs.push(dir);
      dirOf.set(schema, dir);
      stores.set(schema, new MemoryVersionStore());
    }
    const host = await AppHost.open(dir, {
      allowUnfencedStore: true,
      store: stores.get(schema) as MemoryVersionStore,
      database: config(schema),
    });
    hosts.push(host);
    return host;
  };
  const closeHost = async (host: AppHost) => {
    hosts.splice(hosts.indexOf(host), 1);
    await host.close();
  };
  const run = (host: AppHost, cmd: Command) =>
    host.execute(hostOwner(host), cmd, { author: 'test', approved: true });

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
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.close().catch(() => {});
    dirOf.clear();
    stores.clear();
  });
  afterAll(async () => {
    for (const s of schemas)
      await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {});
    if (backend === 'postgres') await admin.close?.();
    else await pglite?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('opens, writes, reads and migrates a user app, and it survives a restart', async () => {
    const schema = await newSchema('life');
    let host = await open(schema);
    await run(host, {
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text', required: true },
        points: { type: 'text' },
        done: { type: 'boolean' },
      },
    });
    const bins = await host.create(hostOwner(host), 'Chore', {
      title: 'Bins',
      points: '3',
      done: false,
    });
    const dishes = await host.create(hostOwner(host), 'Chore', {
      title: 'Dishes',
      points: '5',
    });
    await host.update(hostOwner(host), 'Chore', String(bins.id), {
      done: true,
    });
    expect(
      (await host.get(hostOwner(host), 'Chore', String(bins.id))).done,
    ).toBe(true);
    expect(
      (await host.list(hostOwner(host), 'Chore')).map((r) => r.title).sort(),
    ).toEqual(['Bins', 'Dishes']);
    const rest = await host.rest(hostOwner(host), {
      method: 'GET',
      url: '/api/chores',
    });
    expect(rest.status).toBe(200);
    expect(JSON.stringify(rest.body)).toContain('Dishes');

    // Migrate: add a field, convert text -> integer (the real conversion on
    // the server), rename.
    await run(host, {
      type: 'addField',
      model: 'Chore',
      field: 'notes',
      definition: { type: 'text' },
    });
    await run(host, {
      type: 'changeFieldType',
      model: 'Chore',
      field: 'points',
      to: { type: 'integer' },
    });
    await run(host, {
      type: 'renameField',
      model: 'Chore',
      from: 'title',
      to: 'name',
    });
    const after = await host.get(hostOwner(host), 'Chore', String(dishes.id));
    expect(after.name).toBe('Dishes');
    expect(after.points).toBe(5);
    expect(typeof after.points).toBe('number');

    // The tables are real, in this app's schema only.
    expect(await tablesIn(schema)).toContain('u_chores');
    expect(
      (await tablesIn('public')).filter((t) => t.startsWith('u_')),
    ).toEqual([]);
    const typeOf = (
      await rows(
        `SELECT data_type FROM information_schema.columns WHERE table_schema = ? AND table_name = 'u_chores' AND column_name = 'points'`,
        [schema],
      )
    )[0]?.data_type;
    expect(['integer', 'bigint']).toContain(typeOf);

    // Restart: a fresh host on the same schema finds the same app.
    await closeHost(host);
    host = await open(schema);
    expect(
      (await host.get(hostOwner(host), 'Chore', String(dishes.id))).name,
    ).toBe('Dishes');
    expect((await host.list(hostOwner(host), 'Chore')).length).toBe(2);
  });

  it('refuses an app whose schema the host never created', async () => {
    const err = await open('app_srv_missing_never').then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(EngineError);
    expect(String(err?.message)).toMatch(/does not exist/);
    expect(
      await rows(`SELECT 1 FROM pg_namespace WHERE nspname = ?`, [
        'app_srv_missing_never',
      ]),
    ).toEqual([]);
  });

  // A server holds real locks between sessions; PGlite is one process's own instance.
  it.skipIf(backend !== 'postgres')(
    'one live host per app: a second host on the same schema is refused until the first closes',
    async () => {
      const schema = await newSchema('claim');
      const first = await open(schema);
      await run(first, {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
      await first.create(hostOwner(first), 'Chore', { title: 'kept' });
      const dir = dirOf.get(schema) as string;
      const err = await AppHost.open(dir, {
        allowUnfencedStore: true,
        store: stores.get(schema) as MemoryVersionStore,
        database: config(schema),
      }).then(
        (h) => {
          hosts.push(h);
          return null;
        },
        (e) => e,
      );
      expect(err).toBeInstanceOf(EngineError);
      expect(String(err?.message)).toMatch(/another host already runs/);
      // The refused host touched nothing: the first still serves.
      expect(
        (await first.list(hostOwner(first), 'Chore')).map((r) => r.title),
      ).toEqual(['kept']);
      await closeHost(first);
      const again = await open(schema);
      expect(
        (await again.list(hostOwner(again), 'Chore')).map((r) => r.title),
      ).toEqual(['kept']);
    },
  );

  it('two apps with the same model name never see each other', async () => {
    const a = await open(await newSchema('iso_a'));
    const b = await open(await newSchema('iso_b'));
    for (const [host, who] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      await run(host, {
        type: 'defineModel',
        name: 'Note',
        fields: { title: { type: 'text' } },
      });
      await host.create(hostOwner(host), 'Note', { title: `only ${who}` });
    }
    await run(a, {
      type: 'defineModel',
      name: 'Secret',
      fields: { code: { type: 'text' } },
    });
    await a.create(hostOwner(a), 'Secret', { code: 'a-secret' });

    const titles = async (h: AppHost) =>
      (await h.list(hostOwner(h), 'Note')).map((r) => r.title);
    expect(await titles(a)).toEqual(['only a']);
    expect(await titles(b)).toEqual(['only b']);
    await expect(b.list(hostOwner(b), 'Secret')).rejects.toBeInstanceOf(
      EngineError,
    );
    expect(
      (await b.rest(hostOwner(b), { method: 'GET', url: '/api/secrets' }))
        .status,
    ).toBe(404);
    const restNotes = async (h: AppHost) =>
      JSON.stringify(
        (await h.rest(hostOwner(h), { method: 'GET', url: '/api/notes' })).body,
      );
    expect(await restNotes(a)).toContain('only a');
    expect(await restNotes(a)).not.toContain('only b');
    expect(await restNotes(b)).toContain('only b');
    expect(await restNotes(b)).not.toContain('only a');

    // Physically apart; nothing of either app landed in `public`.
    const inA = await tablesIn(schemas[schemas.length - 2]);
    const inB = await tablesIn(schemas[schemas.length - 1]);
    expect(inA).toContain('u_secrets');
    expect(inB).toContain('u_notes');
    expect(inB).not.toContain('u_secrets');
    expect(
      (await tablesIn('public')).filter((t) => t.startsWith('u_')),
    ).toEqual([]);
  });

  describe('keys in a data load (a server returns BIGINT as digits)', () => {
    it.each([
      ['integer', { type: 'integer' }, 5, 9],
      ['money', { type: 'money' }, 1250, 99],
      ['boolean', { type: 'boolean' }, true, false],
    ] as const)('an upsert keyed on a %s field updates the existing row, and a reference lookup by it resolves', async (kind, def, first, second) => {
      const host = await open(await newSchema(`key_${kind}`));
      const model = `K${kind}`;
      await run(host, {
        type: 'defineModel',
        name: model,
        fields: { k: def as never, note: { type: 'text' } },
      });
      await host.create(hostOwner(host), model, { k: first, note: 'old' });
      const cmd: Command = {
        type: 'loadRecords',
        model,
        mode: 'upsert',
        key: ['k'],
        rows: [
          { k: first, note: 'new' },
          { k: second, note: 'added' },
        ],
      };
      expect((await host.plan(cmd)).preview).toMatchObject({
        insert: 1,
        update: 1,
      });
      await run(host, cmd);
      const all = await host.list(hostOwner(host), model);
      expect(all).toHaveLength(2);
      // Read back as JavaScript values, not the server's digit strings.
      const row = all.find((r) => r.k === first);
      expect(row?.note).toBe('new');
      expect(typeof row?.k).toBe(typeof first);

      const holder = `H${kind}`;
      await run(host, {
        type: 'defineModel',
        name: holder,
        fields: {
          label: { type: 'text' },
          target: { type: 'reference', ref: model },
        },
      });
      const load: Command = {
        type: 'loadRecords',
        model: holder,
        mode: 'insert',
        rows: [{ label: 'x', target: first }],
        references: { target: { model, by: 'k' } },
      };
      expect((await host.plan(load)).preview).toMatchObject({
        insert: 1,
        rejected: 0,
      });
      await run(host, load);
      const held = (await host.list(hostOwner(host), holder))[0];
      expect(held.target).toBe(row?.id);
    });

    it('a safe integer reads as a number; one past 2^53 is refused on read, naming the app, model, field and record', async () => {
      const schema = await newSchema('big');
      const host = await open(schema);
      await run(host, {
        type: 'defineModel',
        name: 'Big',
        fields: { n: { type: 'integer' } },
      });
      const small = await host.create(hostOwner(host), 'Big', { n: 42 });
      const huge = await host.create(hostOwner(host), 'Big', { n: 1 });
      await engineRows(
        `UPDATE "${schema}".u_bigs SET n = 9007199254740993 WHERE id = ?`,
        [huge.id],
      );
      expect(
        (
          await engineRows(
            `SELECT n::text AS n FROM "${schema}".u_bigs WHERE id = ?`,
            [huge.id],
          )
        )[0].n,
      ).toBe('9007199254740993');
      expect((await host.get(hostOwner(host), 'Big', String(small.id))).n).toBe(
        42,
      );
      for (const read of [
        () => host.get(hostOwner(host), 'Big', String(huge.id)),
        () => host.list(hostOwner(host), 'Big'),
      ]) {
        const err = await read().then(
          () => null,
          (e) => e,
        );
        expect(err).toBeInstanceOf(EngineError);
        expect(String(err.message)).toContain('App "My app"');
        expect(String(err.message)).toContain('Big.n');
        expect(String(err.message)).toContain(String(huge.id));
        expect(String(err.message)).toContain('9007199254740993');
      }
    });

    it('a write past 2^53 is refused at write time (create, update, load), nothing lands', async () => {
      const host = await open(await newSchema('bigw'));
      await run(host, {
        type: 'defineModel',
        name: 'Big',
        fields: {
          n: { type: 'integer' },
          m: { type: 'money' },
          t: { type: 'text' },
        },
      });
      const row = await host.create(hostOwner(host), 'Big', {
        n: 1,
        t: 'keep',
      });
      const refused = async (p: Promise<unknown>, what: RegExp) => {
        const err = await p.then(
          () => null,
          (e) => e,
        );
        expect(err, String(what)).not.toBeNull();
        expect(String(err.message)).toMatch(what);
      };
      await refused(
        host.create(hostOwner(host), 'Big', { n: '9007199254740993' }),
        /App "My app": Big\.n must be a whole number between/,
      );
      await refused(
        host.create(hostOwner(host), 'Big', { m: 2 ** 60 }),
        /Big\.m must be a whole/,
      );
      await refused(
        host.update(hostOwner(host), 'Big', String(row.id), {
          n: '9007199254740993',
        }),
        new RegExp(`Big\\.n must be a whole number.*record ${row.id}`),
      );
      const load: Command = {
        type: 'loadRecords',
        model: 'Big',
        mode: 'insert',
        rows: [{ n: '9007199254740993', t: 'L' }],
      };
      const plan = await host.plan(load).then(
        (p) => p,
        (e) => e,
      );
      if (plan instanceof Error)
        expect(plan.message).toMatch(/whole number|safe integer/);
      else expect(plan.preview).toMatchObject({ insert: 0, rejected: 1 });
      await run(host, load).then(
        () => undefined,
        (e) => expect(String(e.message)).toMatch(/whole number|safe integer/),
      );
      // The app still reads: the poisoned values never reached the table.
      const all = await host.list(hostOwner(host), 'Big');
      expect(all).toHaveLength(1);
      expect(all[0].n).toBe(1);
    });

    // A method run is allowed on a database server (it write-locks the model
    // tables for its transaction), so this runs on both backends.
    it('a method write past 2^53 fails when it runs, naming the record', async () => {
      const host = await open(await newSchema('bigm'));
      await run(host, {
        type: 'defineModel',
        name: 'Big',
        fields: { n: { type: 'integer' } },
      });
      const row = await host.create(hostOwner(host), 'Big', { n: 1 });
      await run(host, {
        type: 'addMethod',
        model: 'Big',
        name: 'blow',
        method: {
          description: 'writes too much',
          code: `app.update('Big', record.id, { n: 9007199254740993n.toString() }); return 'ok';`,
        },
      });
      const err = await host
        .runMethod(hostOwner(host), 'Big', 'blow', String(row.id))
        .then(
          () => null,
          (e) => e,
        );
      expect(err).not.toBeNull();
      expect(String(err.message)).toMatch(/Big\.n must be a whole number/);
      expect(String(err.message)).toContain(String(row.id));
      expect((await host.get(hostOwner(host), 'Big', String(row.id))).n).toBe(
        1,
      );
    });
  });

  describe('a method run on a database server', () => {
    it('is allowed, leaves a pre-write undo point, and the undo point restores the data', async () => {
      const host = await open(await newSchema('methodundo'));
      await run(host, {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
      for (const t of ['Bins', 'Dishes'])
        await host.create(hostOwner(host), 'Chore', { title: t });
      await run(host, {
        type: 'addMethod',
        model: 'Chore',
        name: 'wipe',
        method: {
          description: 'rename every chore',
          code: `for (const c of data.Chore) app.update('Chore', c.id, { title: 'wiped' }); return 'ok';`,
        },
      });
      const titles = async () =>
        (await host.list(hostOwner(host), 'Chore'))
          .map((r) => String(r.title))
          .sort();
      const out = await host.runMethod(hostOwner(host), 'Chore', 'wipe', null);
      expect(out.applied).toBe(2);
      expect(String(out.snapshot)).toMatch(/-method-Chore\.wipe\.pgdump$/);
      expect(await titles()).toEqual(['wiped', 'wiped']);
      await host.restoreSnapshot(
        hostOwner(host),
        String(out.snapshot).split('/').pop() as string,
        { approved: true },
      );
      expect(await titles()).toEqual(['Bins', 'Dishes']);
    });
  });

  describe('archive round trip per field type', () => {
    it.each([
      ['text', { type: 'text' }, 'hello'],
      ['number', { type: 'number' }, 1.5],
      ['integer', { type: 'integer' }, 7],
      ['boolean', { type: 'boolean' }, true],
      ['date', { type: 'date' }, '2026-01-05'],
      ['money', { type: 'money' }, 1250],
      ['choice', { type: 'choice', choices: ['a', 'b'] }, 'b'],
      ['json', { type: 'json' }, { k: [1, 2] }],
    ] as const)('removing a %s field archives its values and undo restores them exactly', async (kind, def, value) => {
      const schema = await newSchema(`arc_${kind}`);
      const host = await open(schema);
      const model = `A${kind}`;
      await run(host, {
        type: 'defineModel',
        name: model,
        fields: { keep: { type: 'text' }, v: def as never },
      });
      const made = await host.create(hostOwner(host), model, {
        keep: 'k',
        v: value,
      });
      const before = await host.get(hostOwner(host), model, String(made.id));
      expect(before.v).not.toBeNull();

      const cmd: Command = { type: 'removeField', model, field: 'v' };
      expect(
        ((await host.plan(cmd)).preview as { valuesArchived: number })
          .valuesArchived,
      ).toBe(1);
      await run(host, cmd);
      expect(
        await host.get(hostOwner(host), model, String(made.id)),
      ).not.toHaveProperty('v');
      expect(
        (
          await rows(
            `SELECT count(*)::int AS n FROM "${schema}"._archive WHERE col = 'v'`,
          )
        )[0].n,
      ).toBe(1);

      await run(host, { type: 'undo' });
      expect(await host.get(hostOwner(host), model, String(made.id))).toEqual(
        before,
      );
      expect(
        (
          await rows(
            `SELECT count(*)::int AS n FROM "${schema}"._archive WHERE col = 'v'`,
          )
        )[0].n,
      ).toBe(0);
    });

    it('a reference field round trips too', async () => {
      const schema = await newSchema('arc_ref');
      const host = await open(schema);
      await run(host, {
        type: 'defineModel',
        name: 'Owner',
        fields: { name: { type: 'text' } },
      });
      await run(host, {
        type: 'defineModel',
        name: 'Pet',
        fields: {
          name: { type: 'text' },
          owner: { type: 'reference', ref: 'Owner' },
        },
      });
      const owner = await host.create(hostOwner(host), 'Owner', {
        name: 'Ada',
      });
      const pet = await host.create(hostOwner(host), 'Pet', {
        name: 'Rex',
        owner: owner.id,
      });
      const before = await host.get(hostOwner(host), 'Pet', String(pet.id));
      await run(host, { type: 'removeField', model: 'Pet', field: 'owner' });
      await run(host, { type: 'undo' });
      expect(await host.get(hostOwner(host), 'Pet', String(pet.id))).toEqual(
        before,
      );
    });

    it('removing a model moves its table aside and undo brings every type back', async () => {
      const schema = await newSchema('arc_model');
      const host = await open(schema);
      await run(host, {
        type: 'defineModel',
        name: 'Everything',
        fields: {
          t: { type: 'text' },
          n: { type: 'number' },
          i: { type: 'integer' },
          b: { type: 'boolean' },
          d: { type: 'date' },
          m: { type: 'money' },
          c: { type: 'choice', choices: ['a', 'b'] },
          j: { type: 'json' },
        },
      });
      for (const i of [1, 2])
        await host.create(hostOwner(host), 'Everything', {
          t: `row ${i}`,
          n: i + 0.5,
          i,
          b: i === 1,
          d: `2026-01-0${i}`,
          m: i * 100,
          c: i === 1 ? 'a' : 'b',
          j: { i },
        });
      const snapshot = async () =>
        (await host.list(hostOwner(host), 'Everything')).sort((x, y) =>
          String(x.t).localeCompare(String(y.t)),
        );
      const before = await snapshot();
      expect(before).toHaveLength(2);

      await run(host, { type: 'removeModel', model: 'Everything' });
      const tables = await tablesIn(schema);
      expect(tables).not.toContain('u_everythings');
      expect(tables.some((t) => t.startsWith('_archived_u_everythings_'))).toBe(
        true,
      );

      await run(host, { type: 'undo' });
      expect(await snapshot()).toEqual(before);
      expect(await tablesIn(schema)).toContain('u_everythings');
    });
  });
  // The server itself enforces it (PGlite runs in one thread and cannot cancel
  // a statement), so this one runs on the real-PostgreSQL lane only.
  it.runIf(backend === 'postgres')(
    'a statement timeout cancels a runaway statement, frees the connection and spares another app (#5192)',
    async () => {
      const { scopeDatabase } = await import('./db/postgres.ts');
      // ONE pooled connection shared by both apps: a leak would show at once.
      const raw: any = await getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 1,
        cache: false,
      } as any);
      try {
        const limited: any = scopeDatabase(raw, await newSchema('to'), {
          statementTimeoutMs: 200,
        });
        const other: any = scopeDatabase(raw, await newSchema('ok'));
        await expect(limited.query('SELECT pg_sleep(60)')).rejects.toThrow(
          /statement timeout|canceling statement/i,
        );
        // The same connection, straight after: no limit left on it, and the
        // other app's own longer statement runs to the end.
        expect(
          (await other.query('SHOW statement_timeout')).rows[0]
            .statement_timeout,
        ).toBe('0');
        await other.query('SELECT pg_sleep(0.5)');
        expect((await limited.query('SELECT 1 AS one')).rows[0].one).toBe(1);
      } finally {
        await raw.close?.();
      }
    },
  );
});
