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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  bumpChangeFeed,
  CHANGE_FEED_INTERCEPTOR_NAME,
  type ChangeFeedEntry,
  getChangesSince,
  getTenantScopedChangesSince,
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

const TEST_CLASSES = [
  'ChangeFeedWidget',
  'ChangeFeedGadget',
  'ChangeFeedTenantDoc',
];

const WIDGETS_TABLE = 'change_feed_widgets';
const GADGETS_TABLE = 'change_feed_gadgets';
const TENANT_DOCS_TABLE = 'change_feed_tenant_docs';

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

    it('stamps the tenant id from the instance', async () => {
      const docs = await ChangeFeedTenantDocCollection.create({ db });
      const doc = await docs.create({ title: 'doc', tenantId: 'tenant-a' });
      expect(doc.tenantId).toBe('tenant-a');

      const changes = await allChanges(db);
      expect(changes).toHaveLength(1);
      expect(changes[0].tenantId).toBe('tenant-a');
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
      expect(beyond).toEqual({ changes: [], cursor: 99, resyncRequired: true });
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
      expect(foreign).toEqual({ changes: [], cursor: 5, resyncRequired: true });
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

      const justBelow = await getChangesSince(db, { since: 6 });
      expect(justBelow.resyncRequired).toBe(true);

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
      };
      expect(body.resyncRequired).toBe(true);
      expect(body.changes).toHaveLength(0);
      expect(body.cursor).toBe(999);
    });
  });
});
