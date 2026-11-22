/**
 * Dispatch lease schema (P6 T33): a fresh database and one upgraded from the
 * immediate predecessor schema (1.20.0) carry the same lease columns and the
 * same new-named indexes; the retention index keeps its definition.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  DISPATCH_LEASE_INDEXES,
  type DispatchTestDatabase,
  dispatchTestEngines,
  leaseShapeOf,
  legacyDispatchDdl,
  openDispatchTestDatabase,
  readDispatchTableShape,
  runStatements,
} from '../__tests__/fixtures/dispatch-test-db';

describe.each(dispatchTestEngines)('dispatch lease schema on %s', (engine) => {
  const opened: DispatchTestDatabase[] = [];
  const open = async (preload?: 'legacy') => {
    const ctx = await openDispatchTestDatabase(engine as 'sqlite', {
      preload:
        preload === 'legacy'
          ? (db) => runStatements(db, legacyDispatchDdl(engine))
          : undefined,
    });
    opened.push(ctx);
    return ctx;
  };

  afterEach(async () => {
    for (const ctx of opened.splice(0)) await ctx.close();
  });

  it('a fresh database carries the lease columns and new-named indexes', async () => {
    const { db } = await open();
    const lease = leaseShapeOf(await readDispatchTableShape(db, engine));
    expect(lease.indexes).toEqual({
      ...DISPATCH_LEASE_INDEXES,
      idx_smrt_dispatch_status_updated: ['status', 'updated_at'],
    });
    const columns = lease.columns as Record<string, string | null>;
    expect(columns.lease_token).not.toBeNull();
    expect(columns.max_attempts).not.toBeNull();
    expect(columns.claimed_until).toMatch(
      engine === 'pglite' ? /^timestamp with time zone$/ : /^timestamp/,
    );
  });

  it('immediate-predecessor database gains lease columns and new-named indexes identical to fresh', async () => {
    const fresh = await open();
    const upgraded = await open('legacy');
    const lease = leaseShapeOf(
      await readDispatchTableShape(upgraded.db, engine),
    );
    expect(lease.indexes).toEqual({
      ...DISPATCH_LEASE_INDEXES,
      idx_smrt_dispatch_status_updated: ['status', 'updated_at'],
    });
    expect(lease).toEqual(
      leaseShapeOf(await readDispatchTableShape(fresh.db, engine)),
    );
  });
});
