/**
 * Workbench Commands
 *
 * Shared SMRT package/project workbench host launcher.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { importWorkspaceModule } from '@happyvertical/smrt-core/utils/import-workspace-module';
import type { CLICommand } from '../cli-generator.js';

interface WorkbenchScopeResolution {
  mode: 'workspace' | 'package' | 'consumer';
  projectRoot: string;
  packageName?: string;
}

interface SmrtWorkbenchRuntime {
  resolveWorkbenchScope(
    cwd: string,
    options: { packageName?: string },
  ): WorkbenchScopeResolution;
}

let workbenchRuntimePromise: Promise<SmrtWorkbenchRuntime> | null = null;

function findWorkspaceWorkbenchRoot(cwd: string): string | null {
  let current = resolve(cwd);

  while (true) {
    if (
      existsSync(
        join(current, 'packages', 'smrt-workbench', 'host', 'package.json'),
      )
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function findInstalledWorkbenchPackageRoot(cwd: string): string | null {
  let current = resolve(cwd);

  while (true) {
    const packageRoot = join(
      current,
      'node_modules',
      '@happyvertical',
      'smrt-workbench',
    );
    if (existsSync(join(packageRoot, 'package.json'))) {
      return packageRoot;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function resolveInstalledWorkbenchEntry(cwd: string): string | null {
  const packageRoot = findInstalledWorkbenchPackageRoot(cwd);
  const entryPath = packageRoot ? join(packageRoot, 'dist', 'index.js') : null;
  return entryPath && existsSync(entryPath) ? entryPath : null;
}

function loadWorkbenchRuntime(cwd: string): Promise<SmrtWorkbenchRuntime> {
  if (!workbenchRuntimePromise) {
    const installedEntry = resolveInstalledWorkbenchEntry(cwd);
    workbenchRuntimePromise = installedEntry
      ? import(pathToFileURL(installedEntry).href)
      : importWorkspaceModule<SmrtWorkbenchRuntime>({
          packageName: '@happyvertical/smrt-workbench',
          sourceEntry: 'packages/smrt-workbench/src/index.ts',
          distEntry: 'packages/smrt-workbench/dist/index.js',
          purpose: 'SMRT workbench CLI commands',
        });
  }

  return workbenchRuntimePromise;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }

      reject(new Error(`${command} exited with code ${code ?? 1}`));
    });
  });
}

function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  );
}

function resolveInstalledWorkbenchHostDir(cwd: string): string | null {
  const packageRoot = findInstalledWorkbenchPackageRoot(cwd);
  if (!packageRoot) {
    return null;
  }

  const hostDir = join(packageRoot, 'host');
  return existsSync(join(hostDir, 'package.json')) ? hostDir : null;
}

function resolveWorkspaceWorkbenchHostDir(
  workspaceRoot: string,
): string | null {
  const hostDir = join(workspaceRoot, 'packages', 'smrt-workbench', 'host');
  return existsSync(join(hostDir, 'package.json')) ? hostDir : null;
}

export const workbenchCommands: Record<string, CLICommand> = {
  'workbench:dev': {
    name: 'workbench:dev',
    description: 'Run the shared SMRT workbench host for the current scope',
    args: [],
    options: {
      package: {
        type: 'string',
        description: 'Focus the workbench to a package name',
      },
      port: {
        type: 'string',
        description: 'Workbench dev server port',
        default: '5570',
      },
      host: {
        type: 'string',
        description: 'Workbench dev server host',
        default: '127.0.0.1',
      },
      'allow-remote': {
        type: 'boolean',
        description:
          'Acknowledge that a non-loopback host exposes local project sources',
        default: false,
      },
    },
    handler: async (
      _args: string[],
      options: {
        package?: string;
        port?: string;
        host?: string;
        'allow-remote'?: boolean;
      },
    ) => {
      const cwd = process.cwd();
      const runtime = await loadWorkbenchRuntime(cwd);
      const scope = runtime.resolveWorkbenchScope(cwd, {
        packageName: options.package,
      });
      const workspaceRoot = findWorkspaceWorkbenchRoot(cwd);
      const hostDir =
        (workspaceRoot
          ? resolveWorkspaceWorkbenchHostDir(workspaceRoot)
          : null) || resolveInstalledWorkbenchHostDir(cwd);

      if (!hostDir) {
        throw new Error(
          'Could not locate @happyvertical/smrt-workbench host files. Install @happyvertical/smrt-workbench or run from the SMRT workspace.',
        );
      }

      const host = options.host || '127.0.0.1';
      if (!isLoopbackHost(host) && !options['allow-remote']) {
        throw new Error(
          `Refusing to expose the workbench on non-loopback host "${host}". Re-run with --allow-remote only on a trusted network.`,
        );
      }
      const port = options.port || '5570';
      const url = `http://${host}:${port}/`;
      const env = {
        ...process.env,
        SMRT_WORKBENCH_CWD: cwd,
        SMRT_WORKBENCH_PROJECT_ROOT: scope.projectRoot,
        SMRT_WORKBENCH_PACKAGE: scope.packageName || '',
        SMRT_WORKBENCH_ALLOW_REMOTE: options['allow-remote'] ? '1' : '',
      };

      console.log(
        `\nStarting SMRT workbench (${scope.mode} scope) at ${url}\n`,
      );
      if (scope.packageName) {
        console.log(`Focused package: ${scope.packageName}\n`);
      }

      await runCommand(
        'pnpm',
        ['--dir', resolve(hostDir), 'dev', '--host', host, '--port', port],
        scope.projectRoot,
        env,
      );
    },
  },
};
