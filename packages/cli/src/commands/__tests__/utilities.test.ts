import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveVitestEntrypoint, utilityCommands } from '../utilities.js';

vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({
    error: undefined,
    output: [null, '', 'Missing export file: dist/index.js'],
    pid: 0,
    signal: null,
    status: 1,
    stderr: 'Missing export file: dist/index.js',
    stdout: '',
  })),
}));

describe('utilities', () => {
  const tempDirs: string[] = [];

  async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function createExternalPackage(
    projectRoot: string,
    packageName: string,
  ): Promise<void> {
    const packageDir = resolve(
      projectRoot,
      'node_modules',
      ...packageName.split('/'),
    );

    await writeJson(resolve(packageDir, 'package.json'), {
      name: packageName,
      version: '0.0.0-test',
      type: 'module',
      exports: {
        '.': './dist/index.js',
        './manifest': './dist/manifest.json',
        './manifest.json': './dist/manifest.json',
      },
      dependencies: {
        '@happyvertical/smrt-core': '0.0.0-test',
      },
    });
    await mkdir(resolve(packageDir, 'dist'), { recursive: true });
    await writeFile(resolve(packageDir, 'dist/index.js'), 'export {};\n');
    await writeJson(resolve(packageDir, 'dist/manifest.json'), {
      version: '1.0.0',
      timestamp: Date.now(),
      packageName,
      objects: {
        [`${packageName}:FixtureExternal`]: {
          className: 'FixtureExternal',
          qualifiedName: `${packageName}:FixtureExternal`,
          packageName,
          collection: 'fixture_externals',
          fields: {
            email: { type: 'text', required: true },
          },
        },
      },
    });
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
    vi.clearAllMocks();
  });

  it('resolves vitest from nested project directories without a local node_modules', async () => {
    const tempRoot = await mkdtemp(
      resolve(process.cwd(), '.tmp-resolve-vitest-'),
    );
    tempDirs.push(tempRoot);

    const nestedProjectDir = resolve(tempRoot, 'apps', 'example');
    await mkdir(nestedProjectDir, { recursive: true });
    await writeFile(
      resolve(nestedProjectDir, 'package.json'),
      JSON.stringify({ name: 'example', private: true }),
    );

    const vitestEntrypoint = resolveVitestEntrypoint(nestedProjectDir);

    await access(vitestEntrypoint);
    expect(vitestEntrypoint).toMatch(/vitest[\\/]vitest\.mjs$/);
  });

  it('doctor reports missing consumer registrations for projects with external SMRT dependencies', async () => {
    const projectDir = await mkdtemp(
      resolve(process.cwd(), '.tmp-smrt-doctor-'),
    );
    tempDirs.push(projectDir);

    await mkdir(resolve(projectDir, 'src/lib/objects'), { recursive: true });
    await mkdir(resolve(projectDir, 'src/lib/server'), { recursive: true });
    await mkdir(resolve(projectDir, '.smrt'), { recursive: true });
    await createExternalPackage(projectDir, '@fixture/messages');

    await writeFile(
      resolve(projectDir, 'package.json'),
      JSON.stringify({
        name: 'doctor-fixture',
        private: true,
        dependencies: {
          '@happyvertical/smrt-core': '0.0.0-test',
          '@sveltejs/kit': '0.0.0-test',
        },
      }),
    );
    await writeFile(
      resolve(projectDir, 'smrt.config.js'),
      'export default {};\n',
    );
    await writeFile(
      resolve(projectDir, 'vite.config.ts'),
      [
        "import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';",
        'export default {',
        '  plugins: [smrtPlugin()],',
        '};',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(projectDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
        },
      }),
    );
    await writeFile(
      resolve(projectDir, 'src/lib/objects/index.ts'),
      'export {};\n',
    );
    await writeFile(
      resolve(projectDir, 'src/lib/server/smrt.ts'),
      'export {};\n',
    );
    await writeFile(
      resolve(projectDir, '.smrt/manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        timestamp: Date.now(),
        packageName: '@fixture/app',
        smrtDependencies: ['@fixture/messages'],
        objects: {},
      }),
    );

    const originalCwd = process.cwd();
    process.chdir(projectDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);

    await expect(utilityCommands.doctor.handler([], {})).rejects.toThrow(
      'exit:1',
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('smrtConsumer()');
    expect(output).toContain('.smrt/register.js');

    exitSpy.mockRestore();
    logSpy.mockRestore();
    process.chdir(originalCwd);
  });

  it('doctor reports broken packed publish artifacts for publishable packages', async () => {
    const projectDir = await mkdtemp(
      resolve(process.cwd(), '.tmp-smrt-doctor-pack-'),
    );
    tempDirs.push(projectDir);

    await mkdir(resolve(projectDir, 'src/lib/objects'), { recursive: true });
    await mkdir(resolve(projectDir, 'src/lib/server'), { recursive: true });
    await mkdir(resolve(projectDir, '.smrt'), { recursive: true });

    await writeFile(
      resolve(projectDir, 'package.json'),
      JSON.stringify({
        name: '@fixture/publishable',
        version: '1.0.0',
        type: 'module',
        dependencies: {
          '@happyvertical/smrt-core': '0.0.0-test',
          '@sveltejs/kit': '0.0.0-test',
        },
        exports: {
          '.': './dist/index.js',
        },
      }),
    );
    await writeFile(
      resolve(projectDir, 'smrt.config.js'),
      'export default {};\n',
    );
    await writeFile(
      resolve(projectDir, 'vite.config.ts'),
      [
        "import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';",
        'export default {',
        '  plugins: [smrtPlugin()],',
        '};',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(projectDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          experimentalDecorators: true,
        },
      }),
    );
    await writeFile(
      resolve(projectDir, 'src/lib/objects/index.ts'),
      'export {};\n',
    );
    await writeFile(
      resolve(projectDir, 'src/lib/server/smrt.ts'),
      'export {};\n',
    );
    await writeFile(resolve(projectDir, '.env'), '\n');
    await writeFile(
      resolve(projectDir, '.smrt/manifest.json'),
      JSON.stringify({
        version: '1.0.0',
        timestamp: Date.now(),
        packageName: '@fixture/publishable',
        objects: {},
      }),
    );

    const originalCwd = process.cwd();
    process.chdir(projectDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);

    await expect(utilityCommands.doctor.handler([], {})).rejects.toThrow(
      'exit:1',
    );

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Packed publish artifact verification');
    expect(output).toContain('dist/index.js');
    expect(spawnSync).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringContaining('verify-package-types-exports.js'), projectDir],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    exitSpy.mockRestore();
    logSpy.mockRestore();
    process.chdir(originalCwd);
  });
});
