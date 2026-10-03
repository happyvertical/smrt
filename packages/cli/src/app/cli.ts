/**
 * `smrt app <operation>` dispatcher.
 *
 * Every operation writes machine-readable JSON to stdout and, on failure,
 * one secret-free JSON envelope to stderr with exit code 1 — the contract
 * the template's `scripts/smrt-app.mjs` established.
 */

import { resolve } from 'node:path';
import { ApplicationStartError, redactSecrets } from './errors.js';
import {
  devServerArguments,
  launchVite,
  prepareMigration,
  runWorker,
  validateMcpAppsIfPresent,
} from './launchers.js';
import {
  APP_OPERATIONS,
  type AppOperation,
  runApplicationOperation,
} from './operations.js';
import {
  type AppCommandDependencies,
  type AppCommandIo,
  type AppContext,
  defaultDependencies,
  loadSourceEnvironment,
  resolveContextApplicationId,
} from './runtime.js';

/** Recovery line carried by every error envelope. */
export const APP_RECOVERY =
  'Run pnpm app:doctor and follow its recovery instructions.';

/** Every `smrt app` command with a one-line description (for help output). */
export const APP_COMMANDS: Readonly<Record<string, string>> = Object.freeze({
  install: 'Local: set up, start, and open owner onboarding in one step',
  setup: 'Build, apply migrations explicitly, and prepare owner onboarding',
  recover: 'Local: issue a fresh single-use owner onboarding invitation',
  start: 'Local: start the production build on loopback and prove readiness',
  stop: 'Local: stop the managed application process',
  doctor: 'Report runtime, storage, provider, and migration findings (default)',
  open: 'Open the application or pending owner onboarding in a browser',
  'backup [destination]':
    'Local: copy the private data root to a new directory',
  'export [path]': 'Write a logical, asset-aware export bundle',
  'import <path>': 'Import a logical export bundle into an empty application',
  migrate: 'Prepare storage custody and run smrt db:migrate under the lock',
  'worker [task|schedule]': 'Deployed: run the task or schedule worker',
  'dev [...vite args]': "Run the application's Vite dev server",
  'build [...vite args]':
    'Validate ./mcp-apps when present, then run the Vite build',
  'vite [...args]': "Run the application's installed Vite CLI with args",
});

/** Options for {@link runAppCommand}. */
export interface RunAppCommandOptions {
  /** Application root. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Output sinks. Defaults to the process streams. */
  io?: Partial<AppCommandIo>;
  /** Collaborator overrides (tests, embedding). */
  dependencies?: Partial<AppCommandDependencies>;
}

/** Secret-free failure envelope written to stderr. */
export interface AppErrorEnvelope {
  schemaVersion: 1;
  status: 'error';
  code: 'operation-failed';
  /** Stable runtime code when the failure carries one (e.g. `migration_failed`). */
  runtimeCode?: string;
  message: string;
  /**
   * `start` only: the redacted, bounded (≤ 8 KiB) tail of the web process's
   * stdout/stderr when it never proved readiness.
   */
  output?: string;
  /** `start` only: the private (0600) log that `output` was read from. */
  logFile?: string;
  recovery: string;
  secretValuesIncluded: false;
}

/** Build the stderr envelope for `error`, redacting secret material. */
export function errorEnvelope(error: unknown): AppErrorEnvelope {
  const runtimeCode =
    error instanceof Error &&
    error.name === 'LocalRuntimeError' &&
    typeof (error as { code?: unknown }).code === 'string'
      ? (error as unknown as { code: string }).code
      : undefined;
  return {
    schemaVersion: 1,
    status: 'error',
    code: 'operation-failed',
    ...(runtimeCode ? { runtimeCode } : {}),
    message: redactSecrets(
      error instanceof Error ? error.message : 'Application operation failed.',
    ),
    ...(error instanceof ApplicationStartError
      ? {
          // Redacted against the child's environment when captured; again
          // here against this process's, like every other message.
          output: redactSecrets(error.output, process.env, { strict: true }),
          logFile: error.logFile,
        }
      : {}),
    recovery: APP_RECOVERY,
    secretValuesIncluded: false,
  };
}

/** Render `smrt app` usage. */
export function renderAppHelp(): string {
  const width = Math.max(...Object.keys(APP_COMMANDS).map((key) => key.length));
  const lines = Object.entries(APP_COMMANDS).map(
    ([name, description]) => `  ${name.padEnd(width)}  ${description}`,
  );
  return `Usage: smrt app <operation> [args]\n\nOperations:\n${lines.join('\n')}\n`;
}

const ENV_FILE_OPERATIONS = new Set<string>([
  ...APP_OPERATIONS,
  'migrate',
  'dev',
  'build',
  'vite',
]);

/**
 * Run `smrt app <argv…>` and resolve to the process exit code.
 *
 * `argv` is everything after `app`. A leading `--` before operation
 * arguments is ignored, matching `pnpm app:import -- <path>`.
 */
export async function runAppCommand(
  argv: string[],
  options: RunAppCommandOptions = {},
): Promise<number> {
  const io: AppCommandIo = {
    stdout: options.io?.stdout ?? ((text) => void process.stdout.write(text)),
    stderr: options.io?.stderr ?? ((text) => void process.stderr.write(text)),
    // The onboarding URL is a bearer token: show it only on a real terminal.
    operatorTerminal: options.io
      ? options.io.operatorTerminal
      : process.stderr.isTTY && process.stdout.isTTY
        ? (text) => void process.stderr.write(text)
        : undefined,
  };
  const operation = argv[0] || 'doctor';
  const rawArgs = argv.slice(1);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (operation === 'help' || operation === '--help' || operation === '-h') {
    io.stdout(renderAppHelp());
    return 0;
  }
  try {
    const sourceRoot = resolve(options.cwd ?? process.cwd());
    if (ENV_FILE_OPERATIONS.has(operation)) loadSourceEnvironment(sourceRoot);
    if (operation === 'dev' || operation === 'build' || operation === 'vite') {
      const context = {
        sourceRoot,
        appId: '',
        io,
        deps: {} as AppCommandDependencies,
      } satisfies AppContext;
      if (operation === 'build') {
        const status = await validateMcpAppsIfPresent(context);
        if (status !== 0) return status;
      }
      return launchVite(
        context,
        operation === 'vite'
          ? args
          : operation === 'dev'
            ? ['dev', ...devServerArguments(args)]
            : [operation, ...args],
      );
    }
    const deps: AppCommandDependencies = {
      ...(await defaultDependencies(sourceRoot)),
      ...options.dependencies,
    };
    const context: AppContext = {
      sourceRoot,
      appId: resolveContextApplicationId(sourceRoot),
      io,
      deps,
    };
    if (operation === 'migrate') return await prepareMigration(context);
    if (operation === 'worker') return await runWorker(context, args);
    if (!(APP_OPERATIONS as readonly string[]).includes(operation)) {
      throw new Error(`Unknown app operation: ${operation}`);
    }
    return await runApplicationOperation(
      context,
      operation as AppOperation,
      args,
    );
  } catch (error) {
    io.stderr(`${JSON.stringify(errorEnvelope(error))}\n`);
    return 1;
  }
}
