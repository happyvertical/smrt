/**
 * Dispatch lease executor (P6 T08): on embedded engines the in-process
 * registry prevents a local double execution; a handle that provably cannot
 * commit lease statements on its own is refused before anything is claimed.
 * PostgreSQL pools: `lease-executor-postgres.optional.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { defineLocalLeaseRegistryCases } from '../__tests__/fixtures/dispatch-lease-suites';
import {
  dispatchTestEngines,
  openDispatchTestDatabase,
} from '../__tests__/fixtures/dispatch-test-db';
import { withCallerOwnedDatabaseTransaction } from '../embedded-write-queue.js';
import {
  assertLeaseExecutorSafe,
  DISPATCH_LEASE_EXECUTOR_UNSAFE,
} from './lease-heartbeat.js';

describe.each(
  dispatchTestEngines,
)('dispatch local lease registry on %s', (engine) => {
  defineLocalLeaseRegistryCases((options) =>
    openDispatchTestDatabase(engine as 'sqlite', options),
  );
});

describe('dispatch lease executor policy', () => {
  const pg = (client: unknown) => ({ url: 'postgres://h/db', client }) as never;

  it('refuses a PostgreSQL pool of fewer than two clients', () => {
    expect(() => assertLeaseExecutorSafe(pg({ options: { max: 1 } }))).toThrow(
      DISPATCH_LEASE_EXECUTOR_UNSAFE,
    );
    expect(() =>
      assertLeaseExecutorSafe(pg({ options: { max: 2 } })),
    ).not.toThrow();
  });

  it('refuses a single PostgreSQL connection', () => {
    expect(() =>
      assertLeaseExecutorSafe(pg({ connectionParameters: {} })),
    ).toThrow(DISPATCH_LEASE_EXECUTOR_UNSAFE);
  });

  it('refuses a transaction handle the caller declared', async () => {
    const handle = { url: 'app.db', query: async () => ({ rows: [] }) };
    await withCallerOwnedDatabaseTransaction(handle as never, async () => {
      expect(() => assertLeaseExecutorSafe(handle as never)).toThrow(
        DISPATCH_LEASE_EXECUTOR_UNSAFE,
      );
    });
  });

  it('accepts an embedded handle', async () => {
    const ctx = await openDispatchTestDatabase('sqlite');
    try {
      expect(() => assertLeaseExecutorSafe(ctx.db)).not.toThrow();
    } finally {
      await ctx.close();
    }
  });
});
