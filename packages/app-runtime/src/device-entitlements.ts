/**
 * Signed device entitlement cache for local installs (#4787, epic #4667).
 *
 * A local install must know its tier offline. The cloud/billing host signs a
 * short-lived snapshot of the feature keys one account grants one device
 * (Ed25519); the install verifies it against a public key set that ships with
 * the application and exposes the verified keys through `smrt-features` as a
 * grant source, so `requireFeature()` works unchanged. Anything short of a
 * valid snapshot (absent, expired, tampered, unreadable, wrong account or
 * device, future-dated, replayed) yields the Local tier: no paid keys, and no
 * thrown error, only a {@link DeviceEntitlementStatus}.
 *
 * Trust boundary: the trusted public keys come from application
 * configuration, never from the cache file or the user data directory, and
 * the private key never leaves the issuing host. A local install can
 * therefore delete, copy, or replace the cache file, but it cannot mint a
 * snapshot that verifies.
 *
 * This module imports nothing from `smrt-features`: `smrt-features`'
 * development tooling depends on `smrt-cli`, which depends on this package,
 * so a dependency in this direction would be a cycle. The grant source is
 * structurally a `FeatureGrantSource` and is registered through the same
 * `Symbol.for()` slot `smrt-subscriptions` uses.
 */
import {
  createPublicKey,
  type JsonWebKey,
  type KeyObject,
  sign,
  verify,
} from 'node:crypto';
import { withOperationLock } from './operation-lock.js';
import {
  readPrivateFileBounded,
  writePrivateFileAtomic,
} from './private-files.js';

/** Wire/disk format version of the envelope and payload. */
export const DEVICE_ENTITLEMENT_FORMAT_VERSION = 1;

/**
 * `Symbol.for()` key of `smrt-features`' global grant source slot. A
 * cross-package contract owned by `smrt-features`; do not rename.
 */
export const FEATURE_GRANT_SOURCE_SLOT_KEY =
  '@happyvertical/smrt-features:grant-source';

/** Default tolerated clock skew for a snapshot issued "in the future". */
export const DEFAULT_DEVICE_ENTITLEMENT_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Default longest accepted `expiresAt - issuedAt`. */
export const DEFAULT_DEVICE_ENTITLEMENT_MAX_LIFETIME_MS =
  90 * 24 * 60 * 60 * 1000;
/** Default grace after expiry. Zero: paid keys stop at `expiresAt`. */
export const DEFAULT_DEVICE_ENTITLEMENT_GRACE_MS = 0;
/** Upper bound for a configured grace period. */
export const MAX_DEVICE_ENTITLEMENT_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bound for a configured clock skew. */
export const MAX_DEVICE_ENTITLEMENT_CLOCK_SKEW_MS = 60 * 60 * 1000;

const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_ID_LENGTH = 255;
const MAX_KEY_ID_LENGTH = 128;
const MAX_FEATURE_KEYS = 64;
const MAX_FEATURE_KEY_LENGTH = 128;
const SIGNATURE_BYTES = 64;
const SIGNATURE_DOMAIN = 'smrt-device-entitlement-v1\0';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SAFE_ID = /^[\x21-\x7e]+$/;
const FEATURE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:#@/-]*$/;

/** The signed content of a snapshot. All times are epoch milliseconds. */
export interface DeviceEntitlementSnapshot {
  accountId: string;
  deviceId: string;
  /** Feature keys the account's plan grants this device. */
  featureKeys: readonly string[];
  issuedAt: number;
  expiresAt: number;
  /** Id of the signing key; resolved against the trusted key set. */
  keyId: string;
}

/** Serialized snapshot: what the host issues and the install stores. */
export interface DeviceEntitlementEnvelope {
  version: typeof DEVICE_ENTITLEMENT_FORMAT_VERSION;
  keyId: string;
  /** base64url of the signed payload bytes (UTF-8 JSON). */
  payload: string;
  /** base64url Ed25519 signature over the domain-separated payload bytes. */
  signature: string;
}

