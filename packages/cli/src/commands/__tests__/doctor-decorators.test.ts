/**
 * Doctor's decorator-transform check (#2368).
 *
 * The check used to demand `experimentalDecorators` in tsconfig.json
 * unconditionally, which contradicts the framework's own Vite 8 guidance: the
 * oxc transform ignores that setting, so a correct Vite 8 project (decorators
 * under `oxc.decorator`) was reported broken while a Vite 8 project relying on
 * tsconfig alone was reported healthy right up until the first SSR request
 * threw `SyntaxError: Invalid or unexpected token`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assessDecoratorSupport,
  resolveDeclaredViteMajor,
  utilityCommands,
} from '../utilities.js';

const VITE8_CONFIG = [
  "import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';",
  'export default {',
  '  plugins: [smrtPlugin()],',
  '  oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },',
  '};',
  '',
].join('\n');

const LEGACY_CONFIG = [
  "import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';",
  'export default { plugins: [smrtPlugin()] };',
  '',
].join('\n');

describe('resolveDeclaredViteMajor', () => {
  it('reads the major from ordinary ranges', () => {
    expect(resolveDeclaredViteMajor({ devDependencies: { vite: '^8.1.2' } })).toBe(
      8,
    );
    expect(resolveDeclaredViteMajor({ dependencies: { vite: '7.0.0' } })).toBe(7);
    expect(resolveDeclaredViteMajor({ devDependencies: { vite: '>=8.0.0' } })).toBe(
      8,
    );
  });

  it('returns null when Vite is absent or the range has no readable major', () => {
    expect(resolveDeclaredViteMajor({})).toBeNull();
    expect(resolveDeclaredViteMajor({ devDependencies: { vite: '*' } })).toBeNull();
    expect(
      resolveDeclaredViteMajor({ devDependencies: { vite: 'workspace:*' } }),
    ).toBeNull();
  });
});

describe('assessDecoratorSupport', () => {
  it('accepts a Vite 8 project configured through oxc.decorator', () => {
    expect(
      assessDecoratorSupport({
        viteMajor: 8,
        viteConfigContent: VITE8_CONFIG,
        tsconfigContent: '{}',
      }),
    ).toEqual({
      status: 'ok',
      message: 'oxc.decorator configured in vite.config',
    });
  });

  it('rejects a Vite 8 project that only sets tsconfig experimentalDecorators', () => {
    const result = assessDecoratorSupport({
      viteMajor: 8,
      viteConfigContent: LEGACY_CONFIG,
      tsconfigContent: '{"compilerOptions":{"experimentalDecorators":true}}',
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('Vite 8 ignores tsconfig');
    expect(result.message).toContain('oxc');
  });

  it('accepts the legacy tsconfig recipe on vite<8', () => {
    expect(
      assessDecoratorSupport({
        viteMajor: 7,
        viteConfigContent: LEGACY_CONFIG,
        tsconfigContent: '{"compilerOptions":{"experimentalDecorators":true}}',
      }).status,
    ).toBe('ok');
  });

  it('accepts the legacy recipe when no Vite version is declared', () => {
    expect(
      assessDecoratorSupport({
        viteMajor: null,
        viteConfigContent: LEGACY_CONFIG,
        tsconfigContent: '{"compilerOptions":{"experimentalDecorators":true}}',
      }).status,
    ).toBe('ok');
  });

  it('reports an error when neither recipe is present', () => {
    const result = assessDecoratorSupport({
      viteMajor: null,
      viteConfigContent: LEGACY_CONFIG,
      tsconfigContent: '{"compilerOptions":{}}',
    });

    expect(result.status).toBe('error');
    expect(result.message).toContain('No decorator transform configured');
  });

  it('warns rather than fails when the project has neither config file', () => {
    expect(
      assessDecoratorSupport({
        viteMajor: null,
        viteConfigContent: null,
        tsconfigContent: null,
      }).status,
    ).toBe('warning');
  });
});

describe('doctor decorator check (end to end)', () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  async function createProject(files: Record<string, string>): Promise<string> {
    const projectDir = await mkdtemp(
      resolve(process.cwd(), '.tmp-smrt-doctor-decorators-'),
    );
    tempDirs.push(projectDir);
    await mkdir(resolve(projectDir, 'src/lib/objects'), { recursive: true });
    await mkdir(resolve(projectDir, 'src/lib/server'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(resolve(projectDir, name), content);
    }
    return projectDir;
  }

  it('does not flag a correct Vite 8 project that omits experimentalDecorators', async () => {
    const projectDir = await createProject({
      'package.json': JSON.stringify({
        name: 'vite8-fixture',
        private: true,
        dependencies: { '@happyvertical/smrt-core': '0.0.0-test' },
        devDependencies: { vite: '^8.0.0' },
      }),
      'smrt.config.ts': 'export default {};\n',
      'vite.config.ts': VITE8_CONFIG,
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      '.env': '\n',
    });
    await writeFile(resolve(projectDir, 'src/lib/objects/index.ts'), 'export {};\n');
    await writeFile(resolve(projectDir, 'src/lib/server/smrt.ts'), 'export {};\n');

    process.chdir(projectDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);

    // The fixture is deliberately minimal, so unrelated checks may still fail;
    // this test is only about the decorator verdict.
    await utilityCommands.doctor.handler([], {}).catch(() => undefined);

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('✅ Decorator transform configured');
    expect(output).not.toContain('experimentalDecorators');

    exitSpy.mockRestore();
  });

  it('flags a Vite 8 project that relies on tsconfig alone', async () => {
    const projectDir = await createProject({
      'package.json': JSON.stringify({
        name: 'vite8-tsconfig-fixture',
        private: true,
        dependencies: { '@happyvertical/smrt-core': '0.0.0-test' },
        devDependencies: { vite: '^8.0.0' },
      }),
      'smrt.config.ts': 'export default {};\n',
      'vite.config.ts': LEGACY_CONFIG,
      'tsconfig.json': JSON.stringify({
        compilerOptions: { experimentalDecorators: true },
      }),
      '.env': '\n',
    });
    await writeFile(resolve(projectDir, 'src/lib/objects/index.ts'), 'export {};\n');
    await writeFile(resolve(projectDir, 'src/lib/server/smrt.ts'), 'export {};\n');

    process.chdir(projectDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);

    await expect(utilityCommands.doctor.handler([], {})).rejects.toThrow('exit:1');

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Vite 8 ignores tsconfig experimentalDecorators');

    exitSpy.mockRestore();
  });
});
