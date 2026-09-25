/**
 * Consumer-supplied change-feed authorization seam (issue #3020) — REST
 * transport.
 *
 * The hooks in `change-feed-authz.ts` are process-global (`globalThis`), but
 * that alone does not make them effective: a route handler must actually
 * consult them. The REST generator's `_changes`/`_events` handlers
 * (`generators/changes-route.ts` `handleChangesRoute`,
 * `generators/events-route.ts` `handleEventsRoute`) are a SEPARATE code path
 * from the generated SvelteKit routes covered by
 * `issue-3020-change-feed-authz.test.ts` / `issue-3020-events-authz.test.ts`
 * — a consumer registering a hook and serving REST would otherwise still leak
 * every row through it (the exact #3020 bug, on a different transport).
 *
 * REST has no `locals`; a hook identifies the principal from `request` — the
 * `authMiddleware`-processed `Request` — which this file exercises via a
 * simple `x-principal` header the pass-through auth middleware preserves.
 *
 * Real in-memory SQLite throughout — never a mocked database.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { publishChangeSignal, resetChangeSignals } from '../change-signals';
import {
  type ChangesAuthMiddleware,
  handleChangesRoute,
} from '../generators/changes-route';
import { handleEventsRoute } from '../generators/events-route';
import { getTestDatabase } from '../testing/database';

const PUNCHES_TABLE = 'issue3020rest_punches';
const NOTES_TABLE = 'issue3020rest_notes';

const OWN_ROW_ID = 'punch-station-owns';
const OTHER_ROW_ID = 'punch-office-owns';

/** Pass-through auth middleware: keeps whatever the request already carries (e.g. the `x-principal` header) so a hook can read it from `request`. */
const passThroughAuth: ChangesAuthMiddleware =
  () =>
  async (req: Request): Promise<Request | Response> =>
    req;

function principalOf(request: Request | undefined): string | null {
  return request?.headers.get('x-principal') ?? null;
}

async function createDb(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [],
  });
  await ensureChangeFeedTable(db);
  return db;
}

/** Read the SSE text a stream has produced so far, with a short deadline. */
async function readStreamText(
  stream: ReadableStream<Uint8Array> | null,
  ms = 80,
): Promise<string> {
  if (!stream) return '';
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

async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
}

