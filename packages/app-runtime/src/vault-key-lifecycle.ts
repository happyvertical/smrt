import { randomBytes } from 'node:crypto';
import { deepFrozenPlainCopy } from './plain-data.js';
import {
  accountCode,
  assertConsistentState,
  authorityKeyId,
  authorityPublicKey,
  codesMatch,
  collidingDevices,
  containsState,
  deviceCode,
  EVIDENCE_LIMITS,
  encodeFields,
  headDigest,
  keyCommitment,
  MAX_HEAD_DEVICES,
  MAX_HEAD_GENERATIONS,
  MAX_HEAD_REVOKED_DEVICES,
  parseHead,
  parseHeadDevice,
  parseHeadGeneration,
  parseHeadRevocation,
  sameDigest,
  serializeHead,
  sha256,
  signHead,
  unionState,
  type VaultAccountHead,
  type VaultForkEvidence,
  type VaultHead,
  type VaultHeadDevice,
  VaultHeadError,
  type VaultHeadGeneration,
  type VaultHeadRevocation,
} from './vault-account-head.js';
import { openVaultDeviceKey, wrapVaultDeviceKey } from './vault-device-key.js';
import {
  deriveVaultDevicePublicKey,
  openVaultDeviceTransfer,
  sealVaultDeviceTransfer,
} from './vault-device-transfer.js';
import { prepareVaultKeyGeneration } from './vault-key-generation.js';
import type { VaultKeyStore } from './vault-key-store.js';
import {
  openVaultRecoveryKey,
  wrapVaultRecoveryKey,
} from './vault-recovery.js';

export type { VaultAccountHead } from './vault-account-head.js';
export type { VaultKeyStore } from './vault-key-store.js';

const REGISTRY_FORMAT = 'smrt-vault-device-registry';
const REQUEST_FORMAT = 'smrt-vault-enrollment-request';
const GRANT_FORMAT = 'smrt-vault-device-grant';
const REGISTRY_VERSION = 1;
const REQUEST_VERSION = 2;
const GRANT_VERSION = 2;
const GRANT_BINDING_TAG = 'smrt-vault-grant-binding-v2';
const MAX_GENERATION = (1n << 64n) - 1n;
const MAX_RECORD_BYTES = 1024;
const KEY_BYTES = 32;
const NONCE_BYTES = 16;
const KEY_ID = /^[0-9a-f]{32}$/;
const GENERATION_TEXT = /^[1-9][0-9]{0,19}$/;
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const DEFAULT_REQUEST_TTL_MS = 10 * 60 * 1000;
const MAX_REQUEST_TTL_MS = 15 * 60 * 1000;
const REGISTRY_ITEM = 'registry';
const DEVICE_SECRET_ITEM = 'device-secret';
const ENROLLMENT_ITEM = 'enrollment-request';
const AUTHORITY_ITEM = 'authority';
const AUTHORITY_NEXT_ITEM = 'authority-next';
// A restart (#4817) parks the previous account here: its registry, its
// authority record and its device secret. Its wrapped data keys stay under
// their own key-ID names, which no new key can collide with.
const PREVIOUS_REGISTRY_ITEM = 'previous-registry';
const PREVIOUS_AUTHORITY_ITEM = 'previous-authority';
const PREVIOUS_DEVICE_SECRET_ITEM = 'previous-device-secret';
/** The authority seed's recovery record uses generation 0, never a data key. */
const AUTHORITY_GENERATION = 0n;

export type VaultKeyLifecycleErrorCode =
  | 'not_initialized'
  | 'already_initialized'
  | 'invalid_input'
  | 'invalid_state'
  | 'account_mismatch'
  | 'device_conflict'
  | 'device_revoked'
  | 'unknown_device'
  | 'grant_rejected'
  | 'generation_conflict'
  | 'recovery_rejected'
  | 'rotation_required'
  | 'generation_limit'
  | 'key_missing'
  | 'confirmation_rejected'
  | 'request_expired'
  | 'restart_pending'
  | 'restart_incomplete'
  | 'no_previous_account';

const ERROR_MESSAGES: Record<VaultKeyLifecycleErrorCode, string> = {
  not_initialized: 'Vault keys are not initialized on this device',
  already_initialized: 'Vault keys are already initialized on this device',
  invalid_input: 'Invalid vault key lifecycle input',
  invalid_state: 'Vault key state on this device is invalid',
  account_mismatch: 'Vault account does not match this device',
  device_conflict: 'Vault device conflicts with an enrolled device',
  device_revoked: 'Vault device is revoked',
  unknown_device: 'Vault device is not enrolled',
  grant_rejected: 'Vault device grant was rejected',
  generation_conflict:
    'Vault account state has diverged; rotate to resolve before encrypting',
  recovery_rejected: 'Vault recovery secret was rejected',
  rotation_required: 'Vault key rotation is required before encrypting',
  generation_limit: 'Vault key generation limit reached',
  key_missing: 'Vault key is not held on this device',
  confirmation_rejected: 'Vault confirmation code does not match',
  request_expired: 'Vault enrollment request has expired',
  restart_pending:
    'A previous vault account is still held on this device; discard it first',
  restart_incomplete:
    'The vault restart on this device has not finished; finish it first',
  no_previous_account: 'No previous vault account is held on this device',
};

/** Lifecycle failure with a stable code; messages never carry key material. */
export class VaultKeyLifecycleError extends Error {
  override readonly name = 'VaultKeyLifecycleError';
  constructor(readonly code: VaultKeyLifecycleErrorCode) {
    super(ERROR_MESSAGES[code]);
  }
}

function fail(code: VaultKeyLifecycleErrorCode): never {
  throw new VaultKeyLifecycleError(code);
}

export type VaultGenerationStatus = 'current' | 'read-only';

export interface VaultKeyReference {
  generation: bigint;
  keyId: string;
}

export interface VaultPendingRevocation {
  deviceId: string;
  publicKey: string;
  revokedAt: string;
  /**
   * When the recovery secret was proven to open the authority record, as a
   * condition of recording this revocation (#4818). Null only for a state
   * recorded before that rule; the rotation it needs may not be possible.
   */
  provenAt: string | null;
}

/**
 * The device's local state. It holds the latest adopted signed head, fork
 * evidence, which keys this device holds, and local-only pending
 * revocations. It never contains secret material.
 */
export interface VaultDeviceRegistry {
  accountId: string;
  deviceId: string;
  head: VaultHead;
  conflict: VaultForkEvidence | null;
  keys: VaultKeyReference[];
  pendingRevocations: VaultPendingRevocation[];
  pendingRotation: {
    generation: bigint;
    keyId: string;
    startedAt: string;
  } | null;
}

export interface VaultKeyLifecycleStatus {
  accountId: string;
  deviceId: string;
  /** Sequence of the adopted signed head. */
  sequence: bigint;
  /** Display-only claims of the adopted head, for "last changed by". */
  headIssuedAt: string;
  headIssuerDeviceId: string;
  authorityPublicKey: string;
  currentGeneration: bigint;
  currentKeyId: string;
  generations: Array<{
    generation: bigint;
    keyId: string;
    status: VaultGenerationStatus;
    /** True when this device holds the key. */
    held: boolean;
  }>;
  devices: VaultHeadDevice[];
  revokedDevices: Array<{
    deviceId: string;
    publicKey: string;
    revokedAt: string;
    /** First generation the device cannot open; null until a rotation. */
    effectiveGeneration: bigint | null;
  }>;
  pendingRotation: VaultDeviceRegistry['pendingRotation'];
  /** True while a local revocation waits for the rotation that publishes it. */
  rotationRequired: boolean;
  /** True after fork evidence; sealing is refused until a rotation merges. */
  conflict: boolean;
  /**
   * Why sealing is stopped on this device and whether the rotation that
   * clears it is known to be possible. Null while nothing requires one.
   */
  rotation: VaultRotationStatus | null;
}

export type VaultRotationReason = 'revocation' | 'conflict';

/**
 * A rotation clears a pending revocation or merges a fork, and it needs the
 * recovery secret. `secretProven` is true only when the secret was proven for
 * every reason: a revocation records only after the proof, so it is proven
 * unless the state predates that rule. Fork evidence arrives from the relay
 * unasked, is never refused, and so is never proven; ask the user for the
 * secret and check it (`checkRecoverySecret`) before offering the merge.
 */
export interface VaultRotationStatus {
  reasons: VaultRotationReason[];
  secretProven: boolean;
}

/** What a recovery secret opens, as proven by {@link VaultKeyLifecycle.checkRecoverySecret}. */
export interface VaultRecoveryCheck {
  /** The secret opens the authority record the adopted head signs. */
  authority: boolean;
  /**
   * The secret opens the recovery record of the current key, so a fresh
   * device could recover it. Null when this device does not hold that record.
   */
  currentKey: boolean | null;
}

/** JSON-safe request a new device shows to an enrolled device. */
export interface VaultEnrollmentRequest {
  format: typeof REQUEST_FORMAT;
  version: 2;
  accountId: string;
  deviceId: string;
  publicKey: string;
  /** Random request nonce; binds both confirmation codes to this request. */
  nonce: string;
  expiresAt: string;
}

/** JSON-safe grant that carries sealed data keys to one recipient device. */
export interface VaultDeviceGrant {
  format: typeof GRANT_FORMAT;
  version: 2;
  kind: 'enrollment' | 'update';
  accountId: string;
  senderDeviceId: string;
  senderPublicKey: string;
  recipientDeviceId: string;
  issuedAt: string;
  /** The enrollment request nonce; null for update grants. */
  requestNonce: string | null;
  /** The sender's adopted signed head; the only source of account state. */
  head: VaultAccountHead;
  /**
   * The authority seed wrapped under the recovery secret (base64url), when
   * the sender holds the record its head signs; required for enrollment.
   */
  authorityRecord: string | null;
  generations: Array<{
    generation: string;
    keyId: string;
    transfer: string;
    recoveryRecord: string;
  }>;
}

