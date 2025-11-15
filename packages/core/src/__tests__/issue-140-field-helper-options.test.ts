/**
 * Test for Issue #140: AST scanner should parse @field() decorator options
 *
 * This tests whether the AST scanner correctly extracts options from
 * @field() decorators like @field({ required: true, maxLength: 100 })
 */

import { describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Test class with @field() decorator options
@smrt({ tableName: 'test_field_options' })
class TestFieldOptions extends SmrtObject {
  @field({ required: true })
  requiredField: string = '';

  @field({ required: false })
  optionalField: string = '';

  @field({ minLength: 3, maxLength: 20 })
  lengthConstrainedField: string = '';

  @field({ required: true, maxLength: 100, default: 'default value' })
  complexField: string = 'default value';
}

class TestFieldOptionsCollection extends SmrtCollection<TestFieldOptions> {
  static readonly _itemClass = TestFieldOptions;
}

describe('Issue #140: @field() decorator options parsing', () => {
  it('should extract options from @field() decorators', async () => {
    // Get field definitions from manifest
    const fields = await ObjectRegistry.getAllFields('TestFieldOptions');

    // Required field should have required: true option
    const requiredField = fields.get('requiredField');
    expect(requiredField).toBeDefined();
    expect(requiredField?._meta?.required).toBe(true);

    // Optional field should have required: false option
    const optionalField = fields.get('optionalField');
    expect(optionalField).toBeDefined();
    expect(optionalField?._meta?.required).toBe(false);

    // Length constrained field should have min/maxLength
    const lengthField = fields.get('lengthConstrainedField');
    expect(lengthField).toBeDefined();
    expect(lengthField?._meta?.minLength).toBe(3);
    expect(lengthField?._meta?.maxLength).toBe(20);

    // Complex field should have multiple options
    const complexField = fields.get('complexField');
    expect(complexField).toBeDefined();
    expect(complexField?._meta?.required).toBe(true);
    expect(complexField?._meta?.maxLength).toBe(100);
    expect(complexField?.options?.default).toBe('default value');
  });

  it('should store decorator options in the manifest', async () => {
    // Get class definition from registry
    const classDef = ObjectRegistry.getClass('TestFieldOptions');
    expect(classDef).toBeDefined();

    // Get fields which are loaded from manifest
    const fields = await ObjectRegistry.getAllFields('TestFieldOptions');
    expect(fields.size).toBeGreaterThan(0);

    // Verify field options are accessible
    const requiredField = fields.get('requiredField');
    expect(requiredField).toBeDefined();
    expect(requiredField?.options).toBeDefined();
    expect(requiredField?._meta?.required).toBe(true);
  });

  it('should handle fields with minimal decorator options', async () => {
    const fields = await ObjectRegistry.getAllFields('TestFieldOptions');

    const optionalField = fields.get('optionalField');
    expect(optionalField).toBeDefined();
    expect(optionalField?.type).toBe('text');

    // Options object exists even if just one option is set
    expect(optionalField?.options).toBeDefined();
    expect(optionalField?._meta?.required).toBe(false);
  });
});
