/**
 * Fresh-process reference-application harness for the M5 browser gate.
 *
 * Everything here provisions a *real* local application: the published
 * template plus the M5 reference overlay is copied into a test-owned
 * temporary root, installed dependencies are resolved from the workspace,
 * `app:setup` performs the app's own build/migrate/bootstrap pass, and a
 * supported local web writer serves it on an ephemeral loopback port.
 *
 * The only thing this harness fakes is the browser's WebMCP host boundary
 * (`document.modelContext`), which no headless Chromium exposes. Database,
 * collections, generated REST handlers, session/auth, and every WebMCP
 * registration are the application's own.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveApplicationRuntime } from '@happyvertical/smrt-config';

import { copyRuntimeProfileReference } from '../../fixtures/runtime-profile-reference/index.js';

const here = dirname(fileURLToPath(import.meta.url));
/** `packages/template-sveltekit` — the workspace package that owns this gate. */
export const packageRoot = resolve(here, '..', '..');

/**
 * Environment the PostgreSQL test wrapper injects for the *vitest* half of the
 * gate. The browser half serves a local-profile application on file-backed
 * SQLite and must not see any of it. `PG*` is stripped by prefix alongside.
 */
const POSTGRES_WRAPPER_VARIABLES = new Set([
  'DATABASE_TYPE',
  'DATABASE_URL',
  'SMRT_TEST_POSTGRES_URL',
  'TEST_DB_ADAPTER',
  'TEST_DB_URL',
]);

/** Startup budget for the app's own build/migrate pass, in milliseconds. */
const SETUP_TIMEOUT_MS = 10 * 60_000;
/** Startup budget for the web writer to prove its identity, in milliseconds. */
const READY_TIMEOUT_MS = 3 * 60_000;

export interface ReferenceAppProcessIdentity {
  /** Canonical application id derived from the copied app's package name. */
  readonly application: string;
  /** Per-process instance nonce; proves *this* server, not a stale one. */
  readonly instance: string;
  /** Secret-safe runtime configuration fingerprint. */
  readonly configuration: string;
}

export interface StartedReferenceApp {
  readonly baseURL: string;
  /** Test-owned temporary root; app, data, state and home all live below it. */
  readonly temporaryRoot: string;
  readonly appRoot: string;
  readonly dataRoot: string;
  readonly stateRoot: string;
  readonly identity: ReferenceAppProcessIdentity;
  /** Environment handed to the served application, for assertion. */
  readonly servedEnvironment: Readonly<Record<string, string | undefined>>;
  /**
   * The app's own owner-onboarding URL, carrying the single-use bootstrap
   * token. Held in memory only: never logged, never written to an artifact,
   * and never placed in an environment variable.
   */
  readonly onboardingUrl: string;
  /** The invitation token alone, already masked in a GitHub Actions log. */
  readonly bootstrapToken: string;
  /** Generated manifest of the copied app, used to derive the tool inventory. */
  readonly manifest: Record<string, unknown>;
  stop(): Promise<void>;
}

