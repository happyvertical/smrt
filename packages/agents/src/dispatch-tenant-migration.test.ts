/**
 * Regression tests for S5 #1398 (agents): the legacy dispatch-subscription
 * migration must not rewrite other tenants' `_smrt_dispatch` rows.
 *
 * `Agent.initialize()` calls `migrateLegacyDispatchSubscriptions()`, which
 * issues a raw `UPDATE _smrt_dispatch` to re-target rows from a legacy
 * simple-name subscriber to the canonical (qualified) subscriber. The bus's
 * own subscribe/unsubscribe calls are tenant-scoped server-side, but this raw
 * UPDATE reached around the bus. Without a tenant predicate, an agent running
 * under tenant A would retarget tenant B's pending dispatches.
 */

import {
  ObjectRegistry,
  setDispatchTenantResolver,
  smrt,
} from '@happyvertical/smrt-core';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from './agent.js';

@smrt()
class MigrationAgent extends Agent {
  protected config = {};
  async run(): Promise<void> {}
}

function canonicalSubscriber(): string {
  return (
    ObjectRegistry.getClass('MigrationAgent')?.qualifiedName || 'MigrationAgent'
  );
}

describe('migrateLegacyDispatchSubscriptions tenant isolation (S5 #1398)', () => {
  let activeTenant: string | null = null;

  beforeEach(() => {
    // Register a resolver so the DispatchBus + the raw UPDATE both treat
    // tenancy as ENABLED. The active tenant id is driven by `activeTenant`.
    setDispatchTenantResolver(() => activeTenant);
  });

  afterEach(() => {
    setDispatchTenantResolver(undefined);
    activeTenant = null;
  });

  it("does not retarget another tenant's dispatch rows", async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const legacy = 'MigrationAgent';
    const canonical = canonicalSubscriber();
    expect(canonical).not.toBe(legacy);

    // Bootstrap the dispatch tables via an initialize() under tenant A.
    activeTenant = 'tenant-a';
    const bootstrap = new MigrationAgent({ name: 'bootstrap', db });
    await bootstrap.initialize();

    // Seed a legacy-subscriber row owned by tenant B and a row owned by
    // tenant A, both targeted at the legacy subscriber name.
    await db.query(
      `INSERT INTO _smrt_dispatch
        (id, type, source, status, target_subscriber, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      'd-tenant-b',
      'thing.happened',
      'src',
      legacy,
      'tenant-b',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    await db.query(
      `INSERT INTO _smrt_dispatch
        (id, type, source, status, target_subscriber, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      'd-tenant-a',
      'thing.happened',
      'src',
      legacy,
      'tenant-a',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    // A legacy subscription owned by tenant A so the migration has work to do.
    await db.query(
      `INSERT INTO _smrt_dispatch_subscriptions
        (id, signal_type, subscriber, handler, delivery, enabled, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'handleDispatch', 'compete', 1, ?, ?, ?)`,
      'sub-legacy-a',
      'thing.happened',
      legacy,
      'tenant-a',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    // Run the migration as tenant A.
    activeTenant = 'tenant-a';
    const agent = new MigrationAgent({ name: 'migrating', db });
    await agent.initialize();

    const rowB = await db.query(
      `SELECT target_subscriber FROM _smrt_dispatch WHERE id = ?`,
      'd-tenant-b',
    );
    const rowA = await db.query(
      `SELECT target_subscriber FROM _smrt_dispatch WHERE id = ?`,
      'd-tenant-a',
    );

    // Tenant B's row must be untouched (the bug rewrote it to the canonical
    // subscriber); tenant A's own row is correctly migrated.
    expect(rowB.rows[0].target_subscriber).toBe(legacy);
    expect(rowA.rows[0].target_subscriber).toBe(canonical);
  });

  it('migrates all rows when tenancy is disabled (no resolver)', async () => {
    // Clear the resolver → tenancy off → pre-tenancy behavior (no filtering).
    setDispatchTenantResolver(undefined);

    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const legacy = 'MigrationAgent';
    const canonical = canonicalSubscriber();

    const bootstrap = new MigrationAgent({ name: 'bootstrap-2', db });
    await bootstrap.initialize();

    await db.query(
      `INSERT INTO _smrt_dispatch
        (id, type, source, status, target_subscriber, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?)`,
      'd-global',
      'thing.happened',
      'src',
      legacy,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    await db.query(
      `INSERT INTO _smrt_dispatch_subscriptions
        (id, signal_type, subscriber, handler, delivery, enabled, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'handleDispatch', 'compete', 1, NULL, ?, ?)`,
      'sub-legacy-global',
      'thing.happened',
      legacy,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const agent = new MigrationAgent({ name: 'migrating-2', db });
    await agent.initialize();

    const row = await db.query(
      `SELECT target_subscriber FROM _smrt_dispatch WHERE id = ?`,
      'd-global',
    );
    expect(row.rows[0].target_subscriber).toBe(canonical);
  });

  it('only migrates global rows when tenancy is on but no tenant is active (fail-closed)', async () => {
    // Third security-critical state (review #1552): resolver present (tenancy
    // ENABLED) but no active tenant → scope is { enforced: true, tenantId: null }
    // → the predicate must be `tenant_id IS NULL`, touching ONLY global rows and
    // never any tenant's rows. Exercises the scope.tenantId === null branch of
    // buildDispatchTenantUpdatePredicate.
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const legacy = 'MigrationAgent';
    const canonical = canonicalSubscriber();

    // Bootstrap tables under a tenant.
    activeTenant = 'tenant-a';
    const bootstrap = new MigrationAgent({ name: 'bootstrap-3', db });
    await bootstrap.initialize();

    // A global (tenant_id NULL) row and a tenant-A row, both at the legacy name.
    await db.query(
      `INSERT INTO _smrt_dispatch
        (id, type, source, status, target_subscriber, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?)`,
      'd-global-3',
      'thing.happened',
      'src',
      legacy,
      new Date().toISOString(),
      new Date().toISOString(),
    );
    await db.query(
      `INSERT INTO _smrt_dispatch
        (id, type, source, status, target_subscriber, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      'd-tenant-a-3',
      'thing.happened',
      'src',
      legacy,
      'tenant-a',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    // A global legacy subscription so the migration has work to do.
    await db.query(
      `INSERT INTO _smrt_dispatch_subscriptions
        (id, signal_type, subscriber, handler, delivery, enabled, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'handleDispatch', 'compete', 1, NULL, ?, ?)`,
      'sub-legacy-global-3',
      'thing.happened',
      legacy,
      new Date().toISOString(),
      new Date().toISOString(),
    );

    // Run the migration with tenancy ENABLED but NO active tenant.
    activeTenant = null;
    const agent = new MigrationAgent({ name: 'migrating-3', db });
    await agent.initialize();

    const rowGlobal = await db.query(
      `SELECT target_subscriber FROM _smrt_dispatch WHERE id = ?`,
      'd-global-3',
    );
    const rowA = await db.query(
      `SELECT target_subscriber FROM _smrt_dispatch WHERE id = ?`,
      'd-tenant-a-3',
    );

    // Fail-closed: only the global row migrates; the tenant's row is untouched.
    expect(rowGlobal.rows[0].target_subscriber).toBe(canonical);
    expect(rowA.rows[0].target_subscriber).toBe(legacy);
  });
});
