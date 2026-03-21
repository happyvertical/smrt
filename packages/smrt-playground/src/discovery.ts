import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import fg from 'fast-glob';
import { coercePlaygroundModules } from './runtime.js';
import type {
  DiscoveredInstalledPlayground,
  DiscoveredPlaygroundTarget,
  DiscoveredWorkspacePlayground,
  SmrtPlaygroundModule,
} from './types.js';

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

export function detectPlaygroundMode(
  projectRoot = process.cwd(),
): 'workspace' | 'consumer' {
  return findWorkspaceRoot(projectRoot) ? 'workspace' : 'consumer';
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
    const workspaceRoot = findWorkspaceRoot(projectRoot);
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
    input.startsWith('/') || input.startsWith('.')
      ? await import(pathToFileURL(resolve(input)).href)
      : await import(input);

  const module = imported.default ?? imported.playground ?? imported;
  return module && typeof module === 'object'
    ? coercePlaygroundModules(module as SmrtPlaygroundModule)
    : [];
}

export function describePlaygroundSource(
  target: DiscoveredPlaygroundTarget,
  cwd = process.cwd(),
): string {
  if (target.source === 'package') {
    return target.importSpecifier || target.packageName || 'package';
  }

  const path = target.sourcePath || target.runtimePath;
  return path ? relative(cwd, path) || '.' : target.source;
}
