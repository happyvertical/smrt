/**
 * `smrt doctor --db`: dispatch lease health (docs/content/dispatch.md,
 * "Leases and At-Least-Once Delivery").
 *
 * Counts `processing` rows an older core left without a lease (not
 * reclaimed unless legacy reclaim is opted in), leased rows (zero is the
 * rollback precondition), expired and long-held leases, and rows no
 * subscription can route. Diagnostic only: it writes nothing.
 */

import {
  DispatchCollection,
  type DispatchLeaseInspection,
  DispatchSubscriptionCollection,
  inspectDispatchLeases,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  closeDatabaseConnection,
  redactDatabaseUrlsInText,
} from './db-command-utils.js';

/** One doctor run of the lease check. */
export interface DispatchLeaseOutcome {
  check: DispatchLeaseInspection | null;
  /** Human-readable failure reason, when the check failed. */
  error: string | null;
  /** Set when the database has no dispatch tables (nothing to check). */
  skipped?: string;
}

async function connect(): Promise<DatabaseInterface> {
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');
  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  if (!config.database?.url || config.database.url === ':memory:') {
    throw new Error(
      'No persistent database is configured. Set `database.url` in smrt.config.ts (or DATABASE_URL).',
    );
  }
  const { getDatabase } = await import('@happyvertical/sql');
  return getDatabase({
    type: config.database.type || 'sqlite',
    url: config.database.url,
  });
}

/**
 * Run the check on `options.db`, or on the configured database (opened and
 * closed here). Never throws for an operational problem.
 */
export async function runDispatchLeaseCheck(
  options: { db?: DatabaseInterface; typeHint?: string } = {},
): Promise<DispatchLeaseOutcome> {
  let owned: DatabaseInterface | undefined;
  try {
    let db = options.db;
    if (!db) {
      owned = await connect();
      db = owned;
    }
    const [dispatches, subscriptions] = await Promise.all([
      DispatchCollection.tableExists(db, options.typeHint),
      DispatchSubscriptionCollection.tableExists(db, options.typeHint),
    ]);
    if (!dispatches || !subscriptions) {
      return { check: null, error: null, skipped: 'no dispatch tables' };
    }
    return { check: await inspectDispatchLeases(db), error: null };
  } catch (error) {
    return {
      check: null,
      error: redactDatabaseUrlsInText(
        error instanceof Error ? error.message : String(error),
      ),
    };
  } finally {
    await closeDatabaseConnection(owned);
  }
}

/** Whether the check found anything an operator should act on. */
export function dispatchLeaseCheckNeedsAttention(
  check: DispatchLeaseInspection,
): boolean {
  return (
    check.legacyProcessing > 0 ||
    check.expiredLeases > 0 ||
    check.longLeases > 0 ||
    check.unrouted > 0
  );
}

/** The lines `smrt doctor --db` prints for the check. */
export function formatDispatchLeaseCheck(
  check: DispatchLeaseInspection,
): string[] {
  return [
    `   Leased processing rows: ${check.leasedProcessing}`,
    `   Expired leases: ${check.expiredLeases}`,
    `   Leases held longer than 3x the default lease: ${check.longLeases}`,
    `   Processing rows with no lease (older core): ${check.legacyProcessing}`,
    `   Rows no subscription routes: ${check.unrouted}`,
    ...(dispatchLeaseCheckNeedsAttention(check)
      ? [
          '   Rows without a lease are not reclaimed unless legacyLeaseGraceMs is set;',
          '   after draining older processes, `smrt dispatch:release-leases --legacy`',
          '   returns them to pending. Unrouted rows wait for a subscription; abandoned',
          '   unrouted leases are failed by `smrt db:prune`. See docs/content/dispatch.md.',
        ]
      : []),
  ];
}