/** Key for sealing new data. Zero `key` when done with it. */
export interface VaultSealingKey {
  purpose: 'seal';
  accountId: string;
  deviceId: string;
  generation: bigint;
  keyId: string;
  key: Uint8Array;
}

/** Key for opening existing data only. Zero `key` when done with it. */
export interface VaultReadingKey {
  purpose: 'read';
  accountId: string;
  generation: bigint;
  keyId: string;
  key: Uint8Array;
}

/** Records to publish to the relay; none is secret in the clear. */
export interface VaultPublication {
  head: VaultAccountHead;
  /**
   * Authority seed wrapped under the recovery secret; null while this device
   * has not received the record its adopted head signs.
   */
  authorityRecord: Uint8Array | null;
}

export interface VaultInitializeResult extends VaultPublication {
  authorityRecord: Uint8Array;
  generation: bigint;
  keyId: string;
  recoveryRecord: Uint8Array;
}

/** The new account a restart created, plus the account it replaced. */
export interface VaultRestartResult extends VaultInitializeResult {
  previousAccountId: string;
}

/** A previous account this device still holds after a restart or leave. */
export interface VaultPreviousAccount {
  accountId: string;
  /**
   * True while a restart or leave has not finished. Either no current account
   * exists (it stopped before the device joined or created the new one: run
   * `restartAccount` or enroll again), or parking stopped part way and the
   * old account is still current. In that second case the device may still
   * seal normally on the old account; call `restartAccount` or `leaveAccount`
   * again to finish.
   */
  interrupted: boolean;
}

export interface VaultRotationResult extends VaultPublication {
  authorityRecord: Uint8Array;
  generation: bigint;
  keyId: string;
  recoveryRecord: Uint8Array;
  /** One update grant for every other active device in the new head. */
  grants: VaultDeviceGrant[];
}

export interface VaultKeyLifecycleOptions {
  store: VaultKeyStore;
  now?: () => Date;
}

export interface VaultKeyLifecycle {
  status(): Promise<VaultKeyLifecycleStatus | null>;
  initializeAccount(input: {
    accountId: string;
    deviceId: string;
    recoverySecret: string;
  }): Promise<VaultInitializeResult>;
  /**
   * Start a new vault account from this working device when the recovery
   * secret is lost (#4817). Needs no knowledge of the old secret. The old
   * account is parked on the device (see {@link previousAccount}); nothing
   * from it is carried into the new account, which gets its own device
   * secret, authority key and first data key. Returns what to publish for
   * the new account. A retry with the same input after a crash completes the
   * restart; after it finished, it returns the same publication if the
   * secret is the same and fails `recovery_rejected` otherwise.
   * `confirmRestart` must be `true`: the old account stops being usable here.
   */
  restartAccount(input: {
    accountId: string;
    deviceId: string;
    recoverySecret: string;
    confirmRestart: true;
  }): Promise<VaultRestartResult>;
  /**
   * Park this device's account so it can join another through the normal
   * enrolment exchange (the other devices of a restarted family). Idempotent.
   * `confirmLeave` must be `true`. Publish anything unpublished first.
   */
  leaveAccount(input: {
    confirmLeave: true;
  }): Promise<{ previousAccountId: string }>;
  /** The account parked by `restartAccount` or `leaveAccount`, if any. */
  previousAccount(): Promise<VaultPreviousAccount | null>;
  /**
   * Delete the parked account's wrapped keys and records. Refuses with
   * `restart_incomplete` while the device has no current account. Call it
   * once the new account has a published backup. Idempotent.
   */
  discardPreviousAccount(): Promise<void>;
  /**
   * Read-only rescue of the parked previous account (#4838): open one of its
   * data keys for decrypting that account's snapshots by hand, while
   * `discardPreviousAccount` has not run. `accountId` must be the parked
   * account (`account_mismatch` otherwise, also for the current account).
   * Refuses with `no_previous_account` when nothing is parked or after the
   * discard, and `key_missing` for a key the parked account did not hold.
   * It writes nothing and never seals: the returned key is a reading key
   * bound to the old account, and its `key` is not enumerable, so it does not
   * survive JSON or spread. Zero `key` when done with it.
   */
  openPreviousReadingKey(
    input: VaultKeyReference & { accountId: string },
  ): Promise<VaultReadingKey>;
  /** Show the request (QR) and the device code on the new device. */
  createEnrollmentRequest(input: {
    accountId: string;
    deviceId: string;
    ttlMs?: number;
  }): Promise<{ request: VaultEnrollmentRequest; deviceCode: string }>;
  /**
   * `confirmationCode` is the device code the user reads from the new
   * device's screen. Show the returned account code to the user.
   */
  enrollDevice(
    request: VaultEnrollmentRequest,
    input: { confirmationCode: string; recoverySecret: string },
  ): Promise<{ grant: VaultDeviceGrant; accountCode: string }>;
  /** `confirmationCode` is the account code read from the enroller. */
  acceptEnrollment(
    grant: VaultDeviceGrant,
    input: { confirmationCode: string },
  ): Promise<VaultKeyLifecycleStatus>;
  enrollFromRecovery(input: {
    accountId: string;
    deviceId: string;
    head: VaultAccountHead;
    authorityRecord: Uint8Array;
    recoveryRecord: Uint8Array;
    recoverySecret: string;
  }): Promise<VaultKeyLifecycleStatus>;
  createDeviceGrant(deviceId: string): Promise<VaultDeviceGrant>;
  acceptDeviceGrant(grant: VaultDeviceGrant): Promise<VaultKeyLifecycleStatus>;
  /** Apply a head from the relay, with its authority record when known. */
  acceptAccountHead(
    head: VaultAccountHead,
    authorityRecord?: Uint8Array | null,
  ): Promise<VaultKeyLifecycleStatus>;
  /**
   * Prove, without changing anything, that `recoverySecret` still opens the
   * account authority record and the current key's recovery record. Nothing
   * is written, settled or cached, so a product can run it whenever the user
   * types the secret (for example to confirm it periodically) and warn
   * before the account is frozen. A wrong secret is `false`, not an error.
   */
  checkRecoverySecret(recoverySecret: string): Promise<VaultRecoveryCheck>;
  /**
   * Record a pending revocation. Requires the recovery secret as proof that
   * the rotation that publishes it can run (`recovery_rejected` otherwise,
   * and nothing is recorded). Sealing stops on this device until `rotate`.
   */
  revokeDevice(
    deviceId: string,
    input: { recoverySecret: string },
  ): Promise<VaultKeyLifecycleStatus>;
  rotate(input: {
    recoverySecret: string;
    newRecoverySecret?: string;
  }): Promise<VaultRotationResult>;
  /** The adopted head and authority record, for the caller to publish. */
  accountHead(): Promise<VaultPublication>;
  /** Stored recovery record for a held key, for the caller to publish. */
  recoveryRecord(reference: VaultKeyReference): Promise<Uint8Array>;
  /** The only path for sealing new data. */
  openSealingKey(): Promise<VaultSealingKey>;
  /** Open a held key named by stored data; never use it to seal. */
  openReadingKey(reference: VaultKeyReference): Promise<VaultReadingKey>;
}

// --- parsing helpers -----------------------------------------------------

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !LONE_SURROGATE.test(value) &&
    Buffer.byteLength(value) <= 255
  );
}

function identifier(value: unknown): string {
  if (!isIdentifier(value)) fail('invalid_input');
  return value;
}

function isGeneration(value: unknown): value is bigint {
  return typeof value === 'bigint' && value > 0n && value <= MAX_GENERATION;
}

function parseGeneration(value: unknown): bigint {
  if (typeof value !== 'string' || !GENERATION_TEXT.test(value)) {
    fail('invalid_input');
  }
  const generation = BigInt(value);
  if (!isGeneration(generation)) fail('invalid_input');
  return generation;
}

function keyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID.test(value)) fail('invalid_input');
  return value;
}

function reference(value: unknown): VaultKeyReference {
  const record = plainRecord(value);
  if (!isGeneration(record.generation)) fail('invalid_input');
  return { generation: record.generation, keyId: keyId(record.keyId) };
}

function decodeBytes(value: unknown, maxBytes: number): Uint8Array {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4) {
    fail('invalid_input');
  }
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value || bytes.length > maxBytes) {
    fail('invalid_input');
  }
  return new Uint8Array(bytes);
}

function fixedBytesText(value: unknown, length: number): string {
  if (decodeBytes(value, length).length !== length) fail('invalid_input');
  return value as string;
}

function timestamp(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 32 ||
    Number.isNaN(Date.parse(value))
  ) {
    fail('invalid_input');
  }
  return value;
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function digestText(bytes: Uint8Array): string {
  return encode(sha256(bytes));
}

function plainRecord(value: unknown): Record<string, unknown> {
  let copy: unknown;
  try {
    copy = deepFrozenPlainCopy(value);
  } catch {
    fail('invalid_input');
  }
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) {
    fail('invalid_input');
  }
  return copy as Record<string, unknown>;
}

function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('invalid_input');
  return value;
}

function bytesInput(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length > MAX_RECORD_BYTES) {
    fail('invalid_input');
  }
  return new Uint8Array(value);
}

