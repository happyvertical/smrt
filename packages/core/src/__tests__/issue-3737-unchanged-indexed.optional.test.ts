/**
 * #3737: an existing-row write must not assign UNCHANGED indexed columns.
 *
 * DuckDB rewrites (delete + insert) a row whose indexed column is assigned,
 * even to its current value, and refuses that when a foreign key still
 * references the row. `save()` serializes the whole model, so toggling a
 * non-indexed field of a referenced parent used to fail. The fixture mirrors
 * the real trigger (a subscription with deliveries): a parent, a child whose
 * FK references it, and a save that changes only non-indexed columns.
 *
 * The child table is raw DDL on purpose. The contract under test is the
 * database's behaviour with a referencing row, not the FK planner.
 *
 * Dialects: SQLite and PostgreSQL must keep writing exactly what they wrote
 * before (asserted through the adapter calls); DuckDB leaves out only columns
 * it can prove unchanged. PostgreSQL runs when `SMRT_TEST_POSTGRES_URL` is set.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { field } from '../decorators/index.js';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** A parent with every column kind the write path binds. */
@smrt({ tableName: 'issue3737_parents' })
class Issue3737Parent extends SmrtObject {
  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  @field({ type: 'boolean' })
  enabled = true;

  @field({ type: 'text' })
  label = '';

  @field({ type: 'integer' })
  attempts = 0;

  @field({ type: 'decimal' })
  rate = 0.0;

  @field({ type: 'json' })
  settings: Record<string, unknown> = {};

  @field({ type: 'json' })
  tags: string[] = [];

  @field({ type: 'datetime', nullable: true })
  seenAt: Date | null = null;
}

/** A natural-key object: identified by its external id; the tenant owns it. */
@smrt({
  tableName: 'issue3737_imports',
  conflictColumns: ['external_id'],
})
class Issue3737Import extends SmrtObject {
  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text' })
  externalId = '';

  @field({ type: 'boolean' })
  active = true;
}

/** STI family sharing one table. */
@smrt({ tableName: 'issue3737_shapes', tableStrategy: 'sti' })
class Issue3737Shape extends SmrtObject {
  @field({ type: 'boolean' })
  visible = true;
}

@smrt()
class Issue3737Circle extends Issue3737Shape {
  @field({ type: 'integer' })
  radius = 1;
}

/** Columns named after SQL reserved words. */
@smrt({ tableName: 'issue3737_reserved' })
class Issue3737Reserved extends SmrtObject {
  @field({ type: 'integer' })
  order = 0;

  @field({ type: 'text' })
  group = '';
}

const POSTGRES_URL = process.env.SMRT_TEST_POSTGRES_URL;

