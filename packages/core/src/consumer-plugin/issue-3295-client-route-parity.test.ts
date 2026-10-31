/**
 * #3295: the consumer type generator (`smrtConsumer({ generateTypes: true })`)
 * listed actions in `smrt-client.d.ts` that the generated REST routes never
 * serve. A consumer that aggregates `@happyvertical/smrt-core` receives the
 * framework's own base classes (`SmrtObject`, `SmrtCollection`, ...) in its
 * manifest; the route, MCP, web and knowledge generators skip them as
 * scaffolding (#2642), but client entry selection did not, so the client
 * advertised e.g. `smrtobjects.hasBaseJunctionLifecycle(...)` (a static
 * helper) and `smrtcollections.findOne(id, ...)` as callable actions.
 *
 * The client contract is "methods whose routes the server actually emits", so
 * this test generates the real consumer declarations and the real SvelteKit
 * routes from the same aggregated manifest, and requires every generated
 * client operation to have its route file, with static model methods on the
 * collection-scoped route and instance methods on the item route.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import { selectApiClientEntries } from '../vite-plugin/api-client-entries.js';
import { generateClientModule } from '../vite-plugin/generated-client.js';
import {
  generateSvelteKitRoutes,
  resolveApiActionRouteConfig,
} from '../vite-plugin/sveltekit-generator.js';
import { smrtConsumer } from './index';

const CORE = '@happyvertical/smrt-core';
const SHOP = '@fixture/shop';

function method(
  name: string,
  options: {
    isStatic?: boolean;
    parameters?: Array<{ name: string; type: string; optional?: boolean }>;
  } = {},
) {
  return {
    name,
    async: true,
    parameters: options.parameters ?? [],
    returnType: 'Promise<any>',
    isStatic: options.isStatic ?? false,
    isPublic: true,
  };
}

/** The framework bases as `@happyvertical/smrt-core`'s manifest lists them. */
function coreObjects(root: string) {
  return {
    [`${CORE}:SmrtObject`]: {
      qualifiedName: `${CORE}:SmrtObject`,
      className: 'SmrtObject',
      packageName: CORE,
      name: 'smrtObject',
      collection: 'smrtobjects',
      filePath: join(root, 'core/src/object.ts'),
      extends: 'SmrtClass',
      fields: {},
      methods: {
        describe: method('describe'),
        hasBaseJunctionLifecycle: method('hasBaseJunctionLifecycle', {
          isStatic: true,
          parameters: [{ name: 'candidate', type: 'object' }],
        }),
      },
      decoratorConfig: {},
    },
    [`${CORE}:SmrtCollection`]: {
      qualifiedName: `${CORE}:SmrtCollection`,
      className: 'SmrtCollection',
      packageName: CORE,
      name: 'smrtCollection',
      collection: 'smrtcollections',
      filePath: join(root, 'core/src/collection.ts'),
      extends: 'SmrtClass',
      fields: {},
      methods: {
        validate: method('validate', { isStatic: true }),
        findOne: method('findOne', {
          parameters: [{ name: 'options', type: 'any' }],
        }),
      },
      decoratorConfig: {},
    },
  };
}

function shopObjects(root: string) {
  return {
    [`${SHOP}:Order`]: {
      qualifiedName: `${SHOP}:Order`,
      className: 'Order',
      packageName: SHOP,
      name: 'order',
      collection: 'orders',
      filePath: join(root, 'src/lib/objects/Order.ts'),
      extends: 'SmrtObject',
      extendsQualified: `${CORE}:SmrtObject`,
      fields: { total: { type: 'integer', required: true } },
      methods: {
        refund: method('refund'),
        findOverdue: method('findOverdue', {
          isStatic: true,
          parameters: [{ name: 'days', type: 'number' }],
        }),
      },
      decoratorConfig: {
        api: { include: ['list', 'get', 'refund', 'findOverdue'] },
      },
    },
  };
}

function buildStart(plugin: ReturnType<typeof smrtConsumer>): Promise<void> {
  const hook = plugin.buildStart;
  if (!hook) throw new Error('Expected buildStart hook');
  const handler = typeof hook === 'function' ? hook : hook.handler;
  return Promise.resolve(
    handler.call({} as never, {} as Parameters<typeof handler>[0]),
  );
}

