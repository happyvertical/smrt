/**
 * Tests for SvelteKit route generator
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';

// Mock node:fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocking
import {
  findCliApiCoherenceViolations,
  generateSvelteKitRoutes as generateSvelteKitRoutesImpl,
  methodNameToKebab,
  resolveApiActionRouteConfig,
  resolveApiActionSet,
  validateCliIncludeAgainstApi,
} from './sveltekit-generator';

/**
 * The scanner supplies every real object with a qualified name. Older route
 * fixtures intentionally omit package metadata to test registration fallbacks;
 * retain that shape while supplying only the qualified identity now required by
 * the web-definition hash generated alongside each route.
 */
function withSyntheticQualifiedNames(
  manifest: SmartObjectManifest,
): SmartObjectManifest {
  return {
    ...manifest,
    objects: Object.fromEntries(
      Object.entries(manifest.objects).map(([key, objectDef]) => {
        if (
          objectDef.qualifiedName?.includes(':') ||
          key.includes(':') ||
          objectDef.packageName ||
          objectDef.extends === 'SmrtCollection' ||
          objectDef.extendsTypeArg
        ) {
          return [key, objectDef];
        }
        return [
          key,
          {
            ...objectDef,
            qualifiedName: `@test/sveltekit:${objectDef.className}`,
          },
        ];
      }),
    ),
  } as SmartObjectManifest;
}

async function generateSvelteKitRoutes(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: Parameters<typeof generateSvelteKitRoutesImpl>[2],
): Promise<void> {
  await generateSvelteKitRoutesImpl(
    projectRoot,
    withSyntheticQualifiedNames(manifest),
    options,
  );
}

describe('methodNameToKebab (#1305)', () => {
  it.each([
    ['discoverFromUrl', 'discover-from-url'],
    ['XMLExport', 'xml-export'],
    ['URL', 'url'],
    ['getById', 'get-by-id'],
    ['simple', 'simple'],
    ['Already', 'already'],
    ['aA', 'a-a'],
    ['IOError', 'io-error'],
    ['parseHTML5Data', 'parse-html5-data'],
  ])('%s → %s', (input, expected) => {
    expect(methodNameToKebab(input)).toBe(expected);
  });
});

describe('custom-action target resolution (#2182)', () => {
  it('keeps a non-static model action on its item receiver despite route scope', () => {
    expect(
      resolveApiActionRouteConfig(
        'apply',
        { isStatic: false },
        { routes: { apply: { scope: 'collection' } } },
      ).scope,
    ).toBe('item');
  });

  it('keeps static and collection-class actions on collection receivers', () => {
    expect(
      resolveApiActionRouteConfig(
        'rebalance',
        { isStatic: true },
        { routes: { rebalance: { scope: 'item' } } },
      ).scope,
    ).toBe('collection');
    expect(
      resolveApiActionRouteConfig(
        'fanout',
        { isStatic: false },
        { routes: { fanout: { scope: 'item' } } },
        {},
        'collection',
      ).scope,
    ).toBe('collection');
  });
});

function expectGetCollectionCall(
  content: string,
  objectName: string,
  typeName?: string,
): void {
  const escapedObjectName = objectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedTypeName = typeName?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const genericPattern = escapedTypeName ? `<${escapedTypeName}>` : '<[^>]+>';
  expect(content).toMatch(
    new RegExp(
      `getCollection${genericPattern}\\(\\s*'${escapedObjectName}',?\\s*\\)`,
    ),
  );
}

