/**
 * Scan-time internal-model stamps. Manifest generation records which
 * collections are junction collections (ancestry ends at `SmrtJunction` or
 * `SmrtJunctionBase`, matched by name), which model each one joins (by the
 * item's import binding, never by spelling), and which models are system
 * models (resolved table starts with `_smrt_`). The stamps are facts only:
 * no generated surface changes because of them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertInternalStampsMatchSchema,
  ManifestGenerator,
} from '../manifest-generator';
import type { SmartObjectDefinition, SmartObjectManifest } from '../types';

const { APP, DEP, warn, manifests } = vi.hoisted(() => {
  const APP = '@stamp/app';
  const DEP = '@stamp/dep';
  const warn = vi.fn();
  const entry = (
    className: string,
    extra: Record<string, unknown>,
  ): Record<string, unknown> => ({
    name: className.toLowerCase(),
    className,
    qualifiedName: `${DEP}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `/node_modules/${DEP}/dist/${className}.js`,
    fields: { label: { type: 'text' } },
    methods: {},
    decoratorConfig: {},
    packageName: DEP,
    ...extra,
  });
  const manifests: Record<string, unknown> = {
    [DEP]: {
      version: '1.0.0',
      packageName: DEP,
      objects: {
        [`${DEP}:Asset`]: entry('Asset', {}),
        [`${DEP}:TagJunctionBase`]: entry('TagJunctionBase', {
          extends: 'SmrtJunction',
          fields: {},
        }),
        [`${DEP}:Job`]: entry('Job', {
          decoratorConfig: { tableStrategy: 'sti', tableName: '_smrt_jobs' },
        }),
        [`${DEP}:Run`]: entry('Run', {
          decoratorConfig: { tableStrategy: 'sti' },
          schema: { tableName: '_smrt_runs', columns: {}, indexes: [] },
        }),
      },
    },
  };
  return { APP, DEP, warn, manifests };
});

vi.mock('../../manifest/manifest-loader.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  loadExternalManifestSync: vi.fn(
    (packageName: string) => manifests[packageName] ?? null,
  ),
}));

vi.mock('@happyvertical/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
  }),
}));

function def(
  className: string,
  extra: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    collection: `${className.toLowerCase()}s`,
    filePath: `/repo/app/src/${className}.ts`,
    fields: { title: { type: 'text' } },
    methods: {},
    decoratorConfig: {},
    packageName: APP,
    ...extra,
  } as SmartObjectDefinition;
}

function junction(
  className: string,
  item: string,
  extra: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  return def(className, {
    extends: 'SmrtJunction',
    extendsTypeArg: item,
    itemBindings: [{ via: 'typeArg', name: item }],
    fields: {},
    ...extra,
  });
}

function generate(objects: SmartObjectDefinition[]): SmartObjectManifest {
  return new ManifestGenerator().generateManifest(
    [{ filePath: '/repo/app/src', objects, errors: [] }],
    { packageName: APP, smrtDependencies: [DEP] },
  );
}

const obj = (manifest: SmartObjectManifest, className: string) => {
  const found = Object.values(manifest.objects).find(
    (o) => o.className === className && o.packageName === APP,
  );
  if (!found) throw new Error(`missing ${className}`);
  return found;
};

const warnings = () => warn.mock.calls.map((call) => String(call[0]));

beforeEach(() => warn.mockClear());

describe('junction stamps', () => {
  it('stamps the junction collection and its local item; SmrtJunction and SmrtJunctionBase identical; no marker yet', () => {
    const manifest = generate([
      def('Tag'),
      def('Badge'),
      def('Other'),
      junction('TagLinks', 'Tag'),
      junction('BadgeLinks', 'Badge', { extends: 'SmrtJunctionBase' }),
      def('OtherCollection', {
        extends: 'SmrtCollection',
        extendsTypeArg: 'Other',
        itemBindings: [{ via: 'typeArg', name: 'Other' }],
        fields: {},
      }),
    ]);
    for (const [collection, item] of [
      ['TagLinks', 'Tag'],
      ['BadgeLinks', 'Badge'],
    ]) {
      expect(obj(manifest, collection)).toMatchObject({
        junction: true,
        junctionOf: `${APP}:${item}`,
      });
      expect(obj(manifest, collection).crossPackageJunction).toBeUndefined();
      expect(obj(manifest, collection).junctionItemUnresolved).toBeUndefined();
      expect(obj(manifest, item).internal).toBe('junction');
    }
    expect(obj(manifest, 'Other').internal).toBeUndefined();
    expect(obj(manifest, 'OtherCollection').junction).toBeUndefined();
    expect(obj(manifest, 'OtherCollection').junctionOf).toBeUndefined();
    // The rule marker is written only once defaults are baked, never here.
    expect(Object.hasOwn(manifest, 'exposureRules')).toBe(false);
  });

  it('stamps facts only: the junction item keeps the generated surface it had', () => {
    const asJunction = generate([def('Tag'), junction('TagLinks', 'Tag')]);
    const asPlain = generate([
      def('Tag'),
      junction('TagLinks', 'Tag', { extends: 'SmrtCollection' }),
    ]);
    expect(obj(asJunction, 'Tag').decoratorConfig).toEqual(
      obj(asPlain, 'Tag').decoratorConfig,
    );
    expect(obj(asJunction, 'TagLinks').decoratorConfig).toEqual(
      obj(asPlain, 'TagLinks').decoratorConfig,
    );
    expect(obj(asJunction, 'Tag').defaultedExposure).toBeUndefined();
  });

  it('local class named SmrtJunction is walked through, not matched', () => {
    const manifest = generate([
      def('Tag'),
      def('SmrtJunction', { extends: 'SmrtCollection', fields: {} }),
      junction('TagLinks', 'Tag'),
    ]);
    expect(obj(manifest, 'TagLinks').junction).toBeUndefined();
    expect(obj(manifest, 'Tag').internal).toBeUndefined();
  });

  it('junction base through a barrel re-export, an import alias and an intermediate base in a dependency: all stamped', () => {
    const manifest = generate([
      def('Tag'),
      def('Label'),
      def('Mark'),
      // `import { SmrtJunction } from './junction-barrel'`: the scanner keeps
      // the simple name; nothing qualifies it.
      junction('BarrelLinks', 'Tag'),
      // `import { SmrtJunction as J }`: the scanner records the exported name.
      junction('AliasLinks', 'Label'),
      junction('DepBaseLinks', 'Mark', {
        extends: 'TagJunctionBase',
        extendsQualified: `${DEP}:TagJunctionBase`,
      }),
    ]);
    for (const [collection, item] of [
      ['BarrelLinks', 'Tag'],
      ['AliasLinks', 'Label'],
      ['DepBaseLinks', 'Mark'],
    ]) {
      expect(obj(manifest, collection)).toMatchObject({
        junction: true,
        junctionOf: `${APP}:${item}`,
      });
      expect(obj(manifest, item).internal).toBe('junction');
    }
  });

  it('resolves a relative item import to the local model declared in that file', () => {
    const manifest = generate([
      def('Tag', { filePath: '/repo/app/src/models/tag.ts' }),
      def('Label', { filePath: '/repo/app/src/models/label.ts' }),
      junction('TagLinks', 'Tag', {
        filePath: '/repo/app/src/links/tag-links.ts',
        itemBindings: [
          { via: 'typeArg', name: 'Tag', source: '../models/tag.js' },
        ],
      }),
      junction('LabelLinks', 'Label', {
        filePath: '/repo/app/src/links/label-links.ts',
        itemBindings: [
          {
            via: 'typeArg',
            name: 'Label',
            source: '../models',
            file: '/repo/app/src/models/label.ts',
          },
        ],
      }),
    ]);
    expect(obj(manifest, 'TagLinks').junctionOf).toBe(`${APP}:Tag`);
    expect(obj(manifest, 'LabelLinks').junctionOf).toBe(`${APP}:Label`);
    expect(obj(manifest, 'Tag').internal).toBe('junction');
    expect(obj(manifest, 'Label').internal).toBe('junction');
  });

  it('cross-package junction flags collection, warns, leaves foreign item', () => {
    const manifest = generate([
      def('Owner'),
      junction('OwnerAssets', 'Asset', {
        itemBindings: [
          { via: 'typeArg', name: 'Asset', source: DEP, package: DEP },
        ],
      }),
    ]);
    expect(obj(manifest, 'OwnerAssets')).toMatchObject({
      junction: true,
      junctionOf: `${DEP}:Asset`,
      crossPackageJunction: true,
    });
    expect(obj(manifest, 'Owner').internal).toBeUndefined();
    expect(manifest.objects[`${DEP}:Asset`]).toBeUndefined();
    expect(warnings().join('\n')).toMatch(
      /INTERNAL_MODEL_CROSS_PACKAGE_JUNCTION/,
    );
  });

  it('aliased foreign item beside a same-named local model: local model not stamped, collection flagged cross-package', () => {
    const manifest = generate([
      def('Asset'),
      // `import { Asset as DepAsset } from '@stamp/dep'`, `SmrtJunction<DepAsset>`
      junction('OwnerAssets', 'DepAsset', {
        itemBindings: [
          { via: 'typeArg', name: 'Asset', source: DEP, package: DEP },
        ],
      }),
    ]);
    expect(obj(manifest, 'Asset').internal).toBeUndefined();
    expect(obj(manifest, 'OwnerAssets')).toMatchObject({
      junctionOf: `${DEP}:Asset`,
      crossPackageJunction: true,
    });
  });

  it('an item the dependency does not declare, or no binding at all, is unresolved: the collection is flagged and no model is stamped', () => {
    const manifest = generate([
      def('Asset'),
      def('Ghost'),
      junction('MissingLinks', 'Missing', {
        itemBindings: [
          { via: 'typeArg', name: 'Missing', source: DEP, package: DEP },
        ],
      }),
      junction('NoBindingLinks', 'Ghost', { itemBindings: undefined }),
      junction('UntracedLinks', 'Asset', {
        itemBindings: [{ via: 'typeArg', name: 'Asset', unresolved: true }],
      }),
      junction('AliasPathLinks', 'Asset', {
        itemBindings: [
          { via: 'typeArg', name: 'Asset', source: '$lib/models/asset' },
        ],
      }),
    ]);
    for (const collection of [
      'MissingLinks',
      'NoBindingLinks',
      'UntracedLinks',
      'AliasPathLinks',
    ]) {
      expect(obj(manifest, collection)).toMatchObject({
        junction: true,
        junctionItemUnresolved: true,
      });
      expect(obj(manifest, collection).junctionOf).toBeUndefined();
    }
    expect(obj(manifest, 'Asset').internal).toBeUndefined();
    expect(obj(manifest, 'Ghost').internal).toBeUndefined();
    expect(warnings().join('\n')).toMatch(
      /INTERNAL_MODEL_JUNCTION_ITEM_UNRESOLVED/,
    );
  });

  it('generic argument and _itemClass disagree: CONFIG_JUNCTION_ITEM_MISMATCH', () => {
    expect(() =>
      generate([
        def('Tag'),
        def('Label'),
        junction('TagLinks', 'Tag', {
          itemBindings: [
            { via: 'typeArg', name: 'Tag' },
            { via: 'itemClass', name: 'Label' },
          ],
        }),
      ]),
    ).toThrow(
      expect.objectContaining({ code: 'CONFIG_JUNCTION_ITEM_MISMATCH' }),
    );
    // Agreement, or one reference that does not trace, is not a mismatch.
    const manifest = generate([
      def('Tag'),
      junction('TagLinks', 'Tag', {
        itemBindings: [
          { via: 'typeArg', name: 'Tag' },
          { via: 'itemClass', name: 'Tag' },
        ],
      }),
      junction('HalfLinks', 'Tag', {
        itemBindings: [
          { via: 'typeArg', name: 'Tag', unresolved: true },
          { via: 'itemClass', name: 'Tag' },
        ],
      }),
    ]);
    expect(obj(manifest, 'TagLinks').junctionOf).toBe(`${APP}:Tag`);
    expect(obj(manifest, 'HalfLinks').junctionOf).toBe(`${APP}:Tag`);
  });

  it('collection ancestry that leaves the manifest through an unknown name is a warning and no stamp', () => {
    const manifest = generate([
      def('Tag'),
      def('MysteryLinks', {
        extends: 'SomeUnknownBase',
        extendsTypeArg: 'Tag',
        itemBindings: [{ via: 'typeArg', name: 'Tag' }],
        fields: {},
      }),
    ]);
    expect(obj(manifest, 'MysteryLinks').junction).toBeUndefined();
    expect(obj(manifest, 'Tag').internal).toBeUndefined();
    expect(warnings().join('\n')).toMatch(/INTERNAL_MODEL_UNRESOLVED_ANCESTRY/);
  });
});

describe('system stamps', () => {
  it('stamps a model whose own table starts with _smrt_, after normalisation', () => {
    const manifest = generate([
      def('Widget', { decoratorConfig: { tableName: '_smrt_widgets' } }),
      def('Plain', { decoratorConfig: { tableName: 'smrt_widgets' } }),
    ]);
    expect(obj(manifest, 'Widget').internal).toBe('system');
    expect(obj(manifest, 'Plain').internal).toBeUndefined();
  });

  it('_smrt_ only in schema.tableName gets the system stamp', () => {
    const manifest = generate([
      def('LocalRun', { extends: 'Run', extendsQualified: `${DEP}:Run` }),
    ]);
    expect(obj(manifest, 'LocalRun').schema?.tableName).toBe('_smrt_runs');
    expect(obj(manifest, 'LocalRun').internal).toBe('system');
  });

  it('STI child sharing an external _smrt_ base table is stamped; forced mismatch throws CONFIG_INTERNAL_STAMP_DRIFT', () => {
    const manifest = generate([
      def('LocalJob', { extends: 'Job', extendsQualified: `${DEP}:Job` }),
      def('Plain'),
    ]);
    expect(obj(manifest, 'LocalJob').schema?.tableName).toBe('_smrt_jobs');
    expect(obj(manifest, 'LocalJob').internal).toBe('system');
    expect(() => assertInternalStampsMatchSchema(manifest)).not.toThrow();

    const drifted = structuredClone(manifest);
    delete obj(drifted, 'LocalJob').internal;
    expect(() => assertInternalStampsMatchSchema(drifted)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INTERNAL_STAMP_DRIFT' }),
    );
    const invented = structuredClone(manifest);
    obj(invented, 'Plain').internal = 'system';
    expect(() => assertInternalStampsMatchSchema(invented)).toThrow(
      expect.objectContaining({ code: 'CONFIG_INTERNAL_STAMP_DRIFT' }),
    );
  });

  it('a system junction item is system', () => {
    const manifest = generate([
      def('Ledger', { decoratorConfig: { tableName: '_smrt_ledger' } }),
      junction('LedgerLinks', 'Ledger'),
    ]);
    expect(obj(manifest, 'Ledger').internal).toBe('system');
    expect(obj(manifest, 'LedgerLinks').junctionOf).toBe(`${APP}:Ledger`);
  });
});
