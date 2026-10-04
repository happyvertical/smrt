/**
 * Local/deployed application operations: install, setup, recover, start,
 * stop, doctor, open, backup, export, import.
 *
 * Ported from the template's `scripts/smrt-app.mjs`. Output JSON, exit
 * codes, state files, and environment variables are unchanged so the
 * template's `pnpm app:*` scripts can become `smrt app <operation>`.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  acquireWriterLease,
  createProviderReadinessProbe,
  type OperationLock,
  withOperationLock,
} from '@happyvertical/smrt-app-runtime';
import type { ResolvedApplicationRuntime } from '@happyvertical/smrt-config';
import {
  ApplicationStartError,
  boundedTail,
  errorCode,
  redactSecrets,
} from './errors.js';
import {
  assertExternalArtifactPath,
  resolveApplicationStateRoot,
  runtimeConfigurationFingerprint,
} from './identity.js';
import type {
  ExportResult,
  ImportResult,
  PortabilityContext,
} from './portability.js';
import {
  checkOwnedProcess,
  readOwnedProcess,
  sendTerminationSignal,
  writeProcessRecord,
} from './process-record.js';
import {
  type AppContext,
  preparedStateRoot,
  runtimeEnvironment,
  webLauncherPath,
} from './runtime.js';

/** Operations implemented by this module. */
export const APP_OPERATIONS = [
  'install',
  'setup',
  'recover',
  'start',
  'stop',
  'doctor',
  'open',
  'backup',
  'export',
  'import',
] as const;

/** One of {@link APP_OPERATIONS}. */
export type AppOperation = (typeof APP_OPERATIONS)[number];

/** Report printed by `setup`; `onboardingUrl` is never in this JSON. */
interface SetupReport {
  schemaVersion: 1;
  status: 'ready';
  profile: string;
  onboardingAvailable: boolean;
  onboardingRecovery: string | null;
  secretValuesIncluded: false;
}

function printJson(context: AppContext, value: unknown, pretty = false): void {
  context.io.stdout(
    `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`,
  );
}

