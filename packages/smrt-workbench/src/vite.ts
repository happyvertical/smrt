import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import fg from 'fast-glob';
import { normalizePath, type Plugin } from 'vite';
import {
  buildWorkbenchProject,
  detectWorkbenchMode,
  discoverWorkbenchTargets,
  findWorkspaceRoot,
  resolveWorkbenchScope,
} from './discovery.js';
import type {
  DiscoveredWorkbenchTarget,
  SmrtWorkbenchVitePluginOptions,
} from './types.js';

const VIRTUAL_WORKBENCH_PROJECT_MODULE_ID = 'virtual:smrt-workbench/project';
const RESOLVED_VIRTUAL_WORKBENCH_PROJECT_MODULE_ID = `\0${VIRTUAL_WORKBENCH_PROJECT_MODULE_ID}`;

interface PlaygroundSpecifier {
  packageName?: string;
  specifier: string;
}

function toViteImportSpecifier(specifier: string): string {
  if (!isAbsolute(specifier)) {
    return specifier;
  }

  return `/@fs/${normalizePath(specifier)}`;
}

function targetSpecifier(target: DiscoveredWorkbenchTarget): string | null {
  return (
    target.importSpecifier || target.sourcePath || target.runtimePath || null
  );
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

function exportKeys(exportsField: unknown): string[] {
  if (typeof exportsField === 'string') {
    return ['.'];
  }

  if (
    exportsField &&
    typeof exportsField === 'object' &&
    !Array.isArray(exportsField)
  ) {
    return Object.keys(exportsField).sort();
  }

  return [];
}

function dependencyNames(packageJson: Record<string, unknown>): string[] {
  return Object.keys({
    ...(packageJson.dependencies as Record<string, string> | undefined),
    ...(packageJson.devDependencies as Record<string, string> | undefined),
    ...(packageJson.peerDependencies as Record<string, string> | undefined),
  }).sort();
}

async function discoverWorkspacePlaygroundSpecifiers(
  workspaceRoot: string,
  packageName?: string,
): Promise<PlaygroundSpecifier[]> {
  const matches = await fg('packages/*/src/svelte/playground.ts', {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
  });

  return matches
    .sort()
    .map((sourcePath) => {
      const packageDir = dirname(dirname(dirname(sourcePath)));
      const packageJson = readJson(join(packageDir, 'package.json'));
      return {
        packageName:
          typeof packageJson.name === 'string' ? packageJson.name : undefined,
        specifier: normalizePath(sourcePath),
      };
    })
    .filter((target) =>
      packageName ? target.packageName === packageName : true,
    );
}

async function discoverConsumerPlaygroundSpecifiers(
  projectRoot: string,
  localPlaygroundPath: string,
  packageName?: string,
): Promise<PlaygroundSpecifier[]> {
  const packageJsonPath = resolve(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return [];
  }

  const packageJson = readJson(packageJsonPath);
  const specifiers: PlaygroundSpecifier[] = [];

  for (const dependencyName of dependencyNames(packageJson)) {
    if (
      !dependencyName.startsWith('@happyvertical/smrt-') ||
      dependencyName === '@happyvertical/smrt-playground' ||
      dependencyName === '@happyvertical/smrt-workbench'
    ) {
      continue;
    }

    if (packageName && dependencyName !== packageName) {
      continue;
    }

    const dependencyPackageJsonPath = resolve(
      projectRoot,
      'node_modules',
      dependencyName,
      'package.json',
    );
    if (!existsSync(dependencyPackageJsonPath)) {
      continue;
    }

    const dependencyPackageJson = readJson(dependencyPackageJsonPath);
    if (exportKeys(dependencyPackageJson.exports).includes('./playground')) {
      specifiers.push({
        packageName: dependencyName,
        specifier: `${dependencyName}/playground`,
      });
    }
  }

  const localPlayground = resolve(projectRoot, localPlaygroundPath);
  if (!packageName && existsSync(localPlayground)) {
    specifiers.push({
      specifier: normalizePath(localPlayground),
    });
  }

  return specifiers;
}

function buildVirtualModuleCode(
  projectJson: string,
  workbenchSpecifiers: string[],
  playgroundSpecifiers: string[],
): string {
  const workbenchImports = workbenchSpecifiers
    .map(
      (specifier, index) =>
        `import workbench${index} from ${JSON.stringify(toViteImportSpecifier(specifier))};`,
    )
    .join('\n');
  const playgroundImports = playgroundSpecifiers
    .map(
      (specifier, index) =>
        `import playground${index} from ${JSON.stringify(toViteImportSpecifier(specifier))};`,
    )
    .join('\n');
  const workbenchList = workbenchSpecifiers
    .map((_, index) => `...toModules(workbench${index})`)
    .join(', ');
  const playgroundList = playgroundSpecifiers
    .map((_, index) => `...toModules(playground${index})`)
    .join(', ');

  return `${workbenchImports}
${playgroundImports}

const toModules = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.modules)) return value.modules.filter(Boolean);
  return [value];
};

export const workbenchProject = ${projectJson};
export const workbenchModules = [${workbenchList}].filter(Boolean);
export const playgroundModules = [${playgroundList}].filter(Boolean);
export default { workbenchProject, workbenchModules, playgroundModules };
`;
}

function envValue(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function addWatchFileIfExists(
  context: { addWatchFile(path: string): void },
  path: string,
) {
  if (existsSync(path)) {
    context.addWatchFile(path);
  }
}

export function smrtWorkbenchVitePlugin(
  options: SmrtWorkbenchVitePluginOptions = {},
): Plugin {
  let hostRoot = process.cwd();

  return {
    name: 'smrt-workbench-vite-plugin',
    enforce: 'pre',
    configResolved(config) {
      hostRoot = config.root ? resolve(config.root) : process.cwd();
    },
    resolveId(id) {
      if (id === VIRTUAL_WORKBENCH_PROJECT_MODULE_ID) {
        return RESOLVED_VIRTUAL_WORKBENCH_PROJECT_MODULE_ID;
      }
      return null;
    },
    async load(id) {
      if (id !== RESOLVED_VIRTUAL_WORKBENCH_PROJECT_MODULE_ID) {
        return null;
      }

      const cwd =
        options.cwd || envValue('SMRT_WORKBENCH_CWD') || process.cwd();
      const projectRoot =
        options.projectRoot || envValue('SMRT_WORKBENCH_PROJECT_ROOT') || cwd;
      const packageName =
        options.packageName || envValue('SMRT_WORKBENCH_PACKAGE');
      const scope = resolveWorkbenchScope(cwd, {
        projectRoot,
        workspaceRoot: options.workspaceRoot,
        packageName,
      });
      const effectiveMode =
        options.mode === 'auto' || !options.mode
          ? detectWorkbenchMode(scope.projectRoot)
          : options.mode;
      const project = await buildWorkbenchProject(scope);
      const workbenchTargets = await discoverWorkbenchTargets(
        scope.projectRoot,
        effectiveMode,
        options.localWorkbenchPath || 'src/workbench.ts',
        scope.packageName,
        options.packagesPattern,
      );
      const playgroundTargetSpecifiers =
        effectiveMode === 'workspace'
          ? await discoverWorkspacePlaygroundSpecifiers(
              scope.projectRoot,
              scope.packageName,
            )
          : await discoverConsumerPlaygroundSpecifiers(
              scope.projectRoot,
              options.localPlaygroundPath || 'src/playground.ts',
              scope.packageName,
            );
      const workbenchSpecifiers = workbenchTargets
        .map(targetSpecifier)
        .filter((specifier): specifier is string => Boolean(specifier));
      const playgroundSpecifiers = playgroundTargetSpecifiers.map(
        (target) => target.specifier,
      );

      addWatchFileIfExists(this, resolve(scope.projectRoot, 'package.json'));
      addWatchFileIfExists(
        this,
        resolve(scope.projectRoot, 'pnpm-workspace.yaml'),
      );

      const workspaceRoot =
        options.workspaceRoot || findWorkspaceRoot(scope.projectRoot);
      if (workspaceRoot) {
        addWatchFileIfExists(
          this,
          resolve(workspaceRoot, 'pnpm-workspace.yaml'),
        );
      }

      for (const packageSummary of project.packages) {
        if (packageSummary.directory) {
          addWatchFileIfExists(
            this,
            resolve(packageSummary.directory, 'package.json'),
          );
        }
      }

      for (const specifier of [
        ...workbenchSpecifiers,
        ...playgroundSpecifiers,
      ]) {
        if (isAbsolute(specifier)) {
          this.addWatchFile(specifier);
        }
      }

      return buildVirtualModuleCode(
        JSON.stringify(project),
        workbenchSpecifiers,
        playgroundSpecifiers,
      );
    },
  };
}

export { VIRTUAL_WORKBENCH_PROJECT_MODULE_ID };
