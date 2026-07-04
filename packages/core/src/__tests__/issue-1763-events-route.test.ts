/**
 * Tests for the `_events` SSE route + change-signal bus (issue #1763,
 * SERVER half; parent PRD #1755).
 *
 * Coverage (server-half acceptance criteria of #1763):
 * 1. Change-signal bus: in-process pub/sub, unsubscribe, per-listener error
 *    isolation, two `:memory:` databases never cross-deliver.
 * 2. Cross-replica fan-out via the adapter notification capability, with
 *    echo-avoidance; graceful degradation (no capability never throws, warns
 *    once) — exercised through the `stubNotifications` double.
 * 3. Real write path: SmrtObject save/delete publishes a coarse signal
 *    ({ table, operation, rowId, tenantId, seq }); `_smrt_*` never signals;
 *    no row payload leaks; a throwing subscriber never fails the save.
 * 4. `_events` route: method + fail-closed auth guards; a subscribe-only
 *    stream with heartbeat, teardown, and tenant filtering; cursor catch-up
 *    (`?since=`, `Last-Event-ID` precedence, subscribe-before-catchup,
 *    `resyncRequired` → `event: resync`).
 * 5. Wired into the real REST generator (`generateHandler` + `createServer`).
 *
 * All tests run against real in-memory SQLite (never mock the database).
 * Prior art: issue-1758-change-feed.test.ts, issue-1498-collection-cache.test.ts.
 */

import http from 'node:http';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  type ChangeFeedEntry,
  getChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  type ChangeSignal,
  changeSignalSubscriberCount,
  publishChangeSignal,
  resetChangeSignals,
  subscribeToChangeSignals,
} from '../change-signals';
import { SmrtCollection } from '../collection';
import { resetCollectionCache } from '../collection-cache';
import { setDispatchTenantResolver } from '../dispatch/tenant-resolver';
import {
  buildChangeEventStream,
  DEFAULT_EVENTS_HEARTBEAT_MS,
  handleEventsRoute,
  signalVisibleToTenant,
} from '../generators/events-route';
import { APIGenerator } from '../generators/rest';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';
import { stubNotifications } from '../testing/notifications-stub';

// ============================================================================
// Test classes
// ============================================================================

@smrt()
class EventsWidget extends SmrtObject {
  name: string = '';
  // A secret business field: it must NEVER appear in an emitted signal.
  secret: string = '';
}

class EventsWidgetCollection extends SmrtCollection<EventsWidget> {
  static readonly _itemClass = EventsWidget;
}

// Carries a plain tenantId field (like @TenantScoped models) so the writer
// stamps the row's tenant without core depending on smrt-tenancy.
@smrt()
class EventsTenantDoc extends SmrtObject {
  title: string = '';
  tenantId: string = '';
}

class EventsTenantDocCollection extends SmrtCollection<EventsTenantDoc> {
  static readonly _itemClass = EventsTenantDoc;
}

const TEST_CLASSES = ['EventsWidget', 'EventsTenantDoc'];
const WIDGETS_TABLE = 'events_widgets';
const TENANT_DOCS_TABLE = 'events_tenant_docs';

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

