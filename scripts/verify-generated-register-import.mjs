#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readOptionValue(flagName) {
  const args = process.argv.slice(2);
  const index = args.indexOf(flagName);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith('-')) {
    fail(`Missing ${flagName}`);
  }
  return args[index + 1];
}

function resolveExportTarget(target) {
  if (typeof target === 'string') return target;
  if (!target || typeof target !== 'object') return undefined;

  for (const condition of ['import', 'default', 'node']) {
    const resolved = resolveExportTarget(target[condition]);
    if (resolved) return resolved;
  }
  return undefined;
}

function commandFailure(result) {
  return [result.stdout, result.stderr]
    .filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.trim())
    .join('\n');
}

const repoRoot = process.cwd();
const packageDir = resolve(readOptionValue('--package-dir'));
const tarballPath = resolve(readOptionValue('--tarball'));
const sourcePackageJson = JSON.parse(
  readFileSync(join(packageDir, 'package.json'), 'utf8'),
);
const packageName = sourcePackageJson.name;
const cliEntry = join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

if (!packageName) fail(`Package at ${packageDir} has no name`);
if (!existsSync(tarballPath)) fail(`Tarball not found: ${tarballPath}`);
if (!existsSync(cliEntry)) {
  fail(`Built CLI entry not found: ${cliEntry}`);
}

const consumerDir = mkdtempSync(join(tmpdir(), 'smrt-register-pack-'));
const cleanup = () => rmSync(consumerDir, { recursive: true, force: true });
process.once('exit', cleanup);

try {
  const installedPackageDir = join(
    consumerDir,
    'node_modules',
    ...packageName.split('/'),
  );
  mkdirSync(installedPackageDir, { recursive: true });

  const extractResult = spawnSync(
    'tar',
    [
      '-xzf',
      tarballPath,
      '--strip-components=1',
      '-C',
      installedPackageDir,
    ],
    { encoding: 'utf8', env: process.env },
  );
  if (extractResult.error || extractResult.status !== 0) {
    fail(
      `Failed to extract ${packageName}: ${extractResult.error?.message ?? commandFailure(extractResult)}`,
    );
  }

  writeFileSync(
    join(consumerDir, 'package.json'),
    `${JSON.stringify({ name: 'smrt-release-pack-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );

  const packedPackageJson = JSON.parse(
    readFileSync(join(installedPackageDir, 'package.json'), 'utf8'),
  );
  const dependencyNames = new Set([
    ...Object.keys(packedPackageJson.dependencies ?? {}),
    ...Object.keys(packedPackageJson.optionalDependencies ?? {}),
    ...Object.keys(packedPackageJson.peerDependencies ?? {}),
  ]);
  for (const dependencyName of dependencyNames) {
    const sourceDependencyDir = join(
      packageDir,
      'node_modules',
      ...dependencyName.split('/'),
    );
    if (!existsSync(sourceDependencyDir)) {
      fail(
        `Installed workspace dependency unavailable for ${packageName}: ${dependencyName}`,
      );
    }
    const consumerDependencyDir = join(
      consumerDir,
      'node_modules',
      ...dependencyName.split('/'),
    );
    mkdirSync(resolve(consumerDependencyDir, '..'), { recursive: true });
    symlinkSync(realpathSync(sourceDependencyDir), consumerDependencyDir, 'dir');
  }

  const manifestTarget =
    resolveExportTarget(packedPackageJson.exports?.['./manifest']) ??
    resolveExportTarget(packedPackageJson.exports?.['./manifest.json']);
  if (!manifestTarget) {
    fail(`${packageName} does not publish a manifest export`);
  }
  const manifest = JSON.parse(
    readFileSync(join(installedPackageDir, manifestTarget), 'utf8'),
  );
  const expectedRootExports = new Set();
  for (const [objectName, definition] of Object.entries(
    manifest.objects ?? {},
  )) {
    if (definition.visibility === 'test') continue;
    expectedRootExports.add(
      definition.exportName ?? definition.name ?? objectName,
    );
    if (definition.hasCollection && definition.collectionExportName) {
      expectedRootExports.add(definition.collectionExportName);
    }
  }
  if (expectedRootExports.size === 0) {
    fail(`${packageName} manifest has no public exports`);
  }

  const rootTarget = resolveExportTarget(packedPackageJson.exports?.['.']);
  if (!rootTarget) {
    fail(`${packageName} does not publish a root import`);
  }
  const packedRoot = await import(
    pathToFileURL(join(installedPackageDir, rootTarget)).href
  );
  const missingRootExports = [...expectedRootExports]
    .filter((exportName) => !(exportName in packedRoot))
    .sort();
  if (missingRootExports.length > 0) {
    fail(
      `Packed root for ${packageName} omits manifest exports: ${missingRootExports.join(', ')}`,
    );
  }

  const generateResult = spawnSync(
    process.execPath,
    [cliEntry, 'generate-register', '--output-path', '.smrt/register.js'],
    {
      cwd: consumerDir,
      encoding: 'utf8',
      env: process.env,
    },
  );
  if (generateResult.error || generateResult.status !== 0) {
    fail(
      `Failed to generate consumer registration for ${packageName}: ${generateResult.error?.message ?? commandFailure(generateResult)}`,
    );
  }

  const registerPath = join(consumerDir, '.smrt', 'register.js');
  if (!existsSync(registerPath)) {
    fail(`CLI did not generate ${registerPath}`);
  }

  const registerSource = readFileSync(registerPath, 'utf8');
  const generatedImports = new Set();
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of registerSource.matchAll(importPattern)) {
    if (match[2] !== packageName) continue;
    for (const importedName of match[1].split(',')) {
      generatedImports.add(
        importedName.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0],
      );
    }
  }

  if (generatedImports.size === 0) {
    fail(`Generated registration did not import ${packageName}`);
  }

  const importResult = spawnSync(process.execPath, [registerPath], {
    cwd: consumerDir,
    encoding: 'utf8',
    env: process.env,
  });
  if (importResult.error || importResult.status !== 0) {
    fail(
      `Generated consumer registration could not import ${packageName} from its packed artifact:\n${importResult.error?.message ?? commandFailure(importResult)}`,
    );
  }

  console.log(
    `✅ Verified ${expectedRootExports.size} packed manifest exports and imported generated consumer registration for ${packageName} (${generatedImports.size} imports)`,
  );
} finally {
  process.removeListener('exit', cleanup);
  cleanup();
}
