/**
 * generate-types / generate-mcp / generate-routes handler tests.
 *
 * The generate-register handler is covered by generate-register.test.ts. This
 * file covers the other three handlers by mocking the smrt-core generator
 * boundaries (declarations, MCPGenerator, vite-plugin route generator) and the
 * discovery layer, then asserting on success and error/no-manifest paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateDeclarationsFromCLI: vi.fn(),
  generateServer: vi.fn(),
  getAllClasses: vi.fn(),
  autoDiscoverAndLoad: vi.fn(),
  loadManifestFile: vi.fn(),
  generateSvelteKitRoutes: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: {
    getAllClasses: mocks.getAllClasses,
  },
}));

vi.mock('@happyvertical/smrt-core/generators', () => ({
  MCPGenerator: class {
    generateServer = mocks.generateServer;
  },
}));

vi.mock('@happyvertical/smrt-core/prebuild', () => ({
  generateDeclarationsFromCLI: mocks.generateDeclarationsFromCLI,
}));

vi.mock('@happyvertical/smrt-core/vite-plugin', () => ({
  generateSvelteKitRoutes: mocks.generateSvelteKitRoutes,
}));

vi.mock('../../discovery/index.js', () => ({
  autoDiscoverAndLoad: mocks.autoDiscoverAndLoad,
  loadManifestFile: mocks.loadManifestFile,
}));

import { generateCommands } from '../generate.js';

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

describe('generate-* handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe('generate-types', () => {
    it('requires a manifest path', async () => {
      await expect(
        generateCommands['generate-types'].handler([], {}),
      ).rejects.toThrow(/Manifest path is required/);
    });

    it('forwards the manifest path and output dir', async () => {
      mocks.generateDeclarationsFromCLI.mockResolvedValue(undefined);

      await generateCommands['generate-types'].handler(['m.json'], {
        'output-dir': 'out',
      });

      expect(mocks.generateDeclarationsFromCLI).toHaveBeenCalledWith([
        'm.json',
        'out',
      ]);
    });

    it('passes a single arg when no output dir', async () => {
      mocks.generateDeclarationsFromCLI.mockResolvedValue(undefined);

      await generateCommands['generate-types'].handler(['m.json'], {});

      expect(mocks.generateDeclarationsFromCLI).toHaveBeenCalledWith([
        'm.json',
      ]);
    });

    it('wraps generator errors', async () => {
      mocks.generateDeclarationsFromCLI.mockRejectedValue(new Error('boom'));

      await expect(
        generateCommands['generate-types'].handler(['m.json'], {}),
      ).rejects.toThrow(/Failed to generate types: boom/);
    });
  });

  describe('generate-mcp', () => {
    it('warns when there are no registered objects but still generates', async () => {
      mocks.getAllClasses.mockReturnValue(new Map());
      mocks.generateServer.mockResolvedValue(undefined);

      await generateCommands['generate-mcp'].handler([], {
        'output-path': '.smrt/mcp-server/index.js',
        version: '1.0.0',
        name: 'my-server',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('No SMRT objects found'),
      );
      expect(mocks.generateServer).toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'my-server' }),
      );
    });

    it('derives the server name from package.json when not provided', async () => {
      mocks.getAllClasses.mockReturnValue(new Map([['Widget', {} as never]]));
      mocks.generateServer.mockResolvedValue(undefined);

      await generateCommands['generate-mcp'].handler([], {
        'output-path': 'out/index.js',
        version: '2.0.0',
      });

      // package.json read may resolve to the cli package's own name or the
      // default fallback; either way generateServer must run with a name.
      expect(mocks.generateServer).toHaveBeenCalledWith(
        expect.objectContaining({ serverVersion: '2.0.0' }),
      );
      const call = mocks.generateServer.mock.calls[0][0];
      expect(typeof call.serverName).toBe('string');
      expect(call.serverName.length).toBeGreaterThan(0);
    });

    it('wraps generator errors', async () => {
      mocks.getAllClasses.mockReturnValue(new Map());
      mocks.generateServer.mockRejectedValue(new Error('mcp fail'));

      await expect(
        generateCommands['generate-mcp'].handler([], {
          'output-path': 'out/index.js',
          version: '1.0.0',
          name: 'x',
        }),
      ).rejects.toThrow(/Failed to generate MCP server: mcp fail/);
    });
  });

  describe('generate-routes', () => {
    it('exits when no manifests are discovered', async () => {
      mocks.autoDiscoverAndLoad.mockResolvedValue({
        discovered: [],
        totalObjects: 0,
      });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as any);

      await expect(
        generateCommands['generate-routes'].handler([], {}),
      ).rejects.toThrow();

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('exits when manifests have no objects', async () => {
      mocks.autoDiscoverAndLoad.mockResolvedValue({
        discovered: [{ path: 'm.json', packageName: 'pkg' }],
        totalObjects: 0,
      });
      mocks.loadManifestFile.mockResolvedValue({ objects: {} });
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as any);

      await expect(
        generateCommands['generate-routes'].handler([], {}),
      ).rejects.toThrow();

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('generates routes for discovered objects', async () => {
      mocks.autoDiscoverAndLoad.mockResolvedValue({
        discovered: [{ path: 'm.json', packageName: '@app/x' }],
        totalObjects: 1,
      });
      mocks.loadManifestFile.mockResolvedValue({
        objects: {
          Widget: { collection: 'widgets', packageName: '@app/x' },
        },
      });
      mocks.generateSvelteKitRoutes.mockResolvedValue(undefined);

      await generateCommands['generate-routes'].handler([], {
        'routes-dir': 'src/routes/api',
        'objects-dir': 'src/lib/objects',
        'config-path': 'src/lib/server',
        'config-file': 'smrt.ts',
        'kebab-routes': true,
      });

      expect(mocks.generateSvelteKitRoutes).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          objects: expect.objectContaining({ Widget: expect.any(Object) }),
        }),
        expect.objectContaining({
          kebabRoutes: true,
          routesDir: 'src/routes/api',
        }),
      );
      const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(printed).toContain('Generated routes for 1 object(s)');
    });

    it('wraps generation errors', async () => {
      mocks.autoDiscoverAndLoad.mockResolvedValue({
        discovered: [{ path: 'm.json', packageName: '@app/x' }],
        totalObjects: 1,
      });
      mocks.loadManifestFile.mockResolvedValue({
        objects: { Widget: { collection: 'widgets' } },
      });
      mocks.generateSvelteKitRoutes.mockRejectedValue(new Error('route fail'));

      await expect(
        generateCommands['generate-routes'].handler([], {}),
      ).rejects.toThrow(/Failed to generate routes: route fail/);
    });
  });
});