/** Print the one-time URL to the operator's terminal only, never to logs. */
function printOnboardingUrl(context: AppContext, url: string | null): void {
  if (!url || !context.io.operatorTerminal) return;
  context.io.operatorTerminal(
    `Open this one-time owner setup link on this device (it works once and expires):\n  ${url}\n`,
  );
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

function nearestExistingAncestor(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function pidPath(context: AppContext): string {
  return join(preparedStateRoot(context), 'app.pid');
}

function onboardingPath(context: AppContext): string {
  return join(preparedStateRoot(context), 'onboarding.json');
}

function onboardingLaunchPath(context: AppContext): string {
  return join(preparedStateRoot(context), 'onboarding-launch.html');
}

function removeOnboardingHandoff(context: AppContext): void {
  rmSync(onboardingPath(context), { force: true });
  rmSync(onboardingLaunchPath(context), { force: true });
}

function writePrivateAtomic(destination: string, contents: string): void {
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function saveOnboardingLaunch(context: AppContext, url: string): void {
  const escapedUrl = url.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  writePrivateAtomic(
    onboardingLaunchPath(context),
    `<!doctype html><meta http-equiv="refresh" content="0;url=${escapedUrl}">\n`,
  );
}

function saveOnboardingUrl(context: AppContext, url: string): void {
  ensurePrivateDirectory(preparedStateRoot(context));
  saveOnboardingLaunch(context, url);
  writePrivateAtomic(
    onboardingPath(context),
    `${JSON.stringify({ schemaVersion: 1, url })}\n`,
  );
}

class InvalidOnboardingHandoff extends Error {}

/** Read the retained loopback onboarding URL; tampered handoffs are removed. */
function readOnboardingUrl(context: AppContext): string | null {
  try {
    const value = JSON.parse(readFileSync(onboardingPath(context), 'utf8')) as {
      schemaVersion?: unknown;
      url?: unknown;
    } | null;
    if (value?.schemaVersion !== 1 || typeof value.url !== 'string') {
      throw new InvalidOnboardingHandoff('Invalid onboarding handoff.');
    }
    const url = new URL(value.url);
    if (
      url.protocol !== 'http:' ||
      (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') ||
      url.pathname !== '/setup'
    ) {
      throw new InvalidOnboardingHandoff('Invalid onboarding handoff.');
    }
    return url.toString();
  } catch (error) {
    if (
      errorCode(error) === 'ENOENT' ||
      error instanceof SyntaxError ||
      error instanceof InvalidOnboardingHandoff ||
      errorCode(error) === 'ERR_INVALID_URL'
    ) {
      removeOnboardingHandoff(context);
      return null;
    }
    throw error;
  }
}

/** Throw unless the configured profile is `local`. */
export async function assertLocalOperation(
  context: AppContext,
  operation: string,
): Promise<ResolvedApplicationRuntime> {
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  if (runtime.profile !== 'local') {
    throw new Error(
      `${operation} is local-profile only; run the production Node build or container for deployed profiles.`,
    );
  }
  return runtime;
}

async function initializeLocal(
  context: AppContext,
  runtime: ResolvedApplicationRuntime,
  env: NodeJS.ProcessEnv,
  options: { prepareDatabase?: boolean } = {},
) {
  if (runtime.profile !== 'local') return null;
  return context.deps.runtime.initializeLocalApplicationRuntime({
    appId: context.appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot: context.sourceRoot,
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
          context.deps.runSmrt(['db:migrate'], {
            env,
            label: 'smrt db:migrate',
          });
        }
      : undefined,
    backgroundJobs: process.env.SMRT_BACKGROUND_JOBS === 'true',
  });
}

async function setup(
  context: AppContext,
  operationLock?: OperationLock,
): Promise<SetupReport & { onboardingUrl: string | null }> {
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  const operatorLease =
    runtime.profile === 'local'
      ? acquireWriterLease(preparedStateRoot(context), {
          operationInstance: operationLock?.instance,
        })
      : null;
  try {
    const { env } = runtimeEnvironment(context, runtime);

    context.deps.runPackageManager(['build'], { env, label: 'pnpm build' });

    // The app-runtime owns and locks the local data root while its explicit,
    // idempotent schema hook runs. This keeps first install and concurrent
    // setup attempts on the same secure path.
    let initialized: Awaited<ReturnType<typeof initializeLocal>> = null;
    if (runtime.profile === 'local') {
      initialized = await initializeLocal(context, runtime, env, {
        prepareDatabase: true,
      });
    } else {
      context.deps.runSmrt(['db:migrate'], { env, label: 'smrt db:migrate' });
    }
    const port = env.PORT || '5173';
    const onboardingUrl = initialized?.bootstrap
      ? `http://127.0.0.1:${port}/setup?token=${encodeURIComponent(initialized.bootstrap.token)}`
      : null;
    const diagnostics = await initialized?.runtime.diagnostics();
    if (onboardingUrl) saveOnboardingUrl(context, onboardingUrl);
    if (diagnostics?.bootstrap.status === 'claimed') {
      removeOnboardingHandoff(context);
    }
    await initialized?.runtime.db.close?.();

    const retainedOnboardingUrl = onboardingUrl || readOnboardingUrl(context);
    const onboardingAvailable =
      runtime.profile === 'local' && retainedOnboardingUrl !== null;
    const report: SetupReport = {
      schemaVersion: 1,
      status: 'ready',
      profile: runtime.profile,
      onboardingAvailable,
      onboardingRecovery: onboardingAvailable ? 'pnpm app:open' : null,
      secretValuesIncluded: false,
    };
    printJson(context, report, true);
    return { ...report, onboardingUrl: retainedOnboardingUrl };
  } finally {
    operatorLease?.release();
  }
}

async function recoverOnboarding(
  context: AppContext,
  operationLock?: OperationLock,
): Promise<void> {
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  const { env } = runtimeEnvironment(context, runtime);
  if (runtime.profile !== 'local') {
    throw new Error('Owner onboarding recovery is local-only.');
  }
  const operatorLease = acquireWriterLease(preparedStateRoot(context), {
    operationInstance: operationLock?.instance,
  });
  try {
    const initialized = await initializeLocal(context, runtime, env);
    if (!initialized) throw new Error('Local runtime initialization failed.');
    const invitation = await initialized.runtime.rotateBootstrapInvitation();
    const url = `http://127.0.0.1:${env.PORT || '5173'}/setup?token=${encodeURIComponent(invitation.token)}`;
    saveOnboardingUrl(context, url);
    await initialized.runtime.db.close?.();
    printJson(context, {
      schemaVersion: 1,
      status: 'ready',
      onboardingAvailable: true,
      recovery: 'Run pnpm app:start, then pnpm app:open.',
      secretValuesIncluded: false,
    });
    printOnboardingUrl(context, url);
  } finally {
    operatorLease.release();
  }
}

function isAlive(pid: number): boolean {
  process.kill(pid, 0);
  return true;
}

async function waitForReady(
  context: AppContext,
  url: string,
  pid: number,
  instance: string,
  configuration: string,
): Promise<void> {
  const healthUrl = new URL('/api/_runtime/health', url);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await context.deps.fetch(healthUrl, {
        redirect: 'manual',
      });
      if (response.status === 200) {
        const health = (await response.json()) as Record<string, unknown>;
        if (
          health?.status === 'ready' &&
          health.application === context.appId &&
          health.instance === instance &&
          health.configuration === configuration
        ) {
          isAlive(pid);
          return;
        }
      }
      isAlive(pid);
    } catch {
      try {
        isAlive(pid);
      } catch {
        throw new Error(
          'The application process exited before becoming ready.',
        );
      }
    }
    await context.deps.sleep(250);
  }
  throw new Error(`The application did not become ready at ${url}.`);
}

async function start(
  context: AppContext,
  operationLock?: OperationLock,
): Promise<number> {
  const runtime = await assertLocalOperation(context, 'app:start');
  const { env } = runtimeEnvironment(context, runtime);
  const url = `http://127.0.0.1:${env.PORT || '5173'}/`;
  env.ORIGIN ||= url;
  const configuration = runtimeConfigurationFingerprint(runtime, env);
  const existing = readOwnedProcess(pidPath(context));
  if (existing) {
    await waitForReady(
      context,
      url,
      existing.pid,
      existing.instance,
      configuration,
    );
    printJson(context, {
      schemaVersion: 1,
      status: 'running',
      pid: existing.pid,
    });
    return existing.pid;
  }
  ensurePrivateDirectory(preparedStateRoot(context));
  const instance = randomBytes(16).toString('hex');
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    HOST: runtime.profile === 'local' ? '127.0.0.1' : env.HOST || '0.0.0.0',
    PORT: env.PORT || '5173',
    SMRT_PROCESS_INSTANCE: instance,
    SMRT_OPERATION_INSTANCE: operationLock?.instance,
  };
  // The detached server outlives this command, so its output goes to a
  // private file rather than a pipe that would close (EPIPE) on our exit.
  const logFile = startLogPath(context);
  const logFd = openStartLog(logFile);
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [webLauncherPath(), `--smrt-instance=${instance}`],
      {
        cwd: context.sourceRoot,
        env: childEnv,
        detached: true,
        stdio: ['ignore', logFd, logFd],
      },
    );
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('The application process could not be started.');
  }
  writeProcessRecord(pidPath(context), { pid, instance });
  try {
    await waitForReady(context, url, pid, instance, configuration);
  } catch (error) {
    if (!(await terminateFailedStart(context, child))) {
      // Never drop the only handle `smrt app stop` has on a live writer.
      throw new Error(
        `${error instanceof Error ? error.message : 'The application did not become ready.'} Application process ${pid} did not exit after SIGTERM and SIGKILL and remains recorded; run pnpm app:stop.`,
      );
    }
    rmSync(pidPath(context), { force: true });
    throw new ApplicationStartError(
      error instanceof Error
        ? error.message
        : 'The application did not become ready.',
      redactedLogTail(logFile, childEnv),
      logFile,
    );
  }
  printJson(context, { schemaVersion: 1, status: 'started', pid });
  return pid;
}

