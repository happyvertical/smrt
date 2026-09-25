/**
 * Consumer-supplied change-feed authorization seam (issue #3020).
 *
 * The generated `/_changes` and `/_events` routes authorized on "some
 * authenticated principal" plus tenant scope only — no per-table permission
 * check, no per-principal row scope, and `?tables=` was a client-chosen
 * filter, never enforcement. This file pins the pull-side (`_changes`) fix:
 * `getAuthorizedTenantScopedChangesSince()` / `getAuthorizedChangesSince()`
 * (`change-feed-authz.ts`), which the generated `_changes` route now calls in
 * place of the unauthorized `getTenantScopedChangesSince()`.
 *
 * The `_events` (push) half is pinned separately in
 * `issue-3020-events-authz.test.ts`, against `buildChangeEventStream`.
 *
 * Repro (from the issue): an office principal and a lower-privileged station
 * principal share a tenant. The office saves a row of a table the station may
 * not read. Before this fix, `GET _changes?since=0` as the station returned
 * the entry regardless — the only gates were "authenticated" and "same
 * tenant". Real in-memory SQLite throughout — never a mocked database.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendChange,
  ensureChangeFeedTable,
  getTenantScopedChangesSince,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  type ChangeFeedTableAuthorizationRequest,
  type ChangeFeedVisibilityEntry,
  filterVisibleChangeFeedEntries,
  getAuthorizedChangesSince,
  getAuthorizedTenantScopedChangesSince,
  isChangeFeedEntryVisible,
  resolveAuthorizedChangeFeedTables,
  setChangeFeedAuthorizer,
  setChangeFeedEntryVisibility,
} from '../change-feed-authz';
import { getTestDatabase } from '../testing/database';

const PUNCHES_TABLE = 'issue3020_punches';
const NOTES_TABLE = 'issue3020_notes';

/** A station principal that only owns `OWN_ROW_ID` of `PUNCHES_TABLE`. */
const stationLocals = { user: { id: 'station-1', role: 'station' } };
/** The office principal: no restriction under any of this file's hooks. */
const officeLocals = { user: { id: 'office-1', role: 'office' } };
// SvelteKit's `event.request` always accompanies `locals` on a real route
// (see `vite-plugin/changes-route.ts`'s `getAuthorizedTenantScopedChangesSince`
// call); included here so these tests exercise the real hook context shape.
const stationRequest = new Request('http://localhost/api/_changes');
const officeRequest = new Request('http://localhost/api/_changes');

const OWN_ROW_ID = 'punch-station-owns';
const OTHER_ROW_ID = 'punch-office-owns';

async function createDb(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [],
  });
  await ensureChangeFeedTable(db);
  return db;
}

