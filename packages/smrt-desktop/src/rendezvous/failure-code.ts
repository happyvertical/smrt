/**
 * Typed failure codes for the supervisor rendezvous.
 *
 * The Rust supervisor reports `Failed(String)`: free text meant for the tray
 * and the log. A client must never branch on that text, so the control channel
 * and `instance.json` carry a code from this closed set instead. The Rust
 * follow-up adds a `FailureCode` enum with these exact wire names; until it
 * lands, `failureCodeFromSupervisorMessage` documents (and implements) the
 * mapping from the current messages, for Node-based shells and test doubles.
 */

/**
 * Codes a shell may report (control channel and `instance.json`).
 *
 * @experimental
 */
export const SHELL_FAILURE_CODES = [
  /** Another live process holds the runtime writer lease or operation lock. */
  'lease_held',
  /** The restart budget is spent; only the tray Restart action recovers. */
  'restart_exhausted',
  /** The sidecar could not be launched at all (missing or not executable). */
  'sidecar_missing',
  /** The sidecar never became healthy, or its health route redirects. */
  'health_failed',
  /** No loopback port could be selected or bound. */
  'port_unavailable',
  /** The supervisor could not confirm the previous child exited. */
  'stop_unconfirmed',
  /** The supervisor itself failed (for example a panic). */
  'internal_error',
  /** A failure the shell could not classify. */
  'unknown',
] as const;

/**
 * Codes only the client produces.
 *
 * @experimental
 */
export const CLIENT_FAILURE_CODES = [
  /** The client could not start the shell binary. */
  'launch_failed',
  /** The channel answered for a different instance or product than recorded. */
  'instance_mismatch',
  /** Product, version, target or platform differ from the installed record. */
  'identity_mismatch',
  /** A document or channel speaks a contract version this client rejects. */
  'unsupported_contract',
] as const;

/** @experimental */
export type ShellFailureCode = (typeof SHELL_FAILURE_CODES)[number];
/** @experimental */
export type ClientFailureCode = (typeof CLIENT_FAILURE_CODES)[number];
/**
 * Closed union returned in `failed{code}`.
 *
 * @experimental
 */
export type RendezvousFailureCode = ShellFailureCode | ClientFailureCode;

const shellCodes: readonly string[] = SHELL_FAILURE_CODES;
const allCodes: readonly string[] = [
  ...SHELL_FAILURE_CODES,
  ...CLIENT_FAILURE_CODES,
];

/**
 * True for a code a shell may put on the wire or in `instance.json`.
 *
 * @experimental
 */
export function isShellFailureCode(value: unknown): value is ShellFailureCode {
  return typeof value === 'string' && shellCodes.includes(value);
}

/**
 * True for any member of the closed failure union.
 *
 * @experimental
 */
export function isRendezvousFailureCode(
  value: unknown,
): value is RendezvousFailureCode {
  return typeof value === 'string' && allCodes.includes(value);
}

const clientCodes: readonly string[] = CLIENT_FAILURE_CODES;
const FORWARD_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Normalize a failure code read from the wire or from `instance.json`.
 *
 * A known shell code is returned as is. A code this client has never heard of
 * (a newer shell added one) becomes `unknown`, so a version skew is not
 * mistaken for tampering. Still rejected (`undefined`): a non-string, a string
 * that is not a short lowercase snake_case word, and a code only a client may
 * produce (`launch_failed`, `instance_mismatch`, ...): a shell reporting one
 * of those is malformed, not newer.
 */
export function normalizeShellFailureCode(
  value: unknown,
): ShellFailureCode | undefined {
  if (typeof value !== 'string') return undefined;
  if (shellCodes.includes(value)) return value as ShellFailureCode;
  if (clientCodes.includes(value) || !FORWARD_CODE.test(value)) {
    return undefined;
  }
  return 'unknown';
}

/** True for a short lowercase snake_case word (a forward-compatible code). */
export function isForwardCompatibleCode(value: unknown): value is string {
  return typeof value === 'string' && FORWARD_CODE.test(value);
}

/**
 * Map the current Rust supervisor `Failed` text to a code. Order matters: the
 * underlying cause wins over the generic "gave up after N restarts" suffix.
 * Unrecognized text is `unknown`, never an error.
 *
 * @experimental
 */
export function failureCodeFromSupervisorMessage(
  message: string,
): ShellFailureCode {
  const text = message.toLowerCase();
  if (
    text.includes('writer lease') ||
    text.includes('operation lock') ||
    text.includes('another application writer is active') ||
    text.includes('another application operation is active')
  ) {
    return 'lease_held';
  }
  if (text.includes('internal supervisor error')) return 'internal_error';
  if (text.includes('could not be stopped')) return 'stop_unconfirmed';
  if (
    text.includes('port was taken') ||
    text.includes('could not select a loopback port')
  ) {
    return 'port_unavailable';
  }
  if (text.includes('could not start the sidecar')) return 'sidecar_missing';
  if (
    text.includes('did not become healthy') ||
    text.includes('health route redirects')
  ) {
    return 'health_failed';
  }
  if (text.includes('gave up after')) return 'restart_exhausted';
  return 'unknown';
}
