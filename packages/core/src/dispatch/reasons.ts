/**
 * Framework reason codes on failed dispatches.
 *
 * The bus records why it failed or released a row as `[smrt:<CODE>] <detail>`
 * in `last_error`. Handler error text never parses as a framework reason: a
 * handler message that itself starts with `[smrt:` is stored as
 * `handler: <message>`.
 */

/** Reason codes the bus writes into `last_error`. */
export const DISPATCH_FAILURE_CODES = Object.freeze({
  /** The row's claim budget (`maxAttempts`) is spent. */
  attemptsExhausted: 'DISPATCH_ATTEMPTS_EXHAUSTED',
  /** A lease was abandoned and no subscription can route the row. */
  leaseOrphaned: 'DISPATCH_LEASE_ORPHANED',
  /** An opted-in execution deadline passed before the handler settled. */
  executionTimeout: 'DISPATCH_EXECUTION_TIMEOUT',
  /** An operator released the row's lease. */
  released: 'DISPATCH_RELEASED',
} as const);

export type DispatchFailureCode =
  (typeof DISPATCH_FAILURE_CODES)[keyof typeof DISPATCH_FAILURE_CODES];

const KNOWN_CODES = new Set<string>(Object.values(DISPATCH_FAILURE_CODES));

/** Throw unless `code` is a framework reason code. */
export function assertDispatchFailureCode(code: unknown): DispatchFailureCode {
  if (typeof code !== 'string' || !KNOWN_CODES.has(code)) {
    throw new Error(
      `Unknown dispatch reason ${String(code)}; expected one of ${[...KNOWN_CODES].join(', ')}`,
    );
  }
  return code as DispatchFailureCode;
}

/** The `last_error` prefix of framework reason `code`. */
export function dispatchFailureReasonPrefix(code: DispatchFailureCode): string {
  return `[smrt:${code}]`;
}

/** Format a framework reason for `last_error`. */
export function formatDispatchFailureReason(
  code: DispatchFailureCode,
  detail: string,
): string {
  return `${dispatchFailureReasonPrefix(code)} ${detail}`;
}

/**
 * Parse a framework reason from a dispatch's `last_error`.
 *
 * @returns The code and detail, or `null` for handler error text and
 *   anything else that is not a framework reason.
 */
export function parseDispatchFailureReason(
  lastError: string | null | undefined,
): { code: DispatchFailureCode; detail: string } | null {
  if (typeof lastError !== 'string') return null;
  const match = /^\[smrt:([A-Z_]+)\](?: ([\s\S]*))?$/.exec(lastError);
  if (!match || !KNOWN_CODES.has(match[1])) return null;
  return { code: match[1] as DispatchFailureCode, detail: match[2] ?? '' };
}

/**
 * Store a handler's error message so it cannot be read as a framework
 * reason.
 */
export function encodeHandlerError(message: string): string {
  return message.startsWith('[smrt:') ? `handler: ${message}` : message;
}
