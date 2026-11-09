import { DesktopContractError } from '../errors.js';
import { isIsoUtcTimestamp, isLoopbackOrigin } from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { SecretString } from '../secret-string.js';
import type { CredentialCustody } from './custody.js';
import { isInstanceNonce, isMcpToken } from './grammar.js';
import type { SlotRecordV1 } from './slot-record.js';

/**
 * What a launcher may be told when it asks for the credential. The three
 * codes are the whole failure vocabulary of the handoff; none carries a value.
 *
 * @experimental
 */
export type CredentialFailureCode =
  | 'credential_unavailable'
  | 'credential_invalid'
  | 'instance_mismatch';

const failureCodes: readonly string[] = [
  'credential_unavailable',
  'credential_invalid',
  'instance_mismatch',
];

/**
 * True when `value` is one of the three handoff failure codes.
 *
 * @experimental
 */
export function isCredentialFailureCode(
  value: unknown,
): value is CredentialFailureCode {
  return typeof value === 'string' && failureCodes.includes(value);
}

/**
 * The part of the control protocol this handler needs: the identity of the
 * running instance. The control protocol registry supplies it; this module
 * deliberately imports nothing from it.
 *
 * @experimental
 */
export interface ControlContext {
  readonly instanceNonce: string;
  /** `http://127.0.0.1:<port>` of the ready sidecar. */
  readonly origin: string;
}

/**
 * `acquire-credential` request, after the control codec decoded the line.
 *
 * @experimental
 */
export interface AcquireCredentialRequest {
  readonly v: 1;
  readonly op: 'acquire-credential';
  readonly instanceNonce: string;
  readonly origin: string;
}

/**
 * A bearer bound to the origin it may be sent to.
 *
 * @experimental
 */
export interface CredentialLease {
  readonly token: SecretString;
  readonly origin: string;
  /** ISO-8601 UTC expiry of the bearer. */
  readonly expiresAt: string;
}

/** @experimental */
export type AcquireCredentialResult =
  | {
      readonly ok: true;
      /**
       * The instance that answered, echoed so the reply is bound to the
       * instance `status` proved: a provider rejects a mismatch.
       */
      readonly instanceNonce: string;
      readonly lease: CredentialLease;
    }
  | { readonly ok: false; readonly code: CredentialFailureCode };

/** @experimental */
export interface CredentialControlHandlerOptions {
  readonly custody: CredentialCustody;
  /** The persisted slot record, or `null` before any slot was minted. */
  readonly slot: () => Promise<SlotRecordV1 | null>;
  /** Identity of the running instance; `null` while it is not ready. */
  readonly current: () => ControlContext | null;
  /** Clock, milliseconds since the epoch. Defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * A credential this close to expiry (default 30 s) is treated as expired, so
   * a launcher is never handed a bearer that dies in flight.
   */
  readonly skewMs?: number;
}

/** @experimental */
export type AcquireCredentialHandler = (
  request: AcquireCredentialRequest,
) => Promise<AcquireCredentialResult>;

const DEFAULT_SKEW_MS = 30_000;

function refuse(code: CredentialFailureCode): AcquireCredentialResult {
  return Object.freeze({ ok: false, code });
}

/**
 * Reference `acquire-credential` handler (the Rust shell mirrors it).
 *
 * Order of checks, each failing closed with a code and no token:
 * 1. the request names the running instance (`instanceNonce` and `origin`
 *    both equal), else `instance_mismatch` before custody is touched, so a
 *    stale launcher cannot trigger a keychain read;
 * 2. a slot exists and has a committed credential, else
 *    `credential_unavailable`;
 * 3. the slot is `minted`, not `revoking` or `revoked`, else
 *    `credential_invalid`;
 * 4. custody holds a well-formed credential for the slot (absent:
 *    `credential_unavailable`; malformed: `credential_invalid`) that is not
 *    expired (`credential_invalid`).
 *
 * The credential is read from custody on every call, so after a rotation only
 * the latest committed bearer is ever returned. The handler never throws and
 * never lets an underlying error text escape.
 *
 * @experimental
 */
