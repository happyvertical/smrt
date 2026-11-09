import { DesktopContractError } from '../errors.js';
import { isIsoUtcTimestamp, isUuidV4 } from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { SecretString } from '../secret-string.js';
import {
  isMcpToken,
  isScopeList,
  MIN_CREDENTIAL_LIFETIME_MS,
} from './grammar.js';

/**
 * A credential as held in custody: the bearer is always a `SecretString`.
 *
 * @experimental
 */
export interface StoredCredential {
  readonly slotId: string;
  readonly token: SecretString;
  readonly scopes: readonly string[];
  /** ISO-8601 UTC expiry. */
  readonly expiresAt: string;
}

/**
 * Largest success reply accepted (token, id, up to 64 scopes, timestamp).
 *
 * @experimental
 */
export const MAX_MINT_RESPONSE_BYTES = 12 * 1024;

/** @experimental */
export interface ParseMintResponseOptions {
  /** Clock, milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Shortest acceptable remaining lifetime. Defaults to 60 seconds. */
  readonly minLifetimeMs?: number;
}

const requiredKeys = ['id', 'token', 'scopes', 'expiresAt'] as const;

function invalid(field: string): DesktopContractError {
  return new DesktopContractError('invalid_mint_response', { field });
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Validate the #4726 success reply `{ id, token, scopes, expiresAt }` and wrap
 * the bearer into a `SecretString` immediately.
 *
 * Every failure is a `DesktopContractError('invalid_mint_response')` whose
 * message is fixed text and whose `field` is a static schema name: neither the
 * body, the token nor any value is echoed, and the original parse exception is
 * dropped rather than chained.
 *
 * Checks: strict JSON (duplicate keys rejected), exactly the four keys, `id`
 * equals `expectedSlotId` (and is a UUIDv4), the token format, a valid scope
 * list, and an expiry at least `minLifetimeMs` (default 60 s) in the future.
 *
 * @experimental
 */
export function parseMintResponse(
  body: string,
  expectedSlotId: string,
  options: ParseMintResponseOptions = {},
): StoredCredential {
  if (typeof body !== 'string' || utf8Length(body) > MAX_MINT_RESPONSE_BYTES) {
    throw invalid('body');
  }
  if (!isUuidV4(expectedSlotId)) throw invalid('id');
  const parsed = parseStrictJson(body);
  if (!parsed.ok) throw invalid('body');
  const value = parsed.value;
  if (!isRecord(value) || !hasClosedKeys(value, requiredKeys)) {
    throw invalid('body');
  }
  const { id, token, scopes, expiresAt } = value;
  if (id !== expectedSlotId) throw invalid('id');
  if (!isMcpToken(token)) throw invalid('token');
  if (!isScopeList(scopes)) throw invalid('scopes');
  if (!isIsoUtcTimestamp(expiresAt)) throw invalid('expiresAt');
  const now = (options.now ?? Date.now)();
  const minLifetime = options.minLifetimeMs ?? MIN_CREDENTIAL_LIFETIME_MS;
  if (Date.parse(expiresAt) < now + minLifetime) throw invalid('expiresAt');

  return Object.freeze({
    slotId: id,
    token: new SecretString(token),
    scopes: Object.freeze([...scopes]),
    expiresAt,
  });
}
