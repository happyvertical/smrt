/**
 * Downstream production-bundle registry regression gate (#2308).
 *
 * A package's inline manifest must remain authoritative after a consumer
 * bundles the provider with `ssr.noExternal: true`. The test runs
 * emitted JavaScript in a fresh process so no workspace test manifest or
 * previous registry global can make the assertion pass accidentally.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, 'fixtures/consumer-registry-identity.ts');

const RUNTIME_EXTERNAL = [
  'better-sqlite3',
  'pg-native',
  'duckdb',
  '@duckdb/node-api',
  '@duckdb/node-bindings',
  'sharp',
  'bufferutil',
  'utf-8-validate',
];

interface RegistryResult {
  fieldPolicy: {
    packageName?: string;
    qualifiedName?: string;
    tableName?: string;
    fieldNames: string[];
    matchCount: number;
    collectionItemMatches: boolean;
    emptyListCount: number;
  };
  sharedA: {
    packageName?: string;
    tableName?: string;
    fieldNames: string[];
    constructorMatches: boolean;
  };
  sharedB: {
    packageName?: string;
    tableName?: string;
    fieldNames: string[];
    constructorMatches: boolean;
  };
  sharedMatchCount: number;
  sharedRuntimeNames: string[];
  sharedDecoratorKeys: { a: string[]; b: string[] };
  renamed: {
    packageName?: string;
    qualifiedName?: string;
    tableName?: string;
    fieldNames: string[];
    staleRuntimeNameCount: number;
  };
  consumerConflictPackage?: string;
  providerConflictPackage?: string;
}

describe('production consumer registry identity (#2308)', () => {
  it('preserves provider ownership, fields, and schema after SSR bundling', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'smrt-registry-gate-'));
    const outDir = path.join(tempRoot, 'build', 'server');

    try {
      const output = (await build({
        configFile: false,
        logLevel: 'error',
        build: {
          ssr: true,
          outDir,
          emptyOutDir: true,
          // SvelteKit's SSR build is unminified by default, but Rollup still
          // deconflicts constructor names while combining package chunks.
          minify: false,
          sourcemap: false,
          target: 'node24',
          rollupOptions: {
            input: { server: fixture },
          },
        },
        ssr: {
          noExternal: true,
          external: RUNTIME_EXTERNAL,
        },
      })) as Rollup.RollupOutput;

      const serverChunk = output.output.find(
        (item): item is Rollup.OutputChunk =>
          item.type === 'chunk' && item.isEntry,
      );
      expect(serverChunk).toBeDefined();

      const entryPath = path.join(outDir, serverChunk?.fileName ?? '');
      const entryCode = await readFile(entryPath, 'utf8');
      await writeFile(
        path.join(outDir, 'package.json'),
        JSON.stringify({ name: '@test/consumer', type: 'module' }),
      );
      // Dynamic database adapters remain runtime imports. Model a normal
      // installed consumer while keeping the emitted app and registry state in
      // the isolated temp tree/fresh process.
      await symlink(
        path.resolve(here, '../../node_modules'),
        path.join(tempRoot, 'node_modules'),
        'dir',
      );

      const { stdout } = await execFileAsync(process.execPath, [entryPath], {
        cwd: outDir,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024,
      });

      const resultLine = stdout
        .split('\n')
        .find((line) => line.startsWith('SMRT_REGISTRY_RESULT='));
      expect(resultLine, `bundle output:\n${stdout}`).toBeDefined();

      const result = JSON.parse(
        resultLine?.slice('SMRT_REGISTRY_RESULT='.length) ?? '{}',
      ) as RegistryResult;

      expect(entryCode).toContain('registerPackageManifest');
      expect(result.fieldPolicy).toMatchObject({
        packageName: '@happyvertical/smrt-fields',
        qualifiedName: '@happyvertical/smrt-fields:FieldPolicy',
        tableName: '_smrt_field_policies',
        matchCount: 1,
        collectionItemMatches: true,
        emptyListCount: 0,
      });
      expect(result.fieldPolicy.fieldNames).toEqual(
        expect.arrayContaining([
          'fieldName',
          'objectRef',
          'scopeKey',
          'scopeType',
        ]),
      );
      expect(result.sharedA).toEqual({
        packageName: '@test/a',
        tableName: 'a_shared_things',
        fieldNames: ['alpha'],
        constructorMatches: true,
      });
      expect(result.sharedB).toEqual({
        packageName: '@test/b',
        tableName: 'b_shared_things',
        fieldNames: ['beta'],
        constructorMatches: true,
      });
      expect(result.sharedMatchCount).toBe(2);
      expect(result.sharedRuntimeNames).toEqual([
        'SharedThing',
        'SharedThing2',
      ]);
      expect(result.sharedDecoratorKeys).toEqual({
        a: ['alpha'],
        b: ['beta'],
      });
      expect(result.renamed).toEqual({
        packageName: '@test/renamed',
        qualifiedName: '@test/renamed:RenamedProviderObject',
        tableName: 'renamed_provider_objects',
        fieldNames: ['key'],
        staleRuntimeNameCount: 0,
      });
      expect(result.consumerConflictPackage).toBe('@test/consumer');
      expect(result.providerConflictPackage).toBe('@test/provider');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
