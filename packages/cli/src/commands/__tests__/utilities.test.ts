import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  serializeSmrtGenerationSnapshot,
  sha256SmrtGenerationSnapshot,
} from '@happyvertical/smrt-core/vite-plugin';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCliCommandArgs } from '../../cli-generator.js';
import {
  assertForceMigrationTargetsExist,
  resolveForceMigrationSelection,
  resolvePostgresTimestampMigration,
  resolveVitestEntrypoint,
  utilityCommands,
} from '../utilities.js';

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

  it('exposes --repair-data for db:migrate data repairs and keeps --upgrade-sti deprecated', () => {
    const migrateOptions = utilityCommands['db:migrate'].options;

    expect(migrateOptions?.['repair-data']).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(migrateOptions?.['repair-data'].description).toContain(
      'safe data repairs',
    );
    expect(migrateOptions?.['upgrade-sti'].description).toContain('Deprecated');
    expect(migrateOptions?.['upgrade-sti'].description).toContain(
      '--repair-data',
    );
  });

  it('exposes exact generated-migration force without weakening the global default', () => {
    const migrateOptions = utilityCommands['db:migrate'].options;

    expect(migrateOptions?.force).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(migrateOptions?.['force-migration']).toMatchObject({
      type: 'string',
      multiple: true,
    });
    expect(migrateOptions?.['force-migration'].description).toContain(
      'repeat for multiple IDs',
    );
  });

  it('requires an exact UTC confirmation before enabling PostgreSQL timestamp conversion', () => {
    const migrateOptions = utilityCommands['db:migrate'].options;

    expect(
      migrateOptions?.['postgres-timestamp-legacy-timezone'],
    ).toMatchObject({
      type: 'string',
    });
    expect(
      migrateOptions?.['postgres-timestamp-legacy-timezone'].description,
    ).toContain('Exact value required: UTC');
    expect(resolvePostgresTimestampMigration(undefined)).toBeUndefined();
    expect(resolvePostgresTimestampMigration('UTC')).toEqual({
      legacyTimezone: 'UTC',
    });
    expect(() => resolvePostgresTimestampMigration('America/Edmonton')).toThrow(
      /exactly UTC/,
    );
    expect(() => resolvePostgresTimestampMigration('UTC ')).toThrow(
      /exactly UTC/,
    );
  });

  it('parses the PostgreSQL timestamp confirmation without a default opt-in', () => {
    const migrate = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(
      ['db:migrate', '--postgres-timestamp-legacy-timezone', 'UTC'],
      [migrate],
    );

    expect(parsed.options['postgres-timestamp-legacy-timezone']).toBe('UTC');
  });

  it('offers the same exact PostgreSQL timestamp confirmation to db:diff', () => {
    const diff = utilityCommands['db:diff'];
    const parsed = parseCliCommandArgs(
      ['db:diff', '--postgres-timestamp-legacy-timezone', 'UTC'],
      [diff],
    );

    expect(diff.options?.['postgres-timestamp-legacy-timezone']).toMatchObject({
      type: 'string',
    });
    expect(parsed.options['postgres-timestamp-legacy-timezone']).toBe('UTC');
  });

  it('parses repeated exact migration flags in argv order', () => {
    const migrate = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(
      [
        'db:migrate',
        '--force-migration',
        'create_table_commissions',
        '--force-migration=create_table_referral_links',
      ],
      [migrate],
    );

    expect(parsed.options['force-migration']).toEqual([
      'create_table_commissions',
      'create_table_referral_links',
    ]);
  });

  it('preserves the existing single exact migration flag', () => {
    const migrate = utilityCommands['db:migrate'];
    const parsed = parseCliCommandArgs(
      ['db:migrate', '--force-migration', 'create_table_commissions'],
      [migrate],
    );

    expect(parsed.options['force-migration']).toEqual([
      'create_table_commissions',
    ]);
    expect(
      resolveForceMigrationSelection(false, parsed.options['force-migration']),
    ).toEqual({
      force: false,
      forceMigrations: ['create_table_commissions'],
    });
  });

  it('normalizes duplicate exact IDs and rejects ambiguous or broad selectors', () => {
    expect(
      resolveForceMigrationSelection(false, [
        ' create_table_commissions ',
        'create_table_referral_links',
        'create_table_commissions',
      ]),
    ).toEqual({
      force: false,
      forceMigrations: [
        'create_table_commissions',
        'create_table_referral_links',
      ],
    });

    expect(() => resolveForceMigrationSelection(false, '')).toThrow(
      /cannot be empty/,
    );
    expect(() => resolveForceMigrationSelection(false, 'first,second')).toThrow(
      /Comma-separated/,
    );
    expect(() => resolveForceMigrationSelection(false, '*')).toThrow(
      /wildcard/,
    );
    expect(() => resolveForceMigrationSelection(true, ['first'])).toThrow(
      /Do not combine --force/,
    );
  });

  it('requires every exact selector to exist in the current generated batch', () => {
    expect(() =>
      assertForceMigrationTargetsExist(
        ['create_table_commissions', 'create_table_missing'],
        ['create_table_commissions', 'create_table_referral_links'],
      ),
    ).toThrow(/create_table_missing/);

    expect(() =>
      assertForceMigrationTargetsExist(
        ['create_table_commissions', 'create_table_referral_links'],
        ['create_table_commissions', 'create_table_referral_links'],
      ),
    ).not.toThrow();
  });

  it('rejects a repeated migration flag without a value', () => {
    expect(() =>
      parseCliCommandArgs(
        ['db:migrate', '--force-migration', '--verbose'],
        [utilityCommands['db:migrate']],
      ),
    ).toThrow(/requires a value/);
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

  it('doctor reports a healthy project with all checks passing', async () => {
    const projectDir = await mkdtemp(
      resolve(process.cwd(), '.tmp-smrt-doctor-ok-'),
    );
    tempDirs.push(projectDir);

    await mkdir(resolve(projectDir, 'src/lib/objects'), { recursive: true });
    await mkdir(resolve(projectDir, 'src/lib/server'), { recursive: true });
    await mkdir(resolve(projectDir, '.smrt'), { recursive: true });

    // Private package => no publish-surface verification path.
    await writeFile(
      resolve(projectDir, 'package.json'),
      JSON.stringify({
        name: 'healthy-fixture',
        private: true,
        dependencies: {
          '@happyvertical/smrt-core': '0.0.0-test',
          '@sveltejs/kit': '0.0.0-test',
        },
      }),
    );
    await writeFile(
      resolve(projectDir, 'smrt.config.ts'),
      'export default {};\n',
    );
    await writeFile(
      resolve(projectDir, 'vite.config.ts'),
      [
        "import { smrtPlugin } from '@happyvertical/smrt-core/vite-plugin';",
        'export default { plugins: [smrtPlugin()] };',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(projectDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { experimentalDecorators: true } }),
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
    const manifest = {
      version: '1.0.0',
      timestamp: 0,
      packageName: 'healthy-fixture',
      objects: {},
    };
    await writeFile(
      resolve(projectDir, '.smrt/manifest.json'),
      JSON.stringify(manifest),
    );
    const provenance = 'git-tree:doctor-fixture';
    const snapshotPath = resolve(projectDir, 'generation-snapshot.json');
    const snapshot = serializeSmrtGenerationSnapshot(manifest, provenance, {
      sourceRoot: projectDir,
    });
    await writeFile(snapshotPath, snapshot);

    const originalCwd = process.cwd();
    process.chdir(projectDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await utilityCommands.doctor.handler([], {
      'generation-snapshot': snapshotPath,
      'generation-snapshot-sha256': sha256SmrtGenerationSnapshot(snapshot),
      'generation-snapshot-provenance': provenance,
      'generation-snapshot-source-root': projectDir,
    });

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('SMRT Doctor');
    expect(output).toContain('Generation snapshot verified (0 object(s))');
    expect(output).toContain('package.json exists');
    expect(output).toContain('SvelteKit detected');
    expect(output).toContain('smrtPlugin in vite.config');
    expect(output).toContain('experimentalDecorators enabled');
    expect(output).toContain('.env file exists');
    expect(output).toContain('Summary');

    logSpy.mockRestore();
    process.chdir(originalCwd);
  });

  it('doctor surfaces warnings for a bare project lacking optional config', async () => {
    const projectDir = await mkdtemp(
      resolve(process.cwd(), '.tmp-smrt-doctor-bare-'),
    );
    tempDirs.push(projectDir);

    // Missing smrt-core dependency, no vite/tsconfig, no objects dir, no .env.
    await writeFile(
      resolve(projectDir, 'package.json'),
      JSON.stringify({ name: 'bare-fixture', private: true }),
    );
    await writeFile(resolve(projectDir, '.env.example'), 'DATABASE_URL=\n');

    const originalCwd = process.cwd();
    process.chdir(projectDir);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      code?: string | number | null,
    ) => {
      throw new Error(`exit:${code ?? ''}`);
    }) as typeof process.exit);

    // Issues present (missing smrt-core, missing config) => exits 1.
    await expect(
      utilityCommands.doctor.handler([], {
        fix: true,
        'generation-snapshot': 'snapshot.json',
      }),
    ).rejects.toThrow('exit:1');

    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('@happyvertical/smrt-core installed');
    expect(output).toContain('Not a SvelteKit project');
    expect(output).toContain('.env.example exists');
    expect(output).toContain('Auto-fix is not yet implemented');
    expect(output).toContain('Missing required option(s)');
    expect(output).toContain('--generation-snapshot-sha256');
    expect(output).toContain('Issues to fix');

    exitSpy.mockRestore();
    logSpy.mockRestore();
    process.chdir(originalCwd);
  });

  it('introspect surfaces a guidance message when no manifests exist', async () => {
    const projectDir = await mkdtemp(
      resolve(process.cwd(), '.tmp-smrt-introspect-'),
    );
    tempDirs.push(projectDir);
    await writeFile(
      resolve(projectDir, 'package.json'),
      JSON.stringify({ name: 'introspect-fixture', private: true }),
    );

    const originalCwd = process.cwd();
    process.chdir(projectDir);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await utilityCommands.introspect.handler([], {});
    const output = logSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Introspecting SMRT project');

    logSpy.mockRestore();
    process.chdir(originalCwd);
  });
});
