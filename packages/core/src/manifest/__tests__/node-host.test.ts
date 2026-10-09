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

  it('resolves a real host on Node', async () => {
    vi.resetModules();
    const host = await import('../node-host.js');
    expect(host.nodeHost()).not.toBeNull();
    expect(host.existsSync(process.cwd())).toBe(true);
  });
});
