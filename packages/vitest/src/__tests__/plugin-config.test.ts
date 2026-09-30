import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setupSmrtManifests, smrtVitestPlugin } from '../index.js';

const mockedModules = vi.hoisted(() => ({
  hasClass: vi.fn<(name: string) => boolean>(),
  registerFromManifest:
    vi.fn<(name: string, objectDef: unknown, packageName?: string) => void>(),
  loadLocal:
    vi.fn<
      () => { packageName?: string; objects?: Record<string, unknown> } | null
    >(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  ObjectRegistry: {
    hasClass: mockedModules.hasClass,
    registerFromManifest: mockedModules.registerFromManifest,
  },
}));

vi.mock('@happyvertical/smrt-core/manifest', () => ({
  ManifestManager: class {
    loadLocal() {
      return mockedModules.loadLocal();
    }

    getOutputPath(mode: 'dev' | 'build') {
      return mode === 'dev'
        ? '/tmp/mock/.smrt/manifest.json'
        : '/tmp/mock/dist/manifest.json';
    }
  },
}));

describe('smrtVitestPlugin config', () => {
  const defaultSetupFile = fileURLToPath(
    new URL('../setup.ts', import.meta.url),
  );

  beforeEach(() => {
    mockedModules.hasClass.mockReset();
    mockedModules.hasClass.mockReturnValue(false);
    mockedModules.registerFromManifest.mockReset();
    mockedModules.loadLocal.mockReset();
    mockedModules.loadLocal.mockReturnValue(null);
  });

  function createTempProject(packageJson: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'smrt-vitest-plugin-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(packageJson, null, 2),
    );
    return root;
  }

  it('injects the setup file into root config and mutates project configs', () => {
    const plugin = smrtVitestPlugin();
    const userConfig = {
      test: {
        setupFiles: ['existing-root-setup'],
        projects: [
          {
            test: {
              name: 'sqlite',
              setupFiles: ['existing-project-setup'],
            },
          },
          {
            test: {
              name: 'json',
            },
          },
        ],
      },
    };
    const config = plugin.config?.(userConfig as any);

    expect(config).toMatchObject({
      test: {
        setupFiles: ['existing-root-setup', defaultSetupFile],
      },
    });
    expect(
      (config as any).resolve.alias.some(
        (entry: { find: RegExp }) =>
          entry.find instanceof RegExp &&
          entry.find.test('@happyvertical/smrt-core'),
      ),
    ).toBe(true);

    expect(userConfig).toMatchObject({
      test: {
        projects: [
          {
            test: {
              setupFiles: ['existing-project-setup', defaultSetupFile],
            },
          },
          {
            test: {
              setupFiles: [defaultSetupFile],
            },
          },
        ],
      },
    });
  });

  it('injects CI-aware retry into root and project configs', () => {
    vi.stubEnv('SMRT_VITEST_RETRY', '');
    vi.stubEnv('CI', '1');
    const userConfig = {
      test: { projects: [{ test: { name: 'sqlite' } }] },
    };
    const config = smrtVitestPlugin().config?.(userConfig as any);
    expect((config as any)?.test?.retry).toBe(2);
    expect((userConfig.test.projects[0] as any).test.retry).toBe(2);

    vi.stubEnv('CI', '');
    expect(
      (smrtVitestPlugin().config?.({ test: {} } as any) as any)?.test?.retry,
    ).toBe(0);
    vi.unstubAllEnvs();
  });

  it('lets a project inherit the root retry and preserves object retry', () => {
    vi.stubEnv('SMRT_VITEST_RETRY', '');
    vi.stubEnv('CI', '1');
    // Root retry 0 + a project with none: the project inherits the root's 0
    // (Vitest would otherwise default the project to the CI value).
    const rootZero = {
      test: { retry: 0, projects: [{ test: { name: 'sqlite' } }] },
    };
    smrtVitestPlugin().config?.(rootZero as any);
    expect((rootZero.test.projects[0] as any).test.retry).toBe(0);

    // Object retry config is preserved as-is, not coerced to a number.
    const objectRetry = { test: { retry: { count: 3, delay: 50 } } };
    expect(
      (smrtVitestPlugin().config?.(objectRetry as any) as any)?.test?.retry,
    ).toEqual({ count: 3, delay: 50 });
    vi.unstubAllEnvs();
  });

  it('preserves an explicit retry and honours SMRT_VITEST_RETRY', () => {
    vi.stubEnv('CI', '1');
    vi.stubEnv('SMRT_VITEST_RETRY', '');
    const retryFor = (userConfig: unknown) =>
      (smrtVitestPlugin().config?.(userConfig as any) as any)?.test?.retry;

    // explicit root retry preserved over the CI default
    expect(retryFor({ test: { retry: 5 } })).toBe(5);
    // valid env override wins over everything
    vi.stubEnv('SMRT_VITEST_RETRY', '3');
    expect(retryFor({ test: { retry: 5 } })).toBe(3);
    // non-digit override is ignored, falling back to the explicit value
    vi.stubEnv('SMRT_VITEST_RETRY', '2x');
    expect(retryFor({ test: { retry: 5 } })).toBe(5);
    vi.unstubAllEnvs();
  });

  it('does not duplicate the setup file when already configured', () => {
    const plugin = smrtVitestPlugin();
    const userConfig = {
      test: {
        setupFiles: [defaultSetupFile],
        projects: [
          {
            test: {
              name: 'sqlite',
              setupFiles: [defaultSetupFile],
            },
          },
        ],
      },
    };
    const config = plugin.config?.(userConfig as any);

    expect(config).toMatchObject({
      test: {
        setupFiles: [defaultSetupFile],
      },
    });
    expect(
      (config as any).resolve.alias.some(
        (entry: { find: RegExp }) =>
          entry.find instanceof RegExp &&
          entry.find.test('@happyvertical/smrt-core'),
      ),
    ).toBe(true);

    expect(userConfig).toMatchObject({
      test: {
        projects: [
          {
            test: {
              setupFiles: [defaultSetupFile],
            },
          },
        ],
      },
    });
  });

  it('injects the vite 8 oxc defaults when the consumer sets none (#2017)', () => {
    const config = smrtVitestPlugin().config?.({ test: {} } as any);

    expect((config as any).oxc).toEqual({
      decorator: { legacy: true, emitDecoratorMetadata: true },
      tsconfig: {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
      typescript: { onlyRemoveTypeImports: true },
    });
  });

  it('never overrides consumer-configured oxc fields (#2017)', () => {
    // Explicit decorator config: the decorator default (and its tsconfig
    // mirror) is suppressed; the typescript default still applies.
    const decoratorOwned = smrtVitestPlugin().config?.({
      oxc: { decorator: { legacy: false } },
      test: {},
    } as any);
    expect((decoratorOwned as any).oxc).toEqual({
      typescript: { onlyRemoveTypeImports: true },
    });

    // Explicit onlyRemoveTypeImports: the typescript default is suppressed.
    const typescriptOwned = smrtVitestPlugin().config?.({
      oxc: { typescript: { onlyRemoveTypeImports: false } },
      test: {},
    } as any);
    expect((typescriptOwned as any).oxc).toEqual({
      decorator: { legacy: true, emitDecoratorMetadata: true },
      tsconfig: {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      },
    });

    // Other typescript options without the flag still receive the default
    // (vite deep-merges, so the consumer's fields survive).
    const typescriptPartial = smrtVitestPlugin().config?.({
      oxc: { typescript: { allowNamespaces: true } },
      test: {},
    } as any);
    expect((typescriptPartial as any).oxc).toMatchObject({
      typescript: { onlyRemoveTypeImports: true },
    });

    // `oxc: false` disables the transform entirely — nothing is injected
    // (undefined is dropped by vite's config merge).
    const disabled = smrtVitestPlugin().config?.({
      oxc: false,
      test: {},
    } as any);
    expect((disabled as any).oxc).toBeUndefined();
  });

  it('drops workspace aliases rejected by aliasFilter (#2017)', () => {
    const config = smrtVitestPlugin({
      aliasFilter: (entry) => entry.find !== '@happyvertical/smrt-core',
    }).config?.({ test: {} } as any);

    const alias = (config as any).resolve.alias as Array<{ find: RegExp }>;
    expect(
      alias.some(
        (entry) =>
          entry.find instanceof RegExp &&
          entry.find.test('@happyvertical/smrt-core'),
      ),
    ).toBe(false);
    expect(
      alias.some(
        (entry) =>
          entry.find instanceof RegExp &&
          entry.find.test('@happyvertical/smrt-core/testing'),
      ),
    ).toBe(true);
  });

  it('registers classes from the local manifest during configResolved', async () => {
    const root = createTempProject({ name: '@test/local-package' });
    mockedModules.loadLocal.mockReturnValue({
      packageName: '@test/local-package',
      objects: {
        '@test/local-package:LateClass': {
          className: 'LateClass',
          fields: {},
        },
      },
    });

    try {
      const plugin = smrtVitestPlugin({
        root,
        generateManifest: false,
      });

      await plugin.configResolved?.({} as never);

      expect(mockedModules.registerFromManifest).toHaveBeenCalledWith(
        '@test/local-package:LateClass',
        expect.objectContaining({ className: 'LateClass' }),
        '@test/local-package',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('setupSmrtManifests registers the local manifest without SMRT dependencies', async () => {
    const root = createTempProject({ name: '@test/local-package' });
    mockedModules.loadLocal.mockReturnValue({
      packageName: '@test/local-package',
      objects: {
        '@test/local-package:LateClass': {
          className: 'LateClass',
          fields: {},
        },
      },
    });

    try {
      await setupSmrtManifests({ root });

      expect(mockedModules.registerFromManifest).toHaveBeenCalledWith(
        '@test/local-package:LateClass',
        expect.objectContaining({ className: 'LateClass' }),
        '@test/local-package',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
