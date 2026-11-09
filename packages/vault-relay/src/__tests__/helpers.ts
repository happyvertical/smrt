import { generateKeyPairSync, type KeyObject, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { exportDevicePublicKey, signRelayRequest } from '../auth.js';
import type { VaultRelayPolicyInput } from '../config.js';
import { sha256Hex } from '../encoding.js';
import { migrateVaultRelayLeasesV1 } from '../lease-store.js';
import { migrateVaultRelayV1, VaultRelayStore } from '../metadata-store.js';
import {
  FilesystemObjectStore,
  type VaultObjectStore,
} from '../object-store.js';
import {
  VaultRelay,
  type VaultRelayEntitlements,
  type VaultRelayLogger,
} from '../relay.js';

export const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef0123456789';
export const BASE = 'http://relay.test';

export interface LogLine {
  level: string;
  event: string;
  fields: Record<string, unknown>;
}

export function captureLogger(): VaultRelayLogger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const push =
    (level: string) =>
    (event: string, fields: Record<string, unknown> = {}) =>
      lines.push({ level, event, fields });
  return {
    lines,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
  };
}

/** Entitlements stub: `backup.vault` is on for the listed tenants only. */
export function stubEntitlements(
  enabled: Set<string>,
): VaultRelayEntitlements & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolver: {
      async explain(_key, context) {
        calls.push(context?.tenantId ?? '');
        return context?.tenantId && enabled.has(context.tenantId)
          ? { enabled: true, decidedBy: 'plan_grant' }
          : { enabled: false, decidedBy: 'default' };
      },
      async findGrantingPlan() {
        return { planKey: 'vault', planId: 'plan-vault', name: 'Vault' };
      },
    },
  };
}

export const DEFAULT_POLICY: VaultRelayPolicyInput = {
  quota: { maxBytes: 1_000_000, maxSnapshots: 4 },
  retention: { keepLast: 3, keepWithinMs: 0 },
  limits: {
    maxChunkBytes: 4096,
    uploadTtlMs: 60_000,
    maxClockSkewMs: 30_000,
    leaseTtlMs: 30_000,
  },
};

export interface Harness {
  relay: VaultRelay;
  db: DatabaseInterface;
  storeRoot: string;
  logger: ReturnType<typeof captureLogger>;
  entitlements: ReturnType<typeof stubEntitlements>;
  clock: { now: number };
  close(): Promise<void>;
}

export async function createHarness(
  options: {
    policy?: VaultRelayPolicyInput;
    entitled?: string[];
    entitlements?: VaultRelayEntitlements;
    /** Wrap the filesystem store, e.g. to interleave a concurrent request. */
    wrapObjects?: (store: VaultObjectStore) => VaultObjectStore;
    /** Build the metadata store, e.g. a subclass that injects a race. */
    createStore?: (db: DatabaseInterface) => VaultRelayStore;
  } = {},
): Promise<Harness> {
  const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
  await migrateVaultRelayV1(db);
  await migrateVaultRelayLeasesV1(db);
  const storeRoot = await mkdtemp(join(tmpdir(), 'vault-relay-'));
  const logger = captureLogger();
  const entitlements = stubEntitlements(
    new Set(options.entitled ?? ['acct-a', 'acct-b']),
  );
  const clock = { now: Date.UTC(2026, 10, 8, 12, 0, 0) };
  const relay = new VaultRelay({
    store: options.createStore?.(db) ?? new VaultRelayStore(db),
    objects: (options.wrapObjects ?? ((store) => store))(
      new FilesystemObjectStore(storeRoot),
    ),
    entitlements: options.entitlements ?? entitlements,
    policy: options.policy ?? DEFAULT_POLICY,
    adminToken: ADMIN_TOKEN,
    logger,
    now: () => clock.now,
  });
  return {
    relay,
    db,
    storeRoot,
    logger,
    entitlements,
    clock,
    async close() {
      await db.close?.();
      await rm(storeRoot, { recursive: true, force: true });
    },
  };
}

export interface TestDevice {
  accountId: string;
  deviceId: string;
  privateKey: KeyObject;
  publicKey: string;
}

export function newDevice(accountId: string, deviceId: string): TestDevice {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    accountId,
    deviceId,
    privateKey,
    publicKey: exportDevicePublicKey(publicKey),
  };
}

export async function registerDevice(
  harness: Harness,
  device: TestDevice,
): Promise<void> {
  const result = await harness.relay.registerDevice(
    device.accountId,
    device.deviceId,
    device.publicKey,
  );
  if (result === 'conflict') throw new Error('device conflict');
}

export interface SignedOptions {
  body?: Uint8Array | string;
  timestamp?: number;
  nonce?: string;
  /** Sign this digest instead of the body's. */
  signedDigest?: string;
  /** Sign as this account instead of the device's own. */
  claimAccount?: string;
  /** Sign this path instead of the requested one. */
  signedPath?: string;
  headers?: Record<string, string>;
}