/** Reserve a loopback port, then hand it to the app via `--strictPort`. */
async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (typeof address === 'string' || address === null) {
        probe.close(() => rejectPort(new Error('No loopback port available.')));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

/**
 * Redact the one secret this harness handles. Applied to every subprocess
 * stream before it can reach a reporter, a log, or a retained artifact.
 */
export function redactBootstrapToken(text: string): string {
  return text.replaceAll(/token=[^&\s"'<>]+/g, 'token=[redacted]');
}

/**
 * Reduce captured subprocess output to something safe for a CI log.
 *
 * A failing `app:setup` is the most likely way this harness fails, and its
 * build output is full of temporary and workspace paths. The bootstrap token
 * is the only true secret here, but the declared M5 threat model covers
 * absolute paths reaching a log as well as an artifact.
 */
export function redactHarnessPaths(
  text: string,
  temporaryRoot: string,
): string {
  return redactBootstrapToken(text)
    .replaceAll(temporaryRoot, '[temporary-root]')
    .replaceAll(packageRoot, '[package-root]');
}

function assertPrivateFile(path: string): void {
  const details = statSync(path);
  if ((details.mode & 0o077) !== 0) {
    throw new Error('Onboarding handoff is not owner-private.');
  }
}

/**
 * Provision and start one reference application.
 *
 * `pnpm install` is deliberately *not* run inside the temporary root: the
 * gate must exercise the packages built from this commit, not a published
 * release, so the copied app resolves its dependency graph through the
 * workspace package that owns the gate. Everything else — build, schema
 * migration, owner bootstrap, and serving — is the generated app's own code
 * path, invoked through its own `scripts/`.
 */
export async function startReferenceApp(): Promise<StartedReferenceApp> {
  // `realpathSync` matters: on macOS `/var` is a symlink, and the app's state
  // custody check rejects symlinked path components outright.
  const temporaryRoot = mkdtempSync(join(realpathSync(tmpdir()), 'smrt-m5-'));
  const appRoot = join(temporaryRoot, 'app');
  const dataRoot = join(temporaryRoot, 'data');
  const homeRoot = join(temporaryRoot, 'home');
  const artifactRoot = join(temporaryRoot, 'artifacts');
  mkdirSync(appRoot, { recursive: true, mode: 0o700 });
  // The local data root must already be owner-private, or the runtime's
  // custody check fails closed rather than silently widening it.
  mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  mkdirSync(homeRoot, { recursive: true, mode: 0o700 });
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });

  copyRuntimeProfileReference(appRoot);
  symlinkSync(join(packageRoot, 'node_modules'), join(appRoot, 'node_modules'), 'dir');

  const port = await reserveLoopbackPort();
  // `test:m5` runs under `scripts/run-with-ci-postgres.mjs`, which exports a
  // disposable PostgreSQL target into this process. None of it belongs to the
  // application under test: the local profile is file-backed SQLite, and
  // leaking these would put CI credentials in the served process, fold a
  // PostgreSQL target into its runtime-configuration fingerprint, and make
  // `test:m5` and `test:e2e` serve the same specs under different
  // configurations.
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !POSTGRES_WRAPPER_VARIABLES.has(key) && !key.startsWith('PG'),
    ),
  );
  const baseURL = `http://127.0.0.1:${port}`;
  const environment: NodeJS.ProcessEnv = {
    ...inheritedEnvironment,
    // Keep every derived state/lock/cache root inside the temporary tree.
    HOME: homeRoot,
    XDG_STATE_HOME: join(homeRoot, '.local', 'state'),
    SMRT_DATA_DIR: dataRoot,
    SMRT_RUNTIME_PROFILE: 'local',
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_ENV: 'development',
    // The copied app is not a workspace member; keep its own scripts from
    // re-entering the monorepo package manager context.
    npm_execpath: '',
    npm_config_workspace: '',
  };

  const setup = spawnSync(
    process.execPath,
    ['scripts/smrt-app.mjs', 'setup'],
    {
      cwd: appRoot,
      env: environment,
      encoding: 'utf8',
      timeout: SETUP_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (setup.status !== 0) {
    throw new Error(
      `Reference app setup failed (exit ${setup.status ?? 'signal'}): ${redactHarnessPaths(
        `${setup.stdout ?? ''}${setup.stderr ?? ''}`,
        temporaryRoot,
      ).slice(-2000)}`,
    );
  }

  const identityModule = (await import(
    join(appRoot, 'scripts', 'smrt-runtime-identity.mjs')
  )) as {
    resolveApplicationId(options: Record<string, unknown>): string;
    resolveApplicationStateRoot(options: Record<string, unknown>): string;
    runtimeConfigurationFingerprint(
      runtime: unknown,
      environment: NodeJS.ProcessEnv,
    ): string;
  };
  const application = identityModule.resolveApplicationId({
    sourceRoot: appRoot,
  });
  const stateRoot = identityModule.resolveApplicationStateRoot({
    appId: application,
    dataDirectory: dataRoot,
    sourceRoot: appRoot,
    homeDirectory: homeRoot,
    environment,
  });

  const onboardingPath = join(stateRoot, 'onboarding.json');
  if (!existsSync(onboardingPath)) {
    throw new Error('Reference app setup produced no owner onboarding handoff.');
  }
  assertPrivateFile(onboardingPath);
  const onboardingUrl = String(
    (JSON.parse(readFileSync(onboardingPath, 'utf8')) as { url?: unknown }).url,
  );
  if (!onboardingUrl.startsWith(baseURL)) {
    throw new Error('Owner onboarding handoff does not address this server.');
  }

  // Register the token with the runner before anything can echo it. The
  // harness redacts its own captured subprocess output, but Playwright is a
  // sibling process: a failed navigation to the onboarding URL, or a failed
  // assertion on the setup page, embeds that URL verbatim in a reporter
  // message the harness never sees. `::add-mask::` covers the whole step's
  // stdout and stderr, so it covers every downstream reporter too. The
  // wrapper masks its database URLs the same way.
  const bootstrapToken = new URL(onboardingUrl).searchParams.get('token');
  if (!bootstrapToken) {
    throw new Error('Owner onboarding handoff carries no invitation token.');
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::add-mask::${bootstrapToken}\n`);
  }

  // The web writer accepts only a 32-hex process identity.
  const instance = randomBytes(16).toString('hex');
  const child = spawn(
    process.execPath,
    [
      'scripts/smrt-vite.mjs',
      'dev',
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    {
      cwd: appRoot,
      env: { ...environment, SMRT_PROCESS_INSTANCE: instance },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Streams are drained but never forwarded: a dev server echoes request URLs,
  // and one of those URLs carries the single-use bootstrap token.
  child.stdout?.resume();
  child.stderr?.resume();

  let exited = false;
  child.on('exit', () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill('SIGTERM');
      await new Promise((done) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          done(undefined);
        }, 10_000);
        child.on('exit', () => {
          clearTimeout(timer);
          done(undefined);
        });
      });
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  };

  // Independently derived, so the identity check is a check rather than a
  // value compared to itself.
  //
  // Two deliberate assumptions, both of which fail closed with the dedicated
  // message below rather than silently:
  //  - The served process resolves through `resolveConfiguredApplicationRuntime()`
  //    (its `smrt.config.ts` declares `runtime.profile`), while this resolves
  //    the profile directly. They agree only while the template config
  //    contributes no provider overrides; adding one is what that message is
  //    for.
  //  - This is NOT `smrt-app.mjs start()`'s fingerprint. That one runs after
  //    `runtimeEnvironment()` has set `DATABASE_TYPE`/`DATABASE_URL`, so it
  //    carries a database target this one deliberately does not — the gate
  //    serves the app with `vite dev`, not the production writer.
  const configuration = identityModule.runtimeConfigurationFingerprint(
    resolveApplicationRuntime({ profile: 'local' }),
    { ...environment, SMRT_PROCESS_INSTANCE: instance },
  );

  const identity = await waitForProcessIdentity(
    baseURL,
    application,
    instance,
    configuration,
    () => exited,
    stop,
  );

  const manifest = JSON.parse(
    readFileSync(join(appRoot, '.smrt', 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>;

  return {
    baseURL,
    temporaryRoot,
    appRoot,
    dataRoot,
    stateRoot,
    identity,
    servedEnvironment: Object.freeze({ ...environment }),
    onboardingUrl,
    bootstrapToken,
    manifest,
    stop,
  };
}

/**
 * Prove the listener is this harness's own process before driving it. A
 * stale server on a recycled port answers `/api/_runtime/health` too; only
 * the application id plus the per-process instance nonce distinguishes it.
 */
async function waitForProcessIdentity(
  baseURL: string,
  application: string,
  instance: string,
  configuration: string,
  hasExited: () => boolean,
  stop: () => Promise<void>,
): Promise<ReferenceAppProcessIdentity> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (hasExited()) {
      await stop();
      throw new Error('The reference app exited before becoming ready.');
    }
    try {
      const response = await fetch(`${baseURL}/api/_runtime/health`, {
        redirect: 'manual',
      });
      if (response.ok) {
        const health = (await response.json()) as Record<string, unknown>;
        if (
          health.status === 'ready' &&
          health.application === application &&
          health.instance === instance &&
          health.configuration === configuration
        ) {
          return { application, instance, configuration };
        }
        if (
          health.application === application &&
          health.instance === instance
        ) {
          // Right process, unexpected configuration. Distinguishing this from
          // port reuse matters: the recovery for the two is opposite, and
          // `stop()` below removes the temporary root either way.
          await stop();
          throw new Error(
            'The served runtime configuration fingerprint does not match the harness expectation.',
          );
        }
        await stop();
        throw new Error('A different server answered on the reserved port.');
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('different server') ||
          error.message.includes('configuration fingerprint'))
      ) {
        throw error;
      }
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  await stop();
  throw new Error('The reference app did not prove its identity in time.');
}
