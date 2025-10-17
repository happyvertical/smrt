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
      const configContent = configCall![1] as string;

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
      const content = collectionRoute![1] as string;

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
      const content = itemRoute![1] as string;

      // Should use centralized config
      expect(content).toContain(
        "import { getCollection } from '$lib/server/smrt'",
      );

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
      const analyzeContent = analyzeRoute![1] as string;

      expect(analyzeContent).toContain(
        "import { getCollection } from '$lib/server/smrt'",
      );
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
      const content = itemRoute![1] as string;

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
      const content = gitignoreWrite![1] as string;

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
      const content = gitignoreWrite![1] as string;

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
});
