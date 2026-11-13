import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDevNativeSsrModules } from './native-ssr.js';
import type { SmrtDevServer } from './plugin-contract.js';

describe('shared native SSR entries', () => {
  it.each([
    false,
    true,
  ])('composes exact registrations in either plugin order (%s)', async (reverse) => {
    const original = vi.fn(function (this: unknown, ...args: unknown[]) {
      expect(this).toBe(ssr);
      return Promise.resolve({ delegated: args });
    });
    const ssr = { fetchModule: original };
    const server = {
      config: { root: '/app' },
      environments: { ssr },
    } as unknown as SmrtDevServer;
    const first = createDevNativeSsrModules();
    const second = createDevNativeSsrModules();
    const ordered = reverse ? [second, first] : [first, second];
    ordered[0].configureServer(server);
    const interceptor = ssr.fetchModule;
    ordered[1].configureServer(server);
    ordered[0].configureServer(server);
    expect(ssr.fetchModule).toBe(interceptor);
    first.register('/app/native.js', 'module');
    second.register('/elsewhere/native.cjs', 'commonjs');
    for (const id of [
      '/app/native.js',
      '/@fs/app/native.js',
      '/native.js?t=1',
    ]) {
      expect(await ssr.fetchModule(id)).toEqual({
        externalize: pathToFileURL('/app/native.js').href,
        type: 'module',
      });
    }
    expect(await ssr.fetchModule('/elsewhere/native.cjs')).toEqual({
      externalize: pathToFileURL('/elsewhere/native.cjs').href,
      type: 'commonjs',
    });
    const options = { cached: false };
    expect(
      await ssr.fetchModule('/app/native.js/other', '/importer.js', options),
    ).toEqual({
      delegated: ['/app/native.js/other', '/importer.js', options],
    });
    expect(original).toHaveBeenCalledTimes(1);
  });

  it('preserves upstream failures and independent environments', async () => {
    const failure = new Error('upstream failure');
    const ssr = { fetchModule: vi.fn().mockRejectedValue(failure) };
    const server = {
      config: { root: '/app' },
      environments: { ssr },
    } as unknown as SmrtDevServer;
    const native = createDevNativeSsrModules();
    native.configureServer(server);
    native.register('relative.js', 'module');
    await expect(ssr.fetchModule('relative.js')).rejects.toBe(failure);
    const other = { fetchModule: vi.fn().mockResolvedValue('other') };
    createDevNativeSsrModules().configureServer({
      ...server,
      environments: { ssr: other },
    });
    expect(await other.fetchModule('/app/native.js')).toBe('other');
  });

  it('adds root-relative aliases for entries registered before server configuration', async () => {
    const native = createDevNativeSsrModules();
    native.register('/app/native.js', 'module');
    const ssr = { fetchModule: vi.fn().mockResolvedValue('delegated') };
    native.configureServer({
      config: { root: '/app' },
      environments: { ssr },
    } as unknown as SmrtDevServer);
    expect(await ssr.fetchModule('/native.js?t=1')).toEqual({
      externalize: pathToFileURL('/app/native.js').href,
      type: 'module',
    });
  });

  it('leaves older servers without the optional SSR transport unchanged', () => {
    const server = { config: { root: '/app' } } as SmrtDevServer;
    expect(() =>
      createDevNativeSsrModules().configureServer(server),
    ).not.toThrow();
    expect(server.environments).toBeUndefined();
  });

  it('never treats a generated alias as a canonical file during repeated configuration', async () => {
    const native = createDevNativeSsrModules();
    native.register('/project/project/file.js', 'module');
    const original = vi.fn().mockResolvedValue('unrelated module');
    const ssr = { fetchModule: original };
    const server = {
      config: { root: '/project' },
      environments: { ssr },
    } as unknown as SmrtDevServer;
    native.configureServer(server);
    native.configureServer(server);
    expect(await ssr.fetchModule('/project/file.js')).toEqual({
      externalize: pathToFileURL('/project/project/file.js').href,
      type: 'module',
    });
    // This real request must reach Vite, even though stripping the root from
    // the already-generated alias above would yield the same request ID.
    expect(await ssr.fetchModule('/file.js')).toBe('unrelated module');
    expect(original).toHaveBeenCalledExactlyOnceWith(
      '/file.js',
      undefined,
      undefined,
    );
  });
});