for (const dialect of ['sqlite', 'duckdb', 'postgres'] as const) {
  const suite =
    dialect === 'postgres' && !POSTGRES_URL ? describe.skip : describe;
  suite.sequential(`unchanged indexed assignments (${dialect})`, () => {
    let db: DatabaseInterface;
    const uuidType = dialect === 'sqlite' ? 'TEXT' : 'UUID';

    beforeEach(async () => {
      const classes = [
        'Issue3737Parent',
        'Issue3737Import',
        'Issue3737Shape',
        'Issue3737Circle',
      ];
      if (dialect === 'postgres') {
        const connection = await getDatabase({
          type: 'postgres',
          url: POSTGRES_URL,
          dbid: `issue3737-${randomUUID()}`,
        } as Parameters<typeof getDatabase>[0]);
        db = await getTestDatabase({ db: connection, classes });
      } else {
        db = await getTestDatabase({ type: dialect, url: ':memory:', classes });
      }
      for (const [child, parent] of [
        ['issue3737_children', 'issue3737_parents'],
        ['issue3737_import_children', 'issue3737_imports'],
        ['issue3737_shape_children', 'issue3737_shapes'],
      ]) {
        await db.query(`DROP TABLE IF EXISTS ${child}`);
        // A shared PostgreSQL database keeps rows across tests.
        await db.query(`DELETE FROM ${parent}`);
        await db.query(
          `CREATE TABLE ${child} (id ${uuidType} PRIMARY KEY, parent_id ${uuidType} REFERENCES ${parent}(id))`,
        );
      }
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      if (dialect === 'postgres') {
        for (const table of [
          'issue3737_children',
          'issue3737_import_children',
          'issue3737_shape_children',
        ]) {
          await db?.query(`DROP TABLE IF EXISTS ${table}`);
        }
      }
      await db?.close?.();
    });

    const reference = (table: string, parentId: string) =>
      db.insert(table, { id: randomUUID(), parent_id: parentId });

    const newParent = async (
      values: Partial<Issue3737Parent> = {},
      slug = 'parent-1',
    ) => {
      const parent = new Issue3737Parent({ db, slug });
      await parent.initialize();
      Object.assign(parent, { tenantId: TENANT_A, ...values });
      await parent.save();
      return parent;
    };

    const load = async (id: string) => {
      const loaded = new Issue3737Parent({ db, id });
      await loaded.initialize();
      return loaded;
    };

    /** Columns assigned by each UPDATE statement the core writer issued. */
    const assignedColumns = (query: { mock: { calls: unknown[][] } }) =>
      query.mock.calls
        .map((call) => String(call[0]))
        .filter((sql) => sql.startsWith('UPDATE "'))
        .map((sql) =>
          [
            ...sql
              .slice(sql.indexOf(' SET ') + 5, sql.lastIndexOf(' WHERE '))
              .matchAll(/"([^"]+)" = /gu),
          ].map((match) => match[1]),
        );

    const rawRow = async (table: string, id: string) =>
      (
        await db.query(
          `SELECT slug, context, created_at, updated_at FROM ${table} WHERE id = ?`,
          id,
        )
      ).rows[0] as Record<string, unknown>;

    describe('referenced parent', () => {
      it('toggles a non-indexed field of a parent that a child references', async () => {
        const created = await newParent();
        await reference('issue3737_children', created.id as string);
        const before = await rawRow('issue3737_parents', created.id as string);

        const loaded = await load(created.id as string);
        loaded.enabled = false;
        loaded.label = 'changed';
        await loaded.save();

        const after = await load(created.id as string);
        expect(after.enabled).toBe(false);
        expect(after.label).toBe('changed');
        expect(after.slug).toBe('parent-1');
        expect(after.tenantId).toBe(TENANT_A);
        const row = await rawRow('issue3737_parents', created.id as string);
        expect(row.slug).toBe(before.slug);
        expect(row.context).toBe(before.context);
        expect(new Date(row.created_at as string).getTime()).toBe(
          new Date(before.created_at as string).getTime(),
        );
        expect(new Date(row.updated_at as string).getTime()).toBeGreaterThan(
          new Date(before.updated_at as string).getTime(),
        );
        const children = await db.query(
          'SELECT COUNT(*) AS n FROM issue3737_children',
        );
        expect(Number(children.rows[0].n)).toBe(1);
      });

      it('writes every changed value kind through the id-targeted update', async () => {
        const created = await newParent();
        await reference('issue3737_children', created.id as string);

        const loaded = await load(created.id as string);
        loaded.enabled = false;
        loaded.label = '';
        loaded.attempts = 7;
        loaded.rate = 0.25;
        loaded.settings = { nested: { a: 1 }, list: [1, 2] };
        loaded.tags = ['x', 'y'];
        loaded.seenAt = new Date('2026-01-02T03:04:05.678Z');
        await loaded.save();

        const after = await load(created.id as string);
        expect(after.enabled).toBe(false);
        expect(after.label).toBe('');
        expect(after.attempts).toBe(7);
        expect(after.rate).toBe(0.25);
        expect(after.settings).toEqual({ nested: { a: 1 }, list: [1, 2] });
        expect(after.tags).toEqual(['x', 'y']);
        expect(after.seenAt?.toISOString()).toBe('2026-01-02T03:04:05.678Z');

        const clearing = await load(created.id as string);
        clearing.seenAt = null;
        clearing.tags = [];
        await clearing.save();
        const cleared = await load(created.id as string);
        expect(cleared.seenAt).toBeNull();
        expect(cleared.tags).toEqual([]);
        expect(cleared.settings).toEqual({ nested: { a: 1 }, list: [1, 2] });
      });

      it('assigns what each engine assigned before, minus provably unchanged indexed columns', async () => {
        const created = await newParent();
        await reference('issue3737_children', created.id as string);
        const upsert = vi.spyOn(db, 'upsert');
        const update = vi.spyOn(db, 'update');
        const query = vi.spyOn(db, 'query');

        const loaded = await load(created.id as string);
        loaded.enabled = false;
        await loaded.save();

        if (dialect === 'duckdb') {
          expect(upsert).not.toHaveBeenCalled();
          expect(update).not.toHaveBeenCalled();
          const statements = assignedColumns(query);
          expect(statements).toHaveLength(1);
          const [columns] = statements;
          for (const indexed of [
            'id',
            'slug',
            'context',
            'tenant_id',
            'created_at',
          ]) {
            expect(columns).not.toContain(indexed);
          }
          expect(columns).toEqual(
            expect.arrayContaining(['enabled', 'updated_at', 'label']),
          );
        } else if (dialect === 'sqlite') {
          expect(update).not.toHaveBeenCalled();
          expect(upsert).toHaveBeenCalledTimes(1);
          expect(upsert.mock.calls[0][1]).toEqual(['id']);
          expect(upsert.mock.calls[0][2]).toMatchObject({
            id: created.id,
            slug: 'parent-1',
            context: '',
            tenant_id: TENANT_A,
          });
          expect(upsert.mock.calls[0][2]).toHaveProperty('created_at');
        } else {
          expect(upsert).not.toHaveBeenCalled();
          expect(update.mock.calls[0][2]).toMatchObject({
            slug: 'parent-1',
            tenant_id: TENANT_A,
          });
        }
      });

      it('still assigns a changed indexed column, which DuckDB rightly refuses on a referenced parent', async () => {
        const created = await newParent();
        await reference('issue3737_children', created.id as string);
        const before = await rawRow('issue3737_parents', created.id as string);

        const loaded = await load(created.id as string);
        loaded.slug = 'renamed';
        loaded.enabled = false;
        const attempt = loaded.save();

        if (dialect === 'duckdb') {
          await expect(attempt).rejects.toMatchObject({
            code: 'DB_QUERY_FAILED',
          });
          await expect(attempt).rejects.toThrow(/foreign key/iu);
          const row = await rawRow('issue3737_parents', created.id as string);
          expect(row.slug).toBe('parent-1');
          expect(new Date(row.updated_at as string).getTime()).toBe(
            new Date(before.updated_at as string).getTime(),
          );
          expect((await load(created.id as string)).enabled).toBe(true);
        } else {
          await attempt;
          const row = await rawRow('issue3737_parents', created.id as string);
          expect(row.slug).toBe('renamed');
          expect((await load(created.id as string)).enabled).toBe(false);
        }
      });

      it('rejects a stale writer without touching the row', async () => {
        const created = await newParent();
        await reference('issue3737_children', created.id as string);
        const first = await load(created.id as string);
        const stale = await load(created.id as string);

        first.label = 'first';
        await first.save();
        stale.label = 'stale';
        stale.enabled = false;
        await expect(stale.save()).rejects.toMatchObject({
          code: 'RUNTIME_REVISION_CONFLICT',
        });

        const after = await load(created.id as string);
        expect(after.label).toBe('first');
        expect(after.enabled).toBe(true);
      });

      it('honours an explicit expectedUpdatedAt', async () => {
        const created = await newParent();
        await reference('issue3737_children', created.id as string);
        const loaded = await load(created.id as string);
        const revision = loaded.updated_at as Date;

        loaded.label = 'guarded';
        await loaded.save({ expectedUpdatedAt: revision });
        expect((await load(created.id as string)).label).toBe('guarded');

        const again = await load(created.id as string);
        again.label = 'outdated';
        await expect(
          again.save({ expectedUpdatedAt: revision }),
        ).rejects.toMatchObject({ code: 'RUNTIME_REVISION_CONFLICT' });
        expect((await load(created.id as string)).label).toBe('guarded');
      });

      it.skipIf(dialect !== 'duckdb')(
        'quotes columns named after reserved words',
        async () => {
          // Provisioned by hand: only DuckDB is asked to quote these names.
          await db.query('DROP TABLE IF EXISTS issue3737_reserved_children');
          await db.query('DROP TABLE IF EXISTS issue3737_reserved');
          await db.query(
            `CREATE TABLE issue3737_reserved (id UUID PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '', created_at TIMESTAMP NOT NULL DEFAULT current_timestamp, updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp, "order" INTEGER, "group" TEXT, UNIQUE (slug, context))`,
          );
          await db.query(
            'CREATE TABLE issue3737_reserved_children (id UUID PRIMARY KEY, parent_id UUID REFERENCES issue3737_reserved(id))',
          );
          const row = new Issue3737Reserved({ db, slug: 'reserved-1' });
          await row.initialize();
          row.order = 1;
          row.group = 'a';
          await row.save();
          await reference('issue3737_reserved_children', row.id as string);

          const loaded = new Issue3737Reserved({ db, id: row.id as string });
          await loaded.initialize();
          loaded.order = 4;
          loaded.group = '';
          await loaded.save();

          const after = new Issue3737Reserved({ db, id: row.id as string });
          await after.initialize();
          expect(after.order).toBe(4);
          expect(after.group).toBe('');
        },
      );

      it('claims a revision of a referenced parent and keeps the row otherwise intact', async () => {
        const created = await newParent({ label: 'kept' });
        await reference('issue3737_children', created.id as string);
        const claimant = await load(created.id as string);
        const revision = claimant.updated_at as Date;
        claimant.label = 'must not persist';

        await claimant.claimRevision(revision);

        const after = await load(created.id as string);
        expect(after.label).toBe('kept');
        expect(after.slug).toBe('parent-1');
        expect(after.tenantId).toBe(TENANT_A);
        expect((after.updated_at as Date).getTime()).toBeGreaterThan(
          revision.getTime(),
        );

        const stale = await load(created.id as string);
        await expect(stale.claimRevision(revision)).rejects.toMatchObject({
          code: 'RUNTIME_REVISION_CONFLICT',
        });
      });
    });

    describe('unreferenced parent', () => {
      it('writes changed natural-key and tenant columns', async () => {
        const created = await newParent();
        const loaded = await load(created.id as string);
        loaded.slug = 'renamed';
        loaded.tenantId = TENANT_B;
        loaded.enabled = false;
        await loaded.save();

        const after = await load(created.id as string);
        expect(after.slug).toBe('renamed');
        expect(after.tenantId).toBe(TENANT_B);
        expect(after.enabled).toBe(false);
      });

      it('writes a changed context together with an unchanged slug', async () => {
        const created = await newParent();
        const loaded = await load(created.id as string);
        loaded.context = 'other';
        await loaded.save();
        const row = await rawRow('issue3737_parents', created.id as string);
        expect(row.slug).toBe('parent-1');
        expect(row.context).toBe('other');
      });

      it('compares UUIDs without regard to letter case', async () => {
        const created = await newParent();
        await reference('issue3737_children', created.id as string);
        const loaded = await load(created.id as string);
        loaded.tenantId = TENANT_A.toUpperCase();
        loaded.enabled = false;
        await loaded.save();
        expect((await load(created.id as string)).enabled).toBe(false);
      });
    });

    describe('tenant isolation', () => {
      it('still refuses a write that a beforeSave interceptor denies', async () => {
        const created = await newParent();
        await reference('issue3737_children', created.id as string);
        const loaded = await load(created.id as string);
        loaded.enabled = false;
        GlobalInterceptors.register({
          name: 'issue-3737-tenant-denial',
          beforeSave() {
            throw Object.assign(new Error('tenant denied'), {
              code: 'TENANT_ISOLATION_VIOLATION',
            });
          },
        });
        try {
          await expect(loaded.save()).rejects.toMatchObject({
            code: 'TENANT_ISOLATION_VIOLATION',
          });
        } finally {
          GlobalInterceptors.unregister('issue-3737-tenant-denial');
        }
        expect((await load(created.id as string)).enabled).toBe(true);
      });

      it('refuses a new object whose natural key belongs to another tenant', async () => {
        const first = new Issue3737Import({ db, slug: 'import-1' });
        await first.initialize();
        first.tenantId = TENANT_A;
        first.externalId = 'ext-1';
        await first.save();
        await reference('issue3737_import_children', first.id as string);

        const intruder = new Issue3737Import({ db, slug: 'import-2' });
        await intruder.initialize();
        intruder.tenantId = TENANT_B;
        intruder.externalId = 'ext-1';
        intruder.active = false;
        await expect(intruder.save()).rejects.toMatchObject({
          code: 'TENANT_ISOLATION_VIOLATION',
        });

        const stored = new Issue3737Import({ db, id: first.id as string });
        await stored.initialize();
        expect(stored.tenantId).toBe(TENANT_A);
        expect(stored.active).toBe(true);
      });
    });

    describe('natural-key objects', () => {
      it('updates a referenced natural-key row without reassigning its key', async () => {
        const created = new Issue3737Import({ db, slug: 'import-1' });
        await created.initialize();
        created.tenantId = TENANT_A;
        created.externalId = 'ext-1';
        await created.save();
        await reference('issue3737_import_children', created.id as string);

        const loaded = new Issue3737Import({ db, id: created.id as string });
        await loaded.initialize();
        loaded.active = false;
        await loaded.save();

        const after = new Issue3737Import({ db, id: created.id as string });
        await after.initialize();
        expect(after.active).toBe(false);
        expect(after.externalId).toBe('ext-1');
        expect(after.tenantId).toBe(TENANT_A);
      });

      it('re-imports a referenced natural-key row through a new object', async () => {
        const created = new Issue3737Import({ db, slug: 'import-1' });
        await created.initialize();
        created.tenantId = TENANT_A;
        created.externalId = 'ext-1';
        await created.save();
        await reference('issue3737_import_children', created.id as string);
        const query = vi.spyOn(db, 'query');

        // A fresh object with the same natural key adopts the stored row.
        const reimport = new Issue3737Import({ db, slug: 'import-1' });
        await reimport.initialize();
        reimport.tenantId = TENANT_A;
        reimport.externalId = 'ext-1';
        reimport.active = false;
        await reimport.save();

        expect(reimport.id).toBe(created.id);
        const after = new Issue3737Import({ db, id: created.id as string });
        await after.initialize();
        expect(after.active).toBe(false);
        expect(after.tenantId).toBe(TENANT_A);
        if (dialect === 'duckdb') {
          const columns = assignedColumns(query).at(-1) ?? [];
          for (const kept of [
            'id',
            'slug',
            'context',
            'tenant_id',
            'external_id',
            'created_at',
          ]) {
            expect(columns).not.toContain(kept);
          }
          expect(columns).toContain('active');
        }
      });

      it('still assigns an edited natural-key field', async () => {
        const created = new Issue3737Import({ db, slug: 'import-1' });
        await created.initialize();
        created.tenantId = TENANT_A;
        created.externalId = 'ext-1';
        await created.save();
        await reference('issue3737_import_children', created.id as string);

        const loaded = new Issue3737Import({ db, id: created.id as string });
        await loaded.initialize();
        loaded.externalId = 'ext-2';
        const attempt = loaded.save();
        if (dialect === 'duckdb') {
          await expect(attempt).rejects.toThrow(/foreign key/iu);
        } else {
          await attempt;
          const after = new Issue3737Import({ db, id: created.id as string });
          await after.initialize();
          expect(after.externalId).toBe('ext-2');
        }
      });
    });

    describe('STI subclasses', () => {
      it('toggles a field of a referenced STI row', async () => {
        const circle = new Issue3737Circle({ db, slug: 'circle-1' });
        await circle.initialize();
        circle.radius = 3;
        await circle.save();
        await reference('issue3737_shape_children', circle.id as string);

        const loaded = new Issue3737Circle({ db, id: circle.id as string });
        await loaded.initialize();
        loaded.radius = 5;
        loaded.visible = false;
        await loaded.save();

        const after = new Issue3737Circle({ db, id: circle.id as string });
        await after.initialize();
        expect(after.radius).toBe(5);
        expect(after.visible).toBe(false);
        expect(after.slug).toBe('circle-1');
        const row = await db.query(
          'SELECT _meta_type FROM issue3737_shapes WHERE id = ?',
          circle.id,
        );
        expect(String(row.rows[0]._meta_type)).toContain('Issue3737Circle');
      });
    });
  });
}

