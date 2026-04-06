import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveVitestEntrypoint, utilityCommands } from '../utilities.js';

describe('utilities', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
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
});
