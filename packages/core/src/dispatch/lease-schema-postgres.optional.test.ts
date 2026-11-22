/**
 * Dispatch lease schema on PostgreSQL (P6 T33, optional lane): fresh and
 * 1.20.0-upgraded databases agree on the lease columns (`claimed_until` is
 * `timestamptz`) and the new-named indexes.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DISPATCH_LEASE_INDEXES,
  type DispatchTestDatabase,
  leaseShapeOf,
  legacyDispatchDdl,
  openPostgresDispatchDatabase,
  postgresDispatchUrl,
  readDispatchTableShape,
  runStatements,
} from '../__tests__/fixtures/dispatch-test-db';

describe.skipIf(!postgresDispatchUrl)('dispatch lease schema on pg', () => {
  const opened: DispatchTestDatabase[] = [];

  afterEach(async () => {
    for (const ctx of opened.splice(0)) await ctx.close();
  });

  it('immediate-predecessor database gains lease columns and new-named indexes identical to fresh', async () => {
    const fresh = await openPostgresDispatchDatabase('lease_schema_fresh');
    opened.push(fresh);
    const upgraded = await openPostgresDispatchDatabase('lease_schema_up', {
      preload: (db) => runStatements(db, legacyDispatchDdl('postgres')),
    });
    opened.push(upgraded);

    const freshLease = leaseShapeOf(
      await readDispatchTableShape(fresh.db, 'postgres'),
    );
    const columns = freshLease.columns as Record<string, string>;
    expect(freshLease.indexes).toEqual({
      ...DISPATCH_LEASE_INDEXES,
      idx_smrt_dispatch_status_updated: ['status', 'updated_at'],
    });
    expect(columns.claimed_until).toBe('timestamp with time zone');
    expect(
      leaseShapeOf(await readDispatchTableShape(upgraded.db, 'postgres')),
    ).toEqual(freshLease);
  });
});
