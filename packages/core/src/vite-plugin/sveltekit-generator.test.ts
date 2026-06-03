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
  generateSvelteKitRoutes,
  methodNameToKebab,
  resolveApiActionSet,
  validateCliIncludeAgainstApi,
} from './sveltekit-generator';

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

function expectGetCollectionCall(content: string, objectName: string): void {
  const escapedObjectName = objectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  expect(content).toMatch(
    new RegExp(`getCollection(?:<any>)?\\(\\s*'${escapedObjectName}',?\\s*\\)`),
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
      expect(registrationContent).toMatch(
        /ObjectRegistry\.register\(LocalThing,\s*\{\s*name: 'LocalThing',\s*packageName: '@test\/app',\s*\}\);/s,
      );
      expect(registrationContent).toMatch(
        /ObjectRegistry\.register\(ExternalThing,\s*\{\s*name: 'ExternalThing',\s*packageName: '@test\/pkg',\s*\}\);/s,
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

      expect(registrationContent).toMatch(
        /ObjectRegistry\.register\(LocalThing,\s*\{\s*name: 'LocalThing',\s*packageName: '@test\/app',\s*\}\);/s,
      );
      expect(registrationContent).not.toContain(
        'ObjectRegistry.register(UnqualifiedThing, {});',
      );
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
      expectGetCollectionCall(content, 'Product');
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

      // Should use getCollection<any> to avoid SSR type-stripping issues
      expectGetCollectionCall(content, 'Product');
      expect(content).not.toContain('import type { Product }');

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

      // Should use getCollection<any> to avoid SSR type-stripping issues
      expectGetCollectionCall(analyzeContent, 'Document');
      expect(analyzeContent).not.toContain('import type { Document }');

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
          call[0].toString().includes('documents/facts/+server.ts'),
        );

      expect(browseFactsRoute).toBeDefined();
      const content = browseFactsRoute?.[1] as string;

      expect(content).toContain(
        "import { ObjectRegistry } from '@happyvertical/smrt-core'",
      );
      expect(content).toContain('export const GET: RequestHandler');
      expect(content).toMatch(
        /Object\.fromEntries\(\s*new URL\(request\.url\)\.searchParams\.entries\(\),?\s*\)/,
      );
      expect(content).toContain("ObjectRegistry.getClass('Document')");
      expect(content).toContain('await ClassRef.browseFacts(options)');
      expect(content).not.toContain('params.id');
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
        'export const GET: RequestHandler = async ({ params, request }) => {',
      );
      expect(content).toContain('const pathParams = {');
      expect(content).toContain('"profileKey": params["profileKey"],');
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
            decoratorConfig: { api: true },
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

      expect(content).toContain('const options = await request.json();');
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

    it('should skip collection-scoped custom routes for non-static methods', async () => {
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

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[smrt] Skipping Document.browseFacts - collection API routes require a static method',
      );

      const browseFactsRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('documents/facts/+server.ts'),
        );
      expect(browseFactsRoute).toBeUndefined();

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
      expectGetCollectionCall(itemContent, 'Meeting');
      expect(itemContent).not.toContain('import type { Meeting }');

      // Action route should also import from package
      const actionRoute = vi
        .mocked(writeFileSync)
        .mock.calls.find((call) =>
          call[0].toString().includes('meetings/[id]/summarize/+server.ts'),
        );

      expect(actionRoute).toBeDefined();
      const actionContent = actionRoute?.[1] as string;
      expectGetCollectionCall(actionContent, 'Meeting');
      expect(actionContent).not.toContain('import type { Meeting }');
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

      // Routes should not emit unused model imports
      expect(content).not.toContain('import type { Invitation }');
      expect(content).not.toContain("from '@myapp/dashboard'");

      // Should still use getCollection<any> with qualified registry key
      expectGetCollectionCall(content, '@myapp/dashboard:Invitation');
      expect(content).toContain(
        'export const POST: RequestHandler = async ({ params }) => {',
      );
      expect(content).not.toContain('{ params, request }');
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

      // Routes should not emit unused model imports
      expect(content).not.toContain('import type { Invitation }');
      expect(content).not.toContain('import type { @blindmanpress');

      // Should use <any> as generic parameter to avoid SSR type issues
      expect(content).toContain('getCollection<any>');

      // Should still use the full qualified name as the registry key
      expectGetCollectionCall(content, '@blindmanpress/dashboard:Invitation');
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
      expectGetCollectionCall(findByTokenContent, 'Invitation');
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
      expect(collectionContent).toContain(
        'items.map((item) => serializeItemResponse(item))',
      );
      expect(collectionContent).toContain(
        'return json({ items: serializedItems, count, limit, offset });',
      );
      expect(collectionContent).toContain(
        'const serializedItem = await serializeItemResponse(item);',
      );
      expect(collectionContent).toContain(
        'return json(serializedItem, { status: 201 });',
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
      expect(itemContent).toContain('return json(serializedItem);');
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
        'items.map((item) => serializeListItemResponse(item))',
      );
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

    // Regression: resolveApiActionSet must mirror the scope/static skip rules
    // applied by route generation, otherwise the lint reports a false negative
    // (passes a cli.include method that no route is actually emitted for).
    it('excludes collection-scoped non-static methods on a non-collection class', () => {
      // User wrote `routes[name].scope: 'collection'` for an instance method
      // — the generator skips this with a warning. The lint must agree.
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
      expect(Array.from(resolveApiActionSet(manifest.objects.Doc))).toEqual([]);
      expect(findCliApiCoherenceViolations(manifest)).toEqual([
        { className: 'Doc', unreachable: ['broken'] },
      ]);
    });

    it('excludes scope=item methods on a SmrtCollection class', () => {
      // Collection classes only emit collection-scoped custom routes; an
      // explicit `routes[name].scope = 'item'` override on a collection class
      // method is a misconfig the generator skips. The lint must agree.
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
      // misconfigured has explicit scope: 'item' on a collection class -> skipped.
      // listSpecial defaults to 'collection' on collection class -> exposed.
      expect(
        Array.from(resolveApiActionSet(manifest.objects.DocCollection)).sort(),
      ).toEqual(['listSpecial']);
      expect(findCliApiCoherenceViolations(manifest)).toEqual([
        { className: 'DocCollection', unreachable: ['misconfigured'] },
      ]);
    });
  });
});
