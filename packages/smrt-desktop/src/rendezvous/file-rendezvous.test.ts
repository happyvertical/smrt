import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { nodeFs } from '../internal/fs-seam.js';
import {
  BUNDLE,
  installationFixture,
  ORIGIN,
  PRODUCT,
  SHELL_EXECUTABLE,
} from '../testing/rendezvous-fixture.js';
import { createControlHandlerRegistry } from './control-transport.js';
import { SHELL_FAILURE_CODES } from './failure-code.js';
import {
  createFileRendezvous,
  type FileRendezvousOptions,
  type RendezvousFs,
  type RendezvousResult,
  SHELL_BACKGROUND_FLAG,
  type ShellLaunch,
  shellLaunchEnvironment,
} from './file-rendezvous.js';
import {
  INSTANCE_RECORD_FILENAME,
  type InstanceRecordV1,
  serializeInstanceRecord,
} from './instance-record.js';
import {
  createReferenceSupervisor,
  type ReferenceShell,
  type ReferenceShellOptions,
  startReferenceShell,
} from './reference-shell.js';

const SECRET = 'smrt_mcp_LEAKCANARY0123456789';
const NONCE_B = 'ffeeddccbbaa99887766554433221100';

// Needs Unix domain sockets and POSIX owner/mode bits. On Windows the same
// contract uses a named pipe and ACLs that only the Rust shell can verify, so
// there is nothing for the Node reference to exercise.
const posixOnly = process.platform === 'win32' ? describe.skip : describe;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

