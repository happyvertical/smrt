import { describe, expect, it, vi } from 'vitest';

/** Hide (or restore) `process.getBuiltinModule`, the Node-host probe. */
function setBuiltinModuleProbe(value: unknown): void {
  Object.defineProperty(process, 'getBuiltinModule', {
    value,
    configurable: true,
    writable: true,
  });
}

/**
 * Manifest discovery must degrade to "nothing found" where there is no Node
 * host (a browser), not throw while the registry loads (#2838).
 */
describe('manifest discovery without a Node host', () => {
  async function withoutHost<T>(run: () => Promise<T>): Promise<T> {
    const real = process.getBuiltinModule;
    setBuiltinModuleProbe(undefined);
    vi.resetModules();
    try {
      return await run();
    } finally {
      setBuiltinModuleProbe(real);
    }
  }

  it('answers filesystem probes as absent', async () => {
    await withoutHost(async () => {
      const host = await import('../node-host.js');
      expect(host.nodeHost()).toBeNull();
      expect(host.join('/a/', 'b', 'c.json')).toBe('/a/b/c.json');
      expect(host.dirname('/a/b/c.json')).toBe('/a/b');
      expect(host.dirname('/c.json')).toBe('/');
      expect(host.dirname('c.json')).toBe('.');
      expect(host.existsSync('/anything')).toBe(false);
      expect(host.readdirSync('/anything')).toEqual([]);
      expect(() => host.readFileSync('/anything', 'utf-8')).toThrow(
        /needs a Node host/,
      );
      expect(() => host.require('./static-manifest.js')).toThrow(
        /needs a Node host/,
      );
    });
  });

  it('finds no local manifest', async () => {
    await withoutHost(async () => {
      const { LocalManifestReader } = await import(
        '../local-manifest-reader.js'
      );
      const reader = new LocalManifestReader('/project');
      expect(reader.getOutputPath('dev')).toBe('/project/.smrt/manifest.json');
      expect(reader.loadLocal()).toBeNull();
      expect(reader.loadForExternalPackage()).toBeNull();
    });
  });

  it('keeps the registry-facing readers inert instead of throwing', async () => {
    await withoutHost(async () => {
      const loader = await import('../manifest-loader.js');
      // The registry calls this on every class registration; with nothing to
      // read it returns null instead of throwing.
      expect(loader.readProjectManifestSync()).toBeNull();
    });
  });

  it('preserves bundled STI metadata while optional dependencies have no filesystem', async () => {
    await withoutHost(async () => {
      const loader = await import('../manifest-loader.js');
      const store = await import('../store.js');
      loader.clearManifestCache();
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VITEST', 'false');
      vi.stubEnv('JEST_WORKER_ID', undefined);
      const manifest = {
        version: '1.0.0',
        timestamp: 1,
        packageName: '@fixture/bundled',
        smrtDependencies: ['@fixture/unbundled'],
        objects: {
          BundledParent: {
            className: 'BundledParent',
            collection: 'browser_sti',
            fields: { title: { type: 'text' } },
          },
          BundledChild: {
            className: 'BundledChild',
            collection: 'browser_sti',
            extends: 'BundledParent',
            fields: { detail: { type: 'text' } },
          },
        },
      } as any;
      globalThis.__smrtManifestStatic = manifest;
      globalThis.__smrtManifestStaticLoadAttempted = true;
      globalThis.__smrtManifestCache = new Map([
        ['@fixture/bundled', manifest],
      ]);
      // A browser has no cwd at all. This also catches code that mistakes
      // "process exists" for the capability to inspect installed packages.
      const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
        throw new Error('Browser cannot read cwd');
      });
      try {
        expect(loader.loadExternalManifestSync('@fixture/bundled')).toBe(
          manifest,
        );
        expect(store.loadExternalManifestSyncWithNode('@fixture/bundled')).toBe(
          manifest,
        );
        expect(
          loader.loadExternalManifestSync('@fixture/unbundled'),
        ).toBeNull();
        expect(
          store.loadExternalManifestSyncWithNode('@fixture/unbundled'),
        ).toBeNull();
        const siblings = loader.discoverSTISiblingsSync('browser_sti');
        expect(siblings.map(({ className }) => className)).toEqual([
          'BundledParent',
          'BundledChild',
        ]);
        expect(siblings[1].entry.fields).toEqual({ detail: { type: 'text' } });
        expect(loader.discoverManifestSync('BundledParent')?.fields).toEqual({
          title: { type: 'text' },
        });
        expect(
          loader.discoverManifestSync('UnavailableRequiredClass'),
        ).toBeUndefined();
        expect(cwd).not.toHaveBeenCalled();
        const { ObjectRegistry } = await import('../../registry.js');
        await expect(
          ObjectRegistry.ensureManifestLoaded(
            '@fixture/unbundled:UnavailableRequiredClass',
          ),
        ).rejects.toThrow(/not registered/);
      } finally {
        cwd.mockRestore();
        vi.unstubAllEnvs();
        loader.clearManifestCache();
      }
    });
  });

  it('resolves a real host on Node', async () => {
    vi.resetModules();
    const host = await import('../node-host.js');
    expect(host.nodeHost()).not.toBeNull();
    expect(host.existsSync(process.cwd())).toBe(true);
  });
});
