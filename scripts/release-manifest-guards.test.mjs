import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runReleaseManifestGuards } from './release-manifest-guards.mjs';

// Issue #2853: the manifest guards run centrally for every package the release
// packs, so a package without `prepack` (or any package added later) cannot
// publish a manifest that omits a source object or advertises an object its
// packed exports do not provide. These tests drive the real release validator
// (`validate-publish-packages.js`, the producer of every published tarball)
// against a fixture workspace whose package defines no scripts at all.

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const validatorPath = join(scriptsDir, 'validate-publish-packages.js');
const PACKAGE_NAME = '@happyvertical/smrt-guard-fixture';
const directories = new Set();

after(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

const WIDGET_SOURCE = `
import { smrt, SmrtObject } from '@happyvertical/smrt-core';

@smrt({ tableName: 'widgets' })
export class Widget extends SmrtObject {
  label: string = '';
}
`;

function manifestObject(className, extra = {}) {
  return {
    name: className.toLowerCase(),
    className,
    exportName: className,
    importPath: PACKAGE_NAME,
    ...extra,
  };
}

/**
 * A fixture workspace: one publishable package in the fixed release group,
 * with no `prepack` (no scripts at all), prebuilt `dist/` and real `src/`.
 */
function createWorkspace({
  sources = { 'widget.ts': WIDGET_SOURCE },
  rootExports = ['Widget'],
  objects = { [`${PACKAGE_NAME}:Widget`]: manifestObject('Widget') },
  manifestExport = true,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'smrt-release-guards-'));
  directories.add(root);
  writeJson(join(root, '.changeset/config.json'), { fixed: [[PACKAGE_NAME]] });

  const packageDir = join(root, 'packages', 'guard-fixture');
  const exportsMap = {
    '.': { types: './dist/index.d.ts', import: './dist/index.js' },
  };
  if (manifestExport) {
    exportsMap['./manifest'] = './dist/manifest.json';
    exportsMap['./manifest.json'] = './dist/manifest.json';
  }
  writeJson(join(packageDir, 'package.json'), {
    name: PACKAGE_NAME,
    version: '0.1.0',
    type: 'module',
    files: ['dist'],
    exports: exportsMap,
    publishConfig: { access: 'public' },
  });
  for (const [file, source] of Object.entries(sources)) {
    writeText(join(packageDir, 'src', file), source);
  }
  writeText(
    join(packageDir, 'dist/index.js'),
    `${rootExports.map((name) => `export class ${name} {}`).join('\n')}\n`,
  );
  writeText(
    join(packageDir, 'dist/index.d.ts'),
    `${rootExports.map((name) => `export declare class ${name} {}`).join('\n')}\nexport {};\n`,
  );
  if (manifestExport) {
    writeJson(join(packageDir, 'dist/manifest.json'), {
      version: '1.0.0',
      objects,
    });
  }
  return { root, packageDir, outputDir: join(root, 'out') };
}

