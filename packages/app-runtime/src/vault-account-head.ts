import {
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  type KeyObject,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import { deepFrozenPlainCopy } from './plain-data.js';

/**
 * Signed account heads: the only carrier of account state (current key,
 * key commitments, membership and revocations) between devices.
 *
 * A head is signed by the account authority key, a random Ed25519 seed that
 * a device holds only while the user has entered the recovery secret. A
 * stolen device secret therefore cannot change account state. Every signed
 * or hashed value uses the length-prefixed encoding below with its own
 * domain tag; JSON is only the transport form.
 */

const HEAD_FORMAT = 'smrt-vault-account-head';
const HEAD_VERSION = 1;
const HEAD_BODY_TAG = 'smrt-vault-head-v1';
const HEAD_SIGNATURE_TAG = 'smrt-vault-head-sig-v1';
const KEY_COMMITMENT_TAG = 'smrt-vault-key-commitment-v1';
const AUTHORITY_KEY_ID_TAG = 'smrt-vault-authority-key-id-v1';
const DEVICE_CODE_TAG = 'smrt-vault-device-code-v1';
const ACCOUNT_CODE_TAG = 'smrt-vault-account-code-v1';
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_U64 = (1n << 64n) - 1n;
const KEY_BYTES = 32;
const DIGEST_BYTES = 32;
const SIGNATURE_BYTES = 64;
const KEY_ID = /^[0-9a-f]{32}$/;
const U64_TEXT = /^[1-9][0-9]{0,19}$/;
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const MAX_HEAD_DEVICES = 64;
export const MAX_HEAD_REVOKED_DEVICES = 256;
export const MAX_HEAD_GENERATIONS = 1024;

/** Fork evidence may union two branches' heads. */
export const EVIDENCE_LIMITS = {
  generations: 2 * MAX_HEAD_GENERATIONS,
  devices: 2 * MAX_HEAD_DEVICES,
  revokedDevices: 2 * MAX_HEAD_REVOKED_DEVICES,
};

/** Malformed, oversized or unauthenticated head input. */
export class VaultHeadError extends Error {
  override readonly name = 'VaultHeadError';
  constructor() {
    super('Invalid vault account head');
  }
}

function reject(): never {
  throw new VaultHeadError();
}

export interface VaultHeadGeneration {
  generation: bigint;
  keyId: string;
  /** HKDF commitment to the data key; base64url, 32 bytes. */
  keyCommitment: string;
  /** SHA-256 of the generation's recovery record; base64url. */
  recoveryDigest: string;
}

export interface VaultHeadDevice {
  deviceId: string;
  publicKey: string;
  enrolledAt: string;
}

export interface VaultHeadRevocation {
  deviceId: string;
  publicKey: string;
  revokedAt: string;
  /** First generation the device cannot open. */
  effectiveGeneration: bigint;
}

/** Parsed, verified head. */
export interface VaultHead {
  accountId: string;
  sequence: bigint;
  /** Display-only claims, signed by the authority. */
  issuedAt: string;
  issuerDeviceId: string;
  current: { generation: bigint; keyId: string };
  generations: VaultHeadGeneration[];
  devices: VaultHeadDevice[];
  revokedDevices: VaultHeadRevocation[];
  authorityPublicKey: string;
  authorityRecordDigest: string;
  signature: string;
}

/** JSON-safe transport form of a signed account head. */
export interface VaultAccountHead {
  format: typeof HEAD_FORMAT;
  version: 1;
  accountId: string;
  sequence: string;
  issuedAt: string;
  issuerDeviceId: string;
  current: { generation: string; keyId: string };
  generations: Array<{
    generation: string;
    keyId: string;
    keyCommitment: string;
    recoveryDigest: string;
  }>;
  devices: VaultHeadDevice[];
  revokedDevices: Array<{
    deviceId: string;
    publicKey: string;
    revokedAt: string;
    effectiveGeneration: string;
  }>;
  authorityPublicKey: string;
  authorityRecordDigest: string;
  signature: string;
}

/** Unsigned union of authentic heads from another branch of a fork. */
export interface VaultForkEvidence {
  sequence: bigint;
  generations: VaultHeadGeneration[];
  devices: VaultHeadDevice[];
  revokedDevices: VaultHeadRevocation[];
}

// --- canonical encoding --------------------------------------------------

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function u64(value: bigint): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(value);
  return out;
}