describe('SvelteKit Route Generator', () => {
  const projectRoot = '/test/project';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    vi.mocked(readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Configuration File Generation', () => {
    it('should generate config file when it does not exist', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: true,
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      });

      // Should check if config file exists
      expect(existsSync).toHaveBeenCalledWith(
        join(projectRoot, 'src/lib/server', 'smrt.ts'),
      );

      // Should create directory if needed
      expect(mkdirSync).toHaveBeenCalledWith(
        join(projectRoot, 'src/lib/server'),
        { recursive: true },
      );

      // Should write config file
      expect(writeFileSync).toHaveBeenCalledWith(
        join(projectRoot, 'src/lib/server', 'smrt.ts'),
        expect.stringContaining('objectOverrides'),
        'utf-8',
      );

      // Config should include key sections
      const configCall = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString().endsWith('smrt.ts'));
      expect(configCall).toBeDefined();
      const configContent = configCall?.[1] as string;

      expect(configContent).toContain('objectOverrides');
      expect(configContent).toContain('getDefaultConfig');
      expect(configContent).toContain('getRequestScopedDatabase');
      expect(configContent).toContain('getSmrtConfig');
      expect(configContent).toContain('getCollection');
      expect(configContent).toContain('import { ObjectRegistry }');
      expect(configContent).toContain(
        "T extends import('@happyvertical/smrt-core').SmrtObject",
      );
      expect(configContent).toContain(
        '{ ...(defaults.db as any), ...(override.db as any) }',
      );
      expect(configContent).toContain('requestScopedDb ?? config.db');
    });

    it('does not let transitive collection subclasses emit model CRUD routes', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Widget: {
            className: 'Widget',
            collection: 'widgets',
            extends: 'SmrtObject',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
          WidgetCollection: {
            className: 'WidgetCollection',
            collection: 'widgets',
            extends: 'SmrtCollection',
            extendsTypeArg: 'Widget',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
          SpecialWidget: {
            className: 'SpecialWidget',
            collection: 'specialWidgets',
            extends: 'SmrtObject',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
          SpecialWidgetCollection: {
            className: 'SpecialWidgetCollection',
            collection: 'widgets',
            extends: 'WidgetCollection',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
      });

      const generatedWidgetRoutes = vi
        .mocked(writeFileSync)
        .mock.calls.filter(([filePath]) =>
          String(filePath).includes('/src/routes/api/widgets/'),
        );
      expect(generatedWidgetRoutes).toEqual([]);
    });

    it('resolves an inherited collection item type for custom routes', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Widget: {
            className: 'Widget',
            collection: 'widgets',
            extends: 'SmrtObject',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
          WidgetCollection: {
            className: 'WidgetCollection',
            collection: 'widgets',
            extends: 'SmrtCollection',
            extendsTypeArg: 'Widget',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
          SpecialWidget: {
            className: 'SpecialWidget',
            collection: 'specialWidgets',
            extends: 'SmrtObject',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
          SpecialWidgetCollection: {
            className: 'SpecialWidgetCollection',
            collection: 'widgets',
            extends: 'WidgetCollection',
            fields: {},
            methods: {
              restoreSpecial: {
                name: 'restoreSpecial',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
                isStatic: false,
              },
            },
            decoratorConfig: {
              api: { include: ['restoreSpecial'] },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
      });

      const route = vi
        .mocked(writeFileSync)
        .mock.calls.find(([filePath]) =>
          String(filePath).includes(
            '/src/routes/api/widgets/restoreSpecial/+server.ts',
          ),
        );
      expect(route).toBeDefined();
      const content = route?.[1] as string;
      expectGetCollectionCall(content, 'Widget', 'Widget');
      expect(content).not.toContain("getCollection('SpecialWidget')");
    });

    it('keeps an inherited item type name when a partial manifest omits the item', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          WidgetCollection: {
            className: 'WidgetCollection',
            collection: 'widgets',
            extends: 'SmrtCollection',
            extendsTypeArg: 'Widget',
            fields: {},
            methods: {
              restoreSpecial: {
                name: 'restoreSpecial',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
                isStatic: false,
              },
            },
            decoratorConfig: {
              api: { include: ['restoreSpecial'] },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
      });

      const route = vi
        .mocked(writeFileSync)
        .mock.calls.find(([filePath]) =>
          String(filePath).includes(
            '/src/routes/api/widgets/restoreSpecial/+server.ts',
          ),
        );
      expect(route).toBeDefined();
      const content = route?.[1] as string;
      expect(content).toContain("    'Widget',");
      expect(content).not.toContain("'WidgetCollection'");
    });

    it('should skip config generation when file already exists', async () => {
      vi.mocked(existsSync).mockReturnValue(true);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      });

      // Should not write config file
      const configWrites = vi
        .mocked(writeFileSync)
        .mock.calls.filter((call) => call[0].toString().endsWith('smrt.ts'));
      expect(configWrites).toHaveLength(0);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Config file already exists'),
      );

      consoleSpy.mockRestore();
    });

    it('should use custom config path and filename', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/config',
        configFileName: 'smrt-config.ts',
      });

      // Should check custom path
      expect(existsSync).toHaveBeenCalledWith(
        join(projectRoot, 'src/lib/config', 'smrt-config.ts'),
      );

      // Should write to custom location
      expect(writeFileSync).toHaveBeenCalledWith(
        join(projectRoot, 'src/lib/config', 'smrt-config.ts'),
        expect.any(String),
        'utf-8',
      );
    });

    it('should generate smrt-register with explicit package registrations', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const manifest: SmartObjectManifest = {
        packageName: '@test/app',
        smrtDependencies: [
          '@happyvertical/smrt-core',
          '@happyvertical/smrt-fields',
        ],
        objects: {
          LocalThing: {
            className: 'LocalThing',
            collection: 'localthings',
            fields: {},
            methods: {},
            filePath: join(projectRoot, 'src/lib/objects/LocalThing.ts'),
            decoratorConfig: { api: true },
          },
          '@test/pkg:ExternalThing': {
            className: 'ExternalThing',
            collection: 'externalthings',
            fields: {},
            methods: {},
            packageName: '@test/pkg',
            filePath: '/virtual/node_modules/@test/pkg/dist/ExternalThing.js',
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
      });

      const registrationCall = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().endsWith('src/lib/server/smrt-register.ts'),
        );

      expect(registrationCall).toBeDefined();
      const registrationContent = registrationCall?.[1] as string;

      expect(registrationContent).toContain(
        "import { ObjectRegistry } from '@happyvertical/smrt-core';",
      );
      expect(registrationContent).toContain(
        "import '../../../.smrt/register.js';",
      );
      expect(registrationContent).toMatch(
        /ObjectRegistry\.register\(LocalThing,\s*\{\s*name: 'LocalThing',\s*packageName: '@test\/app',\s*_manifest: smrtRegistrationManifests\['LocalThing'\],\s*_manifestKey: 'LocalThing',\s*\}\);/s,
      );
      expect(registrationContent).toMatch(
        /ObjectRegistry\.register\(ExternalThing,\s*\{\s*name: 'ExternalThing',\s*packageName: '@test\/pkg',\s*_manifest: smrtRegistrationManifests\['@test\/pkg:ExternalThing'\],\s*_manifestKey: '@test\/pkg:ExternalThing',\s*\}\);/s,
      );
      expect(registrationContent).toContain(
        'const smrtRegistrationManifests = JSON.parse(',
      );

      // #2341: smrt-register.ts is tracked in consumer repositories, so the
      // embedded manifest must never carry the generating machine's absolute
      // paths — that made the file uncommittable and left every build dirty.
      expect(registrationContent).not.toContain(projectRoot);
      const embedded = JSON.parse(
        JSON.parse(
          registrationContent.match(
            /const smrtRegistrationManifests = JSON\.parse\((".*?")\);/s,
          )?.[1] as string,
        ),
      ) as Record<string, { objects: Record<string, { filePath?: string }> }>;
      expect(embedded.LocalThing.objects.LocalThing.filePath).toBe(
        'src/lib/objects/LocalThing.ts',
      );
      for (const entry of Object.values(embedded)) {
        for (const objectDef of Object.values(entry.objects)) {
          expect(objectDef.filePath).not.toMatch(/^([/\\]|[A-Za-z]:[/\\])/);
        }
      }
    });

    it('should fall back to object package metadata and skip empty re-registrations', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const manifest: SmartObjectManifest = {
        objects: {
          LocalThing: {
            className: 'LocalThing',
            collection: 'localthings',
            fields: {},
            methods: {},
            packageName: '@test/app',
            filePath: join(projectRoot, 'src/lib/objects/LocalThing.ts'),
            decoratorConfig: { api: true },
          },
          UnqualifiedThing: {
            className: 'UnqualifiedThing',
            collection: 'unqualifiedthings',
            fields: {},
            methods: {},
            filePath: join(projectRoot, 'src/lib/objects/UnqualifiedThing.ts'),
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
      });

      const registrationCall = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().endsWith('src/lib/server/smrt-register.ts'),
        );

      expect(registrationCall).toBeDefined();
      const registrationContent = registrationCall?.[1] as string;

      expect(registrationContent).toMatch(
        /ObjectRegistry\.register\(LocalThing,\s*\{\s*name: 'LocalThing',\s*packageName: '@test\/app',\s*_manifest: smrtRegistrationManifests\['LocalThing'\],\s*_manifestKey: 'LocalThing',\s*\}\);/s,
      );
      expect(registrationContent).not.toContain(
        'ObjectRegistry.register(UnqualifiedThing, {});',
      );
    });

    it('isolates same-name package metadata in generated registrations', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const manifest: SmartObjectManifest = {
        objects: {
          '@test/a:SharedThing': {
            className: 'SharedThing',
            collection: 'sharedthings',
            fields: { alpha: { type: 'text' } },
            methods: {},
            packageName: '@test/a',
            filePath: '/virtual/node_modules/@test/a/dist/SharedThing.js',
            decoratorConfig: { tableName: 'a_shared_things' },
            schema: { tableName: 'a_shared_things' },
          },
          '@test/b:SharedThing': {
            className: 'SharedThing',
            collection: 'sharedthings',
            fields: { beta: { type: 'number' } },
            methods: {},
            packageName: '@test/b',
            filePath: '/virtual/node_modules/@test/b/dist/SharedThing.js',
            decoratorConfig: { tableName: 'b_shared_things' },
            schema: { tableName: 'b_shared_things' },
          },
          '@test/c:__smrt_SharedThing_1': {
            className: '__smrt_SharedThing_1',
            collection: 'reservedbindings',
            fields: {},
            methods: {},
            packageName: '@test/c',
            filePath:
              '/virtual/node_modules/@test/c/dist/__smrt_SharedThing_1.js',
            decoratorConfig: { tableName: 'reserved_bindings' },
            schema: { tableName: 'reserved_bindings' },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
      });

      const registrationCall = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().endsWith('src/lib/server/smrt-register.ts'),
        );
      const registrationContent = registrationCall?.[1] as string;

      expect(registrationContent).toContain(
        "import { SharedThing as __smrt_SharedThing_2 } from '@test/a';",
      );
      expect(registrationContent).toContain(
        "import { SharedThing as __smrt_SharedThing_3 } from '@test/b';",
      );
      expect(registrationContent).toContain(
        'ObjectRegistry.register(__smrt_SharedThing_2, {',
      );
      expect(registrationContent).toContain(
        "_manifest: smrtRegistrationManifests['@test/a:SharedThing']",
      );
      expect(registrationContent).toContain(
        "_manifest: smrtRegistrationManifests['@test/b:SharedThing']",
      );

      const literal = registrationContent.match(
        /const smrtRegistrationManifests = JSON\.parse\((.+)\);/u,
      )?.[1];
      expect(literal).toBeDefined();
      const manifests = JSON.parse(JSON.parse(literal || '"{}"'));
      expect(Object.keys(manifests['@test/a:SharedThing'].objects)).toEqual([
        '@test/a:SharedThing',
      ]);
      expect(
        manifests['@test/a:SharedThing'].objects['@test/a:SharedThing'],
      ).toMatchObject({
        fields: { alpha: { type: 'text' } },
        schema: { tableName: 'a_shared_things' },
      });
      expect(
        manifests['@test/b:SharedThing'].objects['@test/b:SharedThing'],
      ).toMatchObject({
        fields: { beta: { type: 'number' } },
        schema: { tableName: 'b_shared_things' },
      });
    });

    it('should skip explicit re-registration for collection classes', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const manifest: SmartObjectManifest = {
        objects: {
          ImageCollection: {
            className: 'ImageCollection',
            collection: 'imagecollections',
            extends: 'SmrtCollection',
            fields: {},
            methods: {},
            packageName: '@happyvertical/smrt-images',
            filePath: join(projectRoot, 'src/lib/objects/ImageCollection.ts'),
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
      });

      const registrationCall = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().endsWith('src/lib/server/smrt-register.ts'),
        );

      expect(registrationCall).toBeDefined();
      const registrationContent = registrationCall?.[1] as string;

      expect(registrationContent).toContain(
        "import '../objects/ImageCollection';",
      );
      expect(registrationContent).not.toContain(
        'ObjectRegistry.register(ImageCollection',
      );
    });
  });

  describe('Route Template Generation', () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(false);
    });

    it('should generate collection route with list and create', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Product: {
            className: 'Product',
            collection: 'products',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: {
                include: ['list', 'create'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should write collection route
      const collectionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('products/+server.ts'),
        );

      expect(collectionRoute).toBeDefined();
      const content = collectionRoute?.[1] as string;

      // Should import from centralized config
      expect(content).toContain(
        "import { getCollection } from '$lib/server/smrt'",
      );

      // Should include GET handler for list
      expect(content).toContain('export const GET: RequestHandler');
      expectGetCollectionCall(content, 'Product', 'Product');
      expect(content).toContain('await collection.list');

      // Should include POST handler for create
      expect(content).toContain('export const POST: RequestHandler');
      expect(content).toContain('await collection.create');
      expect(content).not.toContain('await item.save()');
      expect(content).toContain(
        "import { normalizeTypedHttpError } from '@happyvertical/smrt-core';",
      );
      expect(content).toContain('function smrtRouteErrorResponse');
      expect(content).toContain('return smrtRouteErrorResponse(cause);');
      expect(content).toContain(
        "return json({ error: 'Internal server error' }, { status: 500 });",
      );

      // Should NOT include hardcoded config
      expect(content).not.toContain('process.env.DATABASE_URL');
      expect(content).not.toContain('process.env.OPENAI_API_KEY');
    });

    it('should generate item route with get, update, delete', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Product: {
            className: 'Product',
            collection: 'products',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: {
                include: ['get', 'update', 'delete'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should write item route
      const itemRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('products/[id]/+server.ts'),
        );

      expect(itemRoute).toBeDefined();
      const content = itemRoute?.[1] as string;

      // Should use centralized config
      expect(content).toContain(
        "import { getCollection } from '$lib/server/smrt'",
      );

      // Should use a concrete model type while keeping runtime lookup by name.
      expectGetCollectionCall(content, 'Product', 'Product');
      expect(content).toContain(
        "import type { Product } from '$lib/objects/Product';",
      );

      // Should include GET handler
      expect(content).toContain('export const GET: RequestHandler');
      expect(content).toContain('await collection.get(params.id)');

      // Should include PUT handler
      expect(content).toContain('export const PUT: RequestHandler');
      expect(content).toContain('Object.assign(item, data)');
      expect(content).toContain('await item.save()');
      expect(content).toContain('return smrtRouteErrorResponse(cause);');

      // Should include DELETE handler
      expect(content).toContain('export const DELETE: RequestHandler');
      expect(content).toContain('await item.delete()');
    });

    it('should generate custom action routes', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Document: {
            className: 'Document',
            collection: 'documents',
            fields: {},
            methods: {
              analyze: {
                name: 'analyze',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
              summarize: {
                name: 'summarize',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['get', 'analyze', 'summarize'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should write analyze action route
      const analyzeRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('documents/[id]/analyze/+server.ts'),
        );

      expect(analyzeRoute).toBeDefined();
      const analyzeContent = analyzeRoute?.[1] as string;

      expect(analyzeContent).toContain(
        "import { getCollection } from '$lib/server/smrt'",
      );

      // Should use a concrete model type while keeping runtime lookup by name.
      expectGetCollectionCall(analyzeContent, 'Document', 'Document');
      expect(analyzeContent).toContain(
        "import type { Document } from '$lib/objects/Document';",
      );

      expect(analyzeContent).toContain('export const POST: RequestHandler');
      expect(analyzeContent).toContain('await item.analyze');
      expect(analyzeContent).toContain("action: 'analyze'");
      expect(analyzeContent).toContain(
        "import { normalizeCustomActionFailure, normalizeTypedHttpError } from '@happyvertical/smrt-core';",
      );
      expect(analyzeContent).toContain('let result: unknown;');
      expect(analyzeContent).toContain('return smrtRouteErrorResponse(cause);');
      expect(analyzeContent).toContain(
        'return json({ error: failure }, { status: failure.status });',
      );

      // Should write summarize action route
      const summarizeRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('documents/[id]/summarize/+server.ts'),
        );

      expect(summarizeRoute).toBeDefined();
    });

    it('should generate collection-scoped custom routes for static methods', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Document: {
            className: 'Document',
            collection: 'documents',
            fields: {},
            methods: {
              browseFacts: {
                name: 'browseFacts',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isStatic: true,
                isPublic: true,
              },
              searchFacts: {
                name: 'searchFacts',
                parameters: [
                  { name: 'query', type: 'string' },
                  { name: 'limit', type: 'number' },
                ],
                returnType: 'Promise<any>',
                isStatic: true,
                isPublic: true,
              },
              searchReserved: {
                name: 'searchReserved',
                parameters: [
                  { name: '__smrt_options', type: 'string' },
                  { name: 'query', type: 'string' },
                ],
                returnType: 'Promise<any>',
                isStatic: true,
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['browseFacts', 'searchFacts', 'searchReserved'],
                routes: {
                  browseFacts: {
                    scope: 'collection',
                    method: 'GET',
                    path: 'facts',
                  },
                  searchFacts: {
                    scope: 'collection',
                    method: 'GET',
                    path: 'search-facts',
                  },
                  searchReserved: {
                    scope: 'collection',
                    method: 'GET',
                    path: 'search-reserved',
                  },
                },
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const browseFactsRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('documents/facts/+server.ts'),
        );

      expect(browseFactsRoute).toBeDefined();
      const content = browseFactsRoute?.[1] as string;

      expect(content).toContain(
        "import { ObjectRegistry } from '@happyvertical/smrt-core'",
      );
      expect(content).toContain('export const GET: RequestHandler');
      expect(content).toContain(
        "const optionsMarker = searchParams.get('__smrt_options');",
      );
      expect(content).toContain("optionsMarker === 'undefined'");
      expect(content).not.toMatch(
        /Object\.fromEntries\([\s\S]*\),\n\s*\) as ActionArgs\[0\];/,
      );
      expect(content).toContain("ObjectRegistry.getClass('Document')");
      expect(content).toContain('await ClassRef.browseFacts(options)');
      expect(content).not.toContain('params.id');

      const searchFactsRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('documents/search-facts/+server.ts'),
        );
      expect(searchFactsRoute).toBeDefined();
      const searchContent = searchFactsRoute?.[1] as string;
      expect(searchContent).toContain(
        'new URL(request.url).searchParams.entries(),',
      );
      expect(searchContent).toContain(
        'await ClassRef.searchFacts(options.query, options.limit)',
      );

      const reservedRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('documents/search-reserved/+server.ts'),
        );
      expect(reservedRoute).toBeDefined();
      const reservedContent = reservedRoute?.[1] as string;
      expect(reservedContent).toContain(
        'new URL(request.url).searchParams.entries(),',
      );
      expect(reservedContent).toContain(
        'await ClassRef.searchReserved(options.__smrt_options, options.query)',
      );
    });

    it('emits generated route handlers without explicit any (#1656)', async () => {
      const manifest = {
        objects: {
          Widget: {
            className: 'Widget',
            collection: 'widgets',
            fields: {
              name: { type: 'text' },
            },
            methods: {
              analyze: {
                name: 'analyze',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: true,
              tenantScoped: { mode: 'optional' },
            },
          },
          WidgetCollection: {
            className: 'WidgetCollection',
            collection: 'widgets',
            fields: {},
            methods: {
              restoreByName: {
                name: 'restoreByName',
                parameters: [{ name: 'name', type: 'string' }],
                returnType: 'Promise<any>',
                isStatic: false,
                isPublic: true,
              },
            },
            decoratorConfig: { api: true },
            extends: 'SmrtCollection',
            extendsTypeArg: 'Widget',
          },
        },
      } as unknown as SmartObjectManifest;

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        knowledge: {
          api: { enabled: true },
        },
      });

      const routeContents = vi
        .mocked(writeFileSync)
        .mock.calls.filter((call) => call[0].toString().endsWith('+server.ts'))
        .map((call) => call[1] as string);

      expect(routeContents.length).toBeGreaterThan(0);
      for (const content of routeContents) {
        expect(content).not.toMatch(/\bany\b/);
      }

      const allRoutes = routeContents.join('\n');
      expect(allRoutes).toContain('getCollection<Widget>');
      expect(allRoutes).not.toContain('getCollection<any>');
      expect(allRoutes).toContain('if (seen.has(value)) return null;');
    });

    it('should pass dynamic path params into custom GET action options', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Document: {
            className: 'Document',
            collection: 'documents',
            fields: {},
            methods: {
              evaluateReviewProfileAction: {
                name: 'evaluateReviewProfileAction',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['evaluateReviewProfileAction'],
                routes: {
                  evaluateReviewProfileAction: {
                    method: 'GET',
                    path: 'review-profiles/[profileKey]',
                  },
                },
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const reviewProfileRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0]
            .toString()
            .includes('documents/[id]/review-profiles/[profileKey]/+server.ts'),
        );

      expect(reviewProfileRoute).toBeDefined();
      const content = reviewProfileRoute?.[1] as string;

      expect(content).toContain(
        'export const GET: RequestHandler = async ({ locals, params, request }) => {',
      );
      // Fail-closed auth guard (#1540): reads do not require auth as a mutation.
      expect(content).toContain('requireRouteAuth(locals, false);');
      expect(content).toContain(
        "type ActionArgs = Parameters<Document['evaluateReviewProfileAction']>;",
      );
      expect(content).toContain('const pathParams = {');
      expect(content).toContain('profileKey: params.profileKey,');
      expect(content).toContain(
        '...Object.fromEntries(new URL(request.url).searchParams.entries()),',
      );
      expect(content).toContain('...pathParams,');
      expect(content).toContain(
        'await item.evaluateReviewProfileAction(options)',
      );
    });

    it('should expand multi-parameter collection methods into positional args', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Document: {
            className: 'Document',
            collection: 'documents',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: true,
              tenantScoped: { mode: 'optional' },
            },
          },
          DocumentCollection: {
            className: 'DocumentCollection',
            collection: 'documents',
            fields: {},
            methods: {
              restoreIntoContent: {
                name: 'restoreIntoContent',
                parameters: [
                  { name: 'contentId', type: 'string' },
                  { name: 'versionNumber', type: 'number' },
                ],
                returnType: 'Promise<any>',
                isStatic: false,
                isPublic: true,
              },
            },
            decoratorConfig: { api: true },
            extends: 'SmrtCollection',
            extendsTypeArg: 'Document',
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const restoreRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0]
            .toString()
            .includes('documents/restoreIntoContent/+server.ts'),
        );

      expect(restoreRoute).toBeDefined();
      const content = restoreRoute?.[1] as string;

      expect(content).toContain('type ActionArgs = Parameters<');
      expect(content).toContain("from '@happyvertical/smrt-tenancy'");
      expect(content).toContain('establishTenantContext(locals);');
      expect(content).toContain('const rawBody = await request.text();');
      expect(content).toContain(
        "const body: unknown = rawBody.trim() === '' ? undefined : JSON.parse(rawBody);",
      );
      expect(content).toContain(
        'const options = readJsonRecord(body) as ActionOptions;',
      );
      expect(content).toMatch(
        /await (?:typedCollection|collection)\.restoreIntoContent\(options(?:\["contentId"\]|\.contentId), options(?:\["versionNumber"\]|\.versionNumber)\)/,
      );
    });

    it('should merge custom handlers that share the same route path', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Document: {
            className: 'Document',
            collection: 'documents',
            fields: {},
            methods: {
              getFactsState: {
                name: 'getFactsState',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
              syncFacts: {
                name: 'syncFacts',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['getFactsState', 'syncFacts'],
                routes: {
                  getFactsState: {
                    scope: 'item',
                    method: 'GET',
                    path: 'facts',
                  },
                  syncFacts: {
                    scope: 'item',
                    method: 'PUT',
                    path: 'facts',
                  },
                },
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const factsRouteWrites = vi
        .mocked(writeFileSync)
        .mock.calls.filter((call) =>
          call[0].toString().includes('documents/[id]/facts/+server.ts'),
        );

      expect(factsRouteWrites).toHaveLength(1);
      const content = factsRouteWrites[0]?.[1] as string;

      expect(content).toContain('export const GET: RequestHandler');
      expect(content).toContain('export const PUT: RequestHandler');
      expect(content).toContain('await item.getFactsState(options)');
      expect(content).toContain('await item.syncFacts(options)');
    });

    it('keeps non-static custom routes item-scoped despite a collection override', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          Document: {
            className: 'Document',
            collection: 'documents',
            fields: {},
            methods: {
              browseFacts: {
                name: 'browseFacts',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isStatic: false,
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['browseFacts'],
                routes: {
                  browseFacts: {
                    scope: 'collection',
                    method: 'GET',
                    path: 'facts',
                  },
                },
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const browseFactsRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('documents/[id]/facts/+server.ts'),
        );
      expect(browseFactsRoute).toBeDefined();
      const content = browseFactsRoute?.[1] as string;
      expect(content).toContain('await item.browseFacts(options)');
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      consoleWarnSpy.mockRestore();
    });

    it('should skip actions not in api config', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Document: {
            className: 'Document',
            collection: 'documents',
            fields: {},
            methods: {
              publicAction: {
                name: 'publicAction',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
              },
              privateAction: {
                name: 'privateAction',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['publicAction'],
                exclude: ['privateAction'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should write publicAction route
      const publicRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('publicAction/+server.ts'),
        );
      expect(publicRoute).toBeDefined();

      // Should NOT write privateAction route
      const privateRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('privateAction/+server.ts'),
        );
      expect(privateRoute).toBeUndefined();
    });

    it('should import from package for external objects', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Meeting: {
            className: 'Meeting',
            collection: 'meetings',
            packageName: '@happyvertical/praeco',
            fields: {},
            methods: {
              summarize: {
                name: 'summarize',
                parameters: [],
                returnType: 'Promise<string>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['get', 'summarize'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Item route should import from package
      const itemRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('meetings/[id]/+server.ts'),
        );

      expect(itemRoute).toBeDefined();
      const itemContent = itemRoute?.[1] as string;
      expectGetCollectionCall(itemContent, 'Meeting', 'Meeting');
      expect(itemContent).toContain(
        "import type { Meeting } from '@happyvertical/praeco';",
      );

      // Action route should also import from package
      const actionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('meetings/[id]/summarize/+server.ts'),
        );

      expect(actionRoute).toBeDefined();
      const actionContent = actionRoute?.[1] as string;
      expectGetCollectionCall(actionContent, 'Meeting', 'Meeting');
      expect(actionContent).toContain(
        "import type { Meeting } from '@happyvertical/praeco';",
      );
    });

    it('should use $lib path for local objects even when packageName is set', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          '@myapp/dashboard:Invitation': {
            className: 'Invitation',
            collection: 'invitations',
            packageName: '@myapp/dashboard',
            filePath: '/test/project/src/lib/models/Invitation.ts',
            fields: {},
            methods: {
              canBeRedeemed: {
                name: 'canBeRedeemed',
                parameters: [],
                returnType: 'boolean',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['get', 'canBeRedeemed'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/models',
      });

      // Action route should use $lib path, NOT the packageName
      const actionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0]
            .toString()
            .includes('invitations/[id]/canBeRedeemed/+server.ts'),
        );

      expect(actionRoute).toBeDefined();
      const content = actionRoute?.[1] as string;

      // Routes import the local type, not the package name, while retaining
      // the package-qualified runtime registry key.
      expect(content).toContain(
        "import type { Invitation } from '$lib/models/Invitation';",
      );
      expect(content).not.toContain("from '@myapp/dashboard'");

      expectGetCollectionCall(
        content,
        '@myapp/dashboard:Invitation',
        'Invitation',
      );
      expect(content).toContain(
        'export const POST: RequestHandler = async ({ locals, params }) => {',
      );
      // Fail-closed auth guard (#1540): POST is a mutating verb.
      expect(content).toContain('requireRouteAuth(locals, true);');
      expect(content).not.toContain('{ params, request }');
    });

    it('should use route-relative type imports for local objects outside src/lib', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Product: {
            className: 'Product',
            collection: 'products',
            filePath: '/test/project/src/models/Product.ts',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: {
                include: ['list', 'get'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/models',
      });

      const collectionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('products/+server.ts'),
        );
      const itemRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('products/[id]/+server.ts'),
        );

      expect(collectionRoute).toBeDefined();
      expect(itemRoute).toBeDefined();
      expect(collectionRoute?.[1]).toContain(
        "import type { Product } from '../../../models/Product';",
      );
      expect(itemRoute?.[1]).toContain(
        "import type { Product } from '../../../../models/Product';",
      );
    });

    it('should extract simple class name from qualified names', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          '@blindmanpress/dashboard:Invitation': {
            className: 'Invitation',
            collection: 'invitations',
            fields: {},
            methods: {
              canBeRedeemed: {
                name: 'canBeRedeemed',
                parameters: [],
                returnType: 'boolean',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['get', 'canBeRedeemed'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Action route should use simple class name for import and generic
      const actionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0]
            .toString()
            .includes('invitations/[id]/canBeRedeemed/+server.ts'),
        );

      expect(actionRoute).toBeDefined();
      const content = actionRoute?.[1] as string;

      // Routes should import the simple model type without putting the
      // qualified registry key inside the import braces.
      expect(content).toContain(
        "import type { Invitation } from '$lib/objects/Invitation';",
      );
      expect(content).not.toContain('import type { @blindmanpress');

      // Should still use the full qualified name as the registry key
      expectGetCollectionCall(
        content,
        '@blindmanpress/dashboard:Invitation',
        'Invitation',
      );
    });

    it('should handle api config exclude list', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Product: {
            className: 'Product',
            collection: 'products',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: {
                exclude: ['delete'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should write item route
      const itemRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('products/[id]/+server.ts'),
        );

      expect(itemRoute).toBeDefined();
      const content = itemRoute?.[1] as string;

      // Should include GET and PUT
      expect(content).toContain('export const GET: RequestHandler');
      expect(content).toContain('export const PUT: RequestHandler');

      // Should NOT include DELETE
      expect(content).not.toContain('export const DELETE: RequestHandler');
    });

    it('should skip route generation when api is disabled', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          InternalObject: {
            className: 'InternalObject',
            collection: 'internalobjects',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: false,
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should log skip message
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping InternalObject - API disabled'),
      );

      // Should not write any route files for this object
      const objectRoutes = vi
        .mocked(writeFileSync)
        .mock.calls.filter(
          (call) =>
            call[0].toString().includes('internalobjects') &&
            !call[0].toString().endsWith('smrt.ts'),
        );

      expect(objectRoutes).toHaveLength(0);

      consoleSpy.mockRestore();
    });

    it('should remove stale auto-generated route files before regenerating', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readdirSync).mockImplementation((path) => {
        if (path.toString() === join(projectRoot, 'src/routes/api')) {
          return [
            {
              name: '+server.ts',
              isDirectory: () => false,
              isFile: () => true,
            },
          ] as any;
        }

        return [];
      });
      vi.mocked(readFileSync).mockImplementation((path) => {
        if (
          path.toString() === join(projectRoot, 'src/routes/api', '+server.ts')
        ) {
          return '// Auto-generated by @smrt/core vite plugin\n';
        }

        return '';
      });

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      expect(unlinkSync).toHaveBeenCalledWith(
        join(projectRoot, 'src/routes/api', '+server.ts'),
      );
    });
  });

  describe('.gitignore Updates', () => {
    it('should add exact generated route paths to .gitignore', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('node_modules/\n.env\n');

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should read existing .gitignore
      expect(readFileSync).toHaveBeenCalledWith(
        join(projectRoot, '.gitignore'),
        'utf-8',
      );

      // Should write updated .gitignore
      const gitignoreWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString().endsWith('.gitignore'));

      expect(gitignoreWrite).toBeDefined();
      const content = gitignoreWrite?.[1] as string;

      expect(content).toContain(
        '# BEGIN SMRT auto-generated routes (Vite plugin)',
      );
      expect(content).toContain('src/routes/api/testobjects/+server.ts');
      expect(content).toContain(
        'src/routes/api/testobjects/\\[id\\]/+server.ts',
      );
      expect(content).not.toContain('src/routes/api/**/+server.ts');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.env');
    });

    it('should migrate only the legacy SMRT broad route entry', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        [
          'node_modules/',
          '# Application-owned broad rule',
          'src/routes/api/**/+server.ts',
          '# SMRT auto-generated routes (from Vite plugin)',
          'src/routes/api/**/+server.ts',
          '# Application-owned rule',
          'src/routes/api/_resources/+server.ts',
          '',
        ].join('\n'),
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const gitignoreWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString().endsWith('.gitignore'));
      const content = gitignoreWrite?.[1] as string;

      expect(gitignoreWrite).toBeDefined();
      expect(
        content
          .split('\n')
          .filter((line) => line === 'src/routes/api/**/+server.ts'),
      ).toHaveLength(1);
      expect(content).toContain('src/routes/api/testobjects/+server.ts');
      expect(content).toContain('# Application-owned broad rule');
      expect(content).toContain('# Application-owned rule');
      expect(content).toContain('src/routes/api/_resources/+server.ts');

      consoleSpy.mockRestore();
    });

    it('should create .gitignore if it does not exist', async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        // Config file exists, but .gitignore doesn't
        return path.toString().endsWith('smrt.ts');
      });

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should write new .gitignore
      const gitignoreWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString().endsWith('.gitignore'));

      expect(gitignoreWrite).toBeDefined();
      const content = gitignoreWrite?.[1] as string;

      expect(content).toContain(
        '# BEGIN SMRT auto-generated routes (Vite plugin)',
      );
      expect(content).toContain('src/routes/api/testobjects/+server.ts');
      expect(content).not.toContain('src/routes/api/**/+server.ts');
    });

    it('should migrate a legacy pair written under an earlier routesDir', async () => {
      // #2198: `@happyvertical/smrt-content` adopted the plugin at
      // `src/routes/api` and later moved to `src/routes/api/v1`, so the legacy
      // pair never matched a routesDir-derived pattern and survived every
      // regeneration.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        [
          'node_modules/',
          '# SMRT auto-generated routes (from Vite plugin)',
          'src/routes/api/**/+server.ts',
          '!src/routes/api/v1/**/+server.ts',
          '',
        ].join('\n'),
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api/v1',
        objectsDir: 'src/lib/objects',
      });

      const gitignoreWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString().endsWith('.gitignore'));
      const content = gitignoreWrite?.[1] as string;

      expect(gitignoreWrite).toBeDefined();
      expect(content).not.toContain(
        '# SMRT auto-generated routes (from Vite plugin)',
      );
      expect(content).not.toContain('src/routes/api/**/+server.ts');
      // The negation is generator-owned idiom directly under the generator's
      // own header, and leaving it re-includes whatever the bounded block
      // stops listing.
      expect(content).not.toContain('!src/routes/api/v1/**/+server.ts');
      expect(content).toContain('src/routes/api/v1/testobjects/+server.ts');
      expect(content).toContain('node_modules/');

      consoleSpy.mockRestore();
    });

    it('should migrate a surviving legacy pair alongside an existing bounded block', async () => {
      // #2198: the first #2185 release appended its bounded block without
      // migrating an unmatched legacy pair, leaving both shapes in the file.
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        [
          '# SMRT auto-generated routes (from Vite plugin)',
          'src/routes/api/**/+server.ts',
          '!src/routes/api/v1/**/+server.ts',
          '',
          '# BEGIN SMRT auto-generated routes (Vite plugin)',
          'src/routes/api/v1/stale/+server.ts',
          '# END SMRT auto-generated routes (Vite plugin)',
          '',
        ].join('\n'),
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api/v1',
        objectsDir: 'src/lib/objects',
      });

      const gitignoreWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString().endsWith('.gitignore'));
      const content = gitignoreWrite?.[1] as string;

      expect(gitignoreWrite).toBeDefined();
      expect(content).not.toContain(
        '# SMRT auto-generated routes (from Vite plugin)',
      );
      expect(content).not.toContain('!src/routes/api/v1/**/+server.ts');
      expect(content).not.toContain('src/routes/api/v1/stale/+server.ts');
      expect(content).toContain('src/routes/api/v1/testobjects/+server.ts');
      expect(
        content
          .split('\n')
          .filter(
            (line) =>
              line === '# BEGIN SMRT auto-generated routes (Vite plugin)',
          ),
      ).toHaveLength(1);

      consoleSpy.mockRestore();
    });

    it('should leave a legacy header with no recognizable pattern beneath it', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        [
          '# SMRT auto-generated routes (from Vite plugin)',
          '# the project rewrote this block by hand',
          'src/routes/api/legacy-handwritten/+server.ts',
          '',
        ].join('\n'),
      );

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const gitignoreWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString().endsWith('.gitignore'));
      const content = gitignoreWrite?.[1] as string;

      expect(gitignoreWrite).toBeDefined();
      expect(content).toContain(
        '# SMRT auto-generated routes (from Vite plugin)',
      );
      expect(content).toContain('# the project rewrote this block by hand');
      expect(content).toContain('src/routes/api/legacy-handwritten/+server.ts');
      expect(content).toContain('src/routes/api/testobjects/+server.ts');

      consoleSpy.mockRestore();
    });
  });

  describe('Main Generation Flow', () => {
    beforeEach(() => {
      vi.mocked(existsSync).mockReturnValue(false);
    });

    it('should return early if svelteKit is not enabled', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          TestObject: {
            className: 'TestObject',
            collection: 'testobjects',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: false,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should not write any files
      expect(writeFileSync).not.toHaveBeenCalled();
      expect(mkdirSync).not.toHaveBeenCalled();
    });

    it('should generate routes for multiple objects', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          Product: {
            className: 'Product',
            collection: 'products',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
          Category: {
            className: 'Category',
            collection: 'categories',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
          Order: {
            className: 'Order',
            collection: 'orders',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should log summary
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Generated routes for 3 SMRT objects'),
      );

      // Should generate routes for all objects
      const productRoutes = vi
        .mocked(writeFileSync)
        .mock.calls.filter((call) => call[0].toString().includes('products/'));
      const categoryRoutes = vi
        .mocked(writeFileSync)
        .mock.calls.filter((call) =>
          call[0].toString().includes('categories/'),
        );
      const orderRoutes = vi
        .mocked(writeFileSync)
        .mock.calls.filter((call) => call[0].toString().includes('orders/'));

      expect(productRoutes.length).toBeGreaterThan(0);
      expect(categoryRoutes.length).toBeGreaterThan(0);
      expect(orderRoutes.length).toBeGreaterThan(0);

      consoleSpy.mockRestore();
    });

    it('should create directories for routes', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Product: {
            className: 'Product',
            collection: 'products',
            fields: {},
            methods: {
              analyze: {
                name: 'analyze',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: { api: { include: ['get', 'analyze'] } },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should create directories
      const mkdirCalls = vi.mocked(mkdirSync).mock.calls;

      // Should create: config dir, products/[id]/, products/[id]/analyze/
      // (No collection route since 'get' is item-only and 'analyze' is a custom action)
      expect(mkdirCalls.length).toBeGreaterThanOrEqual(3);
      expect(
        mkdirCalls.some((call) => call[0].toString().includes('products')),
      ).toBe(true);
      expect(
        mkdirCalls.some((call) => call[0].toString().includes('products/[id]')),
      ).toBe(true);
    });

    it('should log generation progress', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          Product: {
            className: 'Product',
            collection: 'products',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      expect(consoleSpy).toHaveBeenCalledWith(
        '[smrt] Generating SvelteKit routes...',
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Generated configuration file'),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Generated routes for 1 SMRT objects'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Collection Class Filtering', () => {
    it('should generate collection class methods as collection-scoped routes', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const manifest: SmartObjectManifest = {
        objects: {
          Invitation: {
            className: 'Invitation',
            collection: 'invitations',
            fields: {},
            methods: {
              canBeRedeemed: {
                isPublic: true,
                parameters: [],
              },
            },
            decoratorConfig: { api: true },
            filePath: '/test/project/src/lib/models/Invitation.ts',
          },
          InvitationCollection: {
            className: 'InvitationCollection',
            collection: 'invitations', // Same as Invitation (inherited by manifest-generator)
            fields: {},
            methods: {
              findByToken: {
                isPublic: true,
                parameters: [{ name: 'token', type: 'string' }],
              },
            },
            decoratorConfig: { api: true },
            extends: 'SmrtCollection',
            extendsTypeArg: 'Invitation',
            filePath: '/test/project/src/lib/models/InvitationCollection.ts',
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should report both the item class and collection class route generation
      expect(consoleSpy).toHaveBeenCalledWith(
        '[smrt] Generated routes for 2 SMRT objects',
      );

      // Should generate routes for Invitation (item class)
      const writeFileCalls = vi
        .mocked(writeFileSync)
        .mock.calls.map(([path]) => path as string);
      const invitationRoutes = writeFileCalls.filter((p) =>
        p.includes('invitations'),
      );

      // Should have collection route, item route, item action route, and collection method route
      expect(invitationRoutes).toEqual(
        expect.arrayContaining([
          expect.stringContaining('invitations/+server.ts'),
          expect.stringContaining('invitations/[id]/+server.ts'),
          expect.stringContaining('invitations/[id]/canBeRedeemed/+server.ts'),
          expect.stringContaining('invitations/findByToken/+server.ts'),
        ]),
      );

      const findByTokenRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('invitations/findByToken/+server.ts'),
        );
      expect(findByTokenRoute).toBeDefined();
      const findByTokenContent = findByTokenRoute?.[1] as string;
      expectGetCollectionCall(findByTokenContent, 'Invitation', 'Invitation');
      expect(findByTokenContent).toMatch(
        /await (?:typedCollection|collection)\.findByToken\(options(?:\["token"\]|\.token)\)/,
      );

      consoleSpy.mockRestore();
    });

    it('should not skip non-collection classes that happen to have extends set', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Meeting: {
            className: 'Meeting',
            collection: 'meetings',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
            extends: 'Event', // STI: extends Event, NOT SmrtCollection
            filePath: '/test/project/src/lib/models/Meeting.ts',
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      // Should generate routes for Meeting (it's an STI child, not a collection)
      const writeFileCalls = vi
        .mocked(writeFileSync)
        .mock.calls.map(([path]) => path as string);
      const meetingRoutes = writeFileCalls.filter((p) =>
        p.includes('meetings'),
      );
      expect(meetingRoutes.length).toBeGreaterThan(0);
    });
  });

  describe('Standard Response Serializers', () => {
    it('should apply the item serializer to standard item and list responses by default', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Content: {
            className: 'Content',
            collection: 'contents',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: {
                include: ['list', 'get', 'create', 'update'],
                serializers: {
                  item: {
                    importPath: '$lib/server/content-api-serializers',
                    exportName: 'serializeContent',
                  },
                },
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const collectionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('contents/+server.ts'),
        );
      expect(collectionRoute).toBeDefined();
      const collectionContent = collectionRoute?.[1] as string;

      expect(collectionContent).toContain(
        "import { serializeContent as serializeItemResponse } from '$lib/server/content-api-serializers';",
      );
      expect(collectionContent).toContain('await serializeItemResponse(item)');
      expect(collectionContent).toContain('applyReadPermissionRedaction(');
      // Content uses a custom serializer (serializeContent loads related tables),
      // so the route keeps the v1 body-hash ETag rather than the v2 per-table
      // version source, which cannot observe related-table changes (#1765).
      expect(collectionContent).toContain(
        'return conditionalJson(request, { items: serializedItems, count, limit, offset });',
      );
      // #2367: the page is bounded and ordered, including on the custom-serializer
      // (v1 ETag) branch — the ordering is a property of the query, not of the
      // caching strategy.
      expect(collectionContent).toContain(
        'const LIST_ORDER_BY = ["created_at DESC","id ASC"];',
      );
      expect(collectionContent).toContain('function listBounds(url: URL)');
      expect(collectionContent).toContain(
        'const { limit, offset } = listBounds(url);',
      );
      expect(collectionContent).toContain('orderBy: LIST_ORDER_BY');
      expect(collectionContent).not.toContain(
        "Number(url.searchParams.get('limit')) || 50",
      );
      expect(collectionContent).not.toContain('conditionalVersionedRead');
      expect(collectionContent).toContain(
        'const serializedItem = await serializeItemResponse(item);',
      );
      expect(collectionContent).toContain(
        'applyReadPermissionRedaction(serializedItem, publicJsonOptions)',
      );

      const itemRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('contents/[id]/+server.ts'),
        );
      expect(itemRoute).toBeDefined();
      const itemContent = itemRoute?.[1] as string;

      expect(itemContent).toContain(
        "import { serializeContent as serializeItemResponse } from '$lib/server/content-api-serializers';",
      );
      expect(itemContent).toContain(
        'const serializedItem = await serializeItemResponse(item);',
      );
      expect(itemContent).toContain(
        'return json(applyReadPermissionRedaction(serializedItem, publicJsonOptions));',
      );
    });

    it('should support a dedicated list item serializer', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Content: {
            className: 'Content',
            collection: 'contents',
            fields: {},
            methods: {},
            decoratorConfig: {
              api: {
                include: ['list', 'get'],
                serializers: {
                  item: {
                    importPath: '$lib/server/content-api-serializers',
                    exportName: 'serializeContent',
                  },
                  listItem: {
                    importPath: '$lib/server/content-api-serializers',
                    exportName: 'serializeContentListItem',
                  },
                },
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const collectionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('contents/+server.ts'),
        );
      expect(collectionRoute).toBeDefined();
      const collectionContent = collectionRoute?.[1] as string;

      expect(collectionContent).toContain(
        "import { serializeContent as serializeItemResponse } from '$lib/server/content-api-serializers';",
      );
      expect(collectionContent).toContain(
        "import { serializeContentListItem as serializeListItemResponse } from '$lib/server/content-api-serializers';",
      );
      expect(collectionContent).toContain(
        'await serializeListItemResponse(item)',
      );
      expect(collectionContent).toContain('applyReadPermissionRedaction(');
    });
  });

  // Regression: api.exclude was silently ignored for custom methods when
  // api.include was also set. See smrt#1304.
  describe('Custom-method api.include + api.exclude (smrt#1304)', () => {
    it('should drop methods listed in both api.include and api.exclude', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Thing: {
            className: 'Thing',
            collection: 'things',
            fields: {},
            methods: {
              discover: {
                name: 'discover',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
              execute: {
                name: 'execute',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['discover', 'execute'],
                exclude: ['execute'],
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const discoverWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('things/[id]/discover/+server.ts'),
        );
      const executeWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('things/[id]/execute/+server.ts'),
        );

      expect(discoverWrite).toBeDefined();
      expect(executeWrite).toBeUndefined();
    });
  });

  describe('Knowledge Route Generation', () => {
    it('generates the guarded knowledge route only when explicitly enabled', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Thing: {
            className: 'Thing',
            collection: 'things',
            fields: {},
            methods: {},
            decoratorConfig: { api: true },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        knowledge: {
          api: {
            enabled: false,
          },
        },
      });

      const disabledWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('__smrt/knowledge/+server.ts'),
        );
      expect(disabledWrite).toBeUndefined();

      vi.clearAllMocks();
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(readFileSync).mockReturnValue('');
      vi.mocked(readdirSync).mockReturnValue([]);

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        knowledge: {
          api: {
            enabled: true,
            basePath: '/__smrt/knowledge',
            requireAdmin: true,
            includeDocs: false,
            includePrompts: false,
          },
        },
      });

      const enabledWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('__smrt/knowledge/+server.ts'),
        );
      expect(enabledWrite).toBeDefined();
      expect(enabledWrite?.[1]).toContain('SMRT knowledge requires dev mode');
      expect(enabledWrite?.[1]).toContain('sanitizeKnowledgeArtifact');
      expect(enabledWrite?.[1]).toContain(
        "'cache-control': 'private, no-store'",
      );
      expect(enabledWrite?.[1]).toContain('queryBoolean');
      expect(enabledWrite?.[1]).not.toContain('process.cwd()');
    });
  });

  // Regression: custom-method URL paths used method-name casing instead of
  // kebab-case. See smrt#1305. Default off; opt-in via svelteKit.kebabRoutes.
  describe('kebabRoutes option (smrt#1305)', () => {
    function buildManifest(): SmartObjectManifest {
      return {
        objects: {
          Praeco: {
            className: 'Praeco',
            collection: 'praecos',
            fields: {},
            methods: {
              discoverFromUrl: {
                name: 'discoverFromUrl',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
              XMLExport: {
                name: 'XMLExport',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: { include: ['discoverFromUrl', 'XMLExport'] },
            },
          },
        },
      };
    }

    it('should preserve source casing when kebabRoutes is off (default)', async () => {
      await generateSvelteKitRoutes(projectRoot, buildManifest(), {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const kebab = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('praecos/[id]/discover-from-url/'),
        );
      const camel = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('praecos/[id]/discoverFromUrl/'),
        );
      expect(kebab).toBeUndefined();
      expect(camel).toBeDefined();
    });

    it('should kebab-case custom-method segments when kebabRoutes is true', async () => {
      await generateSvelteKitRoutes(projectRoot, buildManifest(), {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        kebabRoutes: true,
      });

      const kebab = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0]
            .toString()
            .includes('praecos/[id]/discover-from-url/+server.ts'),
        );
      const acronymKebab = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('praecos/[id]/xml-export/+server.ts'),
        );
      const camel = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('praecos/[id]/discoverFromUrl/'),
        );
      expect(kebab).toBeDefined();
      expect(acronymKebab).toBeDefined();
      expect(camel).toBeUndefined();
    });

    it('should honor an explicit api.routes[name].path over kebabRoutes', async () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Praeco: {
            className: 'Praeco',
            collection: 'praecos',
            fields: {},
            methods: {
              discoverFromUrl: {
                name: 'discoverFromUrl',
                parameters: [{ name: 'options', type: 'any' }],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['discoverFromUrl'],
                routes: {
                  discoverFromUrl: { path: 'discoverFromUrl' },
                },
              },
            },
          },
        },
      };

      await generateSvelteKitRoutes(projectRoot, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        kebabRoutes: true,
      });

      const camel = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0]
            .toString()
            .includes('praecos/[id]/discoverFromUrl/+server.ts'),
        );
      expect(camel).toBeDefined();
    });
  });

  // Feature: build-time lint that catches cli.include methods missing from
  // the resolved API set. See smrt#1306.
  describe('cli.include vs api.include coherence lint (smrt#1306)', () => {
    function buildManifest(decoratorConfig: any): SmartObjectManifest {
      return {
        objects: {
          Praeco: {
            className: 'Praeco',
            collection: 'praecos',
            fields: {},
            methods: {
              discover: {
                name: 'discover',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
              },
              audit: {
                name: 'audit',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
              },
            },
            decoratorConfig,
          },
        },
      };
    }

    it('resolveApiActionSet returns CRUD + included custom methods', () => {
      const manifest = buildManifest({
        api: { include: ['list', 'get', 'discover'] },
      });
      const set = resolveApiActionSet(manifest.objects.Praeco);
      expect(Array.from(set).sort()).toEqual(['discover', 'get', 'list']);
    });

    it('flags cli.include methods that are not in the resolved api set', () => {
      const manifest = buildManifest({
        api: { include: ['list', 'get', 'discover'] },
        cli: { include: ['list', 'discover', 'audit'] },
      });
      const violations = findCliApiCoherenceViolations(manifest);
      expect(violations).toEqual([
        { className: 'Praeco', unreachable: ['audit'] },
      ]);
    });

    it('throws with remediation guidance when invoked as a build-time gate', () => {
      const manifest = buildManifest({
        api: { include: ['list', 'get'] },
        cli: { include: ['list', 'discover', 'audit'] },
      });
      expect(() => validateCliIncludeAgainstApi(manifest)).toThrow(
        /Praeco\.discover is declared in cli\.include but is not exposed via the api/,
      );
      expect(() => validateCliIncludeAgainstApi(manifest)).toThrow(/audit/);
      expect(() => validateCliIncludeAgainstApi(manifest)).toThrow(
        /cli: \{ skipApiCheck: true \}/,
      );
    });

    it('honors per-class cli.skipApiCheck opt-out', () => {
      const manifest = buildManifest({
        api: { include: [] },
        cli: { include: ['list'], skipApiCheck: true },
      });
      expect(findCliApiCoherenceViolations(manifest)).toEqual([]);
      expect(() => validateCliIncludeAgainstApi(manifest)).not.toThrow();
    });

    it('passes when cli.include is empty', () => {
      const manifest = buildManifest({
        api: { include: [] },
        cli: { include: [] },
      });
      expect(findCliApiCoherenceViolations(manifest)).toEqual([]);
    });

    it('passes when api.exclude removes a method from cli.include too', () => {
      // Combined with smrt#1304: api.include+exclude both apply, so excluded
      // methods must be flagged in cli.include even when listed in api.include.
      const manifest = buildManifest({
        api: { include: ['discover', 'audit'], exclude: ['audit'] },
        cli: { include: ['discover', 'audit'] },
      });
      const violations = findCliApiCoherenceViolations(manifest);
      expect(violations).toEqual([
        { className: 'Praeco', unreachable: ['audit'] },
      ]);
    });

    it('honors cli.exclude when checking effective CLI commands', () => {
      // Match generateCLIModule: a command in both cli.include AND cli.exclude
      // is not actually registered as a CLI command, so the lint must not
      // flag it as unreachable even if no API route exists.
      const manifest = buildManifest({
        api: { include: ['discover'] }, // no 'audit' in API
        cli: { include: ['discover', 'audit'], exclude: ['audit'] },
      });
      // 'audit' is in cli.include but also in cli.exclude → not a real
      // CLI command → must not be flagged as unreachable.
      expect(findCliApiCoherenceViolations(manifest)).toEqual([]);
      expect(() => validateCliIncludeAgainstApi(manifest)).not.toThrow();
    });

    it('keeps config-only collection overrides item-scoped for non-static methods', () => {
      // A route declaration cannot turn an instance action into a ClassRef
      // call. REST discovery now agrees with MCP/WebMCP's item contract.
      const manifest: SmartObjectManifest = {
        objects: {
          Doc: {
            className: 'Doc',
            collection: 'docs',
            fields: {},
            methods: {
              broken: {
                name: 'broken',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
                isStatic: false,
              },
            },
            decoratorConfig: {
              api: {
                include: ['broken'],
                routes: { broken: { scope: 'collection' } },
              },
              cli: { include: ['broken'] },
            },
          },
        },
      };
      expect(Array.from(resolveApiActionSet(manifest.objects.Doc))).toEqual([
        'broken',
      ]);
      expect(findCliApiCoherenceViolations(manifest)).toEqual([]);
    });

    it('keeps recognized collection-class methods collection-scoped', () => {
      // A collection class has a collection receiver even when its action is
      // not static, so a route-only item override cannot remove it.
      const manifest: SmartObjectManifest = {
        objects: {
          DocCollection: {
            className: 'DocCollection',
            collection: 'docs',
            fields: {},
            extends: 'SmrtCollection',
            extendsTypeArg: 'Doc',
            methods: {
              misconfigured: {
                name: 'misconfigured',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
                isStatic: false,
              },
              listSpecial: {
                name: 'listSpecial',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
                isStatic: true,
              },
            },
            decoratorConfig: {
              api: {
                include: ['misconfigured', 'listSpecial'],
                routes: { misconfigured: { scope: 'item' } },
              },
              cli: { include: ['misconfigured', 'listSpecial'] },
            },
          },
        },
      };
      expect(
        Array.from(resolveApiActionSet(manifest.objects.DocCollection)).sort(),
      ).toEqual(['listSpecial', 'misconfigured']);
      expect(findCliApiCoherenceViolations(manifest)).toEqual([]);
    });

    it('does not claim CRUD routes for collection classes', () => {
      const manifest: SmartObjectManifest = {
        objects: {
          DocCollection: {
            className: 'DocCollection',
            collection: 'docs',
            fields: {},
            extends: 'SmrtCollection',
            extendsTypeArg: 'Doc',
            methods: {},
            decoratorConfig: {
              api: true,
              cli: { include: ['list'] },
            },
          },
        },
      };

      expect(
        Array.from(
          resolveApiActionSet(manifest.objects.DocCollection, manifest),
        ),
      ).toEqual([]);
      expect(findCliApiCoherenceViolations(manifest)).toEqual([
        { className: 'DocCollection', unreachable: ['list'] },
      ]);
    });

    it('uses manifest ancestry for transitive collection CLI/API coherence', () => {
      const manifest: SmartObjectManifest = {
        objects: {
          Doc: {
            className: 'Doc',
            collection: 'docs',
            fields: {},
            methods: {},
            decoratorConfig: { api: false },
          },
          DocCollection: {
            className: 'DocCollection',
            collection: 'docs',
            fields: {},
            extends: 'SmrtCollection',
            extendsTypeArg: 'Doc',
            methods: {},
            decoratorConfig: { api: false },
          },
          SpecialDocCollection: {
            className: 'SpecialDocCollection',
            collection: 'docs',
            fields: {},
            extends: 'DocCollection',
            methods: {
              collectionAction: {
                name: 'collectionAction',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
                isStatic: false,
              },
              itemAction: {
                name: 'itemAction',
                parameters: [],
                returnType: 'Promise<any>',
                isPublic: true,
                isStatic: false,
              },
            },
            decoratorConfig: {
              api: {
                include: ['collectionAction', 'itemAction'],
                routes: {
                  collectionAction: { scope: 'collection' },
                  itemAction: { scope: 'item' },
                },
              },
              cli: { include: ['collectionAction', 'itemAction'] },
            },
          },
        },
      };

      expect(
        Array.from(
          resolveApiActionSet(manifest.objects.SpecialDocCollection, manifest),
        ),
      ).toEqual(['collectionAction', 'itemAction']);
      expect(findCliApiCoherenceViolations(manifest)).toEqual([]);
    });
  });

  // Proves the `_events` opt-out (#1763) threads end-to-end: the option reaches
  // generateEventsRoute through generateSvelteKitRoutes (regression guard — it
  // was added to the internal options but not forwarded from the public plugin
  // config, so the documented opt-out was dead).
  describe('_events route generation (#1763)', () => {
    const eventsManifest: SmartObjectManifest = {
      objects: {
        Widget: {
          className: 'Widget',
          collection: 'widgets',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      },
    };

    const eventsServerPath = join(
      projectRoot,
      'src/routes/api',
      '_events',
      '+server.ts',
    );

    it('generates the _events route by default', async () => {
      await generateSvelteKitRoutes(projectRoot, eventsManifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const eventsWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString() === eventsServerPath);
      expect(eventsWrite).toBeDefined();
      // The emitted route delegates to core's stream builder.
      expect(String(eventsWrite?.[1])).toContain('buildChangeEventStream');
      expect(String(eventsWrite?.[1])).toMatch(
        /const MANIFEST_HASH = "[A-Za-z0-9_-]{16}";/,
      );
    });

    it('skips the _events route when eventsRoute.enabled is false', async () => {
      await generateSvelteKitRoutes(projectRoot, eventsManifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        eventsRoute: { enabled: false },
      });

      const eventsWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString() === eventsServerPath);
      expect(eventsWrite).toBeUndefined();
    });

    it('forwards eventsRoute.maxSubscribers into the generated _events route', async () => {
      await generateSvelteKitRoutes(projectRoot, eventsManifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        eventsRoute: { maxSubscribers: 12 },
      });

      const eventsWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString() === eventsServerPath);
      expect(String(eventsWrite?.[1])).toContain(
        'tryReserveChangeEventSubscriberSlot(collection.db, 12)',
      );
    });
  });

  // Proves the `_resources` CLI discovery route (#2663) threads end-to-end
  // through generateSvelteKitRoutes: emitted only when smrt-users is
  // resolvable, never emitted (and never clobbers) when a hand-written route
  // already exists, and never emitted when smrt-users is absent — an
  // unresolvable import must never reach a consumer's build.
  describe('_resources route generation (#2663)', () => {
    const resourcesManifest: SmartObjectManifest = {
      objects: {
        Widget: {
          className: 'Widget',
          collection: 'widgets',
          fields: {},
          methods: {},
          decoratorConfig: { api: true },
        },
      },
    };

    const resourcesServerPath = join(
      projectRoot,
      'src/routes/api',
      '_resources',
      '+server.ts',
    );
    const smrtUsersPkgPath = join(
      projectRoot,
      'node_modules',
      '@happyvertical',
      'smrt-users',
      'package.json',
    );

    it('generates the _resources route when smrt-users is resolvable', async () => {
      vi.mocked(existsSync).mockImplementation(
        (path) => path.toString() === smrtUsersPkgPath,
      );

      await generateSvelteKitRoutes(projectRoot, resourcesManifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const resourcesWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString() === resourcesServerPath);
      expect(resourcesWrite).toBeDefined();
      expect(String(resourcesWrite?.[1])).toContain(
        "import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';",
      );
      expect(String(resourcesWrite?.[1])).toContain(
        "import '$lib/server/smrt';",
      );
    });

    it('does not generate the _resources route when smrt-users is not resolvable', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      await generateSvelteKitRoutes(projectRoot, resourcesManifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const resourcesWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString() === resourcesServerPath);
      expect(resourcesWrite).toBeUndefined();
    });

    it('preserves an existing hand-written _resources route', async () => {
      vi.mocked(existsSync).mockImplementation((path) => {
        const p = path.toString();
        return p === smrtUsersPkgPath || p === resourcesServerPath;
      });

      await generateSvelteKitRoutes(projectRoot, resourcesManifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      });

      const resourcesWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString() === resourcesServerPath);
      expect(resourcesWrite).toBeUndefined();
    });

    it('skips the _resources route when resourcesRoute.enabled is false, even if smrt-users is resolvable', async () => {
      vi.mocked(existsSync).mockImplementation(
        (path) => path.toString() === smrtUsersPkgPath,
      );

      await generateSvelteKitRoutes(projectRoot, resourcesManifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        resourcesRoute: { enabled: false },
      });

      const resourcesWrite = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) => call[0].toString() === resourcesServerPath);
      expect(resourcesWrite).toBeUndefined();
    });
  });
});
