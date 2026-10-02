/**
 * Process wrappers: explicit schema preparation (`migrate`), deployed job
 * workers (`worker`), and the Vite launcher (`dev`, `build`, `vite`).
 *
 * Ported from the template's `scripts/smrt-prepare-migration.mjs`,
 * `scripts/smrt-worker.mjs`, `scripts/smrt-vite.mjs`, and
 * `scripts/smrt-mcp-apps.mjs`.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PublicAuthenticationProvider } from '@happyvertical/smrt-app-runtime';
import type { DatabaseInterface } from '@happyvertical/sql';
import { AppCommandError } from './errors.js';
import { withOperationLock } from './operation-lock.js';
import {
  createProviderReadinessProbe,
  findInstalledPackage,
} from './provider-readiness.js';
import { type AppContext, preparedStateRoot } from './runtime.js';
import { readActiveWriterLease } from './writer-lease.js';

/**
 * Prepare the schema explicitly: under the operation lock, refuse while a
 * local writer is live, establish local storage custody without creating
 * schema or bootstrap records, then run `smrt db:migrate`.
 */
export async function prepareMigration(context: AppContext): Promise<number> {
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  const stateRoot = preparedStateRoot(context);
  await withOperationLock(stateRoot, 'db:migrate', async () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SMRT_APP_ID: context.appId,
    };
    if (runtime.profile === 'local') {
      if (readActiveWriterLease(stateRoot)) {
        throw new Error(
          'Stop the local application before preparing its schema.',
        );
      }
      const paths = context.deps.runtime.resolveLocalRuntimePaths({
        appId: context.appId,
        dataDirectory: process.env.SMRT_DATA_DIR,
        sourceRoot: context.sourceRoot,
      });
      await context.deps.runtime.prepareLocalDatabaseStorage({
        appId: context.appId,
        dataDirectory: process.env.SMRT_DATA_DIR,
        sourceRoot: context.sourceRoot,
      });
      env.DATABASE_TYPE = 'sqlite';
      env.DATABASE_URL = paths.database;
      env.SMRT_ASSETS_DIR = paths.assets;
    }
    const result = context.deps.runSmrt(['db:migrate'], {
      env,
      allowFailure: true,
    });
    if (result.error || result.status !== 0) {
      throw new AppCommandError(
        's-m-r-t database migration failed.',
        result.status ?? 1,
        { cause: result.error },
      );
    }
  });
  return 0;
}

/** Worker kinds. Anything other than `schedule` runs the task worker. */
export type WorkerKind = 'task' | 'schedule';

/**
 * Start a deployed job worker. Resolves once the runner is started; the
 * process stays alive until SIGINT/SIGTERM closes the runtime.
 */
