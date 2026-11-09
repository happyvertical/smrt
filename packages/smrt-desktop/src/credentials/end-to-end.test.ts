import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { DesktopContractError } from '../errors.js';
import { sendControlRequest } from '../rendezvous/control-transport.js';
import {
  createFileRendezvous,
  type RendezvousResult,
} from '../rendezvous/file-rendezvous.js';
import {
  INSTANCE_RECORD_FILENAME,
  parseInstanceRecord,
} from '../rendezvous/instance-record.js';
import {
  createReferenceSupervisor,
  type ReferenceShell,
  startReferenceShell,
} from '../rendezvous/reference-shell.js';
import { SecretString } from '../secret-string.js';
import {
  CANARY_BODY,
  CANARY_TOKEN,
  CANARY_TOKEN_2,
  FUTURE,
  leaks,
  NONCE,
  NOW,
  ORIGIN,
  renderings,
  SLOT_ID,
} from '../testing/credentials.js';
import {
  BUNDLE,
  installationFixture,
  PRODUCT,
} from '../testing/rendezvous-fixture.js';
import { spawnBridgeWithCredential } from './bridge-spawn.js';
import {
  type CredentialControlRequest,
  type CredentialControlResponse,
  createControlChannelSend,
  createCredentialReferenceRegistry,
  credentialControlCodec,
} from './control-channel.js';
import {
  type CredentialCustody,
  createCredentialCustody,
  createMemorySecretItemStore,
} from './custody.js';
import { createControlChannelCredentialProvider } from './provider.js';
import type { SlotRecordV1 } from './slot-record.js';

/**
 * End to end over a real unix domain socket: reference shell (serving the
 * extended control codec) -> rendezvous reaches ready -> the control-channel
 * provider acquires the bearer -> the bridge receives it over fd 3. At every
 * step the bearer must stay out of argv, the environment, rendezvous results,
 * thrown errors, files and console output.
 */

const fakeBridge = fileURLToPath(
  new URL('../testing/fake-bridge.mjs', import.meta.url),
);

const posixOnly = process.platform === 'win32' ? describe.skip : describe;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const minted: SlotRecordV1 = {
  version: 1,
  slotId: SLOT_ID,
  scopes: ['notes.read'],
  expiresAt: FUTURE,
  state: 'minted',
};

