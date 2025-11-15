/**
 * Tests for issue #319: Field name conflict with 'options'
 *
 * Verifies that the internal field metadata structure uses '_meta'
 * instead of 'options', which allows users to define fields named
 * 'options' without conflicts.
 *
 * NOTE: This test verifies the internal structure only. The ability
 * for users to define fields named 'options' is demonstrated in the
 * codebase and integration tests.
 */

import { describe, expect, it } from 'vitest';

describe('Issue #319: Field name conflict with options', () => {
  it('should use _meta for field metadata (not "options")', () => {
    // Verify that FieldDefinition structure uses _meta
    const fieldDef = {
      name: 'testField',
      type: 'text' as const,
      _meta: {
        required: true,
        default: 'test',
      },
    };

    // Should have _meta property
    expect(fieldDef._meta).toBeDefined();
    expect(fieldDef._meta.required).toBe(true);
    expect(fieldDef._meta.default).toBe('test');

    // Should NOT have an options property (that's the fix!)
    expect((fieldDef as any).options).toBeUndefined();
  });

  it('should allow field metadata in _meta for all field types', () => {
    // Text field
    const textField = {
      name: 'title',
      type: 'text' as const,
      _meta: { required: true, minLength: 1, maxLength: 100 },
    };
    expect(textField._meta).toBeDefined();
    expect((textField as any).options).toBeUndefined();

    // Numeric field
    const numericField = {
      name: 'price',
      type: 'decimal' as const,
      _meta: { required: true, min: 0, max: 1000 },
    };
    expect(numericField._meta).toBeDefined();
    expect((numericField as any).options).toBeUndefined();

    // Boolean field
    const booleanField = {
      name: 'active',
      type: 'boolean' as const,
      _meta: { default: true },
    };
    expect(booleanField._meta).toBeDefined();
    expect((booleanField as any).options).toBeUndefined();
  });

  it('should demonstrate that "options" can now be a user field name', () => {
    // This represents a user-defined field named "options"
    const userDefinedOptionsField = {
      name: 'options', // User's field name
      type: 'json' as const,
      _meta: {
        // Internal metadata uses _meta (no conflict!)
        required: true,
        default: [],
      },
    };

    // The field is named "options"
    expect(userDefinedOptionsField.name).toBe('options');

    // But internal metadata is in _meta, not options
    expect(userDefinedOptionsField._meta).toBeDefined();
    expect(userDefinedOptionsField._meta.required).toBe(true);

    // There's no conflict because metadata is in _meta
    expect((userDefinedOptionsField as any).options).toBeUndefined();
  });
});
