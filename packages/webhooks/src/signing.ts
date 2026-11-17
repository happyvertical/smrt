import { createHmac, timingSafeEqual } from 'node:crypto';

/** Default replay window: reject timestamps older or newer than five minutes. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/** Exact format the dispatcher emits (`Date#toISOString`); blocks `.`-split ambiguity. */
const TIMESTAMP_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNIX_SECONDS = /^\d{10}$/;
const UNIX_MILLIS = /^\d{13}$/;
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type WebhookTimestampFormat = 'iso' | 'unix' | 'unix-ms';
export type WebhookSigningPresetName =
  | 'default'
  | 'paperclip'
  | 'standard-webhooks';

/**
 * Per-endpoint wire format. The `default` profile is the historical
 * `x-smrt-*` / ISO / `sha256=<hex>` scheme and must never change.
 */
export interface WebhookSigningProfile {
  /** Lowercase header carrying the signature. */
  signatureHeader: string;
  /** Lowercase header carrying the timestamp. */
  timestampHeader: string;
  /** Lowercase header carrying the stable delivery id. */
  deliveryHeader: string;
  /** Lowercase header carrying the event name; `null` omits it. */
  eventHeader: string | null;
  timestampFormat: WebhookTimestampFormat;
  /** Signed string is `${timestamp}.${body}` or `${deliveryId}.${timestamp}.${body}`. */
  signDeliveryId: boolean;
  signatureEncoding: 'hex' | 'base64';
  /** Prefix emitted before the digest (`sha256=`, `v1,`, or empty). */
  signaturePrefix: string;
  /** When false a signature without the prefix is also accepted on verify. */
  signaturePrefixRequired: boolean;
  /** Accept several whitespace-separated signatures (rotation), any match passes. */
  multipleSignatures: boolean;
  /** `whsec-base64`: `whsec_<base64>` secrets are base64-decoded to the HMAC key. */
  secretEncoding: 'utf8' | 'whsec-base64';
}

/** Stored per-endpoint configuration: a preset plus optional field overrides. */
export type WebhookSigningProfileConfig = Partial<WebhookSigningProfile> & {
  preset?: WebhookSigningPresetName;
};

export const WEBHOOK_SIGNING_PRESETS: Readonly<
  Record<WebhookSigningPresetName, Readonly<WebhookSigningProfile>>
> = Object.freeze({
  default: Object.freeze({
    signatureHeader: 'x-smrt-signature',
    timestampHeader: 'x-smrt-timestamp',
    deliveryHeader: 'x-smrt-delivery',
    eventHeader: 'x-smrt-event',
    timestampFormat: 'iso',
    signDeliveryId: false,
    signatureEncoding: 'hex',
    signaturePrefix: 'sha256=',
    signaturePrefixRequired: true,
    multipleSignatures: false,
    secretEncoding: 'utf8',
  }),
  /** Paperclip routine triggers, mode `hmac_sha256`: hex HMAC over `timestamp.body`. */
  paperclip: Object.freeze({
    signatureHeader: 'x-paperclip-signature',
    timestampHeader: 'x-paperclip-timestamp',
    deliveryHeader: 'x-smrt-delivery',
    eventHeader: 'x-smrt-event',
    timestampFormat: 'unix',
    signDeliveryId: false,
    signatureEncoding: 'hex',
    signaturePrefix: 'sha256=',
    signaturePrefixRequired: false,
    multipleSignatures: false,
    secretEncoding: 'utf8',
  }),
  /** https://www.standardwebhooks.com/: `v1,<base64 HMAC(id.timestamp.body)>`. */
  'standard-webhooks': Object.freeze({
    signatureHeader: 'webhook-signature',
    timestampHeader: 'webhook-timestamp',
    deliveryHeader: 'webhook-id',
    eventHeader: 'x-smrt-event',
    timestampFormat: 'unix',
    signDeliveryId: true,
    signatureEncoding: 'base64',
    signaturePrefix: 'v1,',
    signaturePrefixRequired: true,
    multipleSignatures: true,
    secretEncoding: 'whsec-base64',
  }),
});