posixOnly(
  'credential handoff end to end (skipped on win32: unix sockets and POSIX modes)',
  () => {
    let dir: string;
    let shell: ReferenceShell<
      CredentialControlRequest,
      CredentialControlResponse
    >;
    let custody: CredentialCustody;
    let slot: SlotRecordV1 | null;
    let supervisor: ReturnType<typeof createReferenceSupervisor>;
    let consoleSpies: MockInstance[];
    const children: Array<{ close(): void; child: { kill(s: string): void } }> =
      [];
    const results: RendezvousResult[] = [];
    const errors: unknown[] = [];

    const store = () => createMemorySecretItemStore();

    beforeEach(async () => {
      // Short path: a unix socket path is limited to 104 bytes on macOS.
      dir = mkdtempSync('/tmp/smrt-cred-e2e-');
      chmodSync(dir, 0o700);
      slot = minted;
      custody = createCredentialCustody(store());
      await custody.put({
        slotId: SLOT_ID,
        token: new SecretString(CANARY_TOKEN),
        scopes: ['notes.read'],
        expiresAt: FUTURE,
      });
      supervisor = createReferenceSupervisor({
        productId: PRODUCT,
        instanceNonce: NONCE,
      });
      const registry = createCredentialReferenceRegistry(supervisor, {
        custody,
        slot: async () => slot,
        now: () => NOW,
      });
      shell = await startReferenceShell({
        shellDirectory: dir,
        productId: PRODUCT,
        bundleId: BUNDLE,
        supervisor,
        registry,
        codec: credentialControlCodec,
      });
      supervisor.ready(ORIGIN);
      await shell.flush();
      consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (method) => vi.spyOn(console, method).mockImplementation(() => {}),
      );
    });

    afterEach(async () => {
      for (const handoff of children.splice(0)) {
        handoff.close();
        handoff.child.kill('SIGKILL');
      }
      for (const spy of consoleSpies) spy.mockRestore();
      await shell.close();
      rmSync(dir, { recursive: true, force: true });
      results.length = 0;
      errors.length = 0;
    });

    const rendezvous = () =>
      createFileRendezvous({
        locate: async () => installationFixture(dir),
        spawnShell: async () => {
          throw new Error('the shell is already running; nothing to spawn');
        },
        pollIntervalMs: 5,
        maxPollIntervalMs: 20,
      });

    let lastReady: (RendezvousResult & { state: 'ready' }) | undefined;
    const ready = async () => {
      const result = await rendezvous().ensureReady({ start: false });
      results.push(result);
      if (result.state !== 'ready') throw new Error('not ready');
      lastReady = result;
      return result;
    };

    /** The control endpoint exactly as the vetted `instance.json` publishes it. */
    const endpoint = () =>
      parseInstanceRecord(
        readFileSync(`${dir}/${INSTANCE_RECORD_FILENAME}`, 'utf8'),
      ).control;

    /** The provider over the vetted handle the rendezvous returned. */
    const providerFor = () => {
      const vetted = lastReady?.endpoint;
      if (vetted === undefined) throw new Error('no vetted endpoint');
      return createControlChannelCredentialProvider({
        send: createControlChannelSend(vetted),
        now: () => NOW,
      });
    };

    /** Run `fn`, record what it threw, and return it. */
    const caught = async (fn: () => Promise<unknown>): Promise<unknown> => {
      try {
        await fn();
      } catch (error) {
        errors.push(error);
        return error;
      }
      throw new Error('expected a rejection');
    };

    const consoleOutput = (): string =>
      consoleSpies
        .flatMap((spy) => spy.mock.calls)
        .map((args) => args.map((arg) => renderings(arg).join('\n')).join(' '))
        .join('\n');

    it('hands the minted token from the shell to the bridge over fd 3 and nowhere else', async () => {
      const instance = await ready();
      expect(instance).toMatchObject({
        state: 'ready',
        origin: ORIGIN,
        instanceNonce: NONCE,
        productId: PRODUCT,
      });

      const lease = await providerFor().acquire({
        instanceNonce: instance.instanceNonce,
        origin: instance.origin,
      });
      expect(lease.origin).toBe(ORIGIN);
      expect(lease.expiresAt).toBe(FUTURE);
      expect(lease.token.equals(new SecretString(CANARY_TOKEN))).toBe(true);

      const argv = ['--credential-fd=3'];
      const handoff = spawnBridgeWithCredential({
        command: process.execPath,
        args: [fakeBridge, ...argv],
        env: { PATH: process.env.PATH ?? '' },
        lease,
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      children.push(handoff);

      const reports: Array<Record<string, unknown>> = [];
      const lines = createInterface({
        input: handoff.child.stdout as NodeJS.ReadableStream,
      });
      const frame = await new Promise<Record<string, unknown>>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out')), 8000);
          lines.on('line', (line) => {
            const report = JSON.parse(line) as Record<string, unknown>;
            reports.push(report);
            if (report.type === 'frame') {
              clearTimeout(timer);
              resolve(report);
            }
          });
        },
      );

      // The bridge got the exact token, over the pipe, bound to the origin.
      expect(frame.frameType).toBe('credential');
      expect(frame.origin).toBe(ORIGIN);
      expect(frame.tokenSha).toBe(sha(CANARY_TOKEN));

      // Absent from the child's argv and environment, as the child saw them.
      const started = reports.find((report) => report.type === 'started');
      expect(started).toBeDefined();
      const childView = JSON.stringify([started?.argv, started?.env]);
      expect(childView).not.toContain(CANARY_BODY);
      expect(Object.keys(started?.env as object)).not.toContain('SMRT_TOKEN');

      // Absent from every rendezvous result.
      results.push(await rendezvous().status());
      for (const result of results) expect(leaks(result)).toBe(false);

      // Absent from the persisted record, the socket directory and the console.
      const record = readFileSync(`${dir}/${INSTANCE_RECORD_FILENAME}`, 'utf8');
      expect(record).not.toContain(CANARY_BODY);
      for (const name of readdirSync(dir)) {
        if (statSync(`${dir}/${name}`).isFile()) {
          expect(readFileSync(`${dir}/${name}`, 'utf8')).not.toContain(
            CANARY_BODY,
          );
        }
      }
      expect(consoleOutput()).not.toContain(CANARY_BODY);
      expect(leaks(lease)).toBe(false);
    });

    it('answers a wrong instance nonce or origin with instance_mismatch', async () => {
      const instance = await ready();
      const provider = providerFor();

      const wrongNonce = await caught(() =>
        provider.acquire({
          instanceNonce: 'f'.repeat(32),
          origin: instance.origin,
        }),
      );
      expect(wrongNonce).toBeInstanceOf(DesktopContractError);
      expect((wrongNonce as DesktopContractError).code).toBe(
        'instance_mismatch',
      );

      const wrongOrigin = await caught(() =>
        provider.acquire({
          instanceNonce: instance.instanceNonce,
          origin: 'http://127.0.0.1:4679',
        }),
      );
      expect((wrongOrigin as DesktopContractError).code).toBe(
        'instance_mismatch',
      );

      // A restarting instance is not a place a credential may be released.
      supervisor.starting();
      const starting = await caught(() =>
        provider.acquire({
          instanceNonce: instance.instanceNonce,
          origin: instance.origin,
        }),
      );
      expect((starting as DesktopContractError).code).toBe('instance_mismatch');

      for (const error of errors) expect(leaks(error)).toBe(false);
    });

    it('answers a revoked or revoking slot with credential_invalid', async () => {
      const instance = await ready();
      const acquire = () =>
        providerFor().acquire({
          instanceNonce: instance.instanceNonce,
          origin: instance.origin,
        });

      for (const state of ['revoking', 'revoked'] as const) {
        slot = { ...minted, state };
        const error = await caught(acquire);
        expect(error).toBeInstanceOf(DesktopContractError);
        expect((error as DesktopContractError).code).toBe('credential_invalid');
      }

      // An expired credential is also invalid, and a missing one unavailable.
      slot = minted;
      await custody.put({
        slotId: SLOT_ID,
        token: new SecretString(CANARY_TOKEN),
        scopes: ['notes.read'],
        expiresAt: '2026-11-01T12:00:10Z',
      });
      expect(((await caught(acquire)) as DesktopContractError).code).toBe(
        'credential_invalid',
      );
      await custody.delete(SLOT_ID);
      expect(((await caught(acquire)) as DesktopContractError).code).toBe(
        'credential_unavailable',
      );
      slot = null;
      expect(((await caught(acquire)) as DesktopContractError).code).toBe(
        'credential_unavailable',
      );

      for (const error of errors) expect(leaks(error)).toBe(false);
      expect(consoleOutput()).not.toContain(CANARY_BODY);
    });

    it('yields only the latest token after a rotation', async () => {
      const instance = await ready();
      const acquire = () =>
        providerFor().acquire({
          instanceNonce: instance.instanceNonce,
          origin: instance.origin,
        });

      const first = await acquire();
      expect(first.token.equals(new SecretString(CANARY_TOKEN))).toBe(true);

      await custody.put({
        slotId: SLOT_ID,
        token: new SecretString(CANARY_TOKEN_2),
        scopes: ['notes.read'],
        expiresAt: FUTURE,
      });
      const second = await acquire();
      expect(second.token.equals(new SecretString(CANARY_TOKEN_2))).toBe(true);
      expect(second.token.equals(first.token)).toBe(false);

      // Every further acquisition keeps returning the rotated bearer only.
      for (let i = 0; i < 3; i++) {
        expect((await acquire()).token.equals(second.token)).toBe(true);
      }
    });

    it('keeps the core codec working on the same server and refuses the op to a core-only client', async () => {
      const instance = await ready();
      expect(await rendezvous().status()).toMatchObject({
        state: 'ready',
        origin: ORIGIN,
        instanceNonce: NONCE,
        productId: PRODUCT,
      });
      expect(instance.state).toBe('ready');

      // The default (core) codec refuses to even build the request.
      const error = await caught(() =>
        sendControlRequest(
          endpoint(),
          {
            v: 1,
            op: 'acquire-credential',
            instanceNonce: NONCE,
            origin: ORIGIN,
          } as never,
          { timeoutMs: 2000 },
        ),
      );
      expect((error as DesktopContractError).code).toBe('unsupported_op');
      expect(leaks(error)).toBe(false);
    });

    it('puts the token on the wire only in the credential success body', async () => {
      const instance = await ready();
      const wire = (line: string): Promise<string> =>
        new Promise((resolve, reject) => {
          const ep = endpoint();
          const socket = createConnection({
            path: ep.kind === 'unix' ? ep.path : '',
          });
          const chunks: Buffer[] = [];
          socket.on('data', (chunk: Buffer) => chunks.push(chunk));
          socket.on('error', reject);
          socket.on('close', () =>
            resolve(Buffer.concat(chunks).toString('utf8')),
          );
          socket.on('connect', () => socket.write(line));
        });

      const status = await wire('{"v":1,"op":"status"}\n');
      expect(status).not.toContain(CANARY_BODY);
      const mismatch = await wire(
        `{"v":1,"op":"acquire-credential","instanceNonce":"${'f'.repeat(32)}","origin":"${ORIGIN}"}\n`,
      );
      expect(mismatch).toBe('{"v":1,"ok":false,"code":"instance_mismatch"}\n');
      const garbage = await wire(
        `{"v":1,"op":"acquire-credential","instanceNonce":"${CANARY_TOKEN}","origin":"${ORIGIN}"}\n`,
      );
      expect(garbage).toBe('{"v":1,"ok":false,"code":"bad_request"}\n');
      expect(garbage).not.toContain(CANARY_BODY);

      const success = await wire(
        `{"v":1,"op":"acquire-credential","instanceNonce":"${instance.instanceNonce}","origin":"${instance.origin}"}\n`,
      );
      expect(success).toBe(
        `{"v":1,"ok":true,"instanceNonce":"${NONCE}","origin":"${ORIGIN}","token":"${CANARY_TOKEN}","expiresAt":"${FUTURE}"}\n`,
      );
    });

    it('only takes the endpoint the rendezvous vetted: a raw endpoint or a look-alike is refused', async () => {
      const instance = await ready();
      expect(instance.endpoint).toBeDefined();
      // The handle names nothing: no path, no name.
      expect(JSON.stringify(instance)).not.toContain(dir);
      expect(JSON.stringify(instance.endpoint)).toBe('{}');

      const raw = endpoint();
      for (const forged of [
        raw,
        { ...raw },
        {},
        Object.freeze(Object.create(null)),
        instance.endpoint === undefined ? undefined : { ...instance.endpoint },
        undefined,
        null,
        'x',
      ]) {
        const error = await caught(async () =>
          createControlChannelSend(forged as never),
        );
        expect((error as DesktopContractError).code).toBe('invalid_endpoint');
      }
    });

    it('turns an unreachable channel into credential_unavailable without echoing anything', async () => {
      const instance = await ready();
      const provider = providerFor();
      await shell.close();
      const error = await caught(() =>
        provider.acquire({
          instanceNonce: instance.instanceNonce,
          origin: instance.origin,
        }),
      );
      expect((error as DesktopContractError).code).toBe(
        'credential_unavailable',
      );
      expect(leaks(error)).toBe(false);
      expect(leaks(error, dir)).toBe(false);
    });
  },
);
