/**
 * Consumer-workspace class identity (#3106, #3109, #3110).
 *
 * #3102 (0.51.25) made class identity package-strict. Consumers then broke
 * where a class's declaring package had to be derived from the stack:
 *
 * - under tsx / `--enable-source-maps`, installed smrt-core's frames report
 *   their source-mapped `.../smrt-core/src/...` paths, which the stack walk did
 *   not skip, so every class was attributed to `@happyvertical/smrt-core`
 *   (#3109; ergot's pnpm peer-variant copies of smrt-jobs `SmrtJob` then threw
 *   a class-name collision, #3110);
 * - a model declared in a workspace package that an app's manifest scans under
 *   the app's name (anytown's `packages/cloud-network`) registered under the
 *   workspace package with no fields in a Vite dev server, and a module reset
 *   that re-decorated it threw a class-name collision (#3110);
 * - a consumer class sharing a simple name with a dependency's class
 *   (`LicenseSale` in ergot's market-core and smrt-commerce) threw a
 *   collision, or in bundled output adopted the dependency's entry (#3106).
 *
 * These run in Vitest's module runner (the Vite SSR runner) against consumer
 * workspaces laid out on disk; `issue-3109-plain-node-consumer.test.ts` covers
 * the plain Node process.
 */
import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { getPackageName } from '../../manifest/manifest-loader.js';
import { getManifestCache } from '../../manifest/store.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry, smrt } from '../../registry.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { isSmrtCoreFramePath } from '../../utils/stack-frames.js';
import { getSourceFileFromStack } from '../shared-state.js';
import type { SmrtObjectConstructor } from '../types.js';
import {
  type ConsumerWorkspace,
  createConsumerWorkspace,
  manifestEntry,
} from './helpers/consumer-workspace.js';

type Define = (deps: {
  smrt: typeof smrt;
  SmrtObject: typeof SmrtObject;
}) => typeof SmrtObject;

async function defineFrom(file: string): Promise<typeof SmrtObject> {
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(file).href
  )) as {
    define: Define;
  };
  return module.define({ smrt, SmrtObject });
}

const identity = (ctor: typeof SmrtObject) =>
  ObjectRegistry.getClassByConstructor(ctor);

describe('stack attribution under source maps (#3109, #3110)', () => {
  let ws: ConsumerWorkspace;
  let installedCore: string;

  beforeAll(() => {
    ws = createConsumerWorkspace('smrt-3109-stack');
    installedCore =
      'node_modules/.pnpm/@happyvertical+smrt-core@0.51.25_x/node_modules/@happyvertical/smrt-core';
    ws.writePackage(installedCore, '@happyvertical/smrt-core');
    ws.writePackage('apps/app', '@fixture/app');
    ws.write('apps/app/src/models/Network.ts', '');
    // A consumer's own workspace package that happens to live at
    // `packages/core` (ergot's `@ergot/core`).
    ws.writePackage('packages/core', '@fixture/core');
    ws.write('packages/core/src/models/Usage.ts', '');
  });
  afterAll(() => ws.dispose());

  // The stack a tsx script produced registering an app model on 0.51.25:
  // installed core frames, source-mapped to core's `src/`, above the app's.
  const tsxStack = () =>
    [
      'Error',
      `    at getPackageName (${ws.path(installedCore, 'src/manifest/manifest-loader.ts')}:534:38)`,
      `    at registerUntracked (${ws.path(installedCore, 'src/registry/class-registration.ts')}:783:28)`,
      `    at register (${ws.path(installedCore, 'src/registry/class-registration.ts')}:638:5)`,
      `    at ObjectRegistry.register (${ws.path(installedCore, 'dist/registry.js')}:622:3)`,
      `    at <anonymous> (file://${ws.path(installedCore, 'dist/registry.js')}:2505:19)`,
      `    at <anonymous> (file://${ws.path('apps/app/src/models/Network.ts')}:12:1)`,
      '    at ModuleJob.run (node:internal/modules/esm/module_job:569:25)',
    ].join('\n');

  it('skips source-mapped installed smrt-core frames', () => {
    expect(
      isSmrtCoreFramePath(
        ws.path(installedCore, 'src/registry/class-registration.ts'),
      ),
    ).toBe(true);
    expect(
      getPackageName(
        class Network {} as unknown as SmrtObjectConstructor,
        true,
        tsxStack(),
      ),
    ).toBe('@fixture/app');
  });

  it("does not mistake a consumer's own packages/core for smrt-core", () => {
    const usage = ws.path('packages/core/src/models/Usage.ts');
    const dist = ws.path('packages/core/dist/manifest-loader-usage.js');
    expect(isSmrtCoreFramePath(usage)).toBe(false);
    expect(isSmrtCoreFramePath(dist)).toBe(false);
    const stack = tsxStack().replace(
      ws.path('apps/app/src/models/Network.ts'),
      usage,
    );
    expect(
      getPackageName(
        class Usage {} as unknown as SmrtObjectConstructor,
        true,
        stack,
      ),
    ).toBe('@fixture/core');
    expect(getSourceFileFromStack(stack)).toBe(usage);
  });

  it('reports the declaring file without a named frame parenthesis', () => {
    expect(getSourceFileFromStack(tsxStack())).toBe(
      ws.path('apps/app/src/models/Network.ts'),
    );
  });
});

