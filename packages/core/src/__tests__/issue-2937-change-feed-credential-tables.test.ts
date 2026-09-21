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
  getTableVersion,
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

/**
 * An STI base plus a child that declares itself sensitive. The child's rows land
 * in the BASE class's table, so this pins that a `sensitive` declaration follows
 * the rows rather than the declaring class's own name.
 */
@smrt({ tableStrategy: 'sti' })
class Issue2937StiBase extends SmrtObject {
  label: string = '';
  tenantId: string = '';
}

class Issue2937StiBaseCollection extends SmrtCollection<Issue2937StiBase> {
  static readonly _itemClass = Issue2937StiBase;
}

@smrt({ sensitive: true })
class Issue2937StiSecretChild extends Issue2937StiBase {
  token: string = '';
}

class Issue2937StiSecretChildCollection extends SmrtCollection<Issue2937StiSecretChild> {
  static readonly _itemClass = Issue2937StiSecretChild;
}

const TEST_CLASSES = [
  'Issue2937SecretTicket',
  'Issue2937PublicNote',
  'Issue2937StiBase',
  'Issue2937StiSecretChild',
];
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
        'secrets',
        'tenant_keys',
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

    it('treats an explicit sensitive: false as no opt-out, whichever config source carries it', async () => {
      // The marker is documented as one-way. Ordinary spread precedence in
      // `mergedConfig` would let a `sensitive: false` from a later-spread
      // source erase a `true` from another — a stale manifest disagreeing with
      // the class, say — which is a silent fail-OPEN in a control whose whole
      // contract is that it cannot be turned off.
      const { ObjectRegistry } = await import('../registry');
      const table = 'issue2937_or_merge_secrets';

      class Issue2937OrMergeSecret extends SmrtObject {
        token: string = '';
      }
      ObjectRegistry.register(
        Issue2937OrMergeSecret as unknown as typeof SmrtObject,
        { tableName: table, sensitive: true },
      );
      expect(isChangeFeedSensitiveTable(table)).toBe(true);

      // A re-registration explicitly saying `false` must not clear it, and must
      // not leave `false` on the registered config either — the write path's
      // class-level resolver reads exactly that value.
      ObjectRegistry.register(
        Issue2937OrMergeSecret as unknown as typeof SmrtObject,
        { tableName: table, sensitive: false },
      );
      expect(isChangeFeedSensitiveTable(table)).toBe(true);
      expect(isChangeFeedObservableTable(table)).toBe(false);
      expect(
        ObjectRegistry.getClassByConstructor(
          Issue2937OrMergeSecret as unknown as typeof SmrtObject,
        )?.config?.sensitive,
      ).toBe(true);
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

    it('does not broadcast a sensitive signal to peer replicas either', async () => {
      // `deliverLocally` alone is not enough: a process on this build can drain
      // PostgreSQL rows an OLDER build staged, and would then NOTIFY
      // {table:'sessions', rowId} onto the shared channel — putting the
      // credential on the wire and handing it to old-build peers that forward
      // it to their SSE clients.
      const notified: unknown[] = [];
      const notifications = {
        notify: async (_channel: string, payload: unknown) => {
          notified.push(payload);
        },
        listen: async () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ done: true }),
          }),
        }),
      };
      (db as unknown as Record<string, unknown>).notifications = notifications;

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
      // The broadcast is fire-and-forget; let its microtasks settle.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(JSON.stringify(notified)).not.toContain('owner-session-id');
      expect(
        notified.every(
          (payload) => (payload as { table?: string }).table !== 'sessions',
        ),
      ).toBe(true);
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

  describe('the declared name and the recorded name can differ', () => {
    it('records nothing for an STI child that declares itself sensitive, even though it writes to the base table', async () => {
      // `@smrt()` resolves an STI child to its base's table at registration, so
      // the declaration already lands on the right name — this pins that, since
      // a future change to either derivation (registration's, or the writer's
      // `instance.tableName`) would silently fail OPEN for the child. The
      // write path's class-level check is the backstop that does not depend on
      // the two derivations agreeing.
      const children = await Issue2937StiSecretChildCollection.create({ db });
      const child = await children.create({ label: 'sti', token: 'secret' });
      expect(child.id).toBeTruthy();

      const recordedTable = child.tableName;
      expect(await feedRowCount(db, recordedTable)).toBe(0);

      const { changes } = await getChangesSince(db, { since: 0 });
      expect(JSON.stringify(changes)).not.toContain(String(child.id));

      // The write-path hit declared the real table, so a name-only check now
      // agrees and the read path refuses it as well.
      expect(isChangeFeedSensitiveTable(recordedTable)).toBe(true);
      await insertLegacyFeedRow(db, recordedTable, 'legacy-sti-row');
      const after = await getChangesSince(db, {
        since: 0,
        tables: [recordedTable],
      });
      expect(after.changes).toEqual([]);
    });
  });

  describe('conditional GET cannot answer a stale 304 for a sensitive table', () => {
    it('gives a sensitive table an unrepeatable version, and an ordinary table a stable one', async () => {
      // A non-observable table appends nothing, so getTableVersion() would pin
      // at whatever an older build last wrote and then fall back to the global
      // horizon, which moves only when some OTHER table writes. Every ETag path
      // — the runtime APIGenerator, the generated conditionalVersionedRead, and
      // route files an older generator already emitted — derives its validator
      // from this one call, so a repeated value is a 304 for a revoked API key
      // or a rotated session.
      await ensureChangeFeedTable(db);
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n1');
      await insertLegacyFeedRow(db, 'sessions', 'owner-session-id');

      for (const table of ['sessions', 'api_keys', SECRET_TABLE]) {
        // Unique, not merely increasing. A clock-seeded per-process counter
        // would be monotonic here and still collide across replicas: two
        // processes start milliseconds apart, serve at different rates, and the
        // ETag carries no per-process entropy, so one replica can mint the
        // exact validator a client holds from another and 304 a revoked key.
        // 48 bits of randomness per call is what actually holds.
        const versions = new Set<number>();
        for (let i = 0; i < 64; i++) {
          const version = await getTableVersion(db, table);
          expect(Number.isSafeInteger(version)).toBe(true);
          expect(version).toBeGreaterThan(0);
          versions.add(version);
        }
        expect(versions.size).toBe(64);
        // Not derived from a shared monotonic counter: a strictly increasing
        // sequence over 64 draws is vanishingly unlikely from real randomness.
        const ordered = [...versions];
        expect(
          ordered.every((value, i) => i === 0 || value > ordered[i - 1]),
        ).toBe(false);
      }

      // An ordinary table keeps the documented replica-stable contract: two
      // reads with no write in between agree, and a write advances it.
      const before = await getTableVersion(db, PUBLIC_TABLE);
      expect(await getTableVersion(db, PUBLIC_TABLE)).toBe(before);
      const notes = await Issue2937PublicNoteCollection.create({ db });
      await notes.create({ body: 'moves the version' });
      expect(await getTableVersion(db, PUBLIC_TABLE)).toBeGreaterThan(before);
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

    it('does not double-count purged credential rows under dryRun', async () => {
      // Under dryRun nothing is deleted, so the maxRows/age bounds would count
      // the same rows the sensitive purge already reported and overstate what a
      // real sweep would remove.
      await insertLegacyFeedRow(db, 'sessions', 's1');
      await insertLegacyFeedRow(db, 'api_keys', 'k1');
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n1');
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n2');

      const dry = await pruneChangeFeed(db, { maxRows: 1, dryRun: true });
      // Nothing was actually removed by a dry run.
      expect(await feedRowCount(db, 'sessions')).toBe(1);

      const real = await pruneChangeFeed(db, { maxRows: 1 });
      expect(real.pruned).toBe(dry.pruned);
      // Sequences 1-3 go, the newest survives.
      expect(real.pruned).toBe(3);
    });

    it('moves floor when the oldest rows were sensitive, and fails safe by asking for a resync', async () => {
      // The realistic shape: a session exists before the first domain write and
      // is re-saved on every request, so the LOWEST retained sequences are
      // credential rows. Purging them raises MIN(seq). That is a deliberate
      // departure from the age bound's prefix-only rule; what it must never do
      // is lose a change silently, so pin the fail-safe direction.
      await insertLegacyFeedRow(db, 'sessions', 'oldest-session');
      await insertLegacyFeedRow(db, 'sessions', 'second-session');
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n1');
      await insertLegacyFeedRow(db, PUBLIC_TABLE, 'n2');

      await pruneChangeFeed(db, { maxAgeMs: 30 * 24 * 60 * 60 * 1000 });
      expect(await feedRowCount(db, 'sessions')).toBe(0);

      // floor is now 3, so a since=0 client is told to resync rather than being
      // served a page that silently omits sequences 1-2.
      const page = await getChangesSince(db, { since: 0 });
      expect(page.resyncRequired).toBe(true);
      expect(page.changes).toEqual([]);
      expect(page.cursor).toBe(0);
      expect(page.resyncCursor).toBe(4);

      // Resuming from the advertised resyncCursor works normally.
      const resumed = await getChangesSince(db, { since: page.resyncCursor! });
      expect(resumed.resyncRequired).toBeUndefined();
      expect(resumed.changes).toEqual([]);

      // A cursor already inside the retained run is still served incrementally.
      const inWindow = await getChangesSince(db, { since: 3 });
      expect(inWindow.resyncRequired).toBeUndefined();
      expect(inWindow.changes.map((change) => change.rowId)).toEqual(['n2']);
    });
  });
});
