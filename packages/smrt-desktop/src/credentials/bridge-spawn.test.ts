import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { SecretString } from '../secret-string.js';
import {
  CANARY_BODY,
  CANARY_TOKEN,
  CANARY_TOKEN_2,
  FUTURE,
  ORIGIN,
  thrown,
} from '../testing/credentials.js';
import {
  type BridgeHandoff,
  spawnBridgeWithCredential,
} from './bridge-spawn.js';
import type { CredentialLease } from './control-handler.js';

const fakeBridge = fileURLToPath(
  new URL('../testing/fake-bridge.mjs', import.meta.url),
);
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const lease = (token = CANARY_TOKEN, origin = ORIGIN): CredentialLease => ({
  token: new SecretString(token),
  origin,
  expiresAt: FUTURE,
});

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type Report = Record<string, unknown> & { type: string };

/** Collects the JSON lines the fake bridge prints on stdout. */
class Reports {
  readonly all: Report[] = [];
  readonly #waiters: Array<{
    match: (report: Report) => boolean;
    resolve: (report: Report) => void;
  }> = [];

  constructor(handoff: BridgeHandoff) {
    const lines = createInterface({
      input: handoff.child.stdout as NodeJS.ReadableStream,
    });
    lines.on('line', (line) => {
      const report = JSON.parse(line) as Report;
      this.all.push(report);
      for (const waiter of [...this.#waiters]) {
        if (waiter.match(report)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
          waiter.resolve(report);
        }
      }
    });
  }

  next(match: (report: Report) => boolean, timeoutMs = 8000): Promise<Report> {
    const existing = this.all.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      this.#waiters.push({
        match,
        resolve: (report) => {
          clearTimeout(timer);
          resolve(report);
        },
      });
    });
  }
}

const started: BridgeHandoff[] = [];
afterEach(() => {
  for (const handoff of started.splice(0)) {
    handoff.close();
    handoff.child.kill('SIGKILL');
  }
});

function launch(
  options: {
    lease?: CredentialLease;
    refresh?: (signal: AbortSignal) => Promise<CredentialLease>;
    args?: string[];
    env?: Record<string, string>;
  } = {},
) {
  const handoff = spawnBridgeWithCredential({
    command: process.execPath,
    args: [fakeBridge, '--credential-fd=3', ...(options.args ?? [])],
    env: { PATH: process.env.PATH ?? '', ...options.env },
    lease: options.lease ?? lease(),
    stdio: ['pipe', 'pipe', 'inherit'],
    refresh: options.refresh,
  });
  started.push(handoff);
  return { handoff, reports: new Reports(handoff) };
}

describe('spawnBridgeWithCredential (guards, fake spawner)', () => {
  it('T3: argv and env passed to the spawner never contain the token', () => {
    const captured: Array<{
      command: string;
      args: readonly string[];
      env: unknown;
      stdio: unknown;
    }> = [];
    const fakeChild = Object.assign(new EventEmitter(), {
      stdio: [null, null, null, new PassThrough()],
      kill: () => true,
    });
    spawnBridgeWithCredential({
      command: '/bundle/node',
      args: ['/bundle/bridge.mjs', '--credential-fd=3'],
      env: { PATH: '/usr/bin', HOME: '/home/u' },
      lease: lease(),
      spawn: ((
        command: string,
        args: readonly string[],
        options: { env: unknown; stdio: unknown },
      ) => {
        captured.push({
          command,
          args,
          env: options.env,
          stdio: options.stdio,
        });
        return fakeChild;
      }) as never,
    });
    expect(captured).toHaveLength(1);
    const seen = JSON.stringify(captured[0]);
    expect(seen).not.toContain(CANARY_BODY);
    expect(captured[0]?.stdio).toEqual([
      'inherit',
      'inherit',
      'inherit',
      'pipe',
    ]);
    expect(captured[0]?.env).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
  });

  it('T3/T4: refuses to spawn when the token is in argv, env or command', async () => {
    for (const patch of [
      { args: [`--token=${CANARY_TOKEN}`] },
      { env: { SMRT_NOTES_TOKEN: CANARY_TOKEN } },
      { env: { X: `a${CANARY_TOKEN}b` } },
    ]) {
      const error = await thrown(() =>
        spawnBridgeWithCredential({
          command: process.execPath,
          args: [fakeBridge, ...(patch.args ?? [])],
          env: { PATH: '/usr/bin', ...patch.env },
          lease: lease(),
          spawn: (() => {
            throw new Error('must not spawn');
          }) as never,
        }),
      );
      expect(error).toBeInstanceOf(DesktopContractError);
      expect((error as DesktopContractError).code).toBe('handoff_failed');
      expect(JSON.stringify(error)).not.toContain(CANARY_BODY);
      expect((error as Error).message).not.toContain(CANARY_BODY);
    }
  });

  it('T13: refuses a lease for a non-loopback origin', async () => {
    const error = await thrown(() =>
      spawnBridgeWithCredential({
        command: process.execPath,
        env: {},
        lease: lease(CANARY_TOKEN, 'http://localhost:4678'),
        spawn: (() => {
          throw new Error('must not spawn');
        }) as never,
      }),
    );
    expect((error as DesktopContractError).code).toBe('handoff_failed');
  });

  it('reports a failing spawn as handoff_failed without the cause', async () => {
    const error = await thrown(() =>
      spawnBridgeWithCredential({
        command: '/x',
        env: {},
        lease: lease(),
        spawn: (() => {
          throw new Error(`boom ${CANARY_TOKEN}`);
        }) as never,
      }),
    );
    expect((error as DesktopContractError).code).toBe('handoff_failed');
    expect((error as Error).cause).toBeUndefined();
    expect((error as Error).stack).not.toContain(CANARY_BODY);
  });
});

