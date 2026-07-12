/**
 * Filesystem adapter boundary (#1979).
 *
 * SmrtClass acquires filesystem support through this loader instead of a
 * static @happyvertical/files import so the files SDK (S3/googleapis) never
 * enters provider-neutral consumer bundles. Module-level factory state is
 * reset per test via vi.resetModules() + dynamic import.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function loadFresh() {
  vi.resetModules();
  return import('./filesystem-loader.js');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('importOptionalDependency registration (bundled-runtime opt-in)', () => {
  it('serves a module registered on the global registry without runtime resolution', async () => {
    vi.resetModules();
    const lazy = await import('./lazy-external.js');
    const fake = { marker: 'registered-module' };
    lazy.registerOptionalDependency('@happyvertical/fake-optional', fake);

    // Module-fresh import instance must still see the registration —
    // the registry lives on globalThis, so ANY package's entry point
    // satisfies EVERY package's lazy import of the same specifier.
    vi.resetModules();
    const secondInstance = await import('./lazy-external.js');
    const resolved = await secondInstance.importOptionalDependency(
      '@happyvertical/fake-optional',
      'unused hint',
    );
    expect(resolved).toBe(fake);
  });

  it('throws the enablement hint when unregistered and unresolvable', async () => {
    vi.resetModules();
    const lazy = await import('./lazy-external.js');
    await expect(
      lazy.importOptionalDependency(
        '@happyvertical/does-not-exist-anywhere',
        "Import 'some/entry' to enable it.",
      ),
    ).rejects.toThrow(/Import 'some\/entry' to enable it\./);
  });
});

describe('createFilesystemAdapter', () => {
  it('uses a registered factory without touching the files SDK', async () => {
    const loader = await loadFresh();
    const adapter = { read: vi.fn() };
    const factory = vi.fn(async () => adapter as never);

    loader.registerFilesystemAdapterFactory(factory);
    const created = await loader.createFilesystemAdapter({
      type: 'local',
    } as never);

    expect(created).toBe(adapter);
    expect(factory).toHaveBeenCalledWith({ type: 'local' });
  });

  it('falls back to a runtime-resolved @happyvertical/files import when no factory is registered', async () => {
    const loader = await loadFresh();
    // Workspace runtimes resolve the SDK from node_modules — the behavior
    // ordinary Node/tsx/vite-dev consumers rely on with zero configuration.
    const adapter = await loader.createFilesystemAdapter({
      type: 'local',
      basePath: '.',
    } as never);
    expect(adapter).toBeDefined();
  });

  it('the explicit filesystem entry registers the SDK-backed factory', async () => {
    vi.resetModules();
    const loader = await import('./filesystem-loader.js');
    const spy = vi.fn();
    loader.registerFilesystemAdapterFactory(async (options) => {
      spy(options);
      return { registered: true } as never;
    });
    // The entry registers its own SDK-backed factory; last registration
    // wins, so the spy factory above must no longer be consulted.
    await import('./filesystem.js');
    const adapter = await loader.createFilesystemAdapter({
      type: 'local',
      basePath: '.',
    } as never);
    expect(spy).not.toHaveBeenCalled();
    expect(adapter).toBeDefined();
  });
});