function str(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32(bytes.length), bytes]);
}

function bin(value: Uint8Array): Buffer {
  return Buffer.concat([u32(value.length), Buffer.from(value)]);
}

function b64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Length-prefixed encoding of fields; the first must be a domain tag. */
export function encodeFields(fields: Array<string | bigint | Uint8Array>) {
  return Buffer.concat(
    fields.map((field) =>
      typeof field === 'string'
        ? str(field)
        : typeof field === 'bigint'
          ? u64(field)
          : bin(field),
    ),
  );
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function generationOrder(
  left: VaultHeadGeneration,
  right: VaultHeadGeneration,
) {
  return left.generation !== right.generation
    ? left.generation < right.generation
      ? -1
      : 1
    : compareText(left.keyId, right.keyId);
}

function deviceOrder(
  left: { deviceId: string; publicKey: string },
  right: { deviceId: string; publicKey: string },
) {
  return (
    compareText(left.deviceId, right.deviceId) ||
    compareText(left.publicKey, right.publicKey)
  );
}

type UnsignedHead = Omit<VaultHead, 'signature'>;

function headBody(head: UnsignedHead): Buffer {
  const generations = [...head.generations].sort(generationOrder);
  const devices = [...head.devices].sort(deviceOrder);
  const revoked = [...head.revokedDevices].sort(deviceOrder);
  return Buffer.concat([
    encodeFields([
      HEAD_BODY_TAG,
      head.accountId,
      head.sequence,
      head.issuedAt,
      head.issuerDeviceId,
      head.current.generation,
      head.current.keyId,
    ]),
    u32(generations.length),
    ...generations.map((entry) =>
      encodeFields([
        entry.generation,
        entry.keyId,
        b64(entry.keyCommitment),
        b64(entry.recoveryDigest),
      ]),
    ),
    u32(devices.length),
    ...devices.map((device) =>
      encodeFields([device.deviceId, b64(device.publicKey), device.enrolledAt]),
    ),
    u32(revoked.length),
    ...revoked.map((device) =>
      encodeFields([
        device.deviceId,
        b64(device.publicKey),
        device.revokedAt,
        device.effectiveGeneration,
      ]),
    ),
    encodeFields([
      b64(head.authorityPublicKey),
      b64(head.authorityRecordDigest),
    ]),
  ]);
}

/** Digest that identifies a head; equal digests mean equal heads. */
export function headDigest(head: UnsignedHead): Uint8Array {
  return sha256(headBody(head));
}

// --- authority key -------------------------------------------------------

function authorityPrivateKey(seed: Uint8Array): KeyObject {
  if (!(seed instanceof Uint8Array) || seed.length !== KEY_BYTES) reject();
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  try {
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } finally {
    der.fill(0);
  }
}

/** Ed25519 public key (raw 32 bytes) for an authority seed. */
export function authorityPublicKey(seed: Uint8Array): Uint8Array {
  const der = createPublicKey(authorityPrivateKey(seed)).export({
    format: 'der',
    type: 'spki',
  });
  return new Uint8Array(der.subarray(SPKI_ED25519_PREFIX.length));
}

/** Key ID recorded in the authority's recovery record. */
export function authorityKeyId(publicKey: Uint8Array): string {
  return Buffer.from(sha256(encodeFields([AUTHORITY_KEY_ID_TAG, publicKey])))
    .subarray(0, 16)
    .toString('hex');
}

/** Sign a head body with the authority seed. */
export function signHead(head: UnsignedHead, seed: Uint8Array): VaultHead {
  if (
    Buffer.from(authorityPublicKey(seed)).toString('base64url') !==
    head.authorityPublicKey
  ) {
    reject();
  }
  const signature = sign(
    null,
    Buffer.concat([str(HEAD_SIGNATURE_TAG), headBody(head)]),
    authorityPrivateKey(seed),
  );
  const signed = { ...head, signature: signature.toString('base64url') };
  // Never hand out a head the next parse would reject.
  return parseHead(serializeHead(signed));
}

function verifyHeadSignature(head: VaultHead): boolean {
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, b64(head.authorityPublicKey)]),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.concat([str(HEAD_SIGNATURE_TAG), headBody(head)]),
      publicKey,
      b64(head.signature),
    );
  } catch {
    return false;
  }
}

