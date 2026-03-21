import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import fg from 'fast-glob';
import { normalizePath, type Plugin } from 'vite';
import {
  detectPlaygroundMode,
  discoverInstalledPlaygrounds,
  findWorkspaceRoot,
} from './discovery.js';
import type { SmrtPlaygroundVitePluginOptions } from './types.js';

const VIRTUAL_PLAYGROUND_MODULE_ID = 'virtual:smrt-playground/modules';
const RESOLVED_VIRTUAL_PLAYGROUND_MODULE_ID = `\0${VIRTUAL_PLAYGROUND_MODULE_ID}`;

function toViteImportSpecifier(specifier: string): string {
  if (!isAbsolute(specifier)) {
    return specifier;
  }

  return `/@fs/${normalizePath(specifier)}`;
}

function buildVirtualModuleCode(specifiers: string[]): string {
  const imports = specifiers
    .map(
      (specifier, index) =>
        `import module${index} from ${JSON.stringify(toViteImportSpecifier(specifier))};`,
    )
    .join('\n');

  const moduleList = specifiers
    .map((_, index) => `...toModules(module${index})`)
    .join(', ');

  return `${imports}

const toModules = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (Array.isArray(value.modules)) return value.modules.filter(Boolean);
  return [value];
};

export const playgroundModules = [${moduleList}].filter(Boolean);
export default playgroundModules;
`;
}

async function discoverWorkspaceSpecifiers(
  projectRoot: string,
  options: SmrtPlaygroundVitePluginOptions,
): Promise<string[]> {
  const workspaceRoot = options.workspaceRoot || findWorkspaceRoot(projectRoot);
  if (!workspaceRoot) {
    return [];
  }

  const matches = await fg(
    options.packagesPattern || 'packages/*/src/svelte/playground.ts',
    {
      cwd: workspaceRoot,
      absolute: true,
    },
  );

  return matches.sort().map((path) => normalizePath(path));
}

async function discoverConsumerSpecifiers(
  projectRoot: string,
  options: SmrtPlaygroundVitePluginOptions,
): Promise<string[]> {
  const installed = await discoverInstalledPlaygrounds(projectRoot);
  const specifiers = installed.map((item) => item.importSpecifier);
  const localPlayground = resolve(
    projectRoot,
    options.localPlaygroundPath || 'src/playground.ts',
  );

  if (existsSync(localPlayground)) {
    specifiers.push(normalizePath(localPlayground));
  }

  return specifiers;
}

export function smrtPlaygroundVitePlugin(
  options: SmrtPlaygroundVitePluginOptions = {},
): Plugin {
  let projectRoot = process.cwd();

  return {
    name: 'smrt-playground-vite-plugin',
    enforce: 'pre',
    configResolved(config) {
      projectRoot = config.root ? resolve(config.root) : process.cwd();
    },
    resolveId(id) {
      if (id === VIRTUAL_PLAYGROUND_MODULE_ID) {
        return RESOLVED_VIRTUAL_PLAYGROUND_MODULE_ID;
      }
      return null;
    },
    async load(id) {
      if (id !== RESOLVED_VIRTUAL_PLAYGROUND_MODULE_ID) {
        return null;
      }

      const effectiveMode =
        options.mode === 'auto' || !options.mode
          ? detectPlaygroundMode(projectRoot)
          : options.mode;

      const specifiers =
        effectiveMode === 'workspace'
          ? await discoverWorkspaceSpecifiers(projectRoot, options)
          : await discoverConsumerSpecifiers(projectRoot, options);

      if (effectiveMode === 'workspace') {
        const workspaceRoot =
          options.workspaceRoot || findWorkspaceRoot(projectRoot);
        if (workspaceRoot) {
          const workspaceConfigPath = resolve(
            workspaceRoot,
            'pnpm-workspace.yaml',
          );
          if (existsSync(workspaceConfigPath)) {
            this.addWatchFile(workspaceConfigPath);
          }
        }
      } else {
        const packageJsonPath = resolve(projectRoot, 'package.json');
        if (existsSync(packageJsonPath)) {
          this.addWatchFile(packageJsonPath);
        }
        const localPlayground = resolve(
          projectRoot,
          options.localPlaygroundPath || 'src/playground.ts',
        );
        if (existsSync(localPlayground)) {
          this.addWatchFile(localPlayground);
        }
      }

      for (const specifier of specifiers) {
        if (isAbsolute(specifier)) {
          this.addWatchFile(specifier);
        }
      }

      return buildVirtualModuleCode(specifiers);
    },
  };
}

export { VIRTUAL_PLAYGROUND_MODULE_ID };