/** A public key: SPKI PEM, a public Ed25519 JWK, or a public `KeyObject`. */
export type DeviceEntitlementPublicKey = string | JsonWebKey | KeyObject;

/** Trusted public keys by key id. Supplied by application configuration. */
export type DeviceEntitlementTrustedKeys =
  | ReadonlyMap<string, DeviceEntitlementPublicKey>
  | Readonly<Record<string, DeviceEntitlementPublicKey>>;

/** Why a snapshot or the cache was not accepted. */
export type DeviceEntitlementFailure =
  | 'absent'
  | 'unreadable'
  | 'malformed'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_account'
  | 'wrong_device'
  | 'not_yet_valid'
  | 'invalid_lifetime'
  | 'expired'
  | 'replayed';

/** Verification policy. */
export interface DeviceEntitlementVerifyOptions {
  trustedKeys: DeviceEntitlementTrustedKeys;
  /** The account this install is signed in as. */
  accountId: string;
  /** This device's id. */
  deviceId: string;
  /** Clock override (epoch ms). */
  now?: () => number;
  /** Tolerated clock skew on `issuedAt`. Default 5 minutes, max 1 hour. */
  clockSkewMs?: number;
  /**
   * How long after `expiresAt` the keys stay granted while the device cannot
   * refresh. Default 0 (none), max 30 days. Paid keys are granted during
   * grace, and the status says so.
   */
  gracePeriodMs?: number;
  /** Longest accepted `expiresAt - issuedAt`. Default 90 days. */
  maxLifetimeMs?: number;
}

export type DeviceEntitlementVerification =
  | {
      ok: true;
      /** `grace` once past `expiresAt` but inside the grace period. */
      state: 'valid' | 'grace';
      snapshot: Readonly<DeviceEntitlementSnapshot>;
    }
  | { ok: false; reason: DeviceEntitlementFailure };

/**
 * What the install knows about its entitlement. Contains no secrets and no
 * transport or filesystem error text.
 */
export interface DeviceEntitlementStatus {
  /** `local` unless a valid (or in-grace) snapshot grants keys. */
  tier: 'local' | 'entitled';
  state: 'valid' | 'grace' | 'absent' | 'expired' | 'invalid';
  /** Present when `state` is not `valid` or `grace`. */
  reason?: DeviceEntitlementFailure;
  /** Granted keys; empty on the Local tier. */
  featureKeys: readonly string[];
  issuedAt?: number;
  expiresAt?: number;
  /** `expiresAt` plus the grace period; set whenever a snapshot is held. */
  graceEndsAt?: number;
}

const LOCAL_ABSENT: DeviceEntitlementStatus = Object.freeze({
  tier: 'local',
  state: 'absent',
  reason: 'absent',
  featureKeys: Object.freeze([]) as readonly string[],
});

// ---------------------------------------------------------------------------
// Keys and validation
// ---------------------------------------------------------------------------

function assertIntegerMs(
  value: number | undefined,
  name: string,
  fallback: number,
  max: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > max) {
    throw new RangeError(`${name} must be an integer between 0 and ${max}`);
  }
  return resolved;
}

function validKeyId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_KEY_ID_LENGTH &&
    SAFE_ID.test(value)
  );
}

function validId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    SAFE_ID.test(value)
  );
}

function validFeatureKeys(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_FEATURE_KEYS ||
    new Set(value).size !== value.length
  ) {
    return false;
  }
  return value.every(
    (key) =>
      typeof key === 'string' &&
      key.length <= MAX_FEATURE_KEY_LENGTH &&
      FEATURE_KEY.test(key),
  );
}