/** Parse head input; any failure is reported with `code`. */
function verifiedHead(
  value: unknown,
  code: VaultKeyLifecycleErrorCode,
): VaultHead {
  try {
    return parseHead(value);
  } catch {
    fail(code);
  }
}

function sameDevice(
  left: { deviceId: string; publicKey: string },
  right: { deviceId: string; publicKey: string },
) {
  return left.deviceId === right.deviceId && left.publicKey === right.publicKey;
}

function touches(
  left: { deviceId: string; publicKey: string },
  right: { deviceId: string; publicKey: string },
) {
  return left.deviceId === right.deviceId || left.publicKey === right.publicKey;
}

function sameReference(left: VaultKeyReference, right: VaultKeyReference) {
  return left.generation === right.generation && left.keyId === right.keyId;
}

// --- registry ------------------------------------------------------------

function serializeEvidence(evidence: VaultForkEvidence) {
  return {
    sequence: evidence.sequence.toString(),
    generations: evidence.generations.map((entry) => ({
      generation: entry.generation.toString(),
      keyId: entry.keyId,
      keyCommitment: entry.keyCommitment,
      recoveryDigest: entry.recoveryDigest,
    })),
    devices: evidence.devices.map((device) => ({ ...device })),
    revokedDevices: evidence.revokedDevices.map((device) => ({
      ...device,
      effectiveGeneration: device.effectiveGeneration.toString(),
    })),
  };
}

function parseEvidence(value: unknown): VaultForkEvidence {
  const record = plainRecord(value);
  const evidence: VaultForkEvidence = {
    sequence: parseGeneration(record.sequence),
    generations: list(record.generations, EVIDENCE_LIMITS.generations).map(
      parseHeadGeneration,
    ),
    devices: list(record.devices, EVIDENCE_LIMITS.devices).map(parseHeadDevice),
    revokedDevices: list(
      record.revokedDevices,
      EVIDENCE_LIMITS.revokedDevices,
    ).map(parseHeadRevocation),
  };
  assertConsistentState(evidence, EVIDENCE_LIMITS, false);
  return evidence;
}

/** Serialize a registry. The output holds IDs, digests and public keys. */
export function serializeVaultDeviceRegistry(
  registry: VaultDeviceRegistry,
): string {
  return JSON.stringify({
    format: REGISTRY_FORMAT,
    version: REGISTRY_VERSION,
    accountId: registry.accountId,
    deviceId: registry.deviceId,
    head: serializeHead(registry.head),
    conflict: registry.conflict && serializeEvidence(registry.conflict),
    keys: registry.keys.map((entry) => ({
      generation: entry.generation.toString(),
      keyId: entry.keyId,
    })),
    pendingRevocations: registry.pendingRevocations.map((entry) => ({
      deviceId: entry.deviceId,
      publicKey: entry.publicKey,
      revokedAt: entry.revokedAt,
      provenAt: entry.provenAt,
    })),
    pendingRotation: registry.pendingRotation && {
      generation: registry.pendingRotation.generation.toString(),
      keyId: registry.pendingRotation.keyId,
      startedAt: registry.pendingRotation.startedAt,
    },
  });
}

/** Parse and validate a serialized registry, including its head signature. */
export function parseVaultDeviceRegistry(text: string): VaultDeviceRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('invalid_state');
  }
  try {
    const record = plainRecord(parsed);
    if (
      record.format !== REGISTRY_FORMAT ||
      record.version !== REGISTRY_VERSION
    ) {
      fail('invalid_input');
    }
    const head = verifiedHead(record.head, 'invalid_input');
    const registry: VaultDeviceRegistry = {
      accountId: identifier(record.accountId),
      deviceId: identifier(record.deviceId),
      head,
      conflict:
        record.conflict === null ? null : parseEvidence(record.conflict),
      keys: list(record.keys, MAX_HEAD_GENERATIONS * 2).map((value) => {
        const entry = plainRecord(value);
        return {
          generation: parseGeneration(entry.generation),
          keyId: keyId(entry.keyId),
        };
      }),
      pendingRevocations: list(record.pendingRevocations, MAX_HEAD_DEVICES).map(
        (value) => {
          const entry = plainRecord(value);
          return {
            deviceId: identifier(entry.deviceId),
            publicKey: fixedBytesText(entry.publicKey, KEY_BYTES),
            revokedAt: timestamp(entry.revokedAt),
            // Absent in state recorded before the proof rule: unproven.
            provenAt:
              entry.provenAt === undefined || entry.provenAt === null
                ? null
                : timestamp(entry.provenAt),
          };
        },
      ),
      pendingRotation: null,
    };
    if (record.pendingRotation !== null) {
      const pending = plainRecord(record.pendingRotation);
      registry.pendingRotation = {
        generation: parseGeneration(pending.generation),
        keyId: keyId(pending.keyId),
        startedAt: timestamp(pending.startedAt),
      };
    }
    const known = [
      ...head.generations,
      ...(registry.conflict?.generations ?? []),
    ];
    if (
      head.accountId !== registry.accountId ||
      !head.devices.some((device) => device.deviceId === registry.deviceId) ||
      new Set(
        registry.keys.map((entry) => `${entry.generation}:${entry.keyId}`),
      ).size !== registry.keys.length ||
      registry.keys.some(
        (entry) => !known.some((candidate) => sameReference(candidate, entry)),
      ) ||
      registry.pendingRevocations.some(
        (entry) =>
          entry.deviceId === registry.deviceId ||
          !head.devices.some((device) => sameDevice(device, entry)),
      )
    ) {
      fail('invalid_input');
    }
    return registry;
  } catch (error) {
    if (
      error instanceof VaultKeyLifecycleError ||
      error instanceof VaultHeadError
    ) {
      fail('invalid_state');
    }
    throw error;
  }
}

/** Revocations in effect locally: signed, fork evidence and pending. */
function revokedView(registry: VaultDeviceRegistry) {
  const signed = unionState([
    registry.head,
    ...(registry.conflict ? [registry.conflict] : []),
  ]).revokedDevices;
  return [
    ...signed.map(
      (device) =>
        ({ ...device }) as VaultKeyLifecycleStatus['revokedDevices'][number],
    ),
    ...registry.pendingRevocations
      .filter((entry) => !signed.some((device) => sameDevice(device, entry)))
      .map((entry) => ({
        deviceId: entry.deviceId,
        publicKey: entry.publicKey,
        revokedAt: entry.revokedAt,
        effectiveGeneration: null,
      })),
  ];
}

function activeDevices(registry: VaultDeviceRegistry): VaultHeadDevice[] {
  const revoked = revokedView(registry);
  return registry.head.devices.filter(
    (device) => !revoked.some((entry) => touches(entry, device)),
  );
}

function knownGenerations(registry: VaultDeviceRegistry) {
  return unionState([
    registry.head,
    ...(registry.conflict ? [registry.conflict] : []),
  ]).generations;
}

function rotationStatus(
  registry: VaultDeviceRegistry,
): VaultRotationStatus | null {
  const reasons: VaultRotationReason[] = [];
  if (registry.pendingRevocations.length > 0) reasons.push('revocation');
  if (registry.conflict) reasons.push('conflict');
  if (reasons.length === 0) return null;
  return {
    reasons,
    secretProven:
      registry.conflict === null &&
      registry.pendingRevocations.every((entry) => entry.provenAt !== null),
  };
}

function toStatus(registry: VaultDeviceRegistry): VaultKeyLifecycleStatus {
  const head = registry.head;
  return {
    accountId: registry.accountId,
    deviceId: registry.deviceId,
    sequence: head.sequence,
    headIssuedAt: head.issuedAt,
    headIssuerDeviceId: head.issuerDeviceId,
    authorityPublicKey: head.authorityPublicKey,
    currentGeneration: head.current.generation,
    currentKeyId: head.current.keyId,
    generations: knownGenerations(registry).map((entry) => ({
      generation: entry.generation,
      keyId: entry.keyId,
      status: sameReference(entry, head.current) ? 'current' : 'read-only',
      held: registry.keys.some((held) => sameReference(held, entry)),
    })),
    devices: activeDevices(registry).map((device) => ({ ...device })),
    revokedDevices: revokedView(registry),
    pendingRotation: registry.pendingRotation && {
      ...registry.pendingRotation,
    },
    rotationRequired: registry.pendingRevocations.length > 0,
    conflict: registry.conflict !== null,
    rotation: rotationStatus(registry),
  };
}

/**
 * Apply an authentic head to local state.
 *
 * A head is adopted only when it is newer and contains the local head. An
 * older head the local head contains is stale and changes nothing. Any
 * other authentic head is fork evidence: it is kept, its revocations take
 * effect at once, and sealing stops until a head containing it is adopted.
 */