export async function runWorker(
  context: AppContext,
  args: string[],
): Promise<number> {
  const configured = await context.deps.resolveRuntime(context.sourceRoot);
  if (configured.profile === 'local') {
    throw new Error(
      'Local jobs run inline or embedded; a separate worker requires self-hosted or cloud.',
    );
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

  // Register this application's own @smrt() objects (and the consumed
  // packages' objects) before any runner resolves a job's objectType. The
  // application build compiles the generated registration into this module;
  // the web server's bundle is not importable from a separate Node process.
  const registration = join(
    context.sourceRoot,
    '.smrt',
    'runtime',
    'register.js',
  );
  if (!existsSync(registration)) {
    throw new Error(
      'Missing .smrt/runtime/register.js: run pnpm build before starting a worker.',
    );
  }
  await import(pathToFileURL(registration).href);

  const probe = (component: 'authentication' | 'assets' | 'secrets') =>
    createProviderReadinessProbe(
      component,
      {
        profile: configured.profile,
        provider: configured.providers[component].provider,
      },
      { sourceRoot: context.sourceRoot },
    );
  const runtime =
    await context.deps.runtime.initializeDeployedApplicationRuntime({
      profile: configured.profile as 'self-hosted' | 'cloud',
      providers: {
        database: configured.providers.database,
        authentication: configured.providers.authentication,
        tenancy: configured.providers.tenancy,
        assets: configured.providers.assets,
        secrets: configured.providers.secrets,
        jobs: configured.providers.jobs,
        network: configured.providers.network,
      },
      database: {
        engine: 'postgres',
        connect: async () => {
          const { getDatabase } = await import('@happyvertical/sql');
          return (await getDatabase({
            type: 'postgres',
            url: process.env.DATABASE_URL,
          } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
        },
        close: async (db: DatabaseInterface) => {
          await db.close?.();
        },
      },
      authentication: {
        // initializeDeployedApplicationRuntime rejects a non-public provider.
        provider: configured.providers.authentication
          .provider as PublicAuthenticationProvider,
        readiness: probe('authentication'),
      },
      assets: {
        provider: configured.providers.assets.provider,
        readiness: probe('assets'),
      },
      secrets: {
        provider: configured.providers.secrets.provider,
        readiness: probe('secrets'),
      },
    });

  const kind: WorkerKind = args[0] === 'schedule' ? 'schedule' : 'task';
  const reportedKind = args[0] || 'task';
  const runner =
    kind === 'schedule'
      ? await runtime.createScheduleWorker()
      : await runtime.createTaskWorker({
          concurrency: Number.parseInt(
            process.env.SMRT_WORKER_CONCURRENCY || '4',
            10,
          ),
        });

  await runner.start();
  context.io.stdout(
    `${JSON.stringify({
      schemaVersion: 1,
      status: 'ready',
      kind: reportedKind,
      secretValuesIncluded: false,
    })}\n`,
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await runtime.close();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  return 0;
}

/** Failure of the Vite launcher; rendered as `s-m-r-t Vite launcher: …`. */
export class ViteLauncherError extends Error {}

/** Resolve the application's installed Vite CLI entry, refusing unsafe paths. */
export function resolveViteEntry(sourceRoot: string): string {
  const installed = findInstalledPackage(sourceRoot, 'vite');
  if (!installed) {
    throw new ViteLauncherError(
      'Could not resolve the installed Vite package. Verify the generated app dependencies and Vite compatibility.',
    );
  }
  const packagePath = join(realpathSync(installed), 'package.json');
  const packageRoot = dirname(packagePath);
  let metadata: { bin?: string | { vite?: string } };
  try {
    metadata = JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    throw new ViteLauncherError(
      'The installed Vite package metadata is invalid; reinstall dependencies.',
    );
  }
  const declaredBin =
    typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.vite;
  if (typeof declaredBin !== 'string' || declaredBin === '') {
    throw new ViteLauncherError(
      'The installed Vite package does not declare its CLI.',
    );
  }
  const entry = resolve(packageRoot, declaredBin);
  const relativeEntry = relative(packageRoot, entry);
  if (
    relativeEntry === '' ||
    relativeEntry.startsWith('..') ||
    isAbsolute(relativeEntry)
  ) {
    throw new ViteLauncherError(
      'The installed Vite package declares an unsafe CLI path.',
    );
  }
  if (!existsSync(entry)) {
    throw new ViteLauncherError(
      'The installed Vite package CLI is missing; reinstall dependencies.',
    );
  }
  return entry;
}

/**
 * Run the application's Vite CLI in this process with `args` verbatim. The
 * caller has already loaded `.env` without overriding the shell.
 */
export async function launchVite(
  context: AppContext,
  args: string[],
): Promise<number> {
  let entry: string;
  try {
    entry = resolveViteEntry(context.sourceRoot);
  } catch (error) {
    if (error instanceof ViteLauncherError) {
      context.io.stderr(`s-m-r-t Vite launcher: ${error.message}\n`);
      return 1;
    }
    throw error;
  }
  process.argv = [process.execPath, entry, ...args];
  await import(pathToFileURL(entry).href);
  return 0;
}

/**
 * Validate opt-in portable MCP Apps metadata (`./mcp-apps`) when present.
 * Returns the exit code; findings go to stderr.
 */
export async function validateMcpAppsIfPresent(
  context: AppContext,
): Promise<number> {
  const root = join(context.sourceRoot, 'mcp-apps');
  if (!existsSync(root)) return 0;
  const { validateMcpAppsPackage } = await import(
    '../commands/mcp-apps-packaging.js'
  );
  const result = validateMcpAppsPackage(root);
  for (const finding of result.findings) {
    context.io.stderr(`${finding.code}: ${finding.message}\n`);
  }
  if (!result.valid) {
    context.io.stderr(
      `Error: MCP Apps package validation failed with ${result.findings.length} finding(s)\n`,
    );
    return 1;
  }
  context.io.stdout('MCP Apps package at ./mcp-apps is valid.\n');
  return 0;
}
