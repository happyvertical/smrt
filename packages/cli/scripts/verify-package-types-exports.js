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
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse } from 'acorn';

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

function escapeRegex(source) {
  return source.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function archiveHasPath(archiveEntries, relativePath) {
  const archivePath = `package/${relativePath}`;

  if (!archivePath.includes('*')) {
    return archiveEntries.has(archivePath);
  }

  const pattern = new RegExp(
    `^${escapeRegex(archivePath).replaceAll('*', '.+')}$`,
  );

  return [...archiveEntries].some((entry) => pattern.test(entry));
}

function _walkFiles(rootDir) {
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

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function getPathStem(filePath) {
  return filePath.replace(
    /\.(?:d\.(?:cts|mts|ts)|[cm]?ts|[cm]?js|svelte)$/,
    '',
  );
}

function isRuntimeSourceFile(filePath) {
  return /\.(?:[cm]?js|svelte)$/.test(filePath);
}

function isTypeSourceFile(filePath) {
  return /\.d\.(?:cts|mts|ts)$/.test(filePath);
}

function resolveRuntimeCandidates(basePath) {
  const stems = new Set([basePath, getPathStem(basePath)]);
  const candidates = new Set();

  for (const stem of stems) {
    candidates.add(stem);
    candidates.add(`${stem}.js`);
    candidates.add(`${stem}.mjs`);
    candidates.add(`${stem}.cjs`);
    candidates.add(`${stem}.svelte`);
    candidates.add(join(stem, 'index.js'));
    candidates.add(join(stem, 'index.mjs'));
    candidates.add(join(stem, 'index.cjs'));
    candidates.add(join(stem, 'index.svelte'));
  }

  return [...candidates];
}

function resolveTypeCandidates(basePath) {
  const stems = new Set([basePath, getPathStem(basePath)]);
  const candidates = new Set();

  for (const stem of stems) {
    candidates.add(stem);
    candidates.add(`${stem}.d.ts`);
    candidates.add(`${stem}.d.mts`);
    candidates.add(`${stem}.d.cts`);
    candidates.add(`${stem}.ts`);
    candidates.add(`${stem}.mts`);
    candidates.add(`${stem}.cts`);
    candidates.add(`${stem}.js`);
    candidates.add(`${stem}.mjs`);
    candidates.add(`${stem}.cjs`);
    candidates.add(`${stem}.svelte`);
    candidates.add(`${stem}.svelte.d.ts`);
    candidates.add(join(stem, 'index.d.ts'));
    candidates.add(join(stem, 'index.d.mts'));
    candidates.add(join(stem, 'index.d.cts'));
    candidates.add(join(stem, 'index.ts'));
    candidates.add(join(stem, 'index.mts'));
    candidates.add(join(stem, 'index.cts'));
    candidates.add(join(stem, 'index.js'));
    candidates.add(join(stem, 'index.mjs'));
    candidates.add(join(stem, 'index.cjs'));
    candidates.add(join(stem, 'index.svelte'));
    candidates.add(join(stem, 'index.svelte.d.ts'));
  }

  return [...candidates];
}

function isWithinPackageRoot(packageRoot, targetPath) {
  const relativePath = relative(packageRoot, targetPath);
  return (
    targetPath === packageRoot ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      relativePath !== '')
  );
}

function findExistingPackageCandidate(
  packageRoot,
  basePath,
  candidateResolver,
  predicate = () => true,
) {
  for (const candidate of candidateResolver(basePath)) {
    if (
      isWithinPackageRoot(packageRoot, candidate) &&
      existsSync(candidate) &&
      predicate(candidate)
    ) {
      return candidate;
    }
  }

  return null;
}

function collectPackageEntryFiles(
  packageRoot,
  exportPaths,
  candidateResolver,
  predicate,
) {
  const entryFiles = [];
  const seen = new Set();

  for (const exportPath of exportPaths) {
    if (exportPath.includes('*')) {
      continue;
    }

    const resolved = findExistingPackageCandidate(
      packageRoot,
      resolve(packageRoot, exportPath),
      candidateResolver,
      predicate,
    );

    if (!resolved || seen.has(resolved)) {
      continue;
    }

    seen.add(resolved);
    entryFiles.push(resolved);
  }

  return entryFiles;
}

function collectRelativeEsmSpecifiers(source) {
  const program = parse(source, {
    ecmaVersion: 'latest',
    sourceType: 'module',
  });
  const specifiers = [];
  const pending = [program];

  while (pending.length > 0) {
    const current = pending.pop();

    if (!current || typeof current !== 'object') {
      continue;
    }

    switch (current.type) {
      case 'ImportDeclaration':
      case 'ExportAllDeclaration':
      case 'ExportNamedDeclaration': {
        const specifier = current.source?.value;
        if (typeof specifier === 'string' && specifier.startsWith('.')) {
          specifiers.push(specifier);
        }
        break;
      }
      case 'ImportExpression': {
        const specifier = current.source?.value;
        if (typeof specifier === 'string' && specifier.startsWith('.')) {
          specifiers.push(specifier);
        }
        break;
      }
      default:
        break;
    }

    for (const value of Object.values(current)) {
      if (!value || typeof value !== 'object') {
        continue;
      }

      if (Array.isArray(value)) {
        for (const entry of value) {
          pending.push(entry);
        }
        continue;
      }

      pending.push(value);
    }
  }

  return specifiers;
}

function collectMissingRelativeRuntimeImports(packageRoot, runtimeEntryFiles) {
  const missing = [];
  const importPattern =
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g;
  const pending = [...runtimeEntryFiles];
  const scanned = new Set();

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || scanned.has(filePath)) {
      continue;
    }

    scanned.add(filePath);
    const rawSource = readFileSync(filePath, 'utf8');
    const source = filePath.endsWith('.svelte')
      ? stripComments(rawSource)
      : rawSource;
    const specifiers = filePath.endsWith('.svelte')
      ? [...source.matchAll(importPattern)]
          .map((match) => {
            const specifier = match[1] || match[2];
            const fullMatch = match[0] ?? '';
            const isTypeOnlyImport =
              /^\s*(?:import|export)\s+type\b/.test(fullMatch) ||
              /^\s*import\s*\{\s*type\b/.test(fullMatch);

            if (typeof specifier !== 'string' || !specifier.startsWith('.')) {
              return null;
            }

            return {
              specifier,
              isTypeOnlyImport,
            };
          })
          .filter(Boolean)
      : collectRelativeEsmSpecifiers(source).map((specifier) => ({
          specifier,
          isTypeOnlyImport: false,
        }));
    const seenSpecifiers = new Set();

    for (const entry of specifiers) {
      if (!entry) {
        continue;
      }

      const key = `${entry.specifier}:${entry.isTypeOnlyImport ? 'type' : 'runtime'}`;
      if (seenSpecifiers.has(key)) {
        continue;
      }
      seenSpecifiers.add(key);

      const specifier = entry.specifier;
      const basePath = resolve(dirname(filePath), specifier);
      if (!isWithinPackageRoot(packageRoot, basePath)) {
        missing.push(
          `${filePath.replace(`${packageRoot}/`, '')} -> ${specifier}`,
        );
        continue;
      }
      const candidateResolver = entry.isTypeOnlyImport
        ? resolveTypeCandidates
        : resolveRuntimeCandidates;
      const targetPath = findExistingPackageCandidate(
        packageRoot,
        basePath,
        candidateResolver,
      );

      if (!targetPath) {
        missing.push(
          `${filePath.replace(`${packageRoot}/`, '')} -> ${specifier}`,
        );
        continue;
      }

      if (!entry.isTypeOnlyImport && isRuntimeSourceFile(targetPath)) {
        pending.push(targetPath);
      }
    }
  }

  return missing;
}