function applyHead(
  registry: VaultDeviceRegistry,
  head: VaultHead,
): VaultDeviceRegistry {
  if (head.accountId !== registry.accountId) fail('account_mismatch');
  if (head.authorityPublicKey !== registry.head.authorityPublicKey) {
    fail('grant_rejected');
  }
  const self = registry.head.devices.find(
    (device) => device.deviceId === registry.deviceId,
  ) as VaultHeadDevice;
  if (head.revokedDevices.some((device) => touches(device, self))) {
    fail('device_revoked');
  }
  const local = registry.head;
  if (sameDigest(headDigest(head), headDigest(local))) return registry;
  const next: VaultDeviceRegistry = { ...registry };
  if (head.sequence > local.sequence && containsState(head, local)) {
    next.head = head;
    // A head with a new authority record means another device rotated the
    // secret, so an earlier proof no longer covers the current secret.
    const rotated = head.authorityRecordDigest !== local.authorityRecordDigest;
    next.pendingRevocations = registry.pendingRevocations
      .filter(
        (entry) =>
          !head.revokedDevices.some((device) => sameDevice(device, entry)) &&
          head.devices.some((device) => sameDevice(device, entry)),
      )
      .map((entry) => (rotated ? { ...entry, provenAt: null } : entry));
    if (registry.conflict && containsState(head, registry.conflict)) {
      next.conflict = null;
    }
    if (
      next.pendingRotation &&
      next.pendingRotation.generation <= head.current.generation
    ) {
      next.pendingRotation = null;
    }
    return next;
  }
  if (head.sequence < local.sequence && containsState(local, head)) {
    return registry;
  }
  const evidence = unionState([
    ...(registry.conflict ? [registry.conflict] : []),
    head,
  ]);
  const sequence =
    registry.conflict && registry.conflict.sequence > head.sequence
      ? registry.conflict.sequence
      : head.sequence;
  if (
    registry.conflict &&
    (evidence.generations.length > EVIDENCE_LIMITS.generations ||
      evidence.devices.length > EVIDENCE_LIMITS.devices ||
      evidence.revokedDevices.length > EVIDENCE_LIMITS.revokedDevices)
  ) {
    // Too many branches to keep: stay in conflict on the evidence already
    // held, so sealing remains refused rather than the fork being dropped.
    next.conflict = { ...registry.conflict, sequence };
    return next;
  }
  next.conflict = { sequence, ...evidence };
  return next;
}

function grantBindingDigest(
  grant: VaultDeviceGrant,
  head: VaultHead,
): Uint8Array {
  const entries = [...grant.generations].sort((left, right) =>
    left.generation === right.generation
      ? left.keyId < right.keyId
        ? -1
        : 1
      : BigInt(left.generation) < BigInt(right.generation)
        ? -1
        : 1,
  );
  const count = Buffer.alloc(4);
  count.writeUInt32BE(entries.length);
  return sha256(
    encodeFields([
      GRANT_BINDING_TAG,
      grant.kind,
      grant.accountId,
      grant.senderDeviceId,
      Buffer.from(grant.senderPublicKey, 'base64url'),
      grant.recipientDeviceId,
      grant.issuedAt,
      grant.requestNonce === null
        ? new Uint8Array(0)
        : Buffer.from(grant.requestNonce, 'base64url'),
      headDigest(head),
      grant.authorityRecord === null
        ? new Uint8Array(0)
        : sha256(Buffer.from(grant.authorityRecord, 'base64url')),
    ]),
    count,
    ...entries.map((entry) =>
      encodeFields([
        BigInt(entry.generation),
        entry.keyId,
        Buffer.from(entry.recoveryRecord, 'base64url'),
      ]),
    ),
  );
}

function parseGrant(value: unknown): {
  grant: VaultDeviceGrant;
  head: VaultHead;
} {
  try {
    const record = plainRecord(value);
    if (
      record.format !== GRANT_FORMAT ||
      record.version !== GRANT_VERSION ||
      (record.kind !== 'enrollment' && record.kind !== 'update')
    ) {
      fail('grant_rejected');
    }
    const generations = list(record.generations, MAX_HEAD_GENERATIONS).map(
      (item) => {
        const entry = plainRecord(item);
        return {
          generation: parseGeneration(entry.generation).toString(),
          keyId: keyId(entry.keyId),
          transfer: encode(decodeBytes(entry.transfer, MAX_RECORD_BYTES)),
          recoveryRecord: encode(
            decodeBytes(entry.recoveryRecord, MAX_RECORD_BYTES),
          ),
        };
      },
    );
    if (
      new Set(generations.map((entry) => `${entry.generation}:${entry.keyId}`))
        .size !== generations.length
    ) {
      fail('grant_rejected');
    }
    const head = verifiedHead(record.head, 'grant_rejected');
    const grant: VaultDeviceGrant = {
      format: GRANT_FORMAT,
      version: GRANT_VERSION,
      kind: record.kind,
      accountId: identifier(record.accountId),
      senderDeviceId: identifier(record.senderDeviceId),
      senderPublicKey: fixedBytesText(record.senderPublicKey, KEY_BYTES),
      recipientDeviceId: identifier(record.recipientDeviceId),
      issuedAt: timestamp(record.issuedAt),
      requestNonce:
        record.requestNonce === null
          ? null
          : fixedBytesText(record.requestNonce, NONCE_BYTES),
      head: serializeHead(head),
      authorityRecord:
        record.authorityRecord === null
          ? null
          : encode(decodeBytes(record.authorityRecord, MAX_RECORD_BYTES)),
      generations,
    };
    if ((grant.kind === 'enrollment') !== (grant.requestNonce !== null)) {
      fail('grant_rejected');
    }
    return { grant, head };
  } catch (error) {
    if (error instanceof VaultKeyLifecycleError) fail('grant_rejected');
    throw error;
  }
}

function keyItem(entry: VaultKeyReference) {
  return `key.${entry.generation}.${entry.keyId}`;
}

function recoveryItem(entry: VaultKeyReference) {
  return `recovery.${entry.generation}.${entry.keyId}`;
}

function parseRequest(value: unknown): VaultEnrollmentRequest {
  const record = plainRecord(value);
  if (record.format !== REQUEST_FORMAT || record.version !== REQUEST_VERSION) {
    fail('invalid_input');
  }
  return {
    format: REQUEST_FORMAT,
    version: REQUEST_VERSION,
    accountId: identifier(record.accountId),
    deviceId: identifier(record.deviceId),
    publicKey: fixedBytesText(record.publicKey, KEY_BYTES),
    nonce: fixedBytesText(record.nonce, NONCE_BYTES),
    expiresAt: timestamp(record.expiresAt),
  };
}

/**
 * Manage one device's vault keys: enrollment, rotation and revocation.
 *
 * Account state moves between devices only in heads signed by the account
 * authority, whose seed opens only with the user's recovery secret. Every
 * secret and wrapped key stays in the injected {@link VaultKeyStore}; the
 * registry beside them holds only IDs, digests, signatures and public keys.
 * Operations on one lifecycle object run one at a time; callers that share
 * a store across processes must serialize them (for example under the
 * application's operation lock).
 */
