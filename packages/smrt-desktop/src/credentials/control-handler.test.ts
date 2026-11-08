import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
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
  SLOT_ID,
  SLOT_ID_2,
} from '../testing/credentials.js';
import {
  type AcquireCredentialRequest,
  type AcquireCredentialResult,
  createCredentialControlHandler,
  encodeAcquireCredentialResponse,
  parseAcquireCredentialResponse,
} from './control-handler.js';
import {
  createCredentialCustody,
  createMemorySecretItemStore,
  type SecretItemStore,
} from './custody.js';
import type { StoredCredential } from './mint-response.js';
import type { SlotRecordV1 } from './slot-record.js';

const request: AcquireCredentialRequest = {
  v: 1,
  op: 'acquire-credential',
  instanceNonce: NONCE,
  origin: ORIGIN,
};

function credential(
  token = CANARY_TOKEN,
  expiresAt = FUTURE,
): StoredCredential {
  return {
    slotId: SLOT_ID,
    token: new SecretString(token),
    scopes: ['notes.read'],
    expiresAt,
  };
}

const minted: SlotRecordV1 = {
  version: 1,
  slotId: SLOT_ID,
  scopes: ['notes.read'],
  expiresAt: FUTURE,
  state: 'minted',
};

function setup(
  options: {
    slot?: SlotRecordV1 | null;
    current?: { instanceNonce: string; origin: string } | null;
    store?: SecretItemStore;
  } = {},
) {
  const inner = options.store ?? createMemorySecretItemStore();
  const calls: string[] = [];
  const store: SecretItemStore = {
    get: async (name) => {
      calls.push(`get:${name}`);
      return inner.get(name);
    },
    set: async (name, value) => {
      calls.push('set');
      return inner.set(name, value);
    },
    delete: async (name) => {
      calls.push('delete');
      return inner.delete(name);
    },
  };
  const custody = createCredentialCustody(store);
  let slot = options.slot === undefined ? minted : options.slot;
  let current =
    options.current === undefined
      ? { instanceNonce: NONCE, origin: ORIGIN }
      : options.current;
  const handler = createCredentialControlHandler({
    custody,
    slot: async () => slot,
    current: () => current,
    now: () => NOW,
  });
  return {
    handler,
    custody,
    calls,
    setSlot: (next: SlotRecordV1 | null) => {
      slot = next;
    },
    setCurrent: (next: typeof current) => {
      current = next;
    },
  };
}

function expectRefused(result: AcquireCredentialResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
  expect(JSON.stringify(result)).not.toContain(CANARY_BODY);
}

