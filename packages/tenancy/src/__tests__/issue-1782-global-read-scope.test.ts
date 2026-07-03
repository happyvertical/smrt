/**
 * Regression tests for issue #1782 — the tenancy-interceptor contract the
 * generated REST/SvelteKit routes rely on to fail closed.
 *
 * The transports (core) handle a public/anonymous read of a `@TenantScoped`
 * model by injecting a `{ tenantId: null }` WHERE filter when no tenant context
 * is active, so the read returns global (NULL-tenant) rows only. That only works
 * if the interceptor:
 *
 *  1. leaves an explicit `{ tenantId: null }` filter UNTOUCHED when there is no
 *     context (optional mode) — otherwise the injected global filter would be
 *     stripped and every tenant's rows would leak again; and
 *  2. still scopes an authenticated read to the caller's own tenant — so the
 *     transports correctly DEFER to the interceptor when a context IS active
 *     (they inject nothing in that case).
 *
 * These assert both halves against the real interceptor, complementing the
 * core-side REST integration test (`issue-1782-tenant-read-scope.spec.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../context';
import { createTenantInterceptor, disableTenancy } from '../interceptor';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry';

const ctx = (className: string) => ({
  className,
  operation: 'list' as const,
  timestamp: new Date(),
});

describe('#1782: interceptor preserves the injected global read scope', () => {
  beforeEach(() => {
    registerTenantScopedClass('Doc', { mode: 'optional' });
  });

  afterEach(() => {
    unregisterTenantScopedClass('Doc');
    disableTenancy();
  });

  it('leaves an explicit { tenantId: null } filter untouched with no context', () => {
    const interceptor = createTenantInterceptor();

    // No active tenant + optional mode: the interceptor must NOT modify the
    // query, so the caller's injected global-only filter survives to SQL.
    const result = interceptor.beforeList?.(
      'Doc',
      { where: { tenantId: null } },
      ctx('Doc'),
    );

    // Undefined = "no change" — the { tenantId: null } the transport injected is
    // used as-is (=> WHERE tenant_id IS NULL => global rows only).
    expect(result).toBeUndefined();
  });

  it('scopes an authenticated read to the caller’s tenant (transports defer here)', async () => {
    const interceptor = createTenantInterceptor();

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const result = interceptor.beforeList?.('Doc', { where: {} }, ctx('Doc'));
      // With an active tenant the interceptor injects the tenant filter, so the
      // transports inject nothing — an authenticated read still sees ONLY its
      // own tenant's rows, never the global-only restriction.
      expect(
        (result as { where: Record<string, unknown> })?.where.tenantId,
      ).toBe('tenant-a');
    });
  });
});
