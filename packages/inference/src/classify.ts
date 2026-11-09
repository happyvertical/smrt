/**
 * Failure classification for the chain walk (#4752).
 *
 * Classifies from structured facts only — the SDK error class name, its
 * `code`, `retryable`, and HTTP `status` — collected across the whole cause
 * chain (`cause`, `error`, `context.originalError`), the way core's
 * `db-errors.ts` classifies database failures. Message text is never read:
 * a provider rewording its error must not change routing.
 *
 * `@happyvertical/ai` maps provider failures onto `AIError` subclasses
 * (`AuthenticationError` AUTH_ERROR, `RateLimitError` RATE_LIMIT with the
 * provider error as `cause`, `ModelNotFoundError` MODEL_NOT_FOUND,
 * `ContentFilterError` CONTENT_FILTERED, AI_TIMEOUT, AI_ABORTED). It maps
 * other HTTP failures (5xx, 400) to `API_ERROR` / `UNKNOWN_ERROR` without the
 * status or cause; those classify as `transient` so a route outage still
 * advances, bounded by one retry per candidate. When a status survives in the
 * chain, a client error (other 4xx, `invalid_request_error`, context length)
 * stops the walk instead.
 */
import type { InferenceFailureClass } from './types.js';

interface ErrorFacts {
  names: Set<string>;
  codes: Set<string>;
  statuses: Set<number>;
  /** A rate-limit error that reports it will not reset soon. */
  rateLimitNotSoon: boolean;
  /** Any SDK error marked retryable. */
  retryable: boolean;
}

const MAX_CAUSE_DEPTH = 8;

const QUOTA_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'billing_not_active',
  'quota_exceeded',
  'subscription_sharing_usage_limit_exceeded',
]);
const QUOTA_NAMES = new Set(['ChatGPTPlanUsageLimitError']);

const CREDENTIAL_CODES = new Set([
  'AUTH_ERROR',
  // Core refused to bind the candidate before sending anything (pair rule,
  // HAVE_AI_* fallbacks, injected client): this route has no usable key.
  'INFERENCE_TARGET_UNBOUND',
  'invalid_api_key',
  'authentication_error',
  'permission_error',
  'subscription_sharing_invalid_user',
]);
const CREDENTIAL_NAMES = new Set([
  'AuthenticationError',
  'PermissionDeniedError',
  'AIProviderNotConfiguredError',
  'ChatGPTPlanSessionRevokedError',
]);

const MISSING_MODEL_CODES = new Set(['MODEL_NOT_FOUND', 'model_not_found']);
const MISSING_MODEL_NAMES = new Set(['ModelNotFoundError', 'NotFoundError']);

const REFUSAL_CODES = new Set(['CONTENT_FILTERED', 'content_filter']);
const REFUSAL_NAMES = new Set(['ContentFilterError']);

const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'rate_limit_exceeded']);
const RATE_LIMIT_NAMES = new Set(['RateLimitError']);

