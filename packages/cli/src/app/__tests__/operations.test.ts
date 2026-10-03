/**
 * `smrt app` operations end to end in-process (#3371): real filesystem,
 * real state/lock/lease files, real local storage custody from
 * `@happyvertical/smrt-app-runtime`, real web-launcher child process; the
 * package manager, `smrt db:migrate`, and owner-bootstrap seeding are
 * replaced with recorders so each failure can be forced.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LocalRuntimeError,
  MIGRATION_FAILED_MESSAGE,
  prepareLocalDatabaseStorage,
  resolveLocalRuntimePaths,
  withOperationLock,
} from '@happyvertical/smrt-app-runtime';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAppCommand } from '../cli.js';
import { AppCommandError } from '../errors.js';
import {
  resolveApplicationStateRoot,
  runtimeConfigurationFingerprint,
} from '../identity.js';
import type { AppCommandDependencies, CommandRunner } from '../runtime.js';

const TOKEN = 'bootstrap-token-must-never-print-0123456789';
const ROTATED_TOKEN = 'rotated-token-must-never-print-9876543210';
const DB_PASSWORD = 'pg-password-must-never-print';
const ENV_KEYS = [
  'SMRT_DATA_DIR',
  'XDG_STATE_HOME',
  'SMRT_APP_ID',
  'PORT',
  'HOST',
  'ORIGIN',
  'DATABASE_URL',
  'DATABASE_TYPE',
  'SMRT_OPEN_STUB',
  'SMRT_MAINTENANCE_MODE',
  'SMRT_ASSETS_DIR',
  'SMRT_AUTH_READINESS_MODULE',
  'SMRT_ASSETS_READINESS_MODULE',
  'SMRT_SECRETS_READINESS_MODULE',
  'SMRT_RUNTIME_PROFILE',
  'FAKE_HEALTH',
  'SMRT_FROM_DOTENV',
] as const;

const saved: Record<string, string | undefined> = {};
const roots: string[] = [];
const children: number[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  app: string;
  data: string;
  appId: string;
  stateRoot: () => string;
  output: { stdout: string[]; stderr: string[] };
  calls: {
    pm: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>;
    smrt: Array<{ args: string[]; env?: NodeJS.ProcessEnv }>;
  };
  run(
    argv: string[],
    overrides?: Partial<AppCommandDependencies>,
  ): Promise<number>;
  stdoutJson(): unknown;
  stderrJson(): Record<string, unknown>;
  bootstrapStatus: { value: 'available' | 'claimed' };
  setProfile(profile: 'local' | 'self-hosted'): void;
}

function makeFixture(): Fixture {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-app-ops-')),
  );
  roots.push(root);
  const app = join(root, 'app');
  const data = join(root, 'data');
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'ops-app' }));
  process.env.SMRT_DATA_DIR = data;
  process.env.XDG_STATE_HOME = join(root, 'state-home');
  let profile: 'local' | 'self-hosted' = 'local';
  const output = { stdout: [] as string[], stderr: [] as string[] };
  const calls = {
    pm: [] as Array<{ args: string[]; env?: NodeJS.ProcessEnv }>,
    smrt: [] as Array<{ args: string[]; env?: NodeJS.ProcessEnv }>,
  };
  const bootstrapStatus = { value: 'available' as 'available' | 'claimed' };
  const ok = {
    status: 0,
    stdout: '',
    stderr: '',
    pid: 0,
    output: [],
    signal: null,
  };
  const runPackageManager: CommandRunner = (args, options) => {
    calls.pm.push({ args, env: options?.env });
    return ok;
  };
  const runSmrt: CommandRunner = (args, options) => {
    calls.smrt.push({ args, env: options?.env });
    return ok;
  };
  const fixture: Fixture = {
    root,
    app,
    data,
    appId: 'ops-app',
    stateRoot: () =>
      resolveApplicationStateRoot({
        appId: 'ops-app',
        dataDirectory: data,
        sourceRoot: app,
      }),
    output,
    calls,
    bootstrapStatus,
    setProfile(next) {
      profile = next;
    },
    async run(argv, overrides = {}) {
      output.stdout.length = 0;
      output.stderr.length = 0;
      return runAppCommand(argv, {
        cwd: app,
        io: {
          stdout: (text) => output.stdout.push(text),
          stderr: (text) => output.stderr.push(text),
        },
        dependencies: {
          resolveRuntime: async () =>
            resolveApplicationRuntime({ profile }) as never,
          runPackageManager,
          runSmrt,
          openBrowser: vi.fn(),
          sleep: () => new Promise((resolve) => setTimeout(resolve, 50)),
          runtime: {
            ...(await import('@happyvertical/smrt-app-runtime')),
            initializeLocalApplicationRuntime: fakeInitialize(
              bootstrapStatus,
            ) as never,
          },
          ...overrides,
        },
      });
    },
    stdoutJson() {
      return JSON.parse(output.stdout.join(''));
    },
    stderrJson() {
      return JSON.parse(output.stderr.join(''));
    },
  };
  return fixture;
}

/**
 * Stand-in for owner bootstrap seeding: real storage custody, the explicit
 * migration hook, and app-runtime's own migration-failure normalization.
 */
