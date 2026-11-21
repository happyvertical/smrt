// Drafts, undo snapshots, publish and restore on PostgreSQL (#5187, epic #5183):
// the registered `test:postgres` suite's second file. Like
// `postgres-server.test.ts` it runs on an in-process PGlite (its twin) and,
// when `SMRT_TEST_POSTGRES_URL` is set (CI's "Registered PostgreSQL Suites"
// lane), also on a real server. A server returns BIGINT as digits and holds
// real locks between sessions; PGlite is one connection.
//
// Every schema, role and directory here is created and removed by this file,
// as a host's provisioning would; the engine creates only the side schemas
// of a copy (a draft, a rehearsal) and removes them.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DatabaseConfig, PGliteClient } from './db/index.ts';
import { withSchemaAdmin } from './db/index.ts';
import {
  dropSchema,
  dumpSchema,
  forkSchema,
  restoreDump,
  swapSchemas,
} from './db/postgres-copy.ts';
import {
  assertAppSchema,
  sideName,
  sideOwnerComment,
} from './db/schema-name.ts';
import {
  AppHost,
  ApprovalRequiredError,
  type Command,
  discardDraftDirectory,
  discardOrphanDraft,
  EngineError,
  MemoryVersionStore,
  type PublishStage,
} from './index.ts';
import { JOURNAL_FILE, writeJournal } from './publish.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const adminUrl = process.env.SMRT_TEST_POSTGRES_ADMIN_URL ?? serverUrl;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;
const AUTHOR = { author: 'tester' };
const OK = { author: 'tester', approved: true };

type Sql = {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  close?: () => Promise<void>;
};

