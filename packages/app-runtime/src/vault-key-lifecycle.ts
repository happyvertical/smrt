import { randomBytes } from 'node:crypto';
import { deepFrozenPlainCopy } from './plain-data.js';
import { openVaultDeviceKey, wrapVaultDeviceKey } from './vault-device-key.js';
import {
  deriveVaultDevicePublicKey,
  openVaultDeviceTransfer,
  sealVaultDeviceTransfer,
} from './vault-device-transfer.js';
import { prepareVaultKeyGeneration } from './vault-key-generation.js';
import type { VaultKeyStore } from './vault-key-store.js';
import { openVaultRecoveryKey } from './vault-recovery.js';

export type { VaultKeyStore } from './vault-key-store.js';

const REGISTRY_FORMAT = 'smrt-vault-device-registry';
const REQUEST_FORMAT = 'smrt-vault-enrollment-request';
const GRANT_FORMAT = 'smrt-vault-device-grant';
const FORMAT_VERSION = 1;
const MAX_GENERATION = (1n << 64n) - 1n;
const MAX_DEVICES = 64;
const MAX_REVOKED_DEVICES = 256;
const MAX_GENERATIONS = 256;
const KEY_BYTES = 32;
const KEY_ID = /^[0-9a-f]{32}$/;
const GENERATION_TEXT = /^[1-9][0-9]{0,19}$/;
const LONE_SURROGATE = /[\ud800-\udfff]/u;
const REGISTRY_ITEM = 'registry';
const DEVICE_SECRET_ITEM = 'device-secret';
const ENROLLMENT_ITEM = 'enrollment-request';

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
  | 'rotation_required';

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
  generation_conflict: 'Vault key generation conflicts with local state',
  recovery_rejected: 'Vault recovery secret was rejected',
  rotation_required: 'Vault key rotation is required before encrypting',
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

export interface VaultRegistryGeneration {
  generation: bigint;
  keyId: string;
  status: VaultGenerationStatus;
}

export interface VaultRegistryDevice {
  deviceId: string;
  /** X25519 public key, base64url. Public keys are not secret. */
  publicKey: string;
  /** Latest generation this registry wrapped for the device. */
  generation: bigint;
  keyId: string;
  enrolledAt: string;
}

export interface VaultRevokedDevice {
  deviceId: string;
  publicKey: string;
  revokedAt: string;
  /** First generation the device cannot open; null until a rotation. */
  effectiveGeneration: bigint | null;
}

/** The device's view of its account. It never contains secret material. */
export interface VaultDeviceRegistry {
  accountId: string;
  deviceId: string;
  currentGeneration: bigint;
  generations: VaultRegistryGeneration[];
  devices: VaultRegistryDevice[];
  revokedDevices: VaultRevokedDevice[];
  pendingRotation: {
    generation: bigint;
    keyId: string;
    startedAt: string;
  } | null;
}

export interface VaultKeyLifecycleStatus extends VaultDeviceRegistry {
  currentKeyId: string;
  /** True while a revocation waits for the rotation that makes it effective. */
  rotationRequired: boolean;
}

/** JSON-safe request a new device shows to an enrolled device. */
export interface VaultEnrollmentRequest {
  format: typeof REQUEST_FORMAT;
  version: 1;
  accountId: string;
  deviceId: string;
  publicKey: string;
  /** Single-use pairing secret; send it only over the pairing channel. */
  pairingSecret: string;
}

interface SerializedDevice {
  deviceId: string;
  publicKey: string;
  generation: string;
  keyId: string;
  enrolledAt: string;
}

interface SerializedRevokedDevice {
  deviceId: string;
  publicKey: string;
  revokedAt: string;
  effectiveGeneration: string | null;
}

/** JSON-safe grant that carries sealed data keys to one recipient device. */
export interface VaultDeviceGrant {
  format: typeof GRANT_FORMAT;
  version: 1;
  kind: 'enrollment' | 'update';
  accountId: string;
  senderDeviceId: string;
  senderPublicKey: string;
  recipientDeviceId: string;
  issuedAt: string;
  currentGeneration: string;
  generations: Array<{
    generation: string;
    keyId: string;
    transfer: string;
    recoveryRecord: string;
  }>;
  devices: SerializedDevice[];
  revokedDevices: SerializedRevokedDevice[];
}

export interface VaultCurrentKey {
  accountId: string;
  deviceId: string;
  generation: bigint;
  keyId: string;
  key: Uint8Array;
}