function runValidator(root) {
  return spawnSync(
    process.execPath,
    [validatorPath, '--output-dir', join(root, 'out')],
    { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' } },
  );
}

function combined(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function shardManifest(outputDir) {
  const path = join(outputDir, 'manifest-1-of-1.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

test('release validation guards a package that defines no prepack and records its artifact', () => {
  const { root, outputDir } = createWorkspace();
  const result = runValidator(root);

  assert.equal(result.status, 0, combined(result));
  assert.match(combined(result), /\[verify-manifest\] ✅ .*includes all 1 source object/);
  assert.match(combined(result), /\[verify-manifest-exports\] ✅ .*1 manifest object\(s\) resolve/);
  assert.deepEqual(
    shardManifest(outputDir).packages.map((artifact) => artifact.name),
    [PACKAGE_NAME],
  );
});

test('release validation refuses a package that advertises an object its packed exports omit', () => {
  const { root, outputDir } = createWorkspace({ rootExports: ['Other'] });
  const result = runValidator(root);

  assert.equal(result.status, 1);
  assert.match(
    combined(result),
    /manifest advertises "Widget" from "@happyvertical\/smrt-guard-fixture", but the built module does not export it/,
  );
  assert.match(combined(result), /Release manifest guards failed for @happyvertical\/smrt-guard-fixture: manifest exports/);
  assert.equal(shardManifest(outputDir), null);
});

test('release validation refuses a stale manifest that omits a source object', () => {
  const { root, outputDir } = createWorkspace({
    sources: {
      'widget.ts': WIDGET_SOURCE,
      'gadget.ts': WIDGET_SOURCE.replaceAll('Widget', 'Gadget').replace(
        'widgets',
        'gadgets',
      ),
    },
  });
  const result = runValidator(root);

  assert.equal(result.status, 1);
  assert.match(combined(result), /@happyvertical\/smrt-guard-fixture:Gadget/);
  assert.match(combined(result), /manifest completeness/);
  assert.equal(shardManifest(outputDir), null);
});

test('release validation refuses a package that declares objects without a manifest export', () => {
  const { root, outputDir } = createWorkspace({ manifestExport: false });
  const result = runValidator(root);

  assert.equal(result.status, 1);
  assert.match(combined(result), /publishes no \.\/manifest export/);
  assert.equal(shardManifest(outputDir), null);
});

test('release validation keeps the collection-companion exemption', () => {
  const { root } = createWorkspace({
    objects: {
      [`${PACKAGE_NAME}:Widget`]: manifestObject('Widget'),
      [`${PACKAGE_NAME}:WidgetCollection`]: manifestObject('WidgetCollection', {
        extends: 'SmrtCollection',
        extendsTypeArg: 'Widget',
      }),
    },
  });
  const result = runValidator(root);

  assert.equal(result.status, 0, combined(result));
  assert.match(combined(result), /1 not checked: collection companion/);
});

test('release validation keeps the stronger closed-model export check', () => {
  // A model whose API, CLI and MCP surfaces are all closed is still imported
  // by generated consumer registration, so withholding its export fails.
  const { root } = createWorkspace({
    rootExports: ['Other'],
    objects: {
      [`${PACKAGE_NAME}:Widget`]: manifestObject('Widget', {
        decoratorConfig: { api: false, cli: false, mcp: false },
      }),
    },
  });
  const result = runValidator(root);

  assert.equal(result.status, 1);
  assert.match(combined(result), /advertises "Widget".*does not export it/);
});

function packFixture(packageDir, mutate) {
  const stage = mkdtempSync(join(tmpdir(), 'smrt-release-guards-stage-'));
  directories.add(stage);
  const staged = join(stage, 'package');
  mkdirSync(join(staged, 'dist'), { recursive: true });
  for (const file of [
    'package.json',
    'dist/index.js',
    'dist/index.d.ts',
    'dist/manifest.json',
  ]) {
    copyFileSync(join(packageDir, file), join(staged, file));
  }
  mutate?.(staged);
  const tarballPath = join(stage, 'fixture.tgz');
  const packed = spawnSync('tar', ['-czf', tarballPath, '-C', stage, 'package']);
  assert.equal(packed.status, 0, String(packed.stderr));
  return tarballPath;
}

test('the guard verifies the tarball, not only the workspace: a packed manifest that differs fails', () => {
  const { packageDir } = createWorkspace();
  const tarballPath = packFixture(packageDir, (staged) => {
    writeJson(join(staged, 'dist/manifest.json'), { version: '1.0.0', objects: {} });
  });

  const result = runReleaseManifestGuards({ packageDir, tarballPath });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['packed manifest identity']);
  assert.match(result.logs.join('\n'), /differs from the verified workspace/);
});

test('the exports verdict loads the packed modules, not the workspace dist', () => {
  const { packageDir } = createWorkspace();
  const tarballPath = packFixture(packageDir, (staged) => {
    writeText(join(staged, 'dist/index.js'), 'export class Other {}\n');
  });

  const result = runReleaseManifestGuards({ packageDir, tarballPath });

  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['manifest exports (#2845)']);
});

test('a packed exports map that diverges from the workspace manifest exports fails', () => {
  const { packageDir } = createWorkspace();
  const tarballPath = packFixture(packageDir, (staged) => {
    const packageJson = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'));
    packageJson.exports['./manifest.json'] = {
      import: './dist/other-manifest.json',
      default: './dist/manifest.json',
    };
    writeJson(join(staged, 'package.json'), packageJson);
    writeJson(join(staged, 'dist/other-manifest.json'), { version: '1.0.0', objects: {} });
  });

  const result = runReleaseManifestGuards({ packageDir, tarballPath });

  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('packed manifest identity'));
  assert.match(result.logs.join('\n'), /only in the packed package\.json/);
});

test('the guard fails when a declared dependency cannot be installed into the scratch consumer', () => {
  const { packageDir } = createWorkspace();
  const tarballPath = packFixture(packageDir, (staged) => {
    const packageJson = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'));
    packageJson.dependencies = { 'smrt-guard-absent-dependency': '1.0.0' };
    writeJson(join(staged, 'package.json'), packageJson);
  });

  const result = runReleaseManifestGuards({ packageDir, tarballPath });

  assert.equal(result.ok, false);
  assert.ok(result.failures.includes('packed install'));
  assert.match(result.logs.join('\n'), /smrt-guard-absent-dependency is not installed/);
});

test('completeness --release fails closed when the scanner is not built; prepack mode still skips', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'smrt-release-guards-scanner-'));
  directories.add(sandbox);
  // A copy of the verifier whose repository root has no built scanner.
  const copiedVerifier = join(sandbox, 'scripts', 'verify-manifest-completeness.mjs');
  mkdirSync(dirname(copiedVerifier), { recursive: true });
  copyFileSync(join(scriptsDir, 'verify-manifest-completeness.mjs'), copiedVerifier);
  const { packageDir } = createWorkspace();

  const release = spawnSync(
    process.execPath,
    [copiedVerifier, packageDir, '--release'],
    { encoding: 'utf8' },
  );
  assert.equal(release.status, 1);
  assert.match(release.stderr, /release mode requires the manifest completeness check/);

  const prepack = spawnSync(process.execPath, [copiedVerifier, packageDir], {
    encoding: 'utf8',
  });
  assert.equal(prepack.status, 0);
  assert.match(prepack.stderr, /skipping manifest completeness check/);

  assert.ok(existsSync(resolve(scriptsDir, '../packages/scanner/dist/index.js')),
    'the real scanner must be built for the release-validation tests above');
});