const TRANSIENT_CODES = new Set([
  'AI_TIMEOUT',
  'AI_INTERRUPTED',
  'STREAM_INTERRUPTED',
  // SDK mapping of other HTTP failures; the status is dropped (see above).
  'API_ERROR',
  'UNKNOWN_ERROR',
  'overloaded_error',
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const TRANSIENT_NAMES = new Set([
  'TimeoutError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'InternalServerError',
]);
const TRANSIENT_STATUSES = new Set([408, 409, 425, 500, 502, 503, 504, 529]);

/**
 * Client errors a provider answers the same way on every route (bad
 * parameters, oversized input): never a routing failure. Statuses the
 * taxonomy names are decided before this check.
 */
const REQUEST_ERROR_CODES = new Set([
  'invalid_request_error',
  'CONTEXT_LENGTH_EXCEEDED',
  'context_length_exceeded',
  'INVALID_INPUT',
]);

const ABORT_CODES = new Set(['AI_ABORTED', 'ABORT_ERR']);
const ABORT_NAMES = new Set(['AbortError']);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function collectFacts(error: unknown): ErrorFacts {
  const facts: ErrorFacts = {
    names: new Set(),
    codes: new Set(),
    statuses: new Set(),
    rateLimitNotSoon: false,
    retryable: false,
  };
  const seen = new Set<unknown>();
  const queue: Array<{ value: unknown; depth: number }> = [
    { value: error, depth: 0 },
  ];
  while (queue.length > 0) {
    const { value, depth } = queue.shift() as {
      value: unknown;
      depth: number;
    };
    const record = asObject(value);
    if (!record || seen.has(record) || depth > MAX_CAUSE_DEPTH) continue;
    seen.add(record);

    const name =
      typeof record.name === 'string'
        ? record.name
        : (value as object).constructor?.name;
    if (typeof name === 'string' && name !== 'Error' && name !== 'Object') {
      facts.names.add(name);
    }
    for (const key of ['code', 'type']) {
      const code = record[key];
      if (typeof code === 'string' && code !== '') facts.codes.add(code);
    }
    for (const key of ['status', 'statusCode']) {
      const status = record[key];
      if (typeof status === 'number' && Number.isInteger(status)) {
        facts.statuses.add(status);
      }
    }
    const response = asObject(record.response);
    if (typeof response?.status === 'number') {
      facts.statuses.add(response.status);
    }
    if (record.retryable === true) facts.retryable = true;
    if (
      (RATE_LIMIT_NAMES.has(String(name)) || record.code === 'RATE_LIMIT') &&
      record.retryable === false
    ) {
      facts.rateLimitNotSoon = true;
    }

    for (const next of [
      record.cause,
      record.error,
      asObject(record.context)?.originalError,
    ]) {
      if (next !== undefined) queue.push({ value: next, depth: depth + 1 });
    }
  }
  return facts;
}

function hasAny(set: Set<string>, members: Set<string>): boolean {
  for (const value of set) if (members.has(value)) return true;
  return false;
}

/**
 * True for a caller abort (`AI_ABORTED`, `AbortError`): never a routing
 * failure, so the walk stops and rethrows.
 */
export function isInferenceAbort(error: unknown): boolean {
  const facts = collectFacts(error);
  return hasAny(facts.codes, ABORT_CODES) || hasAny(facts.names, ABORT_NAMES);
}

/**
 * Classify a provider failure, or `undefined` when it is not a routing
 * failure (a caller abort, a programming error, invalid input the SDK did
 * not map). Unclassified errors end the walk and are rethrown.
 */
export function classifyInferenceFailure(
  error: unknown,
): InferenceFailureClass | undefined {
  // Core's typed capability refusal (#4758): the candidate cannot run the
  // request's shape (required tools, an oversized prompt). Advance.
  const unavailable = error as { code?: unknown; reason?: unknown } | null;
  if (
    unavailable &&
    typeof unavailable === 'object' &&
    unavailable.code === 'AI_UNAVAILABLE' &&
    unavailable.reason === 'capability'
  ) {
    return 'missing-capability';
  }
  const facts = collectFacts(error);
  const { names, codes, statuses } = facts;

  if (hasAny(codes, ABORT_CODES) || hasAny(names, ABORT_NAMES)) {
    return undefined;
  }
  if (
    hasAny(codes, QUOTA_CODES) ||
    hasAny(names, QUOTA_NAMES) ||
    statuses.has(402)
  ) {
    return 'quota';
  }
  if (
    hasAny(codes, CREDENTIAL_CODES) ||
    hasAny(names, CREDENTIAL_NAMES) ||
    statuses.has(401) ||
    statuses.has(403)
  ) {
    return 'credential';
  }
  if (
    hasAny(codes, MISSING_MODEL_CODES) ||
    hasAny(names, MISSING_MODEL_NAMES) ||
    statuses.has(404)
  ) {
    return 'missing-model';
  }
  if (hasAny(codes, REFUSAL_CODES) || hasAny(names, REFUSAL_NAMES)) {
    return 'refusal';
  }
  if (
    hasAny(codes, RATE_LIMIT_CODES) ||
    hasAny(names, RATE_LIMIT_NAMES) ||
    statuses.has(429)
  ) {
    return facts.rateLimitNotSoon ? 'quota' : 'transient';
  }
  for (const status of statuses) {
    if (TRANSIENT_STATUSES.has(status)) return 'transient';
  }
  // A definitive client error stops the walk: every candidate would refuse
  // the same request, so advancing only fans the prompt out (#4752 review).
  for (const status of statuses) {
    if (status >= 400 && status < 500) return undefined;
  }
  if (hasAny(codes, REQUEST_ERROR_CODES)) return undefined;
  if (
    hasAny(codes, TRANSIENT_CODES) ||
    hasAny(names, TRANSIENT_NAMES) ||
    facts.retryable
  ) {
    return 'transient';
  }
  return undefined;
}
