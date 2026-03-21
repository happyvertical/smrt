/**
 * Playground Commands
 *
 * Shared SMRT playground scaffolding, discovery, and host runtime helpers.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  createAppPlaygroundRouteTemplate,
  createAppPlaygroundTemplate,
  createPackagePlaygroundTemplate,
  describePlaygroundSource,
  detectPlaygroundMode,
  discoverPlaygroundTargets,
  findWorkspaceRoot,
  importPlaygroundModule,
} from '@happyvertical/smrt-playground';
import type { CLICommand } from '../cli-generator.js';

type PlaygroundTarget = 'package' | 'app';

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeFileIfAllowed(
  path: string,
  content: string,
  force: boolean,
): 'created' | 'updated' | 'skipped' {
  const existed = existsSync(path);
  if (existed && !force) {
    return 'skipped';
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return existed ? 'updated' : 'created';
}

function detectInitTarget(projectRoot: string): PlaygroundTarget {
  const packageJsonPath = resolve(projectRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return 'app';
  }

  const packageJson = readJson(packageJsonPath);
  const isSmrtPackage =
    typeof packageJson.name === 'string' &&
    packageJson.name.startsWith('@happyvertical/smrt-') &&
    existsSync(resolve(projectRoot, 'src/svelte'));

  return isSmrtPackage ? 'package' : 'app';
}

function detectPackageManager(projectRoot: string): 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(resolve(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(resolve(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function addPlaygroundDependency(projectRoot: string) {
  const packageJsonPath = resolve(projectRoot, 'package.json');
  const packageJson = readJson(packageJsonPath);
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  const cliPackageJsonPath = resolve(__dirname, '../../package.json');
  const cliVersion = readJson(cliPackageJsonPath).version;
  const version =
    workspaceRoot && projectRoot.startsWith(workspaceRoot)
      ? 'workspace:*'
      : `^${cliVersion}`;

  packageJson.dependencies = packageJson.dependencies || {};

  if (!packageJson.dependencies['@happyvertical/smrt-playground']) {
    packageJson.dependencies['@happyvertical/smrt-playground'] = version;
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function ensurePlaygroundPlugin(viteConfigPath: string): boolean {
  let source = readFileSync(viteConfigPath, 'utf-8');
  if (source.includes('smrtPlaygroundVitePlugin')) {
    return false;
  }

  const importLine =
    "import { smrtPlaygroundVitePlugin } from '@happyvertical/smrt-playground/vite';";

  if (source.includes("from '@sveltejs/kit/vite'")) {
    source = source.replace(
      /import\s+\{[^}]*\}\s+from\s+'@sveltejs\/kit\/vite';/,
      (match) => `${match}\n${importLine}`,
    );
  } else {
    source = `${importLine}\n${source}`;
  }

  if (!source.includes('plugins: [')) {
    return false;
  }

  source = source.replace(
    'plugins: [',
    'plugins: [smrtPlaygroundVitePlugin(), ',
  );
  writeFileSync(viteConfigPath, source);
  return true;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? 1}`));
    });
  });
}

async function listDiscoveredPlaygrounds(projectRoot: string) {
  const targets = await discoverPlaygroundTargets(projectRoot, 'auto');
  if (targets.length === 0) {
    console.log('No playground modules discovered.');
    return;
  }

  const mode = detectPlaygroundMode(projectRoot);
  console.log(
    `\nDiscovered ${targets.length} playground target(s) in ${mode} mode:\n`,
  );

  for (const target of targets) {
    console.log(`• ${target.packageName || 'local app'} (${target.source})`);
    console.log(`  Source: ${describePlaygroundSource(target, projectRoot)}`);

    const loadTarget =
      target.importSpecifier || target.runtimePath || target.sourcePath;

    if (!loadTarget) {
      console.log('  Entries: unavailable\n');
      continue;
    }

    try {
      const modules = await importPlaygroundModule(loadTarget);
      if (modules.length === 0) {
        console.log('  Entries: unavailable\n');
        continue;
      }

      for (const module of modules) {
        const showModuleLabel =
          modules.length > 1 || module.packageName !== target.packageName;

        if (showModuleLabel) {
          console.log(`  Module: ${module.packageName}`);
        }

        for (const entry of module.entries || []) {
          const modes = entry.modes
            ? Object.keys(entry.modes).join(', ')
            : 'mock';
          console.log(`  - ${entry.id}: ${entry.title} [${modes}]`);
        }
      }
      console.log();
    } catch {
      console.log(
        '  Entries: unavailable (build the package or run through Vite)',
      );
      console.log();
    }
  }
}

export const playgroundCommands: Record<string, CLICommand> = {
  'playground:init': {
    name: 'playground:init',
    description: 'Scaffold package or app playground support',
    args: [],
    options: {
      target: {
        type: 'string',
        description: 'Override target type (package|app)',
      },
      force: {
        type: 'boolean',
        description: 'Overwrite existing scaffold files',
        default: false,
        short: 'f',
      },
    },
    handler: async (_args: string[], options: any) => {
      const projectRoot = process.cwd();
      const packageJsonPath = resolve(projectRoot, 'package.json');

      if (!existsSync(packageJsonPath)) {
        throw new Error('No package.json found in the current directory');
      }

      const packageJson = readJson(packageJsonPath);
      const target =
        (options.target as PlaygroundTarget | undefined) ||
        detectInitTarget(projectRoot);
      const force = Boolean(options.force);
      const created: string[] = [];
      const skipped: string[] = [];

      if (target === 'package') {
        const packagePlaygroundPath = resolve(
          projectRoot,
          'src/svelte/playground.ts',
        );
        const packageEntryBridgePath = resolve(
          projectRoot,
          'src/playground.ts',
        );

        const packageResult = writeFileIfAllowed(
          packagePlaygroundPath,
          createPackagePlaygroundTemplate(packageJson.name),
          force,
        );
        const bridgeResult = writeFileIfAllowed(
          packageEntryBridgePath,
          "export { default } from './svelte/playground.js';\n",
          force,
        );

        if (packageResult === 'skipped')
          skipped.push('src/svelte/playground.ts');
        else created.push('src/svelte/playground.ts');

        if (bridgeResult === 'skipped') skipped.push('src/playground.ts');
        else created.push('src/playground.ts');

        console.log('\nScaffolded package playground support.\n');
        if (created.length > 0) {
          console.log(`Created/updated: ${created.join(', ')}`);
        }
        if (skipped.length > 0) {
          console.log(`Skipped: ${skipped.join(', ')}`);
        }
        console.log(
          '\nNext step: add a `./playground` export and a `playground` build entry when you want this package discoverable outside the workspace host.',
        );
        return;
      }

      addPlaygroundDependency(projectRoot);

      const localPlaygroundPath = resolve(projectRoot, 'src/playground.ts');
      const routePath = resolve(
        projectRoot,
        'src/routes/playground/+page.svelte',
      );
      const viteConfigPath =
        ['vite.config.ts', 'vite.config.js']
          .map((file) => resolve(projectRoot, file))
          .find((path) => existsSync(path)) || null;

      const localResult = writeFileIfAllowed(
        localPlaygroundPath,
        createAppPlaygroundTemplate(packageJson.name || 'local-app'),
        force,
      );
      const routeResult = writeFileIfAllowed(
        routePath,
        createAppPlaygroundRouteTemplate(),
        force,
      );

      if (localResult === 'skipped') skipped.push('src/playground.ts');
      else created.push('src/playground.ts');

      if (routeResult === 'skipped')
        skipped.push('src/routes/playground/+page.svelte');
      else created.push('src/routes/playground/+page.svelte');

      if (!viteConfigPath) {
        console.warn(
          '\nCould not find vite.config.ts or vite.config.js. Add smrtPlaygroundVitePlugin() to your Vite config manually.',
        );
      } else {
        const patched = ensurePlaygroundPlugin(viteConfigPath);
        const relativeViteConfig = viteConfigPath.replace(
          `${projectRoot}/`,
          '',
        );
        if (patched) {
          created.push(relativeViteConfig);
        } else {
          skipped.push(relativeViteConfig);
        }
      }

      console.log('\nScaffolded app playground support.\n');
      if (created.length > 0) {
        console.log(`Created/updated: ${created.join(', ')}`);
      }
      if (skipped.length > 0) {
        console.log(`Skipped: ${skipped.join(', ')}`);
      }
      console.log(
        '\nNext step: install dependencies, run your app dev server, and visit `/playground`.',
      );
    },
  },

  'playground:list': {
    name: 'playground:list',
    description: 'List discovered playground modules and their preview modes',
    args: [],
    options: {},
    handler: async () => {
      await listDiscoveredPlaygrounds(process.cwd());
    },
  },

  'playground:dev': {
    name: 'playground:dev',
    description: 'Run the shared playground host or the local app dev server',
    args: [],
    options: {},
    handler: async () => {
      const projectRoot = process.cwd();
      const mode = detectPlaygroundMode(projectRoot);

      if (mode === 'workspace') {
        const workspaceRoot = findWorkspaceRoot(projectRoot);
        if (!workspaceRoot) {
          throw new Error('Could not determine workspace root');
        }

        console.log('\nStarting the shared SMRT playground host...\n');
        await runCommand(
          'pnpm',
          [
            '--dir',
            join(workspaceRoot, 'packages/smrt-playground/host'),
            'dev',
          ],
          workspaceRoot,
        );
        return;
      }

      const packageManager = detectPackageManager(projectRoot);
      console.log(
        '\nStarting your app dev server with the local playground route...\n',
      );
      await runCommand(
        packageManager,
        packageManager === 'npm' ? ['run', 'dev'] : ['dev'],
        projectRoot,
      );
    },
  },
};