/** Resolve a stored profile (preset name, config object or its JSON) to a full profile. */
export function resolveWebhookSigningProfile(
  input?:
    | WebhookSigningProfileConfig
    | WebhookSigningPresetName
    | string
    | null,
): WebhookSigningProfile {
  let config: unknown = input;
  if (typeof config === 'string') {
    const text = config.trim();
    config = text.startsWith('{') ? JSON.parse(text) : { preset: text };
  }
  if (config === null || config === undefined) {
    return { ...WEBHOOK_SIGNING_PRESETS.default };
  }
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Invalid webhook signing profile.');
  }
  const { preset = 'default', ...overrides } =
    config as WebhookSigningProfileConfig;
  if (
    typeof preset !== 'string' ||
    !Object.hasOwn(WEBHOOK_SIGNING_PRESETS, preset)
  )
    throw new Error('Unknown webhook signing preset.');
  const profile: WebhookSigningProfile = {
    ...WEBHOOK_SIGNING_PRESETS[preset as WebhookSigningPresetName],
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(profile, key))
      throw new Error('Unknown webhook signing profile field.');
    (profile as unknown as Record<string, unknown>)[key] = value;
  }
  assertWebhookSigningProfile(profile);
  return profile;
}

function assertWebhookSigningProfile(p: WebhookSigningProfile): void {
  const names = [p.signatureHeader, p.timestampHeader, p.deliveryHeader];
  if (p.eventHeader !== null) names.push(p.eventHeader);
  if (
    names.some((n) => typeof n !== 'string' || !HEADER_NAME.test(n)) ||
    new Set(names).size !== names.length ||
    names.some((n) => ['content-type', 'user-agent', 'host'].includes(n)) ||
    !['iso', 'unix', 'unix-ms'].includes(p.timestampFormat) ||
    !['hex', 'base64'].includes(p.signatureEncoding) ||
    !['utf8', 'whsec-base64'].includes(p.secretEncoding) ||
    typeof p.signDeliveryId !== 'boolean' ||
    typeof p.signaturePrefixRequired !== 'boolean' ||
    typeof p.multipleSignatures !== 'boolean' ||
    typeof p.signaturePrefix !== 'string' ||
    !/^[A-Za-z0-9_=,:-]{0,16}$/.test(p.signaturePrefix)
  )
    throw new Error('Invalid webhook signing profile.');
}

/** Timestamp header value for `date` in the profile's format. */
export function formatWebhookTimestamp(
  format: WebhookTimestampFormat,
  date: Date = new Date(),
): string {
  if (format === 'unix') return String(Math.floor(date.getTime() / 1000));
  if (format === 'unix-ms') return String(date.getTime());
  return date.toISOString();
}

function parseTimestamp(
  format: WebhookTimestampFormat,
  timestamp: string,
): number {
  if (format === 'iso')
    return TIMESTAMP_FORMAT.test(timestamp)
      ? Date.parse(timestamp)
      : Number.NaN;
  if (format === 'unix')
    return UNIX_SECONDS.test(timestamp) ? Number(timestamp) * 1000 : Number.NaN;
  return UNIX_MILLIS.test(timestamp) ? Number(timestamp) : Number.NaN;
}

function signingKey(secret: string, profile: WebhookSigningProfile) {
  if (profile.secretEncoding === 'whsec-base64')
    return Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return secret;
}

/**
 * Signature header value for `timestamp` (the exact timestamp header string) and
 * body. With no profile this is the historical `sha256=<hex>` output.
 * Profiles that sign the delivery id require `deliveryId`.
 */
export function signWebhookPayload(
  secret: string,
  timestamp: string,
  body: string | Uint8Array,
  profile?: WebhookSigningProfile,
  deliveryId?: string,
): string {
  const p = profile ?? WEBHOOK_SIGNING_PRESETS.default;
  if (p.signDeliveryId && !deliveryId)
    throw new Error('Signing profile requires a delivery id.');
  // Hash the bytes exactly as received; never decode bytes to a string first.
  const hmac = createHmac('sha256', signingKey(secret, p)).update(
    `${p.signDeliveryId ? `${deliveryId}.` : ''}${timestamp}.`,
  );
  hmac.update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return `${p.signaturePrefix}${hmac.digest(p.signatureEncoding)}`;
}