describe('acquire-credential reference handler', () => {
  it('returns the stored credential for the running instance', async () => {
    const { handler, custody } = setup();
    await custody.put(credential());
    const result = await handler(request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.lease.token.reveal()).toBe(CANARY_TOKEN);
    expect(result.lease.origin).toBe(ORIGIN);
    expect(result.lease.expiresAt).toBe(FUTURE);
    expect(Object.isFrozen(result.lease)).toBe(true);
    // The structured result cannot leak the bearer through a log line.
    expect(JSON.stringify(result)).not.toContain(CANARY_BODY);
  });

  it('refuses with credential_unavailable when there is no slot', async () => {
    const { handler, custody, setSlot } = setup({ slot: null });
    await custody.put(credential());
    expectRefused(await handler(request), 'credential_unavailable');
    setSlot({ ...minted, expiresAt: null }); // reserved, never committed
    expectRefused(await handler(request), 'credential_unavailable');
  });

  it('refuses with credential_unavailable when custody holds nothing', async () => {
    const { handler } = setup();
    expectRefused(await handler(request), 'credential_unavailable');
  });

  it('refuses with credential_invalid for an expired credential', async () => {
    const { handler, custody } = setup();
    await custody.put(credential(CANARY_TOKEN, '2026-11-01T11:59:59Z'));
    expectRefused(await handler(request), 'credential_invalid');
  });

  it('treats a credential within the skew of expiry as expired', async () => {
    const { handler, custody } = setup();
    await custody.put(credential(CANARY_TOKEN, '2026-11-01T12:00:29Z'));
    expectRefused(await handler(request), 'credential_invalid');
    await custody.put(credential(CANARY_TOKEN, '2026-11-01T12:00:31Z'));
    expect((await handler(request)).ok).toBe(true);
  });

  it.each([
    'revoking',
    'revoked',
  ] as const)('refuses with credential_invalid for a %s slot, whatever custody holds', async (state) => {
    const { handler, custody } = setup({ slot: { ...minted, state } });
    await custody.put(credential());
    expectRefused(await handler(request), 'credential_invalid');
  });

  it('refuses with credential_invalid when the stored item is malformed', async () => {
    const inner = createMemorySecretItemStore();
    await inner.set(
      `mcp-credential.${SLOT_ID}`,
      new TextEncoder().encode(`{"token":"${CANARY_TOKEN}"`),
    );
    const { handler } = setup({ store: inner });
    const result = await handler(request);
    expectRefused(result, 'credential_invalid');
  });

  it('refuses with credential_unavailable when the store fails', async () => {
    const store: SecretItemStore = {
      get: async () => {
        throw new Error(CANARY_TOKEN);
      },
      set: async () => undefined,
      delete: async () => undefined,
    };
    const { handler } = setup({ store });
    expectRefused(await handler(request), 'credential_unavailable');
  });

  it('refuses while the instance is not ready', async () => {
    const { handler, custody } = setup({ current: null });
    await custody.put(credential());
    expectRefused(await handler(request), 'instance_mismatch');
  });

  it('T8: wrong nonce or origin yields instance_mismatch without touching custody', async () => {
    const { handler, custody, calls } = setup();
    await custody.put(credential());
    calls.length = 0;
    const wrong: Array<Partial<AcquireCredentialRequest>> = [
      { instanceNonce: 'b'.repeat(32) },
      { instanceNonce: NONCE.toUpperCase() },
      { instanceNonce: `${NONCE}0` },
      { origin: 'http://127.0.0.1:4679' },
      { origin: 'http://localhost:4678' },
      { origin: 'http://[::1]:4678' },
      { origin: `${ORIGIN}/` },
      { origin: 'https://127.0.0.1:4678' },
      { origin: 'http://user@127.0.0.1:4678' },
    ];
    for (const patch of wrong) {
      expectRefused(
        await handler({ ...request, ...patch }),
        'instance_mismatch',
      );
    }
    expectRefused(
      await handler(undefined as unknown as AcquireCredentialRequest),
      'instance_mismatch',
    );
    expect(calls).toEqual([]); // no keychain read for a stale launcher
  });

  it('T12: an origin that differs from the running instance never gets a token', async () => {
    const { handler, custody, setCurrent } = setup();
    await custody.put(credential());
    // The sidecar restarted on a new port: the old origin is stale.
    setCurrent({ instanceNonce: NONCE, origin: 'http://127.0.0.1:4700' });
    expectRefused(await handler(request), 'instance_mismatch');
    const fresh = await handler({
      ...request,
      origin: 'http://127.0.0.1:4700',
    });
    expect(fresh.ok).toBe(true);
    if (fresh.ok) expect(fresh.lease.origin).toBe('http://127.0.0.1:4700');
  });

  it('T7: after rotation the handler returns only the latest bearer', async () => {
    const { handler, custody } = setup();
    await custody.put(credential(CANARY_TOKEN));
    const first = await handler(request);
    await custody.put(credential(CANARY_TOKEN_2));
    const second = await handler(request);
    expect(first.ok && first.lease.token.reveal()).toBe(CANARY_TOKEN);
    expect(second.ok && second.lease.token.reveal()).toBe(CANARY_TOKEN_2);
    // Revoke path: the credential is not served once the slot is revoking.
  });

  it('serves only the slot named by the persisted record', async () => {
    const { handler, custody, setSlot } = setup();
    await custody.put({ ...credential(CANARY_TOKEN_2), slotId: SLOT_ID_2 });
    expectRefused(await handler(request), 'credential_unavailable');
    setSlot({ ...minted, slotId: SLOT_ID_2 });
    expect((await handler(request)).ok).toBe(true);
  });

  describe('wire codec', () => {
    it('round-trips a lease and a refusal', async () => {
      const { handler, custody } = setup();
      await custody.put(credential());
      const result = await handler(request);
      const wire = encodeAcquireCredentialResponse(result);
      expect(JSON.parse(wire)).toEqual({
        v: 1,
        ok: true,
        origin: ORIGIN,
        token: CANARY_TOKEN,
        expiresAt: FUTURE,
      });
      expect(Buffer.byteLength(wire)).toBeLessThan(4096);
      const decoded = parseAcquireCredentialResponse(wire);
      expect(decoded.ok && decoded.lease.token).toBeInstanceOf(SecretString);
      expect(decoded.ok && decoded.lease.token.reveal()).toBe(CANARY_TOKEN);
      expect(
        parseAcquireCredentialResponse(
          encodeAcquireCredentialResponse({
            ok: false,
            code: 'instance_mismatch',
          }),
        ),
      ).toEqual({ ok: false, code: 'instance_mismatch' });
    });

    it('a failure reply never contains a token field', () => {
      const wire = encodeAcquireCredentialResponse({
        ok: false,
        code: 'credential_invalid',
      });
      expect(wire).toBe('{"v":1,"ok":false,"code":"credential_invalid"}');
    });

    it.each([
      [
        'unknown key',
        {
          v: 1,
          ok: true,
          origin: ORIGIN,
          token: CANARY_TOKEN,
          expiresAt: FUTURE,
          scopes: [],
        },
      ],
      [
        'bad origin',
        {
          v: 1,
          ok: true,
          origin: 'http://localhost:1',
          token: CANARY_TOKEN,
          expiresAt: FUTURE,
        },
      ],
      [
        'bad token',
        { v: 1, ok: true, origin: ORIGIN, token: 'nope', expiresAt: FUTURE },
      ],
      [
        'bad expiry',
        { v: 1, ok: true, origin: ORIGIN, token: CANARY_TOKEN, expiresAt: 'x' },
      ],
      [
        'failure with token',
        { v: 1, ok: false, code: 'credential_invalid', token: CANARY_TOKEN },
      ],
      ['unknown code', { v: 1, ok: false, code: 'forbidden' }],
      ['wrong version', { v: 2, ok: false, code: 'credential_invalid' }],
      ['not an object', 'x'],
      ['array', []],
    ])('rejects a malformed reply: %s', (_name, reply) => {
      let error: unknown;
      try {
        parseAcquireCredentialResponse(reply);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(DesktopContractError);
      expect((error as DesktopContractError).code).toBe(
        'credential_unavailable',
      );
      expect(leaks(error)).toBe(false);
    });
  });
});
