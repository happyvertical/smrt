/**
 * Tenant-isolation regression tests for the DispatchBus (S5 #1398).
 *
 * Verifies the two HIGH findings from the packages/agents S5 audit:
 *  1. DispatchBus is tenant-scoped — a dispatch emitted in tenant A's context
 *     is not visible/claimable from tenant B's context, while no-context
 *     emit/claim behaves exactly as before (backward compatible).
 *  2. `source` is treated as untrusted caller metadata — a spoofed
 *     `options.source` cannot override the server-derived tenant identity, and
 *     the reserved in-memory sentinel cannot be impersonated.
 *
 * Tenancy is simulated by registering a tenant resolver directly via the core
 * inversion hook (`setDispatchTenantResolver`) so the test does not depend on
 * the `@happyvertical/smrt-tenancy` package. This mirrors what `enableTenancy()`
 * does at runtime. Uses real file-backed SQLite — no DB mocking.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDispatchBus, type DispatchBus } from './bus.js';
import { setDispatchTenantResolver } from './tenant-resolver.js';

describe('DispatchBus tenant isolation (S5 #1398)', () => {
  let bus: DispatchBus;
  let dbPath: string;
  let activeTenant: string | null | undefined;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-dispatch-tenancy-${randomUUID().slice(0, 8)}.db`,
    );
    bus = await createDispatchBus({ db: { type: 'sqlite', url: dbPath } });
    // Simulate an injected tenancy resolver (what enableTenancy() registers).
    activeTenant = undefined;
    setDispatchTenantResolver(() => activeTenant);
  });

  afterEach(() => {
    setDispatchTenantResolver(undefined);
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch (error) {
        console.warn('Failed to cleanup test database:', dbPath, error);
      }
    }
  });

  describe('tenant stamping on emit', () => {
    it('stamps the active tenant id on emitted dispatches', async () => {
      activeTenant = 'tenant-a';
      const dispatch = await bus.emit(
        'order.placed',
        { id: '1' },
        {
          source: 'orders',
        },
      );
      expect(dispatch.tenantId).toBe('tenant-a');

      const stored = await bus.get(dispatch.id);
      expect(stored?.tenantId).toBe('tenant-a');
    });

    it('leaves tenant_id NULL when there is no active tenant context', async () => {
      activeTenant = undefined;
      const dispatch = await bus.emit(
        'order.placed',
        { id: '1' },
        {
          source: 'orders',
        },
      );
      expect(dispatch.tenantId).toBeNull();
    });
  });

  describe('cross-tenant claim isolation', () => {
    it('does not let tenant B claim a dispatch emitted in tenant A', async () => {
      // Both tenants subscribe to the same signal under the same subscriber name.
      activeTenant = 'tenant-a';
      await bus.subscribe({ signalType: 'order.placed', subscriber: 'worker' });
      activeTenant = 'tenant-b';
      await bus.subscribe({ signalType: 'order.placed', subscriber: 'worker' });

      // Emit in tenant A.
      activeTenant = 'tenant-a';
      await bus.emit('order.placed', { id: 'a-1' }, { source: 'orders' });

      // Tenant B processes — must NOT see/claim tenant A's dispatch.
      activeTenant = 'tenant-b';
      const seenByB: unknown[] = [];
      const processedByB = await bus.process('worker', async (payload) => {
        seenByB.push(payload);
      });
      expect(processedByB).toBe(0);
      expect(seenByB).toHaveLength(0);

      // Tenant A processes — claims its own dispatch.
      activeTenant = 'tenant-a';
      const seenByA: unknown[] = [];
      const processedByA = await bus.process('worker', async (payload) => {
        seenByA.push(payload);
      });
      expect(processedByA).toBe(1);
      expect(seenByA).toEqual([{ id: 'a-1' }]);
    });

    it('isolates wildcard subscriptions across tenants too', async () => {
      activeTenant = 'tenant-a';
      await bus.subscribe({ signalType: 'order.*', subscriber: 'auditor' });
      activeTenant = 'tenant-b';
      await bus.subscribe({ signalType: 'order.*', subscriber: 'auditor' });

      activeTenant = 'tenant-a';
      await bus.emit('order.shipped', { id: 'a-2' }, { source: 'orders' });

      activeTenant = 'tenant-b';
      const processedByB = await bus.process('auditor', async () => {});
      expect(processedByB).toBe(0);

      activeTenant = 'tenant-a';
      const processedByA = await bus.process('auditor', async () => {});
      expect(processedByA).toBe(1);
    });

    it('lets a tenant claim global (no-context) dispatches', async () => {
      // Emit with no active tenant context → global dispatch (tenant_id NULL).
      activeTenant = undefined;
      await bus.emit('order.placed', { id: 'global-1' }, { source: 'orders' });

      activeTenant = 'tenant-a';
      await bus.subscribe({ signalType: 'order.placed', subscriber: 'worker' });
      const seen: unknown[] = [];
      const processed = await bus.process('worker', async (payload) => {
        seen.push(payload);
      });
      expect(processed).toBe(1);
      expect(seen).toEqual([{ id: 'global-1' }]);
    });
  });

  describe('no-context backward compatibility', () => {
    it('emits and claims exactly as before when no resolver is registered', async () => {
      // Remove the resolver entirely → core behaves as pre-tenancy.
      setDispatchTenantResolver(undefined);

      await bus.subscribe({ signalType: 'order.placed', subscriber: 'worker' });
      const emitted = await bus.emit(
        'order.placed',
        { id: 'x' },
        {
          source: 'orders',
        },
      );
      expect(emitted.tenantId).toBeNull();

      const seen: unknown[] = [];
      const processed = await bus.process('worker', async (payload) => {
        seen.push(payload);
      });
      expect(processed).toBe(1);
      expect(seen).toEqual([{ id: 'x' }]);
    });

    it('processes global (NULL) dispatches when no resolver is registered', async () => {
      setDispatchTenantResolver(undefined);
      await bus.subscribe({ signalType: 'order.placed', subscriber: 'worker' });
      await bus.emit('order.placed', { id: 'g' }, { source: 'orders' });

      const seen: unknown[] = [];
      const processed = await bus.process('worker', async (payload) => {
        seen.push(payload);
      });
      expect(processed).toBe(1);
      expect(seen).toEqual([{ id: 'g' }]);
    });
  });

  describe('fail-closed when tenancy is on but no active tenant (S5 #1398)', () => {
    it('a tenancy-enabled processor with no active tenant sees only global rows', async () => {
      // Resolver IS registered (tenancy on) but returns no active tenant.
      activeTenant = 'tenant-a';
      await bus.subscribe({
        signalType: 'order.placed',
        subscriber: 'worker',
      });
      await bus.emit('order.placed', { id: 'a' }, { source: 'orders' });

      // A global subscription + global dispatch in the no-tenant scope.
      activeTenant = undefined;
      await bus.subscribe({
        signalType: 'order.placed',
        subscriber: 'worker',
      });
      await bus.emit('order.placed', { id: 'global' }, { source: 'orders' });

      // Tenancy is enabled but no tenant is active → fail closed to global
      // (NULL) rows only. Must NOT see tenant-a's dispatch.
      const seen: unknown[] = [];
      const processed = await bus.process('worker', async (payload) => {
        seen.push(payload);
      });
      expect(processed).toBe(1);
      expect(seen).toEqual([{ id: 'global' }]);
    });

    it('get() with no active tenant cannot fetch a tenant-scoped dispatch', async () => {
      activeTenant = 'tenant-a';
      const dispatch = await bus.emit(
        'order.placed',
        { id: 'a' },
        { source: 'orders' },
      );

      // Tenancy on, no active tenant → only global rows are fetchable.
      activeTenant = undefined;
      const fetched = await bus.get(dispatch.id);
      expect(fetched).toBeNull();
    });
  });

  describe('bus.list()/get() ignore caller-supplied tenant scope (S5 #1398)', () => {
    it('list({}) does not see all tenants under an active tenant', async () => {
      activeTenant = 'tenant-a';
      await bus.emit('order.placed', { id: 'a' }, { source: 'orders' });
      activeTenant = 'tenant-b';
      await bus.emit('order.placed', { id: 'b' }, { source: 'orders' });

      activeTenant = 'tenant-a';
      const listed = await bus.list({});
      const ids = listed.map((d) => (d.payload as { id: string }).id).sort();
      // Only tenant-a's dispatch (no global rows emitted here).
      expect(ids).toEqual(['a']);
    });

    it('a caller-supplied tenantScope cannot widen visibility to another tenant', async () => {
      activeTenant = 'tenant-a';
      await bus.emit('order.placed', { id: 'a' }, { source: 'orders' });
      activeTenant = 'tenant-b';
      await bus.emit('order.placed', { id: 'b' }, { source: 'orders' });

      activeTenant = 'tenant-a';
      // Attempt to pick tenant-b by supplying a scope — must be ignored: the
      // bus strips any caller scope and re-derives it server-side.
      const listed = await bus.list({
        tenantScope: { enforced: true, tenantId: 'tenant-b' },
      });
      const ids = listed.map((d) => (d.payload as { id: string }).id).sort();
      expect(ids).toEqual(['a']);
    });

    it("get() cannot fetch another tenant's dispatch by id", async () => {
      activeTenant = 'tenant-b';
      const bDispatch = await bus.emit(
        'order.placed',
        { id: 'b' },
        { source: 'orders' },
      );

      activeTenant = 'tenant-a';
      const fetched = await bus.get(bDispatch.id);
      expect(fetched).toBeNull();
    });
  });

  describe('source is untrusted caller metadata', () => {
    it('a spoofed source does not override the server-derived tenant', async () => {
      activeTenant = 'tenant-a';
      // Caller asserts a source label; tenant_id is still derived server-side.
      const dispatch = await bus.emit(
        'order.placed',
        { id: '1' },
        {
          source: 'totally-trusted-billing-service',
        },
      );
      expect(dispatch.tenantId).toBe('tenant-a');
      // The label is recorded but carries no authority.
      expect(dispatch.source).toBe('totally-trusted-billing-service');
    });

    it('rejects the reserved in-memory sentinel as an emit source', async () => {
      // The contract is "rejected" — impersonating the in-memory pseudo-source
      // throws rather than being silently rewritten (S5 #1398).
      await expect(
        bus.emit('order.placed', { id: '1' }, { source: '_in_memory_' }),
      ).rejects.toThrow(/reserved source/i);
    });

    it('rejects subscribing under the reserved in-memory subscriber name', async () => {
      await expect(
        bus.subscribe({
          signalType: 'order.placed',
          subscriber: '_in_memory_',
        }),
      ).rejects.toThrow(/reserved subscriber/i);
    });

    it('rejects an empty subscriber name', async () => {
      await expect(
        bus.subscribe({ signalType: 'order.placed', subscriber: '  ' }),
      ).rejects.toThrow(/non-empty subscriber/i);
    });
  });

  describe('subscription identity is tenant-scoped (S5 #1398)', () => {
    it('tenant B cannot clobber tenant A subscription, and A keeps processing', async () => {
      // Tenant A subscribes with compete delivery (default).
      activeTenant = 'tenant-a';
      await bus.subscribe({ signalType: 'order.placed', subscriber: 'worker' });

      // Tenant B registers the SAME (signal_type, subscriber) — must be an
      // independent row, not an overwrite of A's. Use fanout to make the
      // delivery mode observably different if rows were shared.
      activeTenant = 'tenant-b';
      await bus.subscribe({
        signalType: 'order.placed',
        subscriber: 'worker',
        delivery: 'fanout',
      });

      // Both tenants' subscriptions coexist (2 rows total, scoped per tenant).
      activeTenant = 'tenant-a';
      const aSubs = await bus.listSubscriptions('worker');
      expect(aSubs).toHaveLength(1);
      expect(aSubs[0].delivery).toBe('compete');

      activeTenant = 'tenant-b';
      const bSubs = await bus.listSubscriptions('worker');
      expect(bSubs).toHaveLength(1);
      expect(bSubs[0].delivery).toBe('fanout');

      // Tenant A's dispatch is still claimable by tenant A's worker.
      activeTenant = 'tenant-a';
      await bus.emit('order.placed', { id: 'a-1' }, { source: 'orders' });
      const seenByA: unknown[] = [];
      const processedByA = await bus.process('worker', async (payload) => {
        seenByA.push(payload);
      });
      expect(processedByA).toBe(1);
      expect(seenByA).toEqual([{ id: 'a-1' }]);
    });

    it('tenant B cannot unsubscribe tenant A subscription', async () => {
      activeTenant = 'tenant-a';
      await bus.subscribe({ signalType: 'order.placed', subscriber: 'worker' });

      // Tenant B attempts to remove the (signal_type, subscriber) pair.
      activeTenant = 'tenant-b';
      await bus.unsubscribe('order.placed', 'worker');

      // Tenant A's subscription survives.
      activeTenant = 'tenant-a';
      const aSubs = await bus.listSubscriptions('worker');
      expect(aSubs).toHaveLength(1);
    });
  });

  describe('atomic claim prevents double processing (S5 #1398)', () => {
    it('a single global dispatch is processed at most once across concurrent processors', async () => {
      // No tenancy → both processors share the same global compete dispatch.
      setDispatchTenantResolver(undefined);
      await bus.subscribe({ signalType: 'order.placed', subscriber: 'worker' });
      await bus.emit('order.placed', { id: 'once' }, { source: 'orders' });

      // Two concurrent process() calls race for the same pending row. The
      // atomic conditional claim must let exactly one win.
      const seen: unknown[] = [];
      const [a, b] = await Promise.all([
        bus.process('worker', async (payload) => {
          seen.push(payload);
        }),
        bus.process('worker', async (payload) => {
          seen.push(payload);
        }),
      ]);

      expect(a + b).toBe(1);
      expect(seen).toEqual([{ id: 'once' }]);
    });
  });
});
