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
