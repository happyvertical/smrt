/**
 * Test to verify Meta<T> field detection with TypeScript type annotations vs meta() helper
 *
 * According to SMRT documentation, TypeScript type annotations should work.
 * The AST scanner has explicit code to detect Meta<T> type references.
 *
 * This test verifies whether the detection actually works.
 */
import { describe, expect, it } from 'vitest';
import { meta } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Test with @meta() decorator
@smrt()
class TestMetaDecorator extends SmrtObject {
  // Using @meta() decorator
  @meta()
  metaField1: string = '';

  @meta()
  metaField2: number = 0;

  @meta()
  metaField3: boolean = false;

  @meta()
  metaField4: string[] = [];

  // Regular field for comparison
  regularField: string = 'regular';
}

describe('Meta Field Detection: @meta() Decorator', () => {
  describe('@meta() Decorator', () => {
    it('should detect @meta() decorated fields', () => {
      const fields = ObjectRegistry.getFields('TestMetaDecorator');

      // Check if meta fields are detected
      expect(fields.has('metaField1'), 'metaField1 should be detected').toBe(
        true,
      );
      expect(fields.has('metaField2'), 'metaField2 should be detected').toBe(
        true,
      );
      expect(fields.has('metaField3'), 'metaField3 should be detected').toBe(
        true,
      );
      expect(fields.has('metaField4'), 'metaField4 should be detected').toBe(
        true,
      );

      // Check if they're marked as type 'meta'
      const metaField1 = fields.get('metaField1');
      const metaField2 = fields.get('metaField2');
      const metaField3 = fields.get('metaField3');
      const metaField4 = fields.get('metaField4');

      expect(metaField1?.type, 'metaField1 should be type "meta"').toBe('meta');
      expect(metaField2?.type, 'metaField2 should be type "meta"').toBe('meta');
      expect(metaField3?.type, 'metaField3 should be type "meta"').toBe('meta');
      expect(metaField4?.type, 'metaField4 should be type "meta"').toBe('meta');

      // Regular field should NOT be meta
      const regularField = fields.get('regularField');
      expect(regularField?.type, 'regularField should be type "text"').toBe(
        'text',
      );
    });

    it('should properly handle meta fields with different types', () => {
      const fields = ObjectRegistry.getFields('TestMetaDecorator');

      const metaFields = Array.from(fields.entries())
        .filter(([_, field]) => field.type === 'meta')
        .map(([name]) => name)
        .sort();

      // Should detect all 4 meta fields
      expect(metaFields.length).toBe(4);
      expect(metaFields).toEqual([
        'metaField1',
        'metaField2',
        'metaField3',
        'metaField4',
      ]);
    });
  });
});