function fakeInitialize(status: { value: 'available' | 'claimed' }) {
  return async (options: {
    appId: string;
    dataDirectory?: string;
    sourceRoot?: string;
    prepareDatabase?: (db: unknown) => Promise<void>;
  }) => {
    await prepareLocalDatabaseStorage(options);
    if (options.prepareDatabase) {
      try {
        await options.prepareDatabase({});
      } catch (cause) {
        const failure = new LocalRuntimeError(
          'migration_failed',
          MIGRATION_FAILED_MESSAGE,
        );
        Object.defineProperty(failure, 'cause', { value: cause });
        throw failure;
      }
    }
    const close = vi.fn(async () => {});
    return {
      bootstrap:
        status.value === 'available'
          ? { token: TOKEN, expiresAt: new Date().toISOString() }
          : null,
      diagnostics: {},
      runtime: {
        db: { close },
        diagnostics: async () => ({ bootstrap: { status: status.value } }),
        rotateBootstrapInvitation: async () => ({
          token: ROTATED_TOKEN,
          expiresAt: new Date().toISOString(),
        }),
      },
    };
  };
}

function allOutput(fixture: Fixture): string {
  return [...fixture.output.stdout, ...fixture.output.stderr].join('');
}

function expectNoLocks(fixture: Fixture): void {
  expect(existsSync(join(fixture.stateRoot(), 'operation.lock'))).toBe(false);
  expect(existsSync(join(fixture.stateRoot(), 'writer.lease'))).toBe(false);
}

async function freePort(): Promise<string> {
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return String(address.port);
}