export function createVaultKeyLifecycle({
  store,
  now = () => new Date(),
}: VaultKeyLifecycleOptions): VaultKeyLifecycle {
  let queue: Promise<unknown> = Promise.resolve();

  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.catch(() => undefined);
    return result;
  }

  function isoNow(): string {
    return now().toISOString();
  }

  async function loadRegistry(): Promise<VaultDeviceRegistry | null> {
    const bytes = await store.get(REGISTRY_ITEM);
    if (bytes === null) return null;
    return parseVaultDeviceRegistry(Buffer.from(bytes).toString('utf8'));
  }

  async function requireRegistry(): Promise<VaultDeviceRegistry> {
    return (await loadRegistry()) ?? fail('not_initialized');
  }

  async function saveRegistry(registry: VaultDeviceRegistry): Promise<void> {
    const serialized = serializeVaultDeviceRegistry(registry);
    // Never persist a registry the next load would reject.
    parseVaultDeviceRegistry(serialized);
    await store.set(REGISTRY_ITEM, new Uint8Array(Buffer.from(serialized)));
  }

  /** The device secret; callers zero the returned copy when done. */
  async function deviceSecret(create: boolean): Promise<Uint8Array> {
    const existing = await store.get(DEVICE_SECRET_ITEM);
    if (existing !== null) {
      if (existing.length !== KEY_BYTES) fail('invalid_state');
      return new Uint8Array(existing);
    }
    if (!create) fail('invalid_state');
    const secret = new Uint8Array(randomBytes(KEY_BYTES));
    await store.set(DEVICE_SECRET_ITEM, secret);
    return secret;
  }

  async function requireItem(name: string): Promise<Uint8Array> {
    return (await store.get(name)) ?? fail('invalid_state');
  }

  /**
   * The registry is written last, so its absence means no state is in use.
   * Items an interrupted attempt left behind are unreferenced; keys are
   * named by random key ID, so a retry never replaces a different key.
   */
  async function assertUninitialized(): Promise<void> {
    if ((await store.get(REGISTRY_ITEM)) !== null) fail('already_initialized');
  }

  function openOwnKey(
    registry: Pick<VaultDeviceRegistry, 'accountId' | 'deviceId'>,
    secret: Uint8Array,
    entry: VaultKeyReference,
    record: Uint8Array,
  ): Uint8Array {
    try {
      return openVaultDeviceKey(record, secret, {
        accountId: registry.accountId,
        deviceId: registry.deviceId,
        generation: entry.generation,
        keyId: entry.keyId,
      });
    } catch {
      fail('invalid_state');
    }
  }

  async function openHeldKey(
    registry: VaultDeviceRegistry,
    secret: Uint8Array,
    entry: VaultKeyReference,
  ): Promise<Uint8Array> {
    if (!registry.keys.some((held) => sameReference(held, entry))) {
      fail('key_missing');
    }
    return openOwnKey(
      registry,
      secret,
      entry,
      await requireItem(keyItem(entry)),
    );
  }

  async function wrapAuthority(
    seed: Uint8Array,
    accountId: string,
    recoverySecret: string,
  ): Promise<Uint8Array> {
    try {
      return await wrapVaultRecoveryKey(
        { keyId: authorityKeyId(authorityPublicKey(seed)), key: seed },
        recoverySecret,
        { accountId, generation: AUTHORITY_GENERATION },
      );
    } catch {
      fail('invalid_input');
    }
  }

  /** Open an authority record; the caller zeroes the returned seed. */
  async function openAuthority(
    record: Uint8Array,
    accountId: string,
    publicKey: string,
    recoverySecret: unknown,
  ): Promise<Uint8Array | null> {
    let opened: { keyId: string; key: Uint8Array };
    try {
      opened = await openVaultRecoveryKey(record, recoverySecret as string, {
        accountId,
        generation: AUTHORITY_GENERATION,
      });
    } catch {
      return null;
    }
    if (
      encode(authorityPublicKey(opened.key)) !== publicKey ||
      opened.keyId !== authorityKeyId(Buffer.from(publicKey, 'base64url'))
    ) {
      opened.key.fill(0);
      return null;
    }
    return opened.key;
  }

  /** The stored authority record whose digest the adopted head signs. */
  async function headAuthorityRecord(
    registry: VaultDeviceRegistry,
  ): Promise<Uint8Array | null> {
    for (const name of [AUTHORITY_ITEM, AUTHORITY_NEXT_ITEM]) {
      const record = await store.get(name);
      if (
        record !== null &&
        digestText(record) === registry.head.authorityRecordDigest
      ) {
        return record;
      }
    }
    return null;
  }

  /**
   * Open the authority with the recovery secret. Only the record the
   * adopted head signs is accepted, so a superseded secret never signs.
   */
  async function authoritySeed(
    registry: VaultDeviceRegistry,
    recoverySecret: unknown,
  ): Promise<Uint8Array> {
    const record = await headAuthorityRecord(registry);
    const seed =
      record &&
      (await openAuthority(
        record,
        registry.accountId,
        registry.head.authorityPublicKey,
        recoverySecret,
      ));
    return seed ?? fail('recovery_rejected');
  }

  /** Finish or discard an interrupted recovery-secret rotation. */
  async function settleAuthority(registry: VaultDeviceRegistry) {
    const next = await store.get(AUTHORITY_NEXT_ITEM);
    if (next === null) return;
    if (digestText(next) === registry.head.authorityRecordDigest) {
      await store.set(AUTHORITY_ITEM, next);
    }
    await store.delete(AUTHORITY_NEXT_ITEM);
  }

  /** Keep a received authority record when the adopted head signs it. */
  async function keepAuthorityRecord(
    registry: VaultDeviceRegistry,
    record: Uint8Array | null,
  ) {
    if (
      record !== null &&
      digestText(record) === registry.head.authorityRecordDigest
    ) {
      await store.set(AUTHORITY_ITEM, record);
    }
  }

  function verifyCommitment(
    accountId: string,
    entry: VaultHeadGeneration,
    key: Uint8Array,
  ): boolean {
    return (
      keyCommitment(key, accountId, entry.generation, entry.keyId) ===
      entry.keyCommitment
    );
  }

  async function buildGrant(
    registry: VaultDeviceRegistry,
    secret: Uint8Array,
    recipient: { deviceId: string; publicKey: string },
    requestNonce: string | null,
  ): Promise<VaultDeviceGrant> {
    const senderPublicKey = deriveVaultDevicePublicKey(secret);
    const held = registry.head.generations.filter((entry) =>
      registry.keys.some((key) => sameReference(key, entry)),
    );
    const authorityRecord = await headAuthorityRecord(registry);
    // A new device needs the record to hold authority later.
    if (requestNonce !== null && authorityRecord === null) {
      fail('invalid_state');
    }
    const grant: VaultDeviceGrant = {
      format: GRANT_FORMAT,
      version: GRANT_VERSION,
      kind: requestNonce === null ? 'update' : 'enrollment',
      accountId: registry.accountId,
      senderDeviceId: registry.deviceId,
      senderPublicKey: encode(senderPublicKey),
      recipientDeviceId: recipient.deviceId,
      issuedAt: isoNow(),
      requestNonce,
      head: serializeHead(registry.head),
      authorityRecord: authorityRecord && encode(authorityRecord),
      generations: [],
    };
    for (const entry of held) {
      grant.generations.push({
        generation: entry.generation.toString(),
        keyId: entry.keyId,
        transfer: '',
        recoveryRecord: encode(await requireItem(recoveryItem(entry))),
      });
    }
    // Every transfer authenticates the whole grant, including the head.
    const bindingDigest = grantBindingDigest(grant, registry.head);
    for (const [index, entry] of held.entries()) {
      const dataKey = await openHeldKey(registry, secret, entry);
      try {
        grant.generations[index].transfer = encode(
          sealVaultDeviceTransfer(dataKey, secret, {
            accountId: registry.accountId,
            deviceId: recipient.deviceId,
            generation: entry.generation,
            keyId: entry.keyId,
            senderDeviceId: registry.deviceId,
            senderPublicKey,
            recipientPublicKey: decodeBytes(recipient.publicKey, KEY_BYTES),
            bindingDigest,
          }),
        );
      } finally {
        dataKey.fill(0);
      }
    }
    return grant;
  }

  /**
   * Open every transfer before anything is written. Each key must be one
   * the signed head commits to, with its committed recovery record.
   */
  function openGrant(
    grant: VaultDeviceGrant,
    head: VaultHead,
    secret: Uint8Array,
  ) {
    const senderPublicKey = decodeBytes(grant.senderPublicKey, KEY_BYTES);
    const bindingDigest = grantBindingDigest(grant, head);
    const opened: Array<{
      entry: VaultHeadGeneration;
      key: Uint8Array;
      recoveryRecord: Uint8Array;
    }> = [];
    try {
      for (const item of grant.generations) {
        const generation = BigInt(item.generation);
        const entry = head.generations.find((candidate) =>
          sameReference(candidate, { generation, keyId: item.keyId }),
        );
        const recoveryRecord = decodeBytes(
          item.recoveryRecord,
          MAX_RECORD_BYTES,
        );
        if (!entry || digestText(recoveryRecord) !== entry.recoveryDigest) {
          throw new Error('uncommitted');
        }
        const key = openVaultDeviceTransfer(
          decodeBytes(item.transfer, MAX_RECORD_BYTES),
          secret,
          {
            accountId: grant.accountId,
            deviceId: grant.recipientDeviceId,
            generation,
            keyId: item.keyId,
            senderDeviceId: grant.senderDeviceId,
            senderPublicKey,
            bindingDigest,
          },
        );
        opened.push({ entry, key, recoveryRecord });
        if (!verifyCommitment(grant.accountId, entry, key)) {
          throw new Error('uncommitted');
        }
      }
      return opened;
    } catch {
      for (const entry of opened) entry.key.fill(0);
      fail('grant_rejected');
    }
  }

  async function storeKey(
    registry: Pick<VaultDeviceRegistry, 'accountId' | 'deviceId'>,
    secret: Uint8Array,
    entry: VaultKeyReference,
    key: Uint8Array,
    recoveryRecord: Uint8Array,
  ): Promise<void> {
    await store.set(
      keyItem(entry),
      wrapVaultDeviceKey(key, secret, {
        accountId: registry.accountId,
        deviceId: registry.deviceId,
        generation: entry.generation,
        keyId: entry.keyId,
      }),
    );
    await store.set(recoveryItem(entry), recoveryRecord);
  }

  async function verifyRecoveryRecord(
    accountId: string,
    entry: VaultKeyReference,
    recoverySecret: unknown,
  ): Promise<boolean> {
    try {
      const opened = await openVaultRecoveryKey(
        await requireItem(recoveryItem(entry)),
        recoverySecret as string,
        { accountId, generation: entry.generation },
      );
      opened.key.fill(0);
      return opened.keyId === entry.keyId;
    } catch {
      return false;
    }
  }

  /** Create a fresh account on an uninitialized device. */
  async function createAccount(
    accountId: string,
    deviceId: string,
    recoverySecret: string,
  ): Promise<VaultInitializeResult> {
    const secret = await deviceSecret(true);
    const seed = new Uint8Array(randomBytes(KEY_BYTES));
    try {
      const authorityRecord = await wrapAuthority(
        seed,
        accountId,
        recoverySecret,
      );
      const prepared = await prepareVaultKeyGeneration({
        accountId,
        deviceId,
        deviceSecret: secret,
        recoverySecret: recoverySecret,
        currentGeneration: null,
      });
      const entry = {
        generation: prepared.generation,
        keyId: prepared.keyId,
      };
      const key = openOwnKey(
        { accountId, deviceId },
        secret,
        entry,
        prepared.deviceRecord,
      );
      let commitment: string;
      try {
        commitment = keyCommitment(
          key,
          accountId,
          entry.generation,
          entry.keyId,
        );
      } finally {
        key.fill(0);
      }
      const head = signHead(
        {
          accountId,
          sequence: 1n,
          issuedAt: isoNow(),
          issuerDeviceId: deviceId,
          current: entry,
          generations: [
            {
              ...entry,
              keyCommitment: commitment,
              recoveryDigest: digestText(prepared.recoveryRecord),
            },
          ],
          devices: [
            {
              deviceId,
              publicKey: encode(deriveVaultDevicePublicKey(secret)),
              enrolledAt: isoNow(),
            },
          ],
          revokedDevices: [],
          authorityPublicKey: encode(authorityPublicKey(seed)),
          authorityRecordDigest: digestText(authorityRecord),
        },
        seed,
      );
      await store.set(keyItem(entry), prepared.deviceRecord);
      await store.set(recoveryItem(entry), prepared.recoveryRecord);
      await store.set(AUTHORITY_ITEM, authorityRecord);
      await saveRegistry({
        accountId,
        deviceId,
        head,
        conflict: null,
        keys: [entry],
        pendingRevocations: [],
        pendingRotation: null,
      });
      return {
        ...entry,
        recoveryRecord: prepared.recoveryRecord,
        head: serializeHead(head),
        authorityRecord,
      };
    } finally {
      seed.fill(0);
      secret.fill(0);
    }
  }

  async function readPrevious(): Promise<VaultDeviceRegistry | null> {
    const bytes = await store.get(PREVIOUS_REGISTRY_ITEM);
    return bytes === null
      ? null
      : parseVaultDeviceRegistry(Buffer.from(bytes).toString('utf8'));
  }

  /**
   * Park the current account (if any) as the previous one and leave the
   * device uninitialized. Every step is repeatable: a crash anywhere leaves
   * either the old account intact or an uninitialized device holding the
   * archive, and a retry finishes. Returns the parked account's ID.
   */
  async function archiveCurrent(
    registry: VaultDeviceRegistry | null,
  ): Promise<string> {
    const previous = await readPrevious();
    if (registry === null) {
      return previous?.accountId ?? fail('not_initialized');
    }
    // Another account is already parked: discard it first. The same account
    // means an earlier attempt stopped part way.
    if (previous && previous.accountId !== registry.accountId) {
      fail('restart_pending');
    }
    // Finish an interrupted recovery-secret rotation so the parked
    // authority record is the one the adopted head signs.
    await settleAuthority(registry);
    const authority = await store.get(AUTHORITY_ITEM);
    const secret = await store.get(DEVICE_SECRET_ITEM);
    const current = await store.get(REGISTRY_ITEM);
    if (current === null) fail('invalid_state');
    if (authority !== null) await store.set(PREVIOUS_AUTHORITY_ITEM, authority);
    if (secret !== null) await store.set(PREVIOUS_DEVICE_SECRET_ITEM, secret);
    await store.set(PREVIOUS_REGISTRY_ITEM, current);
    await store.delete(ENROLLMENT_ITEM);
    await store.delete(AUTHORITY_NEXT_ITEM);
    await store.delete(AUTHORITY_ITEM);
    await store.delete(DEVICE_SECRET_ITEM);
    // Last: its absence is what makes the device uninitialized.
    await store.delete(REGISTRY_ITEM);
    return registry.accountId;
  }

  return {
    status: () =>
      serial(async () => {
        const registry = await loadRegistry();
        return registry && toStatus(registry);
      }),

    initializeAccount: (input) =>
      serial(async () => {
        const accountId = identifier(input?.accountId);
        const deviceId = identifier(input?.deviceId);
        await assertUninitialized();
        return createAccount(accountId, deviceId, input.recoverySecret);
      }),

    restartAccount: (input) =>
      serial(async () => {
        if (input?.confirmRestart !== true) fail('invalid_input');
        const accountId = identifier(input.accountId);
        const deviceId = identifier(input.deviceId);
        const registry = await loadRegistry();
        if (registry?.accountId === accountId) {
          // The restart already finished. A retry must prove the same secret
          // before it is shown the publication again.
          const previous = await readPrevious();
          if (previous === null) fail('already_initialized');
          (await authoritySeed(registry, input.recoverySecret)).fill(0);
          const authorityRecord = await headAuthorityRecord(registry);
          if (authorityRecord === null) fail('invalid_state');
          const current = registry.head.current;
          return {
            generation: current.generation,
            keyId: current.keyId,
            recoveryRecord: await requireItem(recoveryItem(current)),
            head: serializeHead(registry.head),
            authorityRecord,
            previousAccountId: previous.accountId,
          };
        }
        const previousAccountId = await archiveCurrent(registry);
        if (previousAccountId === accountId) fail('invalid_input');
        return {
          ...(await createAccount(accountId, deviceId, input.recoverySecret)),
          previousAccountId,
        };
      }),

    leaveAccount: (input) =>
      serial(async () => {
        if (input?.confirmLeave !== true) fail('invalid_input');
        return {
          previousAccountId: await archiveCurrent(await loadRegistry()),
        };
      }),

    previousAccount: () =>
      serial(async () => {
        const previous = await readPrevious();
        if (previous === null) return null;
        const registry = await loadRegistry();
        return {
          accountId: previous.accountId,
          // Also while the old registry is still in place: the device was
          // part way through parking it and cannot use it any more.
          interrupted:
            registry === null || registry.accountId === previous.accountId,
        };
      }),

    discardPreviousAccount: () =>
      serial(async () => {
        const previous = await readPrevious();
        if (previous === null) return;
        const registry = await loadRegistry();
        if (registry === null) fail('restart_incomplete');
        if (registry.accountId === previous.accountId) fail('invalid_state');
        const parked = [
          ...previous.keys,
          ...(previous.pendingRotation ? [previous.pendingRotation] : []),
        ];
        for (const entry of parked) {
          // Never delete an item the current account also uses.
          if (
            registry.keys.some((held) => sameReference(held, entry)) ||
            registry.pendingRotation?.keyId === entry.keyId
          ) {
            continue;
          }
          await store.delete(keyItem(entry));
          await store.delete(recoveryItem(entry));
        }
        await store.delete(PREVIOUS_AUTHORITY_ITEM);
        await store.delete(PREVIOUS_DEVICE_SECRET_ITEM);
        await store.delete(PREVIOUS_REGISTRY_ITEM);
      }),

    openPreviousReadingKey: (input) =>
      serial(async () => {
        const record = plainRecord(input);
        const entry = reference(record);
        const accountId = identifier(record.accountId);
        const previous = await readPrevious();
        if (previous === null) fail('no_previous_account');
        if (previous.accountId !== accountId) fail('account_mismatch');
        if (!previous.keys.some((held) => sameReference(held, entry))) {
          fail('key_missing');
        }
        const held = await store.get(PREVIOUS_DEVICE_SECRET_ITEM);
        if (held === null || held.length !== KEY_BYTES) fail('invalid_state');
        const secret = new Uint8Array(held);
        try {
          const reading = {
            purpose: 'read' as const,
            accountId: previous.accountId,
            generation: entry.generation,
            keyId: entry.keyId,
          };
          const key = openOwnKey(
            previous,
            secret,
            entry,
            await requireItem(keyItem(entry)),
          );
          return Object.defineProperty(reading, 'key', {
            value: key,
            enumerable: false,
          }) as VaultReadingKey;
        } finally {
          secret.fill(0);
        }
      }),

    createEnrollmentRequest: (input) =>
      serial(async () => {
        const accountId = identifier(input?.accountId);
        const deviceId = identifier(input?.deviceId);
        const ttl = input.ttlMs ?? DEFAULT_REQUEST_TTL_MS;
        if (
          typeof ttl !== 'number' ||
          !Number.isInteger(ttl) ||
          ttl <= 0 ||
          ttl > MAX_REQUEST_TTL_MS
        ) {
          fail('invalid_input');
        }
        await assertUninitialized();
        const secret = await deviceSecret(true);
        try {
          const request: VaultEnrollmentRequest = {
            format: REQUEST_FORMAT,
            version: REQUEST_VERSION,
            accountId,
            deviceId,
            publicKey: encode(deriveVaultDevicePublicKey(secret)),
            nonce: encode(randomBytes(NONCE_BYTES)),
            expiresAt: new Date(now().getTime() + ttl).toISOString(),
          };
          await store.set(
            ENROLLMENT_ITEM,
            new Uint8Array(Buffer.from(JSON.stringify(request))),
          );
          return { request, deviceCode: deviceCode(request) };
        } finally {
          secret.fill(0);
        }
      }),

    enrollDevice: (input, confirmation) =>
      serial(async () => {
        const request = parseRequest(input);
        const registry = await requireRegistry();
        if (request.accountId !== registry.accountId) fail('account_mismatch');
        const expires = Date.parse(request.expiresAt);
        const current = now().getTime();
        if (expires <= current || expires > current + MAX_REQUEST_TTL_MS) {
          fail('request_expired');
        }
        if (!codesMatch(deviceCode(request), confirmation?.confirmationCode)) {
          fail('confirmation_rejected');
        }
        if (registry.conflict) fail('generation_conflict');
        if (registry.pendingRevocations.length > 0) fail('rotation_required');
        if (revokedView(registry).some((device) => touches(device, request))) {
          fail('device_revoked');
        }
        const recipient = {
          deviceId: request.deviceId,
          publicKey: request.publicKey,
        };
        const existing = registry.head.devices.find((device) =>
          touches(device, recipient),
        );
        if (
          existing &&
          (!sameDevice(existing, recipient) ||
            existing.deviceId === registry.deviceId)
        ) {
          fail('device_conflict');
        }
        if (!existing && registry.head.devices.length >= MAX_HEAD_DEVICES) {
          fail('device_conflict');
        }
        if (!existing && registry.head.sequence >= MAX_GENERATION) {
          fail('generation_limit');
        }
        await settleAuthority(registry);
        const secret = await deviceSecret(false);
        try {
          let next = registry;
          if (!existing) {
            const seed = await authoritySeed(
              registry,
              confirmation?.recoverySecret,
            );
            try {
              next = {
                ...registry,
                head: signHead(
                  {
                    ...registry.head,
                    sequence: registry.head.sequence + 1n,
                    issuedAt: isoNow(),
                    issuerDeviceId: registry.deviceId,
                    devices: [
                      ...registry.head.devices,
                      { ...recipient, enrolledAt: isoNow() },
                    ],
                  },
                  seed,
                ),
              };
            } finally {
              seed.fill(0);
            }
          }
          // Build the grant before recording the device.
          const grant = await buildGrant(
            next,
            secret,
            recipient,
            request.nonce,
          );
          if (next !== registry) await saveRegistry(next);
          return {
            grant,
            accountCode: accountCode({
              accountId: registry.accountId,
              authorityPublicKey: next.head.authorityPublicKey,
              headDigest: headDigest(next.head),
              devicePublicKey: request.publicKey,
              nonce: request.nonce,
            }),
          };
        } finally {
          secret.fill(0);
        }
      }),

    acceptEnrollment: (input, confirmation) =>
      serial(async () => {
        await assertUninitialized();
        const pending = await store.get(ENROLLMENT_ITEM);
        if (pending === null) fail('invalid_state');
        let request: VaultEnrollmentRequest;
        try {
          request = parseRequest(JSON.parse(Buffer.from(pending).toString()));
        } catch {
          fail('invalid_state');
        }
        if (now().getTime() >= Date.parse(request.expiresAt)) {
          await store.delete(ENROLLMENT_ITEM);
          fail('request_expired');
        }
        const { grant, head } = parseGrant(input);
        const secret = await deviceSecret(false);
        try {
          const publicKey = encode(deriveVaultDevicePublicKey(secret));
          if (
            grant.kind !== 'enrollment' ||
            grant.accountId !== request.accountId ||
            head.accountId !== request.accountId ||
            grant.recipientDeviceId !== request.deviceId ||
            grant.requestNonce !== request.nonce ||
            request.publicKey !== publicKey ||
            grant.senderDeviceId === grant.recipientDeviceId
          ) {
            fail('grant_rejected');
          }
          const expected = accountCode({
            accountId: request.accountId,
            authorityPublicKey: head.authorityPublicKey,
            headDigest: headDigest(head),
            devicePublicKey: publicKey,
            nonce: request.nonce,
          });
          if (!codesMatch(expected, confirmation?.confirmationCode)) {
            fail('confirmation_rejected');
          }
          const self = { deviceId: request.deviceId, publicKey };
          const sender = {
            deviceId: grant.senderDeviceId,
            publicKey: grant.senderPublicKey,
          };
          if (grant.authorityRecord === null) fail('grant_rejected');
          const authorityRecord = decodeBytes(
            grant.authorityRecord,
            MAX_RECORD_BYTES,
          );
          if (
            !head.devices.some((device) => sameDevice(device, self)) ||
            !head.devices.some((device) => sameDevice(device, sender)) ||
            digestText(authorityRecord) !== head.authorityRecordDigest
          ) {
            fail('grant_rejected');
          }
          const opened = openGrant(grant, head, secret);
          try {
            const registry: VaultDeviceRegistry = {
              accountId: request.accountId,
              deviceId: request.deviceId,
              head,
              conflict: null,
              keys: opened.map(({ entry }) => ({
                generation: entry.generation,
                keyId: entry.keyId,
              })),
              pendingRevocations: [],
              pendingRotation: null,
            };
            // Validate before writing any key material.
            parseVaultDeviceRegistry(serializeVaultDeviceRegistry(registry));
            for (const { entry, key, recoveryRecord } of opened) {
              await storeKey(registry, secret, entry, key, recoveryRecord);
            }
            await store.set(AUTHORITY_ITEM, authorityRecord);
            await saveRegistry(registry);
            await store.delete(ENROLLMENT_ITEM);
            return toStatus(registry);
          } finally {
            for (const entry of opened) entry.key.fill(0);
          }
        } finally {
          secret.fill(0);
        }
      }),

    enrollFromRecovery: (input) =>
      serial(async () => {
        const accountId = identifier(input?.accountId);
        const deviceId = identifier(input?.deviceId);
        const authorityRecord = bytesInput(input.authorityRecord);
        const recoveryRecord = bytesInput(input.recoveryRecord);
        await assertUninitialized();
        const head = verifiedHead(input.head, 'recovery_rejected');
        if (
          head.accountId !== accountId ||
          digestText(authorityRecord) !== head.authorityRecordDigest
        ) {
          fail('recovery_rejected');
        }
        if (head.sequence >= MAX_GENERATION) fail('generation_limit');
        const seed = await openAuthority(
          authorityRecord,
          accountId,
          head.authorityPublicKey,
          input.recoverySecret,
        );
        if (seed === null) fail('recovery_rejected');
        let recovered: { keyId: string; key: Uint8Array } | undefined;
        let secret: Uint8Array | undefined;
        try {
          if (
            head.devices.some((device) => device.deviceId === deviceId) ||
            head.devices.length >= MAX_HEAD_DEVICES
          ) {
            fail('device_conflict');
          }
          if (
            head.revokedDevices.some((device) => device.deviceId === deviceId)
          ) {
            fail('device_revoked');
          }
          const entry = head.generations.find((candidate) =>
            sameReference(candidate, head.current),
          ) as VaultHeadGeneration;
          if (digestText(recoveryRecord) !== entry.recoveryDigest) {
            fail('recovery_rejected');
          }
          try {
            recovered = await openVaultRecoveryKey(
              recoveryRecord,
              input.recoverySecret,
              { accountId, generation: entry.generation },
            );
          } catch {
            fail('recovery_rejected');
          }
          if (
            recovered.keyId !== entry.keyId ||
            !verifyCommitment(accountId, entry, recovered.key)
          ) {
            fail('recovery_rejected');
          }
          secret = await deviceSecret(true);
          const reference = {
            generation: entry.generation,
            keyId: entry.keyId,
          };
          const registry: VaultDeviceRegistry = {
            accountId,
            deviceId,
            // Joining is itself a signed change, so a stale head served by
            // the relay surfaces as a fork at the first peer.
            head: signHead(
              {
                ...head,
                sequence: head.sequence + 1n,
                issuedAt: isoNow(),
                issuerDeviceId: deviceId,
                devices: [
                  ...head.devices,
                  {
                    deviceId,
                    publicKey: encode(deriveVaultDevicePublicKey(secret)),
                    enrolledAt: isoNow(),
                  },
                ],
              },
              seed,
            ),
            conflict: null,
            keys: [reference],
            pendingRevocations: [],
            pendingRotation: null,
          };
          parseVaultDeviceRegistry(serializeVaultDeviceRegistry(registry));
          await storeKey(
            registry,
            secret,
            reference,
            recovered.key,
            recoveryRecord,
          );
          await store.set(AUTHORITY_ITEM, authorityRecord);
          await saveRegistry(registry);
          await store.delete(ENROLLMENT_ITEM);
          return toStatus(registry);
        } finally {
          recovered?.key.fill(0);
          secret?.fill(0);
          seed.fill(0);
        }
      }),

    createDeviceGrant: (deviceId) =>
      serial(async () => {
        const id = identifier(deviceId);
        const registry = await requireRegistry();
        if (revokedView(registry).some((device) => device.deviceId === id)) {
          fail('device_revoked');
        }
        const recipient = activeDevices(registry).find(
          (device) => device.deviceId === id,
        );
        if (!recipient || id === registry.deviceId) fail('unknown_device');
        const secret = await deviceSecret(false);
        try {
          return await buildGrant(registry, secret, recipient, null);
        } finally {
          secret.fill(0);
        }
      }),

    acceptAccountHead: (input, authorityRecord) =>
      serial(async () => {
        const record =
          authorityRecord === undefined || authorityRecord === null
            ? null
            : bytesInput(authorityRecord);
        const registry = await requireRegistry();
        const next = applyHead(registry, verifiedHead(input, 'grant_rejected'));
        if (next !== registry) await saveRegistry(next);
        await keepAuthorityRecord(next, record);
        return toStatus(next);
      }),

    acceptDeviceGrant: (input) =>
      serial(async () => {
        const { grant, head } = parseGrant(input);
        const registry = await requireRegistry();
        if (
          grant.kind !== 'update' ||
          grant.accountId !== registry.accountId ||
          grant.recipientDeviceId !== registry.deviceId
        ) {
          fail('grant_rejected');
        }
        // The signed head is learned on its own merits first, so a bad
        // transfer from any sender cannot hide a valid head.
        const next = applyHead(registry, head);
        if (next !== registry) await saveRegistry(next);
        const sender = {
          deviceId: grant.senderDeviceId,
          publicKey: grant.senderPublicKey,
        };
        if (revokedView(next).some((device) => touches(device, sender))) {
          fail('device_revoked');
        }
        if (
          sender.deviceId === next.deviceId ||
          !activeDevices(next).some((device) => sameDevice(device, sender))
        ) {
          fail('grant_rejected');
        }
        const secret = await deviceSecret(false);
        let opened: ReturnType<typeof openGrant> = [];
        try {
          opened = openGrant(grant, head, secret);
          const known = knownGenerations(next);
          const fresh = opened.filter(
            ({ entry }) =>
              !next.keys.some((held) => sameReference(held, entry)) &&
              known.some(
                (candidate) =>
                  sameReference(candidate, entry) &&
                  candidate.keyCommitment === entry.keyCommitment,
              ),
          );
          const merged: VaultDeviceRegistry = {
            ...next,
            keys: [
              ...next.keys,
              ...fresh.map(({ entry }) => ({
                generation: entry.generation,
                keyId: entry.keyId,
              })),
            ],
          };
          parseVaultDeviceRegistry(serializeVaultDeviceRegistry(merged));
          for (const { entry, key, recoveryRecord } of fresh) {
            await storeKey(merged, secret, entry, key, recoveryRecord);
          }
          await keepAuthorityRecord(
            merged,
            grant.authorityRecord === null
              ? null
              : decodeBytes(grant.authorityRecord, MAX_RECORD_BYTES),
          );
          if (fresh.length > 0) await saveRegistry(merged);
          return toStatus(merged);
        } finally {
          for (const entry of opened) entry.key.fill(0);
          secret.fill(0);
        }
      }),

    checkRecoverySecret: (recoverySecret) =>
      serial(async () => {
        const registry = await requireRegistry();
        const record = await headAuthorityRecord(registry);
        const seed =
          record === null
            ? null
            : await openAuthority(
                record,
                registry.accountId,
                registry.head.authorityPublicKey,
                recoverySecret,
              );
        seed?.fill(0);
        const current = registry.head.current;
        return {
          authority: seed !== null,
          currentKey: registry.keys.some((held) => sameReference(held, current))
            ? await verifyRecoveryRecord(
                registry.accountId,
                current,
                recoverySecret,
              )
            : null,
        };
      }),

    revokeDevice: (deviceId, proof) =>
      serial(async () => {
        const id = identifier(deviceId);
        const registry = await requireRegistry();
        if (id === registry.deviceId) fail('device_conflict');
        if (revokedView(registry).some((device) => device.deviceId === id)) {
          return toStatus(registry);
        }
        const device = registry.head.devices.find(
          (entry) => entry.deviceId === id,
        );
        if (!device) fail('unknown_device');
        // Record the revocation only when the rotation that publishes it can
        // run: the secret must open the record the adopted head signs. A
        // device holding only its own secret (for example a stolen one) can
        // neither revoke a peer nor strand this device without a way out.
        (await authoritySeed(registry, proof?.recoverySecret)).fill(0);
        const next: VaultDeviceRegistry = {
          ...registry,
          pendingRevocations: [
            ...registry.pendingRevocations,
            {
              deviceId: id,
              publicKey: device.publicKey,
              revokedAt: isoNow(),
              provenAt: isoNow(),
            },
          ],
        };
        await saveRegistry(next);
        return toStatus(next);
      }),

    rotate: (input) =>
      serial(async () => {
        const registry = await requireRegistry();
        const local = registry.head;
        const evidence = registry.conflict;
        const state = unionState([local, ...(evidence ? [evidence] : [])]);
        let maxGeneration = local.current.generation;
        for (const entry of state.generations) {
          if (entry.generation > maxGeneration)
            maxGeneration = entry.generation;
        }
        if (
          state.generations.length >= MAX_HEAD_GENERATIONS ||
          maxGeneration >= MAX_GENERATION
        ) {
          fail('generation_limit');
        }
        const nextGeneration = maxGeneration + 1n;
        const nextSequence =
          (evidence && evidence.sequence > local.sequence
            ? evidence.sequence
            : local.sequence) + 1n;
        if (nextSequence > MAX_GENERATION) fail('generation_limit');
        // Pending local revocations take effect now. Devices two branches
        // enrolled under one ID or key are all revoked: neither claim can be
        // preferred safely, and the user can enroll the right one again.
        const pendingRevocations = registry.pendingRevocations.filter(
          (entry) =>
            !state.revokedDevices.some((device) => sameDevice(device, entry)),
        );
        const active = state.devices.filter(
          (device) =>
            !pendingRevocations.some((entry) => touches(entry, device)),
        );
        const colliding = collidingDevices(active);
        const self = local.devices.find(
          (device) => device.deviceId === registry.deviceId,
        ) as VaultHeadDevice;
        if (colliding.some((device) => touches(device, self))) {
          fail('device_conflict');
        }
        const revokedAt = isoNow();
        const revokedDevices: VaultHeadRevocation[] = [
          ...state.revokedDevices,
          ...[...pendingRevocations, ...colliding].map((entry) => ({
            deviceId: entry.deviceId,
            publicKey: entry.publicKey,
            revokedAt: 'revokedAt' in entry ? entry.revokedAt : revokedAt,
            effectiveGeneration: nextGeneration,
          })),
        ];
        const devices = active.filter((device) => !colliding.includes(device));
        if (
          devices.length > MAX_HEAD_DEVICES ||
          revokedDevices.length > MAX_HEAD_REVOKED_DEVICES
        ) {
          fail('invalid_state');
        }
        const newSecret = input?.newRecoverySecret;
        const effectiveSecret = newSecret ?? input?.recoverySecret;
        await settleAuthority(registry);
        const seed = await authoritySeed(registry, input?.recoverySecret);
        const secret = await deviceSecret(false);
        try {
          let authorityRecord = (await headAuthorityRecord(
            registry,
          )) as Uint8Array;
          if (newSecret !== undefined) {
            authorityRecord = await wrapAuthority(
              seed,
              registry.accountId,
              newSecret,
            );
            await store.set(AUTHORITY_NEXT_ITEM, authorityRecord);
          }
          let pending = registry.pendingRotation;
          if (
            pending &&
            (pending.generation !== nextGeneration ||
              (await store.get(keyItem(pending))) === null ||
              !(await verifyRecoveryRecord(
                registry.accountId,
                pending,
                effectiveSecret,
              )))
          ) {
            pending = null;
          }
          if (!pending) {
            let prepared: Awaited<ReturnType<typeof prepareVaultKeyGeneration>>;
            try {
              prepared = await prepareVaultKeyGeneration({
                accountId: registry.accountId,
                deviceId: registry.deviceId,
                deviceSecret: secret,
                recoverySecret: effectiveSecret as string,
                currentGeneration: nextGeneration - 1n,
              });
            } catch {
              fail('invalid_input');
            }
            pending = {
              generation: prepared.generation,
              keyId: prepared.keyId,
              startedAt: isoNow(),
            };
            // Record the candidate first: a crash after this point leaves
            // the adopted head untouched and the next call resumes or
            // replaces the candidate.
            await saveRegistry({ ...registry, pendingRotation: pending });
            await store.set(keyItem(pending), prepared.deviceRecord);
            await store.set(recoveryItem(pending), prepared.recoveryRecord);
          }
          const candidate = pending;
          const recoveryRecord = await requireItem(recoveryItem(candidate));
          const key = openOwnKey(
            registry,
            secret,
            candidate,
            await requireItem(keyItem(candidate)),
          );
          let commitment: string;
          try {
            commitment = keyCommitment(
              key,
              registry.accountId,
              candidate.generation,
              candidate.keyId,
            );
          } finally {
            key.fill(0);
          }
          let head: VaultHead;
          try {
            head = signHead(
              {
                accountId: registry.accountId,
                sequence: nextSequence,
                issuedAt: isoNow(),
                issuerDeviceId: registry.deviceId,
                current: {
                  generation: candidate.generation,
                  keyId: candidate.keyId,
                },
                generations: [
                  ...state.generations,
                  {
                    generation: candidate.generation,
                    keyId: candidate.keyId,
                    keyCommitment: commitment,
                    recoveryDigest: digestText(recoveryRecord),
                  },
                ],
                devices,
                revokedDevices,
                authorityPublicKey: local.authorityPublicKey,
                authorityRecordDigest: digestText(authorityRecord),
              },
              seed,
            );
          } catch (error) {
            if (error instanceof VaultHeadError) fail('invalid_state');
            throw error;
          }
          const committed: VaultDeviceRegistry = {
            ...registry,
            head,
            conflict: null,
            keys: [
              ...registry.keys,
              { generation: candidate.generation, keyId: candidate.keyId },
            ],
            pendingRevocations: [],
            pendingRotation: null,
          };
          await saveRegistry(committed);
          if (newSecret !== undefined) {
            await store.set(AUTHORITY_ITEM, authorityRecord);
            await store.delete(AUTHORITY_NEXT_ITEM);
          }
          const grants: VaultDeviceGrant[] = [];
          for (const device of head.devices) {
            if (device.deviceId !== committed.deviceId) {
              grants.push(await buildGrant(committed, secret, device, null));
            }
          }
          return {
            generation: candidate.generation,
            keyId: candidate.keyId,
            recoveryRecord,
            head: serializeHead(head),
            authorityRecord,
            grants,
          };
        } finally {
          seed.fill(0);
          secret.fill(0);
        }
      }),

    accountHead: () =>
      serial(async () => {
        const registry = await requireRegistry();
        return {
          head: serializeHead(registry.head),
          authorityRecord: await headAuthorityRecord(registry),
        };
      }),

    recoveryRecord: (input) =>
      serial(async () => {
        const entry = reference(input);
        const registry = await requireRegistry();
        if (!registry.keys.some((held) => sameReference(held, entry))) {
          fail('key_missing');
        }
        return requireItem(recoveryItem(entry));
      }),

    openSealingKey: () =>
      serial(async () => {
        const registry = await requireRegistry();
        if (registry.conflict) fail('generation_conflict');
        if (registry.pendingRevocations.length > 0) fail('rotation_required');
        const current = registry.head.current;
        const secret = await deviceSecret(false);
        try {
          return {
            purpose: 'seal' as const,
            accountId: registry.accountId,
            deviceId: registry.deviceId,
            generation: current.generation,
            keyId: current.keyId,
            key: await openHeldKey(registry, secret, current),
          };
        } finally {
          secret.fill(0);
        }
      }),

    openReadingKey: (input) =>
      serial(async () => {
        const entry = reference(input);
        const registry = await requireRegistry();
        const secret = await deviceSecret(false);
        try {
          return {
            purpose: 'read' as const,
            accountId: registry.accountId,
            generation: entry.generation,
            keyId: entry.keyId,
            key: await openHeldKey(registry, secret, entry),
          };
        } finally {
          secret.fill(0);
        }
      }),
  };
}
