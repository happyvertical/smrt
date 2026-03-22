import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import fg from 'fast-glob';
import { coercePlaygroundModules } from './runtime.js';
import type {
  DiscoveredInstalledPlayground,
  DiscoveredPlaygroundTarget,
  DiscoveredWorkspacePlayground,
  SmrtPlaygroundModule,
} from './types.js';

const require = createRequire(import.meta.url);
const TS_SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

export function findWorkspaceRoot(startDir = process.cwd()): string | null {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function findSmrtWorkspaceRoot(startDir = process.cwd()): string | null {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (!workspaceRoot) {
    return null;
  }

  const hostPackageJsonPath = join(
    workspaceRoot,
    'packages',
    'smrt-playground',
    'host',
    'package.json',
  );

  return existsSync(hostPackageJsonPath) ? workspaceRoot : null;
}

export function detectPlaygroundMode(
  projectRoot = process.cwd(),
): 'workspace' | 'consumer' {
  return findSmrtWorkspaceRoot(projectRoot) ? 'workspace' : 'consumer';
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function resolveNodeModulePackageDir(
  projectRoot: string,
  packageName: string,
): string | null {
  const packageJsonPath = join(
    projectRoot,
    'node_modules',
    packageName,
    'package.json',
  );
  return existsSync(packageJsonPath) ? dirname(packageJsonPath) : null;
}

export async function discoverWorkspacePlaygrounds(
  workspaceRoot: string,
  packagesPattern = 'packages/*/src/svelte/playground.ts',
): Promise<DiscoveredWorkspacePlayground[]> {
  const matches = await fg(packagesPattern, {
    cwd: workspaceRoot,
    absolute: true,
  });

  const discovered: DiscoveredWorkspacePlayground[] = [];

  for (const sourcePath of matches.sort()) {
    const packageDir = dirname(dirname(dirname(sourcePath)));
    const packageJsonPath = join(packageDir, 'package.json');

    if (!existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = readJson(packageJsonPath);
    const runtimePath = join(packageDir, 'dist', 'playground.js');

    discovered.push({
      packageName: packageJson.name,
      packageDir,
      sourcePath,
      runtimePath: existsSync(runtimePath) ? runtimePath : null,
    });
  }

  return discovered;
}

export async function discoverInstalledPlaygrounds(
  projectRoot = process.cwd(),
): Promise<DiscoveredInstalledPlayground[]> {
  const packageJsonPath = join(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  const packageJson = readJson(packageJsonPath);
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  };

  const discovered: DiscoveredInstalledPlayground[] = [];

  for (const dependencyName of Object.keys(dependencies).sort()) {
    if (
      !dependencyName.startsWith('@happyvertical/smrt-') ||
      dependencyName === '@happyvertical/smrt-playground'
    ) {
      continue;
    }

    const packageDir = resolveNodeModulePackageDir(projectRoot, dependencyName);
    if (!packageDir) {
      continue;
    }

    const dependencyPackageJson = readJson(join(packageDir, 'package.json'));
    if (dependencyPackageJson.exports?.['./playground']) {
      discovered.push({
        packageName: dependencyName,
        importSpecifier: `${dependencyName}/playground`,
      });
    }
  }

  return discovered;
}

export async function discoverPlaygroundTargets(
  projectRoot = process.cwd(),
  mode: 'auto' | 'workspace' | 'consumer' = 'auto',
  localPlaygroundPath = 'src/playground.ts',
): Promise<DiscoveredPlaygroundTarget[]> {
  const effectiveMode =
    mode === 'auto' ? detectPlaygroundMode(projectRoot) : mode;

  if (effectiveMode === 'workspace') {
    const workspaceRoot =
      mode === 'workspace'
        ? findWorkspaceRoot(projectRoot)
        : findSmrtWorkspaceRoot(projectRoot);
    if (!workspaceRoot) {
      return [];
    }

    const packages = await discoverWorkspacePlaygrounds(workspaceRoot);
    return packages.map((item) => ({
      packageName: item.packageName,
      source: 'workspace' as const,
      sourcePath: item.sourcePath,
      runtimePath: item.runtimePath ?? undefined,
    }));
  }

  const targets: DiscoveredPlaygroundTarget[] = [];
  const installed = await discoverInstalledPlaygrounds(projectRoot);

  for (const item of installed) {
    targets.push({
      packageName: item.packageName,
      source: 'package',
      importSpecifier: item.importSpecifier,
    });
  }

  const localPath = resolve(projectRoot, localPlaygroundPath);
  if (existsSync(localPath)) {
    targets.push({
      source: 'app',
      sourcePath: localPath,
    });
  }

  return targets;
}

export async function importPlaygroundModule(
  input: string,
): Promise<SmrtPlaygroundModule[]> {
  const imported =
    isAbsolute(input) || input.startsWith('.')
      ? await importPathModule(resolve(input))
      : await import(input);

  const module = imported.default ?? imported.playground ?? imported;
  return module && typeof module === 'object'
    ? coercePlaygroundModules(module as SmrtPlaygroundModule)
    : [];
}

async function importPathModule(inputPath: string): Promise<unknown> {
  if (!TS_SOURCE_EXTENSIONS.has(extname(inputPath))) {
    return import(pathToFileURL(inputPath).href);
  }

  let tsxApiPath: string;
  try {
    tsxApiPath = require.resolve('tsx/esm/api');
  } catch (tsxError) {
    throw new Error(
      `Failed to load playground module from ${inputPath}: source playground discovery requires the "tsx" package.`,
      { cause: tsxError },
    );
  }

  const { tsImport } = await import(pathToFileURL(tsxApiPath).href);
  return tsImport(pathToFileURL(inputPath).href, {
    parentURL: import.meta.url,
  });
}

export function describePlaygroundSource(
  target: DiscoveredPlaygroundTarget,
  cwd = process.cwd(),
): string {
  if (target.source === 'package') {
    return target.importSpecifier || target.packageName || 'installed package';
  }

  const path = target.sourcePath || target.runtimePath;
  return path ? relative(cwd, path) || '.' : target.source;
}