describe('smrt app setup', () => {
  it('builds, migrates explicitly, and keeps the bootstrap token in private files only', async () => {
    const fixture = makeFixture();
    expect(await fixture.run(['setup'])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'ready',
      profile: 'local',
      onboardingAvailable: true,
      onboardingRecovery: 'pnpm app:open',
      secretValuesIncluded: false,
    });
    expect(allOutput(fixture)).not.toContain(TOKEN);
    expect(fixture.calls.pm.map((call) => call.args)).toEqual([['build']]);
    expect(fixture.calls.smrt.map((call) => call.args)).toEqual([
      ['db:migrate'],
    ]);
    const paths = resolveLocalRuntimePaths({
      appId: fixture.appId,
      dataDirectory: fixture.data,
      sourceRoot: fixture.app,
    });
    expect(fixture.calls.smrt[0].env).toMatchObject({
      DATABASE_TYPE: 'sqlite',
      DATABASE_URL: paths.database,
      SMRT_ASSETS_DIR: paths.assets,
      SMRT_APP_ID: 'ops-app',
      HOST: '127.0.0.1',
    });
    const handoff = join(fixture.stateRoot(), 'onboarding.json');
    const launch = join(fixture.stateRoot(), 'onboarding-launch.html');
    expect(statSync(handoff).mode & 0o777).toBe(0o600);
    expect(statSync(launch).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(handoff, 'utf8'))).toEqual({
      schemaVersion: 1,
      url: `http://127.0.0.1:5173/setup?token=${TOKEN}`,
    });
    expect(statSync(fixture.data).mode & 0o777).toBe(0o700);
    expectNoLocks(fixture);
  });

  it('removes the handoff once the owner has claimed the application', async () => {
    const fixture = makeFixture();
    await fixture.run(['setup']);
    fixture.bootstrapStatus.value = 'claimed';
    expect(await fixture.run(['setup'])).toBe(0);
    expect(fixture.stdoutJson()).toMatchObject({
      onboardingAvailable: false,
      onboardingRecovery: null,
    });
    expect(existsSync(join(fixture.stateRoot(), 'onboarding.json'))).toBe(
      false,
    );
  });

  it('reports migration_failed with the fixed message and stays retryable', async () => {
    const fixture = makeFixture();
    const failingSmrt: CommandRunner = () => {
      throw new AppCommandError(
        `migrate failed for postgresql://owner:${DB_PASSWORD}@db/app`,
      );
    };
    expect(await fixture.run(['setup'], { runSmrt: failingSmrt })).toBe(1);
    const envelope = fixture.stderrJson();
    expect(envelope).toEqual({
      schemaVersion: 1,
      status: 'error',
      code: 'operation-failed',
      runtimeCode: 'migration_failed',
      message: MIGRATION_FAILED_MESSAGE,
      recovery: 'Run pnpm app:doctor and follow its recovery instructions.',
      secretValuesIncluded: false,
    });
    expect(allOutput(fixture)).not.toContain(DB_PASSWORD);
    expect(allOutput(fixture)).not.toContain(TOKEN);
    expectNoLocks(fixture);
    expect(await fixture.run(['setup'])).toBe(0);
  });

  it('fails before initialization when the application build fails', async () => {
    const fixture = makeFixture();
    const initialize = vi.fn();
    const failingBuild: CommandRunner = () => {
      throw new AppCommandError('pnpm build failed with exit code 2.', 2);
    };
    expect(
      await fixture.run(['setup'], {
        runPackageManager: failingBuild,
        runtime: {
          ...(await import('@happyvertical/smrt-app-runtime')),
          initializeLocalApplicationRuntime: initialize as never,
        },
      }),
    ).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'pnpm build failed with exit code 2.',
    );
    expect(initialize).not.toHaveBeenCalled();
    expectNoLocks(fixture);
  });

  it('refuses to run while another operation or writer holds the state root', async () => {
    const fixture = makeFixture();
    await fixture.run(['setup']);
    const buildsBefore = fixture.calls.pm.length;
    await withOperationLock(fixture.stateRoot(), 'backup', async () => {
      expect(await fixture.run(['setup'])).toBe(1);
      expect(fixture.stderrJson().message).toContain(
        'Another application operation is active',
      );
    });
    writeFileSync(
      join(fixture.stateRoot(), 'writer.lease'),
      `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, instance: '0123456789abcdef0123456789abcdef' })}\n`,
    );
    expect(await fixture.run(['setup'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      `Another application writer is active (process ${process.ppid}).`,
    );
    expect(fixture.calls.pm).toHaveLength(buildsBefore);
  });

  it('runs the deployed setup without a lease and redacts the database URL', async () => {
    const fixture = makeFixture();
    fixture.setProfile('self-hosted');
    expect(await fixture.run(['setup'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'self-hosted requires DATABASE_URL; copy the matching env example and configure providers.',
    );
    process.env.DATABASE_URL = `postgresql://owner:${DB_PASSWORD}@db.example/app`;
    expect(await fixture.run(['setup'])).toBe(0);
    expect(fixture.stdoutJson()).toMatchObject({
      profile: 'self-hosted',
      onboardingAvailable: false,
    });
    expect(fixture.calls.smrt.at(-1)?.env).toMatchObject({
      DATABASE_TYPE: 'postgres',
      HOST: '0.0.0.0',
    });
    const leakingSmrt: CommandRunner = () => {
      throw new Error(`connect ${process.env.DATABASE_URL} refused`);
    };
    expect(await fixture.run(['setup'], { runSmrt: leakingSmrt })).toBe(1);
    expect(allOutput(fixture)).not.toContain(DB_PASSWORD);
    expect(fixture.stderrJson().message).toContain('[redacted]');
  });
});

describe('smrt app recover / open / install', () => {
  it('rotates the invitation into the private handoff (local only)', async () => {
    const fixture = makeFixture();
    await fixture.run(['setup']);
    expect(await fixture.run(['recover'])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'ready',
      onboardingAvailable: true,
      recovery: 'Run pnpm app:start, then pnpm app:open.',
      secretValuesIncluded: false,
    });
    expect(allOutput(fixture)).not.toContain(ROTATED_TOKEN);
    expect(
      readFileSync(join(fixture.stateRoot(), 'onboarding.json'), 'utf8'),
    ).toContain(ROTATED_TOKEN);
    fixture.setProfile('self-hosted');
    expect(await fixture.run(['recover'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'app:recover is local-profile only; run the production Node build or container for deployed profiles.',
    );
  });

  it('opens the private launch file and discards a tampered handoff', async () => {
    const fixture = makeFixture();
    await fixture.run(['setup']);
    const stub = join(fixture.root, 'opened.txt');
    process.env.SMRT_OPEN_STUB = stub;
    const realOpener = (await import('../runtime.js')).createBrowserOpener(
      fixture.app,
    );
    expect(await fixture.run(['open'], { openBrowser: realOpener })).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'opened',
      url: 'http://127.0.0.1:5173/',
    });
    expect(readFileSync(stub, 'utf8').trim()).toBe(
      pathToFileURL(join(fixture.stateRoot(), 'onboarding-launch.html')).href,
    );
    expect(allOutput(fixture)).not.toContain(TOKEN);

    writeFileSync(
      join(fixture.stateRoot(), 'onboarding.json'),
      JSON.stringify({
        schemaVersion: 1,
        url: 'http://evil.example/setup?token=x',
      }),
      { mode: 0o600 },
    );
    expect(await fixture.run(['open'], { openBrowser: realOpener })).toBe(0);
    expect(readFileSync(stub, 'utf8').trim()).toBe('http://127.0.0.1:5173/');
    expect(existsSync(join(fixture.stateRoot(), 'onboarding.json'))).toBe(
      false,
    );
    expect(
      existsSync(join(fixture.stateRoot(), 'onboarding-launch.html')),
    ).toBe(false);
  });

  it('refuses install and start on a deployed profile before taking the lock', async () => {
    const fixture = makeFixture();
    fixture.setProfile('self-hosted');
    for (const operation of ['install', 'start', 'stop']) {
      expect(await fixture.run([operation])).toBe(1);
      expect(fixture.stderrJson().message).toBe(
        `app:${operation} is local-profile only; run the production Node build or container for deployed profiles.`,
      );
    }
    expect(fixture.calls.pm).toHaveLength(0);
  });
});

/** A fake production build whose health endpoint is driven by the test. */
function writeFakeBuild(app: string, body = ''): void {
  mkdirSync(join(app, 'build'), { recursive: true });
  writeFileSync(
    join(app, 'build', 'index.js'),
    body ||
      `
      import { createServer } from 'node:http';
      import { writeFileSync } from 'node:fs';
      writeFileSync('observed.json', JSON.stringify({ origin: process.env.ORIGIN, operation: process.env.SMRT_OPERATION_INSTANCE ?? null, argv: process.argv.slice(1) }));
      const health = JSON.parse(process.env.FAKE_HEALTH || '{}');
      createServer((request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ status: 'ready', application: process.env.SMRT_APP_ID, instance: health.instance ?? process.env.SMRT_PROCESS_INSTANCE, configuration: health.configuration }));
      }).listen(Number(process.env.PORT), process.env.HOST);
    `,
  );
}

function expectedFingerprint(fixture: Fixture, port: string, origin?: string) {
  const paths = resolveLocalRuntimePaths({
    appId: fixture.appId,
    dataDirectory: fixture.data,
    sourceRoot: fixture.app,
  });
  return runtimeConfigurationFingerprint(
    resolveApplicationRuntime({ profile: 'local' }),
    {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: port,
      ORIGIN: origin ?? `http://127.0.0.1:${port}/`,
      DATABASE_URL: paths.database,
    },
  );
}

describe('smrt app start / stop', () => {
  it.each([
    undefined,
    'https://trusted.example',
  ])('starts the launcher, proves identity, and stops it (ORIGIN %s)', async (origin) => {
    const fixture = makeFixture();
    const port = await freePort();
    process.env.PORT = port;
    if (origin) process.env.ORIGIN = origin;
    writeFakeBuild(fixture.app);
    process.env.FAKE_HEALTH = JSON.stringify({
      configuration: expectedFingerprint(fixture, port, origin),
    });
    expect(await fixture.run(['start'])).toBe(0);
    const started = fixture.stdoutJson() as { status: string; pid: number };
    expect(started.status).toBe('started');
    children.push(started.pid);
    const observed = JSON.parse(
      readFileSync(join(fixture.app, 'observed.json'), 'utf8'),
    );
    expect(observed.origin).toBe(origin ?? `http://127.0.0.1:${port}/`);
    expect(observed.operation).toMatch(/^[a-f0-9]{32}$/);
    const command = spawnSync(
      'ps',
      ['-p', String(started.pid), '-o', 'command='],
      {
        encoding: 'utf8',
      },
    ).stdout;
    expect(command).toContain('smrt-web.mjs --smrt-instance=');
    const record = join(fixture.stateRoot(), 'app.pid');
    expect(statSync(record).mode & 0o777).toBe(0o600);

    expect(await fixture.run(['start'])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'running',
      pid: started.pid,
    });

    expect(await fixture.run(['stop'])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'stopped',
      pid: started.pid,
    });
    expect(existsSync(record)).toBe(false);
    expect(() => process.kill(started.pid, 0)).toThrow();
    expect(await fixture.run(['stop'])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'stopped',
    });
    expectNoLocks(fixture);
  });

  it('kills a server that never proves this instance and removes its record', async () => {
    const fixture = makeFixture();
    const port = await freePort();
    process.env.PORT = port;
    writeFakeBuild(fixture.app);
    process.env.FAKE_HEALTH = JSON.stringify({
      instance: 'ffffffffffffffffffffffffffffffff',
      configuration: expectedFingerprint(fixture, port),
    });
    expect(await fixture.run(['start'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      `The application did not become ready at http://127.0.0.1:${port}/.`,
    );
    expect(existsSync(join(fixture.stateRoot(), 'app.pid'))).toBe(false);
    expectNoLocks(fixture);
  });

  it('reports a launcher that exits before becoming ready', async () => {
    const fixture = makeFixture();
    process.env.PORT = await freePort();
    writeFakeBuild(fixture.app, 'process.exit(3);\n');
    expect(await fixture.run(['start'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'The application process exited before becoming ready.',
    );
    expect(existsSync(join(fixture.stateRoot(), 'app.pid'))).toBe(false);
  });

  it('install runs setup, start, and open under one operation lock', async () => {
    const fixture = makeFixture();
    const port = await freePort();
    process.env.PORT = port;
    writeFakeBuild(fixture.app);
    process.env.FAKE_HEALTH = JSON.stringify({
      configuration: expectedFingerprint(fixture, port),
    });
    const openBrowser = vi.fn();
    expect(await fixture.run(['install'], { openBrowser })).toBe(0);
    const lines = fixture.output.stdout.join('');
    expect(lines).toContain('"status": "ready"');
    const startedLine = lines.trim().split('\n').at(-1) as string;
    const started = JSON.parse(startedLine) as { status: string; pid: number };
    children.push(started.pid);
    expect(started.status).toBe('started');
    expect(openBrowser).toHaveBeenCalledWith(
      pathToFileURL(join(fixture.stateRoot(), 'onboarding-launch.html')).href,
    );
    expect(allOutput(fixture)).not.toContain(TOKEN);
    expect(await fixture.run(['stop'])).toBe(0);
  });
});

describe('smrt app doctor', () => {
  it('reports unavailable storage without creating it', async () => {
    const fixture = makeFixture();
    expect(await fixture.run(['doctor'])).toBe(1);
    const report = fixture.stdoutJson() as {
      status: string;
      findings: Array<{ code: string }>;
      secretValuesIncluded: boolean;
    };
    expect(report.status).toBe('error');
    expect(report.findings.map((finding) => finding.code)).toEqual([
      'runtime-path-unavailable',
    ]);
    expect(existsSync(fixture.data)).toBe(false);
    expect(fixture.calls.smrt).toHaveLength(0);
  });

  it('is the default operation and classifies migration status', async () => {
    const fixture = makeFixture();
    await fixture.run(['setup']);
    const statusRunner =
      (status: number, stdout: string): CommandRunner =>
      (args) => {
        expect(args).toEqual(['db:status', '--json']);
        return { status, stdout, stderr: '', pid: 0, output: [], signal: null };
      };
    expect(
      await fixture.run([], { runSmrt: statusRunner(0, '{"drift":[]}') }),
    ).toBe(0);
    const ready = fixture.stdoutJson() as Record<string, unknown>;
    expect(ready).toMatchObject({
      schemaVersion: 1,
      status: 'ready',
      profile: 'local',
      findings: [],
      secretValuesIncluded: false,
    });
    expect((ready.paths as { state: string }).state).toBe(fixture.stateRoot());

    const codes = async (runner: CommandRunner) => {
      await fixture.run(['doctor'], { runSmrt: runner });
      return (
        fixture.stdoutJson() as { findings: Array<{ code: string }> }
      ).findings.map((finding) => finding.code);
    };
    expect(await codes(statusRunner(0, '{"drift":[{"table":"x"}]}'))).toEqual([
      'migration-required',
    ]);
    expect(
      await codes(
        statusRunner(0, '{"migrations":{"failed":{"actionRequired":1}}}'),
      ),
    ).toEqual(['migration-required']);
    expect(await codes(statusRunner(1, ''))).toEqual([
      'migration-status-failed',
    ]);
    expect(await codes(statusRunner(0, 'not json'))).toEqual([
      'migration-status-failed',
    ]);
    process.env.HOST = '0.0.0.0';
    expect(await codes(statusRunner(0, '{}'))).toEqual(['unsafe-local-bind']);
  });

  it('reports an invalid profile and unready deployed providers', async () => {
    const fixture = makeFixture();
    expect(
      await fixture.run(['doctor'], {
        resolveRuntime: async () => {
          throw new Error(`bad config with ${DB_PASSWORD}`);
        },
      }),
    ).toBe(1);
    const invalid = fixture.stdoutJson() as {
      findings: Array<{ code: string }>;
    };
    expect(invalid.findings.map((finding) => finding.code)).toEqual([
      'invalid-runtime-profile',
    ]);
    expect(allOutput(fixture)).not.toContain(DB_PASSWORD);

    fixture.setProfile('self-hosted');
    process.env.DATABASE_URL = `postgresql://owner:${DB_PASSWORD}@db.example/app`;
    await fixture.run(['doctor'], {
      runSmrt: () => ({
        status: 0,
        stdout: '{}',
        stderr: '',
        pid: 0,
        output: [],
        signal: null,
      }),
    });
    const deployed = fixture.stdoutJson() as {
      findings: Array<{ code: string; component?: string }>;
    };
    expect(
      deployed.findings
        .filter((finding) => finding.code === 'provider-not-configured')
        .map((finding) => finding.component),
    ).toEqual(['authentication', 'assets', 'secrets']);
    expect(allOutput(fixture)).not.toContain(DB_PASSWORD);
  });
});

describe('smrt app backup', () => {
  it('validates storage without creating it, then copies to a new private directory', async () => {
    const fixture = makeFixture();
    const destination = join(fixture.root, 'backups', 'first');
    expect(await fixture.run(['backup', destination])).toBe(1);
    expect(existsSync(fixture.data)).toBe(false);
    expect(existsSync(destination)).toBe(false);

    await fixture.run(['setup']);
    expect(await fixture.run(['backup', '--', destination])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'backed-up',
      destination,
    });
    expect(statSync(destination).mode & 0o777).toBe(0o700);
    expect(readdirSync(destination).sort()).toEqual(
      readdirSync(fixture.data).sort(),
    );
    expectNoLocks(fixture);

    expect(await fixture.run(['backup', destination])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      `Backup destination already exists: ${destination}`,
    );
    expect(await fixture.run(['backup', join(fixture.app, 'backup')])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Backup destination must remain outside the source tree.',
    );
    expect(existsSync(join(fixture.app, 'backup'))).toBe(false);
  });

  it('refuses while the application writer is live and on deployed profiles', async () => {
    const fixture = makeFixture();
    await fixture.run(['setup']);
    writeFileSync(
      join(fixture.stateRoot(), 'writer.lease'),
      `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, instance: '0123456789abcdef0123456789abcdef' })}\n`,
    );
    const destination = join(fixture.root, 'backup-live');
    expect(await fixture.run(['backup', destination])).toBe(1);
    expect(fixture.stderrJson().message).toContain(
      'Another application writer is active',
    );
    expect(existsSync(destination)).toBe(false);
    fixture.setProfile('self-hosted');
    expect(await fixture.run(['backup'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'This scaffold delegates deployed backups to the selected operator or managed provider.',
    );
  });

  it('refuses storage with the wrong mode or a foreign app marker without repairing it', async () => {
    const fixture = makeFixture();
    await fixture.run(['setup']);
    chmodSync(fixture.data, 0o755);
    expect(await fixture.run(['backup', join(fixture.root, 'b1')])).toBe(1);
    expect(statSync(fixture.data).mode & 0o777).toBe(0o755);
    chmodSync(fixture.data, 0o700);
    process.env.SMRT_APP_ID = 'other-app';
    expect(await fixture.run(['backup', join(fixture.root, 'b2')])).toBe(1);
    expect(existsSync(join(fixture.root, 'b2'))).toBe(false);
  });
});

describe('smrt app export / import', () => {
  async function seededApplication() {
    const fixture = makeFixture();
    await fixture.run(['setup']);
    mkdirSync(join(fixture.app, '.smrt'), { recursive: true });
    writeFileSync(
      join(fixture.app, '.smrt', 'manifest.json'),
      JSON.stringify({
        objects: {
          'ops:Item': {
            className: 'Item',
            schema: {
              tableName: 'items',
              columns: { id: { primaryKey: true }, title: {} },
            },
          },
          'ops:Session': {
            className: 'Session',
            schema: {
              tableName: 'sessions',
              columns: { id: { primaryKey: true }, token: {} },
            },
          },
        },
      }),
    );
    const paths = resolveLocalRuntimePaths({
      appId: fixture.appId,
      dataDirectory: fixture.data,
      sourceRoot: fixture.app,
    });
    const db = await getDatabase({ type: 'sqlite', url: paths.database });
    await db.query('CREATE TABLE items (id TEXT PRIMARY KEY, title TEXT)');
    await db.query('CREATE TABLE sessions (id TEXT PRIMARY KEY, token TEXT)');
    await db.query("INSERT INTO items VALUES ('item-1', 'First')");
    await db.query(`INSERT INTO sessions VALUES ('s-1', '${TOKEN}')`);
    await db.close?.();
    return { fixture, paths };
  }

  it('exports without secrets, never replaces a file, and imports into an empty target only', async () => {
    const { fixture, paths } = await seededApplication();
    const bundle = join(fixture.root, 'exports', 'app.json');
    expect(await fixture.run(['export', bundle])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'exported',
      path: bundle,
      tableCount: 2,
      assetsIncluded: true,
      assetCount: 0,
    });
    expect(statSync(bundle).mode & 0o777).toBe(0o600);
    const serialized = readFileSync(bundle, 'utf8');
    expect(serialized).not.toContain(TOKEN);
    expect(JSON.parse(serialized)).toMatchObject({
      schemaVersion: 2,
      application: 'ops-app',
    });

    expect(await fixture.run(['export', bundle])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      `Export destination already exists: ${bundle}`,
    );
    expect(
      await fixture.run(['export', join(fixture.app, 'export.json')]),
    ).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Export destination must remain outside the source tree.',
    );

    // The live database is never merged into or overwritten.
    expect(await fixture.run(['import', bundle])).toBe(1);
    expect(fixture.stderrJson().message).toBe('Import target is not empty.');

    const db = await getDatabase({ type: 'sqlite', url: paths.database });
    await db.query('DELETE FROM items');
    await db.query('DELETE FROM sessions');
    await db.close?.();
    expect(await fixture.run(['import', '--', bundle])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'imported',
      path: bundle,
      rowCount: 1,
      assetsIncluded: true,
      assetCount: 0,
    });
    expectNoLocks(fixture);
  });

  it('refuses unsafe, foreign, and missing import sources', async () => {
    const { fixture } = await seededApplication();
    const bundle = join(fixture.root, 'exports', 'app.json');
    await fixture.run(['export', bundle]);

    expect(await fixture.run(['import'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Usage: pnpm app:import -- /absolute/path/export.json',
    );

    const readable = join(fixture.root, 'readable.json');
    writeFileSync(readable, readFileSync(bundle));
    chmodSync(readable, 0o644);
    expect(await fixture.run(['import', readable])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Asset portability validation failed (unsafe-bundle-file).',
    );
    // An operator-supplied symlink is resolved (as the template did) and the
    // target must itself be a private regular file outside the checkout.
    const linked = join(fixture.root, 'linked.json');
    symlinkSync(readable, linked);
    expect(await fixture.run(['import', linked])).toBe(1);
    expect(fixture.stderrJson().message).toContain('unsafe-bundle-file');
    writeFileSync(join(fixture.app, 'inside.json'), '{}', { mode: 0o600 });
    const intoSource = join(fixture.root, 'into-source.json');
    symlinkSync(join(fixture.app, 'inside.json'), intoSource);
    expect(await fixture.run(['import', intoSource])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Import source must remain outside the source tree.',
    );

    const foreign = join(fixture.root, 'foreign.json');
    const parsed = JSON.parse(readFileSync(bundle, 'utf8'));
    writeFileSync(
      foreign,
      JSON.stringify({ ...parsed, application: 'other-app' }),
      { mode: 0o600 },
    );
    expect(await fixture.run(['import', foreign])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'The export belongs to a different application.',
    );

    expect(
      await fixture.run(['import', join(fixture.app, '..', 'app', 'x.json')]),
    ).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Import source must remain outside the source tree.',
    );
  });

  it('requires maintenance mode for a deployed import', async () => {
    const fixture = makeFixture();
    fixture.setProfile('self-hosted');
    process.env.DATABASE_URL = `postgresql://owner:${DB_PASSWORD}@db.example/app`;
    expect(
      await fixture.run(['import', join(fixture.root, 'bundle.json')]),
    ).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Stop deployed web/workers and set SMRT_MAINTENANCE_MODE=true before importing.',
    );
    expect(allOutput(fixture)).not.toContain(DB_PASSWORD);
  });

  it("keeps the application's scripts/smrt-portability.mjs adapter as the extension point", async () => {
    const { fixture } = await seededApplication();
    mkdirSync(join(fixture.app, 'scripts'), { recursive: true });
    writeFileSync(
      join(fixture.app, 'scripts', 'smrt-portability.mjs'),
      'export async function exportApplication(context) { return { path: context.path, custom: true }; }\n',
    );
    const destination = join(fixture.root, 'custom.json');
    expect(await fixture.run(['export', destination])).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'exported',
      path: destination,
      custom: true,
    });
  });
});

