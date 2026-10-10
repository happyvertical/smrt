import { randomUUID } from 'node:crypto';
import {
  createWidgetRegistry,
  defineOverview,
  type OverviewDefinition,
  type WidgetRegistry,
} from '@happyvertical/smrt-svelte/overview/server';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOMIZE_OVERVIEW_PERMISSION,
  createOverviewStore,
  type OverviewStore,
  PERSONALIZE_OVERVIEW_PERMISSION,
  PreferenceAccessError,
  UiPreferenceRecordCollection,
} from '../index.js';

const BOTH = [CUSTOMIZE_OVERVIEW_PERMISSION, PERSONALIZE_OVERVIEW_PERMISSION];

export function buildRegistry(): WidgetRegistry {
  const registry = createWidgetRegistry();
  registry.register({
    type: 'note',
    title: 'Note',
    options: [{ key: 'title', type: 'text', label: 'Title', required: true }],
  });
  registry.register({
    type: 'count',
    title: 'Count',
    options: [{ key: 'model', type: 'model', label: 'Model', required: true }],
    load: (options, ctx) => ({ model: options.model, value: ctx.count }),
  });
  return registry;
}

export function buildDefinition(): OverviewDefinition {
  return defineOverview({
    id: 'events.home',
    allowed: ['note', 'count'],
    models: ['Event', 'Venue'],
    defaults: [
      { id: 'w1', type: 'note', span: 2, options: { title: 'Welcome' } },
      { id: 'w2', type: 'count', span: 1, options: { model: 'Event' } },
    ],
  });
}

/**
 * The persistence contract of `createOverviewStore`, run against every engine
 * the package supports (SQLite and DuckDB by default, PostgreSQL in the
 * optional lane).
 */
