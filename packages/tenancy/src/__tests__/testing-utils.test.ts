/**
 * Tests for the tenancy test-utility helpers (`src/testing.ts`) and the package
 * barrel (`src/index.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  getTenantId,
  TenantContextError,
  TenantIsolationError,
} from '../context';
import { isTenancyEnabled } from '../enabled-state';
// Import the package barrel so its re-exports are covered.
import * as pkg from '../index';
import {
  assertTenantContextRequired,
  assertTenantIsolationViolation,
  createTestTenantContext,
  resetTenancy,
  setupTestTenancy,
  testTenantIsolation,
} from '../testing';

describe('package barrel', () => {
  it('re-exports the public surface', () => {
    expect(typeof pkg.enableTenancy).toBe('function');
    expect(typeof pkg.withTenant).toBe('function');
    expect(typeof pkg.runTenantScopedEntryPoint).toBe('function');
    expect(typeof pkg.TenantScoped).toBe('function');
  });
});

describe('tenancy testing utilities', () => {
  afterEach(() => {
    resetTenancy();
  });

  it('setupTestTenancy enables tenancy; resetTenancy disables it', () => {
    setupTestTenancy({ enableInterceptors: true });
    expect(isTenancyEnabled()).toBe(true);
    resetTenancy();
    expect(isTenancyEnabled()).toBe(false);
  });

  it('setupTestTenancy can skip the interceptor', () => {
    setupTestTenancy({ enableInterceptors: false });
    expect(isTenancyEnabled()).toBe(false);
  });

  it('createTestTenantContext runs inside the given tenant', async () => {
    let observed: string | undefined;
    const result = await createTestTenantContext(
      { tenantId: 'test-tenant' },
      async () => {
        observed = getTenantId();
        return 'value';
      },
    );
    expect(observed).toBe('test-tenant');
    expect(result).toBe('value');
  });

  it('testTenantIsolation provides a runner per tenant', async () => {
    const seen: string[] = [];
    await testTenantIsolation(['tenant-a', 'tenant-b'], async (tenants) => {
      await tenants['tenant-a'](async () => {
        seen.push(getTenantId() as string);
      });
      await tenants['tenant-b'](async () => {
        seen.push(getTenantId() as string);
      });
    });
    expect(seen).toEqual(['tenant-a', 'tenant-b']);
  });

  describe('assertTenantContextRequired', () => {
    it('passes when fn throws TenantContextError', async () => {
      await assertTenantContextRequired(async () => {
        throw new TenantContextError('Tenant context required for X');
      });
    });

    it('verifies the message substring', async () => {
      await assertTenantContextRequired(async () => {
        throw new TenantContextError('Tenant context required for listing');
      }, 'listing');
    });

    it('throws when fn does not throw', async () => {
      await expect(
        assertTenantContextRequired(async () => undefined),
      ).rejects.toThrow(/no error was thrown/i);
    });

    it('throws when fn throws the wrong error type', async () => {
      await expect(
        assertTenantContextRequired(async () => {
          throw new Error('unrelated');
        }),
      ).rejects.toThrow(/Expected TenantContextError/i);
    });

    it('throws when the message substring is missing', async () => {
      await expect(
        assertTenantContextRequired(async () => {
          throw new TenantContextError('different message');
        }, 'expected-substring'),
      ).rejects.toThrow(/contain 'expected-substring'/i);
    });
  });

  describe('assertTenantIsolationViolation', () => {
    it('passes when fn throws TenantIsolationError', async () => {
      await assertTenantIsolationViolation(async () => {
        throw new TenantIsolationError('Tenant isolation violation in X');
      });
    });

    it('throws when fn does not throw', async () => {
      await expect(
        assertTenantIsolationViolation(async () => undefined),
      ).rejects.toThrow(/no error was thrown/i);
    });

    it('throws when fn throws the wrong error type', async () => {
      await expect(
        assertTenantIsolationViolation(async () => {
          throw new Error('unrelated');
        }),
      ).rejects.toThrow(/Expected TenantIsolationError/i);
    });

    it('verifies the message substring and reports a mismatch', async () => {
      await assertTenantIsolationViolation(async () => {
        throw new TenantIsolationError('cross-tenant read blocked');
      }, 'blocked');
      await expect(
        assertTenantIsolationViolation(async () => {
          throw new TenantIsolationError('some message');
        }, 'absent'),
      ).rejects.toThrow(/contain 'absent'/i);
    });
  });
});
