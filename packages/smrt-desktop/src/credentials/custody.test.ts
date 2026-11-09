import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { SecretString } from '../secret-string.js';
import {
  CANARY_BODY,
  CANARY_TOKEN,
  CANARY_TOKEN_2,
  FUTURE,
  leaks,
  SLOT_ID,
  SLOT_ID_2,
  thrown,
} from '../testing/credentials.js';
import {
  createCredentialCustody,
  createMemorySecretItemStore,
  credentialItemName,
  type SecretItemStore,
} from './custody.js';
import type { StoredCredential } from './mint-response.js';

function credential(token = CANARY_TOKEN, slotId = SLOT_ID): StoredCredential {
  return {
    slotId,
    token: new SecretString(token),
    scopes: ['notes.read'],
    expiresAt: FUTURE,
  };
}

/** A store that records every call and name. */
function spyStore(inner = createMemorySecretItemStore()) {
  const calls: Array<{ op: string; name: string }> = [];
  const store: SecretItemStore = {
    get: async (name) => {
      calls.push({ op: 'get', name });
      return inner.get(name);
    },
    set: async (name, value) => {
      calls.push({ op: 'set', name });
      return inner.set(name, value);
    },
    delete: async (name) => {
      calls.push({ op: 'delete', name });
      return inner.delete(name);
    },
  };
  return { store, calls, inner };
}

const text = (bytes: Uint8Array | null) =>
  bytes === null ? null : new TextDecoder().decode(bytes);

