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
      resolve: {
        alias: expect.arrayContaining([
          expect.objectContaining({ find: '@happyvertical/smrt-core' }),
        ]),
      },
      test: {
        setupFiles: ['existing-root-setup', defaultSetupFile],
      },
    });

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
      resolve: {
        alias: expect.arrayContaining([
          expect.objectContaining({ find: '@happyvertical/smrt-core' }),
        ]),
      },
      test: {
        setupFiles: [defaultSetupFile],
      },
    });

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