/** Headers for one delivery attempt (everything the transport sends). */
export function buildWebhookHeaders(args: {
  secret: string;
  body: string;
  deliveryId: string;
  event: string;
  profile?: WebhookSigningProfile;
  now?: Date;
}): Record<string, string> {
  const p = args.profile ?? WEBHOOK_SIGNING_PRESETS.default;
  const timestamp = formatWebhookTimestamp(p.timestampFormat, args.now);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'smrt-webhooks/1',
  };
  if (p.eventHeader) headers[p.eventHeader] = args.event;
  headers[p.deliveryHeader] = args.deliveryId;
  headers[p.timestampHeader] = timestamp;
  headers[p.signatureHeader] = signWebhookPayload(
    args.secret,
    timestamp,
    args.body,
    p,
    args.deliveryId,
  );
  return headers;
}

export interface VerifyWebhookOptions {
  /** Shared signing secret, or several during rotation; any match passes. */
  secret: string | readonly string[];
  /** Exact raw request body (UTF-8 string or bytes). Never a re-serialized object. */
  body: string | Uint8Array;
  /** Timestamp header value, as sent (default `YYYY-MM-DDTHH:mm:ss.sssZ`). */
  timestamp: string | null | undefined;
  /** Signature header value (default `sha256=<hex>`). */
  signature: string | null | undefined;
  /** Signing profile (default: the historical `x-smrt-*` scheme). */
  profile?: WebhookSigningProfile;
  /** Delivery id header value; required when the profile signs it. */
  deliveryId?: string | null;
  /** Maximum accepted clock skew/age in ms (default 5 minutes). */
  toleranceMs?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'expired' | 'mismatch' };

function digestShape(p: WebhookSigningProfile): RegExp {
  return p.signatureEncoding === 'hex'
    ? /^[0-9a-f]{64}$/
    : /^[A-Za-z0-9+/]{43}=$/;
}

/** Strip the profile prefix; null when the prefix is required but absent. */
function stripPrefix(p: WebhookSigningProfile, value: string): string | null {
  if (value.startsWith(p.signaturePrefix))
    return value.slice(p.signaturePrefix.length);
  return p.signaturePrefixRequired ? null : value;
}

/**
 * Verify a delivery (the sender signs with a single secret; the receiver may
 * hold several during rotation) in constant time with replay protection. Callers must
 * still deduplicate the delivery id header (at-least-once delivery).
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
  const profile = options?.profile ?? WEBHOOK_SIGNING_PRESETS.default;
  const deliveryId = options?.deliveryId ?? undefined;
  if (
    typeof timestamp !== 'string' ||
    typeof signature !== 'string' ||
    (typeof body !== 'string' && !(body instanceof Uint8Array)) ||
    !secrets.length ||
    secrets.some((s) => typeof s !== 'string' || !s) ||
    (profile.signDeliveryId && (typeof deliveryId !== 'string' || !deliveryId))
  )
    return { ok: false, reason: 'malformed' };
  const sent = parseTimestamp(profile.timestampFormat, timestamp);
  const candidates = (
    profile.multipleSignatures ? signature.split(/\s+/) : [signature]
  )
    .map((c) => stripPrefix(profile, c))
    .filter((c): c is string => c !== null && digestShape(profile).test(c));
  const tolerance = options.toleranceMs ?? DEFAULT_WEBHOOK_TOLERANCE_MS;
  const nowMs = (options.now ?? new Date()).getTime();
  if (
    !candidates.length ||
    !Number.isFinite(sent) ||
    !Number.isFinite(tolerance) ||
    tolerance < 0 ||
    !Number.isFinite(nowMs)
  )
    return { ok: false, reason: 'malformed' };
  if (Math.abs(nowMs - sent) > tolerance)
    return { ok: false, reason: 'expired' };
  let matched = false;
  for (const secret of secrets) {
    const expected = Buffer.from(
      stripPrefix(
        profile,
        signWebhookPayload(
          secret as string,
          timestamp,
          body as string | Uint8Array,
          profile,
          deliveryId,
        ),
      ) as string,
    );
    for (const candidate of candidates) {
      const received = Buffer.from(candidate);
      if (
        received.length === expected.length &&
        timingSafeEqual(expected, received)
      )
        matched = true;
    }
  }
  return matched ? { ok: true } : { ok: false, reason: 'mismatch' };
}
