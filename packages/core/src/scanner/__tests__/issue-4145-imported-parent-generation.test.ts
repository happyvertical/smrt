/**
 * #4145: two SMRT dependencies declare `Agreement`. A consumer subclass whose
 * import names one of them must take that package's STI base, table, and
 * fields — whichever dependency is listed first — and an import the parent's
 * package does not confirm falls back to the simple name.
 */
import { describe, expect, it, vi } from 'vitest';
import { ManifestGenerator } from '../manifest-generator';
import type { ScanResult, SmartObjectDefinition } from '../types';

const { COMMERCE, SALES, APP, manifests } = vi.hoisted(() => {
  const COMMERCE = '@test4145/commerce';
  const SALES = '@test4145/sales';
  const APP = '@test4145/app';
  const agreement = (
    packageName: string,
    extra: Record<string, unknown>,
  ): Record<string, unknown> => ({
    name: 'agreement',
    className: 'Agreement',
    qualifiedName: `${packageName}:Agreement`,
    collection: 'agreements',
    filePath: `/node_modules/${packageName}/dist/agreement.js`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    packageName,
    ...extra,
  });
  const manifests: Record<string, unknown> = {
    [COMMERCE]: {
      version: '1.0.0',
      packageName: COMMERCE,
      objects: {
        [`${COMMERCE}:Agreement`]: agreement(COMMERCE, {
          fields: { contractType: { type: 'text' } },
          decoratorConfig: { tableStrategy: 'sti', tableName: 'contracts' },
        }),
      },
    },
    [SALES]: {
      version: '1.0.0',
      packageName: SALES,
      objects: {
        [`${SALES}:Agreement`]: agreement(SALES, {
          fields: { partyA: { type: 'text' } },
          decoratorConfig: { tableStrategy: 'sti', tableName: 'agreements' },
        }),
      },
    },
  };
  return { COMMERCE, SALES, APP, manifests };
});

vi.mock('../../manifest/manifest-loader.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  loadExternalManifestSync: vi.fn(
    (packageName: string) => manifests[packageName] ?? null,
  ),
}));

function generate(child: Partial<SmartObjectDefinition>) {
  const childDef = {
    name: 'advertisingproductcontract',
    className: 'AdvertisingProductContract',
    collection: 'advertisingproductcontracts',
    filePath: '/app/src/lib/models/AdvertisingProductContracts.ts',
    fields: { productId: { type: 'text' } },
    methods: {},
    decoratorConfig: {},
    extends: 'Agreement',
    packageName: APP,
    ...child,
  } as SmartObjectDefinition;
  const scanResults: ScanResult[] = [
    { filePath: childDef.filePath, objects: [childDef], errors: [] },
  ];
  // Sales first: a simple-name lookup would take ITS Agreement.
  return new ManifestGenerator().generateManifest(scanResults, {
    packageName: APP,
    smrtDependencies: [SALES, COMMERCE],
  }).objects[`${APP}:AdvertisingProductContract`];
}

describe('#4145 import-qualified parent in manifest generation', () => {
  it('inherits the imported package parent, not the first same-named one', () => {
    const child = generate({ extendsQualified: `${COMMERCE}:Agreement` });
    expect(child?.extendsQualified).toBe(`${COMMERCE}:Agreement`);
    expect(child?.extends).toBe('Agreement');
    expect(child?.decoratorConfig.tableName).toBe('contracts');
    expect(Object.keys(child?.fields ?? {})).toEqual(
      expect.arrayContaining(['contractType', 'productId']),
    );
    expect(child?.fields.partyA).toBeUndefined();
  });

  it('drops a qualification the named package does not declare', () => {
    const child = generate({ extendsQualified: '@test4145/barrel:Agreement' });
    expect(child?.extendsQualified).toBeUndefined();
    expect(child?.extends).toBe('Agreement');
  });

  it('keeps simple-name resolution unchanged without a qualification', () => {
    const child = generate({});
    expect(child?.extendsQualified).toBeUndefined();
    expect(child?.decoratorConfig.tableName).toBe('agreements');
  });

  it('keeps a local same-named parent for its own subclasses', () => {
    const local = (
      className: string,
      extra: Partial<SmartObjectDefinition>,
    ): SmartObjectDefinition =>
      ({
        name: className.toLowerCase(),
        className,
        collection: `${className.toLowerCase()}s`,
        filePath: `/app/src/lib/models/${className}.ts`,
        fields: {},
        methods: {},
        decoratorConfig: {},
        packageName: APP,
        ...extra,
      }) as SmartObjectDefinition;
    const objects = [
      local('Agreement', {
        fields: { localTerms: { type: 'text' } },
        decoratorConfig: { tableStrategy: 'sti', tableName: 'app_agreements' },
      }),
      local('Imported', {
        extends: 'Agreement',
        extendsQualified: `${COMMERCE}:Agreement`,
      }),
      local('LocalChild', { extends: 'Agreement' }),
    ];
    const manifest = new ManifestGenerator().generateManifest(
      [{ filePath: '/app/src/lib/models', objects, errors: [] }],
      { packageName: APP, smrtDependencies: [SALES, COMMERCE] },
    );
    const imported = manifest.objects[`${APP}:Imported`];
    const localChild = manifest.objects[`${APP}:LocalChild`];
    expect(imported?.decoratorConfig.tableName).toBe('contracts');
    expect(imported?.fields.localTerms).toBeUndefined();
    expect(localChild?.decoratorConfig.tableName).toBe('app_agreements');
    expect(localChild?.fields.localTerms).toBeDefined();
    expect(localChild?.fields.contractType).toBeUndefined();
  });
});
