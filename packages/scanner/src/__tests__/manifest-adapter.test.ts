import { describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import type { RawFieldDefinition } from '../types.js';

describe('ManifestAdapter', () => {
  const adapter = new ManifestAdapter();

  describe('inferFieldType', () => {
    describe('@foreignKey decorator - Issue #846', () => {
      it('should respect TypeScript optional marker (?) for @foreignKey fields', () => {
        // Create a field with @foreignKey decorator and optional marker
        const field: RawFieldDefinition = {
          name: 'organizationId',
          accessibility: 'public',
          typeAnnotation: 'string',
          initializer: null,
          optional: true, // TypeScript optional marker (?)
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'foreignKey',
              arguments: ['Organization'],
            },
          ],
        };

        const result = adapter.inferFieldType(field);

        expect(result.type).toBe('foreignKey');
        expect(result.related).toBe('Organization');
        expect(result.required).toBe(false); // Should respect optional marker
      });

      it('should make @foreignKey fields required when no optional marker', () => {
        const field: RawFieldDefinition = {
          name: 'organizationId',
          accessibility: 'public',
          typeAnnotation: 'string',
          initializer: null,
          optional: false, // No optional marker
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'foreignKey',
              arguments: ['Organization'],
            },
          ],
        };

        const result = adapter.inferFieldType(field);

        expect(result.type).toBe('foreignKey');
        expect(result.required).toBe(true);
      });

      it('should make @foreignKey fields optional when they have a default value', () => {
        const field: RawFieldDefinition = {
          name: 'organizationId',
          accessibility: 'public',
          typeAnnotation: 'string',
          initializer: "'default-org-id'", // Has default value
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'foreignKey',
              arguments: ['Organization'],
            },
          ],
        };

        const result = adapter.inferFieldType(field);

        expect(result.type).toBe('foreignKey');
        expect(result.required).toBe(false); // Should be optional due to default value
      });
    });

    describe('@oneToMany and @manyToMany decorators', () => {
      it('should always set @oneToMany fields as not required', () => {
        const field: RawFieldDefinition = {
          name: 'items',
          accessibility: 'public',
          typeAnnotation: 'OrderItem[]',
          initializer: null,
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'oneToMany',
              arguments: ['OrderItem'],
            },
          ],
        };

        const result = adapter.inferFieldType(field);

        expect(result.type).toBe('oneToMany');
        expect(result.required).toBe(false);
      });

      it('should always set @manyToMany fields as not required', () => {
        const field: RawFieldDefinition = {
          name: 'tags',
          accessibility: 'public',
          typeAnnotation: 'Tag[]',
          initializer: null,
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'manyToMany',
              arguments: ['Tag'],
            },
          ],
        };

        const result = adapter.inferFieldType(field);

        expect(result.type).toBe('manyToMany');
        expect(result.required).toBe(false);
      });
    });
  });
});