export function overviewStoreSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
): void {
  describe(name, () => {
    let db: DatabaseInterface;
    let store: OverviewStore;
    let registry: WidgetRegistry;
    let definition: OverviewDefinition;
    let tenantA: string;
    let tenantB: string;
    let alice: string;
    let bob: string;

    beforeEach(async () => {
      setupTestTenancy();
      db = await create();
      store = createOverviewStore({ db });
      registry = buildRegistry();
      definition = buildDefinition();
      tenantA = randomUUID();
      tenantB = randomUUID();
      alice = randomUUID();
      bob = randomUUID();
    });

    afterEach(async () => {
      resetTenancy();
      await cleanup();
    });

    const as = <T>(
      who: { tenantId: string; userId?: string; permissions?: string[] },
      fn: () => Promise<T>,
    ): Promise<T> =>
      withTenant(
        {
          tenantId: who.tenantId,
          userId: who.userId,
          permissions: new Set(who.permissions ?? BOTH),
        },
        fn,
      );

    const tenantOverride = {
      version: 1,
      changed: { w1: { options: { title: 'Team board' } } },
    };

    it('loads the page defaults when nothing is stored', async () => {
      const state = await as({ tenantId: tenantA, userId: alice }, () =>
        store.load(definition, registry),
      );
      expect(state.document.widgets.map((w) => w.id)).toEqual(['w1', 'w2']);
      expect(state.tenant.revision).toBeNull();
      expect(state.user?.revision).toBeNull();
      expect(state.issues).toEqual([]);
      expect(state.canCustomize).toEqual({ tenant: true, user: true });
    });

    it('merges page defaults < tenant default < user override', async () => {
      const saved = await as({ tenantId: tenantA, userId: alice }, async () => {
        const tenant = await store.save(definition, registry, {
          scope: 'tenant',
          override: tenantOverride,
          revision: null,
        });
        expect(tenant.ok).toBe(true);
        return store.save(definition, registry, {
          scope: 'user',
          override: {
            version: 1,
            changed: { w1: { span: 4 } },
            added: [
              { id: 'w3', type: 'count', span: 1, options: { model: 'Venue' } },
            ],
          },
          revision: null,
        });
      });
      expect(saved.ok).toBe(true);

      const mine = await as({ tenantId: tenantA, userId: alice }, () =>
        store.load(definition, registry),
      );
      expect(mine.tenant.document.widgets[0]).toMatchObject({
        id: 'w1',
        span: 2,
        options: { title: 'Team board' },
      });
      expect(mine.document.widgets.map((w) => [w.id, w.span])).toEqual([
        ['w1', 4],
        ['w2', 1],
        ['w3', 1],
      ]);
      // The user tier is a delta against the tenant default: the tenant's
      // title shows through the user's span change.
      expect(mine.document.widgets[0]?.options.title).toBe('Team board');
      expect(mine.user?.base.widgets[0]?.options.title).toBe('Team board');

      // A later tenant change still flows through untouched user fields.
      await as({ tenantId: tenantA, userId: bob }, async () => {
        const before = await store.load(definition, registry);
        const result = await store.save(definition, registry, {
          scope: 'tenant',
          override: {
            version: 1,
            changed: { w1: { options: { title: 'Renamed' } } },
          },
          revision: before.tenant.revision,
        });
        expect(result.ok).toBe(true);
      });
      const after = await as({ tenantId: tenantA, userId: alice }, () =>
        store.load(definition, registry),
      );
      expect(after.document.widgets[0]).toMatchObject({
        span: 4,
        options: { title: 'Renamed' },
      });

      // A user option change wins over the tenant default.
      await as({ tenantId: tenantA, userId: alice }, async () => {
        const result = await store.save(definition, registry, {
          scope: 'user',
          override: {
            version: 1,
            changed: { w1: { span: 4, options: { title: 'Mine' } } },
          },
          revision: after.user?.revision ?? null,
        });
        expect(result.ok).toBe(true);
      });
      const last = await as({ tenantId: tenantA, userId: alice }, () =>
        store.load(definition, registry),
      );
      expect(last.document.widgets[0]?.options.title).toBe('Mine');
    });

    it('stores only the canonical override', async () => {
      const result = await as({ tenantId: tenantA, userId: alice }, () =>
        store.save(definition, registry, {
          scope: 'user',
          override: {
            version: 1,
            // Natural order, an unchanged option and an explicit default:
            // none of it is a change.
            order: ['w1', 'w2'],
            changed: { w1: { span: 3, options: { title: 'Welcome' } } },
          },
          revision: null,
        }),
      );
      expect(result).toMatchObject({
        ok: true,
        override: { version: 1, changed: { w1: { span: 3 } } },
      });
      const rows = await as({ tenantId: tenantA }, async () =>
        (await UiPreferenceRecordCollection.create({ db })).list({}),
      );
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]?.payloadJson ?? 'null')).toEqual({
        version: 1,
        changed: { w1: { span: 3 } },
      });

      // A no-op override stores nothing (and removes an existing row).
      const noop = await as({ tenantId: tenantA, userId: alice }, () =>
        store.save(definition, registry, {
          scope: 'user',
          override: { version: 1, order: ['w1', 'w2'] },
          revision: result.ok ? result.revision : null,
        }),
      );
      expect(noop).toEqual({ ok: true, override: null, revision: null });
      const left = await as({ tenantId: tenantA }, async () =>
        (await UiPreferenceRecordCollection.create({ db })).list({}),
      );
      expect(left).toHaveLength(0);
    });

    it('refuses an invalid override on save and stores nothing', async () => {
      const cases: unknown[] = [
        { version: 2 },
        {
          version: 1,
          added: [{ id: 'w9', type: 'unknown', span: 1, options: {} }],
        },
        {
          version: 1,
          added: [
            { id: 'w9', type: 'count', span: 1, options: { model: 'Secret' } },
          ],
        },
        { version: 1, changed: { w1: { options: { title: 7 } } } },
        { version: 1, changed: { w1: { options: { title: 'x', extra: 1 } } } },
      ];
      for (const override of cases) {
        const result = await as({ tenantId: tenantA, userId: alice }, () =>
          store.save(definition, registry, {
            scope: 'tenant',
            override,
            revision: null,
          }),
        );
        expect(result.ok).toBe(false);
        expect(result).toMatchObject({ reason: 'invalid' });
      }
      const rows = await as({ tenantId: tenantA }, async () =>
        (await UiPreferenceRecordCollection.create({ db })).list({}),
      );
      expect(rows).toHaveLength(0);
    });

    it('drops and reports stored entries that no longer validate on load', async () => {
      await as({ tenantId: tenantA, userId: alice }, async () => {
        const records = await UiPreferenceRecordCollection.create({ db });
        // A row written before the widget type was removed or its schema
        // changed: the model only checks the envelope, the store validates.
        await records.create({
          tenantId: tenantA,
          kind: 'overview',
          surfaceId: definition.id,
          scopeType: 'user',
          userId: alice,
          payloadJson: JSON.stringify({
            version: 1,
            added: [
              { id: 'w5', type: 'retired', span: 1, options: {} },
              { id: 'w6', type: 'note', span: 1, options: { title: 'Kept' } },
            ],
            changed: { w2: { options: { model: 'NotAllowed' } } },
          }),
        });
      });
      const state = await as({ tenantId: tenantA, userId: alice }, () =>
        store.load(definition, registry),
      );
      expect(state.document.widgets.map((w) => w.id)).toEqual(['w1', 'w6']);
      expect(state.issues.map((issue) => [issue.widgetId, issue.code])).toEqual(
        [
          ['w2', 'invalid_options'],
          ['w5', 'unknown_type'],
        ],
      );
      expect(state.user?.issues).toHaveLength(2);
      expect(state.tenant.issues).toEqual([]);
    });

    it('requires overviews.customize for the tenant default', async () => {
      const member = {
        tenantId: tenantA,
        userId: alice,
        permissions: [PERSONALIZE_OVERVIEW_PERMISSION],
      };
      const state = await as(member, () => store.load(definition, registry));
      expect(state.canCustomize).toEqual({ tenant: false, user: true });
      const denied = await as(member, () =>
        store.save(definition, registry, {
          scope: 'tenant',
          override: tenantOverride,
          revision: null,
        }),
      );
      expect(denied).toEqual({ ok: false, reason: 'not_allowed' });
      const reset = await as(member, () =>
        store.reset(definition, { scope: 'tenant' }),
      );
      expect(reset).toEqual({ ok: false, reason: 'not_allowed' });

      // The model refuses the same write when the store is bypassed.
      await expect(
        as(member, async () => {
          const records = await UiPreferenceRecordCollection.create({ db });
          await records.create({
            tenantId: tenantA,
            kind: 'overview',
            surfaceId: definition.id,
            scopeType: 'tenant',
            payloadJson: JSON.stringify(tenantOverride),
          });
        }),
      ).rejects.toThrow();

      // A personal layout needs overviews.personalize and a user id.
      const viewer = { tenantId: tenantA, userId: alice, permissions: [] };
      expect(
        await as(viewer, () =>
          store.save(definition, registry, {
            scope: 'user',
            override: tenantOverride,
            revision: null,
          }),
        ),
      ).toEqual({ ok: false, reason: 'not_allowed' });
      const service = { tenantId: tenantA, permissions: BOTH };
      const serviceState = await as(service, () =>
        store.load(definition, registry),
      );
      expect(serviceState.user).toBeNull();
      // The users permission resolver needs a user principal for either tier.
      expect(serviceState.canCustomize).toEqual({ tenant: false, user: false });
      expect(
        await as(service, () =>
          store.save(definition, registry, {
            scope: 'user',
            override: tenantOverride,
            revision: null,
          }),
        ),
      ).toEqual({ ok: false, reason: 'not_allowed' });
    });

    it('keeps each user override to its owner', async () => {
      await as({ tenantId: tenantA, userId: alice }, () =>
        store.save(definition, registry, {
          scope: 'user',
          override: { version: 1, removed: ['w2'] },
          revision: null,
        }),
      );
      const bobs = await as({ tenantId: tenantA, userId: bob }, () =>
        store.load(definition, registry),
      );
      expect(bobs.document.widgets.map((w) => w.id)).toEqual(['w1', 'w2']);
      expect(bobs.user?.revision).toBeNull();

      // Bob's reset only ever addresses his own row.
      await as({ tenantId: tenantA, userId: bob }, () =>
        store.reset(definition, { scope: 'user' }),
      );
      const alices = await as({ tenantId: tenantA, userId: alice }, () =>
        store.load(definition, registry),
      );
      expect(alices.document.widgets.map((w) => w.id)).toEqual(['w1']);

      // Holding Alice's row (same tenant) does not let Bob change or delete it.
      const aliceRowId = await as({ tenantId: tenantA }, async () => {
        const rows = await (
          await UiPreferenceRecordCollection.create({ db })
        ).list({});
        return rows[0]?.id as string;
      });
      await expect(
        as({ tenantId: tenantA, userId: bob }, async () => {
          const records = await UiPreferenceRecordCollection.create({ db });
          const row = await records.get(aliceRowId);
          if (!row) throw new Error('expected the same-tenant row');
          row.setPayload({ version: 1 });
          await row.save();
        }),
      ).rejects.toBeInstanceOf(PreferenceAccessError);
      await expect(
        as({ tenantId: tenantA, userId: bob }, async () => {
          const records = await UiPreferenceRecordCollection.create({ db });
          const row = await records.get(aliceRowId);
          await row?.delete();
        }),
      ).rejects.toBeInstanceOf(PreferenceAccessError);
      // Rewriting the owner in memory does not make the row Bob's.
      for (const write of ['save', 'delete'] as const) {
        await expect(
          as({ tenantId: tenantA, userId: bob }, async () => {
            const records = await UiPreferenceRecordCollection.create({
              db,
            });
            const row = await records.get(aliceRowId);
            if (!row) throw new Error('expected the same-tenant row');
            row.userId = bob;
            await (write === 'save' ? row.save() : row.delete());
          }),
        ).rejects.toBeInstanceOf(PreferenceAccessError);
      }
      // Nor can Bob re-scope a row of his own onto Alice.
      await expect(
        as({ tenantId: tenantA, userId: bob }, async () => {
          const records = await UiPreferenceRecordCollection.create({ db });
          await records.create({
            tenantId: tenantA,
            kind: 'overview',
            surfaceId: definition.id,
            scopeType: 'user',
            userId: alice,
            payloadJson: JSON.stringify({ version: 1 }),
          });
        }),
      ).rejects.toThrow();
    });

    it('isolates tenants, including guessed row ids', async () => {
      await as({ tenantId: tenantA, userId: alice }, () =>
        store.save(definition, registry, {
          scope: 'tenant',
          override: tenantOverride,
          revision: null,
        }),
      );
      const rowId = await as({ tenantId: tenantA }, async () => {
        const rows = await (
          await UiPreferenceRecordCollection.create({ db })
        ).list({});
        return rows[0]?.id as string;
      });

      const other = await as({ tenantId: tenantB, userId: bob }, () =>
        store.load(definition, registry),
      );
      expect(other.document.widgets[0]?.options.title).toBe('Welcome');
      expect(other.tenant.revision).toBeNull();

      await as({ tenantId: tenantB, userId: bob }, async () => {
        const records = await UiPreferenceRecordCollection.create({ db });
        expect(await records.get(rowId)).toBeNull();
        expect(await records.list({})).toEqual([]);
        // Resetting in tenant B never touches tenant A's row.
        expect(await store.reset(definition, { scope: 'tenant' })).toEqual({
          ok: true,
        });
      });
      // Writing a row that names tenant A from tenant B is refused.
      await expect(
        as({ tenantId: tenantB, userId: bob }, async () => {
          const records = await UiPreferenceRecordCollection.create({ db });
          await records.create({
            tenantId: tenantA,
            kind: 'overview',
            surfaceId: definition.id,
            scopeType: 'tenant',
            payloadJson: JSON.stringify(tenantOverride),
          });
        }),
      ).rejects.toThrow();
      const still = await as({ tenantId: tenantA, userId: alice }, () =>
        store.load(definition, registry),
      );
      expect(still.tenant.document.widgets[0]?.options.title).toBe(
        'Team board',
      );
    });

    it('fails closed without a principal', async () => {
      await expect(store.load(definition, registry)).rejects.toBeInstanceOf(
        PreferenceAccessError,
      );
      await expect(
        store.save(definition, registry, {
          scope: 'tenant',
          override: tenantOverride,
          revision: null,
        }),
      ).rejects.toBeInstanceOf(PreferenceAccessError);
    });

    it('refuses a stale revision instead of overwriting', async () => {
      const who = { tenantId: tenantA, userId: alice };
      const first = await as(who, () =>
        store.save(definition, registry, {
          scope: 'tenant',
          override: tenantOverride,
          revision: null,
        }),
      );
      if (!first.ok) throw new Error('first save failed');
      // A second first-write (it loaded no row either) conflicts.
      expect(
        await as(who, () =>
          store.save(definition, registry, {
            scope: 'tenant',
            override: { version: 1, removed: ['w2'] },
            revision: null,
          }),
        ),
      ).toEqual({ ok: false, reason: 'conflict' });
      const second = await as(who, () =>
        store.save(definition, registry, {
          scope: 'tenant',
          override: { version: 1, removed: ['w2'] },
          revision: first.revision,
        }),
      );
      expect(second.ok).toBe(true);
      // The first writer's revision is now stale.
      expect(
        await as(who, () =>
          store.save(definition, registry, {
            scope: 'tenant',
            override: { version: 1, removed: ['w1'] },
            revision: first.revision,
          }),
        ),
      ).toEqual({ ok: false, reason: 'conflict' });
      expect(
        await as(who, () =>
          store.reset(definition, {
            scope: 'tenant',
            revision: first.revision,
          }),
        ),
      ).toEqual({ ok: false, reason: 'conflict' });
      const state = await as(who, () => store.load(definition, registry));
      expect(state.tenant.document.widgets.map((w) => w.id)).toEqual(['w1']);
      expect(state.tenant.revision).toBe(second.ok ? second.revision : null);
    });

    it('resets one tier back to the tier below', async () => {
      const who = { tenantId: tenantA, userId: alice };
      await as(who, async () => {
        await store.save(definition, registry, {
          scope: 'tenant',
          override: tenantOverride,
          revision: null,
        });
        await store.save(definition, registry, {
          scope: 'user',
          override: { version: 1, removed: ['w2'] },
          revision: null,
        });
      });
      const loaded = await as(who, () => store.load(definition, registry));
      expect(
        await as(who, () =>
          store.reset(definition, {
            scope: 'user',
            revision: loaded.user?.revision ?? null,
          }),
        ),
      ).toEqual({ ok: true });
      const afterUser = await as(who, () => store.load(definition, registry));
      expect(afterUser.document).toEqual(afterUser.tenant.document);
      expect(afterUser.document.widgets[0]?.options.title).toBe('Team board');

      expect(
        await as(who, () => store.reset(definition, { scope: 'tenant' })),
      ).toEqual({ ok: true });
      const afterTenant = await as(who, () => store.load(definition, registry));
      expect(afterTenant.document.widgets[0]?.options.title).toBe('Welcome');
      // Reset is idempotent.
      expect(
        await as(who, () => store.reset(definition, { scope: 'tenant' })),
      ).toEqual({ ok: true });
    });

    it('loads widget data server-side for the page', async () => {
      const who = { tenantId: tenantA, userId: alice };
      await as(who, () =>
        store.save(definition, registry, {
          scope: 'user',
          override: { version: 1, removed: ['w1'] },
          revision: null,
        }),
      );
      const page = await as(who, () =>
        store.loadPage(definition, registry, { count: 42 }),
      );
      expect(page.loaded.overviewId).toBe('events.home');
      expect(page.loaded.widgets).toEqual([
        expect.objectContaining({
          id: 'w2',
          status: 'ready',
          data: { model: 'Event', value: 42 },
        }),
      ]);
      const defaults = await as(who, () =>
        store.loadPage(definition, registry, { count: 1 }, { scope: 'tenant' }),
      );
      expect(defaults.loaded.widgets.map((w) => w.id)).toEqual(['w1', 'w2']);
    });

    it('loads one widget for the controller, gated like a save', async () => {
      const added = {
        id: 'w3',
        type: 'count',
        span: 1,
        options: { model: 'Venue' },
      };
      const customizer = { tenantId: tenantA, userId: alice };
      expect(
        await as(customizer, () =>
          store.loadWidget(definition, registry, added, { count: 3 }),
        ),
      ).toEqual({ ok: true, data: { model: 'Venue', value: 3 } });

      const viewer = { tenantId: tenantA, userId: bob, permissions: [] };
      // A viewer may reload a widget that is already on their overview...
      expect(
        await as(viewer, () =>
          store.loadWidget(
            definition,
            registry,
            { id: 'w2', type: 'count', span: 1, options: { model: 'Event' } },
            { count: 5 },
          ),
        ),
      ).toEqual({ ok: true, data: { model: 'Event', value: 5 } });
      // ...but not run a loader with options of their choosing.
      expect(
        await as(viewer, () =>
          store.loadWidget(definition, registry, added, { count: 3 }),
        ),
      ).toEqual({ ok: false, reason: 'not_allowed' });

      const invalid = await as(customizer, () =>
        store.loadWidget(
          definition,
          registry,
          { id: 'w3', type: 'count', span: 1, options: { model: 'Secret' } },
          {},
        ),
      );
      expect(invalid).toMatchObject({ ok: false, reason: 'invalid' });

      const failing = createWidgetRegistry();
      failing.register({
        type: 'count',
        title: 'Count',
        options: [
          { key: 'model', type: 'model', label: 'Model', required: true },
        ],
        load: () => {
          throw new Error('boom');
        },
      });
      expect(
        await as(customizer, () =>
          store.loadWidget(definition, failing, added, {}),
        ),
      ).toEqual({ ok: false, reason: 'load_failed', code: 'load_failed' });
    });
  });
}
