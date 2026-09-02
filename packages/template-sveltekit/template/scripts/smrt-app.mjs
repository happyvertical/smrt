#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  initializeLocalApplicationRuntime,
  resolveLocalRuntimePaths,
  validateLocalDatabaseStorage,
} from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import {
  readOwnedProcess,
  sendTerminationSignal,
  writeProcessRecord,
} from './smrt-process.mjs';
import {
  assertExternalArtifactPath,
  prepareApplicationStateRoot,
  resolveApplicationId,
  resolveApplicationStateRoot,
  runtimeConfigurationFingerprint,
} from './smrt-runtime-identity.mjs';
import { withOperationLock } from './smrt-operation-lock.mjs';
import { createProviderReadinessProbe } from './smrt-provider-readiness.mjs';
import { acquireWriterLease } from './smrt-writer-lease.mjs';

const sourceRoot = process.cwd();
try {
  process.loadEnvFile(join(sourceRoot, '.env'));
} catch (error) {
  if (
    !(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
  ) {
    throw error;
  }
}
const packageJson = JSON.parse(
  readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
);
const appId = resolveApplicationId({
  sourceRoot,
  packageName: packageJson.name,
  explicitId: process.env.SMRT_APP_ID,
});
const command = process.argv[2] || 'doctor';
const rawCommandArgs = process.argv.slice(3);
const commandArgs =
  rawCommandArgs[0] === '--' ? rawCommandArgs.slice(1) : rawCommandArgs;

function preparedStateRoot() {
  return prepareApplicationStateRoot({
    appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot,
  });
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function nearestExistingAncestor(path) {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function pidPath() {
  return join(preparedStateRoot(), 'app.pid');
}

function onboardingPath() {
  return join(preparedStateRoot(), 'onboarding.json');
}

function onboardingLaunchPath() {
  return join(preparedStateRoot(), 'onboarding-launch.html');
}

function removeOnboardingHandoff() {
  rmSync(onboardingPath(), { force: true });
  rmSync(onboardingLaunchPath(), { force: true });
}

function writePrivateAtomic(destination, contents) {
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function saveOnboardingLaunch(url) {
  const escapedUrl = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  writePrivateAtomic(
    onboardingLaunchPath(),
    `<!doctype html><meta http-equiv="refresh" content="0;url=${escapedUrl}">\n`,
  );
}

function saveOnboardingUrl(url) {
  ensurePrivateDirectory(preparedStateRoot());
  saveOnboardingLaunch(url);
  writePrivateAtomic(
    onboardingPath(),
    `${JSON.stringify({ schemaVersion: 1, url })}\n`,
  );
}

function readOnboardingUrl() {
  try {
    const value = JSON.parse(readFileSync(onboardingPath(), 'utf8'));
    if (value?.schemaVersion !== 1 || typeof value.url !== 'string') {
      throw new Error('Invalid onboarding handoff.');
    }
    const url = new URL(value.url);
    if (
      url.protocol !== 'http:' ||
      (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
      url.pathname !== '/setup'
    ) {
      throw new Error('Invalid onboarding handoff.');
    }
    return url.toString();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      removeOnboardingHandoff();
      return null;
    }
    if (
      error instanceof SyntaxError ||
      (error instanceof Error &&
        (error.message === 'Invalid onboarding handoff.' ||
          error.code === 'ERR_INVALID_URL'))
    ) {
      removeOnboardingHandoff();
      return null;
    }
    throw error;
  }
}

function readProcess() {
  return readOwnedProcess(pidPath());
}

function readPid() {
  return readProcess()?.pid || null;
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: sourceRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    shell: options.shell || false,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    const error = new Error(
      `${options.label || binary} failed with exit code ${result.status ?? 1}.`,
      { cause: result.error },
    );
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return result;
}

function runPackageManager(args, options = {}) {
  const npmExecPath = process.env.npm_execpath;
  const pnpmExecPath =
    npmExecPath && basename(npmExecPath).toLowerCase().startsWith('pnpm')
      ? npmExecPath
      : null;
  return pnpmExecPath
    ? run(process.execPath, [pnpmExecPath, ...args], options)
    : run(platform() === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
        ...options,
        shell: platform() === 'win32',
      });
}

async function resolveRuntime() {
  await loadConfig({ cache: false });
  return resolveConfiguredApplicationRuntime();
}

async function assertLocalOperation(operation) {
  const runtime = await resolveRuntime();
  if (runtime.profile !== 'local') {
    throw new Error(
      `${operation} is local-profile only; run the production Node build or container for deployed profiles.`,
    );
  }
  return runtime;
}

function runtimeEnvironment(runtime) {
  const env = {
    ...process.env,
    SMRT_APP_ID: appId,
    SMRT_RUNTIME_PROFILE: runtime.profile,
    HOST:
      runtime.profile === 'local'
        ? '127.0.0.1'
        : process.env.HOST || '0.0.0.0',
    PORT: process.env.PORT || '5173',
  };
  if (runtime.profile === 'local') {
    const paths = resolveLocalRuntimePaths({
      appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot,
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
  let assetRoot = null;
  if (runtime.providers.assets.provider === 'local-files') {
    if (!process.env.SMRT_ASSETS_DIR || !isAbsolute(process.env.SMRT_ASSETS_DIR)) {
      throw new Error(
        'Filesystem-backed deployed profiles require an absolute SMRT_ASSETS_DIR outside the source tree.',
      );
    }
    assetRoot = assertExternalArtifactPath({
      sourceRoot,
      path: process.env.SMRT_ASSETS_DIR,
      label: 'Asset storage root',
    });
    env.SMRT_ASSETS_DIR = assetRoot;
  }
  return { env, paths: null, assetRoot };
}

async function initializeLocal(runtime, env, options = {}) {
  if (runtime.profile !== 'local') return null;
  const initialized = await initializeLocalApplicationRuntime({
    appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot,
    bindHost: env.HOST || '127.0.0.1',
    providers: {
      database: runtime.providers.database,
      authentication: runtime.providers.authentication,
      tenancy: runtime.providers.tenancy,
      assets: runtime.providers.assets,
      secrets: runtime.providers.secrets,
      jobs: runtime.providers.jobs,
      network: runtime.providers.network,
    },
    prepareDatabase: options.prepareDatabase
      ? async () => {
          runPackageManager(['exec', 'smrt', 'db:migrate'], {
            env,
            label: 'pnpm exec smrt db:migrate',
          });
        }
      : undefined,
    backgroundJobs: process.env.SMRT_BACKGROUND_JOBS === 'true',
  });
  return initialized;
}

async function setup(operationLock) {
  const runtime = await resolveRuntime();
  const operatorLease =
    runtime.profile === 'local'
      ? acquireWriterLease(preparedStateRoot(), {
          operationInstance: operationLock?.instance,
        })
      : null;
  try {
    const { env } = runtimeEnvironment(runtime);

    runPackageManager(['build'], { env, label: 'pnpm build' });

    // The app-runtime owns and locks the local data root while its explicit,
    // idempotent schema hook runs. This keeps first install and concurrent
    // setup attempts on the same secure path.
    let initialized = null;
    if (runtime.profile === 'local') {
      initialized = await initializeLocal(runtime, env, {
        prepareDatabase: true,
      });
    } else {
      runPackageManager(['exec', 'smrt', 'db:migrate'], {
        env,
        label: 'pnpm exec smrt db:migrate',
      });
    }
    const port = env.PORT || '5173';
    const onboardingUrl = initialized?.bootstrap
      ? `http://127.0.0.1:${port}/setup?token=${encodeURIComponent(initialized.bootstrap.token)}`
      : null;
    const diagnostics = await initialized?.runtime.diagnostics();
    if (onboardingUrl) saveOnboardingUrl(onboardingUrl);
    if (diagnostics?.bootstrap.status === 'claimed') {
      removeOnboardingHandoff();
    }
    await initialized?.runtime.db.close?.();

    const retainedOnboardingUrl = onboardingUrl || readOnboardingUrl();
    const onboardingAvailable =
      runtime.profile === 'local' && retainedOnboardingUrl !== null;
    const report = {
      schemaVersion: 1,
      status: 'ready',
      profile: runtime.profile,
      onboardingAvailable,
      onboardingRecovery: onboardingAvailable ? 'pnpm app:open' : null,
      secretValuesIncluded: false,
    };
    console.log(JSON.stringify(report, null, 2));
    return { ...report, onboardingUrl: retainedOnboardingUrl };
  } finally {
    operatorLease?.release();
  }
}

async function recoverOnboarding(operationLock) {
  const runtime = await resolveRuntime();
  const { env } = runtimeEnvironment(runtime);
  if (runtime.profile !== 'local') {
    throw new Error('Owner onboarding recovery is local-only.');
  }
  const operatorLease = acquireWriterLease(preparedStateRoot(), {
    operationInstance: operationLock?.instance,
  });
  try {
    const initialized = await initializeLocal(runtime, env);
    if (!initialized) throw new Error('Local runtime initialization failed.');
    const invitation = await initialized.runtime.rotateBootstrapInvitation();
    const url = `http://127.0.0.1:${env.PORT || '5173'}/setup?token=${encodeURIComponent(invitation.token)}`;
    saveOnboardingUrl(url);
    await initialized.runtime.db.close?.();
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        onboardingAvailable: true,
        recovery: 'Run pnpm app:start, then pnpm app:open.',
        secretValuesIncluded: false,
      }),
    );
  } finally {
    operatorLease.release();
  }
}

async function waitForReady(url, pid, instance, configuration) {
  const healthUrl = new URL('/api/_runtime/health', url);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(healthUrl, { redirect: 'manual' });
      if (response.status === 200) {
        const health = await response.json();
        if (
          health?.status === 'ready' &&
          health.application === appId &&
          health.instance === instance &&
          health.configuration === configuration
        ) {
          process.kill(pid, 0);
          return;
        }
      }
      process.kill(pid, 0);
    } catch {
      try {
        process.kill(pid, 0);
      } catch {
        throw new Error(
          'The application process exited before becoming ready.',
        );
      }
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`The application did not become ready at ${url}.`);
}

async function start(operationLock) {
  const runtime = await assertLocalOperation('app:start');
  const { env } = runtimeEnvironment(runtime);
  const url = `http://127.0.0.1:${env.PORT || '5173'}/`;
  const configuration = runtimeConfigurationFingerprint(runtime, env);
  const existing = readProcess();
  if (existing) {
    await waitForReady(url, existing.pid, existing.instance, configuration);
    console.log(
      JSON.stringify({ schemaVersion: 1, status: 'running', pid: existing.pid }),
    );
    return existing.pid;
  }
  ensurePrivateDirectory(preparedStateRoot());
  const instance = randomBytes(16).toString('hex');
  const child = spawn(
    process.execPath,
    ['scripts/smrt-web.mjs', `--smrt-instance=${instance}`],
    {
      cwd: sourceRoot,
      env: {
        ...env,
        HOST:
          runtime.profile === 'local' ? '127.0.0.1' : env.HOST || '0.0.0.0',
        PORT: env.PORT || '5173',
        SMRT_PROCESS_INSTANCE: instance,
        SMRT_OPERATION_INSTANCE: operationLock?.instance,
      },
      detached: true,
      stdio: 'ignore',
    },
  );
  child.unref();
  writeProcessRecord(pidPath(), { pid: child.pid, instance });
  try {
    await waitForReady(url, child.pid, instance, configuration);
  } catch (error) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch {
      // The child already exited; stale process state is removed below.
    }
    rmSync(pidPath(), { force: true });
    throw error;
  }
  console.log(
    JSON.stringify({ schemaVersion: 1, status: 'started', pid: child.pid }),
  );
  return child.pid;
}

async function stop() {
  const pid = readPid();
  if (!pid) {
    rmSync(pidPath(), { force: true });
    console.log(JSON.stringify({ schemaVersion: 1, status: 'stopped' }));
    return;
  }
  if (!sendTerminationSignal(pid)) {
    // The process exited after its identity was verified but before SIGTERM.
    rmSync(pidPath(), { force: true });
    console.log(JSON.stringify({ schemaVersion: 1, status: 'stopped', pid }));
    return;
  }
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    if (attempt === 39) {
      throw new Error(`Application process ${pid} did not stop cleanly.`);
    }
  }
  rmSync(pidPath(), { force: true });
  console.log(JSON.stringify({ schemaVersion: 1, status: 'stopped', pid }));
}