export interface VaultRotationResult {
  generation: bigint;
  keyId: string;
  recoveryRecord: Uint8Array;
  /** One update grant for every other active device. */
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
  }): Promise<{
    generation: bigint;
    keyId: string;
    recoveryRecord: Uint8Array;
  }>;
  createEnrollmentRequest(input: {
    accountId: string;
    deviceId: string;
  }): Promise<VaultEnrollmentRequest>;
  enrollDevice(request: VaultEnrollmentRequest): Promise<VaultDeviceGrant>;
  acceptEnrollment(grant: VaultDeviceGrant): Promise<VaultKeyLifecycleStatus>;
  enrollFromRecovery(input: {
    accountId: string;
    deviceId: string;
    generation: bigint;
    keyId: string;
    recoveryRecord: Uint8Array;
    recoverySecret: string;
  }): Promise<VaultKeyLifecycleStatus>;
  createDeviceGrant(deviceId: string): Promise<VaultDeviceGrant>;
  acceptDeviceGrant(grant: VaultDeviceGrant): Promise<VaultKeyLifecycleStatus>;
  revokeDevice(deviceId: string): Promise<VaultKeyLifecycleStatus>;
  rotate(input: { recoverySecret: string }): Promise<VaultRotationResult>;
  /** Stored recovery record for a held generation, for the caller to publish. */
  recoveryRecord(generation: bigint): Promise<Uint8Array>;
  openCurrentKey(): Promise<VaultCurrentKey>;
  openGenerationKey(
    generation: bigint,
  ): Promise<{ generation: bigint; keyId: string; key: Uint8Array }>;
}

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

function publicKeyText(value: unknown): string {
  if (decodeBytes(value, KEY_BYTES).length !== KEY_BYTES) {
    fail('invalid_input');
  }
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

function parseDevice(value: unknown): VaultRegistryDevice {
  const record = plainRecord(value);
  return {
    deviceId: identifier(record.deviceId),
    publicKey: publicKeyText(record.publicKey),
    generation: parseGeneration(record.generation),
    keyId: keyId(record.keyId),
    enrolledAt: timestamp(record.enrolledAt),
  };
}

function parseRevokedDevice(value: unknown): VaultRevokedDevice {
  const record = plainRecord(value);
  return {
    deviceId: identifier(record.deviceId),
    publicKey: publicKeyText(record.publicKey),
    revokedAt: timestamp(record.revokedAt),
    effectiveGeneration:
      record.effectiveGeneration === null
        ? null
        : parseGeneration(record.effectiveGeneration),
  };
}

function serializeDevice(device: VaultRegistryDevice): SerializedDevice {
  return {
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    generation: device.generation.toString(),
    keyId: device.keyId,
    enrolledAt: device.enrolledAt,
  };
}

function serializeRevokedDevice(
  device: VaultRevokedDevice,
): SerializedRevokedDevice {
  return {
    deviceId: device.deviceId,
    publicKey: device.publicKey,
    revokedAt: device.revokedAt,
    effectiveGeneration: device.effectiveGeneration?.toString() ?? null,
  };
}

function assertDistinctDevices(
  devices: readonly VaultRegistryDevice[],
  revoked: readonly VaultRevokedDevice[],
): void {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const device of [...devices, ...revoked]) {
    if (ids.has(device.deviceId) || keys.has(device.publicKey)) {
      fail('device_conflict');
    }
    ids.add(device.deviceId);
    keys.add(device.publicKey);
  }
}

/** Serialize a registry. The output holds IDs and public keys only. */
export function serializeVaultDeviceRegistry(
  registry: VaultDeviceRegistry,
): string {
  return JSON.stringify({
    format: REGISTRY_FORMAT,
    version: FORMAT_VERSION,
    accountId: registry.accountId,
    deviceId: registry.deviceId,
    currentGeneration: registry.currentGeneration.toString(),
    generations: registry.generations.map((entry) => ({
      generation: entry.generation.toString(),
      keyId: entry.keyId,
      status: entry.status,
    })),
    devices: registry.devices.map(serializeDevice),
    revokedDevices: registry.revokedDevices.map(serializeRevokedDevice),
    pendingRotation: registry.pendingRotation && {
      generation: registry.pendingRotation.generation.toString(),
      keyId: registry.pendingRotation.keyId,
      startedAt: registry.pendingRotation.startedAt,
    },
  });
}

