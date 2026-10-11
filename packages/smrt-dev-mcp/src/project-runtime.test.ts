import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { introspectProject } from './tools/introspect-project.js';
import { resetRuntimeBootForTests } from './tools/runtime/boot.js';
import {
  runtimeRegistry,
  runtimeSchemaDiff,
} from './tools/runtime/observation.js';
import {
  importProjectRuntimeModule,
  loadProjectRuntime,
  resetProjectRuntimeForTests,
} from './tools/runtime/project-runtime.js';
import { runtimeMigrationStatus } from './tools/runtime/tools.js';

const roots: string[] = [];
// Node lookup includes ancestor node_modules: a temp directory alone is not
// isolation. Keep the same admission rule as scripts/packed-consumer.mjs.
function hasCleanAncestors(directory: string): boolean {
  for (let current = resolve(directory); ; current = dirname(current)) {
    if (existsSync(join(current, 'node_modules'))) return false;
    if (dirname(current) === current) return true;
  }
}
function project(): string {
  const parent = [tmpdir(), homedir()].find(hasCleanAncestors);
  if (!parent)
    throw new Error(
      'Choose a TMPDIR with no ancestor node_modules directories',
    );
  const root = mkdtempSync(join(parent, 'smrt-project-runtime-'));
  roots.push(root);
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'consumer', type: 'module' }),
  );
  return root;
}
function moduleAt(
  root: string,
  name: string,
  body: string,
  subpaths: Record<string, unknown> = {},
): string {
  const directory = join(root, 'node_modules', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({
      name,
      type: 'module',
      exports: { '.': { import: './index.js' }, ...subpaths },
    }),
  );
  writeFileSync(join(directory, 'index.js'), body);
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetRuntimeBootForTests();
  resetProjectRuntimeForTests();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('selected project runtime boundary (#2961)', () => {
  it('rejects fixture parents with an ancestor node_modules directory', () => {
    const parent = project();
    expect(hasCleanAncestors(parent)).toBe(true);
    mkdirSync(join(parent, 'node_modules'));
    expect(hasCleanAncestors(parent)).toBe(false);
    expect(hasCleanAncestors(join(parent, 'nested', 'consumer'))).toBe(false);
  });

  it('keeps static manifest introspection independent of runtime installation', async () => {
    const root = project();
    mkdirSync(join(root, '.smrt'));
    writeFileSync(
      join(root, '.smrt', 'manifest.json'),
      JSON.stringify({ objects: {} }),
    );
    const result = JSON.parse(await introspectProject({ directory: root }));
    expect(result.manifestSource).toBe('manifest');
    expect(result.objectCount).toBe(0);
  });

  it('fails source enrichment explicitly without borrowing the server runtime', async () => {
    const root = project();
    writeFileSync(
      join(root, 'model.ts'),
      "import { smrt, SmrtObject } from '@happyvertical/smrt-core'; @smrt() export class Entry extends SmrtObject { title = ''; }",
    );
    await expect(introspectProject({ directory: root })).rejects.toMatchObject({
      code: 'runtime_dependency_unavailable',
    });
  });

  it('returns safe missing-runtime diagnostics for registry and live DB tools', async () => {
    const root = project();
    vi.stubEnv('SMRT_DEV_DB_URL', '');
    for (const result of [
      await runtimeMigrationStatus({ projectPath: root }),
      await runtimeRegistry({ projectPath: root }),
      await runtimeMigrationStatus({
        projectPath: root,
        dbUrl: 'postgres://secret:password@localhost/private',
      }),
    ]) {
      expect(result.data.provenance).toBe('static');
      expect(result.diagnostics[0]?.code).toBe(
        'runtime_dependency_unavailable',
      );
      expect(JSON.stringify(result)).not.toContain(root);
      expect(JSON.stringify(result)).not.toContain('password');
      expect(result.data.snapshot).toBeUndefined();
    }
  });

  it('resolves hoisted workspace runtime from the selected project without changing its identity', async () => {
    const workspace = project();
    const root = join(workspace, 'packages', 'app');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"name":"app","type":"module"}');
    const core = moduleAt(
      workspace,
      '@happyvertical/smrt-core',
      'export const identity = "hoisted";',
    );
    moduleAt(core, '@happyvertical/sql', 'export const identity = "core-sql";');
    const runtime = await loadProjectRuntime(root);
    expect(runtime.core).toMatchObject({ identity: 'hoisted' });
    expect(runtime.projectRoot).toBe(realpathSync(root));
    await expect(loadProjectRuntime(workspace)).rejects.toMatchObject({
      code: 'runtime_project_mismatch',
    });
  });

  it('loads import-only exports and SQL from the chosen core installation', async () => {
    const root = project();
    const core = moduleAt(
      root,
      '@happyvertical/smrt-core',
      "export const identity = 'project-core';",
      { './scanner': { import: './scanner.js' } },
    );
    writeFileSync(
      join(core, 'scanner.js'),
      "export const identity = 'project-scanner';",
    );
    moduleAt(
      root,
      '@happyvertical/sql',
      "throw new Error('wrong project-level SQL');",
    );
    moduleAt(
      core,
      '@happyvertical/sql',
      "export const identity = 'core-owned-sql';",
    );
    const loaded = await loadProjectRuntime(root);
    expect(loaded.core).toMatchObject({ identity: 'project-core' });
    expect(loaded.sql).toMatchObject({ identity: 'core-owned-sql' });
    expect(
      await importProjectRuntimeModule(
        root,
        '@happyvertical/smrt-core/scanner',
      ),
    ).toMatchObject({ identity: 'project-scanner' });
  });

  it('runs enrichment in the selected cwd with captured logs', async () => {
    const root = project();
    const core = moduleAt(root, '@happyvertical/smrt-core', '', {
      './scanner': { import: './scanner.js' },
    });
    writeFileSync(
      join(root, 'model.ts'),
      "import { smrt, SmrtObject } from '@happyvertical/smrt-core'; @smrt() export class Entry extends SmrtObject { title = ''; }",
    );
    writeFileSync(
      join(core, 'scanner.js'),
      `
      console.log('not JSON-RPC');
      export class ManifestGenerator {
        injectTenantScopedFields() {} mergeInheritedFields() {} generateValidationRules() {}
        generateSchemas(manifest) { Object.values(manifest.objects).find(object => object.className === 'Entry').fields.title.default = process.cwd(); }
        assertTenantScopedSchemaContract() {} generateAgentManifests() {}
      }
    `,
    );
    const result = JSON.parse(
      await introspectProject({ directory: root, detail: 'full' }),
    );
    expect(
      result.objects[0].fieldDetails.find(
        (field: { name: string }) => field.name === 'title',
      ).default,
    ).toBe(realpathSync(root));
  });

  it.each([
    'process.exit(9);',
    "throw new Error('postgres://secret:password@host/private');",
    "export class ManifestGenerator { injectTenantScopedFields() { throw new Error('secret'); } }",
  ])('fails closed on enrichment process failure: %s', async (body) => {
    const root = project();
    const core = moduleAt(root, '@happyvertical/smrt-core', '', {
      './scanner': { import: './scanner.js' },
    });
    writeFileSync(join(core, 'scanner.js'), body);
    writeFileSync(
      join(root, 'model.ts'),
      "import { smrt, SmrtObject } from '@happyvertical/smrt-core'; @smrt() export class Entry extends SmrtObject { title = ''; }",
    );
    await expect(introspectProject({ directory: root })).rejects.not.toThrow(
      /secret|password/,
    );
  });

  it.each([
    'reader-missing',
    'migrations-missing',
    'comparer-incompatible',
    'read-error',
  ])('distinguishes runtime setup from database read failure: %s', async (kind) => {
    const root = project();
    const core = moduleAt(
      root,
      '@happyvertical/smrt-core',
      `export const ObjectRegistry = { registerFromManifest() {} }; ${kind === 'read-error' ? 'export async function readMigrationStatus() { throw new Error("database read failed"); }' : ''}`,
      {
        './manifest/discover-smrt-packages': './discovery.js',
        ...(kind === 'comparer-incompatible'
          ? { './migrations': './migrations.js' }
          : {}),
      },
    );
    writeFileSync(
      join(core, 'discovery.js'),
      'export function discoverSmrtPackages() { return []; } export function resolveManifestPath() {}',
    );
    writeFileSync(
      join(core, 'migrations.js'),
      'export const SchemaComparer = undefined;',
    );
    moduleAt(
      core,
      '@happyvertical/sql',
      'export let closed = false; export async function getDatabase() { return { close() { closed = true; } }; }',
    );
    const args = { projectPath: root, dbUrl: 'file:/tmp/selected.db' };
    const result = await (kind.startsWith('migrations') ||
    kind.startsWith('comparer')
      ? runtimeSchemaDiff(args)
      : runtimeMigrationStatus(args));
    expect(
      result.diagnostics.some(
        (d) =>
          d.code ===
          (kind === 'read-error'
            ? 'runtime_read_error'
            : 'runtime_dependency_unavailable'),
      ),
    ).toBe(true);
    expect(result.data).toMatchObject({
      connected: kind === 'read-error',
      provenance: kind === 'read-error' ? 'runtime (live DB)' : 'static',
    });
    if (kind !== 'read-error')
      expect(result.data).not.toHaveProperty('displayUrl');
    expect(JSON.stringify(result)).not.toContain(root);
    const sql = await importProjectRuntimeModule<{ closed: boolean }>(
      root,
      '@happyvertical/sql',
    );
    expect(sql.closed).toBe(true);
  });

  it.each([
    'sqlite',
    'postgres',
    'duckdb',
  ])('routes %s through the selected core SQL adapter', async (engine) => {
    const root = project();
    const core = moduleAt(
      root,
      '@happyvertical/smrt-core',
      'export async function readMigrationStatus(db) { return { engine: db.engine }; }',
    );
    moduleAt(
      core,
      '@happyvertical/sql',
      'export async function getDatabase(options) { return { engine: options.type, close() {} }; }',
    );
    const result = await runtimeMigrationStatus({
      projectPath: root,
      dbType: engine,
      dbUrl: 'file:/tmp/selected-database.db',
    });
    expect(result.data).toMatchObject({
      connected: true,
      engine,
      databaseType: engine,
    });
  });

  it('searches config from the selected project using core-owned config', async () => {
    const root = project();
    const core = moduleAt(
      root,
      '@happyvertical/smrt-core',
      'export async function readMigrationStatus(db) { return { file: db.url.split("/").pop() }; }',
    );
    moduleAt(
      root,
      '@happyvertical/smrt-config',
      'throw new Error("wrong config");',
    );
    moduleAt(
      core,
      '@happyvertical/sql',
      'export async function getDatabase(options) { return { ...options, close() {} }; }',
    );
    moduleAt(
      core,
      '@happyvertical/smrt-config',
      `let root; export async function loadConfig(options) { root = options.searchFrom; } export function getPackageConfig() { return { database: { type: 'sqlite', url: root === ${JSON.stringify(realpathSync(root))} ? 'sqlite:./selected.db' : 'sqlite:./wrong.db' } }; }`,
    );
    const result = await runtimeMigrationStatus({ projectPath: root });
    expect(result.data).toMatchObject({
      connected: true,
      file: 'selected.db',
      connectionSource: 'config',
    });
  });

  describe('DATABASE_URL fallback through the project smrt-config (#3446)', () => {
    // The workspace smrt-config itself, so this exercises the precedence the
    // `smrt` CLI applies, not a stub of it.
    const workspaceConfig = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../config',
    );

    function projectWithRealConfig(configSource: string | null): string {
      const root = project();
      const core = moduleAt(
        root,
        '@happyvertical/smrt-core',
        'export async function readMigrationStatus(db) { return { file: db.url.split("/").pop(), type: db.type }; }',
      );
      moduleAt(
        core,
        '@happyvertical/sql',
        'export async function getDatabase(options) { return { ...options, close() {} }; }',
      );
      mkdirSync(join(core, 'node_modules', '@happyvertical'), {
        recursive: true,
      });
      symlinkSync(
        workspaceConfig,
        join(core, 'node_modules', '@happyvertical', 'smrt-config'),
        'dir',
      );
      if (configSource !== null) {
        writeFileSync(join(root, 'smrt.config.mjs'), configSource);
      }
      return root;
    }

    it('opens DATABASE_URL when the config names no database', async () => {
      vi.stubEnv('SMRT_DEV_DB_URL', '');
      vi.stubEnv('DATABASE_URL', 'sqlite:./from-env.db');
      vi.stubEnv('DATABASE_TYPE', '');
      const root = projectWithRealConfig('export default {};\n');
      const result = await runtimeMigrationStatus({ projectPath: root });
      expect(result.data).toMatchObject({
        connected: true,
        file: 'from-env.db',
        type: 'sqlite',
        connectionSource: 'environment',
      });
    });

    it('takes the engine from DATABASE_TYPE like the CLI', async () => {
      vi.stubEnv('SMRT_DEV_DB_URL', '');
      vi.stubEnv('DATABASE_URL', 'postgres://dev@localhost/from-env');
      vi.stubEnv('DATABASE_TYPE', 'postgresql');
      const root = projectWithRealConfig(null);
      const result = await runtimeMigrationStatus({ projectPath: root });
      expect(result.data).toMatchObject({
        connected: true,
        file: 'from-env',
        type: 'postgres',
        connectionSource: 'environment',
      });
    });

    it('lets packages.cli.database win over DATABASE_URL', async () => {
      vi.stubEnv('SMRT_DEV_DB_URL', '');
      vi.stubEnv('DATABASE_URL', 'sqlite:./from-env.db');
      const root = projectWithRealConfig(
        "export default { packages: { cli: { database: { type: 'sqlite', url: 'sqlite:./from-config.db' } } } };\n",
      );
      const result = await runtimeMigrationStatus({ projectPath: root });
      expect(result.data).toMatchObject({
        connected: true,
        file: 'from-config.db',
        connectionSource: 'config',
      });
    });

    it('lets an explicit dbType override the DATABASE_URL engine', async () => {
      vi.stubEnv('SMRT_DEV_DB_URL', '');
      vi.stubEnv('DATABASE_URL', 'postgres://dev@localhost/from-env');
      vi.stubEnv('DATABASE_TYPE', 'postgres');
      const root = projectWithRealConfig(null);
      const result = await runtimeMigrationStatus({
        projectPath: root,
        dbType: 'sqlite',
      });
      expect(result.data).toMatchObject({
        connected: true,
        file: 'from-env',
        type: 'sqlite',
        connectionSource: 'environment',
      });
    });

    it('keeps the configured engine over an explicit dbType', async () => {
      vi.stubEnv('SMRT_DEV_DB_URL', '');
      vi.stubEnv('DATABASE_URL', '');
      const root = projectWithRealConfig(
        "export default { packages: { cli: { database: { type: 'sqlite', url: 'sqlite:./from-config.db' } } } };\n",
      );
      const result = await runtimeMigrationStatus({
        projectPath: root,
        dbType: 'postgres',
      });
      expect(result.data).toMatchObject({
        connected: true,
        file: 'from-config.db',
        type: 'sqlite',
        connectionSource: 'config',
      });
    });

    it('stays static-only for an unsupported DATABASE_TYPE', async () => {
      vi.stubEnv('SMRT_DEV_DB_URL', '');
      vi.stubEnv('DATABASE_URL', 'mysql://root:secret@db/app');
      vi.stubEnv('DATABASE_TYPE', 'mysql');
      const root = projectWithRealConfig(null);
      const result = await runtimeMigrationStatus({ projectPath: root });
      expect(result.data.provenance).toBe('static');
      expect(result.diagnostics[0]?.code).toBe(
        'runtime_connection_unavailable',
      );
      expect(JSON.stringify(result)).not.toContain('secret');
    });
  });

  it.each([
    'missing',
    'incompatible',
    'ordinary-config-error',
  ])('preserves runtime setup errors while allowing absent config: %s', async (kind) => {
    vi.stubEnv('SMRT_DEV_DB_URL', '');
    const root = project();
    const core = moduleAt(root, '@happyvertical/smrt-core', '');
    if (kind !== 'missing')
      moduleAt(
        core,
        '@happyvertical/smrt-config',
        kind === 'incompatible'
          ? 'export const incompatible = true;'
          : 'export async function loadConfig() { throw new Error("config absent"); } export function getPackageConfig() { return {}; }',
      );
    const result = await runtimeMigrationStatus({ projectPath: root });
    expect(result.diagnostics[0]?.code).toBe(
      kind === 'ordinary-config-error'
        ? 'runtime_connection_unavailable'
        : 'runtime_dependency_unavailable',
    );
    expect(JSON.stringify(result)).not.toContain(root);
    expect(result.data.provenance).toBe('static');
  });

  it('bounds a stalled enrichment process and returns no partial inventory', async () => {
    const root = project();
    const core = moduleAt(root, '@happyvertical/smrt-core', '', {
      './scanner': { import: './scanner.js' },
    });
    writeFileSync(
      join(core, 'scanner.js'),
      'setInterval(() => {}, 1000); await new Promise(() => {});',
    );
    writeFileSync(
      join(root, 'model.ts'),
      "import { smrt, SmrtObject } from '@happyvertical/smrt-core'; @smrt() export class Entry extends SmrtObject { title = ''; }",
    );
    await expect(introspectProject({ directory: root })).rejects.toThrow(
      'enrichment timed out',
    );
  }, 35_000);

  it('pins before asynchronous import and refuses a second project', async () => {
    const first = project();
    const second = project();
    moduleAt(
      first,
      '@happyvertical/smrt-core',
      "await new Promise(r => setTimeout(r, 10)); export const identity = 'first';",
    );
    moduleAt(
      second,
      '@happyvertical/smrt-core',
      "throw new Error('second runtime must not execute');",
    );
    const results = await Promise.allSettled([
      importProjectRuntimeModule(first, '@happyvertical/smrt-core'),
      importProjectRuntimeModule(second, '@happyvertical/smrt-core'),
    ]);
    expect(results[0]).toMatchObject({
      status: 'fulfilled',
      value: { identity: 'first' },
    });
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'runtime_project_mismatch' },
    });
  });

  it('sanitizes missing exports and module initialization failures', async () => {
    const root = project();
    moduleAt(
      root,
      '@happyvertical/smrt-core',
      "throw new Error('postgres://secret:password@host/private');",
    );
    for (const name of [
      '@happyvertical/smrt-core/scanner',
      '@happyvertical/smrt-core',
    ]) {
      try {
        await importProjectRuntimeModule(root, name);
        throw new Error('Expected setup failure');
      } catch (error) {
        expect(error).toMatchObject({ code: 'runtime_dependency_unavailable' });
        expect(String(error)).not.toContain('password');
        expect(String(error)).not.toContain(root);
      }
    }
  });
});