/** Upper bound on the web-process output a failed `start` reports. */
export const START_OUTPUT_TAIL_BYTES = 8 * 1024;

/** Window read before redaction, so a cut never splits a reported secret. */
const START_OUTPUT_WINDOW_BYTES = 64 * 1024;

function startLogPath(context: AppContext): string {
  return join(preparedStateRoot(context), 'app.log');
}

/**
 * Create a fresh 0600 `app.log` for this start. The previous run's log is
 * removed first and the new one is created exclusively, so a planted link or
 * file is never written through.
 */
function openStartLog(path: string): number {
  rmSync(path, { force: true });
  return openSync(path, 'wx', 0o600);
}

/**
 * The last {@link START_OUTPUT_TAIL_BYTES} of `path`, strictly redacted
 * against the child's environment. A bounded window is redacted before it is cut, and a
 * window that starts mid-file drops its leading partial record (all of it
 * when the window holds no newline), so no fragment of a secret whose
 * prefix lies before the window can survive the cut.
 */
function redactedLogTail(path: string, env: NodeJS.ProcessEnv): string {
  let text: string;
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, START_OUTPUT_WINDOW_BYTES);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      text = buffer.toString('utf8');
      if (length < size) {
        // No newline: the whole window is one record's suffix.
        const newline = text.indexOf('\n');
        text = newline === -1 ? '' : text.slice(newline + 1);
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
  // Strict: child output is arbitrary text, so no length floor applies.
  return boundedTail(
    redactSecrets(text, env, { strict: true }),
    START_OUTPUT_TAIL_BYTES,
  );
}

