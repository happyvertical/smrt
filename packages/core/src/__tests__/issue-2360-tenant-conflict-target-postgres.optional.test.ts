/**
 * Issue #2360 on PostgreSQL — the engine where a conflict target that does
 * not match a unique index is a hard error (42P10), and where the SDK's
 * `INSERT … ON CONFLICT (…) DO UPDATE SET <every column>` rewrote tenant A's
 * `id`/`tenant_id` when tenant B saved the same slug (finding B1).
 *
 * Covers, against a real server:
 *
 * 1. the B1 probe with the manifest-path schema (`getSchemaDDL(…, 'postgres')`
 *    + the strategy's index DDL — what `smrt db:migrate` materializes): two
 *    tenants, one slug → two rows; same tenant dedups; NULL-tenant rows dedup
 *    through the null-aware upsert;
 * 2. an STI table with a CUSTOM conflict key on the root saves on PostgreSQL
 *    (the STI generator used to hard-code `(slug, context, _meta_type)` and
 *    ignore the root's `conflictColumns`, so every save raised 42P10);
 * 3. the migration rehearsal: a table carrying the PRE-#2360 global unique
 *    `<table>_slug_context_idx (slug, context)` — the anytown shape — is
 *    repaired by `SchemaComparer` with a same-name `drop_index` + `add_index`
 *    swap, after which the cross-tenant create succeeds.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set (`pnpm test:postgres`).
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import type { SchemaDefinition } from '../schema/types.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const WIDGETS = 'issue_2360_pg_widgets';
const TICKETS = 'issue_2360_pg_tickets';
const LEGACY = 'issue_2360_pg_legacy_docs';

@smrt({
  tableName: 'issue_2360_pg_widgets',
  tenantScoped: { mode: 'optional' },
})
class Issue2360PgWidget extends SmrtObject {
  @field({ type: 'text', required: true })
  name: string = '';

  @field({ required: false, nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class Issue2360PgWidgetCollection extends SmrtCollection<Issue2360PgWidget> {
  static readonly _itemClass = Issue2360PgWidget;
}

@smrt({
  tableName: 'issue_2360_pg_tickets',
  tableStrategy: 'sti',
  tenantScoped: { mode: 'optional' },
  conflictColumns: ['tenant_id', 'code'],
})
class Issue2360PgTicket extends SmrtObject {
  @field({ type: 'text', required: true })
  code: string = '';

  @field({ required: false, nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.code === 'string') this.code = options.code;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class Issue2360PgTicketCollection extends SmrtCollection<Issue2360PgTicket> {
  static readonly _itemClass = Issue2360PgTicket;
}

@smrt()
class Issue2360PgBugTicket extends Issue2360PgTicket {
  @field({ type: 'text' })
  severity: string = '';

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    if (typeof options.severity === 'string') {
      this.severity = options.severity;
    }
  }
}

class Issue2360PgBugTicketCollection extends SmrtCollection<Issue2360PgBugTicket> {
  static readonly _itemClass = Issue2360PgBugTicket;
}

/** Same shape as the widget, but its table is created the PRE-#2360 way. */
@smrt({
  tableName: 'issue_2360_pg_legacy_docs',
  tenantScoped: { mode: 'optional' },
})
class Issue2360PgLegacyDoc extends SmrtObject {
  @field({ type: 'text', required: true })
  title: string = '';

