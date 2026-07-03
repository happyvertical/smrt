/**
 * ETag v2 — per-table change-feed version source for zero-query 304s (#1765).
 *
 * Upgrades the generated read routes' ETag source from the v1 response-body
 * hash (#1757) to the change feed's per-table version (#1758), so a matching
 * `If-None-Match` short-circuits into a `304` BEFORE the collection query runs.
 *
 * This suite covers the two new primitives in isolation (the generator wiring
 * is exercised end-to-end in `conditional-get.spec.ts` and the REST/SvelteKit
 * generator suites):
 *
 * 1. `getTableVersion(db, table)` — MAX(seq) for a table, replica-stable (pure
 *    function of committed DB state, no per-process salt), advancing on any
 *    framework write (create/update/delete). Two correctness properties matter:
 *    - a write to table A must NOT advance table B's version when B has its own
 *      retained feed entry (no cross-table over-invalidation), and
 *    - a table whose own entries were all pruned falls back to the global
 *      horizon, NEVER to a resettable low value — otherwise a
 *      change→prune→change→prune cycle could issue a stale `304` (false-304).
 * 2. `computeTableVersionEtag` / `versionConditionalResponse` — a strong ETag
 *    keyed by (version, request representation) so different reads of one table
 *    (`?limit=10` vs `?limit=20`) never collide, and a query-skipping response
 *    builder that does NOT invoke the payload thunk on a `304`.
 *
 * All tests run against real in-memory SQLite (never mock the database).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTableVersion,
  pruneChangeFeed,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import { SmrtCollection } from '../collection';
import {
  canonicalReadRepresentation,
  computeTableVersionEtag,
  versionConditionalResponse,
} from '../generators/conditional-get';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

// ============================================================================
// Test classes (distinct tables so per-table isolation is observable)
// ============================================================================

@smrt()
class Etag1765Widget extends SmrtObject {
  name: string = '';
}

class Etag1765WidgetCollection extends SmrtCollection<Etag1765Widget> {
  static readonly _itemClass = Etag1765Widget;
}

@smrt()
class Etag1765Gadget extends SmrtObject {
  label: string = '';
}

class Etag1765GadgetCollection extends SmrtCollection<Etag1765Gadget> {
  static readonly _itemClass = Etag1765Gadget;
}

const TEST_CLASSES = ['Etag1765Widget', 'Etag1765Gadget'];

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

// ============================================================================
// getTableVersion (issue #1765)
// ============================================================================

describe('getTableVersion (#1765)', () => {
  let db: DatabaseInterface;
  let widgets: Etag1765WidgetCollection;
  let gadgets: Etag1765GadgetCollection;
  let widgetsTable: string;
  let gadgetsTable: string;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    db = await createDb();
    widgets = await Etag1765WidgetCollection.create({ db });
    gadgets = await Etag1765GadgetCollection.create({ db });
    widgetsTable = widgets.tableName;
    gadgetsTable = gadgets.tableName;
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('is 0 for a table with no changes on an empty feed', async () => {
    expect(await getTableVersion(db, widgetsTable)).toBe(0);
  });

  it('advances to the row seq after a create', async () => {
    const widget = await widgets.create({ name: 'a' });
    await widget.save();
    const version = await getTableVersion(db, widgetsTable);
    expect(version).toBeGreaterThan(0);
  });

  it('is a pure function of committed state: two calls with no writes are equal', async () => {
    const widget = await widgets.create({ name: 'a' });
    await widget.save();
    const first = await getTableVersion(db, widgetsTable);
    const second = await getTableVersion(db, widgetsTable);
    expect(second).toBe(first);
  });

  it('advances on an update and on a delete (tombstone is a write)', async () => {
    const widget = await widgets.create({ name: 'a' });
    await widget.save();
    const afterCreate = await getTableVersion(db, widgetsTable);

    widget.name = 'b';
    await widget.save();
    const afterUpdate = await getTableVersion(db, widgetsTable);
    expect(afterUpdate).toBeGreaterThan(afterCreate);

    await widget.delete();
    const afterDelete = await getTableVersion(db, widgetsTable);
    expect(afterDelete).toBeGreaterThan(afterUpdate);
  });

  it('does NOT advance a table that has its own retained entry when a SIBLING table is written (no cross-table over-invalidation)', async () => {
    // Gadget gets its own retained entry first.
    const gadget = await gadgets.create({ label: 'g' });
    await gadget.save();
    const gadgetVersion = await getTableVersion(db, gadgetsTable);

    // Writing widgets repeatedly must not move the gadget version: the gadget
    // has a retained feed entry of its own, so its MAX(seq) is stable.
    for (let i = 0; i < 3; i++) {
      const widget = await widgets.create({ name: `w${i}` });
      await widget.save();
    }
    expect(await getTableVersion(db, gadgetsTable)).toBe(gadgetVersion);
    // ...while the widget version tracked its own writes.
    expect(await getTableVersion(db, widgetsTable)).toBeGreaterThan(
      gadgetVersion,
    );
  });

  it('falls back to the global horizon (NOT 0) for a table whose only entry was pruned — false-304 prevention', async () => {
    // Widget writes first (seq 1), then gadgets advance the horizon.
    const widget = await widgets.create({ name: 'w' });
    await widget.save();
    for (let i = 0; i < 3; i++) {
      const gadget = await gadgets.create({ label: `g${i}` });
      await gadget.save();
    }

    // Prune to only the newest entry: the widget's entry is gone, but gadgets'
    // newest survives (pruning always retains the newest entry).
    await pruneChangeFeed(db, { maxRows: 1 });

    const horizon = await getTableVersion(db, gadgetsTable);
    const widgetVersion = await getTableVersion(db, widgetsTable);

    // The widget has NO retained entry, so its version must fall back to the
    // horizon, not reset to 0 (which would let a stale client false-304 across
    // a change→prune→change→prune cycle).
    expect(widgetVersion).toBe(horizon);
    expect(widgetVersion).toBeGreaterThan(0);
  });
});

// ============================================================================
// computeTableVersionEtag / canonicalReadRepresentation (issue #1765)
// ============================================================================

describe('computeTableVersionEtag (#1765)', () => {
  it('produces a strong quoted ETag (no W/ prefix)', () => {
    const etag = computeTableVersionEtag(7, '/api/v1/widgets?limit=10');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(etag.startsWith('W/')).toBe(false);
  });

  it('is deterministic and carries no per-process state (replica-stable)', () => {
    const a = computeTableVersionEtag(7, '/x');
    const b = computeTableVersionEtag(7, '/x');
    expect(a).toBe(b);
  });

  it('changes when the table version changes (a write bumps the ETag)', () => {
    expect(computeTableVersionEtag(7, '/x')).not.toBe(
      computeTableVersionEtag(8, '/x'),
    );
  });

  it('changes when the request representation changes (different reads never collide)', () => {
    // Same table version, different query representation → different ETag, so
    // ?limit=10 and ?limit=20 can never wrongly share a 304.
    expect(computeTableVersionEtag(7, '/api/v1/widgets?limit=10')).not.toBe(
      computeTableVersionEtag(7, '/api/v1/widgets?limit=20'),
    );
  });

  it('is injective across the version/representation boundary', () => {
    // A naive `${version}${representation}` concatenation would collide here;
    // the delimiter keeps (1, ":x") distinct from (1:, "x").
    expect(computeTableVersionEtag(1, ':x')).not.toBe(
      computeTableVersionEtag(1, 'x'),
    );
  });
});

describe('canonicalReadRepresentation (#1765)', () => {
  it('includes the path and is stable regardless of query-param order', () => {
    const a = canonicalReadRepresentation(
      new Request('http://local/api/v1/widgets?limit=10&offset=20'),
    );
    const b = canonicalReadRepresentation(
      new Request('http://local/api/v1/widgets?offset=20&limit=10'),
    );
    expect(a).toBe(b);
    expect(a).toContain('/api/v1/widgets');
    expect(a).toContain('limit=10');
    expect(a).toContain('offset=20');
  });

  it('distinguishes different paths and different param values', () => {
    const widgets = canonicalReadRepresentation(
      new Request('http://local/api/v1/widgets?limit=10'),
    );
    const gadgets = canonicalReadRepresentation(
      new Request('http://local/api/v1/gadgets?limit=10'),
    );
    const wider = canonicalReadRepresentation(
      new Request('http://local/api/v1/widgets?limit=20'),
    );
    expect(widgets).not.toBe(gadgets);
    expect(widgets).not.toBe(wider);
  });

  it('folds an extra discriminator (e.g. tenant scope) into the representation', () => {
    const base = canonicalReadRepresentation(
      new Request('http://local/api/v1/widgets'),
    );
    const tenantA = canonicalReadRepresentation(
      new Request('http://local/api/v1/widgets'),
      't:aaa',
    );
    const tenantB = canonicalReadRepresentation(
      new Request('http://local/api/v1/widgets'),
      't:bbb',
    );
    expect(tenantA).not.toBe(base);
    expect(tenantA).not.toBe(tenantB);
  });
});

// ============================================================================
// versionConditionalResponse — the query-skipping builder (issue #1765)
// ============================================================================

describe('versionConditionalResponse (#1765)', () => {
  const cacheControl = 'private, no-cache';

  it('returns 200 with the ETag, Cache-Control, and JSON body when no If-None-Match', async () => {
    const etag = computeTableVersionEtag(3, '/api/v1/widgets');
    const payload = { items: [{ id: '1' }], count: 1 };
    const build = vi.fn(async () => payload);

    const res = await versionConditionalResponse(
      new Request('http://local/api/v1/widgets'),
      etag,
      cacheControl,
      build,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('cache-control')).toBe(cacheControl);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual(payload);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('returns 304 with an EMPTY body AND NEVER runs the payload thunk when If-None-Match matches (the zero-query headline)', async () => {
    const etag = computeTableVersionEtag(3, '/api/v1/widgets');
    const build = vi.fn(async () => ({ items: [], count: 0 }));

    const res = await versionConditionalResponse(
      new Request('http://local/api/v1/widgets', {
        headers: { 'if-none-match': etag },
      }),
      etag,
      cacheControl,
      build,
    );

    expect(res.status).toBe(304);
    expect(await res.text()).toBe('');
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('cache-control')).toBe(cacheControl);
    // The whole point of ETag v2: the underlying query is never executed.
    expect(build).not.toHaveBeenCalled();
  });

  it('returns 200 (and runs the thunk) when If-None-Match carries a stale ETag', async () => {
    const currentEtag = computeTableVersionEtag(4, '/api/v1/widgets');
    const staleEtag = computeTableVersionEtag(3, '/api/v1/widgets');
    const build = vi.fn(async () => ({ items: [{ id: '1' }], count: 1 }));

    const res = await versionConditionalResponse(
      new Request('http://local/api/v1/widgets', {
        headers: { 'if-none-match': staleEtag },
      }),
      currentEtag,
      cacheControl,
      build,
    );

    expect(res.status).toBe(200);
    expect(build).toHaveBeenCalledTimes(1);
  });
});
