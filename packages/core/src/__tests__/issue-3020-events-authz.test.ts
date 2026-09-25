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
import {
  type ChangeSignal,
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
      });
      const text = await readStreamText(stream);
      expect(text).not.toContain(NOTES_TABLE);
      expect(text).not.toContain(OTHER_ROW_ID);
      expect(text).toContain(OWN_ROW_ID);
      await stream.cancel().catch(() => {});
    });
  });
});