describe('change-feed authorization seam (issue #3020, REST transport)', () => {
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

  describe('REST _changes (handleChangesRoute)', () => {
    it("repro: office saves a row of a table the station cannot read; the station's REST _changes never sees it", async () => {
      setChangeFeedAuthorizer(({ request }) => {
        return principalOf(request) === 'office'
          ? [PUNCHES_TABLE, NOTES_TABLE]
          : [NOTES_TABLE];
      });

      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OTHER_ROW_ID,
        operation: 'create',
      });

      const stationResponse = await handleChangesRoute(
        new Request('http://localhost/api/v1/_changes?since=0', {
          headers: { 'x-principal': 'station' },
        }),
        { authMiddleware: passThroughAuth, db },
      );
      expect(stationResponse.status).toBe(200);
      const stationBody = await stationResponse.json();
      expect(stationBody.changes).toHaveLength(0);
      // Cursor still advances — the station is not stuck re-polling forever,
      // and nothing about the denied entry is inferable from a stall.
      expect(stationBody.cursor).toBeGreaterThan(0);

      const officeResponse = await handleChangesRoute(
        new Request('http://localhost/api/v1/_changes?since=0', {
          headers: { 'x-principal': 'office' },
        }),
        { authMiddleware: passThroughAuth, db },
      );
      const officeBody = await officeResponse.json();
      expect(officeBody.changes.map((c: { rowId: string }) => c.rowId)).toEqual(
        [OTHER_ROW_ID],
      );
    });

    it('row-level: a station only receives its own row over REST _changes', async () => {
      setChangeFeedAuthorizer(() => [PUNCHES_TABLE]);
      setChangeFeedEntryVisibility(({ request, entry }) => {
        if (principalOf(request) === 'office') return true;
        return entry.rowId === OWN_ROW_ID;
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

      const response = await handleChangesRoute(
        new Request('http://localhost/api/v1/_changes?since=0', {
          headers: { 'x-principal': 'station' },
        }),
        { authMiddleware: passThroughAuth, db },
      );
      const body = await response.json();
      expect(body.changes.map((c: { rowId: string }) => c.rowId)).toEqual([
        OWN_ROW_ID,
      ]);
    });

    it('fails closed (empty page, never the unfiltered feed) when the table hook throws', async () => {
      setChangeFeedAuthorizer(() => {
        throw new Error('boom');
      });
      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OTHER_ROW_ID,
        operation: 'create',
      });

      const response = await handleChangesRoute(
        new Request('http://localhost/api/v1/_changes?since=0', {
          headers: { 'x-principal': 'station' },
        }),
        { authMiddleware: passThroughAuth, db },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.changes).toHaveLength(0);
      expect(body.cursor).toBeGreaterThan(0);
    });

    it('default unchanged: with no hooks registered, REST _changes returns every table', async () => {
      await appendChange(db, { table: PUNCHES_TABLE, rowId: 'p1' });
      await appendChange(db, { table: NOTES_TABLE, rowId: 'n1' });

      const response = await handleChangesRoute(
        new Request('http://localhost/api/v1/_changes?since=0'),
        { authMiddleware: passThroughAuth, db },
      );
      const body = await response.json();
      expect(body.changes).toHaveLength(2);
    });
  });

  describe('REST _events (handleEventsRoute)', () => {
    it("repro: office's live signal for a table the station cannot read never reaches the station's REST _events stream", async () => {
      setChangeFeedAuthorizer(({ request }) => {
        return principalOf(request) === 'office'
          ? [PUNCHES_TABLE, NOTES_TABLE]
          : [NOTES_TABLE];
      });

      const stationConn = await handleEventsRoute(
        new Request('http://localhost/api/v1/_events', {
          headers: { 'x-principal': 'station' },
        }),
        { authMiddleware: passThroughAuth, db },
      );
      expect(stationConn.status).toBe(200);
      // A second, office-identified connection: if the hook is not actually
      // being told who is asking (the exact #3020 REST gap), it cannot tell
      // office from station and would deny office too — this connection
      // pins that office genuinely gets the wider table set.
      const officeConn = await handleEventsRoute(
        new Request('http://localhost/api/v1/_events', {
          headers: { 'x-principal': 'office' },
        }),
        { authMiddleware: passThroughAuth, db },
      );
      expect(officeConn.status).toBe(200);
      await flushAsync();

      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OTHER_ROW_ID,
        operation: 'create',
      });
      // A framework write appends durably (above) and publishes a live
      // signal alongside it; publish directly here to drive the route's live
      // (non-catch-up) path exactly as that write would.
      publishChangeSignal(db, {
        table: PUNCHES_TABLE,
        operation: 'create',
        rowId: OTHER_ROW_ID,
        tenantId: null,
        seq: 1,
      });
      publishChangeSignal(db, {
        table: NOTES_TABLE,
        operation: 'create',
        rowId: 'n1',
        tenantId: null,
        seq: 2,
      });
      await flushAsync();

      const stationText = await readStreamText(stationConn.body);
      expect(stationText).not.toContain(PUNCHES_TABLE);
      expect(stationText).toContain(NOTES_TABLE);

      const officeText = await readStreamText(officeConn.body);
      expect(officeText).toContain(PUNCHES_TABLE);
      expect(officeText).toContain(NOTES_TABLE);
    });

    it('fails closed (nothing delivered) when the table hook throws on REST _events', async () => {
      setChangeFeedAuthorizer(() => {
        throw new Error('boom');
      });

      const response = await handleEventsRoute(
        new Request('http://localhost/api/v1/_events', {
          headers: { 'x-principal': 'station' },
        }),
        { authMiddleware: passThroughAuth, db },
      );
      await flushAsync();
      publishChangeSignal(db, {
        table: PUNCHES_TABLE,
        operation: 'create',
        rowId: OTHER_ROW_ID,
        tenantId: null,
        seq: 1,
      });
      await flushAsync();

      const text = await readStreamText(response.body);
      expect(text).not.toContain('event: change');
    });

    it('default unchanged: with no hooks registered, REST _events delivers every signal', async () => {
      const response = await handleEventsRoute(
        new Request('http://localhost/api/v1/_events'),
        { authMiddleware: passThroughAuth, db },
      );
      await flushAsync();
      publishChangeSignal(db, {
        table: PUNCHES_TABLE,
        operation: 'create',
        rowId: OTHER_ROW_ID,
        tenantId: null,
        seq: 1,
      });
      await flushAsync();

      const text = await readStreamText(response.body);
      expect(text).toContain(OTHER_ROW_ID);
    });
  });
});