/**
 * The JSON adapter wraps the same DuckDB connection but persists a table to
 * `<table>.json` only from its own insert/update/upsert/delete; a raw
 * `query()` never does. A raw write there is visible in-process and lost on
 * the next one, so the DuckDB-only path must not run on it.
 */
describe('JSON adapter keeps persisting existing-row writes (#3737)', () => {
  let dir: string;
  let db: DatabaseInterface;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'issue3737-json-'));
    db = await getTestDatabase({
      type: 'json',
      url: dir,
      classes: ['Issue3737Parent', 'Issue3737Import'],
    });
  });

  afterEach(async () => {
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  /** What the next process sees: the table file, and a fresh connection. */
  const persisted = async (table: string, id: string) => {
    const file = JSON.parse(readFileSync(join(dir, `${table}.json`), 'utf8'));
    const fresh = await getDatabase({ type: 'json', url: dir });
    try {
      const row = (await fresh.get(table, { id })) as Record<string, unknown>;
      return {
        file: file.find((entry: { id: string }) => entry.id === id),
        row,
      };
    } finally {
      await fresh.close?.();
    }
  };

  it('persists a toggle of an existing row', async () => {
    const created = new Issue3737Parent({ db, slug: 'parent-1' });
    await created.initialize();
    await created.save();

    const loaded = new Issue3737Parent({ db, id: created.id as string });
    await loaded.initialize();
    loaded.enabled = false;
    await loaded.save();

    const { file, row } = await persisted(
      'issue3737_parents',
      created.id as string,
    );
    expect(file.enabled).toBe(false);
    expect(row.enabled).toBe(false);
  });

  it('persists a natural-key adoption of an existing row', async () => {
    const created = new Issue3737Import({ db, slug: 'import-1' });
    await created.initialize();
    created.externalId = 'ext-1';
    await created.save();

    const reimport = new Issue3737Import({ db, slug: 'import-1' });
    await reimport.initialize();
    reimport.externalId = 'ext-1';
    reimport.active = false;
    await reimport.save();
    expect(reimport.id).toBe(created.id);

    const { file, row } = await persisted(
      'issue3737_imports',
      created.id as string,
    );
    expect(file.active).toBe(false);
    expect(row.active).toBe(false);
  });

  it('persists a revision claim', async () => {
    const created = new Issue3737Parent({ db, slug: 'parent-1' });
    await created.initialize();
    await created.save();
    const claimant = new Issue3737Parent({ db, id: created.id as string });
    await claimant.initialize();
    const before = claimant.updated_at as Date;

    await claimant.claimRevision(before);

    const { file, row } = await persisted(
      'issue3737_parents',
      created.id as string,
    );
    expect(
      new Date(String(file.updated_at).replace(' ', 'T') + 'Z').getTime(),
    ).toBeGreaterThan(before.getTime());
    expect(new Date(row.updated_at as string).getTime()).toBeGreaterThan(
      before.getTime(),
    );
  });
});