  @field({ required: false, nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.title === 'string') this.title = options.title;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class Issue2360PgLegacyDocCollection extends SmrtCollection<Issue2360PgLegacyDoc> {
  static readonly _itemClass = Issue2360PgLegacyDoc;
}

function registrationName(ctor: typeof SmrtObject): string {
  const registration = ObjectRegistry.getClassByConstructor(ctor);
  return registration?.qualifiedName || registration?.name || ctor.name;
}

async function createFromSchema(
  db: DatabaseInterface,
  ctor: typeof SmrtObject,
  table: string,
): Promise<SchemaDefinition> {
  const className = registrationName(ctor);
  const schema = ObjectRegistry.getSchema(className);
  const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
  if (!schema || !ddl) throw new Error(`Missing schema for ${className}`);
  await db.query(`DROP TABLE IF EXISTS "${table}"`);
  await db.query(ddl);
  for (const indexSql of getDDLStrategy('postgres').generateIndexes(schema)) {
    await db.query(indexSql);
  }
  return schema;
}

async function listRows(
  db: DatabaseInterface,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  return (await db.list(table, {})) as Array<Record<string, unknown>>;
}

describe.skipIf(!pgUrl)(
  'tenant-aware natural keys on PostgreSQL (#2360)',
  () => {
    let db: DatabaseInterface;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2360-${randomUUID()}`,
        max: 4,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;

      await createFromSchema(db, Issue2360PgWidget, WIDGETS);
      await createFromSchema(db, Issue2360PgTicket, TICKETS);
    }, 30_000);

    afterAll(async () => {
      if (!db) return;
      try {
        for (const table of [WIDGETS, TICKETS, LEGACY]) {
          await db.query(`DROP TABLE IF EXISTS "${table}"`);
        }
      } finally {
        await db.close?.();
      }
    });

    beforeEach(async () => {
      await db.query(`TRUNCATE "${WIDGETS}"`);
      await db.query(`TRUNCATE "${TICKETS}"`);
    });

    it('materializes (tenant_id, slug, context) UNIQUE under the stable name', async () => {
      const rows = (await db.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
        [WIDGETS],
      )) as unknown as {
        rows?: Array<{ indexname: string; indexdef: string }>;
      };
      const indexes = Array.isArray(rows) ? rows : (rows.rows ?? []);
      const conflict = indexes.find(
        (index) => index.indexname === `${WIDGETS}_slug_context_idx`,
      );
      expect(conflict?.indexdef).toMatch(/UNIQUE INDEX/);
      expect(conflict?.indexdef).toMatch(/\(tenant_id, slug, context\)/);
      expect(
        indexes.some((index) => index.indexname === `${WIDGETS}_tenant_id_idx`),
      ).toBe(false);
    });

    it('B1 probe: two tenants own the same slug as two rows; same tenant dedups; NULL-tenant rows dedup null-aware', async () => {
      const widgets = await Issue2360PgWidgetCollection.create({ db });

      const a = await widgets.create({ name: 'Widget', tenantId: TENANT_A });
      const b = await widgets.create({ name: 'Widget', tenantId: TENANT_B });
      expect(b.id).not.toBe(a.id);

      let rows = await listRows(db, WIDGETS);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.tenant_id === TENANT_A)?.id).toBe(a.id);
      expect(rows.find((row) => row.tenant_id === TENANT_B)?.id).toBe(b.id);

      await widgets.create({ name: 'Widget', tenantId: TENANT_A });
      rows = await listRows(db, WIDGETS);
      expect(rows).toHaveLength(2);

      await widgets.create({ name: 'Widget', tenantId: null });
      await widgets.create({ name: 'Widget', tenantId: null });
      rows = await listRows(db, WIDGETS);
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => row.tenant_id == null)).toHaveLength(1);
    });

    it('STI root with custom conflictColumns: root and child save (no 42P10) and dedup on the custom key per tenant', async () => {
      const tickets = await Issue2360PgTicketCollection.create({ db });
      const bugs = await Issue2360PgBugTicketCollection.create({ db });

      const t1 = await tickets.create({ code: 'T-1', tenantId: TENANT_A });
      const t1b = await tickets.create({ code: 'T-1', tenantId: TENANT_B });
      await bugs.create({ code: 'B-1', severity: 'high', tenantId: TENANT_A });
      await bugs.create({
        code: 'B-1',
        severity: 'low',
        tenantId: TENANT_A,
        slug: 'another-slug',
      });

      expect(t1.id).not.toBe(t1b.id);
      const rows = await listRows(db, TICKETS);
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.code === 'B-1')?.severity).toBe('low');
    });

    it('migration rehearsal: the pre-#2360 global unique index is swapped in place by name, then cross-tenant creates succeed', async () => {
      const className = registrationName(Issue2360PgLegacyDoc);
      const schema = ObjectRegistry.getSchema(className);
      const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
      if (!schema || !ddl) throw new Error(`Missing schema for ${className}`);

      // The anytown-shaped legacy table: same columns, but the conflict index
      // is the old global `(slug, context)` UNIQUE plus #2359's standalone
      // tenant index.
      await db.query(`DROP TABLE IF EXISTS "${LEGACY}"`);
      await db.query(ddl);
      await db.query(
        `CREATE UNIQUE INDEX "${LEGACY}_slug_context_idx" ON "${LEGACY}" (slug, context)`,
      );
      await db.query(
        `CREATE INDEX "${LEGACY}_tenant_id_idx" ON "${LEGACY}" (tenant_id)`,
      );
      // Existing data: one row per tenant with DIFFERENT slugs (the old index
      // never allowed the same slug twice), so the superset key must apply
      // cleanly on top of it.
      await db.query(
        `INSERT INTO "${LEGACY}" (id, slug, context, title, tenant_id) VALUES ($1, 'alpha', '', 'Alpha', $2), ($3, 'beta', '', 'Beta', $4)`,
        [randomUUID(), TENANT_A, randomUUID(), TENANT_B],
      );

      // Before the swap the runtime target (tenant_id, slug, context) has no
      // matching unique index → PostgreSQL rejects the upsert outright.
      const docs = await Issue2360PgLegacyDocCollection.create({ db });
      await expect(
        docs.create({ title: 'Widget', tenantId: TENANT_A }),
      ).rejects.toThrow();

      const comparer = new SchemaComparer(db, { includeDroppedIndexes: false });
      const diff = await comparer.compare({ [LEGACY]: schema });
      const events = diff.changes
        .filter((c) => c.type === 'drop_index' || c.type === 'add_index')
        .map((c) => `${c.type}:${c.name}`);
      expect(events).toContain(`drop_index:${LEGACY}_slug_context_idx`);
      expect(events).toContain(`add_index:${LEGACY}_slug_context_idx`);
      // The orphaned standalone tenant index is left alone without
      // `--drop-indexes`; it is now redundant with the swapped conflict index.
      expect(events).not.toContain(`drop_index:${LEGACY}_tenant_id_idx`);

      for (const sql of getSQLFromDiff(diff)) {
        await db.query(sql);
      }

      const a = await docs.create({ title: 'Widget', tenantId: TENANT_A });
      const b = await docs.create({ title: 'Widget', tenantId: TENANT_B });
      expect(b.id).not.toBe(a.id);
      const rows = await listRows(db, LEGACY);
      expect(rows).toHaveLength(4);

      // Idempotent: a second diff finds nothing to do for the conflict index.
      const again = await comparer.compare({ [LEGACY]: schema });
      expect(
        again.changes.filter(
          (c) =>
            (c.type === 'drop_index' || c.type === 'add_index') &&
            c.name === `${LEGACY}_slug_context_idx`,
        ),
      ).toEqual([]);
    });
  },
);