function toPublicKey(id: string, input: DeviceEntitlementPublicKey): KeyObject {
  let key: KeyObject;
  if (typeof input === 'string') {
    if (/PRIVATE KEY/.test(input)) {
      throw new TypeError(`Trusted key "${id}" must be a public key`);
    }
    key = createPublicKey({ key: input, format: 'pem' });
  } else if (isKeyObject(input)) {
    if (input.type !== 'public') {
      throw new TypeError(`Trusted key "${id}" must be a public key`);
    }
    key = input;
  } else {
    if ('d' in input) {
      throw new TypeError(`Trusted key "${id}" must not contain private data`);
    }
    key = createPublicKey({ key: input, format: 'jwk' });
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`Trusted key "${id}" must be an Ed25519 public key`);
  }
  return key;
}

function isKeyObject(value: unknown): value is KeyObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as KeyObject).type === 'string' &&
    typeof (value as KeyObject).export === 'function'
  );
}

function buildKeySet(
  trusted: DeviceEntitlementTrustedKeys,
): Map<string, KeyObject> {
  const entries =
    trusted instanceof Map
      ? [...trusted.entries()]
      : Object.entries(trusted as Record<string, DeviceEntitlementPublicKey>);
  if (entries.length === 0) {
    throw new TypeError('At least one trusted entitlement key is required');
  }
  const keys = new Map<string, KeyObject>();
  for (const [id, input] of entries) {
    if (!validKeyId(id)) {
      throw new TypeError('Trusted entitlement key ids must be short tokens');
    }
    keys.set(id, toPublicKey(id, input));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Issuing (cloud/billing host)
// ---------------------------------------------------------------------------

/**
 * Sign a snapshot. Runs on the issuing host, which holds the private key; a
 * local install has no use for it and never receives the key.
 *
 * `issuedAt` and `expiresAt` are required so the issuing host owns the clock.
 */
export function signDeviceEntitlementSnapshot(
  snapshot: DeviceEntitlementSnapshot,
  privateKey: KeyObject | string,
): DeviceEntitlementEnvelope {
  if (
    !validId(snapshot.accountId) ||
    !validId(snapshot.deviceId) ||
    !validKeyId(snapshot.keyId) ||
    !validFeatureKeys(snapshot.featureKeys) ||
    !Number.isSafeInteger(snapshot.issuedAt) ||
    !Number.isSafeInteger(snapshot.expiresAt) ||
    snapshot.expiresAt <= snapshot.issuedAt
  ) {
    throw new TypeError('Invalid device entitlement snapshot');
  }
  const payload = Buffer.from(
    JSON.stringify({
      version: DEVICE_ENTITLEMENT_FORMAT_VERSION,
      accountId: snapshot.accountId,
      deviceId: snapshot.deviceId,
      featureKeys: [...snapshot.featureKeys],
      issuedAt: snapshot.issuedAt,
      expiresAt: snapshot.expiresAt,
      keyId: snapshot.keyId,
    }),
    'utf8',
  );
  const signature = sign(null, signedBytes(payload), privateKey);
  const envelope: DeviceEntitlementEnvelope = {
    version: DEVICE_ENTITLEMENT_FORMAT_VERSION,
    keyId: snapshot.keyId,
    payload: payload.toString('base64url'),
    signature: signature.toString('base64url'),
  };
  if (Buffer.byteLength(JSON.stringify(envelope)) > MAX_FILE_BYTES) {
    throw new TypeError('Device entitlement snapshot is too large');
  }
  return envelope;
}

function signedBytes(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(SIGNATURE_DOMAIN, 'utf8'), payload]);
}

// ---------------------------------------------------------------------------
// Verifying (local install)
// ---------------------------------------------------------------------------

interface ParsedEnvelope {
  keyId: string;
  payload: Buffer;
  signature: Buffer;
}

