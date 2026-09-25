/**
 * Consumer-supplied change-feed authorization seam (issue #3020) — push side.
 *
 * Pins that `buildChangeEventStream` (the shared engine behind both the REST
 * and generated SvelteKit `_events` routes) applies the same
 * `authorizeChangeFeed` / `isChangeFeedEntryVisible` hooks as the pull-side
 * `_changes` route (see `issue-3020-change-feed-authz.test.ts`) to BOTH live
 * signal delivery and cursor catch-up replay — never a row payload, but a
 * denied signal must never reach the wire at all, table- or row-scoped.
 *
 * Repro (from the issue, push variant): an office principal saves a row of a
 * table a station principal may not read. Before this fix, a live `_events`
 * subscriber connected as the station received the signal regardless — the
 * only gates were "authenticated" and "same tenant". Real in-memory SQLite
 * throughout — never a mocked database. Prior art:
 * `issue-1763-events-route.test.ts`.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  ensureChangeFeedTable,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  setChangeFeedAuthorizer,
  setChangeFeedEntryVisibility,
} from '../change-feed-authz';
import {
  type ChangeSignal,
  changeSignalSubscriberCount,
  publishChangeSignal,
  resetChangeSignals,
} from '../change-signals';
import type { DispatchTenantScope } from '../dispatch/tenant-resolver';
import { buildChangeEventStream } from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

const PUNCHES_TABLE = 'issue3020_punches';
const NOTES_TABLE = 'issue3020_notes';

const stationLocals = { user: { id: 'station-1', role: 'station' } };
const officeLocals = { user: { id: 'office-1', role: 'office' } };
// SvelteKit's `event.request` always accompanies `locals` on a real route
// (see `vite-plugin/events-route.ts`'s `buildChangeEventStream` call);
// included here so these tests exercise the real hook context shape.
const stationRequest = new Request('http://localhost/api/_events');

const OWN_ROW_ID = 'punch-station-owns';
const OTHER_ROW_ID = 'punch-office-owns';

const UNENFORCED_SCOPE: DispatchTenantScope = {
  enforced: false,
  tenantId: null,
};

async function createDb(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [],
  });
  await ensureChangeFeedTable(db);
  return db;
}

function signal(overrides: Partial<ChangeSignal> = {}): ChangeSignal {
  return {
    table: PUNCHES_TABLE,
    operation: 'create',
    rowId: OTHER_ROW_ID,
    tenantId: null,
    seq: 1,
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

/** Read the SSE text a stream has produced so far, with a short deadline. */
async function readStreamText(
  stream: ReadableStream<Uint8Array>,
  ms = 80,
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

describe('change-feed authorization seam (issue #3020, push side)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    resetChangeSignals();
    db = await createDb();
  });

  afterEach(async () => {
    setChangeFeedAuthorizer(undefined);
    setChangeFeedEntryVisibility(undefined);
    resetChangeSignals();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  describe('default behavior (no hooks registered)', () => {
    it('delivers a live signal exactly as before', async () => {
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
      });
      await flushAsync();
      publishChangeSignal(db, signal());
      await flushAsync();
      const text = await readStreamText(stream);
      expect(text).toContain(`"rowId":"${OTHER_ROW_ID}"`);
      await stream.cancel().catch(() => {});
    });
  });

  describe('table-level authorization: live delivery', () => {
    it("repro: office's signal for a table the station cannot read never reaches the station's stream", async () => {
      setChangeFeedAuthorizer(({ locals }) => {
        const role = (locals as typeof officeLocals).user.role;
        return role === 'office' ? [PUNCHES_TABLE, NOTES_TABLE] : [NOTES_TABLE];
      });

      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
      });
      await flushAsync();
      publishChangeSignal(db, signal({ table: PUNCHES_TABLE, seq: 1 }));
      publishChangeSignal(
        db,
        signal({ table: NOTES_TABLE, rowId: 'n1', seq: 2 }),
      );
      await flushAsync();
      const text = await readStreamText(stream);
      expect(text).not.toContain(PUNCHES_TABLE);
      expect(text).toContain(NOTES_TABLE);
      await stream.cancel().catch(() => {});
    });

    it('fails closed (nothing delivered) when the table hook throws', async () => {
      setChangeFeedAuthorizer(() => {
        throw new Error('boom');
      });
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
      });
      await flushAsync();
      publishChangeSignal(db, signal());
      await flushAsync();
      const text = await readStreamText(stream);
      expect(text).not.toContain('event: change');
      await stream.cancel().catch(() => {});
    });
  });

  describe('row-level visibility: live delivery', () => {
    it('a station only receives signals for its own rows', async () => {
      setChangeFeedEntryVisibility(({ locals, entry }) => {
        const role = (locals as typeof stationLocals).user.role;
        if (role === 'office') return true;
        return entry.rowId === OWN_ROW_ID;
      });

      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
      });
      await flushAsync();
      publishChangeSignal(db, signal({ rowId: OTHER_ROW_ID, seq: 1 }));
      publishChangeSignal(db, signal({ rowId: OWN_ROW_ID, seq: 2 }));
      await flushAsync();
      const text = await readStreamText(stream);
      expect(text).not.toContain(OTHER_ROW_ID);
      expect(text).toContain(OWN_ROW_ID);
      await stream.cancel().catch(() => {});
    });

    it('fails closed (hidden) when the row visibility hook throws', async () => {
      setChangeFeedEntryVisibility(() => {
        throw new Error('boom');
      });
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
      });
      await flushAsync();
      publishChangeSignal(db, signal({ rowId: OWN_ROW_ID }));
      await flushAsync();
      const text = await readStreamText(stream);
      expect(text).not.toContain('event: change');
      await stream.cancel().catch(() => {});
    });
  });

  describe('catch-up replay applies the same authorization', () => {
    it('replays only tables/rows the hooks allow, and still resolves resync/cursor correctly', async () => {
      setChangeFeedAuthorizer(() => [PUNCHES_TABLE]);
      setChangeFeedEntryVisibility(({ entry }) => entry.rowId === OWN_ROW_ID);

      await appendChange(db, {
        table: NOTES_TABLE,
        rowId: 'n1',
        operation: 'create',
      });
      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OTHER_ROW_ID,
        operation: 'create',
      });
      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OWN_ROW_ID,
        operation: 'create',
      });

      const stream = buildChangeEventStream(db, {
        cursor: 0,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
      });
      const text = await readStreamText(stream);
      expect(text).not.toContain(NOTES_TABLE);
      expect(text).not.toContain(OTHER_ROW_ID);
      expect(text).toContain(OWN_ROW_ID);
      await stream.cancel().catch(() => {});
    });
  });

  describe('subscriber lifecycle during pending table authorization (#3020 P2)', () => {
    it('does not leave a subscription registered when the client disconnects while an async table authorizer is pending', async () => {
      let resolveAuthorization: (tables: string[]) => void = () => {};
      const pendingAuthorization = new Promise<string[]>((resolve) => {
        resolveAuthorization = resolve;
      });
      setChangeFeedAuthorizer(() => pendingAuthorization);

      expect(changeSignalSubscriberCount(db)).toBe(0);

      // Constructing the stream starts running its (async) start() callback,
      // which awaits the table authorizer before subscribing to anything.
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
      });

      // Let start() reach — and suspend on — the pending authorization await,
      // then disconnect while it is still pending. cancel() runs teardown()
      // before any subscription exists (unsubscribe is still null), so it
      // only releases the (no-op here) slot and marks the stream closed.
      await flushAsync();
      await stream.cancel().catch(() => {});
      expect(changeSignalSubscriberCount(db)).toBe(0);

      // Authorization now resolves. Before the fix, start() would subscribe
      // anyway despite the stream already being closed, permanently leaking
      // a change-signals listener that no later teardown() call could ever
      // remove (teardown() short-circuits once `closed` is true).
      resolveAuthorization([PUNCHES_TABLE]);
      await flushAsync();

      expect(changeSignalSubscriberCount(db)).toBe(0);
    });
  });

  describe('subscriber slot when the live-forward head query fails (#3020 follow-up)', () => {
    it('releases the reserved slot exactly once when the head-capture query rejects', async () => {
      setChangeFeedAuthorizer(() => [PUNCHES_TABLE]);
      // Every database call rejects, as during a transient outage.
      const failingDb = new Proxy(db, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function'
            ? () => Promise.reject(new Error('database unavailable'))
            : value;
        },
      }) as DatabaseInterface;
      const releaseSubscriberSlot = vi.fn();

      const stream = buildChangeEventStream(failingDb, {
        cursor: null,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
        releaseSubscriberSlot,
      });
      await expect(stream.getReader().read()).rejects.toThrow();
      await flushAsync();

      expect(releaseSubscriberSlot).toHaveBeenCalledTimes(1);
      expect(changeSignalSubscriberCount(db)).toBe(0);
    });
  });

  describe('gap-fill catch-up during pending table authorization (#3020 follow-up)', () => {
    it('a live-forward stream still delivers a change committed and signalled while the table authorizer is pending', async () => {
      let resolveAuthorization: (tables: string[]) => void = () => {};
      const pendingAuthorization = new Promise<string[]>((resolve) => {
        resolveAuthorization = resolve;
      });
      setChangeFeedAuthorizer(() => pendingAuthorization);

      // cursor: null → live-forward-only, no explicit catch-up requested.
      // Constructing the stream starts its (async) start(), which — with a
      // table hook registered — awaits the authorizer before subscribing.
      const stream = buildChangeEventStream(db, {
        cursor: null,
        tenantScope: UNENFORCED_SCOPE,
        locals: stationLocals,
        request: stationRequest,
      });

      // Let start() reach and suspend on the pending authorization await.
      // `unsubscribe` is still null here — no subscription exists yet.
      await flushAsync();
      expect(changeSignalSubscriberCount(db)).toBe(0);

      // A write commits (and, via appendChange's own publishChangeSignal
      // call, signals) while the authorizer is still pending. With no
      // subscription attached yet, that live signal has no listener to
      // reach — before the fix, this entry would be lost forever once the
      // stream finally subscribes, since live-forward mode runs no explicit
      // catch-up phase to recover it.
      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OTHER_ROW_ID,
        operation: 'create',
      });

      // Authorization now resolves, allowing the table.
      resolveAuthorization([PUNCHES_TABLE]);
      await flushAsync();

      const text = await readStreamText(stream);
      expect(text).toContain(`"rowId":"${OTHER_ROW_ID}"`);
      await stream.cancel().catch(() => {});
    });
  });
});
