/**
 * Tests for field merging with __tenancy metadata preservation
 *
 * Issue #841: @tenantId decorator's __tenancy metadata was being lost
 * during field merging when AST scanner registered a conflicting type.
 *
 * @see https://github.com/happyvertical/smrt/issues/841
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../registry';

describe('Field Merging - __tenancy Metadata Preservation (Issue #841)', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  describe('mergeFieldConfigs() __tenancy handling', () => {
    it('should preserve __tenancy metadata when parent has it', () => {
      // Simulate what happens when @tenantId decorator registers a field
      // and then AST scanner also registers the same field with different type
      const parentField = {
        type: 'foreignKey',
        related: 'Tenant',
        sqlType: 'TEXT',
        __tenancy: {
          isTenantIdField: true,
          autoFilter: true,
          autoPopulate: true,
          nullable: true,
        },
      };

      const childField = {
        type: 'text', // AST scanner sees "tenantId: string | null" as text
      };

      // Access the private method via reflection for testing
      const merged = (ObjectRegistry as any).mergeFieldConfigs(
        parentField,
        childField,
        'tenantId',
      );

      // __tenancy should be preserved from parent
      expect(merged.__tenancy).toBeDefined();
      expect(merged.__tenancy.isTenantIdField).toBe(true);
      expect(merged.__tenancy.autoFilter).toBe(true);
      expect(merged.__tenancy.autoPopulate).toBe(true);
      expect(merged.__tenancy.nullable).toBe(true);
    });

    it('should preserve __tenancy metadata when child has it', () => {
      const parentField = {
        type: 'text',
      };

      const childField = {
        type: 'foreignKey',
        __tenancy: {
          isTenantIdField: true,
          autoFilter: false,
          autoPopulate: true,
        },
      };

      const merged = (ObjectRegistry as any).mergeFieldConfigs(
        parentField,
        childField,
        'tenantId',
      );

      expect(merged.__tenancy).toBeDefined();
      expect(merged.__tenancy.isTenantIdField).toBe(true);
      expect(merged.__tenancy.autoFilter).toBe(false);
    });

    it('should merge __tenancy metadata with parent taking precedence', () => {
      // If both have __tenancy, parent (decorator) should win for conflicts
      const parentField = {
        type: 'foreignKey',
        __tenancy: {
          isTenantIdField: true,
          autoFilter: true, // Parent says true
          autoPopulate: true,
        },
      };

      const childField = {
        type: 'text',
        __tenancy: {
          isTenantIdField: false, // Child says false (parent should win)
          autoFilter: false, // Child says false (parent should win)
        },
      };

      const merged = (ObjectRegistry as any).mergeFieldConfigs(
        parentField,
        childField,
        'tenantId',
      );

      // Parent values should win
      expect(merged.__tenancy.isTenantIdField).toBe(true);
      expect(merged.__tenancy.autoFilter).toBe(true);
      expect(merged.__tenancy.autoPopulate).toBe(true);
    });

    it('should not warn about type mismatch for tenantId fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const parentField = {
        type: 'foreignKey',
        __tenancy: { isTenantIdField: true },
      };

      const childField = {
        type: 'text',
      };

      (ObjectRegistry as any).mergeFieldConfigs(
        parentField,
        childField,
        'tenantId',
      );

      // Should NOT warn for tenantId field type mismatch
      expect(warnSpy).not.toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('should still warn about type mismatch for non-tenant fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const parentField = {
        type: 'integer',
      };

      const childField = {
        type: 'text',
      };

      (ObjectRegistry as any).mergeFieldConfigs(
        parentField,
        childField,
        'regularField',
      );

      // Should warn for regular fields
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Field type mismatch'),
      );

      warnSpy.mockRestore();
    });

    it('should not create __tenancy if neither field has it', () => {
      const parentField = {
        type: 'text',
      };

      const childField = {
        type: 'text',
      };

      const merged = (ObjectRegistry as any).mergeFieldConfigs(
        parentField,
        childField,
        'name',
      );

      // No __tenancy on either, so merged should not have it
      expect(merged.__tenancy).toBeUndefined();
    });
  });

  describe('registerFieldDecorator with __tenancy', () => {
    it('should store __tenancy metadata when registered via decorator', () => {
      // Simulate what @tenantId decorator does
      ObjectRegistry.registerFieldDecorator('TestClass', 'tenantId', {
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

      // Get the registered field
      const fields = ObjectRegistry.getFieldDecorators('TestClass');
      const tenantIdField = fields?.get('tenantId');

      expect(tenantIdField).toBeDefined();
      expect(tenantIdField?.__tenancy).toBeDefined();
      expect(tenantIdField?.__tenancy?.isTenantIdField).toBe(true);
    });
  });
});
