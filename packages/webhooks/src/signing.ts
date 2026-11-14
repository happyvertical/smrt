import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default replay window: reject timestamps older or newer than five minutes. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Exact format the dispatcher emits (`Date#toISOString`); blocks `.`-split ambiguity. */
const TIMESTAMP_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Signature header value for `timestamp` (the exact `x-smrt-timestamp` string) and body. */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  body: string | Uint8Array,
): string {
  // Hash the bytes exactly as received; never decode bytes to a string first.
  const hmac = createHmac('sha256', secret).update(`${timestamp}.`);
  hmac.update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return `sha256=${hmac.digest('hex')}`;
}

export interface VerifyWebhookOptions {
  /** Shared signing secret, or several during rotation; any match passes. */
  secret: string | readonly string[];
  /** Exact raw request body (UTF-8 string or bytes). Never a re-serialized object. */
  body: string | Uint8Array;
  /** `x-smrt-timestamp` header value (`YYYY-MM-DDTHH:mm:ss.sssZ`, as sent). */
  timestamp: string | null | undefined;
  /** `x-smrt-signature` header value (`sha256=<hex>`). */
  signature: string | null | undefined;
  /** Maximum accepted clock skew/age in ms (default 5 minutes). */
  toleranceMs?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' };

/**
 * Verify a delivery (the sender signs with a single secret; the receiver may
 * hold several during rotation) in constant time with replay protection. Callers must
 * still deduplicate the `x-smrt-delivery` id (at-least-once delivery).
 */
export function verifyWebhookSignature(
  options: VerifyWebhookOptions,
): VerifyWebhookResult {
  const { timestamp, signature } = options ?? ({} as VerifyWebhookOptions);
  const body: unknown = options?.body;
  const given: unknown = options?.secret;
  const secrets: unknown[] =
    typeof given === 'string'
      ? [given]
      : Array.isArray(given)
        ? [...given]
        : [];
  if (
    typeof timestamp !== 'string' ||
    typeof signature !== 'string' ||
    (typeof body !== 'string' && !(body instanceof Uint8Array)) ||
    !secrets.length ||
    secrets.some((s) => typeof s !== 'string' || !s) ||
    !/^sha256=[0-9a-f]{64}$/.test(signature) ||
    !TIMESTAMP_FORMAT.test(timestamp)
  )
    return { ok: false, reason: 'malformed' };
  const sent = Date.parse(timestamp);
  const tolerance = options.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  const nowMs = (options.now ?? new Date()).getTime();
  if (
    !Number.isFinite(sent) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    !Number.isFinite(nowMs)
  )
    return { ok: false, reason: 'malformed' };
  if (Math.abs(nowMs - sent) > tolerance)
    return { ok: false, reason: 'expired' };
  const received = Buffer.from(signature);
  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(
      signWebhookPayload(
        secret as string,
        timestamp,
        body as string | Uint8Array,
      ),
    );
    if (timingSafeEqual(expected, received)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: 'mismatch' };
}