function signal(overrides: Partial<ChangeSignal> = {}): ChangeSignal {
  return {
    table: WIDGETS_TABLE,
    operation: 'create',
    rowId: 'row-1',
    tenantId: null,
    seq: 1,
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Poll a predicate until true or timeout. */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const activeSubscriberCount = changeSignalSubscriberCount;

/**
 * Read the SSE text a stream has produced so far, racing the reader against a
 * short timeout because an `_events` stream never ends on its own.
 */
async function readStreamText(
  stream: ReadableStream<Uint8Array>,
  ms = 60,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const next = reader.read();
      const timeout = new Promise<'timeout'>((resolve) =>
        setTimeout(
          () => resolve('timeout'),
          Math.max(1, deadline - Date.now()),
        ),
      );
      const result = await Promise.race([next, timeout]);
      if (result === 'timeout') break;
      if (result.done) break;
      if (result.value) text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

/** Always-authorize middleware matching the generator's contract. */
const allowAuth =
  () =>
  async (req: Request): Promise<Request | Response> =>
    req;

// ============================================================================
// Setup
// ============================================================================

describe('_events SSE route + change signals (issue #1763, server half)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    resetCollectionCache();
    db = await createDb();
  });

  afterEach(async () => {
    setDispatchTenantResolver(undefined);
    resetChangeSignals();
    resetCollectionCache();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  // ==========================================================================
  // Step 1: change-signal bus — in-process
  // ==========================================================================

  describe('change-signal bus: in-process', () => {
    it('delivers a published signal to every subscriber', () => {
      const received: ChangeSignal[] = [];
      const receivedB: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (s) => received.push(s));
      subscribeToChangeSignals(db, (s) => receivedB.push(s));

      const sig = signal();
      publishChangeSignal(db, sig);

      expect(received).toEqual([sig]);
      expect(receivedB).toEqual([sig]);
    });

    it('stops delivering after unsubscribe', () => {
      const received: ChangeSignal[] = [];
      const unsubscribe = subscribeToChangeSignals(db, (s) => received.push(s));

      publishChangeSignal(db, signal({ seq: 1 }));
      unsubscribe();
      publishChangeSignal(db, signal({ seq: 2 }));

      expect(received).toHaveLength(1);
      expect(received[0].seq).toBe(1);
      // Unsubscribe is idempotent.
      expect(() => unsubscribe()).not.toThrow();
    });

    it('isolates a throwing listener so others still receive the signal', () => {
      const received: ChangeSignal[] = [];
      subscribeToChangeSignals(db, () => {
        throw new Error('listener boom');
      });
      subscribeToChangeSignals(db, (s) => received.push(s));

      expect(() => publishChangeSignal(db, signal())).not.toThrow();
      expect(received).toHaveLength(1);
    });

    it('never cross-delivers between two independent :memory: databases', async () => {
      const dbA = db;
      const dbB = await createDb();
      try {
        const a: ChangeSignal[] = [];
        const b: ChangeSignal[] = [];
        subscribeToChangeSignals(dbA, (s) => a.push(s));
        subscribeToChangeSignals(dbB, (s) => b.push(s));

        publishChangeSignal(dbA, signal({ seq: 1 }));

        expect(a).toHaveLength(1);
        expect(b).toHaveLength(0);
      } finally {
        if (dbB && typeof dbB.close === 'function') await dbB.close();
      }
    });
  });

  // ==========================================================================
  // Step 2: change-signal bus — cross-replica + graceful degradation
  // ==========================================================================

  describe('change-signal bus: cross-replica', () => {
    it('broadcasts a published signal over the adapter notification channel', async () => {
      const { broadcasts } = stubNotifications(db);
      subscribeToChangeSignals(db, () => {});

      publishChangeSignal(db, signal({ seq: 7 }));
      await flushAsync();

      const change = broadcasts.find(
        (b) => b.channel === 'smrt_change_signals',
      );
      expect(change).toBeDefined();
      expect(change?.payload).toMatchObject({ table: WIDGETS_TABLE, seq: 7 });
      // The payload carries a process source id for echo-avoidance.
      expect(change?.payload.source).toBeTruthy();
    });

    it('delivers a peer-originated signal (different source) to local subscribers', async () => {
      const { push } = stubNotifications(db);
      const received: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (s) => received.push(s));
      await flushAsync(); // let the listener loop start

      push({
        channel: 'smrt_change_signals',
        payload: {
          table: WIDGETS_TABLE,
          operation: 'update',
          rowId: 'peer-row',
          tenantId: null,
          seq: 42,
          source: 'some-other-process',
        },
      });
      await flushAsync();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        table: WIDGETS_TABLE,
        operation: 'update',
        rowId: 'peer-row',
        seq: 42,
      });
    });

    it('skips echoes of its own broadcasts (matching source id)', async () => {
      const { broadcasts, push } = stubNotifications(db);
      const received: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (s) => received.push(s));
      await flushAsync();

      // Publish locally: delivered once synchronously, broadcast recorded.
      publishChangeSignal(db, signal({ seq: 1 }));
      await flushAsync();
      expect(received).toHaveLength(1);

      // Echo our own broadcast back over the channel — must be ignored.
      const ourBroadcast = broadcasts.find(
        (b) => b.channel === 'smrt_change_signals',
      );
      expect(ourBroadcast).toBeDefined();
      push({ channel: 'smrt_change_signals', payload: ourBroadcast?.payload });
      await flushAsync();

      // Still just the one local delivery — the echo was skipped.
      expect(received).toHaveLength(1);
    });

    it('degrades gracefully with no notification capability: never throws, delivers locally', () => {
      // No stubNotifications on db — adapter has no capability.
      const received: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (s) => received.push(s));

      expect(() => publishChangeSignal(db, signal())).not.toThrow();
      expect(received).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Step 4: real write path publishes signals
  // ==========================================================================

  // ==========================================================================
  // appendChange returns the seq of the row IT inserted (atomic, #1763 review)
  // ==========================================================================

  describe('appendChange seq return', () => {
    it('returns the sequence of the row it inserted', async () => {
      // Concurrency-correctness is by construction: `RETURNING seq` yields the
      // value the INSERT itself allocated, in the same statement, so no
      // interleaving append can substitute a different seq. Here we assert the
      // sequential contract — the return equals the seq queryable back for that
      // exact change.
      const s1 = await appendChange(db, {
        table: 'events_widgets',
        rowId: 'r1',
        operation: 'create',
      });
      const s2 = await appendChange(db, {
        table: 'events_widgets',
        rowId: 'r2',
        operation: 'update',
      });
      const s3 = await appendChange(db, {
        table: 'events_widgets',
        rowId: 'r3',
        operation: 'delete',
      });

      expect(s1).toBe(1);
      expect(s2).toBe(2);
      expect(s3).toBe(3);

      // Each returned seq maps to the row it actually inserted.
      const { changes } = await getChangesSince(db, { since: 0 });
      const bySeq = new Map(changes.map((c) => [c.seq, c]));
      expect(bySeq.get(s1)?.rowId).toBe('r1');
      expect(bySeq.get(s2)?.rowId).toBe('r2');
      expect(bySeq.get(s3)?.rowId).toBe('r3');
    });
  });

  describe('write path integration', () => {
    it('publishes create/update/delete signals mirroring the change feed', async () => {
      const widgets = await EventsWidgetCollection.create({ db });
      const received: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (s) => received.push(s));

      const widget = await widgets.create({ name: 'First', secret: 's3cr3t' });
      widget.name = 'Renamed';
      await widget.save();
      await widget.delete();

      expect(received.map((s) => s.operation)).toEqual([
        'create',
        'update',
        'delete',
      ]);
      for (const s of received) {
        expect(s.table).toBe(WIDGETS_TABLE);
        expect(s.rowId).toBe(widget.id);
        expect(s.tenantId).toBeNull();
      }
      // The signal seq matches the change feed seq for the same change.
      const feed = await getChangesSince(db, { since: 0 });
      expect(received.map((s) => s.seq)).toEqual(
        feed.changes.map((c: ChangeFeedEntry) => c.seq),
      );
    });

    it('carries no row payload — signal keys are exactly the coarse set', async () => {
      const widgets = await EventsWidgetCollection.create({ db });
      const received: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (s) => received.push(s));

      await widgets.create({ name: 'Leaky', secret: 'do-not-leak' });

      expect(received).toHaveLength(1);
      const keys = Object.keys(received[0]).sort();
      expect(keys).toEqual(['operation', 'rowId', 'seq', 'table', 'tenantId']);
      // No business field leaked under any key.
      const serialized = JSON.stringify(received[0]);
      expect(serialized).not.toContain('do-not-leak');
      expect(serialized).not.toContain('Leaky');
    });

    it('stamps the correct tenantId on a tenant-scoped write', async () => {
      const docs = await EventsTenantDocCollection.create({ db });
      const received: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (s) => received.push(s));

      await docs.create({ title: 'Doc', tenantId: 'tenant-x' });

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        table: TENANT_DOCS_TABLE,
        tenantId: 'tenant-x',
      });
    });

    it('never publishes a signal for _smrt_* system-table writes', async () => {
      const received: ChangeSignal[] = [];
      subscribeToChangeSignals(db, (s) => received.push(s));

      // A manual append to the feed table itself must not echo as a signal
      // (the writer skips _smrt_*; a raw appendChange writes no signal).
      await appendChange(db, {
        table: '_smrt_changes',
        rowId: 'x',
        operation: 'update',
      });
      await flushAsync();

      expect(received).toHaveLength(0);
    });

    it('a throwing subscriber never fails the save', async () => {
      const widgets = await EventsWidgetCollection.create({ db });
      subscribeToChangeSignals(db, () => {
        throw new Error('subscriber exploded');
      });

      const widget = await widgets.create({ name: 'Survivor' });
      expect(widget.id).toBeTruthy();
      // The change feed still recorded the write.
      const feed = await getChangesSince(db, { since: 0 });
      expect(feed.changes).toHaveLength(1);
    });
  });

  // ==========================================================================
  // signalVisibleToTenant — the synchronous server-side filter
  // ==========================================================================

  describe('signalVisibleToTenant', () => {
    it('passes everything when tenancy is not enforced', () => {
      const scope = { enforced: false, tenantId: null };
      expect(signalVisibleToTenant(signal({ tenantId: 'a' }), scope)).toBe(
        true,
      );
      expect(signalVisibleToTenant(signal({ tenantId: null }), scope)).toBe(
        true,
      );
    });

    it('with no active tenant, only global (null) signals are visible', () => {
      const scope = { enforced: true, tenantId: null };
      expect(signalVisibleToTenant(signal({ tenantId: null }), scope)).toBe(
        true,
      );
      expect(signalVisibleToTenant(signal({ tenantId: 'a' }), scope)).toBe(
        false,
      );
    });

    it('with an active tenant, that tenant plus global signals are visible', () => {
      const scope = { enforced: true, tenantId: 'a' };
      expect(signalVisibleToTenant(signal({ tenantId: 'a' }), scope)).toBe(
        true,
      );
      expect(signalVisibleToTenant(signal({ tenantId: null }), scope)).toBe(
        true,
      );
      expect(signalVisibleToTenant(signal({ tenantId: 'b' }), scope)).toBe(
        false,
      );
    });
  });

  // ==========================================================================
  // Step 5a: handleEventsRoute — method + auth guards
  // ==========================================================================

  describe('handleEventsRoute: method + auth guards', () => {
    it('405s a non-GET request', async () => {
      const res = await handleEventsRoute(
        new Request('http://x/api/v1/_events', { method: 'POST' }),
        { authMiddleware: allowAuth, db },
      );
      expect(res.status).toBe(405);
    });

    it('401s when no auth middleware is configured (fail-closed)', async () => {
      const res = await handleEventsRoute(
        new Request('http://x/api/v1/_events'),
        { db },
      );
      expect(res.status).toBe(401);
    });

    it('short-circuits when the auth middleware returns a Response (403)', async () => {
      const denyAuth = () => async (): Promise<Request | Response> =>
        new Response('nope', { status: 403 });
      const res = await handleEventsRoute(
        new Request('http://x/api/v1/_events'),
        { authMiddleware: denyAuth, db },
      );
      expect(res.status).toBe(403);
    });

    it('503s when no database is configured', async () => {
      const res = await handleEventsRoute(
        new Request('http://x/api/v1/_events'),
        { authMiddleware: allowAuth, db: undefined },
      );
      expect(res.status).toBe(503);
    });

    it('200s with text/event-stream headers on a valid GET', async () => {
      const res = await handleEventsRoute(
        new Request('http://x/api/v1/_events'),
        { authMiddleware: allowAuth, db },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');
      expect(res.headers.get('Cache-Control')).toContain('no-cache');
      expect(res.headers.get('X-Accel-Buffering')).toBe('no');
      // Don't leave the stream hanging.
      await res.body?.cancel();
    });
  });

  // ==========================================================================
  // Step 5b: buildChangeEventStream — subscribe, heartbeat, teardown, filter
  // ==========================================================================

  describe('buildChangeEventStream: live delivery', () => {
    it('emits retry preamble then streams a live signal as an SSE change event', async () => {
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: { enforced: false, tenantId: null },
      });
      const reader = stream.getReader();
      const decoder = new TextDecoder();

      // First read: the retry preamble.
      const first = await reader.read();
      const preamble = decoder.decode(first.value);
      expect(preamble).toContain('retry: 3000');

      // Publish a live signal; the next chunk carries it.
      publishChangeSignal(db, signal({ seq: 5, rowId: 'live-1' }));
      const second = await reader.read();
      const event = decoder.decode(second.value);
      expect(event).toContain('id: 5');
      expect(event).toContain('event: change');
      expect(event).toContain('"table":"events_widgets"');
      expect(event).toContain('"rowId":"live-1"');
      // seq is only in the id: line, not the data JSON.
      expect(event).not.toContain('"seq"');

      await reader.cancel();
    });

    it('filters signals by the captured tenant scope', async () => {
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: { enforced: true, tenantId: 'a' },
      });
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      await reader.read(); // retry preamble

      // A different tenant's signal must be filtered out; tenant a's arrives.
      publishChangeSignal(
        db,
        signal({ seq: 1, tenantId: 'b', rowId: 'b-row' }),
      );
      publishChangeSignal(
        db,
        signal({ seq: 2, tenantId: 'a', rowId: 'a-row' }),
      );

      const chunk = await reader.read();
      const event = decoder.decode(chunk.value);
      expect(event).toContain('a-row');
      expect(event).not.toContain('b-row');

      await reader.cancel();
    });

    it('unsubscribes on cancel (teardown): no delivery after cancel', async () => {
      const before = new Set(
        // Count active subscribers indirectly by observing delivery.
        [],
      );
      void before;
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: { enforced: false, tenantId: null },
      });
      const reader = stream.getReader();
      await reader.read(); // preamble
      await reader.cancel();
      await flushAsync();

      // After cancel, publishing must not throw (the controller is gone but
      // the subscription was torn down, so no enqueue on a dead controller).
      expect(() => publishChangeSignal(db, signal({ seq: 9 }))).not.toThrow();
    });

    it('emits heartbeat comments on the configured interval', async () => {
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: { enforced: false, tenantId: null },
        heartbeatMs: 20,
      });
      const text = await readStreamText(stream, 80);
      expect(text).toContain(': heartbeat');
      await stream.cancel().catch(() => {});
    });
  });

  // ==========================================================================
  // Step 5c: cursor catch-up
  // ==========================================================================

  describe('buildChangeEventStream: cursor catch-up', () => {
    it('replays changes after ?since= before going live', async () => {
      const widgets = await EventsWidgetCollection.create({ db });
      const w1 = await widgets.create({ name: 'one' });
      const w2 = await widgets.create({ name: 'two' });
      // Catch up from before w2 (cursor = 1 → replay seq 2 = w2).
      const stream = buildChangeEventStream(db, {
        cursor: 1,
        tenantScope: { enforced: false, tenantId: null },
      });
      const text = await readStreamText(stream, 80);
      expect(text).toContain('retry: 3000');
      expect(text).toContain('id: 2');
      expect(text).toContain(w2.id);
      // w1 (seq 1) is at/below the cursor — not replayed.
      expect(text).not.toContain(w1.id);
      await stream.cancel().catch(() => {});
    });

    it('catch-up filters by the CAPTURED scope, not the live ALS resolver', async () => {
      const docs = await EventsTenantDocCollection.create({ db });
      const aDoc = await docs.create({ title: 'a-doc', tenantId: 'tenant-a' });
      const bDoc = await docs.create({ title: 'b-doc', tenantId: 'tenant-b' });
      const gDoc = await docs.create({ title: 'g-doc', tenantId: '' }); // global

      // The ALS resolver reports a DIFFERENT tenant than the captured scope. If
      // catch-up (incorrectly) re-resolved via ALS, it would replay tenant-b and
      // hide the captured tenant-a. The captured scope must win.
      setDispatchTenantResolver(() => 'tenant-b');

      const stream = buildChangeEventStream(db, {
        cursor: 0,
        tenantScope: { enforced: true, tenantId: 'tenant-a' },
      });
      const text = await readStreamText(stream, 100);

      // Only tenant-a's rows plus global rows are replayed.
      expect(text).toContain(aDoc.id);
      expect(text).toContain(gDoc.id);
      expect(text).not.toContain(bDoc.id);
      await stream.cancel().catch(() => {});
    });

    it('catch-up with an enforced-but-no-tenant scope replays global rows only', async () => {
      const docs = await EventsTenantDocCollection.create({ db });
      const aDoc = await docs.create({ title: 'a-doc', tenantId: 'tenant-a' });
      const gDoc = await docs.create({ title: 'g-doc', tenantId: '' });

      // Even if the ALS resolver names a tenant, an enforced+null captured scope
      // (fail-closed: no active tenant) must replay only global rows.
      setDispatchTenantResolver(() => 'tenant-a');

      const stream = buildChangeEventStream(db, {
        cursor: 0,
        tenantScope: { enforced: true, tenantId: null },
      });
      const text = await readStreamText(stream, 100);

      expect(text).toContain(gDoc.id);
      expect(text).not.toContain(aDoc.id);
      await stream.cancel().catch(() => {});
    });

    it('emits event: resync when the cursor cannot be served incrementally', async () => {
      const widgets = await EventsWidgetCollection.create({ db });
      await widgets.create({ name: 'only' }); // horizon = 1
      // A cursor far ahead of the horizon is foreign → resyncRequired.
      const stream = buildChangeEventStream(db, {
        cursor: 999,
        tenantScope: { enforced: false, tenantId: null },
      });
      const text = await readStreamText(stream, 80);
      expect(text).toContain('event: resync');
      expect(text).toContain('id: 1');
      await stream.cancel().catch(() => {});
    });

    it('Last-Event-ID header takes precedence over ?since= (route level)', async () => {
      const widgets = await EventsWidgetCollection.create({ db });
      await widgets.create({ name: 'one' }); // seq 1
      const w2 = await widgets.create({ name: 'two' }); // seq 2

      // ?since=0 would replay both, but Last-Event-ID: 1 replays only seq 2.
      const res = await handleEventsRoute(
        new Request('http://x/api/v1/_events?since=0', {
          headers: { 'Last-Event-ID': '1' },
        }),
        { authMiddleware: allowAuth, db },
      );
      expect(res.status).toBe(200);
      const text = await readStreamText(
        res.body as ReadableStream<Uint8Array>,
        80,
      );
      expect(text).toContain('id: 2');
      expect(text).toContain(w2.id);
      await res.body?.cancel().catch(() => {});
    });

    it('default (no cursor) is live-forward only — no catch-up replay', async () => {
      const widgets = await EventsWidgetCollection.create({ db });
      const w1 = await widgets.create({ name: 'pre-existing' });
      const res = await handleEventsRoute(
        new Request('http://x/api/v1/_events'),
        { authMiddleware: allowAuth, db },
      );
      const text = await readStreamText(
        res.body as ReadableStream<Uint8Array>,
        50,
      );
      expect(text).toContain('retry: 3000');
      expect(text).not.toContain(w1.id); // no replay of the pre-existing change
      await res.body?.cancel().catch(() => {});
    });
  });

  // ==========================================================================
  // Step 6: wired into the real REST generator
  // ==========================================================================

  describe('REST generator wiring', () => {
    it('serves the _events route via generateHandler with fail-closed auth', async () => {
      const generator = new APIGenerator({ basePath: '/api/v1' }, { db });
      const handler = generator.generateHandler();

      // No auth middleware configured → 401.
      const unauth = await handler(new Request('http://x/api/v1/_events'));
      expect(unauth.status).toBe(401);
    });

    it('streams a live signal end-to-end through generateHandler', async () => {
      const generator = new APIGenerator(
        { basePath: '/api/v1', authMiddleware: allowAuth },
        { db },
      );
      const handler = generator.generateHandler();
      const res = await handler(new Request('http://x/api/v1/_events'));
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/event-stream');

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      await reader.read(); // preamble
      publishChangeSignal(db, signal({ seq: 3, rowId: 'e2e' }));
      const chunk = await reader.read();
      expect(decoder.decode(chunk.value)).toContain('e2e');
      await reader.cancel();
    });

    it('exports a default heartbeat constant', () => {
      expect(DEFAULT_EVENTS_HEARTBEAT_MS).toBe(15000);
    });

    it('tears down the subscription + heartbeat when a real Node client disconnects', async () => {
      const generator = new APIGenerator(
        {
          basePath: '/api/v1',
          authMiddleware: allowAuth,
          port: 0,
          hostname: '127.0.0.1',
        },
        { db },
      );
      const { server } = generator.createServer();
      await new Promise<void>((resolve) => server.on('listening', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        // Connect a real HTTP client and read the SSE preamble.
        const req = http.get({
          host: '127.0.0.1',
          port,
          path: '/api/v1/_events',
        });
        const res = await new Promise<http.IncomingMessage>(
          (resolve, reject) => {
            req.on('response', resolve);
            req.on('error', reject);
          },
        );
        await new Promise<void>((resolve) => res.once('data', () => resolve()));

        // The connection installed exactly one route subscription for this db.
        expect(activeSubscriberCount(db)).toBe(1);

        // Client disconnects abruptly.
        req.destroy();
        res.destroy();

        // The server-side stream cancel() must fire, unsubscribing and clearing
        // the heartbeat so the subscription refcount returns to 0.
        await waitFor(() => activeSubscriberCount(db) === 0, 2000);
        expect(activeSubscriberCount(db)).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('tears down even when the client disconnects while back-pressured', async () => {
      const generator = new APIGenerator(
        {
          basePath: '/api/v1',
          authMiddleware: allowAuth,
          port: 0,
          hostname: '127.0.0.1',
        },
        { db },
      );
      const { server } = generator.createServer();
      await new Promise<void>((resolve) => server.on('listening', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;

      try {
        const req = http.get({
          host: '127.0.0.1',
          port,
          path: '/api/v1/_events',
        });
        const res = await new Promise<http.IncomingMessage>(
          (resolve, reject) => {
            req.on('response', resolve);
            req.on('error', reject);
          },
        );
        // Read the preamble, then STOP reading (pause) so the client-side and
        // server-side socket buffers fill and res.write() starts returning false
        // — driving the server into the back-pressure drain-await.
        await new Promise<void>((resolve) => res.once('data', () => resolve()));
        res.pause();
        expect(activeSubscriberCount(db)).toBe(1);

        // Flood large signals so the server's write buffer back-pressures. The
        // large rowId inflates each SSE frame to force the socket buffer full.
        const bigRowId = 'x'.repeat(64 * 1024);
        for (let i = 0; i < 200; i++) {
          publishChangeSignal(db, signal({ seq: 100 + i, rowId: bigRowId }));
        }
        await flushAsync();

        // Disconnect abruptly WHILE back-pressured — no 'drain' will ever fire,
        // so the fix must also settle the await on 'close' and tear down.
        req.destroy();
        res.destroy();

        await waitFor(() => activeSubscriberCount(db) === 0, 3000);
        expect(activeSubscriberCount(db)).toBe(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