posixOnly(
  'file rendezvous (skipped on win32: unix sockets and POSIX modes)',
  () => {
    let dir: string;
    const shells: ReferenceShell[] = [];
    let spawnShell: ReturnType<
      typeof vi.fn<(launch: ShellLaunch) => Promise<void>>
    >;

    beforeEach(() => {
      // Short path: a unix socket path is limited to 104 bytes on macOS.
      dir = mkdtempSync('/tmp/smrt-rdv-');
      chmodSync(dir, 0o700);
      spawnShell = vi.fn(async () => {});
    });
    afterEach(async () => {
      for (const shell of shells.splice(0)) await shell.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const boot = async (options: Partial<ReferenceShellOptions> = {}) => {
      const shell = await startReferenceShell({
        shellDirectory: dir,
        productId: PRODUCT,
        bundleId: BUNDLE,
        ...options,
      });
      shells.push(shell);
      return shell;
    };
    const bootReady = async (options: Partial<ReferenceShellOptions> = {}) => {
      const shell = await boot(options);
      shell.supervisor.ready(ORIGIN);
      await shell.flush();
      return shell;
    };
    const make = (overrides: Partial<FileRendezvousOptions> = {}) =>
      createFileRendezvous({
        locate: async () => installationFixture(dir),
        spawnShell,
        pollIntervalMs: 5,
        maxPollIntervalMs: 20,
        ...overrides,
      });
    const recordPath = () => `${dir}/${INSTANCE_RECORD_FILENAME}`;
    const recordText = (
      overrides: Partial<InstanceRecordV1> & {
        control: InstanceRecordV1['control'];
      },
    ) =>
      serializeInstanceRecord({
        version: 1,
        productId: PRODUCT,
        bundleId: BUNDLE,
        instanceNonce: NONCE_B,
        pid: 4242,
        shellVersion: '1.0.0',
        startedAt: '2026-11-01T12:00:00Z',
        updatedAt: '2026-11-01T12:00:00Z',
        state: 'starting',
        ...overrides,
      });
    const writeRecord = (text: string, mode = 0o600) => {
      writeFileSync(recordPath(), text, { mode });
      chmodSync(recordPath(), mode);
    };

    /** A fake single-instance shell: the first start boots, later ones forward. */
    const singleInstanceShell = (readyAfterMs = 20) => {
      let booting: Promise<ReferenceShell> | undefined;
      const counts = { sidecars: 0, starts: 0 };
      const start = vi.fn(async (_launch: ShellLaunch) => {
        counts.starts++;
        booting ??= (async () => {
          counts.sidecars++;
          const shell = await boot();
          setTimeout(() => shell.supervisor.ready(ORIGIN), readyAfterMs);
          return shell;
        })();
      });
      return { start, counts, booted: () => booting };
    };

    describe('reuse', () => {
      it('returns ready from a live instance without spawning', async () => {
        const shell = await bootReady();
        const result = await make().ensureReady();
        expect(result).toEqual({
          state: 'ready',
          origin: ORIGIN,
          instanceNonce: shell.supervisor.instanceNonce,
          productId: PRODUCT,
        });
        expect(Object.isFrozen(result)).toBe(true);
        expect(spawnShell).not.toHaveBeenCalled();
        expect(await make().status()).toEqual(result);
      });

      it('reports starting from status and waits on ensure-ready', async () => {
        const supervisor = createReferenceSupervisor({ productId: PRODUCT });
        const seen: string[] = [];
        const registry = createControlHandlerRegistry();
        registry.register('status', (request) => {
          seen.push(request.op);
          return supervisor.respond(request);
        });
        registry.register('ensure-ready', (request, context) => {
          seen.push(request.op);
          return supervisor.respond(request, context.signal);
        });
        const shell = await boot({ supervisor, registry });
        expect(await make().status()).toEqual({
          state: 'starting',
          instanceNonce: supervisor.instanceNonce,
        });

        setTimeout(() => supervisor.ready(ORIGIN), 60);
        const result = await make().ensureReady({ timeoutMs: 5000 });
        expect(result).toMatchObject({ state: 'ready', origin: ORIGIN });
        expect(seen).toContain('ensure-ready');
        expect(spawnShell).not.toHaveBeenCalled();
        await shell.flush();
      });

      it('returns failed(lease_held) without spawning and does not retry it', async () => {
        const shell = await boot();
        shell.supervisor.fail('lease_held');
        await shell.flush();
        expect(await make().ensureReady()).toEqual({
          state: 'failed',
          code: 'lease_held',
        });
        expect(await make().status()).toEqual({
          state: 'failed',
          code: 'lease_held',
        });
        expect(spawnShell).not.toHaveBeenCalled();
      });

      it.each(
        SHELL_FAILURE_CODES,
      )('passes the shell failure code %s through', async (code) => {
        const shell = await boot();
        shell.supervisor.fail(code);
        await shell.flush();
        expect(await make().ensureReady()).toEqual({ state: 'failed', code });
        expect(spawnShell).not.toHaveBeenCalled();
      });
    });

    describe('stale instance', () => {
      it('spawns exactly once when the socket is gone (ENOENT), then returns ready', async () => {
        const old = await bootReady();
        const oldNonce = old.supervisor.instanceNonce;
        await old.close();
        expect(existsSync(recordPath())).toBe(true);

        const start = singleInstanceShell();
        const result = await make({ spawnShell: start.start }).ensureReady();
        expect(result).toMatchObject({ state: 'ready', origin: ORIGIN });
        expect((result as { instanceNonce: string }).instanceNonce).not.toBe(
          oldNonce,
        );
        expect(start.start).toHaveBeenCalledTimes(1);
        expect(start.counts.sidecars).toBe(1);
      });

      it('spawns once when the socket file remains with no listener (ECONNREFUSED)', async () => {
        const stale = `${dir}/c-aaaabbbbccccddddeeeeffff00001111.sock`;
        const killed = spawnSync(process.execPath, [
          '-e',
          `const net=require('net'),fs=require('fs');net.createServer().listen(${JSON.stringify(stale)},()=>{fs.chmodSync(${JSON.stringify(stale)},0o600);process.kill(process.pid,'SIGKILL')})`,
        ]);
        expect(killed.signal).toBe('SIGKILL');
        expect(existsSync(stale)).toBe(true);
        writeRecord(recordText({ control: { kind: 'unix', path: stale } }));

        const start = singleInstanceShell();
        const result = await make({ spawnShell: start.start }).ensureReady();
        expect(result).toMatchObject({ state: 'ready' });
        expect(start.start).toHaveBeenCalledTimes(1);
        // The client never "repairs" what it did not write.
        expect(existsSync(stale)).toBe(true);
      });

      it('treats an unanswered status as stale and spawns', async () => {
        const server = await import('node:net');
        const path = `${dir}/c-1111222233334444555566667777aaaa.sock`;
        const hung = server.createServer((socket) =>
          socket.on('error', () => {}),
        );
        await new Promise<void>((resolve) => hung.listen(path, resolve));
        chmodSync(path, 0o600);
        try {
          writeRecord(recordText({ control: { kind: 'unix', path } }));
          const result = await make({
            statusTimeoutMs: 50,
          }).ensureReady({
            timeoutMs: 200,
          });
          expect(result).toEqual({ state: 'timeout' });
          expect(spawnShell).toHaveBeenCalledTimes(1);
        } finally {
          hung.close();
        }
      });

      it('starts the shell with the background flag, an allowlisted environment and no shell', async () => {
        await make({
          env: {
            HOME: '/home/u',
            PATH: '/usr/bin',
            XDG_DATA_HOME: '/home/u/.local/share',
            LANG: 'C',
            SMRT_NOTES_TOKEN: SECRET,
            AWS_SECRET_ACCESS_KEY: SECRET,
            FOO: 'bar',
          },
        }).ensureReady({ timeoutMs: 60 });
        expect(spawnShell).toHaveBeenCalledTimes(1);
        const launch = spawnShell.mock.calls[0]?.[0] as ShellLaunch;
        expect(launch.executable).toBe(SHELL_EXECUTABLE);
        expect(launch.args).toEqual([SHELL_BACKGROUND_FLAG]);
        expect(SHELL_BACKGROUND_FLAG).toBe('--smrt-background');
        expect(launch.cwd).toBe('/opt/smrt-notes');
        expect(launch.env).toEqual({
          HOME: '/home/u',
          PATH: '/usr/bin',
          XDG_DATA_HOME: '/home/u/.local/share',
          LANG: 'C',
        });
        expect(JSON.stringify(launch)).not.toContain(SECRET);
      });

      it('reports launch_failed when the shell cannot be started', async () => {
        spawnShell.mockRejectedValue(new Error(`ENOENT ${SECRET}`));
        const result = await make().ensureReady();
        expect(result).toEqual({ state: 'failed', code: 'launch_failed' });
        expect(spawnShell).toHaveBeenCalledTimes(1);
      });

      it('does not start anything with start:false', async () => {
        expect(await make().ensureReady({ start: false })).toEqual({
          state: 'not_running',
        });
        const old = await bootReady();
        await old.close();
        expect(await make().ensureReady({ start: false })).toEqual({
          state: 'not_running',
        });
        expect(await make().status()).toEqual({ state: 'not_running' });
        expect(spawnShell).not.toHaveBeenCalled();
      });

      it('times out when a started shell never comes up', async () => {
        const started = Date.now();
        expect(await make().ensureReady({ timeoutMs: 120 })).toEqual({
          state: 'timeout',
        });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(spawnShell).toHaveBeenCalledTimes(1);
      });

      it('never spawns a second shell when the instance becomes ready after longer than the server read timeout', async () => {
        const supervisor = createReferenceSupervisor({ productId: PRODUCT });
        await boot({ supervisor, requestReadTimeoutMs: 100 });
        setTimeout(() => supervisor.ready(ORIGIN), 400);
        const result = await make().ensureReady({ timeoutMs: 5000 });
        expect(result).toMatchObject({ state: 'ready', origin: ORIGIN });
        expect(spawnShell).not.toHaveBeenCalled();
      });

      it('re-probes status instead of spawning when a long poll is dropped after a verified starting', async () => {
        const net = await import('node:net');
        const path = `${dir}/c-aaaabbbbccccddddeeeeffff00001111.sock`;
        const asked: string[] = [];
        const answer = (state: 'starting' | 'ready') =>
          `${JSON.stringify({
            v: 1,
            ok: true,
            state,
            instanceNonce: NONCE_B,
            productId: PRODUCT,
            ...(state === 'ready' ? { origin: ORIGIN } : {}),
          })}\n`;
        const flaky = net.createServer((socket) => {
          socket.on('error', () => {});
          socket.on('data', (chunk) => {
            const op = JSON.parse(chunk.toString()).op as string;
            asked.push(op);
            if (op === 'ensure-ready') {
              socket.destroy(); // the long poll is dropped mid-wait
            } else {
              socket.end(answer(asked.length === 1 ? 'starting' : 'ready'));
            }
          });
        });
        await new Promise<void>((resolve) => flaky.listen(path, resolve));
        chmodSync(path, 0o600);
        try {
          writeRecord(
            recordText({
              control: { kind: 'unix', path },
              state: 'ready',
              origin: ORIGIN,
            }),
          );
          const result = await make().ensureReady({ timeoutMs: 5000 });
          expect(result).toMatchObject({ state: 'ready', origin: ORIGIN });
          expect(asked).toEqual(['status', 'ensure-ready', 'status']);
          expect(spawnShell).not.toHaveBeenCalled();
        } finally {
          flaky.close();
        }
      });

      it('times out while a live shell stays in starting', async () => {
        await boot();
        expect(await make().ensureReady({ timeoutMs: 150 })).toEqual({
          state: 'timeout',
        });
        expect(spawnShell).not.toHaveBeenCalled();
      });

      it('rejects with the abort reason when the signal fires while polling', async () => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 40);
        await expect(
          make().ensureReady({ signal: controller.signal, timeoutMs: 5000 }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(spawnShell).toHaveBeenCalledTimes(1);
      });

      it('rejects with the abort reason when the signal fires during a long poll', async () => {
        await boot();
        const controller = new AbortController();
        setTimeout(() => controller.abort(new Error('stop')), 60);
        await expect(
          make().ensureReady({ signal: controller.signal, timeoutMs: 5000 }),
        ).rejects.toThrow('stop');
      });

      it('rejects an already-aborted signal before doing anything', async () => {
        const controller = new AbortController();
        controller.abort();
        const locate = vi.fn(async () => installationFixture(dir));
        await expect(
          make({ locate }).ensureReady({ signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        await expect(
          make({ locate }).status({ signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(locate).not.toHaveBeenCalled();
      });

      it('validates timeoutMs', async () => {
        for (const timeoutMs of [0, -1, 1.5, Number.NaN, 700_000]) {
          await expect(make().ensureReady({ timeoutMs })).rejects.toMatchObject(
            {
              code: 'invalid_field',
            },
          );
        }
      });
    });

    describe('identity', () => {
      it('returns instance_mismatch when the record names another instance', async () => {
        const shell = await bootReady();
        writeRecord(
          recordText({
            control: shell.endpoint,
            state: 'ready',
            origin: ORIGIN,
          }),
        );
        expect(await make().ensureReady()).toEqual({
          state: 'failed',
          code: 'instance_mismatch',
        });
        expect(spawnShell).not.toHaveBeenCalled();
      });

      it('re-reads the record once and accepts a shell that just restarted', async () => {
        const shell = await bootReady();
        const stale = recordText({
          control: shell.endpoint,
          state: 'ready',
          origin: ORIGIN,
        });
        writeRecord(stale);
        const fresh = serializeInstanceRecord(shell.record());
        const clock = {
          now: () => Date.now(),
          sleep: async () => writeRecord(fresh),
        };
        const result = await make({ clock }).ensureReady();
        expect(result).toMatchObject({ state: 'ready', origin: ORIGIN });
        expect(spawnShell).not.toHaveBeenCalled();
      });

      it('returns instance_mismatch when the record origin differs from the channel', async () => {
        const shell = await bootReady();
        const record = shell.record();
        writeRecord(
          serializeInstanceRecord({
            ...record,
            origin: 'http://127.0.0.1:49153',
          }),
        );
        expect(await make().ensureReady()).toEqual({
          state: 'failed',
          code: 'instance_mismatch',
        });
      });

      it('returns instance_mismatch when the channel says ready but the record does not', async () => {
        const shell = await bootReady();
        writeRecord(
          serializeInstanceRecord({
            ...shell.record(),
            state: 'starting',
            origin: undefined,
          }),
        );
        expect(await make().status()).toEqual({
          state: 'failed',
          code: 'instance_mismatch',
        });
      });

      it('returns instance_mismatch when the record belongs to another product', async () => {
        const shell = await bootReady();
        writeRecord(
          serializeInstanceRecord({
            ...shell.record(),
            productId: 'other-app',
          }),
        );
        expect(await make().ensureReady()).toEqual({
          state: 'failed',
          code: 'instance_mismatch',
        });
        writeRecord(
          serializeInstanceRecord({
            ...shell.record(),
            bundleId: 'com.example.other',
          }),
        );
        expect(await make().ensureReady()).toEqual({
          state: 'failed',
          code: 'instance_mismatch',
        });
        expect(spawnShell).not.toHaveBeenCalled();
      });

      it('rejects a shell that answers for another product', async () => {
        const supervisor = createReferenceSupervisor({
          productId: 'other-app',
        });
        supervisor.ready(ORIGIN);
        const shell = await boot({ supervisor, productId: PRODUCT });
        expect(shell.record().productId).toBe(PRODUCT);
        expect(await make().ensureReady()).toEqual({
          state: 'failed',
          code: 'instance_mismatch',
        });
      });

      it('returns a record with an unknown contract version as unsupported_contract', async () => {
        const shell = await bootReady();
        writeRecord(
          serializeInstanceRecord(shell.record()).replace(
            '"version": 1',
            '"version": 2',
          ),
        );
        expect(await make().ensureReady()).toEqual({
          state: 'failed',
          code: 'unsupported_contract',
        });
        expect(spawnShell).not.toHaveBeenCalled();
      });
    });

    describe('protocol refusals from a live peer', () => {
      const refusing = async (code: string) => {
        const registry = createControlHandlerRegistry();
        registry.register('status', () => ({ v: 1, ok: false, code }));
        registry.register('ensure-ready', () => ({ v: 1, ok: false, code }));
        await boot({ registry });
      };

      it.each([
        ['forbidden', { state: 'untrusted_state' }],
        [
          'unsupported_version',
          { state: 'failed', code: 'unsupported_contract' },
        ],
        ['bad_request', { state: 'failed', code: 'unsupported_contract' }],
        ['internal', { state: 'failed', code: 'unknown' }],
      ])('maps %s', async (code, expected) => {
        await refusing(code);
        expect(await make().ensureReady()).toEqual(expected);
        expect(spawnShell).not.toHaveBeenCalled();
      });
    });

    describe('untrusted state never spawns', () => {
      const expectUntrusted = async (
        overrides: Partial<FileRendezvousOptions> = {},
      ) => {
        expect(await make(overrides).ensureReady()).toEqual({
          state: 'untrusted_state',
        });
        expect(await make(overrides).status()).toEqual({
          state: 'untrusted_state',
        });
        expect(spawnShell).not.toHaveBeenCalled();
      };

      it('a record that group or others can read', async () => {
        const shell = await bootReady();
        writeRecord(serializeInstanceRecord(shell.record()), 0o644);
        await expectUntrusted();
      });

      it('a record that is a symlink', async () => {
        const shell = await bootReady();
        const target = `${dir}/elsewhere.json`;
        writeFileSync(target, serializeInstanceRecord(shell.record()), {
          mode: 0o600,
        });
        rmSync(recordPath());
        symlinkSync(target, recordPath());
        await expectUntrusted();
      });

      it('a record that is not valid', async () => {
        await bootReady();
        writeRecord('{"version":1}');
        await expectUntrusted();
        writeRecord('not json');
        await expectUntrusted();
      });

      it('a record owned by another user', async () => {
        await bootReady();
        await expectUntrusted({ currentUid: (process.getuid?.() ?? 0) + 1 });
      });

      it('a private state directory that others can enter', async () => {
        await bootReady();
        chmodSync(dir, 0o755);
        await expectUntrusted();
      });

      it('a socket directory that others can enter', async () => {
        const socketDirectory = mkdtempSync('/tmp/smrt-rdv-s-');
        chmodSync(socketDirectory, 0o700);
        try {
          await bootReady({ socketDirectory });
          chmodSync(socketDirectory, 0o755);
          await expectUntrusted();
        } finally {
          chmodSync(socketDirectory, 0o700);
          await shells.pop()?.close();
          rmSync(socketDirectory, { recursive: true, force: true });
        }
      });

      it('a socket directory that is a symlink', async () => {
        const real = mkdtempSync('/tmp/smrt-rdv-r-');
        const link = `${real}-link`;
        chmodSync(real, 0o700);
        symlinkSync(real, link);
        try {
          await bootReady({ socketDirectory: real });
          const shell = shells[shells.length - 1] as ReferenceShell;
          const endpoint = shell.endpoint;
          if (endpoint.kind !== 'unix')
            throw new Error('expected a unix endpoint');
          const viaLink = `${link}/${endpoint.path.split('/').pop()}`;
          writeRecord(
            serializeInstanceRecord({
              ...shell.record(),
              control: { kind: 'unix', path: viaLink },
            }),
          );
          await expectUntrusted();
        } finally {
          await shells.pop()?.close();
          rmSync(link, { force: true });
          rmSync(real, { recursive: true, force: true });
        }
      });

      it('a socket that group or others can reach', async () => {
        const shell = await bootReady();
        if (shell.endpoint.kind !== 'unix') throw new Error('expected unix');
        chmodSync(shell.endpoint.path, 0o660);
        await expectUntrusted();
      });

      it('a regular file where the socket should be', async () => {
        const shell = await bootReady();
        const path = `${dir}/c-9999888877776666555544443333aaaa.sock`;
        writeFileSync(path, '', { mode: 0o600 });
        writeRecord(
          serializeInstanceRecord({
            ...shell.record(),
            control: { kind: 'unix', path },
          }),
        );
        await expectUntrusted();
      });

      it('a pipe endpoint on a unix platform', async () => {
        const shell = await bootReady();
        writeRecord(
          serializeInstanceRecord({
            ...shell.record(),
            control: {
              kind: 'pipe',
              name: `\\\\.\\pipe\\smrt-0123456789abcdef-${NONCE_B}`,
            },
          }),
        );
        await expectUntrusted();
      });

      it('a peer that answers with garbage', async () => {
        const net = await import('node:net');
        const path = `${dir}/c-aaaa0000bbbb1111cccc2222dddd3333.sock`;
        const garbage = net.createServer((socket) => {
          socket.on('error', () => {});
          socket.on('data', () => socket.end('definitely not json\n'));
        });
        await new Promise<void>((resolve) => garbage.listen(path, resolve));
        chmodSync(path, 0o600);
        try {
          writeRecord(recordText({ control: { kind: 'unix', path } }));
          await expectUntrusted();
        } finally {
          garbage.close();
        }
      });
    });

    describe('installation errors', () => {
      const locating = (
        code: ConstructorParameters<typeof DesktopContractError>[0],
      ) =>
        make({
          locate: async () => {
            throw new DesktopContractError(code);
          },
        });

      it.each([
        ['not_installed', { state: 'not_installed' }],
        ['identity_mismatch', { state: 'failed', code: 'identity_mismatch' }],
        [
          'unsupported_contract',
          { state: 'failed', code: 'unsupported_contract' },
        ],
        ['untrusted_path', { state: 'untrusted_state' }],
        ['invalid_document', { state: 'untrusted_state' }],
        ['sidecar_mismatch', { state: 'untrusted_state' }],
      ] as const)('maps locate error %s', async (code, expected) => {
        expect(await locating(code).ensureReady()).toEqual(expected);
        expect(await locating(code).status()).toEqual(expected);
        expect(spawnShell).not.toHaveBeenCalled();
      });

      it('rethrows configuration and unexpected errors', async () => {
        await expect(
          locating('invalid_environment').status(),
        ).rejects.toMatchObject({
          code: 'invalid_environment',
        });
        await expect(
          make({
            locate: async () => {
              throw new TypeError('bug');
            },
          }).ensureReady(),
        ).rejects.toThrow(TypeError);
      });
    });

    describe('exclusion', () => {
      it('two launchers racing against a single-instance shell start exactly one sidecar', async () => {
        const shell = singleInstanceShell(40);
        const a = make({ spawnShell: shell.start });
        const b = make({ spawnShell: shell.start });
        const [ra, rb] = await Promise.all([
          a.ensureReady({ timeoutMs: 5000 }),
          b.ensureReady({ timeoutMs: 5000 }),
        ]);
        expect(ra).toMatchObject({ state: 'ready', origin: ORIGIN });
        expect(rb).toEqual(ra);
        expect(shell.counts.sidecars).toBe(1);
        // Both launchers may have started the shell; the shell deduplicates.
        expect(shell.counts.starts).toBeGreaterThanOrEqual(1);
        expect(shell.counts.starts).toBeLessThanOrEqual(2);
      });

      it('concurrent calls on one object share a single spawn', async () => {
        const shell = singleInstanceShell(40);
        const slow = vi.fn(async (launch: ShellLaunch) => {
          await sleep(30);
          await shell.start(launch);
        });
        const rendezvous = make({ spawnShell: slow });
        const results = await Promise.all([
          rendezvous.ensureReady({ timeoutMs: 5000 }),
          rendezvous.ensureReady({ timeoutMs: 5000 }),
          rendezvous.ensureReady({ timeoutMs: 5000 }),
        ]);
        expect(slow).toHaveBeenCalledTimes(1);
        expect(shell.counts.sidecars).toBe(1);
        expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      });

      it('spawns at most once per call even when the shell takes long to appear', async () => {
        const rendezvous = make();
        await rendezvous.ensureReady({ timeoutMs: 100 });
        expect(spawnShell).toHaveBeenCalledTimes(1);
        await rendezvous.ensureReady({ timeoutMs: 100 });
        expect(spawnShell).toHaveBeenCalledTimes(2);
      });
    });

    describe('read-only client', () => {
      const spy = () => {
        const calls: string[] = [];
        const fs: RendezvousFs = {
          open: async (path, flags, mode) => {
            const writing =
              constants.O_WRONLY |
              constants.O_RDWR |
              constants.O_CREAT |
              constants.O_TRUNC |
              constants.O_APPEND;
            calls.push(
              flags & writing ? `write-open:${path}` : `read-open:${path}`,
            );
            return nodeFs.open(path, flags, mode);
          },
          lstat: async (path) => {
            calls.push(`lstat:${path}`);
            const { lstat } = await import('node:fs/promises');
            return lstat(path);
          },
          realpath: async (path) => {
            calls.push(`realpath:${path}`);
            return nodeFs.realpath(path);
          },
          rename: async (from, to) => {
            calls.push(`rename:${from}>${to}`);
            return nodeFs.rename(from, to);
          },
          unlink: async (path) => {
            calls.push(`unlink:${path}`);
            return nodeFs.unlink(path);
          },
        };
        return { fs, calls };
      };
      const writes = (calls: string[]) =>
        calls.filter((call) => /^(write-open|rename|unlink):/.test(call));
      const snapshot = () => ({
        names: readdirSync(dir).sort(),
        record: existsSync(recordPath())
          ? readFileSync(recordPath(), 'utf8')
          : null,
      });

      it('never writes, renames or unlinks while reusing a ready instance', async () => {
        await bootReady();
        const { fs, calls } = spy();
        const before = snapshot();
        await make({ fs }).ensureReady();
        await make({ fs }).status();
        expect(calls.some((call) => call.startsWith('read-open:'))).toBe(true);
        expect(writes(calls)).toEqual([]);
        expect(snapshot()).toEqual(before);
      });

      it('never writes, renames or unlinks a stale socket or record', async () => {
        const old = await bootReady();
        await old.close();
        const stale = `${dir}/c-aaaabbbbccccddddeeeeffff00001111.sock`;
        writeRecord(recordText({ control: { kind: 'unix', path: stale } }));
        const { fs, calls } = spy();
        const before = snapshot();
        await make({ fs }).ensureReady({ timeoutMs: 60 });
        expect(writes(calls)).toEqual([]);
        expect(snapshot()).toEqual(before);
        expect(spawnShell).toHaveBeenCalledTimes(1);
      });

      it('never writes while rejecting an untrusted state', async () => {
        const shell = await bootReady();
        writeRecord(serializeInstanceRecord(shell.record()), 0o644);
        const { fs, calls } = spy();
        const before = snapshot();
        await make({ fs }).ensureReady();
        expect(writes(calls)).toEqual([]);
        expect(snapshot()).toEqual(before);
        expect(statSync(recordPath()).mode & 0o777).toBe(0o644);
      });
    });

    describe('results carry no secret, path or pid', () => {
      it('keeps them out of every result and every thrown error', async () => {
        const collected: unknown[] = [];
        const shell = await bootReady({ pid: 987654 });
        const secretEnv = { SMRT_NOTES_TOKEN: SECRET, HOME: dir };
        collected.push(await make({ env: secretEnv }).ensureReady());
        collected.push(await make({ env: secretEnv }).status());
        writeRecord('{"version":1}', 0o600);
        collected.push(await make({ env: secretEnv }).ensureReady());
        writeRecord(serializeInstanceRecord(shell.record()), 0o644);
        collected.push(await make({ env: secretEnv }).status());
        for (const code of ['not_installed', 'untrusted_path'] as const) {
          collected.push(
            await make({
              locate: async () => {
                throw new DesktopContractError(code);
              },
            }).ensureReady(),
          );
        }
        const text = JSON.stringify(collected);
        expect(text).not.toContain(dir);
        expect(text).not.toContain('987654');
        expect(text).not.toContain('pid');
        expect(text).not.toContain(SECRET);
        expect(text).not.toContain('.sock');
        for (const result of collected as RendezvousResult[]) {
          expect(Object.isFrozen(result)).toBe(true);
        }
      });
    });

    describe('environment allowlist', () => {
      it('keeps only well-known variables', () => {
        expect(
          shellLaunchEnvironment({
            HOME: '/h',
            LC_ALL: 'C',
            XDG_RUNTIME_DIR: '/run/user/1',
            DISPLAY: ':0',
            DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x',
            SystemRoot: 'C:\\Windows',
            NODE_OPTIONS: '--require x',
            GITHUB_TOKEN: SECRET,
            UNSET: undefined,
          }),
        ).toEqual({
          HOME: '/h',
          LC_ALL: 'C',
          XDG_RUNTIME_DIR: '/run/user/1',
          DISPLAY: ':0',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x',
          SystemRoot: 'C:\\Windows',
        });
      });
    });

    it('is usable without the optional seams', async () => {
      const shell = await bootReady();
      const rendezvous = createFileRendezvous({
        locate: async () => installationFixture(dir),
      });
      expect(await rendezvous.ensureReady()).toMatchObject({
        state: 'ready',
        instanceNonce: shell.supervisor.instanceNonce,
      });
    });
  },
);
