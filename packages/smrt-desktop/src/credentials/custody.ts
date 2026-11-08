import { DesktopContractError } from '../errors.js';
import { deepFreeze } from '../internal/freeze.js';
import { isIsoUtcTimestamp, isUuidV4 } from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { SecretString } from '../secret-string.js';
import {
  CREDENTIAL_ITEM_PREFIX,
  isMcpToken,
  isScopeList,
  isSecretItemName,
} from './grammar.js';
import type { StoredCredential } from './mint-response.js';

/**
 * Byte-level secret store, structurally identical to the vault-key store of
 * #4792. The Rust shell supplies the OS keychain implementation; this package
 * only ever talks to the seam.
 */
export interface SecretItemStore {
  /** The item's bytes, or `null` when absent. */
  get(name: string): Promise<Uint8Array | null>;
  /** Create or atomically replace the item. */
  set(name: string, value: Uint8Array): Promise<void>;
  /** Remove the item. Deleting an absent item succeeds. */
  delete(name: string): Promise<void>;
}

/**
 * Typed credential custody over a `SecretItemStore`. Keyed by slot id; no
 * method returns the bearer except inside a `SecretString`.
 */
export interface CredentialCustody {
  /**
   * The stored credential, or `null` when none was stored. A stored item that
   * is malformed throws `credential_invalid`; a failing store throws
   * `credential_unavailable`. Neither error carries the item.
   */
  get(slotId: string): Promise<StoredCredential | null>;
  /** Store (atomically replacing) the credential for its slot. */
  put(credential: StoredCredential): Promise<void>;
  /** Remove the credential for `slotId`. Idempotent. */
  delete(slotId: string): Promise<void>;
}

/** Secret-store item name for a slot: `mcp-credential.<slotId>`. */
export function credentialItemName(slotId: string): string {
  if (!isUuidV4(slotId)) {
    throw new DesktopContractError('invalid_field', { field: 'slotId' });
  }
  return `${CREDENTIAL_ITEM_PREFIX}${slotId}`;
}

/** A full 64-scope list is about 8.5 KiB; anything bigger is not ours. */
const MAX_ITEM_BYTES = 16 * 1024;

function unavailable(): DesktopContractError {
  return new DesktopContractError('credential_unavailable');
}

function invalidItem(): DesktopContractError {
  return new DesktopContractError('credential_invalid');
}

function encodeItem(credential: StoredCredential): Uint8Array {
  if (!isRecord(credential)) {
    throw new DesktopContractError('invalid_field', { field: 'credential' });
  }
  const { slotId, token, scopes, expiresAt } = credential;
  if (
    !isUuidV4(slotId) ||
    !(token instanceof SecretString) ||
    !isScopeList(scopes) ||
    !isIsoUtcTimestamp(expiresAt)
  ) {
    throw new DesktopContractError('invalid_field', { field: 'credential' });
  }
  // The one place custody reveals the bearer: serializing it into the item.
  const revealed = token.reveal();
  if (!isMcpToken(revealed)) {
    throw new DesktopContractError('invalid_field', { field: 'token' });
  }
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      slotId,
      token: revealed,
      scopes,
      expiresAt,
    }),
  );
  if (bytes.length > MAX_ITEM_BYTES) {
    bytes.fill(0);
    throw new DesktopContractError('invalid_field', { field: 'credential' });
  }
  return bytes;
}

const itemKeys = ['version', 'slotId', 'token', 'scopes', 'expiresAt'];

function decodeItem(bytes: Uint8Array, slotId: string): StoredCredential {
  if (bytes.length === 0 || bytes.length > MAX_ITEM_BYTES) throw invalidItem();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw invalidItem();
  }
  const parsed = parseStrictJson(text);
  if (!parsed.ok) throw invalidItem();
  const value = parsed.value;
  if (
    !isRecord(value) ||
    !hasClosedKeys(value, itemKeys) ||
    value.version !== 1 ||
    value.slotId !== slotId ||
    !isMcpToken(value.token) ||
    !isScopeList(value.scopes) ||
    !isIsoUtcTimestamp(value.expiresAt)
  ) {
    throw invalidItem();
  }
  return deepFreeze({
    slotId,
    token: new SecretString(value.token),
    scopes: [...value.scopes],
    expiresAt: value.expiresAt,
  });
}

/**
 * Create the custody layer. Operations on one slot are serialized, so a `get`
 * never observes half of a `put`; the store itself must replace atomically
 * (the OS keychain and the file fallback do).
 *
 * Only `mcp-credential.<slotId>` names are ever passed to the store. Store
 * exceptions are replaced by value-free errors (their text may echo the item).
 */
export function createCredentialCustody(
  store: SecretItemStore,
): CredentialCustody {
  const queues = new Map<string, Promise<unknown>>();

  function serialized<T>(slotId: string, run: () => Promise<T>): Promise<T> {
    const previous = queues.get(slotId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.catch(() => undefined);
    queues.set(slotId, tail);
    void tail.then(() => {
      if (queues.get(slotId) === tail) queues.delete(slotId);
    });
    return next;
  }

  return {
    async get(slotId) {
      const name = credentialItemName(slotId);
      return serialized(slotId, async () => {
        let bytes: Uint8Array | null;
        try {
          bytes = await store.get(name);
        } catch {
          throw unavailable();
        }
        if (bytes === null || bytes === undefined) return null;
        if (!(bytes instanceof Uint8Array)) throw invalidItem();
        try {
          return decodeItem(bytes, slotId);
        } finally {
          bytes.fill(0);
        }
      });
    },

    async put(credential) {
      const bytes = encodeItem(credential);
      const { slotId } = credential;
      const name = credentialItemName(slotId);
      return serialized(slotId, async () => {
        try {
          await store.set(name, bytes);
        } catch {
          throw unavailable();
        } finally {
          bytes.fill(0);
        }
      });
    },

    async delete(slotId) {
      const name = credentialItemName(slotId);
      return serialized(slotId, async () => {
        try {
          await store.delete(name);
        } catch {
          throw unavailable();
        }
      });
    },
  };
}

/**
 * In-memory `SecretItemStore` for tests and development only. It copies on
 * every read and write, so callers may zero the buffers they pass or receive,
 * and it enforces the same item-name grammar as the OS-backed stores.
 */
export function createMemorySecretItemStore(): SecretItemStore {
  const items = new Map<string, Uint8Array>();
  const check = (name: string): void => {
    if (!isSecretItemName(name)) {
      throw new DesktopContractError('invalid_field', { field: 'name' });
    }
  };
  return {
    async get(name) {
      check(name);
      const value = items.get(name);
      return value === undefined ? null : new Uint8Array(value);
    },
    async set(name, value) {
      check(name);
      items.set(name, new Uint8Array(value));
    },
    async delete(name) {
      check(name);
      items.delete(name);
    },
  };
}