// --- commitments and codes -----------------------------------------------

/** Commitment that binds a data key to its account, generation and ID. */
export function keyCommitment(
  key: Uint8Array,
  accountId: string,
  generation: bigint,
  keyId: string,
): string {
  return Buffer.from(
    hkdfSync(
      'sha256',
      key,
      Buffer.alloc(0),
      encodeFields([KEY_COMMITMENT_TAG, accountId, generation, keyId]),
      KEY_BYTES,
    ),
  ).toString('base64url');
}

function code(bytes: Uint8Array): string {
  // 60 bits as 12 base32 characters, grouped for reading aloud.
  let bits = 0n;
  for (const byte of bytes.subarray(0, 8)) bits = (bits << 8n) | BigInt(byte);
  bits >>= 4n;
  let text = '';
  for (let index = 11; index >= 0; index -= 1) {
    text += BASE32[Number((bits >> BigInt(index * 5)) & 31n)];
  }
  return `${text.slice(0, 4)}-${text.slice(4, 8)}-${text.slice(8)}`;
}

/** Code the new device shows; the enroller must be given the same code. */
export function deviceCode(request: {
  accountId: string;
  deviceId: string;
  publicKey: string;
  nonce: string;
  expiresAt: string;
}): string {
  return code(
    sha256(
      encodeFields([
        DEVICE_CODE_TAG,
        request.accountId,
        request.deviceId,
        b64(request.publicKey),
        b64(request.nonce),
        request.expiresAt,
      ]),
    ),
  );
}

/** Code the enroller shows; the new device must be given the same code. */
export function accountCode(input: {
  accountId: string;
  authorityPublicKey: string;
  headDigest: Uint8Array;
  devicePublicKey: string;
  nonce: string;
}): string {
  return code(
    sha256(
      encodeFields([
        ACCOUNT_CODE_TAG,
        input.accountId,
        b64(input.authorityPublicKey),
        input.headDigest,
        b64(input.devicePublicKey),
        b64(input.nonce),
      ]),
    ),
  );
}

/** Constant-time comparison of a typed code; case, spaces and dashes ignored. */
export function codesMatch(expected: string, typed: unknown): boolean {
  if (typeof typed !== 'string' || typed.length > 64) return false;
  const normalize = (value: string) =>
    Buffer.from(value.toUpperCase().replace(/[\s-]/g, ''));
  const left = normalize(expected);
  const right = normalize(typed);
  return left.length === right.length && timingSafeEqual(left, right);
}

// --- parsing -------------------------------------------------------------

function plain(value: unknown): Record<string, unknown> {
  let copy: unknown;
  try {
    copy = deepFrozenPlainCopy(value);
  } catch {
    reject();
  }
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) {
    reject();
  }
  return copy as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    LONE_SURROGATE.test(value) ||
    Buffer.byteLength(value) > 255
  ) {
    reject();
  }
  return value;
}

function u64Text(value: unknown): bigint {
  if (typeof value !== 'string' || !U64_TEXT.test(value)) reject();
  const parsed = BigInt(value);
  if (parsed > MAX_U64) reject();
  return parsed;
}

function bytesText(value: unknown, length: number): string {
  if (typeof value !== 'string' || value.length > 128) reject();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) {
    reject();
  }
  return value;
}

function keyIdText(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID.test(value)) reject();
  return value;
}

function timestampText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 32 ||
    Number.isNaN(Date.parse(value))
  ) {
    reject();
  }
  return value;
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) reject();
  return value;
}

export function parseHeadGeneration(value: unknown): VaultHeadGeneration {
  const entry = plain(value);
  return {
    generation: u64Text(entry.generation),
    keyId: keyIdText(entry.keyId),
    keyCommitment: bytesText(entry.keyCommitment, DIGEST_BYTES),
    recoveryDigest: bytesText(entry.recoveryDigest, DIGEST_BYTES),
  };
}

export function parseHeadDevice(value: unknown): VaultHeadDevice {
  const entry = plain(value);
  return {
    deviceId: identifier(entry.deviceId),
    publicKey: bytesText(entry.publicKey, KEY_BYTES),
    enrolledAt: timestampText(entry.enrolledAt),
  };
}

