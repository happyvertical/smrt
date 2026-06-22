import { describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import type { RawFieldDefinition } from '../types.js';

describe('ManifestAdapter', () => {
  const adapter = new ManifestAdapter();

  describe('inferFieldType', () => {
    describe('@field decorator options', () => {
      it('should preserve generic @field options in manifest metadata', () => {
        const field: RawFieldDefinition = {
          name: 'nonce',
          accessibility: 'public',
          typeAnnotation: 'string',
          initializer: "''",
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'field',
              arguments: [
                "{ required: true, unique: true, description: 'Replay nonce' }",
              ],
            },
          ],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const result = adapter.convertField(field);

        expect(result).toBeDefined();
        expect(result?.type).toBe('text');
        expect(result?.required).toBe(true);
        expect(result?.description).toBe('Replay nonce');
        expect(result?._meta?.required).toBe(true);
        expect(result?._meta?.unique).toBe(true);
      });

      it('should let nullable override required in @field options', () => {
        const field: RawFieldDefinition = {
          name: 'optionalName',
          accessibility: 'public',
          typeAnnotation: 'string',
          initializer: null,
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'field',
              arguments: ['{ required: true, nullable: true }'],
            },
          ],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const result = adapter.convertField(field);

        expect(result).toBeDefined();
        expect(result?.required).toBe(false);
        expect(result?._meta?.nullable).toBe(true);
      });
    });

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

      it('should let @foreignKey options override initializer-based requiredness', () => {
        const field: RawFieldDefinition = {
          name: 'assetId',
          accessibility: 'public',
          typeAnnotation: 'string',
          initializer: "''",
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'foreignKey',
              arguments: ['Asset', '{ required: true }'],
            },
          ],
        };

        const result = adapter.inferFieldType(field);

        expect(result.type).toBe('foreignKey');
        expect(result.related).toBe('Asset');
        expect(result.required).toBe(true);
        expect(result._meta?.required).toBe(true);
      });
    });

    describe('@tenantId decorator', () => {
      it('should mark tenant ID fields as UUID tenant references', () => {
        const field: RawFieldDefinition = {
          name: 'tenantId',
          accessibility: 'public',
          typeAnnotation: 'string',
          initializer: null,
          optional: true,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'tenantId',
              arguments: [''],
            },
          ],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const result = adapter.convertField(field);

        expect(result).toMatchObject({
          type: 'text',
          required: true,
          _meta: {
            sqlType: 'UUID',
            __tenancy: {
              isTenantIdField: true,
              autoFilter: true,
              required: true,
              autoPopulate: true,
              nullable: false,
            },
          },
        });
      });

      it('should preserve nullable tenant ID decorator options', () => {
        const field: RawFieldDefinition = {
          name: 'tenantId',
          accessibility: 'public',
          typeAnnotation: 'string | null',
          initializer: 'null',
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'tenantId',
              arguments: ['{ nullable: true, autoPopulate: false }'],
            },
          ],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const result = adapter.convertField(field);

        expect(result).toMatchObject({
          type: 'text',
          required: false,
          _meta: {
            sqlType: 'UUID',
            nullable: true,
            autoPopulate: false,
            __tenancy: {
              isTenantIdField: true,
              autoFilter: true,
              required: false,
              autoPopulate: false,
              nullable: true,
            },
          },
        });
      });
    });

    describe('negative numeric defaults (0 vs 0.0 heuristic)', () => {
      // Regression for the negative-initializer gap: the oxc extractor must
      // unwrap `UnaryExpression('-')` so `numericValue`/`hasDecimalPoint` are
      // populated for negatives. These assert the downstream inference the
      // populated fields drive.
      it('infers decimal with the negative default for `price: number = -1.5`', () => {
        const field: RawFieldDefinition = {
          name: 'price',
          accessibility: 'public',
          typeAnnotation: 'number',
          initializer: '-1.5',
          optional: false,
          hasDecimalPoint: true,
          numericValue: -1.5,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const result = adapter.inferFieldType(field);
        expect(result.type).toBe('decimal');
        expect(result.defaultValue).toBe(-1.5);
      });

      it('infers integer with the negative default for `count: number = -5`', () => {
        const field: RawFieldDefinition = {
          name: 'count',
          accessibility: 'public',
          typeAnnotation: 'number',
          initializer: '-5',
          optional: false,
          hasDecimalPoint: false,
          numericValue: -5,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const result = adapter.inferFieldType(field);
        expect(result.type).toBe('integer');
        expect(result.defaultValue).toBe(-5);
      });

      it('infers integer (not text) for unannotated `balance = -100`', () => {
        const field: RawFieldDefinition = {
          name: 'balance',
          accessibility: 'public',
          typeAnnotation: null,
          initializer: '-100',
          optional: false,
          hasDecimalPoint: false,
          numericValue: -100,
          decorators: [],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const result = adapter.inferFieldType(field);
        expect(result.type).toBe('integer');
        expect(result.defaultValue).toBe(-100);
        expect(result.source).toBe('heuristic');
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

      it('should treat string unions with null and undefined as optional text', () => {
        const field: RawFieldDefinition = {
          name: 'tenantId',
          accessibility: 'public',
          typeAnnotation: 'string | null | undefined',
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
        expect(result.type).toBe('text');
        expect(result.required).toBe(false);
        expect(result.source).toBe('annotation');
      });

      it('should not guess text from unresolved enum-member initializers', () => {
        const field: RawFieldDefinition = {
          name: 'status',
          accessibility: 'public',
          typeAnnotation: 'UserStatus',
          initializer: 'UserStatus.ACTIVE',
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
        expect(result.required).toBe(false);
        expect(result.source).toBe('default');
      });

      it('should let @field({ type: text }) override unresolved enum-member initializers', () => {
        const field: RawFieldDefinition = {
          name: 'status',
          accessibility: 'public',
          typeAnnotation: 'UserStatus',
          initializer: 'UserStatus.ACTIVE',
          optional: false,
          hasDecimalPoint: false,
          numericValue: null,
          decorators: [
            {
              name: 'field',
              arguments: ["{ type: 'text' }"],
            },
          ],
          isStatic: false,
          readonly: false,
          line: 1,
        };

        const adapterWithAliases = new ManifestAdapter();
        adapterWithAliases.toManifest([], { typeAliases: {} });

        const result = adapterWithAliases.convertField(field);
        expect(result?.type).toBe('text');
        expect(result?.required).toBe(false);
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
