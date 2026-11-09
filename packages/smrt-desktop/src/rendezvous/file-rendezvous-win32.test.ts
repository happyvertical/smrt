import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createControlChannelSend } from '../credentials/control-channel.js';
import { MemoryFs } from '../testing/memory-fs.js';
import {
  BUNDLE,
  installationFixture,
  ORIGIN,
  PRODUCT,
} from '../testing/rendezvous-fixture.js';
import { deriveControlEndpoint } from './endpoint.js';
import { createFileRendezvous } from './file-rendezvous.js';
import { serializeInstanceRecord } from './instance-record.js';

const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

// Node cannot open a named pipe on a POSIX host, so the wire is stubbed: the
// "server" answers `status` as the recorded instance. What is under test is
// the vetting decision, which is the part Windows needs from the shell.
vi.mock('./control-transport.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./control-transport.js')>()),
  sendControlRequest: vi.fn(async () => ({
    v: 1,
    ok: true,
    state: 'ready',
    instanceNonce: NONCE,
    productId: PRODUCT,
    origin: ORIGIN,
  })),
}));

const STATE = 'C:\\Users\\u\\AppData\\Local\\smrt-notes';
const pipe = deriveControlEndpoint({ platform: 'win32', bundleId: BUNDLE });

describe('rendezvous on Windows: pipe vetting is the shell’s', () => {
  let fs: MemoryFs;
  beforeEach(() => {
    fs = new MemoryFs();
    fs.set(STATE, 'dir', { mode: 0o700 });
    fs.set(`${STATE}\\instance.json`, 'file', {
      mode: 0o600,
      content: serializeInstanceRecord({
        version: 1,
        productId: PRODUCT,
        bundleId: BUNDLE,
        instanceNonce: NONCE,
        pid: 4242,
        shellVersion: '1.0.0',
        startedAt: '2026-11-01T12:00:00Z',
        updatedAt: '2026-11-01T12:00:00Z',
        control: pipe,
        state: 'ready',
        origin: ORIGIN,
      }),
    });
  });
  const make = (extra: Record<string, unknown> = {}) =>
    createFileRendezvous({
      locate: async () => installationFixture(STATE),
      spawnShell: async () => {
        throw new Error('must not spawn');
      },
      fs: fs as never,
      platform: 'win32',
      currentUid: undefined,
      ...extra,
    });

  it('returns ready WITHOUT a vetted endpoint when the shell supplied no vetting function (fail closed)', async () => {
    const result = await make().ensureReady({ start: false });
    expect(result).toMatchObject({ state: 'ready', origin: ORIGIN });
    expect(result).not.toHaveProperty('endpoint');
    // Nothing a launcher could pass to the credential flow.
    expect(() => createControlChannelSend(undefined as never)).toThrow();
  });

  it('hands out a vetted endpoint only when the injected vetting function accepts that pipe', async () => {
    const vetPipe = vi.fn(async () => true);
    const result = await make({ vetPipe }).ensureReady({ start: false });
    expect(vetPipe).toHaveBeenCalledWith(pipe);
    expect(result).toMatchObject({ state: 'ready' });
    const endpoint = (result as { endpoint?: unknown }).endpoint;
    expect(endpoint).toBeDefined();
    expect(() => createControlChannelSend(endpoint as never)).not.toThrow();
  });

  it.each([
    ['rejects', async () => false],
    [
      'throws',
      async () => {
        throw new Error('GetNamedPipeServerProcessId failed');
      },
    ],
  ])('treats a pipe the vetting function %s as untrusted_state', async (_n, vetPipe) => {
    expect(await make({ vetPipe }).ensureReady({ start: false })).toEqual({
      state: 'untrusted_state',
    });
  });
});