export function createCredentialControlHandler(
  options: CredentialControlHandlerOptions,
): AcquireCredentialHandler {
  const clock = options.now ?? Date.now;
  const skewMs = options.skewMs ?? DEFAULT_SKEW_MS;

  return async (request) => {
    try {
      const current = options.current();
      if (
        current === null ||
        !isInstanceNonce(request?.instanceNonce) ||
        !isLoopbackOrigin(request.origin) ||
        request.instanceNonce !== current.instanceNonce ||
        request.origin !== current.origin
      ) {
        return refuse('instance_mismatch');
      }

      const slot = await options.slot();
      if (slot === null || slot.expiresAt === null) {
        return refuse('credential_unavailable');
      }
      if (slot.state !== 'minted') return refuse('credential_invalid');

      const credential = await options.custody.get(slot.slotId);
      if (credential === null) return refuse('credential_unavailable');
      if (Date.parse(credential.expiresAt) <= clock() + skewMs) {
        return refuse('credential_invalid');
      }
      return Object.freeze({
        ok: true,
        instanceNonce: current.instanceNonce,
        lease: Object.freeze({
          token: credential.token,
          origin: current.origin,
          expiresAt: credential.expiresAt,
        }),
      });
    } catch (error) {
      if (
        error instanceof DesktopContractError &&
        error.code === 'credential_invalid'
      ) {
        return refuse('credential_invalid');
      }
      return refuse('credential_unavailable');
    }
  };
}

const successKeys = [
  'v',
  'ok',
  'instanceNonce',
  'origin',
  'token',
  'expiresAt',
];
/** Success reply as the control codec decodes it: the bearer already wrapped. */
const decodedSuccessKeys = ['v', 'ok', 'instanceNonce', 'lease'];
const decodedLeaseKeys = ['token', 'origin', 'expiresAt'];
const failureKeys = ['v', 'ok', 'code'];

/**
 * Serialize an `acquire-credential` result as one JSON line (no trailing
 * newline; the control codec frames it). This is the only place on the shell
 * side that reveals the bearer for the control channel, and the channel is the
 * owner-only socket or pipe.
 *
 * @experimental
 */
export function encodeAcquireCredentialResponse(
  result: AcquireCredentialResult,
): string {
  if (!result.ok) {
    return JSON.stringify({ v: 1, ok: false, code: result.code });
  }
  const { lease } = result;
  const token = lease.token.reveal();
  return JSON.stringify({
    v: 1,
    ok: true,
    instanceNonce: result.instanceNonce,
    origin: lease.origin,
    token,
    expiresAt: lease.expiresAt,
  });
}

/**
 * Strictly decode an `acquire-credential` reply (a JSON line, the object the
 * control transport parsed, or the control codec's decoded form
 * `{ v, ok: true, instanceNonce, lease }`, which is re-validated field by field) into a
 * result whose bearer is a `SecretString`. Any deviation (unknown key, bad origin, bad token, bad
 * timestamp, unknown code) throws a value-free `credential_unavailable`.
 *
 * @experimental
 */
export function parseAcquireCredentialResponse(
  input: unknown,
): AcquireCredentialResult {
  let value = input;
  if (typeof input === 'string') {
    const parsed = parseStrictJson(input);
    if (!parsed.ok) throw new DesktopContractError('credential_unavailable');
    value = parsed.value;
  }
  if (!isRecord(value) || value.v !== 1 || typeof value.ok !== 'boolean') {
    throw new DesktopContractError('credential_unavailable');
  }
  if (!value.ok) {
    if (!hasClosedKeys(value, failureKeys)) {
      throw new DesktopContractError('credential_unavailable');
    }
    if (!isCredentialFailureCode(value.code)) {
      throw new DesktopContractError('credential_unavailable');
    }
    return refuse(value.code);
  }
  if (hasClosedKeys(value, decodedSuccessKeys)) {
    const lease = value.lease;
    if (
      !isInstanceNonce(value.instanceNonce) ||
      !isRecord(lease) ||
      !hasClosedKeys(lease, decodedLeaseKeys) ||
      !(lease.token instanceof SecretString) ||
      !isMcpToken(lease.token.reveal()) ||
      !isLoopbackOrigin(lease.origin) ||
      !isIsoUtcTimestamp(lease.expiresAt)
    ) {
      throw new DesktopContractError('credential_unavailable');
    }
    return Object.freeze({
      ok: true,
      instanceNonce: value.instanceNonce,
      lease: Object.freeze({
        token: lease.token,
        origin: lease.origin,
        expiresAt: lease.expiresAt,
      }),
    });
  }
  if (
    !hasClosedKeys(value, successKeys) ||
    !isInstanceNonce(value.instanceNonce) ||
    !isLoopbackOrigin(value.origin) ||
    !isMcpToken(value.token) ||
    !isIsoUtcTimestamp(value.expiresAt)
  ) {
    throw new DesktopContractError('credential_unavailable');
  }
  return Object.freeze({
    ok: true,
    instanceNonce: value.instanceNonce,
    lease: Object.freeze({
      token: new SecretString(value.token),
      origin: value.origin,
      expiresAt: value.expiresAt,
    }),
  });
}