describe('fd 3 handoff to a real child process', () => {
  it('delivers the initial frame over fd 3 and keeps the token out of argv and env', async () => {
    const { handoff, reports } = launch({
      env: { SMRT_NOTES_SERVER_URL: ORIGIN },
    });
    const startedReport = await reports.next((r) => r.type === 'started');
    const frame = await reports.next((r) => r.type === 'frame');

    // What the child itself saw as argv and environment.
    const childText = JSON.stringify([startedReport.argv, startedReport.env]);
    expect(childText).not.toContain(CANARY_BODY);
    expect(startedReport.argv).toEqual([
      process.execPath,
      fakeBridge,
      '--credential-fd=3',
    ]);
    // The env is exactly what the launcher passed (no inherited process.env).
    const childEnv = startedReport.env as Record<string, string>;
    expect(childEnv.SMRT_NOTES_SERVER_URL).toBe(ORIGIN);
    expect(Object.keys(childEnv).some((key) => /TOKEN/i.test(key))).toBe(false);

    // The token arrived, only over the pipe.
    expect(frame).toMatchObject({
      frameType: 'credential',
      seq: 0,
      origin: ORIGIN,
      tokenSha: sha(CANARY_TOKEN),
    });
    expect(handoff.child.pid).toBeGreaterThan(0);
  });

  posixOnly('as observed from outside the process', () => {
    it('T3: ps shows no token in the child command line', async () => {
      const { handoff, reports } = launch();
      await reports.next((r) => r.type === 'frame');
      const args = execFileSync(
        'ps',
        ['-o', 'args=', '-p', String(handoff.child.pid)],
        {
          encoding: 'utf8',
        },
      );
      expect(args).toContain('--credential-fd=3');
      expect(args).not.toContain(CANARY_BODY);
    });

    it('T4: the child environment as the OS reports it holds no token', async () => {
      const { handoff, reports } = launch({
        env: { SMRT_NOTES_SERVER_URL: ORIGIN },
      });
      await reports.next((r) => r.type === 'frame');
      const pid = String(handoff.child.pid);
      let environment: string;
      if (process.platform === 'linux') {
        environment = readFileSync(`/proc/${pid}/environ`, 'utf8');
      } else {
        // macOS: `ps eww` appends the environment of own-user processes.
        environment = execFileSync('ps', ['eww', '-o', 'command=', '-p', pid], {
          encoding: 'utf8',
        });
      }
      expect(environment).toContain('SMRT_NOTES_SERVER_URL');
      expect(environment).not.toContain(CANARY_BODY);
    });
  });

  it('T7: a refresh request after a simulated 401 delivers the rotated token', async () => {
    let calls = 0;
    const { handoff, reports } = launch({
      refresh: async () => {
        calls += 1;
        return lease(CANARY_TOKEN_2, 'http://127.0.0.1:4700');
      },
    });
    await reports.next((r) => r.type === 'frame' && r.seq === 0);
    handoff.child.stdin?.write('401\n');
    const refreshed = await reports.next(
      (r) => r.type === 'frame' && r.seq === 1,
    );
    expect(calls).toBe(1);
    expect(refreshed).toMatchObject({
      frameType: 'credential',
      origin: 'http://127.0.0.1:4700',
      tokenSha: sha(CANARY_TOKEN_2),
    });
    // The old token is never re-sent.
    expect(
      reports.all.filter((r) => r.tokenSha === sha(CANARY_TOKEN)),
    ).toHaveLength(1);
  });

  it('answers a refresh with unavailable and the right code when the lease cannot be had', async () => {
    const { handoff, reports } = launch({
      refresh: async () => {
        throw new DesktopContractError('credential_invalid');
      },
    });
    await reports.next((r) => r.type === 'frame' && r.seq === 0);
    handoff.child.stdin?.write('401\n');
    const frame = await reports.next((r) => r.frameType === 'unavailable');
    expect(frame).toMatchObject({ seq: 1, code: 'credential_invalid' });
  });

  it('answers every refresh with credential_unavailable when none is configured', async () => {
    const { handoff, reports } = launch();
    await reports.next((r) => r.type === 'frame' && r.seq === 0);
    handoff.child.stdin?.write('401\n');
    const frame = await reports.next((r) => r.frameType === 'unavailable');
    expect(frame).toMatchObject({ code: 'credential_unavailable' });
  });

  it('pushes a rotated credential without being asked', async () => {
    const { handoff, reports } = launch();
    await reports.next((r) => r.type === 'frame' && r.seq === 0);
    await handoff.sendCredential(lease(CANARY_TOKEN_2));
    const frame = await reports.next((r) => r.type === 'frame' && r.seq === 1);
    expect(frame.tokenSha).toBe(sha(CANARY_TOKEN_2));
  });

  it('drops the channel on a garbage frame instead of crashing the launcher', async () => {
    const { handoff, reports } = launch();
    await reports.next((r) => r.type === 'frame');
    handoff.child.stdin?.write('garbage\n');
    // The pipe is closed, so the fake bridge exits via its close handler.
    await new Promise<void>((resolve) =>
      handoff.child.once('exit', () => resolve()),
    );
    const error = await thrown(() => handoff.sendCredential(lease()));
    expect((error as DesktopContractError).code).toBe('handoff_failed');
  });

  it('closes the pipe when the child exits', async () => {
    const { handoff, reports } = launch();
    await reports.next((r) => r.type === 'frame');
    handoff.child.stdin?.write('exit\n');
    await new Promise<void>((resolve) =>
      handoff.child.once('exit', () => resolve()),
    );
    const error = await thrown(() => handoff.sendCredential(lease()));
    expect((error as DesktopContractError).code).toBe('handoff_failed');
  });
});