function openBrowser(url) {
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
  run(binary, args);
}

async function open() {
  const runtime = await resolveRuntime();
  const host =
    runtime.profile === 'local'
      ? '127.0.0.1'
      : process.env.HOST || '127.0.0.1';
  const url = `http://${host}:${process.env.PORT || '5173'}/`;
  const onboardingUrl =
    runtime.profile === 'local' ? readOnboardingUrl() : null;
  if (onboardingUrl) saveOnboardingLaunch(onboardingUrl);
  const destination = onboardingUrl
    ? pathToFileURL(onboardingLaunchPath()).toString()
    : url;
  openBrowser(destination);
  console.log(JSON.stringify({ schemaVersion: 1, status: 'opened', url }));
}

async function doctor() {
  const findings = [];
  let runtime = null;
  let paths = null;
  let statePath = null;
  let canInspectMigrations = false;
  try {
    runtime = await resolveRuntime();
  } catch {
    findings.push({
      code: 'invalid-runtime-profile',
      severity: 'error',
      message: 'The canonical runtime profile is invalid.',
      recovery: 'Select local, self-hosted, or cloud in smrt.config.ts.',
    });
  }

  if (Number(process.versions.node.split('.')[0]) < 24) {
    findings.push({
      code: 'unsupported-node',
      severity: 'error',
      message: 'Node.js 24 or newer is required.',
      recovery: 'Install the Node.js version declared in package.json engines.',
    });
  }

  if (runtime) {
    if (runtime.profile !== 'local') {
      for (const [component, provider] of [
        ['authentication', runtime.providers.authentication.provider],
        ['assets', runtime.providers.assets.provider],
        ['secrets', runtime.providers.secrets.provider],
      ]) {
        try {
          await createProviderReadinessProbe(component, {
            profile: runtime.profile,
            provider,
          })();
        } catch {
          findings.push({
            code: 'provider-not-configured',
            component,
            severity: 'error',
            message: `The ${component} provider is not ready.`,
            recovery: `Configure and verify the installed ${component} provider readiness module.`,
          });
        }
      }
    }
    try {
      ({ paths } = runtimeEnvironment(runtime));
      statePath = resolveApplicationStateRoot({
        appId,
        dataDirectory: process.env.SMRT_DATA_DIR,
        sourceRoot,
      });
      accessSync(nearestExistingAncestor(statePath), constants.W_OK);
      if (runtime.profile === 'local') {
        paths = await validateLocalDatabaseStorage({
          appId,
          dataDirectory: process.env.SMRT_DATA_DIR,
          sourceRoot,
        });
      }
      canInspectMigrations = true;
      const host =
        process.env.HOST ||
        (runtime.profile === 'local' ? '127.0.0.1' : '0.0.0.0');
      if (
        runtime.profile === 'local' &&
        host !== '127.0.0.1' &&
        host !== '::1'
      ) {
        findings.push({
          code: 'unsafe-local-bind',
          severity: 'error',
          message: 'Local owner bootstrap may only bind to a loopback address.',
          recovery: 'Unset HOST or set HOST=127.0.0.1.',
        });
      }
      if (paths?.root) {
        const writableParent = nearestExistingAncestor(paths.root);
        accessSync(writableParent, constants.W_OK);
      }
    } catch (error) {
      findings.push({
        code: 'runtime-path-unavailable',
        severity: 'error',
        message: 'A required runtime path or provider configuration is unavailable.',
        recovery:
          error instanceof Error
            ? error.message
            : 'Configure a writable runtime data path.',
      });
    }

    if (canInspectMigrations) try {
      const status = runPackageManager(
        ['exec', 'smrt', 'db:status', '--json'],
        {
          env: runtimeEnvironment(runtime).env,
          capture: true,
          allowFailure: true,
          label: 'pnpm exec smrt db:status --json',
        },
      );
      if (status.status !== 0) {
        findings.push({
          code: 'migration-status-failed',
          severity: 'error',
          message: 'Database migration status could not be verified.',
          recovery: 'Run pnpm app:setup and inspect the private migration logs.',
        });
      } else {
        const migrationStatus = JSON.parse(status.stdout || '{}');
        const migrationRequired =
          (migrationStatus.drift?.length || 0) > 0 ||
          (migrationStatus.migrations?.failed?.actionRequired || 0) > 0 ||
          migrationStatus.schemaContract?.ok === false ||
          migrationStatus.preconditions?.some((item) => item.status === 'error');
        if (migrationRequired) {
          findings.push({
            code: 'migration-required',
            severity: 'error',
            message: 'Database migrations are pending or failed.',
            recovery: 'Run pnpm app:setup, then rerun pnpm app:doctor.',
          });
        }
      }
    } catch {
      findings.push({
        code: 'migration-status-failed',
        severity: 'error',
        message: 'Database migration status could not be parsed.',
        recovery: 'Run pnpm app:setup and inspect the private migration logs.',
      });
    }
  }

  const report = {
    schemaVersion: 1,
    status: findings.some((finding) => finding.severity === 'error')
      ? 'error'
      : 'ready',
    profile: runtime?.profile || null,
    capabilities: runtime?.capabilities || null,
    paths:
      paths || statePath
        ? {
            root: paths?.root || null,
            database: paths?.database || null,
            assets: paths?.assets || null,
            state: statePath,
          }
        : null,
    findings,
    secretValuesIncluded: false,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'error') process.exitCode = 1;
}

