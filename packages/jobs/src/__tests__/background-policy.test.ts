import { describe, expect, it } from 'vitest';
import {
  assertWithinTenantCreationCap,
  backgroundEligible,
  clampRetries,
  getBackgroundEligibleMethods,
  isBackgroundEligibleMethod,
  MAX_JOB_RETRIES,
  TenantJobCapExceededError,
} from '../background-policy.js';

/**
 * Regression for S5 audit #1402 (MED/LOW): retry ceiling, per-tenant creation
 * cap, and the opt-in background-method allowlist.
 */
describe('clampRetries', () => {
  it('caps requests above MAX_JOB_RETRIES', () => {
    expect(clampRetries(1_000_000)).toBe(MAX_JOB_RETRIES);
    expect(clampRetries(MAX_JOB_RETRIES + 1)).toBe(MAX_JOB_RETRIES);
  });

  it('passes through in-range values and floors fractions', () => {
    expect(clampRetries(3)).toBe(3);
    expect(clampRetries(2.9)).toBe(2);
  });

  it('clamps invalid/negative input to 0', () => {
    expect(clampRetries(-5)).toBe(0);
    expect(clampRetries(Number.NaN)).toBe(0);
    expect(clampRetries(Number.POSITIVE_INFINITY)).toBe(MAX_JOB_RETRIES);
  });
});

describe('assertWithinTenantCreationCap', () => {
  it('throws when a tenant is at or above its cap', () => {
    expect(() => assertWithinTenantCreationCap('tenant-a', 10, 10)).toThrow(
      TenantJobCapExceededError,
    );
    expect(() => assertWithinTenantCreationCap('tenant-a', 11, 10)).toThrow(
      /reached its background-job cap/,
    );
  });

  it('allows creation below the cap', () => {
    expect(() =>
      assertWithinTenantCreationCap('tenant-a', 9, 10),
    ).not.toThrow();
  });

  it('exempts global (null) tenants and disabled caps', () => {
    expect(() => assertWithinTenantCreationCap(null, 999, 10)).not.toThrow();
    expect(() =>
      assertWithinTenantCreationCap('tenant-a', 999, 0),
    ).not.toThrow();
  });
});

describe('background-method allowlist', () => {
  it('allows any method when a class does not opt in', () => {
    class Unrestricted {}
    expect(getBackgroundEligibleMethods(Unrestricted)).toBeNull();
    expect(isBackgroundEligibleMethod(Unrestricted, 'anything')).toBe(true);
  });

  it('rejects non-allowlisted methods once a class opts in', () => {
    class Restricted {
      @backgroundEligible()
      allowed() {}

      forbidden() {}
    }

    const allow = getBackgroundEligibleMethods(Restricted);
    expect(allow).not.toBeNull();
    expect(allow?.has('allowed')).toBe(true);
    expect(isBackgroundEligibleMethod(Restricted, 'allowed')).toBe(true);
    expect(isBackgroundEligibleMethod(Restricted, 'forbidden')).toBe(false);
  });
});
