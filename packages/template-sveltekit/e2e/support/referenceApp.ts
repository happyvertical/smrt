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
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveApplicationRuntime } from '@happyvertical/smrt-config';

import { copyRuntimeProfileReference } from '../../fixtures/runtime-profile-reference/index.js';

const here = dirname(fileURLToPath(import.meta.url));
/** `packages/template-sveltekit` — the workspace package that owns this gate. */
export const packageRoot = resolve(here, '..', '..');

/** The monorepo checkout root. Redacted out of anything this harness prints. */
export const repositoryRoot = resolve(packageRoot, '..', '..');

/**
 * Environment the PostgreSQL test wrapper injects for the *vitest* half of the
 * gate. The browser half serves a local-profile application on file-backed
 * SQLite and must not see any of it. `PG*` is stripped by prefix alongside.
 */
export const POSTGRES_WRAPPER_VARIABLES = new Set([
  // Derived targets the wrapper exports for its child.
  'DATABASE_TYPE',
  'DATABASE_URL',
  'SMRT_TEST_POSTGRES_URL',
  'TEST_DB_ADAPTER',
  'TEST_DB_URL',
  // ...and the source they were derived from. Stripping only the derived
  // names would leave the live connection string itself in the served
  // process's environment, which is the value the documented local
  // reproduction has a developer point at their own cluster.
  'CI_POSTGRES_BASE_URL',
  'CI_POSTGRES_BASE_URL_FILE',
  'CI_POSTGRES_MANAGED',
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
  return (
    redactBootstrapToken(text)
      // Longest roots first: `packageRoot` is inside `repositoryRoot`, so
      // replacing the shorter one first would leave a half-substituted path.
      .replaceAll(temporaryRoot, '[temporary-root]')
      .replaceAll(packageRoot, '[package-root]')
      .replaceAll(repositoryRoot, '[repository-root]')
      .replaceAll(homedir(), '[home]')
      // Credentials first: a database URL can contain an absolute-looking
      // path, and redacting the whole URL is stricter than redacting its tail.
      .replaceAll(/\b(postgres(?:ql)?|mysql|mongodb):\/\/\S*/gi, '$1://[redacted]')
      .replaceAll(/\bBearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [redacted]')
      // A `file:` URL is an absolute path wearing a scheme, and its third
      // slash would otherwise put the path behind the `/` in the lookbehind
      // class below. Redact the whole thing here instead.
      .replaceAll(/\bfile:\/\/\S*/gi, 'file://[path]')
      // Then any absolute path the named roots above did not cover — any
      // `/`-rooted path of two or more segments, whatever the root is called,
      // since a container image can put the checkout anywhere. Matched
      // wherever it appears rather than only after a delimiter: `path=/var/x`,
      // a JSON value, and a backtick-quoted path are all normal shapes in the
      // output this excerpt is cut from, and a prefix-gated pattern misses
      // every one of them. The lookbehind is what keeps the excerpt readable:
      // it requires the leading slash to start a token, so relative specifiers
      // like `dist/migrations/index.js` and `../../packages/core/dist/x.js` —
      // the bulk of a failing build's output — are left intact. `]` is in the
      // class for the same reason: the substitutions above leave markers like
      // `[temporary-root]/app/src/x.js`, and without it this sweep would eat
      // the relative tail those substitutions exist to preserve. `/` is in it
      // so `https://host/a/b` keeps its host instead of collapsing to
      // `https:/[path]`; `file://` is already gone by the time we get here.
      .replaceAll(/(?<![A-Za-z0-9._@+\]/-])(?:\/[A-Za-z0-9._@+-]+){2,}/g, '[path]')
  );
}

/**
 * Reduce a failed subprocess's output to a bounded, sanitized excerpt.
 *
 * The tail alone is not enough: `app:setup` runs the application's own build
 * first, and that build's warning output is long enough to push the actual
 * failure — which is what the next reader needs — out of a tail-only window.
 * Keep both ends and say how much was dropped.
 */
export function summarizeFailureOutput(
  text: string,
  temporaryRoot: string,
  budget = 4000,
): string {
  const clean = redactHarnessPaths(text, temporaryRoot).trimEnd();
  if (clean.length <= budget) return clean;
  const half = Math.floor(budget / 2);
  const dropped = clean.length - budget;
  return `${clean.slice(0, half)}\n… ${dropped} characters omitted …\n${clean.slice(-half)}`;
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
  try {
    return await provisionReferenceApp(temporaryRoot);
  } catch (error) {
    // Provisioning failed before any caller could receive `stop()`, so this is
    // the only owner of the temporary root. Remove the copied build, the
    // file-backed database, and any unconsumed onboarding handoff rather than
    // leaving them behind after every failed local or CI run.
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The provisioning body itself. Split out so {@link startReferenceApp} owns
 * exactly one cleanup responsibility: the temporary root it created.
 */
async function provisionReferenceApp(
  temporaryRoot: string,
): Promise<StartedReferenceApp> {
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
  // Not a symlink to `packageRoot/node_modules`: Vite resolves `cacheDir` to
  // `<root>/node_modules/.vite`, and through a whole-directory symlink that
  // lands in the workspace package inside the checkout — persistent gate
  // output in the repository, which M5 forbids and which `stop()` could not
  // remove (unlinking the symlink leaves the target). A real directory whose
  // entries are individually symlinked resolves every dependency to the
  // packages built from this commit while keeping `.vite` inside
  // `temporaryRoot`.
  const appModules = join(appRoot, 'node_modules');
  mkdirSync(appModules, { recursive: true, mode: 0o700 });
  const workspaceModules = join(packageRoot, 'node_modules');
  for (const entry of readdirSync(workspaceModules)) {
    // `.vite` and friends are the caches this split exists to keep out; the
    // scoped directories still need to be traversable, so link them as a whole.
    if (entry.startsWith('.')) continue;
    symlinkSync(join(workspaceModules, entry), join(appModules, entry), 'junction');
  }
  // The launchers the harness invokes live under `node_modules/.bin`, so that
  // one dot-directory is linked deliberately rather than swept up above.
  const workspaceBin = join(workspaceModules, '.bin');
  if (existsSync(workspaceBin)) {
    symlinkSync(workspaceBin, join(appModules, '.bin'), 'junction');
  }
  // `app:setup`'s migration step shells out to `pnpm exec smrt db:migrate`.
  // `pnpm exec` resolves that from the nearest `node_modules/.bin`, and the
  // copied app deliberately never runs `pnpm install`, so the binary has to
  // arrive through the link above — which means this package must depend on
  // `@happyvertical/smrt-cli`. Check it here: without this the command falls
  // through to whatever `smrt` happens to be on the developer's PATH, which
  // passes locally and fails on a clean machine with a migration error that
  // #2635 deliberately redacts down to "the migration step failed".
  const appCli = join(appModules, '.bin', 'smrt');
  if (!existsSync(appCli)) {
    throw new Error(
      'The reference app has no local `smrt` binary; ' +
        '`@happyvertical/smrt-cli` must stay a devDependency of this package.',
    );
  }

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
    // The app's own binaries win over anything the developer has installed
    // globally, so a local run resolves `smrt` exactly the way a clean CI
    // runner does instead of silently borrowing a host installation.
    PATH: `${join(appRoot, 'node_modules', '.bin')}${delimiter}${inheritedEnvironment.PATH ?? ''}`,
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
    // The application redacts a migration failure to a fixed sentence, so the
    // only place the real cause can appear is the output of the commands
    // `app:setup` shells out to. Print a bounded, sanitized excerpt of both
    // ends rather than a tail the build output would have swallowed.
    throw new Error(
      `Reference app setup failed (exit ${setup.status ?? 'signal'}).\n` +
        `--- sanitized app:setup output ---\n${summarizeFailureOutput(
          `${setup.stdout ?? ''}\n${setup.stderr ?? ''}`,
          temporaryRoot,
        )}\n--- end ---`,
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

  // The server is live by now, so `stop()` — not the caller's cleanup — owns
  // the child process and the temporary root from here on.
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(
      readFileSync(join(appRoot, '.smrt', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
  } catch (error) {
    await stop();
    throw error;
  }

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