function parseEnvelope(input: unknown): ParsedEnvelope | null {
  let value = input;
  if (typeof value === 'string') {
    if (value.length > MAX_FILE_BYTES) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { keyId, payload, signature } = record;
  if (
    record.version !== DEVICE_ENTITLEMENT_FORMAT_VERSION ||
    !validKeyId(keyId) ||
    typeof payload !== 'string' ||
    typeof signature !== 'string' ||
    payload.length === 0 ||
    payload.length > MAX_FILE_BYTES ||
    !BASE64URL.test(payload) ||
    !BASE64URL.test(signature)
  ) {
    return null;
  }
  const signatureBytes = Buffer.from(signature, 'base64url');
  if (signatureBytes.length !== SIGNATURE_BYTES) return null;
  return {
    keyId,
    payload: Buffer.from(payload, 'base64url'),
    signature: signatureBytes,
  };
}

function parsePayload(bytes: Buffer): DeviceEntitlementSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== DEVICE_ENTITLEMENT_FORMAT_VERSION ||
    !validId(record.accountId) ||
    !validId(record.deviceId) ||
    !validKeyId(record.keyId) ||
    !validFeatureKeys(record.featureKeys) ||
    typeof record.issuedAt !== 'number' ||
    typeof record.expiresAt !== 'number' ||
    !Number.isSafeInteger(record.issuedAt) ||
    !Number.isSafeInteger(record.expiresAt)
  ) {
    return null;
  }
  return Object.freeze({
    accountId: record.accountId,
    deviceId: record.deviceId,
    featureKeys: Object.freeze([...record.featureKeys]),
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    keyId: record.keyId,
  });
}

interface ResolvedPolicy {
  keys: Map<string, KeyObject>;
  accountId: string;
  deviceId: string;
  now: () => number;
  clockSkewMs: number;
  gracePeriodMs: number;
  maxLifetimeMs: number;
}

/** A clock that throws or returns junk reads as NaN, which fails closed. */
function safeClock(clock: () => number): () => number {
  return () => {
    try {
      return clock();
    } catch {
      return Number.NaN;
    }
  };
}