describe.each(
  backends,
)('drafts, undo and publish on PostgreSQL (%s)', (backend) => {
  let admin: Sql; // the host's own connection: provisioning and catalog reads
  let superuser: Sql; // roles only
  let pglite: PGliteClient | undefined;
  const dirs: string[] = [];
  const schemas: string[] = [];
  const roles: string[] = [];
  const hosts: AppHost[] = [];
  const raws: Sql[] = [];

  const rows = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as Array<Record<string, any>>;
  const tablesIn = async (schema: string) =>
    (
      await rows(
        `SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace = to_regnamespace(?) AND c.relkind IN ('r','p','v','m','f') ORDER BY 1`,
        [schema],
      )
    ).map((r) => r.t as string);
  /** Schemas named like a side copy of `base`: leftovers of a draft, rehearsal or aside. */
  const sideSchemas = async (base: string) =>
    (
      await rows(
        `SELECT nspname FROM pg_namespace WHERE nspname LIKE ? ORDER BY 1`,
        [`${base}\\_\\_%`],
      )
    ).map((r) => r.nspname as string);
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'engine-pg-drafts-'));
    dirs.push(d);
    return d;
  };
  const newSchema = async (label: string) => {
    const schema = `app_dr_${label}_${Math.random().toString(36).slice(2, 7)}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.push(schema);
    return schema;
  };
  const config = (schema: string, max = 2): DatabaseConfig =>
    backend === 'postgres'
      ? { kind: 'postgres', schema, connection: { url: serverUrl, max } }
      : { kind: 'pglite', schema, client: pglite as PGliteClient };
  const open = async (
    schema: string,
    extra: { swapLockTimeoutMs?: number } = {},
  ) => {
    const dir = tmp();
    const store = new MemoryVersionStore();
    const host = await AppHost.open(dir, {
      store,
      database: config(schema),
      ...extra,
    });
    hosts.push(host);
    return { host, dir, store, schema };
  };
  const run = (host: AppHost, cmd: Command) => host.execute(cmd, OK);
  const draftDirOf = (dir: string) => join(`${dir}-draft`);

  /** Live app with a model, rows and a method, ready to be forked. */
  const seeded = async (label: string, extra = {}) => {
    const schema = await newSchema(label);
    const live = await open(schema, extra);
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
  const fork = async (live: Awaited<ReturnType<typeof seeded>>) => {
    const store = new MemoryVersionStore();
    const draft = await live.host.forkDraft(draftDirOf(live.dir), { store });
    hosts.push(draft);
    return { draft, store };
  };
  const titles = async (host: AppHost) =>
    (await host.list('Chore')).map((r) => String(r.title)).sort();

  beforeAll(async () => {
    if (backend === 'postgres') {
      admin = (await getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 2,
      } as any)) as any;
      superuser = (await getDatabase({
        type: 'postgres',
        url: adminUrl,
        max: 1,
      } as any)) as any;
    } else {
      const { PGlite } = await importPGlite();
      pglite = (await PGlite.create()) as PGliteClient;
      admin = (await getDatabase({
        type: 'pglite',
        client: pglite,
      } as any)) as any;
      superuser = admin;
    }
  });
  afterEach(async () => {
    for (const h of hosts.splice(0).reverse()) await h.close().catch(() => {});
    for (const r of raws.splice(0)) await r.close?.().catch(() => {});
  });
  afterAll(async () => {
    for (const s of schemas)
      await admin.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`).catch(() => {});
    for (const r of await rows(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE 'app\\_dr\\_%'`,
    ))
      await admin
        .query(`DROP SCHEMA IF EXISTS "${r.nspname}" CASCADE`)
        .catch(() => {});
    for (const r of roles)
      await superuser.query(`DROP ROLE IF EXISTS "${r}"`).catch(() => {});
    if (backend === 'postgres') {
      await superuser.close?.();
      await admin.close?.();
    } else await pglite?.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    for (const d of dirs)
      rmSync(draftDirOf(d), { recursive: true, force: true });
  });

  // ---------- the copy itself ----------

  describe('a schema copy carries everything a plain copy loses', () => {
    /** One schema with keys, defaults, sequences, generated columns, policies, ownership and grants. */
    const fixture = async () => {
      const src = await newSchema('src');
      const role = `smrt_t_${Math.random().toString(36).slice(2, 8)}`;
      roles.push(role);
      await superuser.query(`CREATE ROLE "${role}" NOLOGIN`);
      const me = (await rows(`SELECT current_user AS u`))[0].u as string;
      // The fork runs as this connection: it must be allowed to hand a table to `role`.
      await superuser.query(`GRANT "${role}" TO "${me}"`);
      const ddl = [
        `CREATE TABLE "${src}".parent (id text PRIMARY KEY, label text NOT NULL DEFAULT 'p')`,
        `CREATE TABLE "${src}".child (
           id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
           parent_id text NOT NULL REFERENCES "${src}".parent(id) ON DELETE CASCADE,
           qty integer NOT NULL DEFAULT 1 CHECK (qty >= 0),
           doubled integer GENERATED ALWAYS AS (qty * 2) STORED,
           note text)`,
        `CREATE INDEX child_parent_idx ON "${src}".child (parent_id) WHERE qty > 0`,
        `CREATE UNIQUE INDEX child_note_uq ON "${src}".child (lower(note))`,
        `CREATE TABLE "${src}".ser (id serial PRIMARY KEY, v text)`,
        `COMMENT ON TABLE "${src}".ser IS 'a serial table'`,
        `INSERT INTO "${src}".parent (id) VALUES ('a'), ('b')`,
        `INSERT INTO "${src}".child (parent_id, qty, note) VALUES ('a', 2, 'x'), ('a', 3, 'y'), ('b', 0, NULL)`,
        `INSERT INTO "${src}".ser (v) VALUES ('s1'), ('s2')`,
        `ALTER TABLE "${src}".child ENABLE ROW LEVEL SECURITY`,
        `CREATE POLICY see_all ON "${src}".child FOR SELECT TO PUBLIC USING (true)`,
        `CREATE POLICY add_own ON "${src}".child AS RESTRICTIVE FOR INSERT TO PUBLIC WITH CHECK (qty >= 0)`,
        `GRANT USAGE, CREATE ON SCHEMA "${src}" TO "${role}"`,
        `GRANT SELECT, INSERT ON "${src}".child TO "${role}"`,
        `GRANT SELECT (id) ON "${src}".parent TO "${role}"`,
        `ALTER TABLE "${src}".child OWNER TO "${role}"`,
      ];
      for (const s of ddl) await admin.query(s);
      // PGlite is a superuser and bypasses policies; a server role is subject to them.
      return { src, role, me };
    };
    const fixtureCopy = async () => {
      const f = await fixture();
      const dst = `${f.src}__copy`;
      schemas.push(dst);
      await withSchemaAdmin(config(f.src), (db) => forkSchema(db, f.src, dst));
      return { ...f, dst };
    };

    it('rows, keys, defaults, checks, comments and index names come across', async () => {
      const { src, dst } = await fixtureCopy();
      for (const t of ['parent', 'child', 'ser'])
        expect(
          (await rows(`SELECT count(*)::int AS n FROM "${dst}"."${t}"`))[0].n,
        ).toBe(
          (await rows(`SELECT count(*)::int AS n FROM "${src}"."${t}"`))[0].n,
        );
      expect(await tablesIn(dst)).toEqual(await tablesIn(src));
      // The names the engine itself looks up (`_archive_lookup`, ...) stay.
      const indexNames = (s: string) =>
        rows(
          `SELECT indexname FROM pg_indexes WHERE schemaname = ? ORDER BY 1`,
          [s],
        ).then((r) => r.map((x) => x.indexname));
      expect(await indexNames(dst)).toEqual(await indexNames(src));
      expect(
        (
          await rows(
            `SELECT obj_description(to_regclass(?), 'pg_class') AS c`,
            [`"${dst}".ser`],
          )
        )[0].c,
      ).toBe('a serial table');
      // A check from the source holds in the copy.
      await expect(
        admin.query(
          `INSERT INTO "${dst}".child (parent_id, qty) VALUES ('a', -1)`,
        ),
      ).rejects.toThrow();
    });

    it('foreign keys point at the copy, not at the source', async () => {
      const { src, dst } = await fixtureCopy();
      const fk = await rows(
        `SELECT n.nspname AS ref FROM pg_constraint c JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace
         WHERE c.contype = 'f' AND c.connamespace = to_regnamespace(?)`,
        [dst],
      );
      expect(fk.map((r) => r.ref)).toEqual([dst]);
      // The copy enforces it, and cascades inside itself only.
      await expect(
        admin.query(`INSERT INTO "${dst}".child (parent_id) VALUES ('nope')`),
      ).rejects.toThrow(/foreign key|violates/i);
      await admin.query(`DELETE FROM "${dst}".parent WHERE id = 'a'`);
      expect(
        (await rows(`SELECT count(*)::int AS n FROM "${dst}".child`))[0].n,
      ).toBe(1);
      expect(
        (await rows(`SELECT count(*)::int AS n FROM "${src}".child`))[0].n,
      ).toBe(3);
    });

    it('identity and serial sequences continue past the copied ids, in the copy', async () => {
      const { src, dst } = await fixtureCopy();
      const next = async (s: string, table: string, col: string) => {
        const inserted =
          table === 'child'
            ? `INSERT INTO "${s}".child (parent_id, note) VALUES ('b', 'new-${s}-${Math.random()}') RETURNING id`
            : `INSERT INTO "${s}".ser (v) VALUES ('new') RETURNING id`;
        return Number((await rows(inserted))[0][col]);
      };
      // No duplicate key, and the copy's counter is its own.
      expect(await next(dst, 'child', 'id')).toBe(4);
      expect(await next(dst, 'ser', 'id')).toBe(3);
      expect(await next(src, 'child', 'id')).toBe(4);
      expect(await next(dst, 'child', 'id')).toBe(5);
      expect(
        (
          await rows(`SELECT pg_get_serial_sequence(?, 'id') AS s`, [
            `"${dst}".ser`,
          ])
        )[0].s,
      ).toContain(dst);
    });

    it('generated columns are recomputed in the copy', async () => {
      const { dst } = await fixtureCopy();
      expect(
        (await rows(`SELECT doubled FROM "${dst}".child ORDER BY id`)).map(
          (r) => Number(r.doubled),
        ),
      ).toEqual([4, 6, 0]);
      const added = await rows(
        `INSERT INTO "${dst}".child (parent_id, qty) VALUES ('a', 5) RETURNING doubled`,
      );
      expect(Number(added[0].doubled)).toBe(10);
    });

    it("row-level security flags and policies, ownership and grants are the source's", async () => {
      const { src, dst, role } = await fixtureCopy();
      const flags = (s: string) =>
        rows(
          `SELECT c.relname AS t, c.relrowsecurity AS rls, pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.relnamespace = to_regnamespace(?) AND c.relkind = 'r' ORDER BY 1`,
          [s],
        );
      expect(await flags(dst)).toEqual(await flags(src));
      expect((await flags(dst)).find((r) => r.t === 'child')).toMatchObject({
        rls: true,
        owner: role,
      });
      const policies = (s: string) =>
        rows(
          `SELECT policyname, permissive, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname = ? ORDER BY 1`,
          [s],
        );
      expect(await policies(dst)).toEqual(await policies(src));
      expect((await policies(dst)).map((p) => p.policyname)).toEqual([
        'add_own',
        'see_all',
      ]);
      const priv = async (s: string) => ({
        child: (
          await rows(
            `SELECT has_table_privilege(?::name, ?::text, 'INSERT') AS i, has_table_privilege(?::name, ?::text, 'DELETE') AS d`,
            [role, `"${s}".child`, role, `"${s}".child`],
          )
        )[0],
        col: (
          await rows(
            `SELECT has_column_privilege(?::name, ?::text, 'id', 'SELECT') AS c, has_column_privilege(?::name, ?::text, 'label', 'SELECT') AS l`,
            [role, `"${s}".parent`, role, `"${s}".parent`],
          )
        )[0],
        schema: (
          await rows(
            `SELECT has_schema_privilege(?::name, ?::text, 'CREATE') AS c`,
            [role, s],
          )
        )[0],
      });
      expect(await priv(dst)).toEqual(await priv(src));
      expect((await priv(dst)).child).toEqual({ i: true, d: true }); // owner: all
    });

    it('refuses a schema it cannot copy whole, and leaves nothing behind', async () => {
      const src = await newSchema('odd');
      await admin.query(`CREATE TABLE "${src}".t (a int)`);
      await admin.query(`CREATE VIEW "${src}".v AS SELECT a FROM "${src}".t`);
      const dst = `${src}__copy`;
      await expect(
        withSchemaAdmin(config(src), (db) => forkSchema(db, src, dst)),
      ).rejects.toThrow(/does not carry/);
      expect(
        await rows(`SELECT 1 FROM pg_namespace WHERE nspname = ?`, [dst]),
      ).toEqual([]);
    });

    it('a dump restores into a new schema with the same shape and rows, and adds no tables', async () => {
      const { src } = await fixtureCopy();
      const dir = tmp();
      const file = join(dir, 'x.pgdump');
      const before = await tablesIn(src);
      await withSchemaAdmin(config(src), (db) => dumpSchema(db, src, file));
      expect(await tablesIn(src)).toEqual(before);
      const back = `${src}__back`;
      schemas.push(back);
      await withSchemaAdmin(config(src), (db) => restoreDump(db, file, back));
      expect(await tablesIn(back)).toEqual(before);
      const dataOf = async (s: string) =>
        (
          await rows(
            `SELECT id::text, parent_id, qty, doubled, note FROM "${s}".child ORDER BY id`,
          )
        ).map((r) => JSON.stringify(r));
      expect(await dataOf(back)).toEqual(await dataOf(src));
      // Sequences, constraints and policies came with it.
      expect(
        Number(
          (
            await rows(`SELECT nextval(pg_get_serial_sequence(?, 'id')) AS n`, [
              `"${back}".child`,
            ])
          )[0].n,
        ),
      ).toBe(4);
      expect(
        (
          await rows(
            `SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = ?`,
            [back],
          )
        )[0].n,
      ).toBe(2);
      // An existing target is never overwritten.
      await expect(
        withSchemaAdmin(config(src), (db) => restoreDump(db, file, back)),
      ).rejects.toThrow(/already exists/);
    });
  });

  // ---------- drafts ----------

  describe('a draft', () => {
    it('is a live copy in a schema of its own: edited freely, live untouched, discarded cleanly', async () => {
      const live = await seeded('draft');
      const { draft } = await fork(live);
      expect(await titles(draft)).toEqual(['Bins', 'Dishes', 'Garage']);
      const sides = await sideSchemas(live.schema);
      expect(sides).toHaveLength(1);
      expect(draft.draft?.schema).toBe(sides[0]);
      // The draft takes structure and data changes; live sees none of them.
      await run(draft, {
        type: 'addField',
        model: 'Chore',
        field: 'done',
        definition: { type: 'boolean' },
      });
      await draft.create('Chore', {
        title: 'Draft only',
        points: 1,
        done: true,
      });
      expect(await titles(live.host)).toEqual(['Bins', 'Dishes', 'Garage']);
      expect(
        (
          await rows(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'u_chores'`,
            [live.schema],
          )
        ).map((r) => r.column_name),
      ).not.toContain('done');
      // Draft deletes need no approval (it is the draft's own copy).
      await draft.remove('Chore', String((await draft.list('Chore'))[0].id));
      expect(await titles(live.host)).toHaveLength(3);
      // Discarding removes its schema and its directory, nothing else.
      const dir = draft.dataDir;
      await draft.discard();
      expect(await sideSchemas(live.schema)).toEqual([]);
      expect(existsSync(dir)).toBe(false);
      expect(await titles(live.host)).toHaveLength(3);
    });

    it('reopens after a restart from its marker, and an orphan is discarded with its schema', async () => {
      const live = await seeded('reopen');
      const { draft, store } = await fork(live);
      await draft.create('Chore', { title: 'Kept', points: 2 });
      const dir = draft.dataDir;
      await draft.close();
      hosts.splice(hosts.indexOf(draft), 1);
      const again = await AppHost.open(dir, {
        store,
        autoApprove: true,
        database: config(live.schema),
      });
      hosts.push(again);
      expect(await titles(again)).toContain('Kept');
      await again.close();
      hosts.splice(hosts.indexOf(again), 1);
      expect(await sideSchemas(live.schema)).toHaveLength(1);
      await discardOrphanDraft(dir, config(live.schema));
      expect(await sideSchemas(live.schema)).toEqual([]);
      expect(existsSync(dir)).toBe(false);
    });

    it("copies the app's own functions to the draft, none of them naming the live schema", async () => {
      const live = await seeded('funcs');
      const { draft } = await fork(live);
      const side = String(draft.draft?.schema);
      const defs = (s: string) =>
        rows(
          `SELECT p.proname AS n, pg_get_functiondef(p.oid) AS d, p.proconfig::text AS c FROM pg_proc p WHERE p.pronamespace = to_regnamespace(?) ORDER BY 1, 2`,
          [s],
        );
      const copied = await defs(side);
      expect(copied.map((r) => r.n)).toEqual(
        (await defs(live.schema)).map((r) => r.n),
      );
      expect(copied.length).toBeGreaterThan(0);
      // The draft's own name starts with the live one: only a bare live name is a leak.
      for (const f of copied)
        expect(`${f.d} ${f.c ?? ''}`).not.toMatch(
          new RegExp(`${live.schema}(?!__)`),
        );
    });

    it("does not trust a draft marker that names a schema that is not a draft's", async () => {
      const live = await seeded('badmarker');
      const { draft } = await fork(live);
      const dir = draft.dataDir;
      await draft.close();
      hosts.splice(hosts.indexOf(draft), 1);
      const markerFile = join(dir, '.smrt-draft.json');
      const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
      writeFileSync(
        markerFile,
        JSON.stringify({ ...marker, schema: live.schema }),
      );
      await expect(
        AppHost.open(dir, {
          store: new MemoryVersionStore(),
          autoApprove: true,
          database: config(live.schema),
        }),
      ).rejects.toThrow(/not a draft schema/);
      await expect(
        discardOrphanDraft(dir, config(live.schema)),
      ).rejects.toThrow(/not a draft schema/);
      expect(await tablesIn(live.schema)).toContain('u_chores');
    });

    it('a PostgreSQL draft is refused by the plain directory discard, which would strand its schema', async () => {
      const live = await seeded('plaindiscard');
      const { draft } = await fork(live);
      await draft.close();
      hosts.splice(hosts.indexOf(draft), 1);
      expect(() => discardDraftDirectory(draft.dataDir)).toThrow(
        /PostgreSQL draft/,
      );
      await discardOrphanDraft(draft.dataDir, config(live.schema));
      expect(await sideSchemas(live.schema)).toEqual([]);
    });

    it('a fork that fails leaves no schema and no directory', async () => {
      const live = await seeded('failfork');
      const taken = new MemoryVersionStore();
      await taken.append({
        version: 0,
        parent: null,
        author: 'x',
        summary: 'x',
        definition: live.host.def,
        migration: null,
        createdAt: new Date().toISOString(),
      });
      await taken.setCurrent(0);
      await expect(
        live.host.forkDraft(draftDirOf(live.dir), { store: taken }),
      ).rejects.toThrow(/empty version store/);
      expect(await sideSchemas(live.schema)).toEqual([]);
      expect(existsSync(draftDirOf(live.dir))).toBe(false);
    });
  });

  // ---------- publish ----------

  describe('publish', () => {
    const edit = async (draft: AppHost) => {
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
    };

    it('replays the draft on the live data in one swap: records kept, version and snapshot recorded', async () => {
      const live = await seeded('pub');
      const { draft } = await fork(live);
      await edit(draft);
      live.host.setFrozen(true);
      // A live record made AFTER the fork, and a draft record: only live's survives.
      await live.host.create('Chore', { title: 'Late', points: 9 });
      await draft.create('Chore', { title: 'Draft only', score: 1 });
      const base = live.host.version;
      const preview = await live.host.previewPublish(draft);
      // The rehearsal left nothing but the draft's own schema.
      expect(await sideSchemas(live.schema)).toHaveLength(1);
      await expect(
        live.host.publishDraft(draft, { ...AUTHOR, expect: preview.digest }),
      ).rejects.toBeInstanceOf(ApprovalRequiredError);
      const result = await live.host.publishDraft(draft, {
        ...OK,
        expect: preview.digest,
        draftName: 'Spring',
      });
      expect(result.version).toBe(base + 2);
      expect(result.snapshot).toMatch(/-0-migrate-prepublish\.pgdump$/);
      expect(existsSync(result.snapshot)).toBe(true);
      expect(live.host.version).toBe(base + 2);
      expect(await live.store.current()).toBe(base + 2);
      expect(await titles(live.host)).toEqual([
        'Bins',
        'Dishes',
        'Garage',
        'Late',
      ]);
      const cols = (
        await rows(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'u_chores'`,
          [live.schema],
        )
      ).map((r) => r.column_name);
      expect(cols).toContain('done');
      expect(cols).toContain('score');
      expect(cols).not.toContain('points');
      expect(
        Number(
          (await live.host.list('Chore')).find((r) => r.title === 'Late')
            ?.score,
        ),
      ).toBe(9);
      // The old data's schema and the rehearsal are gone; the draft's stays until discarded.
      expect(await sideSchemas(live.schema)).toHaveLength(1);
      expect(leftoverFiles(live.dir)).toEqual([]);
      // Live thaws, serves and can still undo what was published.
      live.host.setFrozen(false);
      await live.host.create('Chore', { title: 'After', score: 1 });
      await run(live.host, { type: 'undo' });
      expect(await titles(live.host)).toContain('After');
      await draft.discard();
      expect(await sideSchemas(live.schema)).toEqual([]);
    });

    it('snapshots add no tables to the database', async () => {
      const live = await seeded('notables');
      const before = await tablesIn(live.schema);
      const { draft } = await fork(live);
      await edit(draft);
      live.host.setFrozen(true);
      const preview = await live.host.previewPublish(draft);
      const result = await live.host.publishDraft(draft, {
        ...OK,
        expect: preview.digest,
      });
      expect(existsSync(result.snapshot)).toBe(true);
      const after = await tablesIn(live.schema);
      expect(after.filter((t) => !before.includes(t))).toEqual([]);
      expect(
        (
          await rows(
            `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE 'app\\_dr\\_notables%'`,
          )
        )[0].n,
      ).toBe(2); // live and the (undiscarded) draft
    });

    it('an aside that cannot be dropped after the store write is journaled as committed; the owner edits; the next start keeps both', async () => {
      const live = await seeded('dropfail');
      const { draft } = await fork(live);
      await edit(draft);
      live.host.setFrozen(true);
      const preview = await live.host.previewPublish(draft);
      // The old data's schema cannot be dropped (say, a lock_timeout).
      const drop = vi
        .spyOn(live.host as any, 'dropSideSchemaOrThrow')
        .mockRejectedValueOnce(new Error('lock timeout'));
      const result = await live.host.publishDraft(draft, {
        ...OK,
        expect: preview.digest,
      });
      expect(drop).toHaveBeenCalledTimes(1);
      drop.mockRestore();
      const journal = JSON.parse(
        readFileSync(join(live.dir, JOURNAL_FILE), 'utf8'),
      );
      expect(journal.committed).toBe(true);
      expect(await sideSchemas(live.schema)).toContain(journal.pg.aside);
      // The owner edits after the publish: the store passes the journal's final version.
      live.host.setFrozen(false);
      await run(live.host, {
        type: 'defineModel',
        name: 'Later',
        fields: { note: { type: 'text' } },
      });
      expect(live.host.version).toBeGreaterThan(result.version);
      const version = live.host.version;
      await draft.discard();
      await live.host.close();
      hosts.splice(hosts.indexOf(live.host), 1);
      const again = await AppHost.open(live.dir, {
        store: live.store,
        database: config(live.schema),
      });
      hosts.push(again);
      expect(again.version).toBe(version);
      expect(await titles(again)).toEqual(['Bins', 'Dishes', 'Garage']);
      expect(Object.keys(again.def.models)).toContain('Later');
      // The published data (`points` renamed to `score`, values carried over), not the old.
      expect(
        (await again.list('Chore')).map((r) => Number(r.score)).sort(),
      ).toEqual([3, 5, 8]);
      expect(await sideSchemas(live.schema)).toEqual([]);
      expect(existsSync(join(live.dir, JOURNAL_FILE))).toBe(false);
    });

    const STAGES: PublishStage[] = [
      'copied',
      'rehearsed',
      'snapshotted',
      'journaled',
      'retired',
      'moved-aside',
      'swapped',
      'respawned',
    ];
    it.each(
      STAGES,
    )('a failure at "%s" leaves the old app, whole and serving', async (stage) => {
      const live = await seeded(`atomic_${stage.replace(/\W/g, '')}`);
      const { draft } = await fork(live);
      await edit(draft);
      live.host.setFrozen(true);
      const base = live.host.version;
      const preview = await live.host.previewPublish(draft);
      const before = await rows(
        `SELECT id::text, title, points::text FROM "${live.schema}".u_chores ORDER BY id`,
      );
      await expect(
        live.host.publishDraft(draft, {
          ...OK,
          expect: preview.digest,
          onStage: (s) => {
            if (s === stage) throw new Error(`injected at ${s}`);
          },
        }),
      ).rejects.toThrow(/injected/);
      expect(live.host.version).toBe(base);
      expect(await live.store.current()).toBe(base);
      expect(
        await rows(
          `SELECT id::text, title, points::text FROM "${live.schema}".u_chores ORDER BY id`,
        ),
      ).toEqual(before);
      // Only the draft's schema is left beside live; no rehearsal, no aside.
      expect(await sideSchemas(live.schema)).toHaveLength(1);
      expect(leftoverFiles(live.dir)).toEqual([]);
      // Still serving, and publishable again.
      expect(await titles(live.host)).toEqual(['Bins', 'Dishes', 'Garage']);
      const again = await live.host.previewPublish(draft);
      await live.host.publishDraft(draft, { ...OK, expect: again.digest });
      expect(live.host.version).toBe(base + 2);
    });

    it('a version store that fails after the swap puts the old schema back', async () => {
      const schema = await newSchema('storefail');
      class FailingStore extends MemoryVersionStore {
        failCommit = false;
        override async commit(records: any, current: number) {
          if (this.failCommit) throw new Error('store write failed');
          return super.commit(records, current);
        }
      }
      const dir = tmp();
      const store = new FailingStore();
      const host = await AppHost.open(dir, { store, database: config(schema) });
      hosts.push(host);
      await run(host, {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
      await host.create('Chore', { title: 'one' });
      const draftStore = new MemoryVersionStore();
      const draft = await host.forkDraft(draftDirOf(dir), {
        store: draftStore,
      });
      hosts.push(draft);
      await run(draft, {
        type: 'addField',
        model: 'Chore',
        field: 'x',
        definition: { type: 'text' },
      });
      host.setFrozen(true);
      const base = host.version;
      const preview = await host.previewPublish(draft);
      store.failCommit = true;
      await expect(
        host.publishDraft(draft, { ...OK, expect: preview.digest }),
      ).rejects.toThrow(/store write failed/);
      expect(host.version).toBe(base);
      expect(
        (
          await rows(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'u_chores'`,
            [schema],
          )
        ).map((r) => r.column_name),
      ).not.toContain('x');
      expect(await sideSchemas(schema)).toHaveLength(1); // the draft's
      expect(await titles(host)).toEqual(['one']);
    });
  });

  const leftoverFiles = (dir: string) =>
    readdirSync(dir).filter(
      (n) => n === JOURNAL_FILE || n.startsWith('publish-rehearsal-'),
    );

  // ---------- a crash in the middle of a publish ----------

  describe('start-up after a publish was interrupted', () => {
    /** Live app with data, then the state a crash right after the swap leaves: the new data live, the old one aside, a journal. */
    const crashedAfterSwap = async (
      label: string,
      where: 'swapped' | 'swap-back-done' | 'aside-dropped' = 'swapped',
    ) => {
      const schema = await newSchema(label);
      const dir = tmp();
      const store = new MemoryVersionStore();
      const first = await AppHost.open(dir, {
        store,
        database: config(schema),
      });
      await run(first, {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
      await first.create('Chore', { title: 'old data' });
      const version = first.version;
      await first.close();
      const staging = sideName(schema, 'r', 'stage123');
      const aside = sideName(schema, 'o', 'aside123');
      schemas.push(staging, aside);
      await withSchemaAdmin(config(schema), async (db) => {
        await forkSchema(db, schema, staging, schema);
        await db.transaction((tx: any) =>
          tx.query(`UPDATE "${staging}".u_chores SET title = 'new data'`),
        );
        await swapSchemas(db, {
          live: schema,
          next: staging,
          aside,
          owner: schema,
        });
        // Where the process died: right after the swap, or part-way through
        // the recovery of it (swap-back done; or the old data already gone).
        if (where === 'swap-back-done')
          await swapSchemas(db, {
            live: schema,
            next: aside,
            aside: staging,
            owner: schema,
          });
        if (where === 'aside-dropped')
          await dropSchema(db, aside, 5000, schema);
      });
      writeJournal(dir, {
        format: 1,
        oldVersion: version,
        finalVersion: version + 1,
        rehearsal: join(dir, 'publish-rehearsal-x'),
        snapshot: join(dir, 'snapshots', 'x'),
        startedAt: new Date().toISOString(),
        pg: { schema, staging, aside },
      });
      return { schema, dir, store, version, aside, staging };
    };
    const publishedInStore = async (
      c: Awaited<ReturnType<typeof crashedAfterSwap>>,
    ) => {
      await c.store.append({
        version: c.version + 1,
        parent: c.version,
        author: 'x',
        summary: 'published',
        definition: (await c.store.get(c.version))?.definition as any,
        migration: null,
        createdAt: new Date().toISOString(),
      });
      await c.store.setCurrent(c.version + 1);
    };
    const reopen = async (c: Awaited<ReturnType<typeof crashedAfterSwap>>) => {
      const host = await AppHost.open(c.dir, {
        store: c.store,
        database: config(c.schema),
      });
      hosts.push(host);
      return host;
    };
    /** One consistent state: the version the store says, and the data that version had. */
    const consistent = async (
      host: AppHost,
      c: Awaited<ReturnType<typeof crashedAfterSwap>>,
      newer: boolean,
    ) => {
      expect(host.version).toBe(c.version + (newer ? 1 : 0));
      expect(await c.store.current()).toBe(host.version);
      expect((await host.list('Chore')).map((r) => r.title)).toEqual([
        newer ? 'new data' : 'old data',
      ]);
      expect(await sideSchemas(c.schema)).toEqual([]);
      expect(existsSync(join(c.dir, JOURNAL_FILE))).toBe(false);
      expect(await tablesIn(c.schema)).toContain('u_chores');
    };

    it('window (i): died after the swap, before the store write: the old version and old schema come back', async () => {
      const c = await crashedAfterSwap('crash_back');
      const host = await reopen(c);
      expect(host.recovery).toBe('rolled-back');
      await consistent(host, c, false);
    });

    it('window (ii): died after the store write, before the journal was cleared: the new version stays, the old data goes', async () => {
      const c = await crashedAfterSwap('crash_fwd');
      await publishedInStore(c);
      const host = await reopen(c);
      expect(host.recovery).toBe('rolled-forward');
      await consistent(host, c, true);
    });

    it('window (ii-b): the store write was journaled as committed, then the owner edited: the next start does not roll the publish back', async () => {
      const c = await crashedAfterSwap('crash_fwd_edit');
      await publishedInStore(c);
      // The owner's next edit: the store is now PAST the published version.
      await c.store.append({
        version: c.version + 2,
        parent: c.version + 1,
        author: 'owner',
        summary: 'edited after the publish',
        definition: (await c.store.get(c.version))?.definition as any,
        migration: null,
        createdAt: new Date().toISOString(),
      });
      await c.store.setCurrent(c.version + 2);
      writeJournal(c.dir, {
        format: 1,
        oldVersion: c.version,
        finalVersion: c.version + 1,
        rehearsal: join(c.dir, 'publish-rehearsal-x'),
        snapshot: join(c.dir, 'snapshots', 'x'),
        startedAt: new Date().toISOString(),
        committed: true,
        pg: { schema: c.schema, staging: c.staging, aside: c.aside },
      });
      const host = await reopen(c);
      expect(host.version).toBe(c.version + 2);
      expect((await host.list('Chore')).map((r) => r.title)).toEqual([
        'new data',
      ]);
      expect(await sideSchemas(c.schema)).toEqual([]);
      expect(existsSync(join(c.dir, JOURNAL_FILE))).toBe(false);
    });

    it('window (iii): died during the swap-back: the recovery finishes it, and a second recovery changes nothing', async () => {
      const c = await crashedAfterSwap('crash_swapback', 'swap-back-done');
      const first = await reopen(c);
      await consistent(first, c, false);
      // The recovery itself was interrupted before it cleared the journal:
      // run it again over the same state.
      await first.close();
      hosts.splice(hosts.indexOf(first), 1);
      writeJournal(c.dir, {
        format: 1,
        oldVersion: c.version,
        finalVersion: c.version + 1,
        rehearsal: join(c.dir, 'publish-rehearsal-x'),
        snapshot: join(c.dir, 'snapshots', 'x'),
        startedAt: new Date().toISOString(),
        pg: { schema: c.schema, staging: c.staging, aside: c.aside },
      });
      await consistent(await reopen(c), c, false);
    });

    it('a roll-forward interrupted after the old data was dropped finishes, and runs again harmlessly', async () => {
      const c = await crashedAfterSwap('crash_fwd2', 'aside-dropped');
      await publishedInStore(c);
      const first = await reopen(c);
      await consistent(first, c, true);
      await first.close();
      hosts.splice(hosts.indexOf(first), 1);
      writeJournal(c.dir, {
        format: 1,
        oldVersion: c.version,
        finalVersion: c.version + 1,
        rehearsal: join(c.dir, 'publish-rehearsal-x'),
        snapshot: join(c.dir, 'snapshots', 'x'),
        startedAt: new Date().toISOString(),
        pg: { schema: c.schema, staging: c.staging, aside: c.aside },
      });
      await consistent(await reopen(c), c, true);
    });

    it("sweeps rehearsal, aside and restore schemas a crash left, and keeps the app's drafts", async () => {
      const live = await seeded('sweep');
      const { draft } = await fork(live);
      const strays = (['r', 'o', 'n'] as const).map((t) =>
        sideName(live.schema, t, 'abcd1234'),
      );
      for (const n of strays) {
        await admin.query(`CREATE SCHEMA "${n}"`);
        await admin.query(
          `COMMENT ON SCHEMA "${n}" IS '${sideOwnerComment(live.schema)}'`,
        );
      }
      // Right name, nobody's comment: could be anyone's, so it stays.
      const unclaimed = sideName(live.schema, 'r', 'ffff0000');
      await admin.query(`CREATE SCHEMA "${unclaimed}"`);
      schemas.push(unclaimed);
      const dir = live.dir;
      await live.host.close();
      hosts.splice(hosts.indexOf(live.host), 1);
      const again = await AppHost.open(dir, {
        store: live.store,
        database: config(live.schema),
      });
      hosts.push(again);
      expect((await sideSchemas(live.schema)).sort()).toEqual(
        [String(draft.draft?.schema), unclaimed].sort(),
      );
    });

    it('a journal for another schema is refused, not guessed at', async () => {
      const c = await crashedAfterSwap('crash_other');
      const other = await newSchema('crash_other_app');
      await expect(
        AppHost.open(c.dir, { store: c.store, database: config(other) }),
      ).rejects.toThrow(/belongs to schema/);
    });
  });

  // ---------- undo snapshots and restore ----------

  describe('restoring a snapshot', () => {
    it('puts the data back by swapping a rebuilt schema in; the data it replaces is kept as a snapshot', async () => {
      const live = await seeded('restore');
      const file = join(
        live.dir,
        'snapshots',
        `${Date.now()}-0-method-test.pgdump`,
      );
      await withSchemaAdmin(config(live.schema), (db) =>
        dumpSchema(db, live.schema, file),
      );
      const name = file.split('/').pop() as string;
      await live.host.create('Chore', { title: 'After', points: 1 });
      expect(await titles(live.host)).toContain('After');
      const r = await live.host.restoreSnapshot(name, OK);
      expect(r.restoredFrom).toBe(name);
      expect(await titles(live.host)).toEqual(['Bins', 'Dishes', 'Garage']);
      expect(existsSync(r.snapshot)).toBe(true);
      expect(await sideSchemas(live.schema)).toEqual([]);
      // Serving normally afterwards, and the restore itself can be undone by restoring its snapshot.
      await live.host.create('Chore', { title: 'Next', points: 2 });
      const undo = await live.host.restoreSnapshot(
        r.snapshot.split('/').pop() as string,
        OK,
      );
      expect(await titles(live.host)).toContain('After');
      expect(undo.restoredFrom).toMatch(/migrate-before-restore/);
    });

    it('needs an approval, and says what it would restore', async () => {
      const live = await seeded('restore_gate');
      const file = join(
        live.dir,
        'snapshots',
        `${Date.now()}-0-method-gate.pgdump`,
      );
      await withSchemaAdmin(config(live.schema), (db) =>
        dumpSchema(db, live.schema, file),
      );
      const err = await live.host
        .restoreSnapshot(file.split('/').pop() as string)
        .then(
          () => null,
          (e) => e,
        );
      expect(err).toBeInstanceOf(ApprovalRequiredError);
      expect(JSON.stringify(err.plan ?? err)).toContain('method-gate');
      expect(await sideSchemas(live.schema)).toEqual([]);
    });

    it('refuses a snapshot of another version, a path, and a frozen app', async () => {
      const live = await seeded('restore_refuse');
      const file = join(
        live.dir,
        'snapshots',
        `${Date.now()}-0-method-old.pgdump`,
      );
      await withSchemaAdmin(config(live.schema), (db) =>
        dumpSchema(db, live.schema, file),
      );
      await run(live.host, {
        type: 'addField',
        model: 'Chore',
        field: 'x',
        definition: { type: 'text' },
      });
      await expect(
        live.host.restoreSnapshot(file.split('/').pop() as string, OK),
      ).rejects.toThrow(/Undo to that version first/);
      await expect(
        live.host.restoreSnapshot('../../etc/passwd', OK),
      ).rejects.toBeInstanceOf(EngineError);
      await expect(live.host.restoreSnapshot(file, OK)).rejects.toBeInstanceOf(
        EngineError,
      );
      expect(await titles(live.host)).toEqual(['Bins', 'Dishes', 'Garage']);
    });

    it('a method run leaves a pre-write undo point that restores', async () => {
      const live = await seeded('method');
      await run(live.host, {
        type: 'addMethod',
        model: 'Chore',
        name: 'wipe',
        method: {
          description: 'rename every chore',
          code: `for (const c of data.Chore) app.update('Chore', c.id, { title: 'wiped' }); return 'ok';`,
        },
      });
      const out = await live.host.runMethod('Chore', 'wipe', null);
      expect(out.applied).toBe(3);
      const snapshot = String(out.snapshot);
      expect(snapshot).toMatch(/-method-Chore\.wipe\.pgdump$/);
      expect(await titles(live.host)).toEqual(['wiped', 'wiped', 'wiped']);
      await live.host.restoreSnapshot(snapshot.split('/').pop() as string, OK);
      expect(await titles(live.host)).toEqual(['Bins', 'Dishes', 'Garage']);
      expect(live.host.notices).toEqual([]);
    });

    it('snapshots of methods are kept to the newest twenty', async () => {
      const dir = tmp();
      const snaps = join(dir, 'snapshots');
      mkdirSync(snaps, { recursive: true });
      const { pruneMethodSnapshots } = await import('./snapshots.ts');
      for (let i = 0; i < 23; i++)
        writeFileSync(join(snaps, `${1000 + i}-0-method-A.b.pgdump`), '{}');
      expect(pruneMethodSnapshots(snaps)).toBe(3);
      expect(readdirSync(snaps)).toHaveLength(20);
    });
  });

  // ---------- no session on the old objects; two apps stay apart ----------

  describe('a swap leaves nothing on the old objects', () => {
    it('a session connected across the publish reads the new objects; another app is untouched', async () => {
      const a = await seeded('iso_a');
      const b = await seeded('iso_b');
      // A connection that stays open through A's publish.
      const reader =
        backend === 'postgres'
          ? ((await getDatabase({
              type: 'postgres',
              url: serverUrl,
              max: 1,
            } as any)) as any as Sql)
          : admin;
      if (reader !== admin) raws.push(reader);
      const count = async (schema: string) =>
        Number(
          (
            await reader.query(
              `SELECT count(*)::int AS n FROM "${schema}".u_chores`,
            )
          ).rows[0].n,
        );
      expect(await count(a.schema)).toBe(3);
      const { draft } = await fork(a);
      await run(draft, {
        type: 'addField',
        model: 'Chore',
        field: 'done',
        definition: { type: 'boolean' },
      });
      await draft.create('Chore', { title: 'Draft only', points: 1 });
      a.host.setFrozen(true);
      await a.host.create('Chore', { title: 'Late', points: 4 });
      const bBefore = await rows(
        `SELECT id::text, title FROM "${b.schema}".u_chores ORDER BY id`,
      );
      const preview = await a.host.previewPublish(draft);
      await a.host.publishDraft(draft, { ...OK, expect: preview.digest });
      // The same session now sees the published tables, not the ones swapped out.
      expect(await count(a.schema)).toBe(4);
      expect(
        (
          await reader.query(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = '${a.schema}' AND table_name = 'u_chores' AND column_name = 'done'`,
          )
        ).rows,
      ).toHaveLength(1);
      // Nothing of the swapped-out schema is left to be on.
      expect(
        (
          await rows(
            `SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname LIKE ? AND n.nspname <> ?`,
            [`${a.schema}\\_\\_o%`, a.schema],
          )
        )[0].n,
      ).toBe(0);
      // App B: same data, same schema, still serving, no leftovers.
      expect(
        await rows(
          `SELECT id::text, title FROM "${b.schema}".u_chores ORDER BY id`,
        ),
      ).toEqual(bBefore);
      expect(await titles(b.host)).toEqual(['Bins', 'Dishes', 'Garage']);
      await b.host.create('Chore', { title: 'B after', points: 1 });
      expect(await count(b.schema)).toBe(4);
      expect(await sideSchemas(b.schema)).toEqual([]);
    });

    it.skipIf(backend !== 'postgres')(
      'a session still holding the old tables stops the swap, and nothing changes',
      async () => {
        const live = await seeded('fence', { swapLockTimeoutMs: 400 });
        const { draft } = await fork(live);
        await run(draft, {
          type: 'addField',
          model: 'Chore',
          field: 'done',
          definition: { type: 'boolean' },
        });
        live.host.setFrozen(true);
        const base = live.host.version;
        const preview = await live.host.previewPublish(draft);
        // Another session holds a lock on one of live's tables.
        const holder = (await getDatabase({
          type: 'postgres',
          url: serverUrl,
          max: 1,
        } as any)) as any;
        raws.push(holder);
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        let locked!: () => void;
        const lockTaken = new Promise<void>((r) => (locked = r));
        const tx = holder.transaction(async (t: any) => {
          await t.query(
            `LOCK TABLE "${live.schema}".u_chores IN ACCESS SHARE MODE`,
          );
          locked();
          await held;
        });
        await lockTaken;
        try {
          await expect(
            live.host.publishDraft(draft, { ...OK, expect: preview.digest }),
          ).rejects.toThrow(/lock timeout|canceling statement/i);
        } finally {
          release();
          await tx;
        }
        expect(live.host.version).toBe(base);
        expect(await sideSchemas(live.schema)).toHaveLength(1); // the draft's
        expect(await titles(live.host)).toEqual(['Bins', 'Dishes', 'Garage']);
        // Once the other session lets go, the same publish goes through.
        const again = await live.host.previewPublish(draft);
        await live.host.publishDraft(draft, { ...OK, expect: again.digest });
        expect(live.host.version).toBe(base + 1);
      },
    );
  });
  // ---------- names and ownership of copies ----------

  describe('a copy belongs to exactly one app', () => {
    const longName = (len: number, tail: string) =>
      `app_dr_len_${'x'.repeat(len - 11 - tail.length)}${tail}`;

    it.each([
      51, 52, 53, 62, 63,
    ])('an app schema of %i characters forks, reopens, discards and publishes', async (len) => {
      const schema = longName(len, Math.random().toString(36).slice(2, 7));
      expect(schema).toHaveLength(len);
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemas.push(schema);
      const live = await open(schema);
      await run(live.host, {
        type: 'defineModel',
        name: 'Chore',
        fields: { title: { type: 'text' } },
      });
      await live.host.create('Chore', { title: 'one' });
      const { draft, store } = await fork(live);
      const side = String(draft.draft?.schema);
      expect(Buffer.byteLength(side)).toBeLessThanOrEqual(63);
      // The draft's schema is one the engine itself accepts again.
      const dir = draft.dataDir;
      await draft.close();
      hosts.splice(hosts.indexOf(draft), 1);
      const again = await AppHost.open(dir, {
        store,
        autoApprove: true,
        database: config(schema),
      });
      hosts.push(again);
      await run(again, {
        type: 'addField',
        model: 'Chore',
        field: 'done',
        definition: { type: 'boolean' },
      });
      live.host.setFrozen(true);
      const preview = await live.host.previewPublish(again);
      await live.host.publishDraft(again, { ...OK, expect: preview.digest });
      // Restart recovery on that name, then discard the draft.
      await live.host.close();
      hosts.splice(hosts.indexOf(live.host), 1);
      const restarted = await AppHost.open(live.dir, {
        store: live.store,
        database: config(schema),
      });
      hosts.push(restarted);
      expect(await titles(restarted)).toEqual(['one']);
      await again.discard();
      hosts.splice(hosts.indexOf(again), 1);
      expect(
        (
          await rows(
            `SELECT count(*)::int AS n FROM pg_namespace WHERE nspname LIKE '%\\_\\_d%' AND obj_description(oid, 'pg_namespace') = ?`,
            [sideOwnerComment(schema)],
          )
        )[0].n,
      ).toBe(0);
    });

    it("two apps sharing their first 52 characters get different copies and never drop each other's", async () => {
      const prefix = `app_dr_share_${'y'.repeat(39)}`;
      expect(prefix).toHaveLength(52);
      const a = `${prefix}aaa`;
      const b = `${prefix}bbb`;
      for (const n of [a, b]) {
        await admin.query(`CREATE SCHEMA "${n}"`);
        schemas.push(n);
      }
      const A = await open(a, { swapLockTimeoutMs: 2000 });
      const B = await open(b, { swapLockTimeoutMs: 2000 });
      for (const h of [A, B]) {
        await run(h.host, {
          type: 'defineModel',
          name: 'Chore',
          fields: { title: { type: 'text' } },
        });
        await h.host.create('Chore', { title: 'x' });
      }
      // Fork both at once.
      const [fa, fb] = await Promise.all([
        fork(A),
        (async () => {
          const store = new MemoryVersionStore();
          const draft = await B.host.forkDraft(draftDirOf(B.dir), { store });
          hosts.push(draft);
          return { draft, store };
        })(),
      ]);
      expect(fa.draft.draft?.schema).not.toBe(fb.draft.draft?.schema);
      expect(sideName(a, 'd', 'aaaaaaaa')).not.toBe(
        sideName(b, 'd', 'aaaaaaaa'),
      );
      for (const [h, f] of [
        [A, fa],
        [B, fb],
      ] as const)
        await run(f.draft, {
          type: 'addField',
          model: 'Chore',
          field: 'done',
          definition: { type: 'boolean' },
        });
      A.host.setFrozen(true);
      B.host.setFrozen(true);
      const [pa, pb] = await Promise.all([
        A.host.previewPublish(fa.draft),
        B.host.previewPublish(fb.draft),
      ]);
      // A publishes while B's publish fails and rolls back, at the same time.
      const [ra, rb] = await Promise.allSettled([
        A.host.publishDraft(fa.draft, { ...OK, expect: pa.digest }),
        B.host.publishDraft(fb.draft, {
          ...OK,
          expect: pb.digest,
          onStage: (st) => {
            if (st === 'swapped') throw new Error('injected');
          },
        }),
      ]);
      expect(ra.status).toBe('fulfilled');
      expect(rb.status).toBe('rejected');
      const cols = async (schema: string) =>
        (
          await rows(
            `SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'u_chores'`,
            [schema],
          )
        ).map((r) => r.column_name);
      expect(await cols(a)).toContain('done');
      expect(await cols(b)).not.toContain('done');
      expect(await titles(B.host)).toEqual(['x']);
      // Each still has exactly its own draft, and nothing else.
      const owned = async (base: string) =>
        (
          await rows(
            `SELECT nspname FROM pg_namespace WHERE obj_description(oid, 'pg_namespace') = ? ORDER BY 1`,
            [sideOwnerComment(base)],
          )
        ).map((r) => r.nspname);
      expect(await owned(a)).toEqual([String(fa.draft.draft?.schema)]);
      expect(await owned(b)).toEqual([String(fb.draft.draft?.schema)]);
      // A's start-up sweep, with a look-alike of A's name that B owns, leaves both.
      const lookalike = sideName(a, 'r', 'cafe0000');
      await admin.query(`CREATE SCHEMA "${lookalike}"`);
      await admin.query(
        `COMMENT ON SCHEMA "${lookalike}" IS '${sideOwnerComment(b)}'`,
      );
      schemas.push(lookalike);
      await A.host.close();
      hosts.splice(hosts.indexOf(A.host), 1);
      hosts.push(
        await AppHost.open(A.dir, { store: A.store, database: config(a) }),
      );
      expect(await owned(b)).toEqual(
        [lookalike, String(fb.draft.draft?.schema)].sort(),
      );
      expect(await owned(a)).toEqual([String(fa.draft.draft?.schema)]);
    });

    it("refuses an app schema named like a copy, and a drop of a copy that is not the caller's", async () => {
      const looks = sideName('some_app', 'r', 'abcd1234');
      expect(() => assertAppSchema(looks)).toThrow(/looks like a draft/);
      await expect(
        AppHost.open(tmp(), {
          store: new MemoryVersionStore(),
          database: config(looks),
        }),
      ).rejects.toThrow(/looks like/);
      const other = await newSchema('own_other');
      const mine = await newSchema('own_mine');
      const planted = sideName(mine, 'r', 'abcd1234');
      await admin.query(`CREATE SCHEMA "${planted}"`);
      await admin.query(
        `COMMENT ON SCHEMA "${planted}" IS '${sideOwnerComment(other)}'`,
      );
      schemas.push(planted);
      await expect(
        withSchemaAdmin(config(mine), (db) =>
          dropSchema(db, planted, 1000, mine),
        ),
      ).rejects.toThrow(/not a copy made for/);
      expect(
        await rows(`SELECT 1 FROM pg_namespace WHERE nspname = ?`, [planted]),
      ).toHaveLength(1);
    });
  });

  // ---------- privileges are the source's, exactly ----------

  describe('a copy carries exactly the source privileges', () => {
    /** Effective ACL of everything in a schema, by object, as text (owner and grantor included). */
    const privileges = async (schema: string) => {
      const acl = (kind: string, owner: string, acl: string) =>
        `coalesce((SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END || ':' || x.privilege_type || ':' || x.is_grantable, ',' ORDER BY x.grantee, x.privilege_type) FROM aclexplode(coalesce(${acl}, acldefault('${kind}', ${owner}))) x), '')`;
      return rows(
        `SELECT 'function' AS k, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS n, pg_get_userbyid(p.proowner) AS o, ${acl('f', 'p.proowner', 'p.proacl')} AS a FROM pg_proc p WHERE p.pronamespace = to_regnamespace(?1)
         UNION ALL SELECT 'table', c.relname, pg_get_userbyid(c.relowner), ${acl('r', 'c.relowner', 'c.relacl')} FROM pg_class c WHERE c.relnamespace = to_regnamespace(?1) AND c.relkind = 'r'
         UNION ALL SELECT 'sequence', c.relname, pg_get_userbyid(c.relowner), ${acl('s', 'c.relowner', 'c.relacl')} FROM pg_class c WHERE c.relnamespace = to_regnamespace(?1) AND c.relkind = 'S'
         UNION ALL SELECT 'schema', 'self', pg_get_userbyid(n.nspowner), ${acl('n', 'n.nspowner', 'n.nspacl')} FROM pg_namespace n WHERE n.oid = to_regnamespace(?1)
         UNION ALL SELECT 'default', d.defaclobjtype::text, pg_get_userbyid(d.defaclrole), coalesce(d.defaclacl::text, '') FROM pg_default_acl d WHERE d.defaclnamespace = to_regnamespace(?1)
         ORDER BY 1, 2`.replace(/\?1/g, '?'),
        [schema, schema, schema, schema, schema],
      );
    };
    const fixture = async () => {
      const src = await newSchema('priv');
      const role = `smrt_p_${Math.random().toString(36).slice(2, 8)}`;
      roles.push(role);
      await superuser.query(`CREATE ROLE "${role}" NOLOGIN`);
      const me = (await rows(`SELECT current_user AS u`))[0].u as string;
      await superuser.query(`GRANT "${role}" TO "${me}"`);
      for (const q of [
        // Default privileges first, so objects created next pick them up.
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${me}" IN SCHEMA "${src}" GRANT SELECT ON TABLES TO "${role}"`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE "${me}" IN SCHEMA "${src}" GRANT USAGE ON SEQUENCES TO PUBLIC`,
        `CREATE TABLE "${src}".t (id serial PRIMARY KEY, v text)`,
        `CREATE TABLE "${src}".open_t (id int)`,
        `CREATE FUNCTION "${src}".secret() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
        `REVOKE ALL ON FUNCTION "${src}".secret() FROM PUBLIC`,
        `CREATE FUNCTION "${src}".shared(a int) RETURNS int LANGUAGE sql AS 'SELECT a'`,
        `GRANT EXECUTE ON FUNCTION "${src}".shared(int) TO "${role}"`,
        `CREATE FUNCTION "${src}".plain() RETURNS int LANGUAGE sql AS 'SELECT 3'`,
        `GRANT INSERT, UPDATE ON "${src}".t TO "${role}" WITH GRANT OPTION`,
        `GRANT SELECT ON "${src}".open_t TO PUBLIC`,
        `REVOKE ALL ON "${src}".t_id_seq FROM PUBLIC`,
        `GRANT USAGE ON SCHEMA "${src}" TO PUBLIC`,
        `GRANT CREATE ON SCHEMA "${src}" TO "${role}"`,
        `ALTER TABLE "${src}".open_t OWNER TO "${role}"`,
      ])
        await admin.query(q);
      return { src, role };
    };
    const verify = async (src: string, dst: string, role: string) => {
      const a = await privileges(src);
      const b = await privileges(dst);
      expect(b).toEqual(a);
      // Spot checks: the revoked function is not executable by PUBLIC in the copy.
      const secret = b.find((r) => r.n === 'secret()');
      expect(secret?.a).not.toContain('PUBLIC');
      expect(
        b.find((r) => r.k === 'function' && r.n === 'shared(a integer)')?.a,
      ).toContain(`${role}:EXECUTE`);
      expect(b.find((r) => r.k === 'default')).toBeTruthy();
      expect(b.find((r) => r.k === 'sequence')?.a).not.toContain('PUBLIC');
    };

    it('a fork', async () => {
      const { src, role } = await fixture();
      const dst = sideName(src, 'r', 'cafe0001');
      schemas.push(dst);
      await withSchemaAdmin(config(src), (db) => forkSchema(db, src, dst, src));
      await verify(src, dst, role);
    });

    it('a dump restored into a new schema', async () => {
      const { src, role } = await fixture();
      const file = join(tmp(), 'p.pgdump');
      await withSchemaAdmin(config(src), (db) => dumpSchema(db, src, file));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const dst = sideName(src, 'n', 'cafe0002');
      schemas.push(dst);
      await withSchemaAdmin(config(src), (db) =>
        restoreDump(db, file, dst, src),
      );
      await verify(src, dst, role);
    });
  });

  it('a snapshot that is a SQLite database file is refused, not parsed', async () => {
    const live = await seeded('dbfile');
    const name = `${Date.now()}-0-method-x.db`;
    writeFileSync(join(live.dir, 'snapshots', name), 'SQLite format 3');
    await expect(live.host.restoreSnapshot(name, OK)).rejects.toBeInstanceOf(
      EngineError,
    );
    await expect(live.host.restoreSnapshot(name, OK)).rejects.toThrow(
      /SQLite database file/,
    );
  });
});
