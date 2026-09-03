/**
 * Tests for the change-feed spine (issue #1758).
 *
 * Test coverage (acceptance criteria of #1758):
 * 1. Every framework save/delete appends exactly one change entry; deletes
 *    are tombstones distinguishable from updates.
 * 2. Cursor monotonicity under interleaved writes — polling with returned
 *    cursors observes every committed change exactly once.
 * 3. Paging: a limited page resumes exactly where it stopped; an exhaustive
 *    page advances the cursor to the committed horizon.
 * 4. Tenant-scoped reads never return another tenant's changes (explicit
 *    tenantId filter and ambient tenant-context resolution).
 * 5. Retention pruning bounds the log (maxRows / maxAgeMs).
 * 6. Manual bump escape hatch for out-of-band writers.
 * 7. Feed-write failures never fail the user's write.
 * 8. Generated `_changes` REST route: fail-closed auth (401 without an auth
 *    middleware), parameter validation, tenant scoping.
 *
 * All tests run against real in-memory SQLite (never mock the database).
 * Prior art: issue-1498-collection-cache.test.ts, interceptors.test.ts.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  bumpChangeFeed,
  CHANGE_FEED_INTERCEPTOR_NAME,
  type ChangeFeedEntry,
  ensureChangeFeedTable,
  getChangesSince,
  getTenantScopedChangesSince,
  isChangeFeedObservableTable,
  pruneChangeFeed,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { SmrtCollection } from '../collection';
import { setDispatchTenantResolver } from '../dispatch/tenant-resolver';
import { APIGenerator } from '../generators/rest';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

// ============================================================================
// Test classes
// ============================================================================

@smrt()
class ChangeFeedWidget extends SmrtObject {
  name: string = '';
}

class ChangeFeedWidgetCollection extends SmrtCollection<ChangeFeedWidget> {
  static readonly _itemClass = ChangeFeedWidget;
}

@smrt()
class ChangeFeedGadget extends SmrtObject {
  label: string = '';
}

class ChangeFeedGadgetCollection extends SmrtCollection<ChangeFeedGadget> {
  static readonly _itemClass = ChangeFeedGadget;
}

// Carries a plain tenantId field (like @TenantScoped models do) so the feed
// writer stamps the row's tenant without core depending on smrt-tenancy.
@smrt()
class ChangeFeedTenantDoc extends SmrtObject {
  title: string = '';
  tenantId: string = '';
}

class ChangeFeedTenantDocCollection extends SmrtCollection<ChangeFeedTenantDoc> {
  static readonly _itemClass = ChangeFeedTenantDoc;
}

// A *domain* table that happens to carry the `_smrt_` prefix — the shape of
// ~25 real tables (feature flags, prompt overrides, subscription plans, field
// policies). The writer used to skip these by bare prefix, so clients syncing
// them through `_changes` never saw an update (issue #2376).
@smrt({ tableName: '_smrt_change_feed_domain_settings' })
class ChangeFeedDomainSetting extends SmrtObject {
  value: string = '';
}

class ChangeFeedDomainSettingCollection extends SmrtCollection<ChangeFeedDomainSetting> {
  static readonly _itemClass = ChangeFeedDomainSetting;
}

const TEST_CLASSES = [
  'ChangeFeedWidget',
  'ChangeFeedGadget',
  'ChangeFeedTenantDoc',
  'ChangeFeedDomainSetting',
];

const WIDGETS_TABLE = 'change_feed_widgets';
const GADGETS_TABLE = 'change_feed_gadgets';
const TENANT_DOCS_TABLE = 'change_feed_tenant_docs';
const DOMAIN_SETTINGS_TABLE = '_smrt_change_feed_domain_settings';

// ============================================================================
// Helpers
// ============================================================================

async function createDb(): Promise<DatabaseInterface> {
  return getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: TEST_CLASSES,
  });
}

async function allChanges(db: DatabaseInterface): Promise<ChangeFeedEntry[]> {
  const { changes } = await getChangesSince(db, { since: 0 });
  return changes;
}

// ============================================================================
// Tests
// ============================================================================

describe('change feed spine (issue #1758)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    // The writer registers during framework init; re-register defensively in
    // case another suite in this worker cleared GlobalInterceptors.
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    db = await createDb();
  });

  afterEach(async () => {
    setDispatchTenantResolver(undefined);
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('writer: exactly one entry per framework save/delete', () => {
    it('registers the writer interceptor at framework init', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      expect(widgets).toBeDefined();
      expect(
        GlobalInterceptors.getAll().some(
          (interceptor) => interceptor.name === CHANGE_FEED_INTERCEPTOR_NAME,
        ),
      ).toBe(true);
    });

    it('appends exactly one entry per save and delete, with tombstones distinguishable from updates', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });

      const widget = await widgets.create({ name: 'First' });
      let changes = await allChanges(db);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        table: WIDGETS_TABLE,
        rowId: widget.id,
        operation: 'create',
        tenantId: null,
      });
      expect(changes[0].seq).toBe(1);
      expect(changes[0].timestamp).toBeTruthy();

      widget.name = 'Renamed';
      await widget.save();
      changes = await allChanges(db);
      expect(changes).toHaveLength(2);
      expect(changes[1]).toMatchObject({
        table: WIDGETS_TABLE,
        rowId: widget.id,
        operation: 'update',
      });

      await widget.delete();
      changes = await allChanges(db);
      expect(changes).toHaveLength(3);
      // The tombstone: present after delete and distinguishable from updates.
      expect(changes[2]).toMatchObject({
        table: WIDGETS_TABLE,
        rowId: widget.id,
        operation: 'delete',
      });
      expect(changes[2].operation).not.toBe(changes[1].operation);

      // Exactly one row per mutation — no duplicates, strictly monotonic seq.
      expect(changes.map((change) => change.seq)).toEqual([1, 2, 3]);
    });

    it('records the physical table per class', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      const gadgets = await ChangeFeedGadgetCollection.create({ db });

      await widgets.create({ name: 'w' });
      await gadgets.create({ label: 'g' });

      const changes = await allChanges(db);
      expect(changes.map((change) => change.table)).toEqual([
        WIDGETS_TABLE,
        GADGETS_TABLE,
      ]);
    });

    it('records a revision-only claim as an observable update', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      const widget = await widgets.create({ name: 'claimed' });
      const expectedUpdatedAt = widget.updated_at;
      if (!expectedUpdatedAt) throw new Error('expected persisted revision');

      await widget.claimRevision(expectedUpdatedAt);

      const changes = await allChanges(db);
      expect(changes).toHaveLength(2);
      expect(changes[1]).toMatchObject({
        table: WIDGETS_TABLE,
        rowId: widget.id,
        operation: 'update',
      });
    });

    it('stamps the tenant id from the instance', async () => {
      const docs = await ChangeFeedTenantDocCollection.create({ db });
      const doc = await docs.create({ title: 'doc', tenantId: 'tenant-a' });
      expect(doc.tenantId).toBe('tenant-a');

      const changes = await allChanges(db);
      expect(changes).toHaveLength(1);
      expect(changes[0].tenantId).toBe('tenant-a');
    });

    it('observes `_smrt_`-prefixed domain tables (issue #2376)', async () => {
      const settings = await ChangeFeedDomainSettingCollection.create({ db });

      const setting = await settings.create({ value: 'on' });
      setting.value = 'off';
      await setting.save();
      await setting.delete();

      const changes = await allChanges(db);
      expect(changes.map((change) => change.table)).toEqual([
        DOMAIN_SETTINGS_TABLE,
        DOMAIN_SETTINGS_TABLE,
        DOMAIN_SETTINGS_TABLE,
      ]);
      expect(changes.map((change) => change.operation)).toEqual([
        'create',
        'update',
        'delete',
      ]);
    });

    it('records nothing for the framework tables a bootstrapped database carries (issue #2376)', async () => {
      // The allowlist is a closed list, so a table the framework starts
      // creating — or one a sibling change reclassifies — would silently
      // acquire feed rows and shift every count in this file. Pin the whole
      // recorded set against a real bootstrapped database so that failure
      // surfaces here, as a named assertion, instead of as an off-by-N
      // elsewhere. This is the shape the #2411 landing steward hit.
      const liveTables = await db.query(
        `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name LIKE '\\_smrt\\_%' ESCAPE '\\'
           ORDER BY name`,
      );
      const systemTables = (liveTables.rows as { name: string }[]).map(
        (row) => row.name,
      );
      // Sanity: the database really did bootstrap its framework tables.
      expect(systemTables).toContain('_smrt_changes');
      expect(systemTables).toContain('_smrt_contexts');

      // Every framework table present is unobservable; the only `_smrt_`
      // table this file expects the feed to record is the domain fixture.
      for (const table of systemTables) {
        if (table === DOMAIN_SETTINGS_TABLE) continue;
        expect(
          isChangeFeedObservableTable(table),
          `${table} is a framework table the change feed must not record`,
        ).toBe(false);
      }

      // A write through the framework produces exactly one row, for the
      // application table — no incidental framework rows alongside it.
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      await widgets.create({ name: 'only-entry' });

      const changes = await allChanges(db);
      expect(changes.map((change) => change.table)).toEqual([WIDGETS_TABLE]);
    });

    it('classifies framework-owned tables as unobservable and everything else as observable', () => {
      // The feed's own table and the hand-written bookkeeping DDL.
      expect(isChangeFeedObservableTable('_smrt_changes')).toBe(false);
      expect(isChangeFeedObservableTable('_smrt_contexts')).toBe(false);
      expect(isChangeFeedObservableTable('_smrt_dispatch')).toBe(false);
      expect(isChangeFeedObservableTable('_smrt_ai_usage')).toBe(false);
      // The jobs runner's own state (the claim loop writes several rows per
      // job per second — that churn is not client-syncable data).
      expect(isChangeFeedObservableTable('_smrt_jobs')).toBe(false);
      expect(isChangeFeedObservableTable('_smrt_job_events')).toBe(false);
      expect(isChangeFeedObservableTable('_smrt_workers')).toBe(false);
      // Retired tables that may still exist on older databases.
      expect(isChangeFeedObservableTable('_smrt_signals')).toBe(false);
      // Domain tables that merely carry the prefix.
      for (const table of [
        '_smrt_feature_overrides',
        '_smrt_prompt_overrides',
        '_smrt_subscription_plans',
        '_smrt_report_schedules',
        '_smrt_field_policies',
        '_smrt_language_overrides',
        '_smrt_agent_schedules',
      ]) {
        expect(isChangeFeedObservableTable(table)).toBe(true);
      }
      // Ordinary application tables and the empty-name guard.
      expect(isChangeFeedObservableTable('change_feed_widgets')).toBe(true);
      expect(isChangeFeedObservableTable('')).toBe(false);
    });

    it('a feed-write failure never fails the user write', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      await widgets.create({ name: 'before' });

      // Break the feed table out from under the writer.
      await db.query('DROP TABLE _smrt_changes');

      const widget = await widgets.create({ name: 'survives' });
      expect(widget.id).toBeTruthy();

      const reloaded = await widgets.get(widget.id as string);
      expect(reloaded?.name).toBe('survives');
    });
  });

  describe('cursor semantics', () => {
    it('polling with returned cursors observes every committed change exactly once under interleaved writers', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      const gadgets = await ChangeFeedGadgetCollection.create({ db });

      const observed: ChangeFeedEntry[] = [];
      let cursor = 0;

      const poll = async () => {
        const page = await getChangesSince(db, { since: cursor });
        expect(page.cursor).toBeGreaterThanOrEqual(cursor);
        observed.push(...page.changes);
        cursor = page.cursor;
      };

      // Interleave two writers with polls in between.
      const w1 = await widgets.create({ name: 'w1' });
      await poll();
      await gadgets.create({ label: 'g1' });
      w1.name = 'w1b';
      await w1.save();
      await poll();
      await gadgets.create({ label: 'g2' });
      await w1.delete();
      await poll();
      // Idle poll must not re-deliver or regress.
      const idleCursor = cursor;
      await poll();
      expect(cursor).toBe(idleCursor);

      const seqs = observed.map((change) => change.seq);
      // Strictly monotonic, no duplicates, no gaps missed.
      expect(seqs).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(observed.filter((c) => c.operation === 'delete')).toHaveLength(1);
    });

    it('sequences stay strictly monotonic under concurrent saves', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          widgets.create({ name: `concurrent-${index}` }),
        ),
      );

      const changes = await allChanges(db);
      expect(changes).toHaveLength(8);
      expect(changes.map((change) => change.seq)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ]);
    });

    it('limited pages resume exactly where they stopped; exhaustive pages advance to the horizon', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      for (let i = 0; i < 5; i++) {
        await widgets.create({ name: `w${i}` });
      }

      const first = await getChangesSince(db, { since: 0, limit: 2 });
      expect(first.changes.map((c) => c.seq)).toEqual([1, 2]);
      expect(first.cursor).toBe(2);

      const second = await getChangesSince(db, {
        since: first.cursor,
        limit: 2,
      });
      expect(second.changes.map((c) => c.seq)).toEqual([3, 4]);
      expect(second.cursor).toBe(4);

      const third = await getChangesSince(db, {
        since: second.cursor,
        limit: 2,
      });
      expect(third.changes.map((c) => c.seq)).toEqual([5]);
      // Exhaustive page → cursor is the committed horizon.
      expect(third.cursor).toBe(5);
    });

    it('table filters affect returned rows but never stall the cursor', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      const gadgets = await ChangeFeedGadgetCollection.create({ db });
      await widgets.create({ name: 'w1' });
      await gadgets.create({ label: 'g1' });
      await gadgets.create({ label: 'g2' });

      const page = await getChangesSince(db, {
        since: 0,
        tables: [WIDGETS_TABLE],
      });
      expect(page.changes.map((c) => c.table)).toEqual([WIDGETS_TABLE]);
      // Cursor advances past filtered-out rows to the horizon.
      expect(page.cursor).toBe(3);

      const next = await getChangesSince(db, {
        since: page.cursor,
        tables: [WIDGETS_TABLE],
      });
      expect(next.changes).toHaveLength(0);
      expect(next.cursor).toBe(3);
    });

    it('a caught-up cursor idles normally; a cursor beyond the horizon is flagged for resync', async () => {
      const empty = await getChangesSince(db, { since: 0 });
      expect(empty).toEqual({ changes: [], cursor: 0 });

      const widgets = await ChangeFeedWidgetCollection.create({ db });
      await widgets.create({ name: 'w' });

      const caughtUp = await getChangesSince(db, { since: 1 });
      expect(caughtUp).toEqual({ changes: [], cursor: 1 });

      // A foreign/reset cursor can never be served incrementally: cursor is
      // echoed unchanged (never regresses) and the resync flag is raised.
      const beyond = await getChangesSince(db, { since: 99 });
      expect(beyond).toEqual({
        changes: [],
        cursor: 99,
        resyncRequired: true,
        resyncCursor: 1,
      });
    });

    it('rejects invalid cursors', async () => {
      await expect(getChangesSince(db, { since: -1 })).rejects.toThrow(
        /non-negative/,
      );
      await expect(getChangesSince(db, { since: Number.NaN })).rejects.toThrow(
        /non-negative/,
      );
    });
  });

  describe('tenant isolation', () => {
    async function seedTenantRows(): Promise<void> {
      const docs = await ChangeFeedTenantDocCollection.create({ db });
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      await docs.create({ title: 'a1', tenantId: 'tenant-a' });
      await docs.create({ title: 'b1', tenantId: 'tenant-b' });
      await widgets.create({ name: 'global' }); // tenant_id NULL
    }

    it('explicit tenant filter returns that tenant plus global rows, never another tenant', async () => {
      await seedTenantRows();

      const tenantA = await getChangesSince(db, {
        since: 0,
        tenantId: 'tenant-a',
      });
      expect(tenantA.changes).toHaveLength(2);
      expect(
        tenantA.changes.every(
          (change) =>
            change.tenantId === 'tenant-a' || change.tenantId === null,
        ),
      ).toBe(true);
      expect(
        tenantA.changes.some((change) => change.tenantId === 'tenant-b'),
      ).toBe(false);
      // Filters never stall the cursor.
      expect(tenantA.cursor).toBe(3);

      const globalOnly = await getChangesSince(db, {
        since: 0,
        tenantId: null,
      });
      expect(globalOnly.changes).toHaveLength(1);
      expect(globalOnly.changes[0].tenantId).toBeNull();
    });

    it('getTenantScopedChangesSince follows the ambient tenant context (fail-closed without one)', async () => {
      await seedTenantRows();

      // Tenancy disabled (no resolver): unfiltered.
      setDispatchTenantResolver(undefined);
      const unfiltered = await getTenantScopedChangesSince(db, { since: 0 });
      expect(unfiltered.changes).toHaveLength(3);

      // Tenancy enabled with an active tenant: that tenant plus global rows.
      setDispatchTenantResolver(() => 'tenant-a');
      const scoped = await getTenantScopedChangesSince(db, { since: 0 });
      expect(scoped.changes).toHaveLength(2);
      expect(
        scoped.changes.some((change) => change.tenantId === 'tenant-b'),
      ).toBe(false);

      // Tenancy enabled with NO active tenant: fail closed to global rows.
      setDispatchTenantResolver(() => undefined);
      const failClosed = await getTenantScopedChangesSince(db, { since: 0 });
      expect(failClosed.changes).toHaveLength(1);
      expect(failClosed.changes[0].tenantId).toBeNull();
    });
  });

  describe('retention', () => {
    it('maxRows keeps only the newest entries', async () => {
      for (let i = 0; i < 10; i++) {
        await bumpChangeFeed(db, { table: 'products', rowId: `row-${i}` });
      }

      const { pruned } = await pruneChangeFeed(db, { maxRows: 3 });
      expect(pruned).toBe(7);

      // Reading from the retained-window edge serves the survivors.
      const { changes } = await getChangesSince(db, { since: 7 });
      expect(changes.map((change) => change.seq)).toEqual([8, 9, 10]);

      // Appends continue from the retained head — no seq reuse.
      await bumpChangeFeed(db, { table: 'products' });
      const after = await getChangesSince(db, { since: 10 });
      expect(after.changes.map((change) => change.seq)).toEqual([11]);
    });

    it('maxAgeMs prunes old entries but always retains the newest', async () => {
      await bumpChangeFeed(db, { table: 'products', rowId: 'old' });
      await bumpChangeFeed(db, { table: 'products', rowId: 'newest' });

      // Let the entries age past the cutoff (created_at < now - maxAgeMs is
      // a strict comparison at millisecond precision).
      await new Promise((resolve) => setTimeout(resolve, 15));

      // Both entries are older than the cutoff, but a non-empty feed is
      // never emptied: the newest entry survives so caught-up consumers
      // keep polling without a resync (see resync-detection tests).
      const { pruned } = await pruneChangeFeed(db, { maxAgeMs: 5 });
      expect(pruned).toBe(1);
      const survivors = await getChangesSince(db, { since: 1 });
      expect(survivors.changes.map((change) => change.rowId)).toEqual([
        'newest',
      ]);

      // A generous window prunes nothing.
      const second = await pruneChangeFeed(db, { maxAgeMs: 60_000 });
      expect(second.pruned).toBe(0);
    });

    it('never empties a non-empty feed (maxRows: 0 keeps the newest entry)', async () => {
      await bumpChangeFeed(db, { table: 'products', rowId: 'a' });
      await bumpChangeFeed(db, { table: 'products', rowId: 'b' });

      const { pruned } = await pruneChangeFeed(db, { maxRows: 0 });
      expect(pruned).toBe(1);

      const page = await getChangesSince(db, { since: 1 });
      expect(page.changes.map((change) => change.seq)).toEqual([2]);
      expect(page.resyncRequired).toBeUndefined();
    });

    it('requires at least one bound', async () => {
      await expect(pruneChangeFeed(db, {})).rejects.toThrow(
        /maxAgeMs and\/or maxRows/,
      );
    });
  });

  describe('resync detection (pruned/foreign cursors)', () => {
    it('an empty feed serves since=0 normally but flags any nonzero cursor', async () => {
      const fresh = await getChangesSince(db, { since: 0 });
      expect(fresh).toEqual({ changes: [], cursor: 0 });
      expect(fresh.resyncRequired).toBeUndefined();

      // No entries were ever recorded here — a nonzero cursor came from a
      // different database (or a reset feed) and cannot be served.
      const foreign = await getChangesSince(db, { since: 5 });
      expect(foreign).toEqual({
        changes: [],
        cursor: 5,
        resyncRequired: true,
        resyncCursor: 0,
      });
    });

    it('a cursor below the retained window is flagged; the window edge still serves', async () => {
      for (let i = 0; i < 10; i++) {
        await bumpChangeFeed(db, { table: 'products', rowId: `row-${i}` });
      }
      await pruneChangeFeed(db, { maxRows: 3 }); // retained run: [8..10]

      // since < floor-1: the changes in (since, floor) are gone for good —
      // empty page, cursor NOT advanced, resync demanded.
      const longGone = await getChangesSince(db, { since: 2 });
      expect(longGone.changes).toHaveLength(0);
      expect(longGone.cursor).toBe(2);
      expect(longGone.resyncRequired).toBe(true);
      expect(longGone.resyncCursor).toBe(10);

      const justBelow = await getChangesSince(db, { since: 6 });
      expect(justBelow.resyncRequired).toBe(true);
      expect(justBelow.resyncCursor).toBe(10);

      // since == floor-1: the next expected row is the floor itself —
      // incremental reads still work.
      const edge = await getChangesSince(db, { since: 7 });
      expect(edge.changes.map((change) => change.seq)).toEqual([8, 9, 10]);
      expect(edge.resyncRequired).toBeUndefined();
    });

    it('rows hidden by filters never trigger (or mask) a resync signal', async () => {
      const gadgets = await ChangeFeedGadgetCollection.create({ db });
      const docs = await ChangeFeedTenantDocCollection.create({ db });
      await gadgets.create({ label: 'g1' });
      await docs.create({ title: 'a1', tenantId: 'tenant-a' });

      // Table filter hides every row: normal empty page, cursor advances.
      const tableFiltered = await getChangesSince(db, {
        since: 0,
        tables: [WIDGETS_TABLE],
      });
      expect(tableFiltered.changes).toHaveLength(0);
      expect(tableFiltered.cursor).toBe(2);
      expect(tableFiltered.resyncRequired).toBeUndefined();

      // Tenant filter hides the tenant-a row: same story.
      const tenantFiltered = await getChangesSince(db, {
        since: 0,
        tenantId: null,
      });
      expect(
        tenantFiltered.changes.every((change) => change.tenantId === null),
      ).toBe(true);
      expect(tenantFiltered.cursor).toBe(2);
      expect(tenantFiltered.resyncRequired).toBeUndefined();
    });

    it('a caught-up consumer keeps polling normally after age-pruning wipes the backlog', async () => {
      await bumpChangeFeed(db, { table: 'products', rowId: 'a' });
      await bumpChangeFeed(db, { table: 'products', rowId: 'b' });
      const caughtUp = (await getChangesSince(db, { since: 0 })).cursor;
      expect(caughtUp).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 15));
      await pruneChangeFeed(db, { maxAgeMs: 5 }); // newest entry survives

      const idle = await getChangesSince(db, { since: caughtUp });
      expect(idle).toEqual({ changes: [], cursor: caughtUp });
      expect(idle.resyncRequired).toBeUndefined();
    });

    it('getTenantScopedChangesSince inherits resync detection', async () => {
      for (let i = 0; i < 5; i++) {
        await bumpChangeFeed(db, {
          table: 'products',
          rowId: `r${i}`,
          tenantId: 'tenant-a',
        });
      }
      await pruneChangeFeed(db, { maxRows: 1 }); // retained run: [5]

      setDispatchTenantResolver(() => 'tenant-a');
      const page = await getTenantScopedChangesSince(db, { since: 1 });
      expect(page.changes).toHaveLength(0);
      expect(page.cursor).toBe(1);
      expect(page.resyncRequired).toBe(true);
      expect(page.resyncCursor).toBe(5);
    });
  });

  describe('append allocation', () => {
    it('skips Postgres function DDL on raw handles when the helper exists', async () => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('to_regclass')) {
          return {
            rows: [
              {
                created_at_type: 'timestamp with time zone',
                drain_function_name: '_smrt_drain_changes',
                function_name: '_smrt_append_change',
                pending_table_name: '_smrt_changes_pending',
                table_name: '_smrt_changes',
              },
            ],
          };
        }
        if (sql.includes('to_regprocedure')) {
          return {
            rows: [{ function_name: '_smrt_append_change' }],
          };
        }
        return { rows: [] };
      });
      const rawDb = {
        url: 'postgresql://localhost/smrt',
        query,
      } as unknown as DatabaseInterface;

      await ensureChangeFeedTable(rawDb);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('to_regclass'),
      );
      expect(
        query.mock.calls.some(([sql]) =>
          /CREATE (?:TABLE|INDEX|OR REPLACE FUNCTION)/.test(sql),
        ),
      ).toBe(false);
    });

    it('installs the Postgres schema under the bootstrap lock when it is missing', async () => {
      const query = vi.fn(async () => ({ rows: [] }));
      const rawDb = {
        url: 'postgresql://localhost/smrt',
        query,
      } as unknown as DatabaseInterface;

      await ensureChangeFeedTable(rawDb);

      const install = query.mock.calls
        .map(([sql]) => sql)
        .find((sql) =>
          sql.includes('CREATE TABLE IF NOT EXISTS _smrt_changes'),
        );
      expect(install).toContain(
        'CREATE OR REPLACE FUNCTION _smrt_append_change',
      );
      expect(install?.indexOf('pg_advisory_xact_lock')).toBeLessThan(
        install?.indexOf('CREATE TABLE IF NOT EXISTS _smrt_changes') ?? -1,
      );
    });

    it('requires explicit provenance migration for a legacy Postgres change feed', async () => {
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('to_regclass')) {
          return {
            rows: [
              {
                created_at_type: 'timestamp without time zone',
                function_name: null,
                table_name: '_smrt_changes',
              },
            ],
          };
        }
        return { rows: [] };
      });
      const rawDb = {
        url: 'postgresql://localhost/smrt-legacy',
        query,
      } as unknown as DatabaseInterface;

      await expect(ensureChangeFeedTable(rawDb)).rejects.toThrow(
        'migratePostgresSystemTimestamps',
      );
      expect(
        query.mock.calls.some(([sql]) =>
          String(sql).includes('ALTER COLUMN created_at TYPE TIMESTAMPTZ'),
        ),
      ).toBe(false);
    });

    it('retries a unique SQLSTATE returned by the Postgres append function', async () => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              allocated_seq: null,
              error_code: '23505',
              error_message:
                'duplicate key value violates unique constraint "_smrt_changes_pkey"',
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              allocated_seq: 1,
              error_code: null,
              error_message: null,
            },
          ],
        });
      const postgresDb = {
        url: 'postgresql://ci.invalid/smrt',
        query,
      } as unknown as DatabaseInterface;

      await expect(
        appendChange(postgresDb, {
          table: 'products',
          rowId: 'product-1',
        }),
      ).resolves.toBe(1);
      expect(query).toHaveBeenCalledTimes(2);
    });

    it('turns a caught Postgres function SQLSTATE back into a safe append error', async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          {
            allocated_seq: null,
            error_code: '23514',
            error_message: 'forced change-feed check failure',
          },
        ],
      });
      const postgresDb = {
        url: 'postgresql://ci.invalid/smrt',
        query,
      } as unknown as DatabaseInterface;

      await expect(
        appendChange(postgresDb, {
          table: 'products',
          rowId: 'product-1',
        }),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'forced change-feed check failure',
      });
      expect(query).toHaveBeenCalledOnce();
      expect(query.mock.calls[0]?.[0]).toContain('_smrt_append_change');
    });
  });

  describe('manual bump escape hatch', () => {
    it('appends a synthetic change row for out-of-band writes', async () => {
      // Raw SQL bypasses the framework write path — invisible to the feed.
      await db.query(
        `CREATE TABLE IF NOT EXISTS raw_products (id TEXT PRIMARY KEY, name TEXT)`,
      );
      await db.query(
        `INSERT INTO raw_products (id, name) VALUES ('p1', 'raw')`,
      );
      expect(await allChanges(db)).toHaveLength(0);

      await bumpChangeFeed(db, { table: 'raw_products' });

      const changes = await allChanges(db);
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        table: 'raw_products',
        rowId: null, // table-level bump
        operation: 'update',
        tenantId: null,
      });

      await bumpChangeFeed(db, {
        table: 'raw_products',
        rowId: 'p1',
        operation: 'delete',
        tenantId: 'tenant-a',
      });
      const second = (await allChanges(db))[1];
      expect(second).toMatchObject({
        table: 'raw_products',
        rowId: 'p1',
        operation: 'delete',
        tenantId: 'tenant-a',
      });
    });

    it('validates input', async () => {
      await expect(appendChange(db, { table: '', rowId: 'x' })).rejects.toThrow(
        /non-empty table/,
      );
      await expect(
        appendChange(db, {
          table: 'products',
          operation: 'truncate' as never,
        }),
      ).rejects.toThrow(/create\/update\/delete/);
    });
  });

  describe('generated _changes REST route', () => {
    function createHandler(options: {
      withAuth?: 'pass' | 'reject';
      db?: unknown;
    }): (req: Request) => Promise<Response> {
      const generator = new APIGenerator(
        {
          basePath: '/api/v1',
          ...(options.withAuth
            ? {
                authMiddleware: (_objectName: string, _action: string) => {
                  return async (req: Request) =>
                    options.withAuth === 'pass'
                      ? req
                      : new Response(JSON.stringify({ error: 'Forbidden' }), {
                          status: 403,
                        });
                },
              }
            : {}),
        },
        { db: 'db' in options ? options.db : db },
      );
      return generator.generateHandler();
    }

    it('fails closed with 401 when no auth middleware is configured', async () => {
      const handler = createHandler({});
      const response = await handler(
        new Request('http://localhost/api/v1/_changes'),
      );
      expect(response.status).toBe(401);
    });

    it('returns the auth middleware response when auth rejects', async () => {
      const handler = createHandler({ withAuth: 'reject' });
      const response = await handler(
        new Request('http://localhost/api/v1/_changes'),
      );
      expect(response.status).toBe(403);
    });

    it('serves { changes, cursor } when authenticated', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      const widget = await widgets.create({ name: 'served' });

      const handler = createHandler({ withAuth: 'pass' });
      const response = await handler(
        new Request('http://localhost/api/v1/_changes?since=0'),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        changes: ChangeFeedEntry[];
        cursor: number;
      };
      expect(body.cursor).toBe(1);
      expect(body.changes).toHaveLength(1);
      expect(body.changes[0]).toMatchObject({
        table: WIDGETS_TABLE,
        rowId: widget.id,
        operation: 'create',
      });

      // Poll from the returned cursor.
      const idle = await handler(
        new Request(`http://localhost/api/v1/_changes?since=${body.cursor}`),
      );
      const idleBody = (await idle.json()) as { changes: unknown[] };
      expect(idleBody.changes).toHaveLength(0);
    });

    it('applies table filters and validates parameters', async () => {
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      const gadgets = await ChangeFeedGadgetCollection.create({ db });
      await widgets.create({ name: 'w' });
      await gadgets.create({ label: 'g' });

      const handler = createHandler({ withAuth: 'pass' });

      const filtered = await handler(
        new Request(`http://localhost/api/v1/_changes?tables=${GADGETS_TABLE}`),
      );
      const filteredBody = (await filtered.json()) as {
        changes: ChangeFeedEntry[];
        cursor: number;
      };
      expect(filteredBody.changes.map((c) => c.table)).toEqual([GADGETS_TABLE]);
      expect(filteredBody.cursor).toBe(2);

      const badSince = await handler(
        new Request('http://localhost/api/v1/_changes?since=-5'),
      );
      expect(badSince.status).toBe(400);

      const badLimit = await handler(
        new Request('http://localhost/api/v1/_changes?limit=0'),
      );
      expect(badLimit.status).toBe(400);

      const badMethod = await handler(
        new Request('http://localhost/api/v1/_changes', { method: 'POST' }),
      );
      expect(badMethod.status).toBe(405);
    });

    it('scopes the route by the ambient tenant context', async () => {
      const docs = await ChangeFeedTenantDocCollection.create({ db });
      await docs.create({ title: 'a', tenantId: 'tenant-a' });
      await docs.create({ title: 'b', tenantId: 'tenant-b' });

      const handler = createHandler({ withAuth: 'pass' });

      setDispatchTenantResolver(() => 'tenant-a');
      const response = await handler(
        new Request('http://localhost/api/v1/_changes'),
      );
      const body = (await response.json()) as { changes: ChangeFeedEntry[] };
      expect(body.changes).toHaveLength(1);
      expect(body.changes[0].tenantId).toBe('tenant-a');
    });

    it('returns 503 when the generator has no database', async () => {
      const handler = createHandler({ withAuth: 'pass', db: null });
      const response = await handler(
        new Request('http://localhost/api/v1/_changes'),
      );
      expect(response.status).toBe(503);
    });

    it('serves the feed via a registered collection when context.db is unset (registerCollection path)', async () => {
      // The documented `registerCollection()` wiring (see sync-apply.spec.ts)
      // never sets APIContext.db — the live handle lives on each registered
      // collection. Without a fallback the feed 503s here even though the
      // database is reachable; the generator must resolve db from the first
      // registered collection.
      const widgets = await ChangeFeedWidgetCollection.create({ db });
      const widget = await widgets.create({
        name: 'via-registered-collection',
      });

      const generator = new APIGenerator(
        {
          basePath: '/api/v1',
          // Passthrough auth so the fail-closed gate is not what we measure.
          authMiddleware: () => async (req: Request) => req,
        },
        // No context: APIContext.db is deliberately unset.
      );
      generator.registerCollection('changefeedwidgets', widgets);
      const handler = generator.generateHandler();

      const response = await handler(
        new Request('http://localhost/api/v1/_changes?since=0'),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        changes: ChangeFeedEntry[];
        cursor: number;
      };
      expect(body.changes).toHaveLength(1);
      expect(body.changes[0]).toMatchObject({
        table: WIDGETS_TABLE,
        rowId: widget.id,
        operation: 'create',
      });
    });

    it('surfaces resyncRequired to HTTP clients as protocol state (200, not an error)', async () => {
      const handler = createHandler({ withAuth: 'pass' });
      const response = await handler(
        new Request('http://localhost/api/v1/_changes?since=999'),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        changes: unknown[];
        cursor: number;
        resyncRequired?: boolean;
        resyncCursor?: number;
      };
      expect(body.resyncRequired).toBe(true);
      expect(body.changes).toHaveLength(0);
      expect(body.cursor).toBe(999);
      expect(body.resyncCursor).toBe(0);
    });
  });
});
