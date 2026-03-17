/**
 * Tests for SvelteKit route generator
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';

// Mock node:fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

// Import after mocking
import { generateSvelteKitRoutes } from './sveltekit-generator';

describe('SvelteKit Route Generator', () => {
  const projectRoot = '/test/project';

  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock implementations
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
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
      expect(configContent).toContain('getSmrtConfig');
      expect(configContent).toContain('getCollection');
      expect(configContent).toContain('import { ObjectRegistry }');
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
        "ObjectRegistry.register(LocalThing, { packageName: '@test/app' });",
      );
      expect(registrationContent).toContain(
        "ObjectRegistry.register(ExternalThing, { packageName: '@test/pkg' });",
      );
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

      expect(registrationContent).toContain(
        "ObjectRegistry.register(LocalThing, { packageName: '@test/app' });",
      );
      expect(registrationContent).not.toContain(
        'ObjectRegistry.register(UnqualifiedThing, {});',
      );
    });

    it('should wrap long package registrations to match repository formatting', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const manifest: SmartObjectManifest = {
        objects: {
          ImageCollection: {
            className: 'ImageCollection',
            collection: 'imagecollections',
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

      expect(
        registrationContent,
      ).toContain(`ObjectRegistry.register(ImageCollection, {
  packageName: '@happyvertical/smrt-images',
});`);
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
      expect(content).toContain(
        "const collection = await getCollection('Product')",
      );
      expect(content).toContain('await collection.list');

      // Should include POST handler for create
      expect(content).toContain('export const POST: RequestHandler');
      expect(content).toContain('await collection.create');
      expect(content).toContain('await item.save()');

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

      // Should import model type for type-safe getCollection
      expect(content).toContain(
        "import type { Product } from '$lib/objects/Product'",
      );

      // Should use getCollection<any> to avoid SSR type-stripping issues
      expect(content).toContain("getCollection<any>('Product')");

      // Should include GET handler
      expect(content).toContain('export const GET: RequestHandler');
      expect(content).toContain('await collection.get(params.id)');

      // Should include PUT handler
      expect(content).toContain('export const PUT: RequestHandler');
      expect(content).toContain('Object.assign(item, data)');

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

      // Should import model type for type-safe getCollection
      expect(analyzeContent).toContain(
        "import type { Document } from '$lib/objects/Document'",
      );

      // Should use getCollection<any> to avoid SSR type-stripping issues
      expect(analyzeContent).toContain("getCollection<any>('Document')");

      expect(analyzeContent).toContain('export const POST: RequestHandler');
      expect(analyzeContent).toContain('await item.analyze');
      expect(analyzeContent).toContain("action: 'analyze'");

      // Should write summarize action route
      const summarizeRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('documents/[id]/summarize/+server.ts'),
        );

      expect(summarizeRoute).toBeDefined();
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
      expect(itemContent).toContain(
        "import type { Meeting } from '@happyvertical/praeco'",
      );
      expect(itemContent).toContain("getCollection<any>('Meeting')");

      // Action route should also import from package
      const actionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('meetings/[id]/summarize/+server.ts'),
        );

      expect(actionRoute).toBeDefined();
      const actionContent = actionRoute?.[1] as string;
      expect(actionContent).toContain(
        "import type { Meeting } from '@happyvertical/praeco'",
      );
      expect(actionContent).toContain("getCollection<any>('Meeting')");
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

      // Should import via $lib, not from '@myapp/dashboard'
      expect(content).toContain(
        "import type { Invitation } from '$lib/models/Invitation'",
      );
      expect(content).not.toContain("from '@myapp/dashboard'");

      // Should still use getCollection<any> with qualified registry key
      expect(content).toContain(
        "getCollection<any>('@myapp/dashboard:Invitation')",
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

      // Should import the simple class name, not the qualified name
      expect(content).toContain('import type { Invitation }');
      expect(content).not.toContain('import type { @blindmanpress');

      // Should use <any> as generic parameter to avoid SSR type issues
      expect(content).toContain('getCollection<any>');

      // Should still use the full qualified name as the registry key
      expect(content).toContain(
        "getCollection<any>('@blindmanpress/dashboard:Invitation')",
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
  });

  describe('.gitignore Updates', () => {
    it('should add generated routes pattern to .gitignore', async () => {
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

      expect(content).toContain('# SMRT auto-generated routes');
      expect(content).toContain('src/routes/api/**/+server.ts');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.env');
    });

    it('should not duplicate .gitignore entries', async () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        'node_modules/\n# SMRT auto-generated routes (from Vite plugin)\nsrc/routes/api/**/+server.ts\n',
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

      // Should not write to .gitignore since patterns already exist
      const gitignoreWrites = vi
        .mocked(writeFileSync)
        .mock.calls.filter((call) => call[0].toString().endsWith('.gitignore'));

      expect(gitignoreWrites).toHaveLength(0);

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

      expect(content).toContain('# SMRT auto-generated routes');
      expect(content).toContain('src/routes/api/**/+server.ts');
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
    it('should skip collection classes and only generate routes for item classes', async () => {
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

      // Should log that collection class was skipped
      expect(consoleSpy).toHaveBeenCalledWith(
        '[smrt] Skipping InvitationCollection - collection class (routes handled by item class)',
      );

      // Should report 1 generated + 1 skipped
      expect(consoleSpy).toHaveBeenCalledWith(
        '[smrt] Generated routes for 1 SMRT objects (skipped 1 collection classes)',
      );

      // Should generate routes for Invitation (item class)
      const writeFileCalls = vi
        .mocked(writeFileSync)
        .mock.calls.map(([path]) => path as string);
      const invitationRoutes = writeFileCalls.filter((p) =>
        p.includes('invitations'),
      );

      // Should have collection route, item route, and canBeRedeemed action route
      expect(invitationRoutes).toEqual(
        expect.arrayContaining([
          expect.stringContaining('invitations/+server.ts'),
          expect.stringContaining('invitations/[id]/+server.ts'),
          expect.stringContaining('invitations/[id]/canBeRedeemed/+server.ts'),
        ]),
      );

      // Should NOT have findByToken route (that's on the collection class which was skipped)
      const findByTokenRoutes = writeFileCalls.filter((p) =>
        p.includes('findByToken'),
      );
      expect(findByTokenRoutes).toHaveLength(0);

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
});
