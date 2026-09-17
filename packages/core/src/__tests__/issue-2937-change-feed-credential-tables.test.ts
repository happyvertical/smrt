/**
 * The change feed must never disclose credential-bearing rows (issue #2937).
 *
 * `@happyvertical/smrt-users`' `Session` row **id is the bearer credential**:
 * it is the `sid` cookie value and the token `TerminalAuthService` hands a
 * device. The feed records `{table, rowId, operation, tenantId}` for every
 * observable table, and `SessionService.loadSessionContext()` re-saves the
 * session on every authenticated request — so every live session id was
 * rewritten into `_smrt_changes` continuously and served by the generated
 * `/_changes` and `/_events` routes, which gate only on "some authenticated
 * principal". The lowest-privileged enrolled station could read the owner's
 * session id and take the account over.
 *
 * The fix is fail-closed and enforced at three points, all of which this file
 * pins:
 *
 * 1. **Declared marker.** `@smrt({ sensitive: true })` marks a class's table
 *    credential-bearing; registration pushes the resolved table name into the
 *    sensitive set, which only ever grows.
 * 2. **Baseline names.** {@link CHANGE_FEED_CREDENTIAL_TABLES} covers the
 *    framework's own credential tables even in a process where the owning
 *    package has not registered (or is running an older build).
 * 3. **Read-side refusal.** `getChangesSince()` never serves a sensitive
 *    table's rows, so entries an *earlier* version already wrote stay
 *    unreadable after the upgrade, and `pruneChangeFeed()` deletes them
 *    outright rather than waiting out the retention window.
 *
 * Real in-memory SQLite throughout — never a mocked database.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  appendChange,
  appendChanges,
  bumpChangeFeed,
  CHANGE_FEED_TABLE,
  ensureChangeFeedTable,
  getChangesSince,
  getTenantScopedChangesSince,
  isChangeFeedObservableTable,
  pruneChangeFeed,
  registerChangeFeedWriter,
  resetChangeFeedWarnings,
} from '../change-feed';
import {
  CHANGE_FEED_CREDENTIAL_TABLES,
  isChangeFeedSensitiveTable,
} from '../change-feed-sensitivity';
import type { ChangeSignal } from '../change-signals';
import {
  publishChangeSignal,
  subscribeToChangeSignals,
} from '../change-signals';
import { SmrtCollection } from '../collection';
import { setDispatchTenantResolver } from '../dispatch/tenant-resolver';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

// ============================================================================
// Fixtures
// ============================================================================

/**
 * Stands in for `smrt-users`' `Session`: the row id IS the credential, so the
 * class declares itself sensitive and the feed must never record it.
 */
@smrt({ sensitive: true })
class Issue2937SecretTicket extends SmrtObject {
  subject: string = '';
  tenantId: string = '';
}

class Issue2937SecretTicketCollection extends SmrtCollection<Issue2937SecretTicket> {
  static readonly _itemClass = Issue2937SecretTicket;
}

/** An ordinary table alongside it — coverage must not regress. */
@smrt()
class Issue2937PublicNote extends SmrtObject {
  body: string = '';
  tenantId: string = '';
}

class Issue2937PublicNoteCollection extends SmrtCollection<Issue2937PublicNote> {
  static readonly _itemClass = Issue2937PublicNote;
}

const TEST_CLASSES = ['Issue2937SecretTicket', 'Issue2937PublicNote'];
// Derived, not declared — `tableNameFromClass` does not insert a separator
// between a trailing digit run and the next word.
const SECRET_TABLE = 'issue2937secret_tickets';
const PUBLIC_TABLE = 'issue2937public_notes';

async function createDb(): Promise<DatabaseInterface> {
  return getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: TEST_CLASSES,
  });
}

/**
 * Write a feed row the way a pre-fix build did — straight INSERT, bypassing
 * every guard — so the read-side tests describe a database upgraded *into*
 * the fix with credential rows already in its log.
 */
