import { describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import type {
  RawFieldDefinition,
  RawMethodDefinition,
  ResolvedClassDefinition,
} from '../types.js';

/**
 * Field/method/collection conversion coverage for ManifestAdapter — the
 * decorator-option, exclusion, and pluralization branches that the publish
 * manifest depends on but the existing inferFieldType suite did not exercise.
 */
function field(
  partial: Partial<RawFieldDefinition> & { name: string },
): RawFieldDefinition {
  return {
    typeAnnotation: null,
    initializer: null,
    hasDecimalPoint: false,
    numericValue: null,
    decorators: [],
    optional: false,
    isStatic: false,
    readonly: false,
    accessibility: 'public',
    line: 1,
    ...partial,
  };
}

function method(
  partial: Partial<RawMethodDefinition> & { name: string },
): RawMethodDefinition {
  return {
    async: false,
    isStatic: false,
    accessibility: 'public',
    parameters: [],
    returnType: null,
    description: null,
    line: 1,
    ...partial,
  };
}

function resolved(
  partial: Partial<ResolvedClassDefinition> & { className: string },
): ResolvedClassDefinition {
  return {
    filePath: '/fixture.ts',
    extendsClause: 'SmrtObject',
    extendsTypeArg: null,
    decoratorConfig: {},
    hasSmartDecorator: true,
    fields: [],
    methods: [],
    startLine: 1,
    endLine: 2,
    inheritanceChain: [],
    stiBase: null,
    effectiveTableStrategy: 'cti',
    isSTI: false,
    isFrameworkBase: false,
    allFields: [],
    packageName: null,
    ...partial,
  };
}

describe('ManifestAdapter conversion', () => {
  const adapter = new ManifestAdapter();

  describe('convertField exclusions', () => {
    it('drops non-public fields', () => {
      expect(
        adapter.convertField(
          field({ name: 'secret', accessibility: 'private' }),
        ),
      ).toBeNull();
      expect(
        adapter.convertField(
          field({ name: 'secret', accessibility: 'protected' }),
        ),
      ).toBeNull();
    });

    it('drops framework-internal fields', () => {
      expect(adapter.convertField(field({ name: '_db' }))).toBeNull();
      expect(adapter.convertField(field({ name: '_tableName' }))).toBeNull();
    });

    it('marks Function-typed fields as transient', () => {
      const result = adapter.convertField(
        field({ name: 'onSave', typeAnnotation: 'Function' }),
      );
      expect(result?.transient).toBe(true);
    });

    it('honours an explicit @field({ transient: true })', () => {
      const result = adapter.convertField(
        field({
          name: 'computed',
          typeAnnotation: 'string',
          initializer: "''",
          decorators: [{ name: 'field', arguments: ['{ transient: true }'] }],
        }),
      );
      expect(result?.transient).toBe(true);
    });
  });

  describe('@field numeric/string constraints', () => {
    it('carries min/max/minLength/maxLength into the definition', () => {
      const result = adapter.convertField(
        field({
          name: 'score',
          typeAnnotation: 'number',
          initializer: '0',
          decorators: [
            {
              name: 'field',
              arguments: ['{ min: 1, max: 10, minLength: 2, maxLength: 8 }'],
            },
          ],
        }),
      );
      expect(result?.min).toBe(1);
      expect(result?.max).toBe(10);
      expect(result?.minLength).toBe(2);
      expect(result?.maxLength).toBe(8);
    });
  });

  describe('@field default/related/ignored-shape options', () => {
    it('applies default and related from @field options', () => {
      const result = adapter.convertField(
        field({
          name: 'parentId',
          typeAnnotation: 'string',
          decorators: [
            {
              name: 'field',
              arguments: ['{ default: "root", related: "Node" }'],
            },
          ],
        }),
      );
      expect(result?.default).toBe('root');
      expect(result?.related).toBe('Node');
    });

    it('promotes readPermission while preserving it in field metadata', () => {
      const result = adapter.convertField(
        field({
          name: 'wholesalePrice',
          typeAnnotation: 'number',
          initializer: '0.0',
          hasDecimalPoint: true,
          decorators: [
            {
              name: 'field',
              arguments: ['{ readPermission: "products.read.internal" }'],
            },
          ],
        }),
      );

      expect(result?.readPermission).toBe('products.read.internal');
      expect(result?._meta?.readPermission).toBe('products.read.internal');
    });

    it('ignores a non-object @field argument', () => {
      const result = adapter.convertField(
        field({
          name: 'label',
          typeAnnotation: 'string',
          initializer: "''",
          decorators: [{ name: 'field', arguments: ['[1, 2, 3]'] }],
        }),
      );
      // Array argument is not a valid options object → treated as plain text field.
      expect(result?.type).toBe('text');
    });
  });

  describe('@meta decorator', () => {
    it('flags STI meta storage and preserves indexed/nullable options', () => {
      const result = adapter.convertField(
        field({
          name: 'extra',
          typeAnnotation: 'string',
          decorators: [
            { name: 'meta', arguments: ['{ indexed: true, nullable: true }'] },
          ],
        }),
      );
      expect(result?.type).toBe('meta');
      expect(result?._meta?.indexed).toBe(true);
      expect(result?._meta?.nullable).toBe(true);
    });
  });

  describe('@crossPackageRef decorator', () => {
    it('captures the qualified target and standard option metadata', () => {
      const result = adapter.convertField(
        field({
          name: 'ownerId',
          typeAnnotation: 'string',
          decorators: [
            {
              name: 'crossPackageRef',
              arguments: [
                "'@happyvertical/smrt-profiles:Person'",
                '{ nullable: true, unique: true, description: "owner" }',
              ],
            },
          ],
        }),
      );
      expect(result?.type).toBe('crossPackageRef');
      expect(result?.related).toBe('@happyvertical/smrt-profiles:Person');
      expect(result?._meta?.unique).toBe(true);
      expect(result?._meta?.nullable).toBe(true);
    });
  });

  describe('convertMethod', () => {
    it('drops private/protected methods', () => {
      expect(
        adapter.convertMethod(
          method({ name: 'helper', accessibility: 'private' }),
        ),
      ).toBeNull();
      expect(
        adapter.convertMethod(
          method({ name: 'helper', accessibility: 'protected' }),
        ),
      ).toBeNull();
    });

    it('maps public methods with parameters, defaults, and return type', () => {
      const result = adapter.convertMethod(
        method({
          name: 'rename',
          async: true,
          isStatic: true,
          returnType: 'Promise<void>',
          description: 'Rename the record',
          parameters: [
            {
              name: 'next',
              type: 'string',
              optional: false,
              defaultValue: "'x'",
            },
            {
              name: 'force',
              type: 'boolean',
              optional: true,
              defaultValue: null,
            },
          ],
        }),
      );
      expect(result?.name).toBe('rename');
      expect(result?.async).toBe(true);
      expect(result?.isStatic).toBe(true);
      expect(result?.returnType).toBe('Promise<void>');
      expect(result?.parameters[0]).toMatchObject({
        name: 'next',
        default: 'x',
      });
      expect(result?.parameters[1]).toMatchObject({
        name: 'force',
        type: 'boolean',
      });
    });
  });

  describe('type inference heuristics without annotation', () => {
    it('infers integer from a bare numeric literal', () => {
      const result = adapter.convertField(
        field({ name: 'count', initializer: '1', numericValue: 1 }),
      );
      expect(result?.type).toBe('integer');
      expect(result?.default).toBe(1);
    });

    it('infers decimal from a bare decimal literal', () => {
      const result = adapter.convertField(
        field({
          name: 'price',
          initializer: '1.5',
          numericValue: 1.5,
          hasDecimalPoint: true,
        }),
      );
      expect(result?.type).toBe('decimal');
      expect(result?.default).toBe(1.5);
    });

    it('infers boolean from a bare boolean literal', () => {
      const result = adapter.convertField(
        field({ name: 'isRead', initializer: 'false' }),
      );
      expect(result?.type).toBe('boolean');
      expect(result?.default).toBe(false);
    });

    it('unwraps Meta<T> annotations to a meta field with underlying type', () => {
      const result = adapter.convertField(
        field({ name: 'detail', typeAnnotation: 'Meta<number>' }),
      );
      expect(result?.type).toBe('meta');
      expect(result?._meta?.underlyingType).toBe('integer');
    });
  });

  describe('relationship decorators', () => {
    it('captures @oneToMany related class and foreignKey', () => {
      const result = adapter.convertField(
        field({
          name: 'items',
          decorators: [
            {
              name: 'oneToMany',
              arguments: ['Item', '{ foreignKey: "parent_id" }'],
            },
          ],
        }),
      );
      expect(result?.type).toBe('oneToMany');
      expect(result?.related).toBe('Item');
      expect(result?._meta?.foreignKey).toBe('parent_id');
    });

    it('captures @manyToMany junction coordinates', () => {
      const result = adapter.convertField(
        field({
          name: 'tags',
          decorators: [
            {
              name: 'manyToMany',
              arguments: [
                'Tag',
                '{ through: "widget_tags", sourceKey: "widget_id", targetKey: "tag_id" }',
              ],
            },
          ],
        }),
      );
      expect(result?.type).toBe('manyToMany');
      expect(result?.related).toBe('Tag');
      expect(result?._meta?.through).toBe('widget_tags');
      expect(result?._meta?.sourceKey).toBe('widget_id');
      expect(result?._meta?.targetKey).toBe('tag_id');
    });
  });

  describe('static properties', () => {
    const uiSlots = field({
      name: 'uiSlots',
      isStatic: true,
      initializer: '{ main: ["card"] }',
    });

    it('captures own static uiSlots', () => {
      const def = adapter.toSmartObjectDefinition(
        resolved({
          className: 'Widget',
          fields: [uiSlots],
          allFields: [uiSlots],
        }),
      );
      expect(def.staticProperties?.uiSlots).toEqual({ main: ['card'] });
    });

    it('captures inherited static uiSlots not redeclared by the child', () => {
      const def = adapter.toSmartObjectDefinition(
        resolved({ className: 'Widget', fields: [], allFields: [uiSlots] }),
      );
      expect(def.staticProperties?.uiSlots).toEqual({ main: ['card'] });
    });
  });

  describe('collection pluralization', () => {
    const cases: Array<[string, string]> = [
      ['City', 'cities'],
      // Vowel + y → +s, not +ies (regression: Day must not become "daies").
      ['Day', 'days'],
      ['Key', 'keys'],
      ['Box', 'boxes'],
      ['Bus', 'buses'],
      ['Dish', 'dishes'],
      ['Watch', 'watches'],
      ['Widget', 'widgets'],
    ];

    for (const [className, expected] of cases) {
      it(`pluralizes ${className} -> ${expected}`, () => {
        const def = adapter.toSmartObjectDefinition(resolved({ className }));
        expect(def.collection).toBe(expected);
      });
    }
  });
});
