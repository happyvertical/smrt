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

    it('a no-context processor sees all tenants (system/global scope)', async () => {
      activeTenant = 'tenant-a';
      await bus.subscribe({
        signalType: 'order.placed',
        subscriber: 'sysworker',
      });
      await bus.emit('order.placed', { id: 'a' }, { source: 'orders' });

      // No active context → system scope sees the dispatch.
      activeTenant = undefined;
      const seen: unknown[] = [];
      const processed = await bus.process('sysworker', async (payload) => {
        seen.push(payload);
      });
      expect(processed).toBe(1);
      expect(seen).toEqual([{ id: 'a' }]);
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
      const dispatch = await bus.emit(
        'order.placed',
        { id: '1' },
        {
          source: '_in_memory_',
        },
      );
      // Impersonation of the in-memory pseudo-source is neutralized.
      expect(dispatch.source).toBe('unknown');
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
});
