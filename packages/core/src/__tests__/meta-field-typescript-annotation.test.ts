/**
 * Test to verify Meta<T> field detection with TypeScript type annotations vs meta() helper
 *
 * According to SMRT documentation, TypeScript type annotations should work.
 * The AST scanner has explicit code to detect Meta<T> type references.
 *
 * This test verifies whether the detection actually works.
 */
import { describe, expect, it } from 'vitest';
import { type Meta, meta } from '../fields';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';

// Test with TypeScript type annotation (as documented)
@smrt()
class TestTypeAnnotation extends SmrtObject {
  // Using TypeScript type annotation
  metaField1: Meta<string> = '';
  metaField2: Meta<number> = 0;
  metaField3: Meta<boolean> = false;
  metaField4: Meta<string[]> = [];

  // Regular field for comparison
  regularField: string = 'regular';
}

// Test with meta() helper
@smrt()
class TestMetaHelper extends SmrtObject {
  // Using meta() helper
  metaField1 = meta<string>();
  metaField2 = meta<number>();
  metaField3 = meta<boolean>();
  metaField4 = meta<string[]>();

  // Regular field for comparison
  regularField: string = 'regular';
}

describe('Meta Field Detection: TypeScript Annotations vs Helpers', () => {
  describe('TypeScript Type Annotation: Meta<T>', () => {
    it('should detect Meta<T> type annotations', () => {
      const fields = ObjectRegistry.getFields('TestTypeAnnotation');

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
  });

  describe('meta() Field Helper', () => {
    it('should detect meta() helper fields', () => {
      const fields = ObjectRegistry.getFields('TestMetaHelper');

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
  });

  describe('Comparison', () => {
    it('both approaches should work identically', () => {
      const fieldsTypeAnnotation =
        ObjectRegistry.getFields('TestTypeAnnotation');
      const fieldsHelper = ObjectRegistry.getFields('TestMetaHelper');

      const typeAnnotationMetaFields = Array.from(
        fieldsTypeAnnotation.entries(),
      )
        .filter(([_, field]) => field.type === 'meta')
        .map(([name]) => name)
        .sort();

      const helperMetaFields = Array.from(fieldsHelper.entries())
        .filter(([_, field]) => field.type === 'meta')
        .map(([name]) => name)
        .sort();

      // Both should detect the same number of meta fields
      expect(typeAnnotationMetaFields.length).toBe(4);
      expect(helperMetaFields.length).toBe(4);

      // Both should detect the same field names
      expect(typeAnnotationMetaFields).toEqual(helperMetaFields);
    });
  });
});