/** Parse and validate a serialized registry. */
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
      record.version !== FORMAT_VERSION
    ) {
      fail('invalid_input');
    }
    const currentGeneration = parseGeneration(record.currentGeneration);
    const generations = list(record.generations, MAX_GENERATIONS).map(
      (value) => {
        const entry = plainRecord(value);
        if (entry.status !== 'current' && entry.status !== 'read-only') {
          fail('invalid_input');
        }
        return {
          generation: parseGeneration(entry.generation),
          keyId: keyId(entry.keyId),
          status: entry.status as VaultGenerationStatus,
        };
      },
    );
    const current = generations.filter((entry) => entry.status === 'current');
    if (
      current.length !== 1 ||
      current[0].generation !== currentGeneration ||
      new Set(generations.map((entry) => entry.generation)).size !==
        generations.length ||
      generations.some((entry) => entry.generation > currentGeneration)
    ) {
      fail('invalid_input');
    }
    let pendingRotation: VaultDeviceRegistry['pendingRotation'] = null;
    if (record.pendingRotation !== null) {
      const pending = plainRecord(record.pendingRotation);
      pendingRotation = {
        generation: parseGeneration(pending.generation),
        keyId: keyId(pending.keyId),
        startedAt: timestamp(pending.startedAt),
      };
    }
    const registry: VaultDeviceRegistry = {
      accountId: identifier(record.accountId),
      deviceId: identifier(record.deviceId),
      currentGeneration,
      generations: generations.sort((left, right) =>
        left.generation < right.generation ? -1 : 1,
      ),
      devices: list(record.devices, MAX_DEVICES).map(parseDevice),
      revokedDevices: list(record.revokedDevices, MAX_REVOKED_DEVICES).map(
        parseRevokedDevice,
      ),
      pendingRotation,
    };
    assertDistinctDevices(registry.devices, registry.revokedDevices);
    if (
      !registry.devices.some((device) => device.deviceId === registry.deviceId)
    ) {
      fail('invalid_input');
    }
    return registry;
  } catch (error) {
    if (error instanceof VaultKeyLifecycleError) fail('invalid_state');
    throw error;
  }
}

function parseGrant(value: unknown): VaultDeviceGrant {
  const record = plainRecord(value);
  if (
    record.format !== GRANT_FORMAT ||
    record.version !== FORMAT_VERSION ||
    (record.kind !== 'enrollment' && record.kind !== 'update')
  ) {
    fail('grant_rejected');
  }
  const generations = list(record.generations, MAX_GENERATIONS).map((value) => {
    const entry = plainRecord(value);
    return {
      generation: parseGeneration(entry.generation).toString(),
      keyId: keyId(entry.keyId),
      transfer: encode(decodeBytes(entry.transfer, 1024)),
      recoveryRecord: encode(decodeBytes(entry.recoveryRecord, 1024)),
    };
  });
  const currentGeneration = parseGeneration(record.currentGeneration);
  if (
    generations.length === 0 ||
    new Set(generations.map((entry) => entry.generation)).size !==
      generations.length ||
    !generations.some(
      (entry) => BigInt(entry.generation) === currentGeneration,
    ) ||
    generations.some((entry) => BigInt(entry.generation) > currentGeneration)
  ) {
    fail('grant_rejected');
  }
  return {
    format: GRANT_FORMAT,
    version: FORMAT_VERSION,
    kind: record.kind,
    accountId: identifier(record.accountId),
    senderDeviceId: identifier(record.senderDeviceId),
    senderPublicKey: publicKeyText(record.senderPublicKey),
    recipientDeviceId: identifier(record.recipientDeviceId),
    issuedAt: timestamp(record.issuedAt),
    currentGeneration: currentGeneration.toString(),
    generations,
    devices: list(record.devices, MAX_DEVICES)
      .map(parseDevice)
      .map(serializeDevice),
    revokedDevices: list(record.revokedDevices, MAX_REVOKED_DEVICES)
      .map(parseRevokedDevice)
      .map(serializeRevokedDevice),
  };
}

function generationItem(prefix: 'key' | 'recovery', generation: bigint) {
  return `${prefix}.${generation.toString()}`;
}

function copyRegistry(registry: VaultDeviceRegistry): VaultDeviceRegistry {
  return parseVaultDeviceRegistry(serializeVaultDeviceRegistry(registry));
}

