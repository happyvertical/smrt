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
    // Bundled output of the app (adapter-node / SvelteKit build).
    ws.writeModel(
      'apps/app/build/server/chunks/license-sale.js',
      'LicenseSale',
      {
        tableName: 'license_sales',
      },
    );
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
