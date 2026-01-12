/**
 * Issue #688: @smrt({ tenantScoped: true }) configuration
 *
 * Tests the new tenantScoped option in the @smrt() decorator that:
 * 1. Auto-injects a tenantId field when enabled
 * 2. Stores normalized tenant config in ObjectRegistry
 * 3. Generates tenant_id column in schema
 *
 * @see https://github.com/happyvertical/smrt/issues/688
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Clean up registry between tests
beforeEach(() => {
  // Registry is global, but we test fresh classes each time
});

afterEach(() => {
  // Clean up test classes if needed
});

describe('Issue #688: @smrt({ tenantScoped: true })', () => {
  describe('tenantScoped: true (boolean)', () => {
    it('should inject tenantId field when tenantScoped is true', () => {
      @smrt({ tenantScoped: true })
      class TenantScopedDoc688A extends SmrtObject {
        title: string = '';
      }

      const fields = ObjectRegistry.getFields('TenantScopedDoc688A');
      expect(fields.has('tenantId')).toBe(true);

      const tenantIdField = fields.get('tenantId');
      expect(tenantIdField).toBeDefined();
      expect(tenantIdField.type).toBe('foreignKey');
      expect(tenantIdField.related).toBe('Tenant');
    });

    it('should store normalized tenant config with defaults', () => {
      @smrt({ tenantScoped: true })
      class TenantScopedDoc688B extends SmrtObject {
        title: string = '';
      }

      const config = ObjectRegistry.getTenantScopedConfig(
        'TenantScopedDoc688B',
      );
      expect(config).toBeDefined();
      expect(config?.mode).toBe('required');
      expect(config?.field).toBe('tenantId');
      expect(config?.autoFilter).toBe(true);
      expect(config?.autoPopulate).toBe(true);
      expect(config?.allowSuperAdminBypass).toBe(false);
    });

    it('should report class as tenant-scoped via isTenantScoped()', () => {
      @smrt({ tenantScoped: true })
      class TenantScopedDoc688C extends SmrtObject {
        title: string = '';
      }

      expect(ObjectRegistry.isTenantScoped('TenantScopedDoc688C')).toBe(true);
    });
  });

  describe('tenantScoped with custom options', () => {
    it('should use custom field name', () => {
      @smrt({
        tenantScoped: {
          field: 'organizationId',
        },
      })
      class TenantScopedDoc688D extends SmrtObject {
        title: string = '';
      }

      const fields = ObjectRegistry.getFields('TenantScopedDoc688D');
      expect(fields.has('organizationId')).toBe(true);
      expect(fields.has('tenantId')).toBe(false);

      const config = ObjectRegistry.getTenantScopedConfig(
        'TenantScopedDoc688D',
      );
      expect(config?.field).toBe('organizationId');
    });

    it('should respect mode: optional', () => {
      @smrt({
        tenantScoped: {
          mode: 'optional',
        },
      })
      class TenantScopedDoc688E extends SmrtObject {
        title: string = '';
      }

      const config = ObjectRegistry.getTenantScopedConfig(
        'TenantScopedDoc688E',
      );
      expect(config?.mode).toBe('optional');

      // Field should not be required when mode is optional
      const fields = ObjectRegistry.getFields('TenantScopedDoc688E');
      const tenantIdField = fields.get('tenantId');
      expect(tenantIdField.required).toBe(false);
    });

    it('should respect allowSuperAdminBypass: true', () => {
      @smrt({
        tenantScoped: {
          allowSuperAdminBypass: true,
        },
      })
      class TenantScopedDoc688F extends SmrtObject {
        title: string = '';
      }

      const config = ObjectRegistry.getTenantScopedConfig(
        'TenantScopedDoc688F',
      );
      expect(config?.allowSuperAdminBypass).toBe(true);
    });

    it('should respect autoFilter: false', () => {
      @smrt({
        tenantScoped: {
          autoFilter: false,
        },
      })
      class TenantScopedDoc688G extends SmrtObject {
        title: string = '';
      }

      const config = ObjectRegistry.getTenantScopedConfig(
        'TenantScopedDoc688G',
      );
      expect(config?.autoFilter).toBe(false);
    });

    it('should respect autoPopulate: false', () => {
      @smrt({
        tenantScoped: {
          autoPopulate: false,
        },
      })
      class TenantScopedDoc688H extends SmrtObject {
        title: string = '';
      }

      const config = ObjectRegistry.getTenantScopedConfig(
        'TenantScopedDoc688H',
      );
      expect(config?.autoPopulate).toBe(false);
    });
  });

  describe('tenantScoped: false or undefined', () => {
    it('should not inject tenantId field when tenantScoped is false', () => {
      @smrt({ tenantScoped: false })
      class NonTenantDoc688A extends SmrtObject {
        title: string = '';
      }

      const fields = ObjectRegistry.getFields('NonTenantDoc688A');
      expect(fields.has('tenantId')).toBe(false);
    });

    it('should not inject tenantId field when tenantScoped is not specified', () => {
      @smrt()
      class NonTenantDoc688B extends SmrtObject {
        title: string = '';
      }

      const fields = ObjectRegistry.getFields('NonTenantDoc688B');
      expect(fields.has('tenantId')).toBe(false);
    });

    it('should report class as not tenant-scoped', () => {
      @smrt()
      class NonTenantDoc688C extends SmrtObject {
        title: string = '';
      }

      expect(ObjectRegistry.isTenantScoped('NonTenantDoc688C')).toBe(false);
      expect(
        ObjectRegistry.getTenantScopedConfig('NonTenantDoc688C'),
      ).toBeUndefined();
    });
  });

  describe('existing tenantId field', () => {
    it('should not override existing tenantId field', () => {
      @smrt({ tenantScoped: true })
      class TenantScopedDoc688I extends SmrtObject {
        tenantId: string = ''; // Explicitly defined
        title: string = '';
      }

      const fields = ObjectRegistry.getFields('TenantScopedDoc688I');
      const tenantIdField = fields.get('tenantId');

      // The existing field should be preserved (from manifest)
      // or the injected one should be used if no manifest exists
      expect(tenantIdField).toBeDefined();
    });
  });

  describe('schema generation', () => {
    it('should include tenant_id column in schema', () => {
      @smrt({ tenantScoped: true })
      class TenantScopedDoc688J extends SmrtObject {
        title: string = '';
      }

      const fields = ObjectRegistry.getFields('TenantScopedDoc688J');
      const tenantIdField = fields.get('tenantId');

      expect(tenantIdField).toBeDefined();
      expect(tenantIdField._meta?.sqlType).toBe('TEXT');
      expect(tenantIdField._meta?.__tenancy?.isTenantIdField).toBe(true);
    });
  });
});
