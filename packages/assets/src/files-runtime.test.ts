/**
 * Lazy files-SDK boundary for AssetStore (#1979).
 *
 * smrt-assets is reachable from provider-neutral consumer graphs, so the
 * files SDK must load lazily (or via the explicit filesystem entry) instead
 * of a static import.
 */

import { describe, expect, it, vi } from 'vitest';

async function loadFresh() {
  vi.resetModules();
  return import('./files-runtime.js');
}

describe('files-runtime boundary', () => {
  it('uses a registered files module without runtime resolution', async () => {
    const runtime = await loadFresh();
    const filesystem = { read: vi.fn() };
    const getFilesystem = vi.fn(async () => filesystem as never);
    runtime.registerFilesModule({ getFilesystem } as never);

    const resolved = await runtime.getFilesystemLazy({
      type: 'local',
      basePath: '.',
    } as never);

    expect(resolved).toBe(filesystem);
    expect(getFilesystem).toHaveBeenCalledWith({
      type: 'local',
      basePath: '.',
    });
  });

  it('falls back to runtime resolution of @happyvertical/files', async () => {
    const runtime = await loadFresh();
    const filesystem = await runtime.getFilesystemLazy({
      type: 'local',
      basePath: '.',
    } as never);
    expect(filesystem).toBeDefined();
  });

  it('the explicit filesystem entry registers the real SDK module', async () => {
    vi.resetModules();
    const runtime = await import('./files-runtime.js');
    await import('./filesystem.js');
    const filesystem = await runtime.getFilesystemLazy({
      type: 'local',
      basePath: '.',
    } as never);
    expect(filesystem).toBeDefined();
  });

  it('recognizes FileNotFoundError from the loaded module and by name', async () => {
    const runtime = await loadFresh();
    class FileNotFoundError extends Error {
      constructor() {
        super('missing');
        this.name = 'FileNotFoundError';
      }
    }
    runtime.registerFilesModule({
      getFilesystem: async () => ({}) as never,
      FileNotFoundError,
    } as never);

    expect(runtime.isFileNotFoundError(new FileNotFoundError())).toBe(true);

    const foreign = new Error('missing elsewhere');
    foreign.name = 'FileNotFoundError';
    expect(runtime.isFileNotFoundError(foreign)).toBe(true);

    expect(runtime.isFileNotFoundError(new Error('other'))).toBe(false);
    expect(runtime.isFileNotFoundError(undefined)).toBe(false);
  });
});