async function insertLegacyFeedRow(
  db: DatabaseInterface,
  table: string,
  rowId: string,
  tenantId: string | null = null,
): Promise<void> {
  await ensureChangeFeedTable(db);
  const rows = (await db.query(
    `SELECT COALESCE(MAX(seq), 0) AS seq FROM ${CHANGE_FEED_TABLE}`,
  )) as unknown as { rows?: { seq: number }[] };
  const current = Array.isArray(rows) ? rows : (rows.rows ?? []);
  const seq = Number((current[0] as { seq?: unknown })?.seq ?? 0) + 1;
  await db.query(
    `INSERT INTO ${CHANGE_FEED_TABLE} (seq, table_name, row_id, operation, tenant_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    seq,
    table,
    rowId,
    'update',
    tenantId,
    new Date().toISOString(),
  );
}

async function feedRowCount(
  db: DatabaseInterface,
  table: string,
): Promise<number> {
  const result = (await db.query(
    `SELECT COUNT(*) AS n FROM ${CHANGE_FEED_TABLE} WHERE table_name = ?`,
    table,
  )) as unknown as { rows?: { n: number }[] };
  const rows = Array.isArray(result) ? result : (result.rows ?? []);
  return Number((rows[0] as { n?: unknown })?.n ?? 0);
}

// ============================================================================
// Tests
// ============================================================================

describe('change feed never discloses credential-bearing tables (issue #2937)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
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

  describe('classification', () => {
    it('treats the framework credential tables as sensitive without any registration', () => {
      // These are the tables the audit for #2937 found whose row id or payload
      // is secret. They must classify even in a process where smrt-users /
      // smrt-profiles never registered — an older consumer build, a worker
      // that only loaded core, a replica mid-rollout.
      for (const table of [
        'sessions',
        'users_cli_auth_requests',
        'users_magic_link_tokens',
        'magic_link_tokens',
        'api_keys',
        'nostr_identities',
      ]) {
        expect(CHANGE_FEED_CREDENTIAL_TABLES).toContain(table);
        expect(isChangeFeedSensitiveTable(table)).toBe(true);
        expect(isChangeFeedObservableTable(table)).toBe(false);
      }
    });

    it('shares one set across module instances, so a reloaded or duplicated copy of core cannot lose a declaration', async () => {
      // A dev server's HMR reload, or a build resolving two copies of
      // @happyvertical/smrt-core, gives this module two instances. A
      // module-scope Set would take the declaration in one and be read in the
      // other — and the failure is silent and fails OPEN, which is the exact
      // disclosure this issue closes. `vi.resetModules()` + a dynamic import is
      // the documented way to obtain genuinely fresh module state.
      const declaredTable = 'issue2937_second_instance_secrets';
      vi.resetModules();
      const first = await import('../change-feed-sensitivity');
      first.declareChangeFeedSensitiveTable(declaredTable);

      vi.resetModules();
      const second = await import('../change-feed-sensitivity');
      expect(second).not.toBe(first);
      // The declaration made through the first instance is visible through the
      // second, and the baseline is intact in both.
      expect(second.isChangeFeedSensitiveTable(declaredTable)).toBe(true);
      expect(second.getChangeFeedSensitiveTables()).toContain(declaredTable);
      expect(second.isChangeFeedSensitiveTable('sessions')).toBe(true);
      expect(first.isChangeFeedSensitiveTable('sessions')).toBe(true);

      // And the live guards this file's other tests use agree with it.
      expect(isChangeFeedSensitiveTable(declaredTable)).toBe(true);
      expect(isChangeFeedObservableTable(declaredTable)).toBe(false);
    });

    it('marks a table sensitive because its class declared it, and leaves ordinary tables observable', () => {
      expect(isChangeFeedSensitiveTable(SECRET_TABLE)).toBe(true);
      expect(isChangeFeedObservableTable(SECRET_TABLE)).toBe(false);

      expect(isChangeFeedSensitiveTable(PUBLIC_TABLE)).toBe(false);
      expect(isChangeFeedObservableTable(PUBLIC_TABLE)).toBe(true);
    });
  });

  describe('write side', () => {
    it('records nothing for a declared-sensitive table while ordinary writes still flow', async () => {
      const tickets = await Issue2937SecretTicketCollection.create({ db });
      const notes = await Issue2937PublicNoteCollection.create({ db });

      const ticket = await tickets.create({ subject: 'bearer' });
      ticket.subject = 'bearer-rotated';
      await ticket.save();
      await ticket.delete();

      const note = await notes.create({ body: 'ordinary' });

      const { changes } = await getChangesSince(db, { since: 0 });
      expect(changes.map((change) => change.table)).toEqual([PUBLIC_TABLE]);
      expect(changes.map((change) => change.rowId)).toEqual([note.id]);
      // The id never reached the durable log at all.
      expect(await feedRowCount(db, SECRET_TABLE)).toBe(0);
    });

    it('refuses the low-level append and the manual bump escape hatch', async () => {
      await ensureChangeFeedTable(db);

      await expect(
        appendChange(db, {
          table: 'sessions',
          rowId: 'owner-session-id',
          operation: 'update',
          tenantId: null,
        }),
      ).resolves.toBeNull();

      await appendChanges(db, [
        { table: 'sessions', rowId: 's1', operation: 'update', tenantId: null },
        {
          table: PUBLIC_TABLE,
          rowId: 'n1',
          operation: 'update',
          tenantId: null,
        },
      ]);

      await bumpChangeFeed(db, {
        table: 'sessions',
        rowId: 'owner-session-id',
      });

      expect(await feedRowCount(db, 'sessions')).toBe(0);
      expect(await feedRowCount(db, PUBLIC_TABLE)).toBe(1);
    });

    it('never publishes a live signal for a sensitive table', () => {
      const seen: ChangeSignal[] = [];
      const unsubscribe = subscribeToChangeSignals(db, (signal) => {
        seen.push(signal);
      });
      try {
        publishChangeSignal(db, {
          table: 'sessions',
          operation: 'update',
          rowId: 'owner-session-id',
          tenantId: null,
          seq: 1,
        });
        publishChangeSignal(db, {
          table: PUBLIC_TABLE,
          operation: 'update',
          rowId: 'n1',
          tenantId: null,
          seq: 2,
        });
      } finally {
        unsubscribe();
      }
      expect(seen.map((signal) => signal.table)).toEqual([PUBLIC_TABLE]);
    });
  });

  describe('read side: rows an older build already wrote', () => {
    it('never serves them, not even when the caller names the table explicitly', async () => {
      await insertLegacyFeedRow(db, 'sessions', 'owner-session-id');
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n1');
      await insertLegacyFeedRow(
        db,
        'users_cli_auth_requests',
        'device-code-row',
      );

      const all = await getChangesSince(db, { since: 0 });
      expect(all.changes.map((change) => change.table)).toEqual([PUBLIC_TABLE]);
      expect(JSON.stringify(all.changes)).not.toContain('owner-session-id');

      // The issue's exact request shape: `?since=0&tables=sessions`.
      const targeted = await getChangesSince(db, {
        since: 0,
        tables: ['sessions', 'users_cli_auth_requests'],
      });
      expect(targeted.changes).toEqual([]);

      const tenantScoped = await getTenantScopedChangesSince(db, {
        since: 0,
        tables: ['sessions'],
      });
      expect(tenantScoped.changes).toEqual([]);
    });

    it("a second principal cannot observe another principal's session id through either route", async () => {
      // Two tenants, one credential row each, written the way a pre-fix build
      // wrote them. `_changes` reads them through getTenantScopedChangesSince;
      // `_events` catch-up reads them through getChangesSince with the tenant
      // captured at connection open. Neither may disclose either id — not the
      // other principal's, and not the caller's own (which would confirm the
      // table is readable at all).
      await insertLegacyFeedRow(db, 'sessions', 'session-of-owner', 'tenant-a');
      await insertLegacyFeedRow(
        db,
        'sessions',
        'session-of-station',
        'tenant-b',
      );
      await insertLegacyFeedRow(db, 'sessions', 'session-global', null);
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'note-b', 'tenant-b');

      // The low-privilege station authenticates into tenant-b.
      setDispatchTenantResolver(() => ({
        enforced: true,
        tenantId: 'tenant-b',
      }));

      const changesRoute = await getTenantScopedChangesSince(db, {
        since: 0,
        tables: ['sessions'],
      });
      expect(changesRoute.changes).toEqual([]);

      const eventsCatchup = await getChangesSince(db, {
        since: 0,
        tenantId: 'tenant-b',
      });
      const payload = JSON.stringify(eventsCatchup.changes);
      expect(payload).not.toContain('session-of-owner');
      expect(payload).not.toContain('session-of-station');
      expect(payload).not.toContain('session-global');
      // The station still gets its own tenant's ordinary rows.
      expect(eventsCatchup.changes.map((change) => change.rowId)).toEqual([
        'note-b',
      ]);
    });

    it('does not let a sensitive table hold the cursor back', async () => {
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n1');
      await insertLegacyFeedRow(db, 'sessions', 'owner-session-id');

      const page = await getChangesSince(db, { since: 0 });
      expect(page.changes.map((change) => change.rowId)).toEqual(['n1']);
      // An exhaustive page still advances all the way to the horizon, so a
      // poller does not re-read the filtered row forever.
      expect(page.cursor).toBe(2);
      const next = await getChangesSince(db, { since: page.cursor });
      expect(next.changes).toEqual([]);
      expect(next.resyncRequired).toBeUndefined();
    });
  });

  describe('retention purges credential rows at rest', () => {
    it('deletes them regardless of age or row budget', async () => {
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n1');
      await insertLegacyFeedRow(db, 'sessions', 'owner-session-id');
      await insertLegacyFeedRow(db, 'api_keys', 'key-row');
      await insertLegacyFeedRow(db, SECRET_TABLE, 'ticket-row');
      // The newest entry is never deleted (the feed's "a non-empty feed is
      // never emptied" invariant), so give the horizon to an ordinary row —
      // which is also the realistic shape, sessions being far from the only
      // thing writing.
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n2');

      expect(await feedRowCount(db, 'sessions')).toBe(1);

      // A sweep with a generous window: nothing here is old enough or
      // numerous enough to prune on the ordinary predicates.
      await pruneChangeFeed(db, { maxAgeMs: 30 * 24 * 60 * 60 * 1000 });

      expect(await feedRowCount(db, 'sessions')).toBe(0);
      expect(await feedRowCount(db, 'api_keys')).toBe(0);
      expect(await feedRowCount(db, SECRET_TABLE)).toBe(0);
      expect(await feedRowCount(db, PUBLIC_TABLE)).toBe(2);
    });
  });
});