function resolvePolicy(
  options: DeviceEntitlementVerifyOptions,
): ResolvedPolicy {
  if (!validId(options.accountId) || !validId(options.deviceId)) {
    throw new TypeError('accountId and deviceId are required');
  }
  return {
    keys: buildKeySet(options.trustedKeys),
    accountId: options.accountId,
    deviceId: options.deviceId,
    now: safeClock(options.now ?? Date.now),
    clockSkewMs: assertIntegerMs(
      options.clockSkewMs,
      'clockSkewMs',
      DEFAULT_DEVICE_ENTITLEMENT_CLOCK_SKEW_MS,
      MAX_DEVICE_ENTITLEMENT_CLOCK_SKEW_MS,
    ),
    gracePeriodMs: assertIntegerMs(
      options.gracePeriodMs,
      'gracePeriodMs',
      DEFAULT_DEVICE_ENTITLEMENT_GRACE_MS,
      MAX_DEVICE_ENTITLEMENT_GRACE_MS,
    ),
    maxLifetimeMs: assertIntegerMs(
      options.maxLifetimeMs,
      'maxLifetimeMs',
      DEFAULT_DEVICE_ENTITLEMENT_MAX_LIFETIME_MS,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

function verifyWithPolicy(
  input: unknown,
  policy: ResolvedPolicy,
):
  | DeviceEntitlementVerification
  | {
      ok: false;
      reason: 'expired';
      snapshot: Readonly<DeviceEntitlementSnapshot>;
    } {
  const envelope = parseEnvelope(input);
  if (!envelope) return { ok: false, reason: 'malformed' };

  const key = policy.keys.get(envelope.keyId);
  if (!key) return { ok: false, reason: 'unknown_key' };

  let signatureValid = false;
  try {
    signatureValid = verify(
      null,
      signedBytes(envelope.payload),
      key,
      envelope.signature,
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) return { ok: false, reason: 'bad_signature' };

  // Only now is the payload trusted. It must also name the key that verified.
  const snapshot = parsePayload(envelope.payload);
  if (!snapshot || snapshot.keyId !== envelope.keyId) {
    return { ok: false, reason: 'malformed' };
  }
  if (snapshot.accountId !== policy.accountId) {
    return { ok: false, reason: 'wrong_account' };
  }
  if (snapshot.deviceId !== policy.deviceId) {
    return { ok: false, reason: 'wrong_device' };
  }
  if (
    snapshot.expiresAt <= snapshot.issuedAt ||
    snapshot.expiresAt - snapshot.issuedAt > policy.maxLifetimeMs
  ) {
    return { ok: false, reason: 'invalid_lifetime' };
  }
  const now = policy.now();
  if (!Number.isFinite(now)) return { ok: false, reason: 'unreadable' };
  if (snapshot.issuedAt > now + policy.clockSkewMs) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  if (now > snapshot.expiresAt) {
    if (now > snapshot.expiresAt + policy.gracePeriodMs) {
      return { ok: false, reason: 'expired', snapshot };
    }
    return { ok: true, state: 'grace', snapshot };
  }
  return { ok: true, state: 'valid', snapshot };
}

/**
 * Verify a serialized snapshot (envelope object or its JSON text). Never
 * throws for bad input; throws `TypeError`/`RangeError` only for invalid
 * policy (programmer error: bad trusted keys, ids, or durations).
 *
 * Order matters: the signature is checked against a trusted key before any
 * payload field is believed.
 *
 * This checks the signature, binding, and expiry only. It is not replay-safe:
 * a validly signed but older snapshot (for example one issued before an
 * entitlement lapsed) still verifies here. Callers that accept a snapshot
 * must go through the cache store's `install()`, which also enforces
 * the persistent replay and clock watermarks.
 */
export function verifyDeviceEntitlementSnapshot(
  envelope: unknown,
  options: DeviceEntitlementVerifyOptions,
): DeviceEntitlementVerification {
  const result = verifyWithPolicy(envelope, resolvePolicy(options));
  return result.ok ? result : { ok: false, reason: result.reason };
}

// ---------------------------------------------------------------------------
// Cache store
// ---------------------------------------------------------------------------

/** Request handed to the injected refresh transport. */
export interface DeviceEntitlementRefreshRequest {
  accountId: string;
  deviceId: string;
  /** `issuedAt` of the snapshot currently held, if any. */
  currentIssuedAt: number | null;
  /** Aborted when the refresh times out. */
  signal: AbortSignal;
}

/**
 * Fetches a fresh envelope from the hosted endpoint. The transport is
 * injected (the hosted endpoint is out of scope here); its result is verified
 * exactly like a file on disk, so it needs no trust of its own.
 */
export type DeviceEntitlementTransport = (
  request: DeviceEntitlementRefreshRequest,
) => Promise<DeviceEntitlementEnvelope | string>;

export interface DeviceEntitlementCacheOptions
  extends DeviceEntitlementVerifyOptions {
  /**
   * Cache file. Keep it in the application's private data root. The sibling
   * `<filePath>.watermark` records the newest accepted `issuedAt` and observed
   * clock time; `<filePath>.lock/operation.lock` serializes participating processes.
   */
  filePath: string;
  transport?: DeviceEntitlementTransport;
  /** Abort a refresh after this long. Default 10 seconds. */
  refreshTimeoutMs?: number;
}

export interface DeviceEntitlementInstallResult {
  accepted: boolean;
  /** Why the offered snapshot was refused (status is unchanged then). */
  reason?: DeviceEntitlementFailure | 'storage_failed';
  status: DeviceEntitlementStatus;
}

export interface DeviceEntitlementRefreshResult
  extends Omit<DeviceEntitlementInstallResult, 'reason'> {
  /** `transport_failed` when the transport threw, timed out or is absent. */
  reason?: DeviceEntitlementInstallResult['reason'] | 'transport_failed';
}

type Watermark =
  | { kind: 'ok'; issuedAt: number; observedAt?: number }
  | { kind: 'corrupt' };

/**
 * Verifier plus file-backed cache of the newest accepted snapshot.
 *
 * Replay: an older, still-unexpired snapshot (from before a downgrade or
 * cancellation) must not displace a newer one. The newest accepted `issuedAt`
 * is kept in a sibling watermark file and every load and install compares
 * against it, so swapping an old backup over the cache file fails too. A user
 * who deletes or corrupts the watermark can still replay a snapshot that has
 * not expired; that offline limit is bounded by the issuer lifetime. While the
 * watermark survives, clock rollback fails closed against its observedAt.
 * The private parent directory must be shared by all participating processes;
 * this is not protection against an owner rewriting that directory or against
 * older application versions that do not take the entitlement lock.
 */
export class DeviceEntitlementCache {
  readonly #policy: ResolvedPolicy;
  readonly #filePath: string;
  readonly #watermarkPath: string;
  readonly #transport?: DeviceEntitlementTransport;
  readonly #refreshTimeoutMs: number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: DeviceEntitlementCacheOptions) {
    this.#policy = resolvePolicy(options);
    if (typeof options.filePath !== 'string' || options.filePath === '') {
      throw new TypeError('filePath is required');
    }
    this.#filePath = options.filePath;
    this.#watermarkPath = `${options.filePath}.watermark`;
    this.#transport = options.transport;
    this.#refreshTimeoutMs = assertIntegerMs(
      options.refreshTimeoutMs,
      'refreshTimeoutMs',
      DEFAULT_REFRESH_TIMEOUT_MS,
      10 * 60 * 1000,
    );
  }

  /**
   * Current entitlement, re-evaluated against the clock on every call. Never
   * throws: any failure is reported as the Local tier with a reason.
   */
  status(): Promise<DeviceEntitlementStatus> {
    return this.#serialize(async () => {
      try {
        return await this.#locked(() => this.#safeEvaluate());
      } catch {
        return local('invalid', 'unreadable');
      }
    });
  }

  /**
   * Verify and store a snapshot offered by the host. A refused snapshot
   * leaves the stored one (and its status) untouched.
   */
  install(
    envelope: DeviceEntitlementEnvelope | string,
  ): Promise<DeviceEntitlementInstallResult> {
    return this.#serialize(async () => {
      try {
        return await this.#locked(() => this.#install(envelope));
      } catch {
        return {
          accepted: false,
          reason: 'storage_failed' as const,
          status: local('invalid', 'unreadable'),
        };
      }
    });
  }

  /**
   * Ask the injected transport for a fresh snapshot and install it. A failed
   * or refused refresh keeps what is stored: an unreachable host never turns
   * a still-valid snapshot off early.
   */
  async refresh(): Promise<DeviceEntitlementRefreshResult> {
    const transport = this.#transport;
    if (!transport) {
      return {
        accepted: false,
        reason: 'transport_failed',
        status: await this.status(),
      };
    }
    const before = await this.status();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#refreshTimeoutMs);
    let offered: DeviceEntitlementEnvelope | string;
    try {
      offered = await Promise.race([
        transport({
          accountId: this.#policy.accountId,
          deviceId: this.#policy.deviceId,
          currentIssuedAt: before.issuedAt ?? null,
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error('timeout')),
          );
        }),
      ]);
    } catch {
      return { accepted: false, reason: 'transport_failed', status: before };
    } finally {
      clearTimeout(timer);
    }
    return this.install(offered);
  }

  /**
   * A `smrt-features` grant source backed by this cache. Never throws and
   * never reports grants unless the cache currently verifies, so a failure
   * reads as "no paid keys" rather than an outage.
   *
   * `tenantId` limits grants to the install's own tenant; omitted, every
   * tenant on this device sees the device's keys.
   */
  grantSource(
    options: { tenantId?: string } = {},
  ): DeviceEntitlementGrantSource {
    return {
      getGrants: async (tenantId: string) => {
        if (options.tenantId !== undefined && tenantId !== options.tenantId) {
          return null;
        }
        const status = await this.status();
        if (status.tier !== 'entitled') return null;
        return { featureKeys: status.featureKeys, planKey: null };
      },
    };
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #locked<T>(task: () => Promise<T>): Promise<T> {
    return withOperationLock(
      `${this.#filePath}.lock`,
      'device-entitlements',
      task,
    );
  }

  async #readWatermark(): Promise<Watermark | null> {
    const text = await readPrivateFileBounded(
      this.#watermarkPath,
      MAX_FILE_BYTES,
    );
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as {
        version?: unknown;
        issuedAt?: unknown;
        observedAt?: unknown;
      };
      if (
        value?.version === DEVICE_ENTITLEMENT_FORMAT_VERSION &&
        typeof value.issuedAt === 'number' &&
        Number.isSafeInteger(value.issuedAt) &&
        (value.observedAt === undefined ||
          (typeof value.observedAt === 'number' &&
            Number.isSafeInteger(value.observedAt)))
      ) {
        return {
          kind: 'ok',
          issuedAt: value.issuedAt,
          observedAt: value.observedAt as number | undefined,
        };
      }
    } catch {
      // fall through
    }
    return { kind: 'corrupt' };
  }

  async #evaluate(): Promise<DeviceEntitlementStatus> {
    const watermark = await this.#readWatermark();
    const text = await readPrivateFileBounded(this.#filePath, MAX_FILE_BYTES);
    if (text === null) return LOCAL_ABSENT;
    const now = this.#policy.now();
    if (!Number.isSafeInteger(now)) return local('invalid', 'unreadable');
    const verification = verifyWithPolicy(text, {
      ...this.#policy,
      now: () => now,
    });
    if (!verification.ok && verification.reason !== 'expired') {
      return local('invalid', verification.reason);
    }
    if (watermark?.kind === 'corrupt') return local('invalid', 'unreadable');
    // Expired metadata has passed the same signature, identity and lifetime checks.
    const snapshot =
      'snapshot' in verification ? verification.snapshot : undefined;
    if (!snapshot) return local('expired', 'expired');
    if (watermark && snapshot.issuedAt < watermark.issuedAt) {
      return local('invalid', 'replayed');
    }
    const dates = {
      issuedAt: snapshot.issuedAt,
      expiresAt: snapshot.expiresAt,
      graceEndsAt: snapshot.expiresAt + this.#policy.gracePeriodMs,
    };
    if (watermark?.observedAt !== undefined && now < watermark.observedAt) {
      return { ...local('expired', 'expired'), ...dates };
    }
    if (
      !watermark ||
      watermark.observedAt !== now ||
      watermark.issuedAt < snapshot.issuedAt
    ) {
      await this.#writeWatermark(snapshot.issuedAt, now);
    }
    if (!verification.ok) return { ...local('expired', 'expired'), ...dates };
    return {
      tier: 'entitled',
      state: verification.state,
      featureKeys: snapshot.featureKeys,
      ...dates,
    };
  }

  async #safeEvaluate(): Promise<DeviceEntitlementStatus> {
    try {
      return await this.#evaluate();
    } catch {
      return local('invalid', 'unreadable');
    }
  }

  async #writeWatermark(issuedAt: number, observedAt: number): Promise<void> {
    await writePrivateFileAtomic(
      this.#watermarkPath,
      JSON.stringify({
        version: DEVICE_ENTITLEMENT_FORMAT_VERSION,
        issuedAt,
        observedAt,
      }),
      { createParent: true },
    );
  }

  async #install(
    offered: DeviceEntitlementEnvelope | string,
  ): Promise<DeviceEntitlementInstallResult> {
    const now = this.#policy.now();
    const verification = verifyWithPolicy(offered, {
      ...this.#policy,
      now: () => now,
    });
    if (!verification.ok) {
      return {
        accepted: false,
        reason: verification.reason,
        status: await this.#safeEvaluate(),
      };
    }
    try {
      const { snapshot } = verification;
      const watermark = await this.#readWatermark();
      // A corrupt watermark is repaired by the next valid install.
      const floor = watermark?.kind === 'ok' ? watermark.issuedAt : -Infinity;
      if (
        !Number.isSafeInteger(now) ||
        (watermark?.kind === 'ok' &&
          watermark.observedAt !== undefined &&
          now < watermark.observedAt)
      ) {
        return {
          accepted: false,
          reason: 'expired',
          status: await this.#safeEvaluate(),
        };
      }
      const serialized =
        typeof offered === 'string' ? offered : JSON.stringify(offered);
      if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) {
        throw new Error('too large');
      }
      if (snapshot.issuedAt < floor) {
        return {
          accepted: false,
          reason: 'replayed',
          status: await this.#safeEvaluate(),
        };
      }
      if (snapshot.issuedAt === floor) {
        const current = await readPrivateFileBounded(
          this.#filePath,
          MAX_FILE_BYTES,
        ).catch(() => null);
        if (current !== null && !sameEnvelope(current, serialized)) {
          const held = verifyWithPolicy(current, {
            ...this.#policy,
            now: () => now,
          });
          if (
            !('snapshot' in held) ||
            held.snapshot.issuedAt >= snapshot.issuedAt
          ) {
            return {
              accepted: false,
              reason: 'replayed',
              status: await this.#safeEvaluate(),
            };
          }
        }
      }
      // Persist the floor first. If snapshot replacement fails or the process
      // dies, an older file fails closed; retrying this snapshot repairs it.
      await this.#writeWatermark(Math.max(floor, snapshot.issuedAt), now);
      await writePrivateFileAtomic(this.#filePath, serialized, {
        createParent: true,
      });
      return { accepted: true, status: await this.#safeEvaluate() };
    } catch {
      return {
        accepted: false,
        reason: 'storage_failed',
        status: await this.#safeEvaluate(),
      };
    }
  }
}