describe('credential custody', () => {
  it('puts, gets and deletes by slot id', async () => {
    const custody = createCredentialCustody(createMemorySecretItemStore());
    expect(await custody.get(SLOT_ID)).toBeNull();
    await custody.put(credential());
    const stored = await custody.get(SLOT_ID);
    expect(stored?.slotId).toBe(SLOT_ID);
    expect(stored?.token).toBeInstanceOf(SecretString);
    expect(stored?.token.reveal()).toBe(CANARY_TOKEN);
    expect(stored?.scopes).toEqual(['notes.read']);
    expect(stored?.expiresAt).toBe(FUTURE);
    await custody.delete(SLOT_ID);
    expect(await custody.get(SLOT_ID)).toBeNull();
    await custody.delete(SLOT_ID); // idempotent
  });

  it('never returns the token through a value that serializes it', async () => {
    const custody = createCredentialCustody(createMemorySecretItemStore());
    await custody.put(credential());
    const stored = await custody.get(SLOT_ID);
    for (const rendered of [
      JSON.stringify(stored),
      inspect(stored, { depth: 10, showHidden: true }),
      String(stored?.token),
    ]) {
      expect(rendered).not.toContain(CANARY_BODY);
    }
  });

  it('T1: custody only touches mcp-credential.<uuid> item names', async () => {
    const { store, calls } = spyStore();
    const custody = createCredentialCustody(store);
    await custody.put(credential());
    await custody.get(SLOT_ID);
    await custody.put(credential(CANARY_TOKEN_2, SLOT_ID_2));
    await custody.delete(SLOT_ID_2);
    expect(calls.length).toBe(4);
    for (const { name } of calls) {
      expect(name).toMatch(
        /^mcp-credential\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
    expect(credentialItemName(SLOT_ID)).toBe(`mcp-credential.${SLOT_ID}`);
  });

  it('refuses slot ids that are not UUIDv4 before reaching the store', async () => {
    const { store, calls } = spyStore();
    const custody = createCredentialCustody(store);
    for (const bad of ['', '../x', 'mcp-credential.x', SLOT_ID.toUpperCase()]) {
      for (const op of [
        () => custody.get(bad),
        () => custody.delete(bad),
        () => custody.put(credential(CANARY_TOKEN, bad)),
      ]) {
        expect((await thrown(op)) instanceof DesktopContractError).toBe(true);
      }
    }
    expect(calls).toEqual([]);
  });

  it('refuses to store a malformed credential', async () => {
    const { store, calls } = spyStore();
    const custody = createCredentialCustody(store);
    const bad: unknown[] = [
      { ...credential(), token: CANARY_TOKEN },
      { ...credential(), token: new SecretString('not-a-token') },
      { ...credential(), scopes: [] },
      { ...credential(), expiresAt: 'soon' },
      null,
    ];
    for (const value of bad) {
      const error = await thrown(() => custody.put(value as StoredCredential));
      expect(error).toBeInstanceOf(DesktopContractError);
      expect(leaks(error)).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it('replaces atomically: a later put wins and old bytes are gone', async () => {
    const { store, inner } = spyStore();
    const custody = createCredentialCustody(store);
    await custody.put(credential(CANARY_TOKEN));
    await custody.put(credential(CANARY_TOKEN_2));
    expect((await custody.get(SLOT_ID))?.token.reveal()).toBe(CANARY_TOKEN_2);
    const raw = text(await inner.get(`mcp-credential.${SLOT_ID}`));
    expect(raw).toContain(CANARY_TOKEN_2);
    expect(raw).not.toContain(CANARY_TOKEN);
  });

  it('serializes concurrent operations on one slot (get never sees a torn put)', async () => {
    const order: string[] = [];
    const inner = createMemorySecretItemStore();
    const store: SecretItemStore = {
      async get(name) {
        order.push('get:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push('get:end');
        return inner.get(name);
      },
      async set(name, value) {
        order.push('set:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        await inner.set(name, value);
        order.push('set:end');
      },
      delete: (name) => inner.delete(name),
    };
    const custody = createCredentialCustody(store);
    await Promise.all([
      custody.put(credential()),
      custody.get(SLOT_ID),
      custody.put(credential(CANARY_TOKEN_2)),
      custody.get(SLOT_ID),
    ]);
    expect(order).toEqual([
      'set:start',
      'set:end',
      'get:start',
      'get:end',
      'set:start',
      'set:end',
      'get:start',
      'get:end',
    ]);
  });

  it('does not serialize operations on different slots', async () => {
    const started: string[] = [];
    const inner = createMemorySecretItemStore();
    const store: SecretItemStore = {
      get: (name) => inner.get(name),
      async set(name, value) {
        started.push(name);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await inner.set(name, value);
      },
      delete: (name) => inner.delete(name),
    };
    const custody = createCredentialCustody(store);
    const both = Promise.all([
      custody.put(credential(CANARY_TOKEN, SLOT_ID)),
      custody.put(credential(CANARY_TOKEN_2, SLOT_ID_2)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(started.length).toBe(2);
    await both;
  });

  describe('malformed stored items are credential_invalid, never echoed', () => {
    const name = `mcp-credential.${SLOT_ID}`;
    const item = (overrides: Record<string, unknown>) =>
      JSON.stringify({
        version: 1,
        slotId: SLOT_ID,
        token: CANARY_TOKEN,
        scopes: ['notes.read'],
        expiresAt: FUTURE,
        ...overrides,
      });

    it.each([
      ['not JSON', `{"token":"${CANARY_TOKEN}"`],
      ['an array', `["${CANARY_TOKEN}"]`],
      ['empty', ''],
      [
        'duplicate keys',
        item({}).replace('"version":1', '"version":1,"version":1'),
      ],
      ['unknown key', item({ extra: CANARY_TOKEN })],
      ['wrong version', item({ version: 2 })],
      ['another slot id', item({ slotId: SLOT_ID_2 })],
      ['bad token', item({ token: `${CANARY_TOKEN}!` })],
      ['bad scopes', item({ scopes: [] })],
      ['bad expiry', item({ expiresAt: 'later' })],
      ['oversize', item({ scopes: ['x'.repeat(100)] }) + ' '.repeat(17_000)],
    ])('%s', async (_label, content) => {
      const inner = createMemorySecretItemStore();
      await inner.set(name, new TextEncoder().encode(content));
      const custody = createCredentialCustody(inner);
      const error = await thrown(() => custody.get(SLOT_ID));
      expect(error).toBeInstanceOf(DesktopContractError);
      expect((error as DesktopContractError).code).toBe('credential_invalid');
      expect(leaks(error)).toBe(false);
    });

    it('invalid UTF-8', async () => {
      const inner = createMemorySecretItemStore();
      await inner.set(name, new Uint8Array([0xff, 0xfe, 0x7b]));
      const error = await thrown(() =>
        createCredentialCustody(inner).get(SLOT_ID),
      );
      expect((error as DesktopContractError).code).toBe('credential_invalid');
    });
  });

  it('maps store failures to credential_unavailable without chaining them', async () => {
    const failing: SecretItemStore = {
      get: async () => {
        throw new Error(`keychain says ${CANARY_TOKEN}`);
      },
      set: async () => {
        throw new Error(`keychain says ${CANARY_TOKEN}`);
      },
      delete: async () => {
        throw new Error(`keychain says ${CANARY_TOKEN}`);
      },
    };
    const custody = createCredentialCustody(failing);
    for (const op of [
      () => custody.get(SLOT_ID),
      () => custody.put(credential()),
      () => custody.delete(SLOT_ID),
    ]) {
      const error = await thrown(op);
      expect((error as DesktopContractError).code).toBe(
        'credential_unavailable',
      );
      expect(leaks(error)).toBe(false);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('zeroes the buffers it handed to and received from the store', async () => {
    const seen: Uint8Array[] = [];
    const inner = createMemorySecretItemStore();
    const store: SecretItemStore = {
      get: async (name) => {
        const value = await inner.get(name);
        if (value) seen.push(value);
        return value;
      },
      set: async (name, value) => {
        seen.push(value);
        await inner.set(name, value);
      },
      delete: (name) => inner.delete(name),
    };
    const custody = createCredentialCustody(store);
    await custody.put(credential());
    await custody.get(SLOT_ID);
    expect(seen.length).toBe(2);
    for (const bytes of seen)
      expect(bytes.every((byte) => byte === 0)).toBe(true);
  });

  describe('memory store', () => {
    it('copies in and out and enforces the item-name grammar', async () => {
      const store = createMemorySecretItemStore();
      const value = new Uint8Array([1, 2, 3]);
      await store.set('a.b-c', value);
      value.fill(9);
      const first = await store.get('a.b-c');
      expect(first).toEqual(new Uint8Array([1, 2, 3]));
      first?.fill(7);
      expect(await store.get('a.b-c')).toEqual(new Uint8Array([1, 2, 3]));
      expect(await store.get('missing')).toBeNull();
      for (const bad of ['', 'A', '-x', 'a/b', 'a'.repeat(129)]) {
        expect(await thrown(() => store.get(bad))).toBeInstanceOf(
          DesktopContractError,
        );
      }
    });
  });
});
