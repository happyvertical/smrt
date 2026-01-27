/**
 * Tests for Issue #841: @tenantId decorator auto-populate not working
 *
 * The bug was that tenantId was being set to empty string '' instead of
 * the tenant ID from context when creating objects inside withTenant().
 *
 * Root causes:
 * 1. Field merging didn't preserve __tenancy metadata
 * 2. toJSON() converted undefined tenant fields to empty string ''
 *
 * @see https://github.com/happyvertical/smrt/issues/841
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

describe('Issue #841: toJSON() should not convert tenant fields to empty string', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('should keep tenant field as null when value is undefined', async () => {
    // Register the class with decorated field (simulates @tenantId decorator)
    ObjectRegistry.registerFieldDecorator('TestProduct', 'tenantId', {
      type: 'foreignKey',
      related: 'Tenant',
      sqlType: 'TEXT',
      nullable: true,
      __tenancy: {
        isTenantIdField: true,
        autoFilter: true,
        autoPopulate: true,
        nullable: true,
      },
    });

    // Define the class (need to use @smrt for registration)
    @smrt()
    class TestProduct extends SmrtObject {
      tenantId: string | null = null;
      name: string = '';

      constructor(options: any = {}) {
        super(options);
        const { db, ai, fs, ...rest } = options;
        Object.assign(this, rest);
      }
    }

    // Create an instance without tenantId
    const product = new TestProduct({ name: 'Test Product' });
    await product.initialize();

    // The tenantId is undefined/null, not explicitly set
    // toJSON() should NOT convert it to '' because it's a tenant field
    const json = product.toJSON();

    // Tenant field should be null (for interceptor to auto-populate), not ''
    expect(json.tenantId).toBeNull();
  });

  it('should respect explicitly set tenantId value', async () => {
    ObjectRegistry.registerFieldDecorator('TestItem', 'tenantId', {
      type: 'foreignKey',
      related: 'Tenant',
      sqlType: 'TEXT',
      nullable: true,
      __tenancy: {
        isTenantIdField: true,
        autoFilter: true,
        autoPopulate: true,
        nullable: true,
      },
    });

    @smrt()
    class TestItem extends SmrtObject {
      tenantId: string | null = null;
      name: string = '';

      constructor(options: any = {}) {
        super(options);
        const { db, ai, fs, ...rest } = options;
        Object.assign(this, rest);
      }
    }

    // Create with explicit tenantId
    const item = new TestItem({
      name: 'Test Item',
      tenantId: 'tenant-123',
    });
    await item.initialize();

    const json = item.toJSON();

    // Explicit value should be preserved
    expect(json.tenantId).toBe('tenant-123');
  });

  it('should store __tenancy metadata via registerFieldDecorator', () => {
    // This test verifies that the decorator registration mechanism
    // properly stores the __tenancy metadata
    ObjectRegistry.registerFieldDecorator('TestClass', 'tenantId', {
      type: 'foreignKey',
      related: 'Tenant',
      __tenancy: {
        isTenantIdField: true,
        autoPopulate: true,
      },
    });

    const decorators = ObjectRegistry.getFieldDecorators('TestClass');
    const tenantIdField = decorators?.get('tenantId');

    expect(tenantIdField).toBeDefined();
    expect(tenantIdField?.__tenancy).toBeDefined();
    expect(tenantIdField?.__tenancy?.isTenantIdField).toBe(true);
    expect(tenantIdField?.__tenancy?.autoPopulate).toBe(true);
  });
});

// Integration tests with full collection workflow are skipped in this file
// because they require the database to be configured correctly, which is
// tested in the tenancy package's integration tests instead.
// The unit tests above verify the core fix:
// 1. __tenancy metadata is preserved during field merging
// 2. toJSON() doesn't convert tenant fields to empty string
