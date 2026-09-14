/**
 * Contract-narrowing regression for #2861 review (bus.ts:189-195,
 * bootstrap.ts:152-195, types.ts `DispatchBusOptions.db`).
 *
 * `DispatchBus.initialize()` now serializes its PostgreSQL bootstrap inside
 * the advisory-locked transaction `ensureSystemTables()` uses, which
 * requires the supplied database handle to implement `beginTransaction()`
 * or `transaction()` — both optional on `DatabaseInterface`. Before this
 * fix, `DispatchBus` needed only `db.query()`, so a query-only PostgreSQL
 * adapter/proxy worked. That is a deliberate narrowing of the accepted
 * input (documented on `DispatchBusOptions.db`): a query-only handle cannot
 * safely take the mutual-exclusion lock the #2861 fix depends on, so
 * failing closed with an actionable error replaces silently running
 * unguarded, racy DDL. This test pins that documented behavior — a
 * query-only PostgreSQL handle throws the specific, actionable message
 * before touching any table — so a future change cannot silently regress
 * it back to an unguarded path (or to some other, less actionable error) in
 * either direction.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { createDispatchBus } from './bus.js';

describe('DispatchBus PostgreSQL transaction-capability contract (#2861)', () => {
  it('fails closed with an actionable message for a query-only PostgreSQL adapter, without touching a table', async () => {
    const query = vi.fn(async () => {
      throw new Error(
        'query() should not run before the transaction-capability check',
      );
    });
    const queryOnlyPostgresAdapter = {
      url: 'postgres://user:pass@localhost:5432/does-not-exist',
      client: {},
      query,
    } as unknown as DatabaseInterface;

    await expect(
      createDispatchBus({ db: queryOnlyPostgresAdapter }),
    ).rejects.toThrow(
      'Postgres system table bootstrap requires a transaction-capable database adapter',
    );
    expect(query).not.toHaveBeenCalled();
  });
});
