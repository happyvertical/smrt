/**
 * Regression test for #1410 (security audit, Tier T3).
 *
 * All persisted analytics models must be `@TenantScoped` so the tenant
 * interceptor auto-filters reads and binds writes to the active tenant.
 * Before this fix, none of the four models were tenant-scoped, which leaked
 * cross-tenant data through the generated `list`/`get`/`create` API:
 *   - AnalyticsProperty exposed `apiSecret` / `providerMetadata` credentials
 *   - AnalyticsEvent exposed end-user PII (userId, clientId, ipAddress, ...)
 *   - AnalyticsDataStream exposed tenant-private platform configuration
 *   - AnalyticsReport exposed cached result rows + AI ops over other tenants
 */

import {
  getTenantScopedConfig,
  isTenantScopedClass,
} from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';

// Importing the models triggers the `@TenantScoped()` decorator side-effect
// which registers each class with the tenancy registry.
import { AnalyticsDataStream } from '../models/AnalyticsDataStream.js';
import { AnalyticsEvent } from '../models/AnalyticsEvent.js';
import { AnalyticsProperty } from '../models/AnalyticsProperty.js';
import { AnalyticsReport } from '../models/AnalyticsReport.js';

const PERSISTED_MODELS = [
  'AnalyticsProperty',
  'AnalyticsEvent',
  'AnalyticsDataStream',
  'AnalyticsReport',
] as const;

describe('analytics tenant isolation (#1410)', () => {
  // Reference the classes so the imports (and thus the decorator
  // registrations) are not tree-shaken away.
  it('keeps the model classes loaded', () => {
    expect(AnalyticsProperty.name).toBe('AnalyticsProperty');
    expect(AnalyticsEvent.name).toBe('AnalyticsEvent');
    expect(AnalyticsDataStream.name).toBe('AnalyticsDataStream');
    expect(AnalyticsReport.name).toBe('AnalyticsReport');
  });

  for (const className of PERSISTED_MODELS) {
    it(`registers ${className} as tenant-scoped`, () => {
      expect(isTenantScopedClass(className)).toBe(true);
    });

    it(`scopes ${className} in 'optional' mode (nullable tenantId)`, () => {
      const config = getTenantScopedConfig(className);
      expect(config).toBeDefined();
      expect(config?.mode).toBe('optional');
    });
  }

  it('declares a nullable tenantId field on every persisted model', () => {
    expect(new AnalyticsProperty({}).tenantId).toBeNull();
    expect(new AnalyticsEvent({}).tenantId).toBeNull();
    expect(new AnalyticsDataStream({}).tenantId).toBeNull();
    expect(new AnalyticsReport({}).tenantId).toBeNull();
  });

  it('binds tenantId from constructor options', () => {
    expect(new AnalyticsProperty({ tenantId: 't1' }).tenantId).toBe('t1');
    expect(new AnalyticsEvent({ tenantId: 't2' }).tenantId).toBe('t2');
    expect(new AnalyticsDataStream({ tenantId: 't3' }).tenantId).toBe('t3');
    expect(new AnalyticsReport({ tenantId: 't4' }).tenantId).toBe('t4');
  });
});
