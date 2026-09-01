/**
 * init command tests.
 *
 * Drives initCommands.init.handler against real temp project directories,
 * asserting on the scaffolded files. Console output is silenced; process.exit
 * is stubbed so error paths can be asserted without tearing down the worker.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCommands } from '../init.js';

let tempDir: string;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function writePackageJson(content: Record<string, unknown> | string): void {
  writeFileSync(
    join(tempDir, 'package.json'),
    typeof content === 'string' ? content : JSON.stringify(content),
    'utf-8',
  );
}

const init = initCommands.init.handler;
const INSTALLED_CLI_VERSION = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
).version as string;

describe('init command', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-init-'));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('scaffolds SMRT files for a SvelteKit project', async () => {
    writePackageJson({
      name: 'demo',
      devDependencies: { '@sveltejs/kit': '^2.0.0' },
    });

    await init([], { database: 'sqlite' });

    expect(existsSync(join(tempDir, 'smrt.config.ts'))).toBe(true);
    expect(existsSync(join(tempDir, 'src/lib/server/smrt.ts'))).toBe(true);
    expect(existsSync(join(tempDir, 'src/lib/objects/index.ts'))).toBe(true);
    expect(existsSync(join(tempDir, 'src/lib/objects/Example.ts'))).toBe(true);
    expect(existsSync(join(tempDir, '.env.example'))).toBe(true);
    expect(existsSync(join(tempDir, '.gitignore'))).toBe(true);
    // SQLite default creates a data directory.
    expect(existsSync(join(tempDir, 'data'))).toBe(true);

    const config = readFileSync(join(tempDir, 'smrt.config.ts'), 'utf-8');
    expect(config).toContain("type: 'sqlite'");
    expect(config).toContain('./data/app.db');

    const packageJson = JSON.parse(
      readFileSync(join(tempDir, 'package.json'), 'utf-8'),
    );
    expect(packageJson.dependencies).toMatchObject({
      '@happyvertical/smrt-core': `^${INSTALLED_CLI_VERSION}`,
      '@happyvertical/smrt-config': `^${INSTALLED_CLI_VERSION}`,
      '@modelcontextprotocol/server': '2.0.0',
    });
    expect(packageJson.devDependencies).toMatchObject({
      '@happyvertical/smrt-cli': `^${INSTALLED_CLI_VERSION}`,
    });
  });

  it('uses the postgres database type and url when requested', async () => {
    writePackageJson({
      name: 'demo',
      dependencies: { '@sveltejs/kit': '^2.0.0' },
    });

    await init([], { database: 'postgres' });

    const config = readFileSync(join(tempDir, 'smrt.config.ts'), 'utf-8');
    expect(config).toContain("type: 'postgres'");
    expect(config).toContain('postgres://localhost/app');
    // Postgres does not create the SQLite data directory.
    expect(existsSync(join(tempDir, 'data'))).toBe(false);
  });

  it('skips the example object when skipExample is set', async () => {
    writePackageJson({
      name: 'demo',
      devDependencies: { '@sveltejs/kit': '^2.0.0' },
    });

    await init([], { database: 'sqlite', skipExample: true });

    expect(existsSync(join(tempDir, 'src/lib/objects/Example.ts'))).toBe(false);
    expect(existsSync(join(tempDir, 'src/lib/objects/index.ts'))).toBe(true);
  });

  it('warns but continues for a non-SvelteKit project', async () => {
    writePackageJson({ name: 'plain' });

    await init([], { database: 'sqlite' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('does not appear to be a SvelteKit project'),
    );
    expect(existsSync(join(tempDir, 'smrt.config.ts'))).toBe(true);
  });

  it('appends SMRT patterns to an existing gitignore', async () => {
    writePackageJson({
      name: 'demo',
      devDependencies: { '@sveltejs/kit': '^2.0.0' },
    });
    writeFileSync(join(tempDir, '.gitignore'), 'node_modules\n', 'utf-8');

    await init([], { database: 'sqlite' });

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('SMRT auto-generated');
  });

  it('does not duplicate gitignore patterns on re-run', async () => {
    writePackageJson({
      name: 'demo',
      devDependencies: { '@sveltejs/kit': '^2.0.0' },
    });
    writeFileSync(
      join(tempDir, '.gitignore'),
      'node_modules\n# SMRT auto-generated\n',
      'utf-8',
    );

    await init([], { database: 'sqlite' });

    const gitignore = readFileSync(join(tempDir, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/SMRT auto-generated/g) || [];
    expect(matches).toHaveLength(1);
  });

  it('skips existing files unless force is passed', async () => {
    writePackageJson({
      name: 'demo',
      devDependencies: { '@sveltejs/kit': '^2.0.0' },
    });
    writeFileSync(join(tempDir, 'smrt.config.ts'), 'EXISTING', 'utf-8');

    await init([], { database: 'sqlite' });
    expect(readFileSync(join(tempDir, 'smrt.config.ts'), 'utf-8')).toBe(
      'EXISTING',
    );

    await init([], { database: 'sqlite', force: true });
    expect(readFileSync(join(tempDir, 'smrt.config.ts'), 'utf-8')).not.toBe(
      'EXISTING',
    );
  });

  it('exits when no package.json is present', async () => {
    // Throw from the exit stub so the handler aborts (mirroring real exit)
    // instead of falling through to the subsequent file reads.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    await expect(init([], { database: 'sqlite' })).rejects.toThrow(
      'process.exit called',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('No package.json found'),
    );
    exitSpy.mockRestore();
  });

  it('exits when package.json is invalid JSON', async () => {
    writePackageJson('{ not valid json');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    await expect(init([], { database: 'sqlite' })).rejects.toThrow(
      'process.exit called',
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse package.json'),
    );
    exitSpy.mockRestore();
  });

  it('preserves existing package versions when promoting runtime dependencies', async () => {
    writePackageJson({
      name: 'demo',
      devDependencies: {
        '@sveltejs/kit': '^2.0.0',
        '@happyvertical/smrt-core': '^1.0.0',
        '@happyvertical/smrt-cli': '^1.0.0',
      },
      dependencies: {
        '@happyvertical/smrt-config': '^1.0.0',
        '@modelcontextprotocol/server': '^3.0.0',
      },
    });

    await init([], { database: 'sqlite' });

    const packageJson = JSON.parse(
      readFileSync(join(tempDir, 'package.json'), 'utf-8'),
    );
    expect(packageJson.dependencies).toMatchObject({
      '@happyvertical/smrt-core': '^1.0.0',
      '@happyvertical/smrt-config': '^1.0.0',
      '@modelcontextprotocol/server': '^3.0.0',
    });
    expect(packageJson.devDependencies).toMatchObject({
      '@happyvertical/smrt-cli': '^1.0.0',
    });
    expect(
      packageJson.devDependencies['@happyvertical/smrt-core'],
    ).toBeUndefined();

    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('Added SMRT dependencies');
  });

  it('does not rewrite package.json when every dependency is already declared', async () => {
    const packageJson = {
      name: 'demo',
      dependencies: {
        '@happyvertical/smrt-core': '^1.0.0',
        '@happyvertical/smrt-config': '^1.0.0',
        '@modelcontextprotocol/server': '^3.0.0',
      },
      devDependencies: {
        '@sveltejs/kit': '^2.0.0',
        '@happyvertical/smrt-cli': '^1.0.0',
      },
    };
    writePackageJson(packageJson);
    const before = readFileSync(join(tempDir, 'package.json'), 'utf-8');

    await init([], { database: 'sqlite' });

    expect(readFileSync(join(tempDir, 'package.json'), 'utf-8')).toBe(before);
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).not.toContain('Added SMRT dependencies');
  });
});
