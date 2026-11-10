/**
 * #4145: two packages export `Agreement` (smrt-commerce and smrt-sales). A
 * consumer subclass must name its parent's package in the manifest, or the
 * runtime cannot tell which `Agreement` it extends.
 */
import { describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import {
  importedParentQualifiedName,
  ManifestAdapter,
  scopedPackageOfSpecifier,
} from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';

const CONSUMER = '@anytown/dashboard';

function manifestObjects(source: string, packageName = CONSUMER) {
  const parsed = parseSource(source, '/app/src/lib/models/Contracts.ts');
  expect(parsed.errors).toEqual([]);
  const resolver = new InheritanceResolver();
  resolver.addClasses(parsed.classes);
  return new ManifestAdapter().toManifest(resolver.resolveAll(), {
    packageName,
  }).objects;
}

describe('#4145 import-qualified extends', () => {
  it('qualifies a parent named-imported from another package', () => {
    const objects = manifestObjects(`
      import { smrt } from '@happyvertical/smrt-core';
      import { Agreement } from '@happyvertical/smrt-commerce';
      @smrt({ tableStrategy: 'sti' })
      export class AdvertisingProductContract extends Agreement {}
    `);
    expect(objects[`${CONSUMER}:AdvertisingProductContract`]).toMatchObject({
      extends: 'Agreement',
      extendsQualified: '@happyvertical/smrt-commerce:Agreement',
    });
  });

  it('qualifies an aliased import by its exported name', () => {
    const objects = manifestObjects(`
      import { smrt } from '@happyvertical/smrt-core';
      import { Agreement as CommerceAgreement } from '@happyvertical/smrt-commerce';
      @smrt()
      export class Agreement extends CommerceAgreement {}
    `);
    expect(objects[`${CONSUMER}:Agreement`]).toMatchObject({
      extends: 'Agreement',
      extendsQualified: '@happyvertical/smrt-commerce:Agreement',
    });
  });

  it('qualifies a namespace member and keeps the simple name in extends', () => {
    const objects = manifestObjects(`
      import { smrt } from '@happyvertical/smrt-core';
      import * as commerce from '@happyvertical/smrt-commerce/server';
      @smrt()
      export class Retainer extends commerce.Agreement {}
    `);
    expect(objects[`${CONSUMER}:Retainer`]).toMatchObject({
      extends: 'Agreement',
      extendsQualified: '@happyvertical/smrt-commerce:Agreement',
    });
  });

  it('leaves same-package, framework, and untraceable parents unqualified', () => {
    const objects = manifestObjects(`
      import { smrt, SmrtObject } from '@happyvertical/smrt-core';
      import { Shared } from './shared';
      import { Aliased } from '$lib/models/aliased';
      import { AtAlias } from '@/models/at-alias';
      import Defaulted from '@happyvertical/smrt-commerce';
      import { Self } from '@anytown/dashboard';
      import type { TypeOnly } from '@happyvertical/smrt-sales';
      @smrt() export class Base extends SmrtObject {}
      @smrt() export class Local extends Base {}
      @smrt() export class Relative extends Shared {}
      @smrt() export class SvelteAlias extends Aliased {}
      @smrt() export class AtAliasChild extends AtAlias {}
      @smrt() export class DefaultChild extends Defaulted {}
      @smrt() export class SelfImport extends Self {}
      @smrt() export class TypeOnlyChild extends TypeOnly {}
    `);
    for (const [key, object] of Object.entries(objects)) {
      expect(object.extendsQualified, key).toBeUndefined();
    }
    expect(objects[`${CONSUMER}:Local`]?.extends).toBe('Base');
    expect(objects[`${CONSUMER}:Base`]?.extends).toBe('SmrtObject');
  });

  it('qualifies without an own package but never a framework base', () => {
    expect(
      importedParentQualifiedName(
        {
          extendsClause: 'Agreement',
          extendsSource: '@happyvertical/smrt-commerce',
        },
        undefined,
      ),
    ).toBe('@happyvertical/smrt-commerce:Agreement');
    expect(
      importedParentQualifiedName(
        { extendsClause: 'SmrtCollection', extendsSource: '@happyvertical/x' },
        CONSUMER,
      ),
    ).toBeUndefined();
  });

  it('maps only scoped bare specifiers to a package', () => {
    expect(scopedPackageOfSpecifier('@happyvertical/smrt-commerce')).toBe(
      '@happyvertical/smrt-commerce',
    );
    expect(
      scopedPackageOfSpecifier('@happyvertical/smrt-commerce/server'),
    ).toBe('@happyvertical/smrt-commerce');
    for (const specifier of [
      './agreement',
      '../agreement.js',
      '/abs/agreement',
      'node:events',
      'lodash',
      '@/models/agreement',
      '$lib/models/agreement',
      '#internal/agreement',
    ]) {
      expect(scopedPackageOfSpecifier(specifier), specifier).toBeUndefined();
    }
  });
});
