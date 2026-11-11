import { describe, expect, it } from 'vitest';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import {
  annotateModelReplacements,
  modelReplacements,
} from './model-replacements';
import { selectObjectDeclarations } from './object-declarations';

function model(
  pkg: string,
  parent?: string,
  tableName = 'customers',
): SmartObjectDefinition {
  return {
    name: 'customer',
    className: 'Customer',
    collection: 'customers',
    packageName: pkg,
    qualifiedName: `${pkg}:Customer`,
    filePath: `/${pkg}/customer.ts`,
    fields: {},
    methods: {},
    decoratorConfig: { tableName },
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
  it('leaves unrelated and explicitly separate-table models independent', () => {
    expect(
      modelReplacements(
        manifest(
          model('@fixture/base'),
          model('@fixture/peer'),
          model('@fixture/separate', '@fixture/base', 'other_customers'),
        ),
      ).size,
    ).toBe(0);
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
