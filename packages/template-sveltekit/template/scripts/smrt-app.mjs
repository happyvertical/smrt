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
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  initializeLocalApplicationRuntime,
  resolveLocalRuntimePaths,
} from '@happyvertical/smrt-app-runtime';
import {
  loadConfig,
  resolveConfiguredApplicationRuntime,
} from '@happyvertical/smrt-config';
import {
  readOwnedProcess,
  writeProcessRecord,
} from './smrt-process.mjs';

const sourceRoot = process.cwd();
const packageJson = JSON.parse(
  readFileSync(join(sourceRoot, 'package.json'), 'utf8'),
);
const appId = String(
  process.env.SMRT_APP_ID || packageJson.name || basename(sourceRoot),
)
  .toLowerCase()
  .replace(/[^a-z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '');
const command = process.argv[2] || 'doctor';
const rawCommandArgs = process.argv.slice(3);
const commandArgs =
  rawCommandArgs[0] === '--' ? rawCommandArgs.slice(1) : rawCommandArgs;

function stateRoot() {
  if (process.env.SMRT_STATE_DIR) return resolve(process.env.SMRT_STATE_DIR);
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', appId, 'state');
  }
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA || homedir(), appId, 'state');
  }
  return join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    appId,
  );
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function pidPath() {
  return join(stateRoot(), 'app.pid');
}

function readPid() {
  return readOwnedProcess(pidPath())?.pid || null;
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: sourceRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error || result.status !== 0) {
    const error = new Error(`${binary} ${args.join(' ')} failed`);
    error.exitCode = result.status ?? 1;
    throw error;
  }
  return result;
}

async function resolveRuntime() {
  await loadConfig({ cache: false });
  return resolveConfiguredApplicationRuntime();
}

function runtimeEnvironment(runtime) {
  const env = {
    ...process.env,
    SMRT_APP_ID: appId,
    SMRT_RUNTIME_PROFILE: runtime.profile,
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
    return { env, paths };
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      `${runtime.profile} requires DATABASE_URL; copy the matching env example and configure providers.`,
    );
  }
  env.DATABASE_TYPE = 'postgres';
  return { env, paths: null };
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
          run('pnpm', ['exec', 'smrt', 'db:migrate'], { env });
        }
      : undefined,
    backgroundJobs: process.env.SMRT_BACKGROUND_JOBS === 'true',
  });
  return initialized;
}

async function setup() {
  const runtime = await resolveRuntime();
  const { env } = runtimeEnvironment(runtime);

  run('pnpm', ['build'], { env });

  // The app-runtime owns and locks the local data root while its explicit,
  // idempotent schema hook runs. This keeps first install and concurrent
  // setup attempts on the same secure path.
  let initialized = null;
  if (runtime.profile === 'local') {
    initialized = await initializeLocal(runtime, env, {
      prepareDatabase: true,
    });
  } else {
    run('pnpm', ['exec', 'smrt', 'db:migrate'], { env });
  }
  const port = env.PORT || '5173';
  const onboardingUrl = initialized?.bootstrap
    ? `http://127.0.0.1:${port}/setup?token=${encodeURIComponent(initialized.bootstrap.token)}`
    : null;
  await initialized?.runtime.db.close?.();

  const report = {
    schemaVersion: 1,
    status: 'ready',
    profile: runtime.profile,
    onboardingAvailable: onboardingUrl !== null,
    secretValuesIncluded: false,
  };
  console.log(JSON.stringify(report, null, 2));
  return { ...report, onboardingUrl };
}

async function waitForReady(url, pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return;
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

async function start() {
  const existing = readPid();
  if (existing) {
    console.log(
      JSON.stringify({ schemaVersion: 1, status: 'running', pid: existing }),
    );
    return existing;
  }
  const runtime = await resolveRuntime();
  const { env } = runtimeEnvironment(runtime);
  ensurePrivateDirectory(stateRoot());
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
      },
      detached: true,
      stdio: 'ignore',
    },
  );
  child.unref();
  writeProcessRecord(pidPath(), { pid: child.pid, instance });
  const url = `http://127.0.0.1:${env.PORT || '5173'}/`;
  try {
    await waitForReady(url, child.pid);
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
  process.kill(pid, 'SIGTERM');
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
  openBrowser(url);
  console.log(JSON.stringify({ schemaVersion: 1, status: 'opened', url }));
}

async function doctor() {
  const findings = [];
  let runtime = null;
  let paths = null;
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
    try {
      ({ paths } = runtimeEnvironment(runtime));
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
      const writableTarget = paths?.root || stateRoot();
      const writableParent = existsSync(writableTarget)
        ? writableTarget
        : dirname(writableTarget);
      accessSync(writableParent, constants.W_OK);
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

    try {
      const status = spawnSync('pnpm', ['exec', 'smrt', 'db:status', '--json'], {
        cwd: sourceRoot,
        env: runtimeEnvironment(runtime).env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
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
    paths: paths
      ? { root: paths.root, database: paths.database, assets: paths.assets }
      : null,
    findings,
    secretValuesIncluded: false,
  };
  console.log(JSON.stringify(report, null, 2));
  if (report.status === 'error') process.exitCode = 1;
}

async function backup() {
  const runtime = await resolveRuntime();
  const { paths } = runtimeEnvironment(runtime);
  if (runtime.profile !== 'local' || !paths) {
    throw new Error(
      'This scaffold delegates deployed backups to the selected operator or managed provider.',
    );
  }
  if (readPid()) {
    throw new Error(
      'Stop the application before creating a consistent local backup.',
    );
  }
  const destination = resolve(
    commandArgs[0] ||
      join(
        dirname(paths.root),
        'backups',
        `${appId}-${new Date().toISOString().replaceAll(':', '-')}`,
      ),
  );
  if (existsSync(destination)) {
    throw new Error(`Backup destination already exists: ${destination}`);
  }
  ensurePrivateDirectory(dirname(destination));
  cpSync(paths.root, destination, { recursive: true, errorOnExist: true });
  console.log(
    JSON.stringify({ schemaVersion: 1, status: 'backed-up', destination }),
  );
}

async function portability(operation) {
  const adapterPath = join(sourceRoot, 'scripts', 'smrt-portability.mjs');
  const adapter = await import(pathToFileURL(adapterPath).href);
  const runtime = await resolveRuntime();
  const context = {
    appId,
    sourceRoot,
    stateRoot: stateRoot(),
    runtime,
    ...runtimeEnvironment(runtime),
  };
  const result = await adapter[
    operation === 'export' ? 'exportApplication' : 'importApplication'
  ]({
    ...context,
    path: commandArgs[0] ? resolve(commandArgs[0]) : undefined,
  });
  console.log(
    JSON.stringify(
      { schemaVersion: 1, status: `${operation}ed`, ...result },
      null,
      2,
    ),
  );
}

try {
  switch (command) {
    case 'install': {
      const report = await setup();
      await start();
      openBrowser(
        report.onboardingUrl ||
          `http://127.0.0.1:${process.env.PORT || '5173'}/`,
      );
      break;
    }
    case 'setup':
      await setup();
      break;
    case 'start':
      await start();
      break;
    case 'doctor':
      await doctor();
      break;
    case 'open':
      await open();
      break;
    case 'stop':
      await stop();
      break;
    case 'backup':
      await backup();
      break;
    case 'export':
    case 'import':
      await portability(command);
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
