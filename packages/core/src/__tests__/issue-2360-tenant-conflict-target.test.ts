/**
 * Issue #2360 (epic #2382, finding B1/A4): tenant-aware natural keys.
 *
 * A NEW object's `save()` upserts on `ObjectRegistry.getConflictColumns()`.
 * Before this fix that was `(slug, context)` — or `(slug, context, _meta_type)`
 * for STI — with no tenant column, while the schema carried a matching global
 * unique index. `save()` from tenant B with the same slug therefore matched
 * tenant A's row and `DO UPDATE SET` rewrote its `id` and `tenant_id`: tenant
 * A silently lost the row and every reference it held dangled.
 *
 * Now a tenant-scoped class's default conflict target is
 * `[tenant column, ...natural key]` on both the schema and the upsert, so:
 *
 * - two tenants can each own the same slug (the B1 probe: two rows);
 * - within one tenant the natural key still dedups (ingestion-style upsert);
 * - NULL-tenant rows keep the SDK's null-aware upsert semantics
 *   (`IS NOT DISTINCT FROM`): global rows dedup among themselves;
 * - STI hierarchies key on the ROOT's target for every class in the table;
 * - a custom `@smrt({ conflictColumns })` on an STI root is honoured by the
 *   schema (it used to be ignored while `getConflictColumns()` returned it,
 *   so every PostgreSQL save failed with 42P10);
 * - custom-primary-key classes upsert on their primary key.
 *
 * Runs against the real registry paths on SQLite without the tenancy
 * interceptor (the tenant id is set explicitly). The interceptor-driven probe
 * lives in `packages/tenancy` (`issue-2360-tenant-natural-keys.test.ts`), the
 * PostgreSQL lane in `issue-2360-tenant-conflict-target-postgres.optional.test.ts`,
 * and the schema-path parity assertions in
 * `src/schema/schema-path-parity.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

@smrt({
  tableName: 'issue_2360_widgets',
  tenantScoped: { mode: 'optional' },
})
class Issue2360Widget extends SmrtObject {
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

class Issue2360WidgetCollection extends SmrtCollection<Issue2360Widget> {
  static readonly _itemClass = Issue2360Widget;
}

/**
 * Tenant-scoped with NO declared tenant property: the registry injects the
 * field. `toJSON()` must still emit it as an explicit NULL so the conflict
 * target is complete (an omitted key fails upsert validation).
 */
@smrt({
  tableName: 'issue_2360_notes',
  tenantScoped: { mode: 'optional' },
})
class Issue2360Note extends SmrtObject {
  @field({ type: 'text' })
  body: string = '';

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.body === 'string') this.body = options.body;
  }
}

class Issue2360NoteCollection extends SmrtCollection<Issue2360Note> {
  static readonly _itemClass = Issue2360Note;
}

@smrt({
  tableName: 'issue_2360_things',
  tableStrategy: 'sti',
  tenantScoped: { mode: 'optional' },
})
class Issue2360Thing extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ required: false, nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.label === 'string') this.label = options.label;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class Issue2360ThingCollection extends SmrtCollection<Issue2360Thing> {
  static readonly _itemClass = Issue2360Thing;
}

@smrt()
class Issue2360Gadget extends Issue2360Thing {
  @field({ type: 'text' })
  power: string = '';
}

class Issue2360GadgetCollection extends SmrtCollection<Issue2360Gadget> {
  static readonly _itemClass = Issue2360Gadget;
}

/** STI root with a CUSTOM conflict key — honoured by schema AND upsert. */
@smrt({
  tableName: 'issue_2360_tickets',
  tableStrategy: 'sti',
  tenantScoped: { mode: 'optional' },
  conflictColumns: ['tenant_id', 'code'],
})
class Issue2360Ticket extends SmrtObject {
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

class Issue2360TicketCollection extends SmrtCollection<Issue2360Ticket> {
  static readonly _itemClass = Issue2360Ticket;
}

@smrt()
class Issue2360BugTicket extends Issue2360Ticket {
  @field({ type: 'text' })
  severity: string = '';
}

class Issue2360BugTicketCollection extends SmrtCollection<Issue2360BugTicket> {
  static readonly _itemClass = Issue2360BugTicket;
}

/** Custom primary key: the only unique key is the declared PK. */
@smrt({ tableName: 'issue_2360_external_records' })
class Issue2360ExternalRecord extends SmrtObject {
  @field({ type: 'text', required: true, primaryKey: true })
  externalId: string = '';

