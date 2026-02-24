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

    describe('string literal union types', () => {
      it('should infer text for inline string literal union', () => {
        const field: RawFieldDefinition = {
          name: 'status',
          accessibility: 'public',
          typeAnnotation: "'pending' | 'ready' | 'archived'",
          initializer: "'pending'",
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        // Need to call toManifest first to set typeAliases (even empty)
        const adapterWithAliases = new ManifestAdapter();
        adapterWithAliases.toManifest([], { typeAliases: {} });

        const result = adapterWithAliases.inferFieldType(field);
        expect(result.type).toBe('text');
        expect(result.defaultValue).toBe('pending');
        expect(result.source).toBe('annotation');
      });

      it('should infer integer for number literal union', () => {
        const field: RawFieldDefinition = {
          name: 'priority',
          accessibility: 'public',
          typeAnnotation: '1 | 2 | 3',
          initializer: null,
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const adapterWithAliases = new ManifestAdapter();
        adapterWithAliases.toManifest([], { typeAliases: {} });

        const result = adapterWithAliases.inferFieldType(field);
        expect(result.type).toBe('integer');
        expect(result.source).toBe('annotation');
      });

      it('should resolve type alias to underlying literal union', () => {
        const field: RawFieldDefinition = {
          name: 'status',
          accessibility: 'public',
          typeAnnotation: 'PerformerStatus',
          initializer: "'pending'",
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const adapterWithAliases = new ManifestAdapter();
        adapterWithAliases.toManifest([], {
          typeAliases: { PerformerStatus: "'pending' | 'ready'" },
        });

        const result = adapterWithAliases.inferFieldType(field);
        expect(result.type).toBe('text');
        expect(result.defaultValue).toBe('pending');
      });

      it('should resolve type alias to primitive type', () => {
        const field: RawFieldDefinition = {
          name: 'label',
          accessibility: 'public',
          typeAnnotation: 'DisplayName',
          initializer: "''",
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const adapterWithAliases = new ManifestAdapter();
        adapterWithAliases.toManifest([], {
          typeAliases: { DisplayName: 'string' },
        });

        const result = adapterWithAliases.inferFieldType(field);
        expect(result.type).toBe('text');
      });

      it('should use string initializer heuristic as fallback', () => {
        const field: RawFieldDefinition = {
          name: 'status',
          accessibility: 'public',
          typeAnnotation: 'UnknownType',
          initializer: "'pending'",
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        // No type aliases — UnknownType won't resolve
        const adapterWithAliases = new ManifestAdapter();
        adapterWithAliases.toManifest([], { typeAliases: {} });

        const result = adapterWithAliases.inferFieldType(field);
        expect(result.type).toBe('text');
        expect(result.defaultValue).toBe('pending');
        expect(result.source).toBe('heuristic');
      });

      it('should still default to json for non-string complex types', () => {
        const field: RawFieldDefinition = {
          name: 'config',
          accessibility: 'public',
          typeAnnotation: 'SomeInterface',
          initializer: null,
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const adapterWithAliases = new ManifestAdapter();
        adapterWithAliases.toManifest([], { typeAliases: {} });

        const result = adapterWithAliases.inferFieldType(field);
        expect(result.type).toBe('json');
      });

      it('should infer json for inline object type literal (TSTypeLiteral)', () => {
        const field: RawFieldDefinition = {
          name: 'regexPatterns',
          accessibility: 'public',
          typeAnnotation: 'object',
          initializer: '{}',
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const adapter = new ManifestAdapter();
        adapter.toManifest([], { typeAliases: {} });

        const result = adapter.inferFieldType(field);
        expect(result.type).toBe('json');
        expect(result.required).toBe(false);
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
