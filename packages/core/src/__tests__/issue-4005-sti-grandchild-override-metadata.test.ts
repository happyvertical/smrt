import { describe, expect, it } from 'vitest';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';

const pkg = '@test/sti4005';

/**
 * Three-level STI hierarchy mirroring the commerce Contract split (#3898 /
 * #4005): `Contract` declares `contractType` with rich metadata, the middle
 * class inherits it without redeclaring, and the leaf redeclares it bare
 * (as `override contractType = ContractType.ORDER` would convert).
 */
function fixture(): SmartObjectManifest {
  const base: SmartObjectDefinition = {
    className: 'Contract4005',
    name: 'contract4005',
    collection: 'contracts4005',
    packageName: pkg,
    filePath: '/test/Contract4005.ts',
    fields: {
      contractType: {
        type: 'text',
        enum: ['order', 'estimate', 'lease'],
        description: 'The kind of contract.',
      },
    },
    methods: {},
    decoratorConfig: { tableStrategy: 'sti', tableName: 'contracts_4005' },
  };
  const middle: SmartObjectDefinition = {
    className: 'SalesContract4005',
    name: 'salescontract4005',
    collection: 'salescontracts4005',
    packageName: pkg,
    filePath: '/test/SalesContract4005.ts',
    extends: base.className,
    extendsQualified: `${pkg}:${base.className}`,
    fields: {},
    methods: {},
    decoratorConfig: {},
  };
  const leaf: SmartObjectDefinition = {
    className: 'Order4005',
    name: 'order4005',
    collection: 'orders4005',
    packageName: pkg,
    filePath: '/test/Order4005.ts',
    extends: middle.className,
    extendsQualified: `${pkg}:${middle.className}`,
    fields: {
      // Bare override: carries its own type/required but no enum or
      // description source, exactly like the manifests built before #4005.
      contractType: { type: 'text', required: false },
    },
    methods: {},
    decoratorConfig: {},
  };
  return {
    version: '1',
    timestamp: 0,
    objects: {
      [`${pkg}:${base.className}`]: base,
      [`${pkg}:${middle.className}`]: middle,
      [`${pkg}:${leaf.className}`]: leaf,
    },
  };
}

describe('STI grandchild override metadata (#4005)', () => {
  it('fills enum and description on a bare leaf override from the declaring ancestor', () => {
    const manifest = fixture();
    new ManifestGenerator().mergeInheritedFields(manifest);
    const field = manifest.objects[`${pkg}:Order4005`].fields.contractType;
    // Leaf-wins: the leaf's own options survive the merge
    expect(field.type).toBe('text');
    expect(field.required).toBe(false);
    // Filled from the nearest declaring ancestor (two levels up)
    expect(field.enum).toEqual(['order', 'estimate', 'lease']);
    expect(field.description).toBe('The kind of contract.');
  });

  it.each([
    false,
    true,
  ])('uses nearest ancestor metadata regardless of object order (reversed: %s)', (reversed) => {
    const manifest = fixture();
    manifest.objects[`${pkg}:SalesContract4005`].fields.contractType = {
      type: 'text',
      enum: ['order', 'estimate'],
      description: 'A sales contract.',
    };
    if (reversed) {
      manifest.objects = Object.fromEntries(
        Object.entries(manifest.objects).reverse(),
      );
    }
    new ManifestGenerator().mergeInheritedFields(manifest);
    const field = manifest.objects[`${pkg}:Order4005`].fields.contractType;
    expect(field.enum).toEqual(['order', 'estimate']);
    expect(field.description).toBe('A sales contract.');
    expect(field.required).toBe(false);
  });

  it('preserves inherited storage options while composing nearer metadata', () => {
    const manifest = fixture();
    manifest.objects[`${pkg}:Contract4005`].fields.contractType.required = true;
    manifest.objects[`${pkg}:SalesContract4005`].fields.contractType = {
      type: 'text',
      required: false,
      enum: ['order'],
      description: 'A sales contract.',
    };
    manifest.objects[`${pkg}:Order4005`].fields = {};
    new ManifestGenerator().mergeInheritedFields(manifest);
    const field = manifest.objects[`${pkg}:Order4005`].fields.contractType;
    expect(field.required).toBe(true);
    expect(field.enum).toEqual(['order']);
    expect(field.description).toBe('A sales contract.');
  });

  it('keeps the leaf own description while still filling the enum', () => {
    const manifest = fixture();
    manifest.objects[`${pkg}:Order4005`].fields.contractType.description =
      'A customer purchase order.';
    new ManifestGenerator().mergeInheritedFields(manifest);
    const field = manifest.objects[`${pkg}:Order4005`].fields.contractType;
    expect(field.description).toBe('A customer purchase order.');
    expect(field.enum).toEqual(['order', 'estimate', 'lease']);
  });

  it('keeps the leaf own enum while still filling the description', () => {
    const manifest = fixture();
    manifest.objects[`${pkg}:Order4005`].fields.contractType.enum = ['order'];
    new ManifestGenerator().mergeInheritedFields(manifest);
    const field = manifest.objects[`${pkg}:Order4005`].fields.contractType;
    expect(field.enum).toEqual(['order']);
    expect(field.description).toBe('The kind of contract.');
  });
});