describe('generated client lists only operations the generated routes serve (#3295)', () => {
  let tmpDir: string;
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];

  function writeProvider(
    packageName: string,
    objects: Record<string, unknown>,
  ) {
    const packageDir = join(tmpDir, 'node_modules', ...packageName.split('/'));
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        exports: {
          '.': './dist/index.js',
          './manifest.json': './dist/manifest.json',
        },
      }),
    );
    writeFileSync(
      join(packageDir, 'dist', 'manifest.json'),
      JSON.stringify({ version: '1.0.0', packageName, objects }),
    );
  }

  beforeEach(() => {
    tmpDir = resolve(
      import.meta.dirname,
      `__test-issue-3295-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: '@fixture/dashboard', version: '1.0.0' }),
    );
    writeProvider(CORE, coreObjects(tmpDir));
    writeProvider(SHOP, shopObjects(tmpDir));
    for (const level of ['log', 'warn'] as const) {
      spies.push(vi.spyOn(console, level).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('omits framework base classes and keeps model statics collection-scoped', async () => {
    await buildStart(
      smrtConsumer({
        packages: [CORE, SHOP],
        projectRoot: tmpDir,
        disableScanning: true,
        generateTypes: true,
        typesDir: 'src/types/smrt-generated',
      }),
    );
    const client = readFileSync(
      join(tmpDir, 'src/types/smrt-generated/smrt-client.d.ts'),
      'utf-8',
    );
    expect(client).not.toMatch(/"smrtobjects"|"smrtcollections"/);
    expect(client).not.toContain('hasBaseJunctionLifecycle');
    expect(client).not.toContain('findOne');
    // A static model method is a collection operation; an instance method
    // needs the record id.
    expect(client).toContain(
      'findOverdue(options: { days: any }): Promise<any>;',
    );
    expect(client).toContain(
      'refund(id: string, options?: Record<string, never>): Promise<any>;',
    );

    const manifest = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    ) as SmartObjectManifest;
    const runtimeClient = generateClientModule(manifest);
    expect(runtimeClient).not.toContain('/smrtobjects');
    expect(runtimeClient).not.toContain('/smrtcollections');
    expect(runtimeClient).toContain("'/orders/findOverdue'");

    // Every client operation has the route file the route generator writes
    // from the same manifest.
    const appRoot = join(tmpDir, 'app');
    mkdirSync(appRoot, { recursive: true });
    await generateSvelteKitRoutes(appRoot, manifest, {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    });
    const routeFile = (...segments: string[]) =>
      join(appRoot, 'src/routes/api', ...segments, '+server.ts');
    const missing: string[] = [];
    for (const entry of selectApiClientEntries(manifest)) {
      const collection = entry.obj.collection;
      if (
        entry.crudMethods.some((op) => ['list', 'create'].includes(op)) &&
        !existsSync(routeFile(collection))
      ) {
        missing.push(`${entry.clientKey}: ${collection}/+server.ts`);
      }
      if (
        entry.crudMethods.some((op) =>
          ['get', 'update', 'delete'].includes(op),
        ) &&
        !existsSync(routeFile(collection, '[id]'))
      ) {
        missing.push(`${entry.clientKey}: ${collection}/[id]/+server.ts`);
      }
      for (const custom of entry.customMethods) {
        const methodDef = entry.obj.methods[custom.name];
        const { pathSegments } = resolveApiActionRouteConfig(
          custom.name,
          methodDef ?? {},
          entry.obj.decoratorConfig?.api,
          {},
          custom.scope,
        );
        const segments =
          custom.scope === 'item'
            ? [collection, '[id]', ...pathSegments]
            : [collection, ...pathSegments];
        if (!existsSync(routeFile(...segments))) {
          missing.push(
            `${entry.clientKey}.${custom.name}: ${segments.join('/')}`,
          );
        }
      }
    }
    expect(missing).toEqual([]);
    expect(existsSync(routeFile('orders', 'findOverdue'))).toBe(true);
    expect(existsSync(routeFile('orders', '[id]', 'refund'))).toBe(true);
  });
});

describe('framework bases never own a shared endpoint CRUD set (#3295)', () => {
  it('takes a consumer model and collection CRUD from the consumer, not a base on the same segment', () => {
    const REPORTS = '@happyvertical/smrt-reports';
    const manifest = {
      version: '1.0.0',
      timestamp: 0,
      objects: {
        [`${REPORTS}:SmrtReport`]: {
          qualifiedName: `${REPORTS}:SmrtReport`,
          className: 'SmrtReport',
          packageName: REPORTS,
          name: 'smrtReport',
          collection: 'smrtreports',
          filePath: '/build/reports/src/report.ts',
          fields: {},
          methods: {},
          decoratorConfig: {},
        },
        [`${SHOP}:SalesReport`]: {
          qualifiedName: `${SHOP}:SalesReport`,
          className: 'SalesReport',
          packageName: SHOP,
          name: 'salesReport',
          collection: 'smrtreports',
          filePath: '/build/shop/src/sales-report.ts',
          fields: {},
          methods: {},
          decoratorConfig: { api: { include: ['list'] } },
        },
        [`${SHOP}:SalesReportArchive`]: {
          qualifiedName: `${SHOP}:SalesReportArchive`,
          className: 'SalesReportArchive',
          packageName: SHOP,
          name: 'salesReportArchive',
          collection: 'smrtreports',
          filePath: '/build/shop/src/sales-report-archive.ts',
          extends: 'SmrtCollection',
          fields: {},
          methods: {},
          decoratorConfig: {},
        },
      },
    } as unknown as SmartObjectManifest;
    const entries = selectApiClientEntries(manifest);
    expect(entries.map((entry) => entry.obj.className).sort()).toEqual([
      'SalesReport',
      'SalesReportArchive',
    ]);
    // The base sorts after the consumer model and would otherwise replace the
    // endpoint's list-only set with full CRUD that no route serves.
    for (const entry of entries) {
      expect(entry.crudMethods).toEqual(['list']);
    }
  });
});