describe('smrt app migrate', () => {
  it('prepares local custody and runs db:migrate with the local database', async () => {
    const fixture = makeFixture();
    expect(await fixture.run(['migrate'])).toBe(0);
    const paths = resolveLocalRuntimePaths({
      appId: fixture.appId,
      dataDirectory: fixture.data,
      sourceRoot: fixture.app,
    });
    expect(fixture.calls.smrt).toHaveLength(1);
    expect(fixture.calls.smrt[0].args).toEqual(['db:migrate']);
    expect(fixture.calls.smrt[0].env).toMatchObject({
      SMRT_APP_ID: 'ops-app',
      DATABASE_TYPE: 'sqlite',
      DATABASE_URL: paths.database,
      SMRT_ASSETS_DIR: paths.assets,
    });
    expect(lstatSync(fixture.data).mode & 0o777).toBe(0o700);
    expect(existsSync(join(fixture.data, '.smrt-local-runtime-ops-app'))).toBe(
      true,
    );
    expectNoLocks(fixture);
  });

  it('refuses while a writer is live and reports a failed migration', async () => {
    const fixture = makeFixture();
    await fixture.run(['migrate']);
    writeFileSync(
      join(fixture.stateRoot(), 'writer.lease'),
      `${JSON.stringify({ schemaVersion: 1, pid: process.ppid, instance: '0123456789abcdef0123456789abcdef' })}\n`,
    );
    expect(await fixture.run(['migrate'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Stop the local application before preparing its schema.',
    );
    rmSync(join(fixture.stateRoot(), 'writer.lease'));
    expect(
      await fixture.run(['migrate'], {
        runSmrt: () => ({
          status: 4,
          stdout: '',
          stderr: '',
          pid: 0,
          output: [],
          signal: null,
        }),
      }),
    ).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      's-m-r-t database migration failed.',
    );
    expectNoLocks(fixture);
  });
});

describe('smrt app worker', () => {
  it('refuses local profiles, missing DATABASE_URL, and a missing registration', async () => {
    const fixture = makeFixture();
    expect(await fixture.run(['worker'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Local jobs run inline or embedded; a separate worker requires self-hosted or cloud.',
    );
    fixture.setProfile('self-hosted');
    expect(await fixture.run(['worker'])).toBe(1);
    expect(fixture.stderrJson().message).toBe('DATABASE_URL is required.');
    process.env.DATABASE_URL = `postgresql://owner:${DB_PASSWORD}@db.example/app`;
    expect(await fixture.run(['worker'])).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Missing .smrt/runtime/register.js: run pnpm build before starting a worker.',
    );
  });

  it.each([
    [['scheduel']],
    [['Schedule']],
    [['tasks']],
    [['task', 'extra']],
  ])('rejects worker kind %j with a usage error before any runtime initialisation', async (args) => {
    const fixture = makeFixture();
    fixture.setProfile('self-hosted');
    process.env.DATABASE_URL = `postgresql://owner:${DB_PASSWORD}@db.example/app`;
    mkdirSync(join(fixture.app, '.smrt', 'runtime'), { recursive: true });
    writeFileSync(
      join(fixture.app, '.smrt', 'runtime', 'register.js'),
      `globalThis.__smrtRegisteredByRejected = true;\n`,
    );
    const initialize = vi.fn();
    expect(
      await fixture.run(['worker', ...args], {
        runtime: {
          ...(await import('@happyvertical/smrt-app-runtime')),
          initializeDeployedApplicationRuntime: initialize as never,
        },
      }),
    ).toBe(1);
    expect(fixture.stderrJson().message).toBe(
      'Usage: smrt app worker [task|schedule]',
    );
    expect(fixture.output.stdout.join('')).toBe('');
    expect(initialize).not.toHaveBeenCalled();
    expect(
      (globalThis as { __smrtRegisteredByRejected?: boolean })
        .__smrtRegisteredByRejected,
    ).toBeUndefined();
  });

  it.each([
    [[], 'task'],
    [['task'], 'task'],
    [['schedule'], 'schedule'],
  ])('imports the registration before starting the %s runner and closes on SIGTERM', async (args, kind) => {
    const fixture = makeFixture();
    fixture.setProfile('self-hosted');
    process.env.DATABASE_URL = `postgresql://owner:${DB_PASSWORD}@db.example/app`;
    mkdirSync(join(fixture.app, '.smrt', 'runtime'), { recursive: true });
    writeFileSync(
      join(fixture.app, '.smrt', 'runtime', 'register.js'),
      `globalThis.__smrtRegistered = (globalThis.__smrtRegistered ?? 0) + 1;\n`,
    );
    const events: string[] = [];
    const close = vi.fn(async () => {
      events.push('close');
    });
    const runner = {
      start: vi.fn(async () => {
        events.push('start');
      }),
    };
    const initialize = vi.fn(async (options: Record<string, unknown>) => {
      events.push(
        `init:${(globalThis as { __smrtRegistered?: number }).__smrtRegistered ? 'registered' : 'unregistered'}`,
      );
      expect(options).toMatchObject({
        profile: 'self-hosted',
        database: { engine: 'postgres' },
      });
      return {
        createTaskWorker: vi.fn(async () => {
          events.push('task');
          return runner;
        }),
        createScheduleWorker: vi.fn(async () => {
          events.push('schedule');
          return runner;
        }),
        close,
      };
    });
    expect(
      await fixture.run(['worker', ...args], {
        runtime: {
          ...(await import('@happyvertical/smrt-app-runtime')),
          initializeDeployedApplicationRuntime: initialize as never,
        },
      }),
    ).toBe(0);
    expect(fixture.stdoutJson()).toEqual({
      schemaVersion: 1,
      status: 'ready',
      kind,
      secretValuesIncluded: false,
    });
    expect(events).toEqual(['init:registered', kind, 'start']);
    process.emit('SIGTERM');
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    process.removeAllListeners('SIGINT');
    expect(allOutput(fixture)).not.toContain(DB_PASSWORD);
  });
});

describe('smrt app dispatch', () => {
  it('renders help, rejects unknown operations, and loads .env without overriding the shell', async () => {
    const fixture = makeFixture();
    expect(await fixture.run(['help'])).toBe(0);
    expect(fixture.output.stdout.join('')).toContain(
      'Usage: smrt app <operation> [args]',
    );
    expect(await fixture.run(['launch'])).toBe(1);
    expect(fixture.stderrJson()).toMatchObject({
      status: 'error',
      code: 'operation-failed',
      message: 'Unknown app operation: launch',
    });
    writeFileSync(
      join(fixture.app, '.env'),
      `SMRT_APP_ID=from-dotenv\nSMRT_FROM_DOTENV=yes\n`,
    );
    process.env.SMRT_APP_ID = 'shell-app';
    await fixture.run(['doctor']);
    expect(process.env.SMRT_APP_ID).toBe('shell-app');
    expect(process.env.SMRT_FROM_DOTENV).toBe('yes');
  });

  it('fails with the envelope when the application has no package.json', async () => {
    const fixture = makeFixture();
    rmSync(join(fixture.app, 'package.json'));
    expect(await fixture.run(['setup'])).toBe(1);
    expect(fixture.stderrJson()).toMatchObject({
      status: 'error',
      secretValuesIncluded: false,
    });
  });
});