function collectMissingTypeImports(packageRoot, typeEntryFiles) {
  const missing = [];
  const importPattern =
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)/g;
  const pending = [...typeEntryFiles];
  const scanned = new Set();

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || scanned.has(filePath)) {
      continue;
    }

    scanned.add(filePath);
    const source = stripComments(readFileSync(filePath, 'utf8'));
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
      if (!isWithinPackageRoot(packageRoot, basePath)) {
        missing.push(
          `${filePath.replace(`${packageRoot}/`, '')} -> ${specifier}`,
        );
        continue;
      }
      const targetPath = findExistingPackageCandidate(
        packageRoot,
        basePath,
        resolveTypeCandidates,
      );

      if (!targetPath) {
        missing.push(
          `${filePath.replace(`${packageRoot}/`, '')} -> ${specifier}`,
        );
        continue;
      }

      if (isTypeSourceFile(targetPath)) {
        pending.push(targetPath);
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
    (typePath) => !archiveHasPath(archiveEntries, typePath),
  );

  const missingRuntime = runtimePaths.filter(
    (runtimePath) => !archiveHasPath(archiveEntries, runtimePath),
  );

  run('tar', ['-xf', tarballPath, '-C', tempDir]);
  const packageRoot = join(tempDir, 'package');
  const runtimeEntryFiles = collectPackageEntryFiles(
    packageRoot,
    runtimePaths,
    resolveRuntimeCandidates,
    isRuntimeSourceFile,
  );
  const typeEntryFiles = collectPackageEntryFiles(
    packageRoot,
    typePaths,
    resolveTypeCandidates,
    isTypeSourceFile,
  );
  const missingRelativeRuntimeImports = collectMissingRelativeRuntimeImports(
    packageRoot,
    runtimeEntryFiles,
  );
  const missingTypeImports = collectMissingTypeImports(
    packageRoot,
    typeEntryFiles,
  );

  if (
    missing.length > 0 ||
    missingRuntime.length > 0 ||
    missingRelativeRuntimeImports.length > 0 ||
    missingTypeImports.length > 0
  ) {
    fail(
      `${packageJson.name} is missing required package artifacts in the packed artifact:\n${[
        ...missing.map((typePath) => `- types: ${typePath}`),
        ...missingRuntime.map((runtimePath) => `- runtime: ${runtimePath}`),
        ...missingRelativeRuntimeImports.map(
          (entry) => `- relative import target: ${entry}`,
        ),
        ...missingTypeImports.map((entry) => `- type import target: ${entry}`),
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
