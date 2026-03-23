#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function fail(message) {
  throw new Error(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  if (result.error) {
    fail(`Failed to run ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    fail(
      `${command} ${args.join(' ')} exited with code ${result.status}${
        stderr ? `\n${stderr}` : ''
      }`,
    );
  }

  return result.stdout;
}

function collectTypePaths(packageJson) {
  const typePaths = new Set();

  if (typeof packageJson.types === 'string') {
    typePaths.add(packageJson.types);
  }

  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'types' && typeof child === 'string') {
        typePaths.add(child);
        continue;
      }

      visit(child);
    }
  };

  visit(packageJson.exports);

  return [...typePaths].map((filePath) => filePath.replace(/^\.\//, ''));
}

function collectRuntimePaths(packageJson) {
  const runtimePaths = new Set();

  const addPath = (filePath) => {
    if (typeof filePath === 'string') {
      runtimePaths.add(filePath.replace(/^\.\//, ''));
    }
  };

  if (typeof packageJson.main === 'string') {
    addPath(packageJson.main);
  }

  if (typeof packageJson.module === 'string') {
    addPath(packageJson.module);
  }

  if (typeof packageJson.svelte === 'string') {
    addPath(packageJson.svelte);
  }

  const visit = (value, currentKey) => {
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && currentKey !== 'types') {
        addPath(value);
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, currentKey);
      }
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      visit(child, key);
    }
  };

  visit(packageJson.exports);

  return [...runtimePaths];
}

function walkFiles(rootDir) {
  const pending = [rootDir];
  const files = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current)) {
      const entryPath = join(current, entry);
      const stats = statSync(entryPath);

      if (stats.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      files.push(entryPath);
    }
  }

  return files;
}

function collectMissingRelativeRuntimeImports(packageRoot) {
  const missing = [];
  const runtimeFiles = walkFiles(packageRoot).filter((filePath) =>
    /\.(?:[cm]?js|svelte)$/.test(filePath),
  );
  const importPattern =
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g;

  const resolveCandidates = (basePath) => [
    basePath,
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
    `${basePath}.svelte`,
    join(basePath, 'index.js'),
    join(basePath, 'index.mjs'),
    join(basePath, 'index.cjs'),
    join(basePath, 'index.svelte'),
  ];

  for (const filePath of runtimeFiles) {
    const source = readFileSync(filePath, 'utf8');
    const seenSpecifiers = new Set();

    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] || match[2];
      if (!specifier || !specifier.startsWith('.')) {
        continue;
      }

      if (seenSpecifiers.has(specifier)) {
        continue;
      }
      seenSpecifiers.add(specifier);

      const basePath = resolve(dirname(filePath), specifier);
      const hasTarget = resolveCandidates(basePath).some((candidate) =>
        existsSync(candidate),
      );

      if (!hasTarget) {
        missing.push(
          `${filePath.replace(`${packageRoot}/`, '')} -> ${specifier}`,
        );
      }
    }
  }

  return missing;
}

const packageDir = resolve(process.cwd(), process.argv[2] ?? '.');
const packageJsonPath = join(packageDir, 'package.json');
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
const typePaths = collectTypePaths(packageJson);
const runtimePaths = collectRuntimePaths(packageJson);
const npmConfigDryRunKey = 'npm_config_dry_run';
const npmConfigDryRunUpperKey = 'NPM_CONFIG_DRY_RUN';

if (typePaths.length === 0 && runtimePaths.length === 0) {
  console.log(
    `ℹ️ No exported pack verification paths declared for ${packageJson.name}`,
  );
  process.exit(0);
}

const tempDir = mkdtempSync(join(tmpdir(), 'smrt-pack-'));

try {
  const packOutput = run(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', tempDir],
    {
      cwd: packageDir,
      env: {
        ...process.env,
        [npmConfigDryRunKey]: 'false',
        [npmConfigDryRunUpperKey]: 'false',
      },
    },
  );
  const packResult = JSON.parse(packOutput);
  const tarballName = packResult[0]?.filename;

  if (!tarballName) {
    fail(`npm pack did not return a tarball filename for ${packageJson.name}`);
  }

  const tarballPath = join(tempDir, tarballName);
  const archiveListing = run('tar', ['-tf', tarballPath]);
  const archiveEntries = new Set(
    archiveListing
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );

  const missing = typePaths.filter(
    (typePath) => !archiveEntries.has(`package/${typePath}`),
  );

  const missingRuntime = runtimePaths.filter(
    (runtimePath) => !archiveEntries.has(`package/${runtimePath}`),
  );

  run('tar', ['-xf', tarballPath, '-C', tempDir]);
  const packageRoot = join(tempDir, 'package');
  const missingRelativeRuntimeImports =
    collectMissingRelativeRuntimeImports(packageRoot);

  if (
    missing.length > 0 ||
    missingRuntime.length > 0 ||
    missingRelativeRuntimeImports.length > 0
  ) {
    fail(
      `${packageJson.name} is missing required package artifacts in the packed artifact:\n${[
        ...missing.map((typePath) => `- types: ${typePath}`),
        ...missingRuntime.map((runtimePath) => `- runtime: ${runtimePath}`),
        ...missingRelativeRuntimeImports.map(
          (entry) => `- relative import target: ${entry}`,
        ),
      ].join('\n')}`,
    );
  }

  console.log(
    `✅ Verified packed exports for ${packageJson.name}: ${[
      ...typePaths.map((typePath) => `types=${typePath}`),
      ...runtimePaths.map((runtimePath) => `runtime=${runtimePath}`),
    ].join(', ')}`,
  );
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
