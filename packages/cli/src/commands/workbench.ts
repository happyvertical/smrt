/**
 * Workbench Commands
 *
 * Shared SMRT package/project workbench host launcher.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
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

function packageManagerEntryMatches(
  command: string,
  entryPath: string,
): boolean {
  const expectedNames: Record<string, string[]> = {
    npm: ['npm-cli.js', 'npm.cjs', 'npm.js'],
    pnpm: ['pnpm.cjs', 'pnpm.js'],
    yarn: ['yarn.cjs', 'yarn.js'],
  };
  return (
    expectedNames[command]?.includes(basename(entryPath).toLowerCase()) ?? false
  );
}

function resolveWindowsCommandShimEntry(command: string): string | null {
  let shimPaths: string;
  try {
    shimPaths = execFileSync('where.exe', [`${command}.cmd`], {
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch {
    return null;
  }

  const shimPath = shimPaths
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find(Boolean);
  if (!shimPath || !existsSync(shimPath)) return null;

  try {
    const packageRoot = realpathSync(
      join(dirname(shimPath), 'node_modules', command),
    );
    const shim = readFileSync(shimPath, 'utf8');
    const entryPattern = /(?:%dp0%|%~dp0)([^"\r\n]*?\.(?:cjs|mjs|js))/gi;
    for (const match of shim.matchAll(entryPattern)) {
      const relativeEntry = match[1]
        ?.replace(/^[\\/]+/, '')
        .replace(/[\\/]+/g, sep);
      if (!relativeEntry) continue;
      const entryPath = resolve(dirname(shimPath), relativeEntry);
      const realEntryPath = existsSync(entryPath)
        ? realpathSync(entryPath)
        : null;
      if (
        realEntryPath?.startsWith(`${packageRoot}${sep}`) &&
        packageManagerEntryMatches(command, realEntryPath)
      ) {
        return realEntryPath;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function windowsPackageManagerInvocation(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const nodeRoot = dirname(process.execPath);
  const bundledEntry =
    command === 'npm'
      ? join(nodeRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : join(nodeRoot, 'node_modules', 'corepack', 'dist', `${command}.js`);
  if (existsSync(bundledEntry)) {
    return {
      command: process.execPath,
      args: [bundledEntry, ...args],
    };
  }

  const shimEntry = resolveWindowsCommandShimEntry(command);
  if (shimEntry) {
    return {
      command: process.execPath,
      args: [shimEntry, ...args],
    };
  }

  // Standalone and version-manager installations commonly expose a native
  // package-manager shim. An .exe can be launched directly without a shell;
  // a cmd.exe fallback is deliberately excluded because CLI arguments may
  // include consumer-controlled paths and host values.
  return {
    command: `${command}.exe`,
    args,
  };
}

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

function findYarnPnpRoot(cwd: string): string | null {
  let current = resolve(cwd);

  while (true) {
    if (
      existsSync(join(current, '.pnp.cjs')) ||
      existsSync(join(current, '.pnp.js'))
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

function resolveInstalledWorkbenchEntry(cwd: string): string | null {
  const packageRoot = findInstalledWorkbenchPackageRoot(cwd);
  const entryPath = packageRoot ? join(packageRoot, 'dist', 'index.js') : null;
  return entryPath && existsSync(entryPath) ? entryPath : null;
}

function loadWorkbenchRuntime(cwd: string): Promise<SmrtWorkbenchRuntime> {
  if (!workbenchRuntimePromise) {
    const installedEntry = resolveInstalledWorkbenchEntry(cwd);
    const workspaceRoot = findWorkspaceWorkbenchRoot(cwd);
    if (!installedEntry && !workspaceRoot && findYarnPnpRoot(cwd)) {
      return Promise.reject(
        new Error(
          'SMRT workbench requires Yarn to use nodeLinker: node-modules; Yarn Plug’n’Play does not expose the browser host as a physical directory.',
        ),
      );
    }
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
    const invocation =
      process.platform === 'win32'
        ? windowsPackageManagerInvocation(command, args)
        : { command, args };

    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: false,
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

function resolveWorkbenchPort(value: string | undefined): string {
  const port = value ?? '5570';
  if (!/^[1-9]\d*$/.test(port)) {
    throw new Error(
      `Invalid workbench port "${port}". Expected an integer from 1 to 65535.`,
    );
  }

  const numericPort = Number(port);
  if (!Number.isSafeInteger(numericPort) || numericPort > 65535) {
    throw new Error(
      `Invalid workbench port "${port}". Expected an integer from 1 to 65535.`,
    );
  }

  return String(numericPort);
}

function workbenchUrlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

function normalizeWorkbenchHost(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
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

function detectPackageManager(projectRoot: string): 'pnpm' | 'yarn' | 'npm' {
  let current = resolve(projectRoot);

  while (true) {
    if (existsSync(join(current, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (existsSync(join(current, 'yarn.lock'))) {
      return 'yarn';
    }

    const packageJsonPath = join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const packageManager = (
          JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
            packageManager?: unknown;
          }
        ).packageManager;
        if (typeof packageManager === 'string') {
          if (packageManager.startsWith('pnpm@')) return 'pnpm';
          if (packageManager.startsWith('yarn@')) return 'yarn';
          if (packageManager.startsWith('npm@')) return 'npm';
        }
      } catch {
        // The runtime scope resolver reports malformed project metadata.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return 'npm';
    }
    current = parent;
  }
}

function workbenchDevCommand(
  packageManager: 'pnpm' | 'yarn' | 'npm',
  hostDir: string,
  host: string,
  port: string,
): { command: string; args: string[] } {
  if (packageManager === 'pnpm') {
    return {
      command: 'pnpm',
      args: [
        '--dir',
        hostDir,
        'dev',
        '--host',
        host,
        '--port',
        port,
        '--strictPort',
      ],
    };
  }

  if (packageManager === 'yarn') {
    return {
      command: 'yarn',
      args: [
        '--cwd',
        hostDir,
        'dev',
        '--host',
        host,
        '--port',
        port,
        '--strictPort',
      ],
    };
  }

  return {
    command: 'npm',
    args: [
      '--prefix',
      hostDir,
      'run',
      'dev',
      '--',
      '--host',
      host,
      '--port',
      port,
      '--strictPort',
    ],
  };
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

      const requestedHost = options.host || '127.0.0.1';
      const host = normalizeWorkbenchHost(requestedHost);
      if (!isLoopbackHost(host) && !options['allow-remote']) {
        throw new Error(
          `Refusing to expose the workbench on non-loopback host "${requestedHost}". Re-run with --allow-remote only on a trusted network.`,
        );
      }
      const port = resolveWorkbenchPort(options.port);
      const url = `http://${workbenchUrlHost(host)}:${port}/`;
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

      const packageManager = workspaceRoot
        ? 'pnpm'
        : detectPackageManager(scope.projectRoot);
      const devCommand = workbenchDevCommand(
        packageManager,
        resolve(hostDir),
        host,
        port,
      );
      await runCommand(
        devCommand.command,
        devCommand.args,
        scope.projectRoot,
        env,
      );
    },
  },
};
