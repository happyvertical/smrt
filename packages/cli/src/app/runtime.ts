/**
 * Shared per-invocation context for the `smrt app` command group: source
 * root, application identity, I/O, child-process runners, and the
 * profile-aware runtime environment.
 */

import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as AppRuntime from '@happyvertical/smrt-app-runtime';
import type { ResolvedApplicationRuntime } from '@happyvertical/smrt-config';
import { AppCommandError, errorCode } from './errors.js';
import {
  assertExternalArtifactPath,
  prepareApplicationStateRoot,
  resolveApplicationId,
} from './identity.js';

/** Output sinks. Each call receives complete text including the newline. */
export interface AppCommandIo {
  stdout(text: string): void;
  stderr(text: string): void;
  /**
   * Operator-only sink for secret material (the one-time onboarding URL).
   * Present only when it reaches an interactive terminal; never a log, pipe,
   * or file. Absent means the secret is not printed.
   */
  operatorTerminal?(text: string): void;
}

/** Options for a child command run. */
export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  /** Capture stdout/stderr instead of inheriting the terminal. */
  capture?: boolean;
  /** Return a failed result instead of throwing. */
  allowFailure?: boolean;
  /** Secret-free name used in the failure message. */
  label?: string;
  shell?: boolean;
}

/** Child-process runner signature. */
export type CommandRunner = (
  args: string[],
  options?: RunOptions,
) => SpawnSyncReturns<string>;

/** Replaceable collaborators. Production values are filled in by default. */
export interface AppCommandDependencies {
  /** `@happyvertical/smrt-app-runtime` entry points. */
  runtime: Pick<
    typeof AppRuntime,
    | 'initializeLocalApplicationRuntime'
    | 'initializeDeployedApplicationRuntime'
    | 'prepareLocalDatabaseStorage'
    | 'resolveLocalRuntimePaths'
    | 'validateLocalDatabaseStorage'
  >;
  /** Resolve the configured runtime after (re)loading `smrt.config`. */
  resolveRuntime(sourceRoot: string): Promise<ResolvedApplicationRuntime>;
  /** Run the application's package manager (`pnpm <args>`). */
  runPackageManager: CommandRunner;
  /** Run this CLI (`smrt <args>`) as a child process. */
  runSmrt: CommandRunner;
  /** Open a URL in the operator's browser. */
  openBrowser(url: string): void;
  /** Health probe transport for `start`. */
  fetch: typeof fetch;
  /** Delay between readiness polls. */
  sleep(milliseconds: number): Promise<void>;
  /** Signal a process (`start` cleanup). */
  signal(pid: number, signal: NodeJS.Signals): void;
}

/** Per-invocation context. */
export interface AppContext {
  readonly sourceRoot: string;
  readonly appId: string;
  readonly io: AppCommandIo;
  readonly deps: AppCommandDependencies;
}

/** Locate this package's root (`…/smrt-cli`) from the running module. */
export function cliPackageRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      try {
        const name = (
          JSON.parse(readFileSync(candidate, 'utf8')) as { name?: unknown }
        ).name;
        if (name === '@happyvertical/smrt-cli') return directory;
      } catch {
        // Keep walking: a malformed unrelated package.json is not ours.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('The smrt CLI package root could not be located.');
}

/** Absolute path of the `smrt` executable shipped with this package. */
export function cliExecutablePath(): string {
  return join(cliPackageRoot(), 'bin', 'smrt.js');
}

/** Absolute path of the web launcher `start` spawns. */
export function webLauncherPath(): string {
  return join(cliPackageRoot(), 'bin', 'smrt-web.mjs');
}

