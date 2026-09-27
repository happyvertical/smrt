import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { introspectProject } from './tools/introspect-project.js';
import { resetRuntimeBootForTests } from './tools/runtime/boot.js';
import { runtimeRegistry } from './tools/runtime/observation.js';
import {
  importProjectRuntimeModule,
  loadProjectRuntime,
  resetProjectRuntimeForTests,
} from './tools/runtime/project-runtime.js';
import { runtimeMigrationStatus } from './tools/runtime/tools.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'smrt-project-runtime-'));
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
  resetRuntimeBootForTests();
  resetProjectRuntimeForTests();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe('selected project runtime boundary (#2961)', () => {
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
    for (const result of [
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