describe('change-feed authorization seam (issue #3020, pull side)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    registerChangeFeedWriter();
    resetChangeFeedWarnings();
    db = await createDb();
  });

  afterEach(async () => {
    setChangeFeedAuthorizer(undefined);
    setChangeFeedEntryVisibility(undefined);
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  // ==========================================================================
  // Default behavior is unchanged when no hooks are registered
  // ==========================================================================

  describe('default behavior (no hooks registered)', () => {
    it('returns exactly what getTenantScopedChangesSince returns', async () => {
      await appendChange(db, { table: PUNCHES_TABLE, rowId: 'p1' });
      await appendChange(db, { table: NOTES_TABLE, rowId: 'n1' });

      const baseline = await getTenantScopedChangesSince(db, { since: 0 });
      const authorized = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });

      expect(authorized).toEqual(baseline);
      expect(authorized.changes).toHaveLength(2);
    });

    it('an empty requested tables: [] behaves exactly like an omitted filter (Copilot #3020 follow-up)', async () => {
      // Documented as equivalent to an omitted `tables` filter. Without a
      // hook registered, `resolveAuthorizedChangeFeedTables` used to return
      // `[]` unchanged, and `isChangeFeedDenyAll([])` then turned that into
      // deny-all — silently breaking the promised unchanged default for a
      // client that happens to send `tables=` with nothing in it.
      await appendChange(db, { table: PUNCHES_TABLE, rowId: 'p1' });
      await appendChange(db, { table: NOTES_TABLE, rowId: 'n1' });

      const omitted = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });
      const emptyArray = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        tables: [],
        locals: stationLocals,
        request: stationRequest,
      });

      expect(emptyArray).toEqual(omitted);
      expect(emptyArray.changes).toHaveLength(2);
    });

    it('resolveAuthorizedChangeFeedTables passes requested tables through unchanged, and normalizes an empty array to undefined', async () => {
      const ctx = { locals: stationLocals, request: stationRequest };
      await expect(
        resolveAuthorizedChangeFeedTables(ctx, undefined),
      ).resolves.toBeUndefined();
      await expect(
        resolveAuthorizedChangeFeedTables(ctx, [PUNCHES_TABLE]),
      ).resolves.toEqual([PUNCHES_TABLE]);
      await expect(
        resolveAuthorizedChangeFeedTables(ctx, []),
      ).resolves.toBeUndefined();
    });

    it('isChangeFeedEntryVisible / filterVisibleChangeFeedEntries are no-ops', async () => {
      const ctx = { locals: stationLocals, request: stationRequest };
      const entry: ChangeFeedVisibilityEntry = {
        table: PUNCHES_TABLE,
        rowId: OTHER_ROW_ID,
        operation: 'create',
        tenantId: null,
        seq: 1,
      };
      await expect(isChangeFeedEntryVisible(ctx, entry)).resolves.toBe(true);
      const entries = [entry];
      await expect(filterVisibleChangeFeedEntries(ctx, entries)).resolves.toBe(
        entries,
      );
    });
  });

  // ==========================================================================
  // Table-level authorization (the issue's repro)
  // ==========================================================================

  describe('table-level authorization', () => {
    it('repro: office saves a row of a table the station cannot read; station never sees it', async () => {
      setChangeFeedAuthorizer(
        ({ locals }: ChangeFeedTableAuthorizationRequest) => {
          const role = (locals as typeof officeLocals).user.role;
          return role === 'office'
            ? [PUNCHES_TABLE, NOTES_TABLE]
            : [NOTES_TABLE];
        },
      );

      // Office saves a punch — the table the station may not read.
      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OTHER_ROW_ID,
        operation: 'create',
      });

      const stationPage = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(stationPage.changes).toHaveLength(0);
      // The cursor still advances past the denied entry — the station is not
      // stuck re-polling `since: 0` forever, and nothing about the denied
      // entry (its row id or timing) is inferable from where it stops.
      expect(stationPage.cursor).toBeGreaterThan(0);
      expect(stationPage.resyncRequired).toBeUndefined();

      // Polling again from the advanced cursor sees nothing new (idempotent).
      const stationNext = await getAuthorizedTenantScopedChangesSince(db, {
        since: stationPage.cursor,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(stationNext.changes).toHaveLength(0);
      expect(stationNext.cursor).toBe(stationPage.cursor);

      // The office, reading the same feed, sees the row.
      const officePage = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: officeLocals,
        request: officeRequest,
      });
      expect(officePage.changes.map((c) => c.rowId)).toEqual([OTHER_ROW_ID]);
    });

    it('intersects the hook allow-list with the client ?tables= filter (never widens it)', async () => {
      // Hook allows only notes; the client asks for BOTH — a client filter
      // alone (the pre-#3020 behavior) would return both tables, so this
      // pins that the hook is the one doing the narrowing, not the client.
      setChangeFeedAuthorizer(() => [NOTES_TABLE]);
      await appendChange(db, { table: PUNCHES_TABLE, rowId: 'p1' });
      await appendChange(db, { table: NOTES_TABLE, rowId: 'n1' });

      const page = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        tables: [PUNCHES_TABLE, NOTES_TABLE],
        locals: stationLocals,
        request: stationRequest,
      });
      expect(page.changes.map((c) => c.table)).toEqual([NOTES_TABLE]);
    });

    it('a table the hook does not name is never returned even if the client asks for it', async () => {
      // Hook allows only notes; client asks for punches (which it may not
      // legitimately know exists) — the answer must not include it.
      setChangeFeedAuthorizer(() => [NOTES_TABLE]);
      await appendChange(db, { table: PUNCHES_TABLE, rowId: 'p1' });

      const page = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        tables: [PUNCHES_TABLE],
        locals: stationLocals,
        request: stationRequest,
      });
      expect(page.changes).toHaveLength(0);
      expect(page.cursor).toBeGreaterThan(0);
    });

    it('fails closed to no tables when the hook throws', async () => {
      setChangeFeedAuthorizer(() => {
        throw new Error('boom');
      });
      await appendChange(db, { table: PUNCHES_TABLE, rowId: 'p1' });

      const page = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(page.changes).toHaveLength(0);
      expect(page.cursor).toBeGreaterThan(0);
      expect(page.resyncRequired).toBeUndefined();
    });

    it('fails closed to no tables when the hook returns a non-array', async () => {
      // @ts-expect-error intentionally malformed to exercise the fail-closed path
      setChangeFeedAuthorizer(() => 'not-an-array');
      await appendChange(db, { table: PUNCHES_TABLE, rowId: 'p1' });

      const page = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(page.changes).toHaveLength(0);
      expect(page.cursor).toBeGreaterThan(0);
    });

    it('never falls back to the unfiltered feed on a denied read (getAuthorizedChangesSince, the non-tenant-scoped variant)', async () => {
      setChangeFeedAuthorizer(() => []);
      await appendChange(db, { table: PUNCHES_TABLE, rowId: 'p1' });

      const page = await getAuthorizedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(page.changes).toHaveLength(0);
      expect(page.cursor).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Row-level visibility
  // ==========================================================================

  describe('row-level visibility', () => {
    beforeEach(() => {
      // Table-level: both principals may read punches at all.
      setChangeFeedAuthorizer(() => [PUNCHES_TABLE]);
    });

    it('a station sees only its own row of a table it is otherwise allowed to read', async () => {
      setChangeFeedEntryVisibility(({ locals, entry }) => {
        const role = (locals as typeof stationLocals).user.role;
        if (role === 'office') return true;
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

      const stationPage = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(stationPage.changes.map((c) => c.rowId)).toEqual([OWN_ROW_ID]);

      const officePage = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: officeLocals,
        request: officeRequest,
      });
      expect(officePage.changes.map((c) => c.rowId).sort()).toEqual(
        [OTHER_ROW_ID, OWN_ROW_ID].sort(),
      );
    });

    it('cursor advances past a hidden entry even when the page hits its limit (pagination correctness)', async () => {
      setChangeFeedEntryVisibility(({ entry }) => entry.rowId === OWN_ROW_ID);

      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OTHER_ROW_ID,
        operation: 'create',
      });
      const ownSeqEntry = await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OWN_ROW_ID,
        operation: 'create',
      });

      // limit: 2 forces the underlying page to hit its limit exactly at the
      // second (fetched-but-hidden-for-nobody-here, both fetched) entry, so
      // the cursor is tied to the last FETCHED row, not the last VISIBLE one.
      const page = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        limit: 2,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(page.changes.map((c) => c.rowId)).toEqual([OWN_ROW_ID]);
      expect(page.cursor).toBe(ownSeqEntry);

      // Polling again from that cursor is stable — nothing left to see, and
      // the denied entry is never re-served.
      const next = await getAuthorizedTenantScopedChangesSince(db, {
        since: page.cursor,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(next.changes).toHaveLength(0);
      expect(next.cursor).toBe(page.cursor);
    });

    it('fails closed (entry hidden) when the visibility hook throws', async () => {
      setChangeFeedEntryVisibility(() => {
        throw new Error('boom');
      });
      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OWN_ROW_ID,
        operation: 'create',
      });

      const page = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(page.changes).toHaveLength(0);
      expect(page.cursor).toBeGreaterThan(0);
    });

    it('fails closed (entry hidden) when the visibility hook returns a non-boolean', async () => {
      // @ts-expect-error intentionally malformed to exercise the fail-closed path
      setChangeFeedEntryVisibility(() => 'yes');
      await appendChange(db, {
        table: PUNCHES_TABLE,
        rowId: OWN_ROW_ID,
        operation: 'create',
      });

      const page = await getAuthorizedTenantScopedChangesSince(db, {
        since: 0,
        locals: stationLocals,
        request: stationRequest,
      });
      expect(page.changes).toHaveLength(0);
    });
  });
});