/** Load `<sourceRoot>/.env` without overriding the shell; a missing file is fine. */
export function loadSourceEnvironment(sourceRoot: string): void {
  try {
    process.loadEnvFile(join(sourceRoot, '.env'));
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}

function runChild(
  sourceRoot: string,
  binary: string,
  args: string[],
  options: RunOptions = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(binary, args, {
    cwd: sourceRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    shell: options.shell || false,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw new AppCommandError(
      `${options.label || binary} failed with exit code ${result.status ?? 1}.`,
      result.status ?? 1,
      { cause: result.error },
    );
  }
  return result;
}

/** Default package-manager runner: honours a pnpm `npm_execpath`. */
export function createPackageManagerRunner(sourceRoot: string): CommandRunner {
  return (args, options = {}) => {
    const npmExecPath = process.env.npm_execpath;
    const pnpmExecPath =
      npmExecPath && basename(npmExecPath).toLowerCase().startsWith('pnpm')
        ? npmExecPath
        : null;
    return pnpmExecPath
      ? runChild(sourceRoot, process.execPath, [pnpmExecPath, ...args], options)
      : runChild(
          sourceRoot,
          platform() === 'win32' ? 'pnpm.cmd' : 'pnpm',
          args,
          { ...options, shell: platform() === 'win32' },
        );
  };
}

/** Default self-runner: this package's own `smrt` executable. */
export function createSmrtRunner(sourceRoot: string): CommandRunner {
  return (args, options = {}) =>
    runChild(
      sourceRoot,
      process.execPath,
      [cliExecutablePath(), ...args],
      options,
    );
}

/** Default browser opener (`SMRT_OPEN_STUB` writes the URL to a file instead). */
export function createBrowserOpener(sourceRoot: string): (url: string) => void {
  return (url) => {
    if (process.env.SMRT_OPEN_STUB) {
      writeFileSync(resolve(process.env.SMRT_OPEN_STUB), `${url}\n`);
      return;
    }
    const [binary, args] =
      platform() === 'darwin'
        ? ['open', [url]]
        : platform() === 'win32'
          ? ['cmd', ['/c', 'start', '', url]]
          : ['xdg-open', [url]];
    runChild(sourceRoot, binary as string, args as string[]);
  };
}

/**
 * Default runtime resolver: reload `smrt.config` without the cache.
 *
 * A config with no `runtime` block (or no config file) is the `local`
 * profile — the same rule the web process applies in app-runtime's SvelteKit
 * entry — so the operator and the server it manages never disagree. A
 * present but invalid block still fails closed.
 */
export async function resolveConfiguredRuntime(
  sourceRoot: string,
): Promise<ResolvedApplicationRuntime> {
  const {
    loadConfig,
    resolveApplicationRuntime,
    resolveConfiguredApplicationRuntime,
  } = await import('@happyvertical/smrt-config');
  const loaded = await loadConfig({ cache: false, searchFrom: sourceRoot });
  // Only an absent property (or an explicit `undefined`) is "no runtime
  // block". A present falsy value (`null`, `false`, `0`, `''`) goes to the
  // validator, which rejects it, rather than silently selecting local.
  const declaresRuntime =
    Object.hasOwn(loaded, 'runtime') && loaded.runtime !== undefined;
  return (
    declaresRuntime
      ? resolveConfiguredApplicationRuntime()
      : resolveApplicationRuntime({ profile: 'local' })
  ) as ResolvedApplicationRuntime;
}

/** Build the default dependency set for `sourceRoot`. */
export async function defaultDependencies(
  sourceRoot: string,
): Promise<AppCommandDependencies> {
  const runtime = await import('@happyvertical/smrt-app-runtime');
  return {
    runtime,
    resolveRuntime: resolveConfiguredRuntime,
    runPackageManager: createPackageManagerRunner(sourceRoot),
    runSmrt: createSmrtRunner(sourceRoot),
    openBrowser: createBrowserOpener(sourceRoot),
    fetch: globalThis.fetch.bind(globalThis),
    sleep: (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    signal: (pid, signal) => {
      process.kill(pid, signal);
    },
  };
}

/** Resolve the application id from `<sourceRoot>/package.json` and `SMRT_APP_ID`. */
export function resolveContextApplicationId(sourceRoot: string): string {
  const packageJson = JSON.parse(
    readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
  ) as { name?: string };
  return resolveApplicationId({
    sourceRoot,
    packageName: packageJson.name,
    explicitId: process.env.SMRT_APP_ID,
  });
}

/** Create or verify the private state root for this invocation. */
export function preparedStateRoot(context: AppContext): string {
  return prepareApplicationStateRoot({
    appId: context.appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot: context.sourceRoot,
  });
}

/** Profile-aware child environment, with local storage paths when local. */
export interface RuntimeEnvironment {
  env: NodeJS.ProcessEnv;
  paths: AppRuntime.LocalRuntimePaths | null;
  assetRoot: string | null;
}

/** Compute the environment a web/migration child of this app runs with. */
export function runtimeEnvironment(
  context: AppContext,
  runtime: ResolvedApplicationRuntime,
): RuntimeEnvironment {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SMRT_APP_ID: context.appId,
    SMRT_RUNTIME_PROFILE: runtime.profile,
    HOST:
      runtime.profile === 'local' ? '127.0.0.1' : process.env.HOST || '0.0.0.0',
    PORT: process.env.PORT || '5173',
  };
  if (runtime.profile === 'local') {
    const paths = context.deps.runtime.resolveLocalRuntimePaths({
      appId: context.appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot: context.sourceRoot,
    });
    env.DATABASE_TYPE = 'sqlite';
    env.DATABASE_URL = paths.database;
    env.SMRT_ASSETS_DIR = paths.assets;
    return { env, paths, assetRoot: paths.assets };
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      `${runtime.profile} requires DATABASE_URL; copy the matching env example and configure providers.`,
    );
  }
  env.DATABASE_TYPE = 'postgres';
  let assetRoot: string | null = null;
  if (runtime.providers.assets.provider === 'local-files') {
    if (
      !process.env.SMRT_ASSETS_DIR ||
      !isAbsolute(process.env.SMRT_ASSETS_DIR)
    ) {
      throw new Error(
        'Filesystem-backed deployed profiles require an absolute SMRT_ASSETS_DIR outside the source tree.',
      );
    }
    assetRoot = assertExternalArtifactPath({
      sourceRoot: context.sourceRoot,
      path: process.env.SMRT_ASSETS_DIR,
      label: 'Asset storage root',
    });
    env.SMRT_ASSETS_DIR = assetRoot;
  }
  return { env, paths: null, assetRoot };
}