/**
 * Manage one device's vault keys: enrollment, rotation and revocation.
 *
 * Every secret and wrapped key stays in the injected {@link VaultKeyStore};
 * the registry it keeps alongside holds only IDs, generations and public
 * keys. Operations on one lifecycle object run one at a time; callers that
 * share a store across processes must serialize them (for example under the
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
    await store.set(
      REGISTRY_ITEM,
      new Uint8Array(Buffer.from(serializeVaultDeviceRegistry(registry))),
    );
  }

  async function deviceSecret(create: boolean): Promise<Uint8Array> {
    const existing = await store.get(DEVICE_SECRET_ITEM);
    if (existing !== null) {
      if (existing.length !== KEY_BYTES) fail('invalid_state');
      return existing;
    }
    if (!create) fail('invalid_state');
    const secret = new Uint8Array(randomBytes(KEY_BYTES));
    await store.set(DEVICE_SECRET_ITEM, secret);
    return secret;
  }

  async function requireItem(name: string): Promise<Uint8Array> {
    return (await store.get(name)) ?? fail('invalid_state');
  }

  function keyIdFor(registry: VaultDeviceRegistry, generation: bigint) {
    return registry.generations.find((entry) => entry.generation === generation)
      ?.keyId;
  }

  async function openOwnKey(
    registry: VaultDeviceRegistry,
    secret: Uint8Array,
    generation: bigint,
    expectedKeyId: string,
  ): Promise<Uint8Array> {
    const record = await requireItem(generationItem('key', generation));
    try {
      return openVaultDeviceKey(record, secret, {
        accountId: registry.accountId,
        deviceId: registry.deviceId,
        generation,
        keyId: expectedKeyId,
      });
    } catch {
      fail('invalid_state');
    }
  }

  function toStatus(registry: VaultDeviceRegistry): VaultKeyLifecycleStatus {
    const copy = copyRegistry(registry);
    return {
      ...copy,
      currentKeyId: keyIdFor(copy, copy.currentGeneration) as string,
      rotationRequired: copy.revokedDevices.some(
        (device) => device.effectiveGeneration === null,
      ),
    };
  }

  async function assertUninitialized(): Promise<void> {
    if ((await store.get(REGISTRY_ITEM)) !== null) fail('already_initialized');
  }

  async function buildGrant(
    registry: VaultDeviceRegistry,
    secret: Uint8Array,
    recipient: { deviceId: string; publicKey: string },
    pairingSecret?: Uint8Array,
  ): Promise<VaultDeviceGrant> {
    const senderPublicKey = deriveVaultDevicePublicKey(secret);
    const generations: VaultDeviceGrant['generations'] = [];
    for (const entry of registry.generations) {
      const dataKey = await openOwnKey(
        registry,
        secret,
        entry.generation,
        entry.keyId,
      );
      try {
        generations.push({
          generation: entry.generation.toString(),
          keyId: entry.keyId,
          transfer: encode(
            sealVaultDeviceTransfer(dataKey, secret, {
              accountId: registry.accountId,
              deviceId: recipient.deviceId,
              generation: entry.generation,
              keyId: entry.keyId,
              senderDeviceId: registry.deviceId,
              senderPublicKey,
              recipientPublicKey: decodeBytes(recipient.publicKey, KEY_BYTES),
              pairingSecret,
            }),
          ),
          recoveryRecord: encode(
            await requireItem(generationItem('recovery', entry.generation)),
          ),
        });
      } finally {
        dataKey.fill(0);
      }
    }
    return {
      format: GRANT_FORMAT,
      version: FORMAT_VERSION,
      kind: pairingSecret === undefined ? 'update' : 'enrollment',
      accountId: registry.accountId,
      senderDeviceId: registry.deviceId,
      senderPublicKey: encode(senderPublicKey),
      recipientDeviceId: recipient.deviceId,
      issuedAt: isoNow(),
      currentGeneration: registry.currentGeneration.toString(),
      generations,
      devices: registry.devices.map(serializeDevice),
      revokedDevices: registry.revokedDevices.map(serializeRevokedDevice),
    };
  }

  /** Open every transfer in a grant before anything is written. */
  function openGrant(
    grant: VaultDeviceGrant,
    secret: Uint8Array,
    recipientDeviceId: string,
    pairingSecret?: Uint8Array,
  ) {
    const senderPublicKey = decodeBytes(grant.senderPublicKey, KEY_BYTES);
    const opened: Array<{
      generation: bigint;
      keyId: string;
      key: Uint8Array;
      recoveryRecord: Uint8Array;
    }> = [];
    try {
      for (const entry of grant.generations) {
        const generation = BigInt(entry.generation);
        const key = openVaultDeviceTransfer(
          decodeBytes(entry.transfer, 1024),
          secret,
          {
            accountId: grant.accountId,
            deviceId: recipientDeviceId,
            generation,
            keyId: entry.keyId,
            senderDeviceId: grant.senderDeviceId,
            senderPublicKey,
            pairingSecret,
          },
        );
        opened.push({
          generation,
          keyId: entry.keyId,
          key,
          recoveryRecord: decodeBytes(entry.recoveryRecord, 1024),
        });
      }
      return opened;
    } catch {
      for (const entry of opened) entry.key.fill(0);
      fail('grant_rejected');
    }
  }

  async function storeOpenedKeys(
    registry: Pick<VaultDeviceRegistry, 'accountId' | 'deviceId'>,
    secret: Uint8Array,
    opened: ReturnType<typeof openGrant>,
  ): Promise<void> {
    for (const entry of opened) {
      await store.set(
        generationItem('key', entry.generation),
        wrapVaultDeviceKey(entry.key, secret, {
          accountId: registry.accountId,
          deviceId: registry.deviceId,
          generation: entry.generation,
          keyId: entry.keyId,
        }),
      );
      await store.set(
        generationItem('recovery', entry.generation),
        entry.recoveryRecord,
      );
    }
  }

  async function verifyRecoverySecret(
    registry: VaultDeviceRegistry,
    recoverySecret: string,
    generation: bigint,
    expectedKeyId: string,
  ): Promise<void> {
    const record = await requireItem(generationItem('recovery', generation));
    let recovered: { keyId: string; key: Uint8Array };
    try {
      recovered = await openVaultRecoveryKey(record, recoverySecret, {
        accountId: registry.accountId,
        generation,
      });
    } catch {
      fail('recovery_rejected');
    }
    recovered.key.fill(0);
    if (recovered.keyId !== expectedKeyId) fail('recovery_rejected');
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
        const secret = await deviceSecret(true);
        const prepared = await prepareVaultKeyGeneration({
          accountId,
          deviceId,
          deviceSecret: secret,
          recoverySecret: input.recoverySecret,
          currentGeneration: null,
        });
        await store.set(
          generationItem('key', prepared.generation),
          prepared.deviceRecord,
        );
        await store.set(
          generationItem('recovery', prepared.generation),
          prepared.recoveryRecord,
        );
        const enrolledAt = isoNow();
        await saveRegistry({
          accountId,
          deviceId,
          currentGeneration: prepared.generation,
          generations: [
            {
              generation: prepared.generation,
              keyId: prepared.keyId,
              status: 'current',
            },
          ],
          devices: [
            {
              deviceId,
              publicKey: encode(deriveVaultDevicePublicKey(secret)),
              generation: prepared.generation,
              keyId: prepared.keyId,
              enrolledAt,
            },
          ],
          revokedDevices: [],
          pendingRotation: null,
        });
        return {
          generation: prepared.generation,
          keyId: prepared.keyId,
          recoveryRecord: prepared.recoveryRecord,
        };
      }),

    createEnrollmentRequest: (input) =>
      serial(async () => {
        const accountId = identifier(input?.accountId);
        const deviceId = identifier(input?.deviceId);
        await assertUninitialized();
        const secret = await deviceSecret(true);
        const pairingSecret = new Uint8Array(randomBytes(KEY_BYTES));
        const request: VaultEnrollmentRequest = {
          format: REQUEST_FORMAT,
          version: FORMAT_VERSION,
          accountId,
          deviceId,
          publicKey: encode(deriveVaultDevicePublicKey(secret)),
          pairingSecret: encode(pairingSecret),
        };
        await store.set(
          ENROLLMENT_ITEM,
          new Uint8Array(Buffer.from(JSON.stringify(request))),
        );
        return request;
      }),

    enrollDevice: (request) =>
      serial(async () => {
        const record = plainRecord(request);
        if (
          record.format !== REQUEST_FORMAT ||
          record.version !== FORMAT_VERSION
        ) {
          fail('invalid_input');
        }
        const accountId = identifier(record.accountId);
        const deviceId = identifier(record.deviceId);
        const publicKey = publicKeyText(record.publicKey);
        const pairingSecret = decodeBytes(record.pairingSecret, KEY_BYTES);
        if (pairingSecret.length !== KEY_BYTES) fail('invalid_input');
        const registry = await requireRegistry();
        if (accountId !== registry.accountId) fail('account_mismatch');
        if (
          registry.revokedDevices.some(
            (device) =>
              device.deviceId === deviceId || device.publicKey === publicKey,
          )
        ) {
          fail('device_revoked');
        }
        const existing = registry.devices.find(
          (device) =>
            device.deviceId === deviceId || device.publicKey === publicKey,
        );
        if (
          existing &&
          (existing.deviceId !== deviceId ||
            existing.publicKey !== publicKey ||
            deviceId === registry.deviceId)
        ) {
          fail('device_conflict');
        }
        if (!existing) {
          if (registry.devices.length >= MAX_DEVICES) fail('device_conflict');
          registry.devices.push({
            deviceId,
            publicKey,
            generation: registry.currentGeneration,
            keyId: keyIdFor(registry, registry.currentGeneration) as string,
            enrolledAt: isoNow(),
          });
          await saveRegistry(registry);
        }
        const secret = await deviceSecret(false);
        return buildGrant(
          registry,
          secret,
          { deviceId, publicKey },
          pairingSecret,
        );
      }),

    acceptEnrollment: (input) =>
      serial(async () => {
        await assertUninitialized();
        const grant = parseGrant(input);
        const pending = await store.get(ENROLLMENT_ITEM);
        if (pending === null) fail('invalid_state');
        let request: Record<string, unknown>;
        try {
          request = plainRecord(JSON.parse(Buffer.from(pending).toString()));
        } catch {
          fail('invalid_state');
        }
        const secret = await deviceSecret(false);
        const publicKey = encode(deriveVaultDevicePublicKey(secret));
        if (
          grant.kind !== 'enrollment' ||
          grant.accountId !== request.accountId ||
          grant.recipientDeviceId !== request.deviceId ||
          request.publicKey !== publicKey ||
          grant.senderDeviceId === grant.recipientDeviceId
        ) {
          fail('grant_rejected');
        }
        const opened = openGrant(
          grant,
          secret,
          grant.recipientDeviceId,
          decodeBytes(request.pairingSecret, KEY_BYTES),
        );
        try {
          const devices = grant.devices.map(parseDevice);
          const revokedDevices = grant.revokedDevices.map(parseRevokedDevice);
          const self = devices.find(
            (device) => device.deviceId === grant.recipientDeviceId,
          );
          const sender = devices.find(
            (device) => device.deviceId === grant.senderDeviceId,
          );
          if (
            self?.publicKey !== publicKey ||
            sender?.publicKey !== grant.senderPublicKey
          ) {
            fail('grant_rejected');
          }
          assertDistinctDevices(devices, revokedDevices);
          const currentGeneration = BigInt(grant.currentGeneration);
          const registry: VaultDeviceRegistry = {
            accountId: grant.accountId,
            deviceId: grant.recipientDeviceId,
            currentGeneration,
            generations: opened
              .map((entry) => ({
                generation: entry.generation,
                keyId: entry.keyId,
                status: (entry.generation === currentGeneration
                  ? 'current'
                  : 'read-only') as VaultGenerationStatus,
              }))
              .sort((left, right) =>
                left.generation < right.generation ? -1 : 1,
              ),
            devices,
            revokedDevices: revokedDevices.map((device) => ({
              ...device,
              effectiveGeneration:
                device.effectiveGeneration !== null &&
                device.effectiveGeneration <= currentGeneration
                  ? device.effectiveGeneration
                  : null,
            })),
            pendingRotation: null,
          };
          await storeOpenedKeys(registry, secret, opened);
          await saveRegistry(registry);
          await store.delete(ENROLLMENT_ITEM);
          return toStatus(registry);
        } finally {
          for (const entry of opened) entry.key.fill(0);
        }
      }),

    enrollFromRecovery: (input) =>
      serial(async () => {
        const accountId = identifier(input?.accountId);
        const deviceId = identifier(input?.deviceId);
        const expectedKeyId = keyId(input.keyId);
        if (!isGeneration(input.generation)) fail('invalid_input');
        const generation = input.generation;
        await assertUninitialized();
        let recovered: { keyId: string; key: Uint8Array };
        try {
          recovered = await openVaultRecoveryKey(
            input.recoveryRecord,
            input.recoverySecret,
            { accountId, generation },
          );
        } catch {
          fail('recovery_rejected');
        }
        try {
          if (recovered.keyId !== expectedKeyId) fail('recovery_rejected');
          const secret = await deviceSecret(true);
          await store.set(
            generationItem('key', generation),
            wrapVaultDeviceKey(recovered.key, secret, {
              accountId,
              deviceId,
              generation,
              keyId: expectedKeyId,
            }),
          );
          await store.set(
            generationItem('recovery', generation),
            new Uint8Array(input.recoveryRecord),
          );
          const registry: VaultDeviceRegistry = {
            accountId,
            deviceId,
            currentGeneration: generation,
            generations: [
              { generation, keyId: expectedKeyId, status: 'current' },
            ],
            devices: [
              {
                deviceId,
                publicKey: encode(deriveVaultDevicePublicKey(secret)),
                generation,
                keyId: expectedKeyId,
                enrolledAt: isoNow(),
              },
            ],
            revokedDevices: [],
            pendingRotation: null,
          };
          await saveRegistry(registry);
          await store.delete(ENROLLMENT_ITEM);
          return toStatus(registry);
        } finally {
          recovered.key.fill(0);
        }
      }),

    createDeviceGrant: (deviceId) =>
      serial(async () => {
        const id = identifier(deviceId);
        const registry = await requireRegistry();
        if (registry.revokedDevices.some((device) => device.deviceId === id)) {
          fail('device_revoked');
        }
        const recipient = registry.devices.find(
          (device) => device.deviceId === id,
        );
        if (!recipient || id === registry.deviceId) fail('unknown_device');
        return buildGrant(registry, await deviceSecret(false), recipient);
      }),

    acceptDeviceGrant: (input) =>
      serial(async () => {
        const grant = parseGrant(input);
        const registry = await requireRegistry();
        if (grant.kind !== 'update' || grant.accountId !== registry.accountId) {
          fail('grant_rejected');
        }
        if (
          registry.revokedDevices.some(
            (device) =>
              device.deviceId === grant.senderDeviceId ||
              device.publicKey === grant.senderPublicKey,
          )
        ) {
          fail('device_revoked');
        }
        const sender = registry.devices.find(
          (device) => device.deviceId === grant.senderDeviceId,
        );
        if (
          grant.recipientDeviceId !== registry.deviceId ||
          !sender ||
          sender.deviceId === registry.deviceId ||
          sender.publicKey !== grant.senderPublicKey
        ) {
          fail('grant_rejected');
        }
        const grantRevoked = grant.revokedDevices.map(parseRevokedDevice);
        if (
          grantRevoked.some((device) => device.deviceId === registry.deviceId)
        ) {
          fail('grant_rejected');
        }
        const secret = await deviceSecret(false);
        const opened = openGrant(grant, secret, registry.deviceId);
        try {
          for (const entry of opened) {
            const known = keyIdFor(registry, entry.generation);
            if (known !== undefined && known !== entry.keyId) {
              fail('generation_conflict');
            }
          }
          const fresh = opened.filter(
            (entry) => keyIdFor(registry, entry.generation) === undefined,
          );
          const grantCurrent = BigInt(grant.currentGeneration);
          const currentGeneration =
            grantCurrent > registry.currentGeneration
              ? grantCurrent
              : registry.currentGeneration;
          if (
            registry.pendingRotation &&
            registry.pendingRotation.generation <= currentGeneration
          ) {
            registry.pendingRotation = null;
          }
          await storeOpenedKeys(registry, secret, fresh);
          registry.generations = [
            ...registry.generations,
            ...fresh.map((entry) => ({
              generation: entry.generation,
              keyId: entry.keyId,
              status: 'read-only' as VaultGenerationStatus,
            })),
          ]
            .map((entry) => ({
              ...entry,
              status: (entry.generation === currentGeneration
                ? 'current'
                : 'read-only') as VaultGenerationStatus,
            }))
            .sort((left, right) =>
              left.generation < right.generation ? -1 : 1,
            );
          registry.currentGeneration = currentGeneration;
          for (const revoked of grantRevoked) {
            if (
              registry.revokedDevices.some(
                (device) => device.deviceId === revoked.deviceId,
              )
            ) {
              continue;
            }
            registry.devices = registry.devices.filter(
              (device) => device.deviceId !== revoked.deviceId,
            );
            registry.revokedDevices.push({
              ...revoked,
              effectiveGeneration:
                revoked.effectiveGeneration !== null &&
                revoked.effectiveGeneration <= currentGeneration
                  ? revoked.effectiveGeneration
                  : null,
            });
          }
          const self = registry.devices.find(
            (device) => device.deviceId === registry.deviceId,
          ) as VaultRegistryDevice;
          self.generation = currentGeneration;
          self.keyId = keyIdFor(registry, currentGeneration) as string;
          await saveRegistry(registry);
          return toStatus(registry);
        } finally {
          for (const entry of opened) entry.key.fill(0);
        }
      }),

    revokeDevice: (deviceId) =>
      serial(async () => {
        const id = identifier(deviceId);
        const registry = await requireRegistry();
        if (id === registry.deviceId) fail('device_conflict');
        if (registry.revokedDevices.some((device) => device.deviceId === id)) {
          return toStatus(registry);
        }
        const device = registry.devices.find((entry) => entry.deviceId === id);
        if (!device) fail('unknown_device');
        if (registry.revokedDevices.length >= MAX_REVOKED_DEVICES) {
          fail('invalid_state');
        }
        registry.devices = registry.devices.filter(
          (entry) => entry.deviceId !== id,
        );
        registry.revokedDevices.push({
          deviceId: id,
          publicKey: device.publicKey,
          revokedAt: isoNow(),
          effectiveGeneration: null,
        });
        await saveRegistry(registry);
        return toStatus(registry);
      }),

    rotate: (input) =>
      serial(async () => {
        const registry = await requireRegistry();
        const secret = await deviceSecret(false);
        const recoverySecret = input?.recoverySecret;
        await verifyRecoverySecret(
          registry,
          recoverySecret,
          registry.currentGeneration,
          keyIdFor(registry, registry.currentGeneration) as string,
        );
        const nextGeneration = registry.currentGeneration + 1n;
        let pending = registry.pendingRotation;
        if (pending) {
          try {
            if (pending.generation !== nextGeneration) fail('invalid_state');
            const key = await openOwnKey(
              registry,
              secret,
              pending.generation,
              pending.keyId,
            );
            key.fill(0);
            await verifyRecoverySecret(
              registry,
              recoverySecret,
              pending.generation,
              pending.keyId,
            );
          } catch {
            pending = null;
          }
        }
        if (!pending) {
          const prepared = await prepareVaultKeyGeneration({
            accountId: registry.accountId,
            deviceId: registry.deviceId,
            deviceSecret: secret,
            recoverySecret,
            currentGeneration: registry.currentGeneration,
          });
          pending = {
            generation: prepared.generation,
            keyId: prepared.keyId,
            startedAt: isoNow(),
          };
          // Record the candidate first: a crash after this point leaves the
          // current generation untouched and the next call resumes or
          // replaces the candidate.
          await saveRegistry({ ...registry, pendingRotation: pending });
          await store.set(
            generationItem('key', prepared.generation),
            prepared.deviceRecord,
          );
          await store.set(
            generationItem('recovery', prepared.generation),
            prepared.recoveryRecord,
          );
        }
        const candidate = pending;
        const committed: VaultDeviceRegistry = {
          ...registry,
          currentGeneration: candidate.generation,
          generations: [
            ...registry.generations.map((entry) => ({
              ...entry,
              status: 'read-only' as VaultGenerationStatus,
            })),
            {
              generation: candidate.generation,
              keyId: candidate.keyId,
              status: 'current',
            },
          ],
          devices: registry.devices.map((device) => ({
            ...device,
            generation: candidate.generation,
            keyId: candidate.keyId,
          })),
          revokedDevices: registry.revokedDevices.map((device) => ({
            ...device,
            effectiveGeneration:
              device.effectiveGeneration ?? candidate.generation,
          })),
          pendingRotation: null,
        };
        await saveRegistry(committed);
        const grants: VaultDeviceGrant[] = [];
        for (const device of committed.devices) {
          if (device.deviceId !== committed.deviceId) {
            grants.push(await buildGrant(committed, secret, device));
          }
        }
        return {
          generation: candidate.generation,
          keyId: candidate.keyId,
          recoveryRecord: await requireItem(
            generationItem('recovery', candidate.generation),
          ),
          grants,
        };
      }),

    recoveryRecord: (generation) =>
      serial(async () => {
        if (!isGeneration(generation)) fail('invalid_input');
        const registry = await requireRegistry();
        if (keyIdFor(registry, generation) === undefined) {
          fail('generation_conflict');
        }
        return requireItem(generationItem('recovery', generation));
      }),

    openCurrentKey: () =>
      serial(async () => {
        const registry = await requireRegistry();
        if (
          registry.revokedDevices.some(
            (device) => device.effectiveGeneration === null,
          )
        ) {
          fail('rotation_required');
        }
        const generation = registry.currentGeneration;
        const id = keyIdFor(registry, generation) as string;
        return {
          accountId: registry.accountId,
          deviceId: registry.deviceId,
          generation,
          keyId: id,
          key: await openOwnKey(
            registry,
            await deviceSecret(false),
            generation,
            id,
          ),
        };
      }),

    openGenerationKey: (generation) =>
      serial(async () => {
        if (!isGeneration(generation)) fail('invalid_input');
        const registry = await requireRegistry();
        const id =
          keyIdFor(registry, generation) ?? fail('generation_conflict');
        return {
          generation,
          keyId: id,
          key: await openOwnKey(
            registry,
            await deviceSecret(false),
            generation,
            id,
          ),
        };
      }),
  };
}
