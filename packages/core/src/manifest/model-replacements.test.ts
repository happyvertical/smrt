import { describe, expect, it } from 'vitest';
import { manifestEntry } from '../registry/__tests__/helpers/consumer-workspace';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import {
  annotateModelReplacements,
  assertSameNameSubclassChoices,
  isReplacedModel,
  modelReplacements,
} from './model-replacements';
import { selectObjectDeclarations } from './object-declarations';

function model(
  pkg: string,
  parent?: string,
  tableName = 'customers',
  replaceParent: boolean | undefined = parent ? true : undefined,
): SmartObjectDefinition {
  // This case deliberately exercises the decorator table fallback, without a
  // precomputed schema or root extends edge. Reuse the shared entry factory.
  const {
    schema: _schema,
    extends: _extends,
    ...definition
  } = manifestEntry({
    className: 'Customer',
    packageName: pkg,
    filePath: `/${pkg}/customer.ts`,
    tableName,
    fields: {},
  });
  return {
    ...definition,
    decoratorConfig: {
      ...definition.decoratorConfig,
      ...(replaceParent === undefined ? {} : { replaceParent }),
    },
    collection: 'customers',
    ...(parent
      ? { extends: 'Customer', extendsQualified: `${parent}:Customer` }
      : {}),
  };
}
function manifest(...models: SmartObjectDefinition[]): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 0,
    objects: Object.fromEntries(models.map((obj) => [obj.qualifiedName!, obj])),
  };
}

describe('effective manifest identities', () => {
  it('collapses an N-level replacement chain and row type without dropping declarations', () => {
    const source = manifest(
      model('@fixture/base'),
      model('@fixture/middle', '@fixture/base'),
      model('@fixture/app', '@fixture/middle'),
    );
    const annotated = annotateModelReplacements(source);
    expect(annotated.objects['@fixture/base:Customer'].replacedBy).toBe(
      '@fixture/app:Customer',
    );
    expect(annotated.objects['@fixture/middle:Customer'].replacedBy).toBe(
      '@fixture/app:Customer',
    );
    expect(Object.keys(annotated.objects)).toHaveLength(3);
    expect(
      selectObjectDeclarations(annotated).map((entry) => entry.interfaceName),
    ).toEqual(['CustomerData']);
    expect(source.objects['@fixture/base:Customer'].replacedBy).toBeUndefined();
  });
  it('leaves unrelated models independent', () => {
    expect(
      modelReplacements(
        manifest(model('@fixture/base'), model('@fixture/peer')),
      ).size,
    ).toBe(0);
  });
  it('replaces only where the subclass declares replaceParent: true, never by name and table', () => {
    const base = model('@fixture/base');
    const replacement = model('@fixture/app', '@fixture/base');
    const declared = manifest(base, replacement);
    expect(modelReplacements(declared)).toEqual(
      new Map([['@fixture/base:Customer', '@fixture/app:Customer']]),
    );
    expect(isReplacedModel(declared, base)).toBe(true);
    expect(isReplacedModel(declared, replacement)).toBe(false);
    // The same name and table without the declaration is not a replacement
    // (generation refuses such a class; the map alone never guesses).
    for (const replaceParent of [undefined, false]) {
      const subclass = model(
        '@fixture/app',
        '@fixture/base',
        'customers',
        replaceParent,
      );
      if (replaceParent === undefined)
        subclass.decoratorConfig = { tableName: 'customers' };
      const source = manifest(base, subclass);
      expect(modelReplacements(source).size).toBe(0);
      expect(isReplacedModel(source, base)).toBe(false);
    }
  });
  it('refuses a same-named subclass that declares no choice, with or without its parent in the manifest', () => {
    const undeclared = model('@fixture/app', '@fixture/base', 'customers');
    undeclared.decoratorConfig = { tableName: 'customers' };
    for (const source of [
      manifest(model('@fixture/base'), undeclared),
      manifest(undeclared),
    ]) {
      // Manifest generation refuses it; the replacement map alone (also read
      // from run-time manifests) never treats it as a replacement.
      expect(modelReplacements(source).size).toBe(0);
      expect(() => assertSameNameSubclassChoices(source)).toThrow(
        expect.objectContaining({
          code: 'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED',
          message: expect.stringMatching(
            /@fixture\/app:Customer extends @fixture\/base:Customer.*replaceParent: true.*different class name/s,
          ),
        }),
      );
      expect(() => annotateModelReplacements(source)).toThrow(/replaceParent/);
    }
  });
  it('refuses replaceParent: false on any table, with or without its parent in the manifest', () => {
    for (const table of ['customers', 'other_customers']) {
      const coexisting = model('@fixture/app', '@fixture/base', table, false);
      for (const source of [
        manifest(model('@fixture/base'), coexisting),
        manifest(coexisting),
      ]) {
        expect(() => annotateModelReplacements(source)).toThrow(
          expect.objectContaining({
            code: 'CONFIG_SAME_NAME_COEXISTENCE_UNSUPPORTED',
            message: expect.stringMatching(
              /^@fixture\/app:Customer declares replaceParent: false, but a same-named subclass cannot be registered next to its parent @fixture\/base:Customer: give @fixture\/app:Customer a different class name, or declare replaceParent: true/,
            ),
          }),
        );
      }
    }
  });
  it('refuses a replacement on another table than its parent', () => {
    const otherTable = manifest(
      model('@fixture/base'),
      model('@fixture/app', '@fixture/base', 'other_customers', true),
    );
    expect(modelReplacements(otherTable).size).toBe(0);
    expect(() => annotateModelReplacements(otherTable)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH',
        message: expect.stringMatching(
          /remove the tableName from @fixture\/app:Customer, or give @fixture\/app:Customer a different class name/,
        ),
      }),
    );
  });
  it('refuses siblings and cycles instead of choosing by scan order', () => {
    expect(() =>
      modelReplacements(
        manifest(
          model('@fixture/base'),
          model('@fixture/left', '@fixture/base'),
          model('@fixture/right', '@fixture/base'),
        ),
      ),
    ).toThrow(/Sibling/);
    expect(() =>
      modelReplacements(
        manifest(
          model('@fixture/a', '@fixture/b'),
          model('@fixture/b', '@fixture/a'),
        ),
      ),
    ).toThrow(/Cyclic/);
  });
});