async function backup(operationLock) {
  const runtime = await resolveRuntime();
  if (runtime.profile !== 'local') {
    throw new Error(
      'This scaffold delegates deployed backups to the selected operator or managed provider.',
    );
  }
  const explicitDestination = commandArgs[0]
    ? assertExternalArtifactPath({
        sourceRoot,
        path: resolve(commandArgs[0]),
        label: 'Backup destination',
      })
    : null;
  const paths = await validateLocalDatabaseStorage({
    appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot,
  });
  const operatorLease = acquireWriterLease(preparedStateRoot(), {
    operationInstance: operationLock?.instance,
  });
  try {
    const destination = assertExternalArtifactPath({
      sourceRoot,
      path:
        explicitDestination ||
        join(
          dirname(paths.root),
          'backups',
          `${appId}-${new Date().toISOString().replaceAll(':', '-')}`,
        ),
      label: 'Backup destination',
    });
    ensurePrivateDirectory(dirname(destination));
    try {
      mkdirSync(destination, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(`Backup destination already exists: ${destination}`);
      }
      throw error;
    }
    try {
      cpSync(paths.root, destination, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    } catch (error) {
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
    console.log(
      JSON.stringify({ schemaVersion: 1, status: 'backed-up', destination }),
    );
  } finally {
    operatorLease.release();
  }
}

async function portability(operation, operationLock) {
  const adapterPath = join(sourceRoot, 'scripts', 'smrt-portability.mjs');
  const adapter = await import(pathToFileURL(adapterPath).href);
  const runtime = await resolveRuntime();
  const environment = runtimeEnvironment(runtime);
  const requestedPath = commandArgs[0] ? resolve(commandArgs[0]) : undefined;
  const artifactPath =
    requestedPath
      ? assertExternalArtifactPath({
          sourceRoot,
          path: requestedPath,
          label:
            operation === 'export' ? 'Export destination' : 'Import source',
        })
      : requestedPath;
  if (runtime.profile === 'local') {
    environment.paths = await validateLocalDatabaseStorage({
      appId,
      dataDirectory: process.env.SMRT_DATA_DIR,
      sourceRoot,
    });
  }
  const context = {
    appId,
    sourceRoot,
    stateRoot: preparedStateRoot(),
    runtime,
    ...environment,
  };
  let operatorLease = null;
  if (operation === 'import') {
    if (runtime.profile === 'local') {
      operatorLease = acquireWriterLease(preparedStateRoot(), {
        operationInstance: operationLock?.instance,
      });
    }
    if (
      runtime.profile !== 'local' &&
      process.env.SMRT_MAINTENANCE_MODE !== 'true'
    ) {
      throw new Error(
        'Stop deployed web/workers and set SMRT_MAINTENANCE_MODE=true before importing.',
      );
    }
  }
  try {
    const result = await adapter[
      operation === 'export' ? 'exportApplication' : 'importApplication'
    ]({
      ...context,
      path: artifactPath,
    });
    console.log(
      JSON.stringify(
        { schemaVersion: 1, status: `${operation}ed`, ...result },
        null,
        2,
      ),
    );
  } finally {
    operatorLease?.release();
  }
}

try {
  switch (command) {
    case 'install': {
      await assertLocalOperation('app:install');
      await withOperationLock(preparedStateRoot(), 'install', async (lock) => {
        const report = await setup(lock);
        await start(lock);
        const baseUrl = `http://127.0.0.1:${process.env.PORT || '5173'}/`;
        if (report.onboardingUrl) {
          saveOnboardingLaunch(report.onboardingUrl);
        }
        openBrowser(
          report.onboardingUrl
            ? pathToFileURL(onboardingLaunchPath()).toString()
            : baseUrl,
        );
      });
      break;
    }
    case 'setup':
      await withOperationLock(preparedStateRoot(), command, setup);
      break;
    case 'recover':
      await assertLocalOperation('app:recover');
      await withOperationLock(preparedStateRoot(), command, recoverOnboarding);
      break;
    case 'start':
      await assertLocalOperation('app:start');
      await withOperationLock(preparedStateRoot(), command, start);
      break;
    case 'doctor':
      await doctor();
      break;
    case 'open':
      await open();
      break;
    case 'stop':
      await assertLocalOperation('app:stop');
      await withOperationLock(preparedStateRoot(), command, stop);
      break;
    case 'backup':
      await withOperationLock(preparedStateRoot(), command, backup);
      break;
    case 'export':
    case 'import':
      await withOperationLock(preparedStateRoot(), command, (lock) =>
        portability(command, lock),
      );
      break;
    default:
      throw new Error(`Unknown app operation: ${command}`);
  }
} catch (error) {
  console.error(
    JSON.stringify({
      schemaVersion: 1,
      status: 'error',
      code: 'operation-failed',
      message:
        error instanceof Error
          ? error.message
          : 'Application operation failed.',
      recovery: 'Run pnpm app:doctor and follow its recovery instructions.',
      secretValuesIncluded: false,
    }),
  );
  process.exitCode = 1;
}