function sameEnvelope(a: string, b: string): boolean {
  const left = parseEnvelope(a);
  const right = parseEnvelope(b);
  return (
    left !== null &&
    right !== null &&
    left.keyId === right.keyId &&
    left.payload.equals(right.payload) &&
    left.signature.equals(right.signature)
  );
}

function local(
  state: 'expired' | 'invalid',
  reason: DeviceEntitlementFailure,
): DeviceEntitlementStatus {
  return { tier: 'local', state, reason, featureKeys: [] };
}

// ---------------------------------------------------------------------------
// smrt-features integration (structural; no import)
// ---------------------------------------------------------------------------

/**
 * Structurally a `smrt-features` `FeatureGrantSource`. Pass it as
 * `FeatureResolver`'s `grantSource` option or `context.grantSource`, or
 * register it app-wide with {@link registerDeviceEntitlementGrantSource}.
 */
export interface DeviceEntitlementGrantSource {
  getGrants(
    tenantId: string,
  ): Promise<{ featureKeys: readonly string[]; planKey: null } | null>;
}

type GrantSlotHolder = Record<symbol, DeviceEntitlementGrantSource | undefined>;

/**
 * Register the cache as the process-wide grant source in `smrt-features`
 * (the `Symbol.for()` slot `smrt-subscriptions` writes for hosted
 * deployments). It replaces any registered source, so use it only on a local
 * install, which has no subscription tables. Returns a function that restores
 * what was registered before.
 */
export function registerDeviceEntitlementGrantSource(
  source: DeviceEntitlementGrantSource,
): () => void {
  const slot = Symbol.for(FEATURE_GRANT_SOURCE_SLOT_KEY);
  const holder = globalThis as unknown as GrantSlotHolder;
  const previous = holder[slot];
  holder[slot] = source;
  return () => {
    if (holder[slot] === source) holder[slot] = previous;
  };
}