describe('consumer workspace registration (#3106, #3110)', () => {
  let ws: ConsumerWorkspace;
  let previousCwd: string;
  let restoreRegistry: () => void;

  beforeAll(() => {
    ws = createConsumerWorkspace('smrt-3110-consumer');
    ws.writePackage('apps/app', '@fixture/app');
    ws.writePackage('packages/cloud', '@fixture/cloud');
    ws.writePackage('packages/market', '@fixture/market');
    ws.writePackage('node_modules/@fixture/commerce', '@fixture/commerce');
    // The app's manifest scans a workspace package's model under the app's
    // package name, with a workspace-relative path (anytown's shape).
    ws.write(
      'apps/app/.smrt/manifest.json',
      JSON.stringify({
        version: '1',
        timestamp: 0,
        packageName: '@fixture/app',
        objects: {
          '@fixture/app:PreviewResource': manifestEntry({
            className: 'PreviewResource',
            packageName: '@fixture/app',
            filePath: 'packages/cloud/src/models/PreviewResource.js',
            tableName: 'preview_resources',
            fields: { networkId: { type: 'text' }, status: { type: 'text' } },
          }),
        },
      }),
    );
    ws.writeModel(
      'packages/cloud/src/models/PreviewResource.js',
      'PreviewResource',
    );
    // A dependency and a consumer package both declare `LicenseSale`.
    ws.writeModel(
      'node_modules/@fixture/commerce/dist/models.js',
      'LicenseSale',
      {
        tableName: 'contracts',
      },
    );
    ws.writeModel('packages/market/src/LicenseSale.js', 'LicenseSale', {
      tableName: 'license_sales',
    });
    ws.writeModel('packages/market/src/BareLicenseSale.js', 'LicenseSale');
    // No scoped package.json above it: its package cannot be derived.
    ws.writeModel('scripts/UnscopedLicenseSale.js', 'LicenseSale');
    ws.writeModel('apps/app/build/server/chunks/order.js', 'Order', {
      tableStrategy: 'sti',
    });
    ws.write(
      'apps/app/build/server/chunks/consumer-contract.js',
      [
        'export function define({ smrt, SmrtObject }) {',
        "  const ConsumerContract = smrt({ tableName: 'consumer_contracts', tableStrategy: 'sti' })(class ConsumerContract extends SmrtObject {});",
        "  return smrt({ tableStrategy: 'sti' })(class LicenseSale extends ConsumerContract {});",
        '}',
        '',
      ].join('\n'),
    );
    ws.writeModel('packages/market/src/ExplicitLicenseSale.js', 'LicenseSale', {
      packageName: '@fixture/market',
    });
    // Bundled output of the app (adapter-node / SvelteKit build).
    ws.writeModel(
      'apps/app/build/server/chunks/license-sale.js',
      'LicenseSale',
      {
        tableName: 'license_sales',
      },
    );
    // An installed dependency whose LicenseSale is an STI subtype of its
    // Contract (smrt-commerce's shape), a bundle that inlined that pair, and
    // an app bundle declaring its own LicenseSale with no configuration.
    ws.writePackage('node_modules/@fixture/sales', '@fixture/sales');
    ws.write(
      'node_modules/@fixture/sales/dist/models.js',
      [
        'export function define({ smrt, SmrtObject }) {',
        "  const Contract = smrt({ tableName: 'contracts', tableStrategy: 'sti' })(class Contract extends SmrtObject {});",
        "  return smrt({ tableStrategy: 'sti' })(class LicenseSale extends Contract {});",
        '}',
        '',
      ].join('\n'),
    );
    ws.write(
      'apps/app/build/server/chunks/sales-inlined.js',
      [
        'export function define({ smrt, SmrtObject }) {',
        "  const Contract = smrt({ tableName: 'contracts', tableStrategy: 'sti' })(class Contract extends SmrtObject {});",
        "  return smrt({ tableStrategy: 'sti' })(class LicenseSale extends Contract {});",
        '}',
        '',
      ].join('\n'),
    );
    ws.writeModel(
      'apps/app/build/server/chunks/license-sale-bare.js',
      'LicenseSale',
    );
    ws.writePackage('node_modules/@fixture/profiles', '@fixture/profiles');
    ws.writeModel('node_modules/@fixture/profiles/dist/models.js', 'ApiKey');
    ws.writeModel('apps/app/build/server/chunks/api-key.js', 'ApiKey');
    ws.writeModel('apps/app/build/server/chunks/widget-a.js', 'Widget');
    ws.writeModel('apps/app/build/server/chunks/widget-b.js', 'Widget');
    // Two pnpm peer-variant copies of one installed package version.
    for (const variant of ['a', 'b']) {
      const dir = `node_modules/.pnpm/@fixture+jobs@1.0.0_${variant}/node_modules/@fixture/jobs`;
      ws.writePackage(dir, '@fixture/jobs');
      ws.writeModel(`${dir}/dist/index.js`, 'FixtureJob');
    }
    previousCwd = process.cwd();
    process.chdir(ws.path('apps/app'));
  });

  afterAll(() => {
    process.chdir(previousCwd);
    ws.dispose();
  });

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
  });

  const previewManifestEntry = () =>
    manifestEntry({
      className: 'PreviewResource',
      packageName: '@fixture/app',
      filePath: 'packages/cloud/src/models/PreviewResource.js',
      tableName: 'preview_resources',
      fields: { networkId: { type: 'text' }, status: { type: 'text' } },
    });

  it("registers a workspace package's model under the app manifest that scans it (dev server)", async () => {
    // A Vite dev server is not a test environment: no test manifests, and
    // the app's manifest is not loaded when the model is first decorated.
    vi.stubEnv('VITEST', 'false');
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const PreviewResource = await defineFrom(
        ws.path('packages/cloud/src/models/PreviewResource.js'),
      );
      const registered = identity(PreviewResource);
      expect(registered?.qualifiedName).toBe('@fixture/app:PreviewResource');
      expect([...(registered?.fields.keys() ?? [])]).toEqual(
        expect.arrayContaining(['networkId', 'status']),
      );
      expect(registered?.schema?.tableName).toBe('preview_resources');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sees the app manifest again after it is regenerated', async () => {
    const manifestPath = ws.path('apps/app/.smrt/manifest.json');
    const original = readFileSync(manifestPath, 'utf8');
    ws.writeModel('packages/cloud/src/models/LaterA.js', 'LaterA');
    ws.writeModel('packages/cloud/src/models/LaterB.js', 'LaterB');
    vi.stubEnv('VITEST', 'false');
    vi.stubEnv('NODE_ENV', 'development');
    try {
      const LaterA = await defineFrom(
        ws.path('packages/cloud/src/models/LaterA.js'),
      );
      expect(identity(LaterA)?.qualifiedName).toBe('@fixture/cloud:LaterA');
      // A dev server's plugin rewrites the manifest when a model is added.
      const manifest = JSON.parse(original);
      manifest.objects['@fixture/app:LaterB'] = manifestEntry({
        className: 'LaterB',
        packageName: '@fixture/app',
        filePath: 'packages/cloud/src/models/LaterB.js',
        tableName: 'later_bs',
        fields: { label: { type: 'text' } },
      });
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const later = new Date(Date.now() + 5_000);
      utimesSync(manifestPath, later, later);
      const LaterB = await defineFrom(
        ws.path('packages/cloud/src/models/LaterB.js'),
      );
      expect(identity(LaterB)?.qualifiedName).toBe('@fixture/app:LaterB');
      expect(identity(LaterB)?.schema?.tableName).toBe('later_bs');
    } finally {
      vi.unstubAllEnvs();
      writeFileSync(manifestPath, original);
    }
  });

  it('re-registers that model after a module reset (app manifest registered first)', async () => {
    // Vitest's smrt plugin registers the app manifest before test modules
    // load; the entry carries the manifest's workspace-relative path.
    ObjectRegistry.registerFromManifest(
      'PreviewResource',
      previewManifestEntry(),
      '@fixture/app',
    );
    const file = ws.path('packages/cloud/src/models/PreviewResource.js');
    const first = await defineFrom(file);
    vi.resetModules();
    const second = await defineFrom(file);
    expect(second).not.toBe(first);
    const registered = identity(second);
    expect(registered?.qualifiedName).toBe('@fixture/app:PreviewResource');
    expect([...(registered?.fields.keys() ?? [])]).toEqual(
      expect.arrayContaining(['networkId', 'status']),
    );
    expect(ObjectRegistry.getClass('@fixture/cloud:PreviewResource')).toBe(
      undefined,
    );
  });

  it('accepts pnpm peer-variant copies of one package class as one class', async () => {
    const copies = [];
    for (const variant of ['a', 'b']) {
      copies.push(
        await defineFrom(
          ws.path(
            `node_modules/.pnpm/@fixture+jobs@1.0.0_${variant}/node_modules/@fixture/jobs/dist/index.js`,
          ),
        ),
      );
    }
    expect(identity(copies[1])?.qualifiedName).toBe('@fixture/jobs:FixtureJob');
  });

  for (const order of ['dependency first', 'consumer first'] as const) {
    it(`keeps a consumer class apart from a same-named dependency class (${order})`, async () => {
      const load = {
        dependency: () =>
          defineFrom(ws.path('node_modules/@fixture/commerce/dist/models.js')),
        consumer: () =>
          defineFrom(ws.path('packages/market/src/LicenseSale.js')),
      };
      const [first, second] =
        order === 'dependency first'
          ? [await load.dependency(), await load.consumer()]
          : [await load.consumer(), await load.dependency()];
      const [dependency, consumer] =
        order === 'dependency first' ? [first, second] : [second, first];

      expect(identity(dependency)?.qualifiedName).toBe(
        '@fixture/commerce:LicenseSale',
      );
      expect(identity(consumer)?.qualifiedName).toBe(
        '@fixture/market:LicenseSale',
      );
      expect(identity(dependency)?.schema?.tableName).toBe('contracts');
      expect(identity(consumer)?.schema?.tableName).toBe('license_sales');
      expect(identity(dependency)?.constructor).toBe(dependency);
    });
  }

  it("does not let another package's manifest stub adopt a consumer class", async () => {
    ObjectRegistry.registerFromManifest(
      'LicenseSale',
      {
        ...manifestEntry({
          className: 'LicenseSale',
          packageName: '@fixture/commerce',
          filePath: '/build-host/packages/commerce/src/models/Contract.ts',
          tableName: 'contracts',
          fields: { contractNumber: { type: 'text' } },
        }),
      },
      '@fixture/commerce',
    );
    const consumer = await defineFrom(
      ws.path('packages/market/src/LicenseSale.js'),
    );
    expect(identity(consumer)?.qualifiedName).toBe(
      '@fixture/market:LicenseSale',
    );
    expect(identity(consumer)?.schema?.tableName).toBe('license_sales');
    const stub = ObjectRegistry.getClass('@fixture/commerce:LicenseSale');
    expect(stub?.schema?.tableName).toBe('contracts');
    expect(stub?.constructor).not.toBe(consumer);
  });

  for (const variant of [
    'stack-derived',
    'stack-derived, no table',
    'explicit packageName',
    'bundled, no table',
  ] as const) {
    it(`does not take a dependency's cached, unregistered manifest entry (${variant})`, async () => {
      // An app manifest declaring the dependency makes discovery load its
      // manifest before any of its classes (or stubs) register.
      getManifestCache().set('@fixture/commerce', {
        version: '1',
        timestamp: 0,
        packageName: '@fixture/commerce',
        objects: {
          '@fixture/commerce:LicenseSale': manifestEntry({
            className: 'LicenseSale',
            packageName: '@fixture/commerce',
            filePath: '/build-host/packages/commerce/src/models/Contract.ts',
            tableName: 'contracts',
            fields: { contractNumber: { type: 'text' } },
          }),
        },
      } as never);
      try {
        const consumer = await defineFrom(
          ws.path(
            {
              'stack-derived': 'packages/market/src/LicenseSale.js',
              'stack-derived, no table':
                'packages/market/src/BareLicenseSale.js',
              'explicit packageName':
                'packages/market/src/ExplicitLicenseSale.js',
              'bundled, no table':
                'apps/app/build/server/chunks/license-sale-bare.js',
            }[variant],
          ),
        );
        expect(identity(consumer)?.qualifiedName).toBe(
          variant === 'bundled, no table'
            ? '@fixture/app:LicenseSale'
            : '@fixture/market:LicenseSale',
        );
        expect(identity(consumer)?.schema?.tableName).not.toBe('contracts');
        expect([...(identity(consumer)?.fields.keys() ?? [])]).not.toContain(
          'contractNumber',
        );
      } finally {
        getManifestCache().delete('@fixture/commerce');
      }
    });
  }

  for (const shape of [
    {
      name: 'its own STI base',
      file: 'apps/app/build/server/chunks/order.js',
      className: 'Order',
      foreignTable: 'commerce_orders',
      table: 'orders',
    },
    {
      name: 'a subtype of its own registered STI base',
      file: 'apps/app/build/server/chunks/consumer-contract.js',
      className: 'LicenseSale',
      foreignTable: 'contracts',
      table: 'consumer_contracts',
    },
  ]) {
    it(`gives a bundled consumer STI class (${shape.name}) its own table, not a cached dependency entry's`, async () => {
      getManifestCache().set('@fixture/commerce', {
        version: '1',
        timestamp: 0,
        packageName: '@fixture/commerce',
        objects: {
          [`@fixture/commerce:${shape.className}`]: manifestEntry({
            className: shape.className,
            packageName: '@fixture/commerce',
            filePath: '/build-host/packages/commerce/src/models/Contract.ts',
            tableName: shape.foreignTable,
            fields: { contractNumber: { type: 'text' } },
          }),
        },
      } as never);
      try {
        const ctor = await defineFrom(ws.path(shape.file));
        expect(identity(ctor)?.qualifiedName).toBe(
          `@fixture/app:${shape.className}`,
        );
        expect(identity(ctor)?.schema?.tableName).toBe(shape.table);
      } finally {
        getManifestCache().delete('@fixture/commerce');
      }
    });
  }

  it("does not give a class of unknown package a cached dependency entry's table", async () => {
    getManifestCache().set('@fixture/commerce', {
      version: '1',
      timestamp: 0,
      packageName: '@fixture/commerce',
      objects: {
        '@fixture/commerce:LicenseSale': manifestEntry({
          className: 'LicenseSale',
          packageName: '@fixture/commerce',
          filePath: '/build-host/packages/commerce/src/models/Contract.ts',
          tableName: 'contracts',
          fields: { contractNumber: { type: 'text' } },
        }),
      },
    } as never);
    try {
      const ctor = await defineFrom(ws.path('scripts/UnscopedLicenseSale.js'));
      expect(ctor.SMRT_TABLE_NAME).not.toBe('contracts');
    } finally {
      getManifestCache().delete('@fixture/commerce');
    }
  });

  it("keeps an app bundle's class apart from an installed dependency's", async () => {
    const dependency = await defineFrom(
      ws.path('node_modules/@fixture/commerce/dist/models.js'),
    );
    const bundled = await defineFrom(
      ws.path('apps/app/build/server/chunks/license-sale.js'),
    );
    expect(identity(dependency)?.qualifiedName).toBe(
      '@fixture/commerce:LicenseSale',
    );
    expect(identity(dependency)?.constructor).toBe(dependency);
    expect(identity(dependency)?.schema?.tableName).toBe('contracts');
    expect(identity(bundled)?.qualifiedName).toBe('@fixture/app:LicenseSale');
    expect(identity(bundled)?.schema?.tableName).toBe('license_sales');
  });

  it("keeps an app bundle's undeclared-table class apart from a dependency class of another lineage", async () => {
    const dependency = await defineFrom(
      ws.path('node_modules/@fixture/sales/dist/models.js'),
    );
    const bundled = await defineFrom(
      ws.path('apps/app/build/server/chunks/license-sale-bare.js'),
    );
    expect(identity(dependency)?.qualifiedName).toBe(
      '@fixture/sales:LicenseSale',
    );
    expect(identity(dependency)?.constructor).toBe(dependency);
    expect(identity(bundled)?.qualifiedName).toBe('@fixture/app:LicenseSale');
    expect(identity(bundled)?.schema?.tableName).not.toBe('contracts');
  });

  it("still accepts an inlined copy of a dependency's STI pair as the same classes", async () => {
    const installed = await defineFrom(
      ws.path('node_modules/@fixture/sales/dist/models.js'),
    );
    const inlined = await defineFrom(
      ws.path('apps/app/build/server/chunks/sales-inlined.js'),
    );
    expect(identity(installed)?.qualifiedName).toBe(
      '@fixture/sales:LicenseSale',
    );
    expect(identity(inlined)?.qualifiedName).toBe('@fixture/sales:LicenseSale');
    expect(ObjectRegistry.getClass('@fixture/app:LicenseSale')).toBe(undefined);
    expect(ObjectRegistry.getClass('@fixture/app:Contract')).toBe(undefined);
  });

  it('keeps one class when the app bundle inlines a class the installed dependency also loads', async () => {
    // A SvelteKit build's analysis step loads a server bundle that inlined
    // the dependency's ApiKey while the installed package registers it too;
    // the generated registration then claims the bundled constructor.
    const installed = await defineFrom(
      ws.path('node_modules/@fixture/profiles/dist/models.js'),
    );
    const inlined = await defineFrom(
      ws.path('apps/app/build/server/chunks/api-key.js'),
    );
    expect(identity(installed)?.qualifiedName).toBe('@fixture/profiles:ApiKey');
    expect(identity(inlined)?.qualifiedName).toBe('@fixture/profiles:ApiKey');
    expect(ObjectRegistry.getClass('@fixture/app:ApiKey')).toBe(undefined);

    const key = '@fixture/profiles:ApiKey';
    ObjectRegistry.register(inlined, {
      name: 'ApiKey',
      packageName: '@fixture/profiles',
      _manifestKey: key,
      _manifest: {
        version: '1',
        timestamp: 0,
        packageName: '@fixture/profiles',
        objects: {
          [key]: manifestEntry({
            className: 'ApiKey',
            packageName: '@fixture/profiles',
            filePath: '/build-host/packages/profiles/src/ApiKey.ts',
            tableName: 'api_keys',
            fields: { label: { type: 'text' } },
          }),
        },
      } as never,
    });
    expect(identity(inlined)?.qualifiedName).toBe(key);
  });

  it("still treats an inlined dependency's chunk duplicates as one class", async () => {
    ObjectRegistry.registerFromManifest(
      'Widget',
      manifestEntry({
        className: 'Widget',
        packageName: '@fixture/dep',
        filePath: '/build-host/packages/dep/src/Widget.ts',
        tableName: 'widgets',
        fields: { label: { type: 'text' } },
      }),
      '@fixture/dep',
    );
    const chunkA = await defineFrom(
      ws.path('apps/app/build/server/chunks/widget-a.js'),
    );
    const chunkB = await defineFrom(
      ws.path('apps/app/build/server/chunks/widget-b.js'),
    );
    expect(identity(chunkA)?.qualifiedName).toBe('@fixture/dep:Widget');
    expect(identity(chunkB)?.qualifiedName).toBe('@fixture/dep:Widget');
    expect(ObjectRegistry.getClass('@fixture/app:Widget')).toBe(undefined);
  });
});
