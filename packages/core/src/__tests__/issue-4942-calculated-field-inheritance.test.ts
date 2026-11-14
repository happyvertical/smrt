/**
 * Calculated fields (#4915) under the one inheritance rule (#4942, #4932).
 *
 * A redeclared field inherits its parent's options, `generated` included. A
 * redeclaration may not change whether a field is calculated: an inherited
 * ordinary field cannot become calculated (generated-field validation), and
 * an inherited calculated field cannot be cleared to an ordinary one
 * (`CONFIG_CALCULATED_FIELD_CLEARED`). A required calculated field that
 * carries a reason cannot be loosened either.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { registerRuntimeModel } from '../runtime-model.js';
import type { FieldDefinition } from '../scanner/types.js';
import { resolveInheritedFields } from '../schema/field-inheritance.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

const doubled = {
  op: 'mul',
  left: { col: 'qty' },
  right: { value: 2 },
} as unknown as FieldDefinition['generated'];

function resolveManifest(own: FieldDefinition): FieldDefinition | undefined {
  return resolveInheritedFields<FieldDefinition>({
    strategy: 'own-table',
    className: 'Leaf',
    ancestors: [
      {
        name: 'Base',
        frameworkBase: false,
        fields: new Map<string, FieldDefinition>([
          ['qty', { type: 'integer' } as FieldDefinition],
          ['total', { type: 'integer', generated: doubled } as FieldDefinition],
        ]),
      },
    ],
    own: [['total', own]],
    representation: 'manifest',
  }).get('total');
}

describe('calculated fields and the inheritance rule (#4915, #4942)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('a bare restatement inherits the expression (build path)', () => {
    const resolved = resolveManifest({
      type: 'integer',
      _meta: { __statedOptions: [] },
    } as FieldDefinition);
    expect(resolved?.generated ?? resolved?._meta?.generated).toEqual(doubled);
  });

  it('null cannot clear an inherited expression (build path)', () => {
    expect(() =>
      resolveManifest({
        type: 'integer',
        generated: null,
        _meta: { __statedOptions: ['generated'] },
      } as unknown as FieldDefinition),
    ).toThrow(
      expect.objectContaining({ code: 'CONFIG_CALCULATED_FIELD_CLEARED' }),
    );
  });

  for (const replaces of [false, true]) {
    it(`a run-time ${replaces ? 'replacement' : 'subclass'} cannot clear an inherited expression`, () => {
      const parent = registerRuntimeModel({
        name: 'CalcBase',
        packageName: '@test/calc',
        tableName: 'calc_bases',
        fields: {
          qty: { type: 'integer' },
          total: { type: 'integer', generated: doubled },
        },
      });
      const name = replaces ? 'CalcBase' : 'CalcLeaf';
      const packageName = replaces ? '@test/calc-app' : '@test/calc';
      expect(() =>
        registerRuntimeModel({
          name,
          packageName,
          extends: parent,
          ...(replaces ? { replaces: true } : {}),
          fields: {
            total: { type: 'integer', generated: null } as never,
          },
        }),
      ).toThrow(
        expect.objectContaining({ code: 'CONFIG_CALCULATED_FIELD_CLEARED' }),
      );
      expect(ObjectRegistry.getClass(`${packageName}:${name}`)).toBeUndefined();
    });

    it(`a run-time ${replaces ? 'replacement' : 'subclass'} cannot make a field smrt needs calculated`, () => {
      const Base = class CalcNeeded extends SmrtObject {};
      field({ type: 'integer' })(Base.prototype, 'qty');
      field({ type: 'integer', required: true, requiredFor: 'identity' })(
        Base.prototype,
        'code',
      );
      smrt({ packageName: '@test/calc-needed', tableName: 'calc_needed' })(
        Base,
      );
      const parent = ObjectRegistry.getClassByConstructor(Base)!.qualifiedName!;
      const name = replaces ? 'CalcNeeded' : 'CalcNeededLeaf';
      expect(() =>
        registerRuntimeModel({
          name,
          packageName: replaces ? '@test/calc-needed-app' : '@test/calc-needed',
          extends: parent,
          ...(replaces ? { replaces: true } : {}),
          fields: { code: { type: 'integer', generated: doubled } },
        }),
      ).toThrow(expect.objectContaining({ name: 'GeneratedFieldError' }));
    });
  }

  it('a run-time replacement cannot loosen a required calculated field with a reason', () => {
    const Base = class CalcReasoned extends SmrtObject {};
    field({ type: 'integer' })(Base.prototype, 'qty');
    field({
      type: 'integer',
      required: true,
      requiredFor: 'integrity',
      generated: doubled,
    })(Base.prototype, 'total');
    smrt({ packageName: '@test/calc-reasoned', tableName: 'calc_reasoned' })(
      Base,
    );
    const parent = ObjectRegistry.getClassByConstructor(Base)!.qualifiedName!;
    expect(() =>
      registerRuntimeModel({
        name: 'CalcReasoned',
        packageName: '@test/calc-reasoned-app',
        extends: parent,
        replaces: true,
        fields: { total: { type: 'integer', required: false } },
      }),
    ).toThrow(
      expect.objectContaining({ code: 'CONFIG_REQUIRED_FIELD_LOOSENED' }),
    );
  });

  it('a decorated own-table subclass that restates a calculated field keeps it calculated, column included', async () => {
    const Base = class CalcDecorated extends SmrtObject {};
    field({ type: 'integer' })(Base.prototype, 'qty');
    field({ type: 'integer', generated: doubled })(Base.prototype, 'total');
    smrt({ packageName: '@test/calc-deco', tableName: 'calc_decorated' })(Base);
    const Leaf = class CalcDecoratedLeaf extends Base {};
    field({ type: 'integer' })(Leaf.prototype, 'total');
    smrt({
      packageName: '@test/calc-deco',
      tableName: 'calc_decorated_leaves',
    })(Leaf);
    const fields = await ObjectRegistry.getAllFields(
      '@test/calc-deco:CalcDecoratedLeaf',
    );
    const total = fields.get('total');
    expect(total?.generated ?? total?._meta?.generated).toEqual(doubled);
    const schema = ObjectRegistry.getAllSchemasAsDefinitions({
      tables: ['calc_decorated_leaves'],
    }).calc_decorated_leaves;
    expect(schema?.columns.total?.generated).toBeDefined();
  });
});