export function parseHeadRevocation(value: unknown): VaultHeadRevocation {
  const entry = plain(value);
  return {
    deviceId: identifier(entry.deviceId),
    publicKey: bytesText(entry.publicKey, KEY_BYTES),
    revokedAt: timestampText(entry.revokedAt),
    effectiveGeneration: u64Text(entry.effectiveGeneration),
  };
}

function generationKey(entry: { generation: bigint; keyId: string }) {
  return `${entry.generation}:${entry.keyId}`;
}

function deviceKey(device: { deviceId: string; publicKey: string }) {
  return `${device.deviceId}\u0000${device.publicKey}`;
}

export interface VaultStateLimits {
  generations: number;
  devices: number;
  revokedDevices: number;
}

export const HEAD_LIMITS: VaultStateLimits = {
  generations: MAX_HEAD_GENERATIONS,
  devices: MAX_HEAD_DEVICES,
  revokedDevices: MAX_HEAD_REVOKED_DEVICES,
};

/**
 * Structural checks shared by heads and fork evidence: unique key entries,
 * active devices distinct by ID and key, revocations unique, and no device
 * both active and revoked. Two branches may revoke one ID under two keys.
 */
export function assertConsistentState(
  state: {
    generations: VaultHeadGeneration[];
    devices: VaultHeadDevice[];
    revokedDevices: VaultHeadRevocation[];
  },
  limits: VaultStateLimits = HEAD_LIMITS,
  /** Fork evidence may hold one ID enrolled differently on two branches. */
  distinctActive = true,
): void {
  if (
    state.generations.length > limits.generations ||
    state.devices.length > limits.devices ||
    state.revokedDevices.length > limits.revokedDevices ||
    new Set(state.generations.map(generationKey)).size !==
      state.generations.length ||
    new Set(state.revokedDevices.map(deviceKey)).size !==
      state.revokedDevices.length ||
    new Set(state.devices.map(deviceKey)).size !== state.devices.length ||
    (distinctActive &&
      (new Set(state.devices.map((device) => device.deviceId)).size !==
        state.devices.length ||
        new Set(state.devices.map((device) => device.publicKey)).size !==
          state.devices.length)) ||
    state.devices.some((device) =>
      state.revokedDevices.some(
        (revoked) =>
          revoked.deviceId === device.deviceId ||
          revoked.publicKey === device.publicKey,
      ),
    )
  ) {
    reject();
  }
}

/** Parse a transport head and verify its authority signature. */
export function parseHead(value: unknown): VaultHead {
  const record = plain(value);
  if (record.format !== HEAD_FORMAT || record.version !== HEAD_VERSION) {
    reject();
  }
  const current = plain(record.current);
  const head: VaultHead = {
    accountId: identifier(record.accountId),
    sequence: u64Text(record.sequence),
    issuedAt: timestampText(record.issuedAt),
    issuerDeviceId: identifier(record.issuerDeviceId),
    current: {
      generation: u64Text(current.generation),
      keyId: keyIdText(current.keyId),
    },
    generations: array(record.generations, MAX_HEAD_GENERATIONS)
      .map(parseHeadGeneration)
      .sort(generationOrder),
    devices: array(record.devices, MAX_HEAD_DEVICES)
      .map(parseHeadDevice)
      .sort(deviceOrder),
    revokedDevices: array(record.revokedDevices, MAX_HEAD_REVOKED_DEVICES)
      .map(parseHeadRevocation)
      .sort(deviceOrder),
    authorityPublicKey: bytesText(record.authorityPublicKey, KEY_BYTES),
    authorityRecordDigest: bytesText(
      record.authorityRecordDigest,
      DIGEST_BYTES,
    ),
    signature: bytesText(record.signature, SIGNATURE_BYTES),
  };
  assertConsistentState(head);
  if (
    !head.generations.some(
      (entry) => generationKey(entry) === generationKey(head.current),
    ) ||
    head.generations.some(
      (entry) => entry.generation > head.current.generation,
    ) ||
    head.revokedDevices.some(
      (device) => device.effectiveGeneration > head.current.generation,
    ) ||
    !head.devices.some((device) => device.deviceId === head.issuerDeviceId) ||
    !verifyHeadSignature(head)
  ) {
    reject();
  }
  return head;
}