export function signed(
  harness: Harness,
  device: TestDevice,
  method: string,
  path: string,
  options: SignedOptions = {},
): Request {
  const body =
    typeof options.body === 'string'
      ? new TextEncoder().encode(options.body)
      : options.body;
  const headers = signRelayRequest(
    {
      method,
      pathAndQuery: options.signedPath ?? path,
      accountId: options.claimAccount ?? device.accountId,
      deviceId: device.deviceId,
      timestamp: options.timestamp ?? harness.clock.now,
      nonce: options.nonce ?? randomBytes(18).toString('base64url'),
      contentSha256:
        options.signedDigest ?? sha256Hex(body ?? new Uint8Array()),
    },
    device.privateKey,
  );
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...headers,
      ...(body ? { 'content-length': String(body.length) } : {}),
      ...options.headers,
    },
    ...(body ? { body } : {}),
  });
}

export function adminRequest(
  method: string,
  path: string,
  body?: unknown,
  token = ADMIN_TOKEN,
): Request {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(text
        ? {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(text)),
          }
        : {}),
    },
    ...(text ? { body: text } : {}),
  });
}

/** Account lease state as `GET /v1/lease` reports it. */
export interface LeaseStatusBody {
  holder: string | null;
  expiresAt: string | null;
  headSequence: number;
  latestCommittedSequence: number;
  headIsHole: boolean;
}

export async function leaseStatus(
  harness: Harness,
  device: TestDevice,
): Promise<LeaseStatusBody> {
  const response = await harness.relay.handle(
    signed(harness, device, 'GET', '/v1/lease'),
  );
  return (await response.json()) as LeaseStatusBody;
}

export function acquireRequest(
  harness: Harness,
  device: TestDevice,
  baseSequence: number,
  extra: Record<string, unknown> = {},
): Request {
  return signed(harness, device, 'POST', '/v1/lease/acquire', {
    body: JSON.stringify({ baseSequence, ...extra }),
  });
}

/**
 * Acquire the lease as a device that is at the account's head (as if it had
 * just restored latest) and return the fencing token.
 */
export async function leaseToken(
  harness: Harness,
  device: TestDevice,
): Promise<number> {
  const status = await leaseStatus(harness, device);
  const base = status.headIsHole
    ? status.latestCommittedSequence
    : status.headSequence;
  const response = await harness.relay.handle(
    acquireRequest(harness, device, base),
  );
  if (response.status !== 200) {
    throw new Error(
      `lease refused: ${response.status} ${await response.text()}`,
    );
  }
  return ((await response.json()) as { fencingToken: number }).fencingToken;
}

/**
 * Upload `blob` as `sequence` in `chunkSize` pieces and commit it. Returns the
 * commit response. Without `fencingToken` the device first takes the lease
 * at the head.
 */
export async function uploadSnapshot(
  harness: Harness,
  device: TestDevice,
  sequence: number,
  blob: Uint8Array,
  chunkSize = 4096,
  fencingToken?: number,
): Promise<Response> {
  const token = fencingToken ?? (await leaseToken(harness, device));
  const begin = await harness.relay.handle(
    signed(harness, device, 'POST', '/v1/uploads', {
      body: JSON.stringify({
        fencingToken: token,
        sequence,
        byteSize: blob.length,
        chunkSize,
        sha256: sha256Hex(blob),
      }),
    }),
  );
  if (begin.status !== 201) return begin;
  const { uploadId, chunkCount } = (await begin.json()) as {
    uploadId: string;
    chunkCount: number;
  };
  for (let index = 0; index < chunkCount; index++) {
    const piece = blob.subarray(index * chunkSize, (index + 1) * chunkSize);
    const put = await harness.relay.handle(
      signed(
        harness,
        device,
        'PUT',
        `/v1/uploads/${uploadId}/chunks/${index}`,
        { body: piece },
      ),
    );
    if (put.status !== 200) return put;
  }
  return harness.relay.handle(
    signed(harness, device, 'POST', `/v1/uploads/${uploadId}/commit`),
  );
}

export async function downloadSnapshot(
  harness: Harness,
  device: TestDevice,
  sequence: number,
): Promise<Uint8Array> {
  const meta = await harness.relay.handle(
    signed(harness, device, 'GET', `/v1/snapshots/${sequence}`),
  );
  const { chunkCount } = (await meta.json()) as { chunkCount: number };
  const parts: Uint8Array[] = [];
  for (let index = 0; index < chunkCount; index++) {
    const response = await harness.relay.handle(
      signed(
        harness,
        device,
        'GET',
        `/v1/snapshots/${sequence}/chunks/${index}`,
      ),
    );
    parts.push(new Uint8Array(await response.arrayBuffer()));
  }
  return new Uint8Array(Buffer.concat(parts));
}
