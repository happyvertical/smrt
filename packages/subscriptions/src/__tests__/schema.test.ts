import { generateDDLForEngine, ObjectRegistry } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { TenantSubscription } from '../models/TenantSubscription.js';
import { TenantUsageMetric } from '../models/TenantUsageMetric.js';

describe('subscription schemas', () => {
  it.each([
    [TenantSubscription.name, '_smrt_tenant_subscriptions'],
    [TenantUsageMetric.name, '_smrt_tenant_usage_metrics'],
  ])('%s uses a native UUID tenant column without an empty default', (name, tableName) => {
    const schema = ObjectRegistry.getSchema(name);

    if (!schema) {
      throw new Error(`Expected schema for ${name}`);
    }

    expect(schema.tableName).toBe(tableName);
    expect(schema.columns.tenant_id).toMatchObject({
      type: 'UUID',
      referenceKind: 'tenantId',
    });
    expect(schema.columns.tenant_id.defaultValue).toBeUndefined();

    const ddl = generateDDLForEngine(schema, 'postgres').createTable;
    expect(ddl).toContain('"tenant_id" uuid');
    expect(ddl).not.toContain('"tenant_id" uuid DEFAULT');
  });
});
