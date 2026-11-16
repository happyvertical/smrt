import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const withoutWorkspaceDist = registerHooks({
  load(url, context, next) {
    assert.doesNotMatch(url, /\/packages\/[^/]+\/dist\//);
    return next(url, context);
  },
});
const { configName, generateWorkspaceSourcePaths } = await import(
  './generate-workspace-source-paths.mjs'
).finally(() => withoutWorkspaceDist.deregister());

const root = fileURLToPath(new URL('../', import.meta.url));

test('the checked-in workspace map matches the current package exports', () => {
  const actual = JSON.parse(readFileSync(join(root, configName), 'utf8'));
  assert.deepEqual(
    actual,
    generateWorkspaceSourcePaths(root),
    'Run node scripts/generate-workspace-source-paths.mjs to refresh the map',
  );
});

test('the no-emit profile resolves roots, exact subpaths and public patterns with sibling dist unavailable', () => {
  const options = ts.getParsedCommandLineOfConfigFile(
    join(root, 'packages/users/tsconfig.typecheck.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: assert.fail },
  );
  assert.deepEqual(options.errors, []);
  assert.deepEqual(options.projectReferences, undefined);
  assert.equal(options.options.noEmit, true);

  const hideWorkspaceDist = (path) =>
    /\/packages\/[^/]+\/dist(?:\/|$)/.test(
      ts.sys.realpath(path).replaceAll('\\', '/'),
    );
  const host = {
    ...ts.sys,
    fileExists: (path) => !hideWorkspaceDist(path) && ts.sys.fileExists(path),
    directoryExists: (path) =>
      !hideWorkspaceDist(path) && ts.sys.directoryExists(path),
  };
  const importer = join(root, 'packages/users/src/index.ts');
  const resolveSource = (specifier) =>
    ts.resolveModuleName(specifier, importer, options.options, host)
      .resolvedModule?.resolvedFileName;

  for (const [specifier, relativePath] of Object.entries({
    '@happyvertical/smrt-types': 'types/src/index.ts',
    '@happyvertical/smrt-core/manifest/discover-smrt-packages':
      'core/src/manifest/discover-smrt-packages.ts',
    '@happyvertical/smrt-products': 'products/src/lib/index.ts',
    '@happyvertical/smrt-template-sveltekit/host/server': 'template-sveltekit/host/server.ts',
    '@happyvertical/smrt-ui/utils/forms/formatters.js':
      'smrt-ui/src/utils/forms/formatters.ts',
    '@happyvertical/smrt-ui/test-support/setup':
      'smrt-ui/src/test-support/setup.ts',
  })) {
    assert.equal(resolveSource(specifier), join(root, 'packages', relativePath));
  }
  for (const specifier of [
    '@happyvertical/smrt-core/manifest/test-artifacts',
    '@happyvertical/smrt-ui/utils/forms/formatters',
    '@happyvertical/smrt-fields/manifest.json',
  ]) {
    assert.equal(resolveSource(specifier), undefined, specifier);
  }
});

test('new concrete wildcard exports receive aliases and missing declared sources fail', (context) => {
  const fixture = mkdtempSync(join(tmpdir(), 'workspace-source-paths-'));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  const write = (path, text) => {
    const file = join(fixture, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  };
  write('pnpm-workspace.yaml', 'packages: [packages/*]');
  write(
    'packages/fixture/package.json',
    JSON.stringify({
      name: '@scope/fixture',
      exports: {
        './utils/*': './dist/utils/*',
        './utils/private.js': null,
        './types/*': {
          types: './dist/types/*.d.ts',
        },
        './types/private/*': null,
        './types/*-internal': null,
        './only-types': { types: './dist/only-types.d.ts' },
        './manifest.json': './dist/manifest.json',
      },
    }),
  );
  write('packages/fixture/src/utils/public.ts', 'export {}');
  write('packages/fixture/src/utils/private.ts', 'export {}');
  write('packages/fixture/src/utils/public.test.ts', 'export {}');
  write('packages/fixture/src/types/thing.ts', 'export {}');
  write('packages/fixture/src/types/private/thing.ts', 'export {}');
  write('packages/fixture/src/types/thing-internal.ts', 'export {}');
  write('packages/fixture/src/only-types.ts', 'export {}');
  write('packages/fixture/dist/manifest.json', '{}');

  assert.deepEqual(generateWorkspaceSourcePaths(fixture).compilerOptions.paths, {
    '@scope/fixture/only-types': ['./packages/fixture/src/only-types.ts'],
    '@scope/fixture/types/thing': ['./packages/fixture/src/types/thing.ts'],
    '@scope/fixture/utils/public.js': ['./packages/fixture/src/utils/public.ts'],
  });
  write(
    'packages/fixture/package.json',
    JSON.stringify({
      name: '@scope/fixture',
      exports: {
        './missing': { types: './dist/missing.d.ts', import: './dist/missing.js' },
      },
    }),
  );
  assert.throws(
    () => generateWorkspaceSourcePaths(fixture),
    /No source for typed export @scope\/fixture\/missing/,
  );
});
