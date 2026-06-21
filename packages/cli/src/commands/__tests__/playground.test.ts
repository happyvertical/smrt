/**
 * Unit tests for playground commands
 *
 * Covers the pure scaffolding/arg-handling paths of playground:init and
 * playground:list (and the dev-server branch selection of playground:dev)
 * against a real temp-dir filesystem. The only mocked boundaries are:
 *   - the workspace playground runtime (loaded lazily via importWorkspaceModule),
 *     because building/importing the full @happyvertical/smrt-playground host is
 *     out of scope for a unit test and supplies the template/discovery fns; and
 *   - node:child_process spawn, because playground:dev launches a long-running
 *     interactive dev server that cannot run inside a unit test.
 *
 * INFEASIBLE (flagged, not covered): the actual interactive dev server launched
 * by playground:dev (runCommand → spawn(..., { stdio: 'inherit' })) and the
 * real module discovery/import loop inside listDiscoveredPlaygrounds that reads
 * built playground packages — both require a live workspace build and a running
 * process, so only their orchestration (branch selection, output) is asserted.
 */

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { importWorkspaceModuleMock, spawnMock } = vi.hoisted(() => ({
  importWorkspaceModuleMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core/utils/import-workspace-module', () => ({
  importWorkspaceModule: importWorkspaceModuleMock,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

// playground.ts caches the resolved runtime in a module-level promise
// (playgroundRuntimePromise). Re-import the module fresh per test so each test
// can supply its own runtime mock without the first call's cache winning.
async function loadCommands() {
  const mod = await import('../playground.js');
  return mod.playgroundCommands;
}

// Build a fake playground runtime that the lazy loader returns.
function makeRuntime(overrides: Record<string, unknown> = {}) {
  return {
    createPackagePlaygroundTemplate: (name: string) =>
      `// package playground for ${name}\n`,
    createAppPlaygroundTemplate: (name: string) =>
      `// app playground for ${name}\n`,
    createAppPlaygroundRouteTemplate: () => '<!-- route -->\n',
    findSmrtWorkspaceRoot: () => null,
    detectPlaygroundMode: () => 'standalone',
    discoverPlaygroundTargets: vi.fn(async () => []),
    describePlaygroundSource: () => 'source-desc',
    importPlaygroundModule: vi.fn(async () => []),
    ...overrides,
  };
}

describe('playground commands', () => {
  let projectRoot: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    originalCwd = process.cwd();
    // realpath via mkdtempSync(tmpdir()) on macOS resolves through /private,
    // so resolve cwd through the same realpath the handler will see.
    projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-playground-')));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    importWorkspaceModuleMock.mockResolvedValue(makeRuntime());
    spawnMock.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    warnSpy.mockRestore();
    importWorkspaceModuleMock.mockReset();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  const out = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

  function writePackageJson(content: Record<string, unknown>) {
    writeFileSync(
      join(projectRoot, 'package.json'),
      `${JSON.stringify(content, null, 2)}\n`,
    );
  }

  describe('playground:init', () => {
    it('throws when no package.json is present', async () => {
      process.chdir(projectRoot);
      await expect(
        (await loadCommands())['playground:init'].handler([], {}),
      ).rejects.toThrow('No package.json found');
    });

    it('scaffolds package playground when --target package', async () => {
      writePackageJson({ name: '@happyvertical/smrt-demo' });
      process.chdir(projectRoot);

      await (await loadCommands())['playground:init'].handler([], {
        target: 'package',
      });

      const o = out();
      expect(o).toContain('Scaffolded package playground support');
      expect(o).toContain('src/svelte/playground.ts');
      const bridge = readFileSync(
        join(projectRoot, 'src/playground.ts'),
        'utf-8',
      );
      expect(bridge).toContain("from './svelte/playground.js'");
      const pkgPlayground = readFileSync(
        join(projectRoot, 'src/svelte/playground.ts'),
        'utf-8',
      );
      expect(pkgPlayground).toContain('package playground');
    });

    it('reports skipped files when scaffold already exists without --force', async () => {
      writePackageJson({ name: '@happyvertical/smrt-demo' });
      process.chdir(projectRoot);

      await (await loadCommands())['playground:init'].handler([], {
        target: 'package',
      });
      logSpy.mockClear();
      await (await loadCommands())['playground:init'].handler([], {
        target: 'package',
      });

      expect(out()).toContain('Skipped:');
    });

    it('overwrites existing files with --force', async () => {
      writePackageJson({ name: '@happyvertical/smrt-demo' });
      process.chdir(projectRoot);

      await (await loadCommands())['playground:init'].handler([], {
        target: 'package',
      });
      logSpy.mockClear();
      await (await loadCommands())['playground:init'].handler([], {
        target: 'package',
        force: true,
      });

      expect(out()).toContain('Created/updated:');
    });

    it('scaffolds app playground and warns when no vite config found', async () => {
      writePackageJson({ name: 'my-app' });
      process.chdir(projectRoot);

      await (await loadCommands())['playground:init'].handler([], {
        target: 'app',
      });

      const o = out();
      expect(o).toContain('Scaffolded app playground support');
      expect(o).toContain('src/routes/playground/+page.svelte');
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not find vite.config'),
      );
      // Dependency was added to package.json.
      const pkg = JSON.parse(
        readFileSync(join(projectRoot, 'package.json'), 'utf-8'),
      );
      expect(pkg.dependencies).toHaveProperty('@happyvertical/smrt-playground');
    });

    it('patches an existing vite config with the playground plugin', async () => {
      writePackageJson({ name: 'my-app' });
      writeFileSync(
        join(projectRoot, 'vite.config.ts'),
        "import { sveltekit } from '@sveltejs/kit/vite';\n\nexport default { plugins: [sveltekit()] };\n",
      );
      process.chdir(projectRoot);

      await (await loadCommands())['playground:init'].handler([], {
        target: 'app',
      });

      const vite = readFileSync(join(projectRoot, 'vite.config.ts'), 'utf-8');
      expect(vite).toContain('smrtPlaygroundVitePlugin');
      expect(out()).toContain('Created/updated:');
    });

    it('auto-detects app target from a non-smrt package name', async () => {
      writePackageJson({ name: 'plain-project' });
      process.chdir(projectRoot);

      await (await loadCommands())['playground:init'].handler([], {});

      expect(out()).toContain('Scaffolded app playground support');
    });
  });

  describe('playground:list', () => {
    it('reports when no playground modules are discovered', async () => {
      process.chdir(projectRoot);
      await (await loadCommands())['playground:list'].handler([], {});
      expect(out()).toContain('No playground modules discovered.');
    });

    it('lists discovered targets with their entries', async () => {
      importWorkspaceModuleMock.mockResolvedValue(
        makeRuntime({
          detectPlaygroundMode: () => 'workspace',
          discoverPlaygroundTargets: vi.fn(async () => [
            {
              packageName: '@happyvertical/smrt-demo',
              source: 'workspace',
              sourcePath: '/abs/src/index.ts',
              runtimePath: '/abs/dist/index.js',
            },
          ]),
          importPlaygroundModule: vi.fn(async () => [
            {
              packageName: '@happyvertical/smrt-demo',
              entries: [
                {
                  id: 'demo',
                  title: 'Demo Entry',
                  modes: { mock: {}, live: {} },
                },
              ],
            },
          ]),
        }),
      );
      process.chdir(projectRoot);

      await (await loadCommands())['playground:list'].handler([], {});

      const o = out();
      expect(o).toContain('Discovered 1 playground target(s)');
      expect(o).toContain('@happyvertical/smrt-demo');
      expect(o).toContain('demo: Demo Entry [mock, live]');
    });

    it('marks a target as unavailable when no modules load', async () => {
      importWorkspaceModuleMock.mockResolvedValue(
        makeRuntime({
          discoverPlaygroundTargets: vi.fn(async () => [
            {
              packageName: 'local app',
              source: 'installed',
              importSpecifier: 'pkg',
              runtimePath: '/abs/dist/index.js',
              sourcePath: '/abs/src/index.ts',
            },
          ]),
          importPlaygroundModule: vi.fn(async () => []),
        }),
      );
      process.chdir(projectRoot);

      await (await loadCommands())['playground:list'].handler([], {});

      expect(out()).toContain('Entries: unavailable');
    });
  });

  describe('playground:dev', () => {
    it('starts the shared host in workspace mode', async () => {
      // Simulate a successful child process that exits cleanly.
      spawnMock.mockImplementation(() => {
        const handlers: Record<string, (code: number) => void> = {};
        return {
          on: (event: string, cb: (code: number) => void) => {
            handlers[event] = cb;
            if (event === 'exit') setTimeout(() => cb(0), 0);
          },
        } as never;
      });

      importWorkspaceModuleMock.mockResolvedValue(
        makeRuntime({
          detectPlaygroundMode: () => 'workspace',
          findSmrtWorkspaceRoot: () => '/abs/workspace',
        }),
      );
      process.chdir(projectRoot);

      await (await loadCommands())['playground:dev'].handler([], {});

      expect(spawnMock).toHaveBeenCalled();
      expect(out()).toContain('shared SMRT playground host');
    });

    it('throws in workspace mode when the workspace root is unknown', async () => {
      importWorkspaceModuleMock.mockResolvedValue(
        makeRuntime({
          detectPlaygroundMode: () => 'workspace',
          findSmrtWorkspaceRoot: () => null,
        }),
      );
      process.chdir(projectRoot);

      await expect(
        (await loadCommands())['playground:dev'].handler([], {}),
      ).rejects.toThrow('Could not determine workspace root');
    });

    it('runs the local app dev server in standalone mode (npm)', async () => {
      spawnMock.mockImplementation(
        () =>
          ({
            on: (event: string, cb: (code: number) => void) => {
              if (event === 'exit') setTimeout(() => cb(0), 0);
            },
          }) as never,
      );

      importWorkspaceModuleMock.mockResolvedValue(
        makeRuntime({ detectPlaygroundMode: () => 'standalone' }),
      );
      // No lockfiles → npm.
      process.chdir(projectRoot);

      await (await loadCommands())['playground:dev'].handler([], {});

      expect(spawnMock).toHaveBeenCalledWith(
        'npm',
        ['run', 'dev'],
        expect.objectContaining({ cwd: projectRoot }),
      );
      expect(out()).toContain('app dev server');
    });

    it('rejects when the dev server exits with a non-zero code', async () => {
      spawnMock.mockImplementation(
        () =>
          ({
            on: (event: string, cb: (code: number) => void) => {
              if (event === 'exit') setTimeout(() => cb(1), 0);
            },
          }) as never,
      );

      importWorkspaceModuleMock.mockResolvedValue(
        makeRuntime({ detectPlaygroundMode: () => 'standalone' }),
      );
      process.chdir(projectRoot);

      await expect(
        (await loadCommands())['playground:dev'].handler([], {}),
      ).rejects.toThrow(/exited with code 1/);
    });
  });
});
