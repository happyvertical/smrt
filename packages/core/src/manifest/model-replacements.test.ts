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
  sameNameSubtypes,
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
  it('leaves unrelated models independent and refuses a separate-table subtype of a plain parent', () => {
    expect(
      modelReplacements(
        manifest(model('@fixture/base'), model('@fixture/peer')),
      ).size,
    ).toBe(0);
    // replaceParent: false is an STI subtype; another table does not make a
    // plain parent's family single-table inheritance.
    const separate = manifest(
      model('@fixture/base'),
      model('@fixture/separate', '@fixture/base', 'other_customers', false),
    );
    expect(modelReplacements(separate).size).toBe(0);
    expect(() => annotateModelReplacements(separate)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR',
      }),
    );
  });
  it('replaces only where the subclass declares it, never by name and table', () => {
    const sti = { ...model('@fixture/base') };
    sti.decoratorConfig = { ...sti.decoratorConfig, tableStrategy: 'sti' };
    const subtype = model(
      '@fixture/library',
      '@fixture/base',
      'customers',
      false,
    );
    const source = manifest(sti, subtype);
    expect(modelReplacements(source).size).toBe(0);
    expect(annotateModelReplacements(source)).toBe(source);
    // The subtype is addressed through its parent's surface: no row type,
    // route or tool of its own under the shared name.
    expect(isReplacedModel(source, subtype)).toBe(true);
    expect(isReplacedModel(source, sti)).toBe(false);
    expect(sameNameSubtypes(source)).toEqual(
      new Map([['@fixture/library:Customer', '@fixture/base:Customer']]),
    );
    expect(
      selectObjectDeclarations(source).map((entry) => entry.interfaceName),
    ).toEqual(['CustomerData']);
    // Its own collection name gives it a surface of its own.
    const named = {
      ...subtype,
      decoratorConfig: { ...subtype.decoratorConfig, collection: 'vips' },
    };
    expect(isReplacedModel(manifest(sti, named), named)).toBe(false);
    expect(sameNameSubtypes(manifest(sti, named)).size).toBe(0);
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
            /@fixture\/app:Customer extends @fixture\/base:Customer.*replaceParent: true.*replaceParent: false/s,
          ),
        }),
      );
      expect(() => annotateModelReplacements(source)).toThrow(/replaceParent/);
    }
  });
  it('refuses a subtype on a plain parent table and a replacement on another table', () => {
    expect(() =>
      annotateModelReplacements(
        manifest(
          model('@fixture/base'),
          model('@fixture/library', '@fixture/base', 'customers', false),
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR',
        message: expect.stringMatching(
          /@fixture\/library:Customer.*@fixture\/base:Customer.*replaceParent: true.*rename/s,
        ),
      }),
    );
    const otherTable = manifest(
      model('@fixture/base'),
      model('@fixture/app', '@fixture/base', 'other_customers', true),
    );
    expect(modelReplacements(otherTable).size).toBe(0);
    expect(() => annotateModelReplacements(otherTable)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH',
      }),
    );
  });
  it('refuses a subtype that declares another table than its single-table parent, as registration does', () => {
    const base = model('@fixture/base');
    base.decoratorConfig = { ...base.decoratorConfig, tableStrategy: 'sti' };
    const elsewhere = manifest(
      base,
      model('@fixture/library', '@fixture/base', 'other_customers', false),
    );
    expect(() => assertSameNameSubclassChoices(elsewhere)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_TABLE_MISMATCH',
        details: {
          className: '@fixture/library:Customer',
          parentName: '@fixture/base:Customer',
          childTable: 'other_customers',
          parentTable: 'customers',
        },
      }),
    );
    // On the parent's table, or naming none, it is accepted.
    const shared = model(
      '@fixture/library',
      '@fixture/base',
      'customers',
      false,
    );
    const unnamed = model('@fixture/library', '@fixture/base', 'x', false);
    delete unnamed.decoratorConfig.tableName;
    for (const subtype of [shared, unnamed])
      expect(() =>
        assertSameNameSubclassChoices(manifest(base, subtype)),
      ).not.toThrow();
  });
  it('treats a framework base as the family root, so a subtype of a plain SmrtObject parent fails the build', () => {
    for (const root of ['SmrtObject', '@happyvertical/smrt-core:SmrtObject']) {
      const plain = { ...model('@fixture/base'), extends: 'SmrtObject' };
      if (root.includes(':')) plain.extendsQualified = root;
      expect(() =>
        annotateModelReplacements(
          manifest(
            plain,
            model('@fixture/library', '@fixture/base', 'customers', false),
          ),
        ),
      ).toThrow(
        expect.objectContaining({
          code: 'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR',
          message: expect.stringContaining(
            '@fixture/library:Customer declares replaceParent: false, but its parent @fixture/base:Customer',
          ),
        }),
      );
    }
    // A parent outside this manifest still defers to registration.
    expect(() =>
      annotateModelReplacements(
        manifest(
          model('@fixture/library', '@fixture/base', 'customers', false),
        ),
      ),
    ).not.toThrow();
  });
  it('advises a remedy the parent allows when a replacement names another table', () => {
    const otherTable = model('@fixture/app', '@fixture/base', 'other', true);
    const message = (parent: SmartObjectDefinition) => {
      try {
        annotateModelReplacements(manifest(parent, otherTable));
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error('expected a refusal');
    };
    const plain = message(model('@fixture/base'));
    expect(plain).toMatch(
      /or rename @fixture\/app:Customer to keep it a separate model/,
    );
    expect(plain).not.toMatch(/declare replaceParent: false/);
    const sti = model('@fixture/base');
    sti.decoratorConfig = { ...sti.decoratorConfig, tableStrategy: 'sti' };
    expect(message(sti)).toMatch(
      /or declare replaceParent: false to register it as a subtype of @fixture\/base:Customer/,
    );
  });
  it('serves a replacement of a served subtype through the base, in manifest selection', () => {
    const base = model('@fixture/base');
    base.decoratorConfig = { ...base.decoratorConfig, tableStrategy: 'sti' };
    const middle = model(
      '@fixture/middle',
      '@fixture/base',
      'customers',
      false,
    );
    const leaf = model('@fixture/app', '@fixture/middle', 'customers', true);
    const source = manifest(base, middle, leaf);
    expect(isReplacedModel(source, middle)).toBe(true);
    expect(isReplacedModel(source, leaf)).toBe(true);
    expect(isReplacedModel(source, base)).toBe(false);
    expect(
      selectObjectDeclarations(source).map((entry) => entry.interfaceName),
    ).toEqual(['CustomerData']);
  });
  it('treats only the framework package as a framework root', () => {
    // A foreign `SmrtReport` outside this manifest is an unknown ancestor:
    // the build defers to registration rather than refusing.
    const parent = {
      ...model('@fixture/base'),
      extendsQualified: '@vendor/models:SmrtReport',
      extends: 'SmrtReport',
    };
    expect(() =>
      annotateModelReplacements(
        manifest(
          parent,
          model('@fixture/library', '@fixture/base', 'customers', false),
        ),
      ),
    ).not.toThrow();
    const framework = {
      ...parent,
      extendsQualified: '@happyvertical/smrt-reports:SmrtReport',
    };
    expect(() =>
      annotateModelReplacements(
        manifest(
          framework,
          model('@fixture/library', '@fixture/base', 'customers', false),
        ),
      ),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR',
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