  @field({ type: 'text' })
  label: string = '';
}

const CLASSES = [
  'Issue2360Widget',
  'Issue2360Note',
  'Issue2360Thing',
  'Issue2360Gadget',
  'Issue2360Ticket',
  'Issue2360BugTicket',
];

describe('tenant-aware natural keys (#2360)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'Issue2360Widget',
      Issue2360WidgetCollection,
    );
    ObjectRegistry.registerCollection('Issue2360Note', Issue2360NoteCollection);
    ObjectRegistry.registerCollection(
      'Issue2360Thing',
      Issue2360ThingCollection,
    );
    ObjectRegistry.registerCollection(
      'Issue2360Gadget',
      Issue2360GadgetCollection,
    );
    ObjectRegistry.registerCollection(
      'Issue2360Ticket',
      Issue2360TicketCollection,
    );
    ObjectRegistry.registerCollection(
      'Issue2360BugTicket',
      Issue2360BugTicketCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: CLASSES,
    });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  beforeEach(async () => {
    for (const table of [
      'issue_2360_widgets',
      'issue_2360_notes',
      'issue_2360_things',
      'issue_2360_tickets',
    ]) {
      await db.query(`DELETE FROM ${table}`);
    }
  });

  describe('ObjectRegistry.getConflictColumns()', () => {
    it('leads the default natural key with the tenant column for a tenant-scoped CTI class', () => {
      expect(ObjectRegistry.getConflictColumns('Issue2360Widget')).toEqual([
        'tenant_id',
        'slug',
        'context',
      ]);
      expect(ObjectRegistry.getTenantColumn('Issue2360Widget')).toBe(
        'tenant_id',
      );
    });

    it('leads the STI natural key with the tenant column, for the root AND its children', () => {
      const expected = ['tenant_id', 'slug', 'context', '_meta_type'];
      expect(ObjectRegistry.getConflictColumns('Issue2360Thing')).toEqual(
        expected,
      );
      expect(ObjectRegistry.getConflictColumns('Issue2360Gadget')).toEqual(
        expected,
      );
      expect(ObjectRegistry.getTenantColumn('Issue2360Gadget')).toBe(
        'tenant_id',
      );
    });

    it('resolves an STI child through the root when the root declares custom conflictColumns', () => {
      expect(ObjectRegistry.getConflictColumns('Issue2360Ticket')).toEqual([
        'tenant_id',
        'code',
      ]);
      expect(ObjectRegistry.getConflictColumns('Issue2360BugTicket')).toEqual([
        'tenant_id',
        'code',
      ]);
    });

    it('returns the declared primary key for a custom-primary-key class', () => {
      expect(
        ObjectRegistry.getConflictColumns('Issue2360ExternalRecord'),
      ).toEqual(['external_id']);
    });

    it('leaves a class that is not tenant-scoped on the plain natural key', () => {
      @smrt({ tableName: 'issue_2360_plain' })
      class Issue2360Plain extends SmrtObject {}
      expect(Issue2360Plain.name).toBe('Issue2360Plain');
      expect(ObjectRegistry.getConflictColumns('Issue2360Plain')).toEqual([
        'slug',
        'context',
      ]);
      expect(ObjectRegistry.getTenantColumn('Issue2360Plain')).toBeUndefined();
    });
  });

  describe('the generated unique index backs the conflict target', () => {
    it('emits (tenant_id, slug, context) UNIQUE under the stable name and no standalone tenant index', () => {
      const schema = ObjectRegistry.getSchema('Issue2360Widget');
      const conflict = schema?.indexes.find(
        (i) => i.name === 'issue_2360_widgets_slug_context_idx',
      );
      expect(conflict?.unique).toBe(true);
      expect(conflict?.columns).toEqual(['tenant_id', 'slug', 'context']);
      expect(
        schema?.indexes.some(
          (i) => i.name === 'issue_2360_widgets_tenant_id_idx',
        ),
      ).toBe(false);
    });

    it('emits the STI root custom key as the unique conflict index and keeps the slug lookup index', () => {
      const schema = ObjectRegistry.getSchema('Issue2360Ticket');
      const names = (schema?.indexes ?? []).map((i) => i.name).sort();
      expect(names).toEqual([
        'issue_2360_tickets_meta_type_idx',
        'issue_2360_tickets_slug_context_idx',
        'issue_2360_tickets_tenant_id_code_idx',
      ]);
      expect(
        schema?.indexes.find(
          (i) => i.name === 'issue_2360_tickets_tenant_id_code_idx',
        )?.unique,
      ).toBe(true);
      expect(
        schema?.indexes.find(
          (i) => i.name === 'issue_2360_tickets_slug_context_idx',
        )?.unique,
      ).toBeFalsy();
    });
  });

  describe('the B1 probe: two tenants, one slug', () => {
    it('CTI: tenant B creating "Widget" after tenant A yields a second row and leaves A intact', async () => {
      const widgets = await Issue2360WidgetCollection.create({ db });

      const a = await widgets.create({ name: 'Widget', tenantId: TENANT_A });
      const b = await widgets.create({ name: 'Widget', tenantId: TENANT_B });

      expect(a.slug).toBe('widget');
      expect(b.slug).toBe('widget');
      expect(b.id).not.toBe(a.id);

      const rows = (await db.list('issue_2360_widgets', {})) as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(2);
      const rowA = rows.find((row) => row.tenant_id === TENANT_A);
      const rowB = rows.find((row) => row.tenant_id === TENANT_B);
      expect(rowA?.id).toBe(a.id);
      expect(rowB?.id).toBe(b.id);
    });

    it('CTI: within one tenant the natural key still dedups (second create updates in place)', async () => {
      const widgets = await Issue2360WidgetCollection.create({ db });

      const first = await widgets.create({
        name: 'Widget',
        tenantId: TENANT_A,
      });
      const again = await widgets.create({
        name: 'Widget',
        tenantId: TENANT_A,
      });
      expect(again.slug).toBe(first.slug);

      const rows = (await db.list('issue_2360_widgets', {})) as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(TENANT_A);
    });

    it('CTI: NULL-tenant rows keep null-aware dedup among themselves and never collide with tenant rows', async () => {
      const widgets = await Issue2360WidgetCollection.create({ db });

      await widgets.create({ name: 'Widget', tenantId: TENANT_A });
      const g1 = await widgets.create({ name: 'Widget', tenantId: null });
      const g2 = await widgets.create({ name: 'Widget', tenantId: null });
      expect(g2.slug).toBe(g1.slug);

      const rows = (await db.list('issue_2360_widgets', {})) as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => row.tenant_id == null)).toHaveLength(1);
      expect(rows.filter((row) => row.tenant_id === TENANT_A)).toHaveLength(1);
    });

    it('CTI: an injected (undeclared) tenant field reaches the row as NULL, so the conflict target is complete', async () => {
      const notes = await Issue2360NoteCollection.create({ db });
      const note = await notes.create({ body: 'hello' });
      const rows = (await db.list('issue_2360_notes', {})) as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(note.id);
      expect(rows[0].tenant_id ?? null).toBeNull();
    });

    it('STI: root and child rows are per tenant, keyed on the root target', async () => {
      const things = await Issue2360ThingCollection.create({ db });
      const gadgets = await Issue2360GadgetCollection.create({ db });

      const thingA = await things.create({
        label: 'Rotor',
        slug: 'rotor',
        tenantId: TENANT_A,
      });
      const thingB = await things.create({
        label: 'Rotor',
        slug: 'rotor',
        tenantId: TENANT_B,
      });
      const gadgetA = await gadgets.create({
        label: 'Rotor',
        slug: 'rotor',
        power: 'high',
        tenantId: TENANT_A,
      });
      const gadgetB = await gadgets.create({
        label: 'Rotor',
        slug: 'rotor',
        power: 'low',
        tenantId: TENANT_B,
      });

      const ids = new Set([thingA.id, thingB.id, gadgetA.id, gadgetB.id]);
      expect(ids.size).toBe(4);
      const rows = (await db.list('issue_2360_things', {})) as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(4);
      // Same tenant + same slug + same subtype still dedups.
      await gadgets.create({
        label: 'Rotor',
        slug: 'rotor',
        power: 'medium',
        tenantId: TENANT_A,
      });
      expect(await db.list('issue_2360_things', {})).toHaveLength(4);
    });

    it('STI with custom conflictColumns on the root: root and child save on SQLite and dedup on the custom key per tenant', async () => {
      const tickets = await Issue2360TicketCollection.create({ db });
      const bugs = await Issue2360BugTicketCollection.create({ db });

      const t1 = await tickets.create({ code: 'T-1', tenantId: TENANT_A });
      const t1b = await tickets.create({ code: 'T-1', tenantId: TENANT_B });
      const b1 = await bugs.create({
        code: 'B-1',
        severity: 'high',
        tenantId: TENANT_A,
      });
      // Same tenant + same code → the custom key dedups, whatever the slug.
      await bugs.create({
        code: 'B-1',
        severity: 'low',
        tenantId: TENANT_A,
        slug: 'other-slug',
      });

      expect(t1.id).not.toBe(t1b.id);
      expect(b1.id).toBeDefined();
      const rows = (await db.list('issue_2360_tickets', {})) as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(3);
      const bug = rows.find((row) => row.code === 'B-1');
      expect(bug?.severity).toBe('low');
    });
  });
});
