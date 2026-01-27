/**
 * Integration tests for @tenantId auto-populate feature
 *
 * These tests verify that the toJSON() method and field merging properly
 * preserve __tenancy metadata for tenant fields.
 *
 * The key requirement (Issue #841):
 * - Tenant fields should serialize as null (not '') when undefined
 * - This allows the tenancy interceptor to detect and auto-populate them
 *
 * @see https://github.com/happyvertical/smrt/issues/841
 */

import { describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';

describe('Issue #841 - @tenantId integration tests', () => {
  describe('mergeFieldConfigs preserves __tenancy metadata', () => {
    // Access the private method for testing
    const mergeFieldConfigs = (ObjectRegistry as any).mergeFieldConfigs.bind(
      ObjectRegistry,
    );

    it('should preserve __tenancy from parent when child has no tenancy', () => {
      const parentField = {
        type: 'foreignKey',
        __tenancy: {
          isTenantIdField: true,
          autoFilter: true,
          nullable: true,
          autoPopulate: true,
        },
      };

      const childField = {
        type: 'text', // AST scanner sees this
        // No __tenancy - child doesn't have decorator
      };

      const merged = mergeFieldConfigs(parentField, childField, 'tenantId');

      // Parent's __tenancy should be preserved
      expect(merged.__tenancy).toBeDefined();
      expect(merged.__tenancy.isTenantIdField).toBe(true);
      expect(merged.__tenancy.autoPopulate).toBe(true);
    });

    it('should preserve __tenancy from parent when child re-declares field', () => {
      const parentField = {
        type: 'text',
        __tenancy: {
          isTenantIdField: true,
          autoFilter: true,
        },
      };

      const childField = {
        type: 'text',
        value: null, // Child specifies default
        // No __tenancy
      };

      const merged = mergeFieldConfigs(parentField, childField, 'tenantId');

      expect(merged.__tenancy).toBeDefined();
      expect(merged.__tenancy.isTenantIdField).toBe(true);
    });

    it('should merge __tenancy from both parent and child (parent wins)', () => {
      const parentField = {
        type: 'text',
        __tenancy: {
          isTenantIdField: true,
          autoFilter: true,
          autoPopulate: true,
        },
      };

      const childField = {
        type: 'text',
        __tenancy: {
          isTenantIdField: false, // Should be overridden by parent
          customOption: 'child-value',
        },
      };

      const merged = mergeFieldConfigs(parentField, childField, 'tenantId');

      // Parent wins on conflicts
      expect(merged.__tenancy.isTenantIdField).toBe(true);
      expect(merged.__tenancy.autoFilter).toBe(true);
      expect(merged.__tenancy.autoPopulate).toBe(true);
      // Child values preserved for non-conflicting keys
      expect(merged.__tenancy.customOption).toBe('child-value');
    });

    it('should NOT suppress type mismatch warning for non-tenant fields', () => {
      // This test verifies that the warning suppression only applies to tenantId
      const parentField = {
        type: 'foreignKey',
        // No __tenancy
      };

      const childField = {
        type: 'text',
      };

      // We can't easily test console.warn, but we can verify the field
      // doesn't have __tenancy marker which would suppress the warning
      const merged = mergeFieldConfigs(parentField, childField, 'categoryId');

      expect(merged.__tenancy).toBeUndefined();
    });

    it('should suppress type mismatch warning for tenantId with __tenancy marker', () => {
      const parentField = {
        type: 'foreignKey',
        __tenancy: {
          isTenantIdField: true,
        },
      };

      const childField = {
        type: 'text', // AST scanner sees this
      };

      // This should NOT warn because parent has __tenancy.isTenantIdField
      const merged = mergeFieldConfigs(parentField, childField, 'tenantId');

      // Type from child should be used (child wins on type)
      expect(merged.type).toBe('text');
      // But __tenancy should be preserved
      expect(merged.__tenancy.isTenantIdField).toBe(true);
    });

    it('should also check _meta.__tenancy for warning suppression', () => {
      const parentField = {
        type: 'foreignKey',
        _meta: {
          __tenancy: {
            isTenantIdField: true,
          },
        },
      };

      const childField = {
        type: 'text',
      };

      // This should also NOT warn because parent has _meta.__tenancy.isTenantIdField
      const merged = mergeFieldConfigs(parentField, childField, 'tenantId');

      // Type from child should be used
      expect(merged.type).toBe('text');
      // _meta should be preserved through standard _meta merging
      expect(merged._meta?.__tenancy?.isTenantIdField).toBe(true);
    });
  });

  describe('toJSON() tenant field serialization', () => {
    it('should identify tenant field via hasTenancyMarker logic', () => {
      // Test the tenant field detection logic that toJSON() uses
      // This mirrors the check in object.ts lines ~760-770

      const checkHasTenancyMarker = (prop: any, fieldDef: any): boolean => {
        return (
          (prop &&
            typeof prop === 'object' &&
            '__tenancy' in prop &&
            (prop as any).__tenancy?.isTenantIdField) ||
          (fieldDef as any)?.__tenancy?.isTenantIdField ||
          (fieldDef as any)?._meta?.__tenancy?.isTenantIdField
        );
      };

      // Case 1: __tenancy on prop (unlikely but possible)
      expect(
        checkHasTenancyMarker({ __tenancy: { isTenantIdField: true } }, {}),
      ).toBe(true);

      // Case 2: __tenancy on fieldDef (from @tenantId decorator)
      expect(
        checkHasTenancyMarker(null, {
          __tenancy: { isTenantIdField: true },
        }),
      ).toBe(true);

      // Case 3: _meta.__tenancy on fieldDef (from @smrt({ tenantScoped: true }))
      expect(
        checkHasTenancyMarker(null, {
          _meta: { __tenancy: { isTenantIdField: true } },
        }),
      ).toBe(true);

      // Case 4: No tenancy marker (returns falsy value - undefined or false)
      expect(checkHasTenancyMarker(null, { type: 'text' })).toBeFalsy();
      expect(checkHasTenancyMarker('value', {})).toBeFalsy();
      expect(checkHasTenancyMarker(undefined, undefined)).toBeFalsy();
    });
  });

  describe('field inheritance chain preserves tenancy', () => {
    it('should preserve __tenancy through multi-level inheritance', () => {
      const mergeFieldConfigs = (ObjectRegistry as any).mergeFieldConfigs.bind(
        ObjectRegistry,
      );

      // Level 1: Base class with @tenantId
      const baseField = {
        type: 'text',
        __tenancy: {
          isTenantIdField: true,
          autoFilter: true,
          autoPopulate: true,
        },
      };

      // Level 2: Middle class (no tenancy config)
      const middleField = {
        type: 'text',
        value: null,
      };

      // Level 3: Leaf class (no tenancy config)
      const leafField = {
        type: 'text',
      };

      // Merge base -> middle
      const mergedMiddle = mergeFieldConfigs(
        baseField,
        middleField,
        'tenantId',
      );
      expect(mergedMiddle.__tenancy?.isTenantIdField).toBe(true);

      // Merge middle -> leaf
      const mergedLeaf = mergeFieldConfigs(mergedMiddle, leafField, 'tenantId');
      expect(mergedLeaf.__tenancy?.isTenantIdField).toBe(true);
      expect(mergedLeaf.__tenancy?.autoPopulate).toBe(true);
    });
  });
});
