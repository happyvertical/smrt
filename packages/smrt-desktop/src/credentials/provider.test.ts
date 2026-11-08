import { describe, expect, it, vi } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { SecretString } from '../secret-string.js';
import {
  CANARY_TOKEN,
  FUTURE,
  leaks,
  NONCE,
  NOW,
  ORIGIN,
  thrown,
} from '../testing/credentials.js';
import {
  type AcquireCredentialRequest,
  encodeAcquireCredentialResponse,
} from './control-handler.js';
import {
  type AcquireOptions,
  createControlChannelCredentialProvider,
  type SendAcquireRequest,
} from './provider.js';

const ask: AcquireOptions = { instanceNonce: NONCE, origin: ORIGIN };

const success = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  ok: true,
  origin: ORIGIN,
  token: CANARY_TOKEN,
  expiresAt: FUTURE,
  ...overrides,
});

function provider(send: SendAcquireRequest, timeoutMs?: number) {
  return createControlChannelCredentialProvider({
    send,
    timeoutMs,
    now: () => NOW,
  });
}

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await thrown(() => promise);
  expect(error).toBeInstanceOf(DesktopContractError);
  expect(leaks(error)).toBe(false);
  return (error as DesktopContractError).code;
}

describe('control-channel credential provider', () => {
  it('sends one acquire-credential request and returns a lease', async () => {
    const send = vi.fn(async (_request: AcquireCredentialRequest) => success());
    const lease = await provider(send).acquire(ask);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual({
      v: 1,
      op: 'acquire-credential',
      instanceNonce: NONCE,
      origin: ORIGIN,
    });
    expect(lease.token).toBeInstanceOf(SecretString);
    expect(lease.token.reveal()).toBe(CANARY_TOKEN);
    expect(lease.origin).toBe(ORIGIN);
  });

  it('accepts a JSON line as the reply', async () => {
    const wire = encodeAcquireCredentialResponse({
      ok: true,
      lease: {
        token: new SecretString(CANARY_TOKEN),
        origin: ORIGIN,
        expiresAt: FUTURE,
      },
    });
    const lease = await provider(async () => wire).acquire(ask);
    expect(lease.token.reveal()).toBe(CANARY_TOKEN);
  });

  it('T10: talks only through the injected send and never opens an endpoint itself', async () => {
    // The provider has no endpoint parameter: whatever transport `send`
    // wraps (socket or pipe, name grammar, peer checks) is contract (b)'s.
    const send = vi.fn(async () => success());
    await provider(send).acquire(ask);
    expect(send).toHaveBeenCalledTimes(1);
    expect(Object.keys(provider(send))).toEqual(['acquire']);
  });

  it.each([
    ['nonce', { instanceNonce: 'short' }],
    ['uppercase nonce', { instanceNonce: NONCE.toUpperCase() }],
    ['origin', { origin: 'http://localhost:4678' }],
  ])('refuses a bad %s before sending', async (_name, patch) => {
    const send = vi.fn(async () => success());
    expect(await code(provider(send).acquire({ ...ask, ...patch }))).toBe(
      'instance_mismatch',
    );
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    'credential_unavailable',
    'credential_invalid',
    'instance_mismatch',
  ])('propagates the %s refusal', async (refusal) => {
    const send = async () => ({ v: 1, ok: false, code: refusal });
    expect(await code(provider(send).acquire(ask))).toBe(refusal);
  });

  it('T12: rejects a lease whose origin differs from the origin it asked about', async () => {
    const send = async () => success({ origin: 'http://127.0.0.1:4679' });
    expect(await code(provider(send).acquire(ask))).toBe('instance_mismatch');
  });

  it('T13: only the loopback origin grammar is ever accepted in a reply', async () => {
    for (const origin of [
      'http://localhost:4678',
      'http://[::1]:4678',
      'https://127.0.0.1:4678',
      'http://127.0.0.1:4678/path',
      'http://user@127.0.0.1:4678',
      'http://127.0.0.1:0',
      'http://127.0.0.1:65536',
    ]) {
      const send = async () => success({ origin });
      expect(await code(provider(send).acquire(ask))).toBe(
        'credential_unavailable',
      );
    }
  });

  it('refuses an already-expired bearer', async () => {
    const send = async () => success({ expiresAt: '2026-11-01T11:00:00Z' });
    expect(await code(provider(send).acquire(ask))).toBe('credential_invalid');
  });

  it('maps transport errors to credential_unavailable and drops them', async () => {
    const send = async () => {
      throw new Error(`socket said ${CANARY_TOKEN}`);
    };
    const error = await thrown(() => provider(send).acquire(ask));
    expect((error as DesktopContractError).code).toBe('credential_unavailable');
    expect((error as Error).cause).toBeUndefined();
    expect(leaks(error)).toBe(false);
  });

  it('maps malformed replies to credential_unavailable', async () => {
    for (const reply of [
      null,
      'x',
      { v: 1, ok: true },
      success({ extra: 1 }),
    ]) {
      expect(await code(provider(async () => reply).acquire(ask))).toBe(
        'credential_unavailable',
      );
    }
  });

  it('times out and aborts the send', async () => {
    let seen: AbortSignal | undefined;
    const send: SendAcquireRequest = (_request, { signal }) => {
      seen = signal;
      return new Promise(() => undefined);
    };
    expect(await code(provider(send, 20).acquire(ask))).toBe(
      'credential_unavailable',
    );
    expect(seen?.aborted).toBe(true);
  });

  it('honors the caller abort signal', async () => {
    const controller = new AbortController();
    const send: SendAcquireRequest = () => new Promise(() => undefined);
    const pending = provider(send, 5000).acquire({
      ...ask,
      signal: controller.signal,
    });
    controller.abort();
    expect(await code(pending)).toBe('credential_unavailable');
    const already = AbortSignal.abort();
    const send2 = vi.fn(async () => success());
    expect(
      await code(provider(send2).acquire({ ...ask, signal: already })),
    ).toBe('credential_unavailable');
    expect(send2).not.toHaveBeenCalled();
  });
});