/**
 * Terminate a launcher that failed to prove readiness: SIGTERM, wait, then
 * SIGKILL, wait. Resolves `true` only once the child has provably exited.
 * Uses the child handle we own, so a reaped pid is never signalled.
 */
async function terminateFailedStart(
  context: AppContext,
  child: ChildProcess,
): Promise<boolean> {
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  for (const [signal, attempts] of [
    ['SIGTERM', 50],
    ['SIGKILL', 20],
  ] as const) {
    if (exited()) return true;
    try {
      context.deps.signal(child.pid as number, signal);
    } catch (error) {
      if (errorCode(error) === 'ESRCH') return true;
      throw error;
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await context.deps.sleep(100);
      if (exited()) return true;
    }
  }
  return exited();
}

async function stop(context: AppContext): Promise<void> {
  const record = readOwnedProcess(pidPath(context));
  const pid = record?.pid || null;
  if (!record || !pid) {
    rmSync(pidPath(context), { force: true });
    printJson(context, { schemaVersion: 1, status: 'stopped' });
    return;
  }
  // Re-prove identity immediately before signalling: the pid may have exited
  // and been recycled since the record was read. A failed query proves
  // nothing, so it keeps the record and sends no signal.
  const state = checkOwnedProcess(record);
  if (state === 'unverifiable') {
    throw new Error(
      `Application process ${pid} is live but its identity could not be re-verified; app.pid was kept and no signal was sent. Retry pnpm app:stop.`,
    );
  }
  if (state !== 'owned' || !sendTerminationSignal(pid)) {
    // The process exited after its identity was verified but before SIGTERM.
    rmSync(pidPath(context), { force: true });
    printJson(context, { schemaVersion: 1, status: 'stopped', pid });
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
  rmSync(pidPath(context), { force: true });
  printJson(context, { schemaVersion: 1, status: 'stopped', pid });
}

async function open(context: AppContext): Promise<void> {
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  const host =
    runtime.profile === 'local' ? '127.0.0.1' : process.env.HOST || '127.0.0.1';
  const url = `http://${host}:${process.env.PORT || '5173'}/`;
  const onboardingUrl =
    runtime.profile === 'local' ? readOnboardingUrl(context) : null;
  if (onboardingUrl) saveOnboardingLaunch(context, onboardingUrl);
  const destination = onboardingUrl
    ? pathToFileURL(onboardingLaunchPath(context)).toString()
    : url;
  context.deps.openBrowser(destination);
  printJson(context, { schemaVersion: 1, status: 'opened', url });
}

interface DoctorFinding {
  code: string;
  severity: 'error' | 'warning';
  message: string;
  recovery: string;
  component?: string;
}

async function doctor(context: AppContext): Promise<number> {
  const findings: DoctorFinding[] = [];
  let runtime: ResolvedApplicationRuntime | null = null;
  let paths: { root?: string; database?: string; assets?: string } | null =
    null;
  let statePath: string | null = null;
  let canInspectMigrations = false;
  try {
    runtime = await context.deps.resolveRuntime(context.sourceRoot);
  } catch {
    findings.push({
      code: 'invalid-runtime-profile',
      severity: 'error',
      message: 'The canonical runtime profile is invalid.',
      recovery: 'Select local, self-hosted, or cloud in smrt.config.ts.',
    });
  }

  if (Number(process.versions.node.split('.')[0]) < 26) {
    findings.push({
      code: 'unsupported-node',
      severity: 'error',
      message: 'Node.js 26 or newer is required.',
      recovery: 'Install the Node.js version declared in package.json engines.',
    });
  }

  if (runtime) {
    if (runtime.profile !== 'local') {
      for (const [component, provider] of [
        ['authentication', runtime.providers.authentication.provider],
        ['assets', runtime.providers.assets.provider],
        ['secrets', runtime.providers.secrets.provider],
      ] as const) {
        try {
          await createProviderReadinessProbe(
            component,
            { profile: runtime.profile, provider },
            { sourceRoot: context.sourceRoot },
          )();
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
      ({ paths } = runtimeEnvironment(context, runtime));
      statePath = resolveApplicationStateRoot({
        appId: context.appId,
        dataDirectory: process.env.SMRT_DATA_DIR,
        sourceRoot: context.sourceRoot,
      });
      accessSync(nearestExistingAncestor(statePath), constants.W_OK);
      if (runtime.profile === 'local') {
        paths = await context.deps.runtime.validateLocalDatabaseStorage({
          appId: context.appId,
          dataDirectory: process.env.SMRT_DATA_DIR,
          sourceRoot: context.sourceRoot,
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
        accessSync(nearestExistingAncestor(paths.root), constants.W_OK);
      }
    } catch (error) {
      findings.push({
        code: 'runtime-path-unavailable',
        severity: 'error',
        message:
          'A required runtime path or provider configuration is unavailable.',
        recovery:
          error instanceof Error
            ? error.message
            : 'Configure a writable runtime data path.',
      });
    }

    if (canInspectMigrations) {
      try {
        const status = context.deps.runSmrt(['db:status', '--json'], {
          env: runtimeEnvironment(context, runtime).env,
          capture: true,
          allowFailure: true,
          label: 'smrt db:status --json',
        });
        if (status.status !== 0) {
          findings.push({
            code: 'migration-status-failed',
            severity: 'error',
            message: 'Database migration status could not be verified.',
            recovery:
              'Run pnpm app:setup and inspect the private migration logs.',
          });
        } else {
          const migrationStatus = JSON.parse(status.stdout || '{}') as {
            drift?: unknown[];
            migrations?: { failed?: { actionRequired?: number } };
            schemaContract?: { ok?: boolean };
            preconditions?: Array<{ status?: string }>;
          };
          const migrationRequired =
            (migrationStatus.drift?.length || 0) > 0 ||
            (migrationStatus.migrations?.failed?.actionRequired || 0) > 0 ||
            migrationStatus.schemaContract?.ok === false ||
            migrationStatus.preconditions?.some(
              (item) => item.status === 'error',
            );
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
          recovery:
            'Run pnpm app:setup and inspect the private migration logs.',
        });
      }
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
  printJson(context, report, true);
  return report.status === 'error' ? 1 : 0;
}

async function backup(
  context: AppContext,
  args: string[],
  operationLock?: OperationLock,
): Promise<void> {
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  if (runtime.profile !== 'local') {
    throw new Error(
      'This scaffold delegates deployed backups to the selected operator or managed provider.',
    );
  }
  const explicitDestination = args[0]
    ? assertExternalArtifactPath({
        sourceRoot: context.sourceRoot,
        path: resolve(args[0]),
        label: 'Backup destination',
      })
    : null;
  const paths = await context.deps.runtime.validateLocalDatabaseStorage({
    appId: context.appId,
    dataDirectory: process.env.SMRT_DATA_DIR,
    sourceRoot: context.sourceRoot,
  });
  const operatorLease = acquireWriterLease(preparedStateRoot(context), {
    operationInstance: operationLock?.instance,
  });
  try {
    const destination = assertExternalArtifactPath({
      sourceRoot: context.sourceRoot,
      path:
        explicitDestination ||
        join(
          dirname(paths.root),
          'backups',
          `${context.appId}-${new Date().toISOString().replaceAll(':', '-')}`,
        ),
      label: 'Backup destination',
    });
    ensurePrivateDirectory(dirname(destination));
    try {
      mkdirSync(destination, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === 'EEXIST') {
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
    printJson(context, {
      schemaVersion: 1,
      status: 'backed-up',
      destination,
    });
  } finally {
    operatorLease.release();
  }
}

/** Portability adapter contract (built-in or an application override). */
export interface PortabilityAdapter {
  exportApplication(context: PortabilityContext): Promise<ExportResult>;
  importApplication(context: PortabilityContext): Promise<ImportResult>;
}

/**
 * The application's own adapter at `scripts/smrt-portability.mjs` keeps
 * working as the documented extension point; otherwise the built-in adapter
 * is used.
 */
async function loadPortabilityAdapter(
  context: AppContext,
): Promise<PortabilityAdapter> {
  const override = join(context.sourceRoot, 'scripts', 'smrt-portability.mjs');
  if (existsSync(override)) {
    return (await import(pathToFileURL(override).href)) as PortabilityAdapter;
  }
  return import('./portability.js');
}

async function portability(
  context: AppContext,
  operation: 'export' | 'import',
  args: string[],
  operationLock?: OperationLock,
): Promise<void> {
  const adapter = await loadPortabilityAdapter(context);
  const runtime = await context.deps.resolveRuntime(context.sourceRoot);
  const environment = runtimeEnvironment(context, runtime);
  const requestedPath = args[0] ? resolve(args[0]) : undefined;
  const artifactPath = requestedPath
    ? assertExternalArtifactPath({
        sourceRoot: context.sourceRoot,
        path: requestedPath,
        label: operation === 'export' ? 'Export destination' : 'Import source',
      })
    : requestedPath;
  if (runtime.profile === 'local') {
    environment.paths = await context.deps.runtime.validateLocalDatabaseStorage(
      {
        appId: context.appId,
        dataDirectory: process.env.SMRT_DATA_DIR,
        sourceRoot: context.sourceRoot,
      },
    );
  }
  const portabilityContext: PortabilityContext = {
    appId: context.appId,
    sourceRoot: context.sourceRoot,
    stateRoot: preparedStateRoot(context),
    runtime,
    env: environment.env,
    paths: environment.paths,
    assetRoot: environment.assetRoot,
  };
  let operatorLease: { release(): void } | null = null;
  if (operation === 'import') {
    if (runtime.profile === 'local') {
      operatorLease = acquireWriterLease(preparedStateRoot(context), {
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
    ]({ ...portabilityContext, path: artifactPath });
    printJson(
      context,
      { schemaVersion: 1, status: `${operation}ed`, ...result },
      true,
    );
  } finally {
    operatorLease?.release();
  }
}

/**
 * Run one application operation. Resolves to the process exit code; throws
 * on failure (the caller renders the error envelope).
 */
export async function runApplicationOperation(
  context: AppContext,
  operation: AppOperation,
  args: string[],
): Promise<number> {
  switch (operation) {
    case 'install': {
      await assertLocalOperation(context, 'app:install');
      await withOperationLock(
        preparedStateRoot(context),
        'install',
        async (lock) => {
          const report = await setup(context, lock);
          await start(context, lock);
          const baseUrl = `http://127.0.0.1:${process.env.PORT || '5173'}/`;
          if (report.onboardingUrl) {
            saveOnboardingLaunch(context, report.onboardingUrl);
          }
          context.deps.openBrowser(
            report.onboardingUrl
              ? pathToFileURL(onboardingLaunchPath(context)).toString()
              : baseUrl,
          );
        },
      );
      return 0;
    }
    case 'setup':
      await withOperationLock(
        preparedStateRoot(context),
        operation,
        async (lock) => {
          const report = await setup(context, lock);
          printOnboardingUrl(context, report.onboardingUrl);
        },
      );
      return 0;
    case 'recover':
      await assertLocalOperation(context, 'app:recover');
      await withOperationLock(preparedStateRoot(context), operation, (lock) =>
        recoverOnboarding(context, lock),
      );
      return 0;
    case 'start':
      await assertLocalOperation(context, 'app:start');
      await withOperationLock(preparedStateRoot(context), operation, (lock) =>
        start(context, lock),
      );
      return 0;
    case 'doctor':
      return doctor(context);
    case 'open':
      await open(context);
      return 0;
    case 'stop':
      await assertLocalOperation(context, 'app:stop');
      await withOperationLock(preparedStateRoot(context), operation, () =>
        stop(context),
      );
      return 0;
    case 'backup':
      await withOperationLock(preparedStateRoot(context), operation, (lock) =>
        backup(context, args, lock),
      );
      return 0;
    case 'export':
    case 'import':
      await withOperationLock(preparedStateRoot(context), operation, (lock) =>
        portability(context, operation, args, lock),
      );
      return 0;
  }
}