export function serializeHead(head: VaultHead): VaultAccountHead {
  return {
    format: HEAD_FORMAT,
    version: HEAD_VERSION,
    accountId: head.accountId,
    sequence: head.sequence.toString(),
    issuedAt: head.issuedAt,
    issuerDeviceId: head.issuerDeviceId,
    current: {
      generation: head.current.generation.toString(),
      keyId: head.current.keyId,
    },
    generations: [...head.generations].sort(generationOrder).map((entry) => ({
      generation: entry.generation.toString(),
      keyId: entry.keyId,
      keyCommitment: entry.keyCommitment,
      recoveryDigest: entry.recoveryDigest,
    })),
    devices: [...head.devices].sort(deviceOrder).map((device) => ({
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      enrolledAt: device.enrolledAt,
    })),
    revokedDevices: [...head.revokedDevices]
      .sort(deviceOrder)
      .map((device) => ({
        deviceId: device.deviceId,
        publicKey: device.publicKey,
        revokedAt: device.revokedAt,
        effectiveGeneration: device.effectiveGeneration.toString(),
      })),
    authorityPublicKey: head.authorityPublicKey,
    authorityRecordDigest: head.authorityRecordDigest,
    signature: head.signature,
  };
}

// --- containment and union -----------------------------------------------

type HeadState = Pick<VaultHead, 'generations' | 'devices' | 'revokedDevices'>;

function sameDevice(
  left: { deviceId: string; publicKey: string },
  right: { deviceId: string; publicKey: string },
) {
  return left.deviceId === right.deviceId && left.publicKey === right.publicKey;
}

/**
 * True when `outer` already reflects everything `inner` says: every key
 * entry identically, every revocation, and every device as active or
 * revoked. A revocation that takes effect no later counts as contained.
 * Heads on one branch always contain their predecessors.
 */
export function containsState(outer: HeadState, inner: HeadState): boolean {
  const entries = new Map(
    outer.generations.map((entry) => [generationKey(entry), entry]),
  );
  return (
    inner.generations.every((entry) => {
      const match = entries.get(generationKey(entry));
      return (
        match !== undefined &&
        match.keyCommitment === entry.keyCommitment &&
        match.recoveryDigest === entry.recoveryDigest
      );
    }) &&
    inner.revokedDevices.every((device) =>
      outer.revokedDevices.some(
        (known) =>
          sameDevice(known, device) &&
          known.effectiveGeneration <= device.effectiveGeneration,
      ),
    ) &&
    inner.devices.every(
      (device) =>
        outer.devices.some((known) => sameDevice(known, device)) ||
        outer.revokedDevices.some((known) => sameDevice(known, device)),
    )
  );
}

/**
 * Union of several authentic states. Revocations remove active devices, and
 * a device revoked on two branches keeps the earlier effective generation,
 * so every merge of the same branches is identical.
 */
export function unionState(states: HeadState[]): HeadState {
  const generations = new Map<string, VaultHeadGeneration>();
  const revoked = new Map<string, VaultHeadRevocation>();
  const devices = new Map<string, VaultHeadDevice>();
  for (const state of states) {
    for (const entry of state.generations) {
      if (!generations.has(generationKey(entry))) {
        generations.set(generationKey(entry), entry);
      }
    }
    for (const device of state.revokedDevices) {
      const known = revoked.get(deviceKey(device));
      if (!known || device.effectiveGeneration < known.effectiveGeneration) {
        revoked.set(deviceKey(device), device);
      }
    }
    for (const device of state.devices) {
      if (!devices.has(deviceKey(device))) {
        devices.set(deviceKey(device), device);
      }
    }
  }
  const revokedList = [...revoked.values()];
  return {
    generations: [...generations.values()].sort(generationOrder),
    revokedDevices: revokedList.sort(deviceOrder),
    devices: [...devices.values()]
      .filter(
        (device) =>
          !revokedList.some(
            (known) =>
              known.deviceId === device.deviceId ||
              known.publicKey === device.publicKey,
          ),
      )
      .sort(deviceOrder),
  };
}

export function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Active devices that share an ID or public key with another active device.
 * Branches can enroll two devices under one ID; a merge revokes them all,
 * because neither branch's claim can be preferred safely.
 */
export function collidingDevices(
  devices: readonly VaultHeadDevice[],
): VaultHeadDevice[] {
  return devices.filter((device) =>
    devices.some(
      (other) =>
        other !== device &&
        (other.deviceId === device.deviceId ||
          other.publicKey === device.publicKey),
    ),
  );
}
