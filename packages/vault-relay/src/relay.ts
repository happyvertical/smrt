/**
 * The blind snapshot relay: a per-account, versioned store of encrypted
 * snapshot blobs. It never parses, decrypts, or validates blob content and
 * holds no key material; it sees sizes, dates, sequences, and ciphertext
 * digests only.
 *
 * Two fetch-style handlers:
 * - {@link VaultRelay.handle} serves devices. Every `/v1` route requires a
 *   device signature and then the `backup.vault` entitlement.
 * - {@link VaultRelay.handleAdmin} serves the operator and the account layer
 *   (bearer token): device registration and revocation, sizes and dates,
 *   usage repair, and the expiry sweep. Serve it on a private listener.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  FEATURE_BACKUP_VAULT,
  type FeatureGrantSource,
  type FeatureResolver,
  FeatureUnavailableError,
  requireFeature,
} from '@happyvertical/smrt-features';
import {
  importDevicePublicKey,
  parseSignatureHeaders,
  verifySignature,
} from './auth.js';
import {
  MAX_CHUNKS_PER_SNAPSHOT,
  MAX_JSON_BODY_BYTES,
  resolvePolicy,
  type VaultRelayPolicy,
  type VaultRelayPolicyInput,
} from './config.js';
import {
  accountHandle,
  EMPTY_SHA256,
  isIdentifier,
  isSha256Hex,
  isUploadId,
  parseCanonicalInteger,
  sha256Hex,
} from './encoding.js';
import { type LeaseRefusal, LeaseService } from './lease.js';
import {
  VAULT_RELAY_LEASE_TABLES,
  VaultRelayLeaseStore,
} from './lease-store.js';
import type {
  AccountUsage,
  DeviceRecord,
  SnapshotRecord,
  VaultRelayStore,
} from './metadata-store.js';
import { chunkObjectKey, type VaultObjectStore } from './object-store.js';

/** Structured log sink. Fields never carry blob bytes or secrets. */
export interface VaultRelayLogger {
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
  error(
    event: string,
    fields?: Record<string, string | number | boolean>,
  ): void;
}

/** JSON-lines logger on stdout/stderr. */
export const jsonLineLogger: VaultRelayLogger = {
  info: (event, fields) =>
    process.stdout.write(
      `${JSON.stringify({ level: 'info', event, ...fields })}\n`,
    ),
  warn: (event, fields) =>
    process.stdout.write(
      `${JSON.stringify({ level: 'warn', event, ...fields })}\n`,
    ),
  error: (event, fields) =>
    process.stderr.write(
      `${JSON.stringify({ level: 'error', event, ...fields })}\n`,
    ),
};

/** How the relay resolves an account's `backup.vault` entitlement. */
export interface VaultRelayEntitlements {
  /** Feature resolver over the platform's feature and subscription data. */
  resolver: Pick<FeatureResolver, 'explain' | 'findGrantingPlan'>;
  /**
   * Request-scoped plan grant source (for example a fresh
   * `SubscriptionFeatureSource`). Omitted means the resolver's own source.
   */
  grantSource?: () =>
    | FeatureGrantSource
    | null
    | undefined
    | Promise<FeatureGrantSource | null | undefined>;
  /**
   * Tenant whose entitlements govern the account. Defaults to the account id
   * itself: a relay account is a hosted SMRT tenant.
   */
  tenantForAccount?: (accountId: string) => string;
}

export interface VaultRelayOptions {
  store: VaultRelayStore;
  /** Primary-writer lease store; defaults to one over `store.db`. */
  leaseStore?: VaultRelayLeaseStore;
  objects: VaultObjectStore;
  entitlements: VaultRelayEntitlements;
  policy: VaultRelayPolicyInput;
  /**
   * Operator bearer token for {@link VaultRelay.handleAdmin}. Only its hash is
   * retained. Without it every admin route answers 404.
   */
  adminToken?: string;
  logger?: VaultRelayLogger;
  now?: () => number;
}

/** Operator view of one account: sizes, dates, and device state, no content. */
export interface OperatorAccountView {
  usage: AccountUsage | null;
  snapshots: Array<{
    sequence: number;
    status: SnapshotRecord['status'];
    byteSize: number;
    chunkCount: number;
    sha256: string;
    createdAt: string;
    committedAt: string | null;
  }>;
  devices: Array<{
    deviceId: string;
    status: DeviceRecord['status'];
    registeredAt: string;
    revokedAt: string | null;
  }>;
  /** The account that replaced this one (#4817), if the account layer set it. */
  supersededBy: string | null;
}

class RelayError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown> | undefined;

  constructor(status: number, code: string, detail?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

const NONCE_PRUNE_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 100;

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function errorResponse(error: RelayError): Response {
  return json(error.status, { error: error.code, ...error.detail });
}

/** Content-Length as a safe integer, `null` when absent, error when bad. */
function declaredLength(request: Request): number | null {
  const header = request.headers.get('content-length');
  if (header === null) return null;
  const parsed = parseCanonicalInteger(header.trim());
  if (parsed === null) throw new RelayError(400, 'invalid_content_length');
  return parsed;
}

/**
 * Read the request body into one buffer of at most `max` bytes, allocated up
 * front from the declared length. Bodies without a Content-Length, or longer
 * than declared, are refused before anything beyond `max` is buffered.
 */
async function readBoundedBody(
  request: Request,
  max: number,
  exact?: number,
): Promise<Uint8Array> {
  const length = declaredLength(request);
  if (length === null) {
    if (request.body === null) return new Uint8Array(0);
    throw new RelayError(411, 'length_required');
  }
  if (length > max) throw new RelayError(413, 'body_too_large');
  if (exact !== undefined && length !== exact) {
    throw new RelayError(400, 'unexpected_body_length', { expected: exact });
  }
  const buffer = new Uint8Array(length);
  if (request.body === null) {
    if (length !== 0) throw new RelayError(400, 'body_length_mismatch');
    return buffer;
  }
  let offset = 0;
  const reader = request.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > length) {
        throw new RelayError(400, 'body_length_mismatch');
      }
      buffer.set(value, offset);
      offset += value.length;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== length) throw new RelayError(400, 'body_length_mismatch');
  return buffer;
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new RelayError(400, 'invalid_json');
}

function positiveSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RelayError(400, 'invalid_request', { field });
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RelayError(400, 'invalid_request', { field });
  }
  return value;
}

/** Optional `ttlSeconds` of a lease request, in milliseconds. */
function requestedTtlMs(input: Record<string, unknown>): number | undefined {
  if (input.ttlSeconds === undefined) return undefined;
  return positiveSafeInteger(input.ttlSeconds, 'ttlSeconds') * 1000;
}

function refusalError(refusal: LeaseRefusal): RelayError {
  const { error, ...detail } = refusal;
  return new RelayError(409, error, detail);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function snapshotView(record: SnapshotRecord) {
  return {
    sequence: record.sequence,
    byteSize: record.byteSize,
    chunkSize: record.chunkSize,
    chunkCount: record.chunkCount,
    sha256: record.sha256,
    deviceId: record.deviceId,
    createdAt: iso(record.createdAt),
    committedAt: record.committedAt === null ? null : iso(record.committedAt),
  };
}

function expectedChunkBytes(record: SnapshotRecord, index: number): number {
  return index < record.chunkCount - 1
    ? record.chunkSize
    : record.byteSize - record.chunkSize * (record.chunkCount - 1);
}

type DeviceRoute =
  | { name: 'lease-status' }
  | { name: 'lease-acquire' }
  | { name: 'lease-renew' }
  | { name: 'lease-release' }
  | { name: 'list' }
  | { name: 'latest' }
  | { name: 'snapshot'; sequence: number }
  | { name: 'chunk'; sequence: number; index: number }
  | { name: 'begin' }
  | { name: 'upload-chunk'; uploadId: string; index: number }
  | { name: 'commit'; uploadId: string }
  | { name: 'abort'; uploadId: string };

const SEQUENCE = '(0|[1-9][0-9]{0,15})';
const INDEX = '(0|[1-9][0-9]{0,5})';
const UPLOAD = '([0-9a-f-]{36})';

const SNAPSHOT_PATH = new RegExp(`^/v1/snapshots/${SEQUENCE}$`);
const SNAPSHOT_CHUNK_PATH = new RegExp(
  `^/v1/snapshots/${SEQUENCE}/chunks/${INDEX}$`,
);
const UPLOAD_CHUNK_PATH = new RegExp(`^/v1/uploads/${UPLOAD}/chunks/${INDEX}$`);
const UPLOAD_COMMIT_PATH = new RegExp(`^/v1/uploads/${UPLOAD}/commit$`);
const UPLOAD_PATH = new RegExp(`^/v1/uploads/${UPLOAD}$`);

function only(
  method: string,
  allowed: readonly string[],
  route: DeviceRoute,
): DeviceRoute | null {
  return allowed.includes(method) ? route : null;
}

function matchDeviceRoute(method: string, path: string): DeviceRoute | null {
  if (path === '/v1/lease') {
    return only(method, ['GET'], { name: 'lease-status' });
  }
  if (path === '/v1/lease/acquire') {
    return only(method, ['POST'], { name: 'lease-acquire' });
  }
  if (path === '/v1/lease/renew') {
    return only(method, ['POST'], { name: 'lease-renew' });
  }
  if (path === '/v1/lease/release') {
    return only(method, ['POST'], { name: 'lease-release' });
  }
  if (path === '/v1/snapshots') return only(method, ['GET'], { name: 'list' });
  if (path === '/v1/snapshots/latest') {
    return only(method, ['GET'], { name: 'latest' });
  }
  if (path === '/v1/uploads') return only(method, ['POST'], { name: 'begin' });

  const snapshot = SNAPSHOT_PATH.exec(path);
  if (snapshot) {
    const sequence = Number(snapshot[1]);
    if (!Number.isSafeInteger(sequence)) return null;
    return only(method, ['GET', 'DELETE'], { name: 'snapshot', sequence });
  }
  const chunk = SNAPSHOT_CHUNK_PATH.exec(path);
  if (chunk) {
    const sequence = Number(chunk[1]);
    if (!Number.isSafeInteger(sequence)) return null;
    return only(method, ['GET'], {
      name: 'chunk',
      sequence,
      index: Number(chunk[2]),
    });
  }
  const uploadChunk = UPLOAD_CHUNK_PATH.exec(path);
  if (uploadChunk) {
    if (!isUploadId(uploadChunk[1])) return null;
    return only(method, ['PUT'], {
      name: 'upload-chunk',
      uploadId: uploadChunk[1],
      index: Number(uploadChunk[2]),
    });
  }
  const commit = UPLOAD_COMMIT_PATH.exec(path);
  if (commit) {
    if (!isUploadId(commit[1])) return null;
    return only(method, ['POST'], { name: 'commit', uploadId: commit[1] });
  }
  const upload = UPLOAD_PATH.exec(path);
  if (upload) {
    if (!isUploadId(upload[1])) return null;
    return only(method, ['DELETE'], { name: 'abort', uploadId: upload[1] });
  }
  return null;
}

interface AuthenticatedDevice {
  accountId: string;
  deviceId: string;
  handle: string;
  contentSha256: string;
}

export class VaultRelay {
  readonly policy: VaultRelayPolicy;
  private readonly store: VaultRelayStore;
  private readonly leaseStore: VaultRelayLeaseStore;
  private readonly leases: LeaseService;
  private readonly objects: VaultObjectStore;
  private readonly entitlements: VaultRelayEntitlements;
  private readonly adminTokenHash: Buffer | null;
  private readonly logger: VaultRelayLogger;
  private readonly now: () => number;
  private lastNoncePrune = 0;

  constructor(options: VaultRelayOptions) {
    this.policy = resolvePolicy(options.policy);
    this.store = options.store;
    this.leaseStore =
      options.leaseStore ?? new VaultRelayLeaseStore(options.store.db);
    this.leases = new LeaseService(
      this.leaseStore,
      this.policy.limits.leaseTtlMs,
    );
    this.objects = options.objects;
    this.entitlements = options.entitlements;
    if (options.adminToken !== undefined && options.adminToken.length < 32) {
      throw new Error(
        'vault relay: the admin token must be at least 32 characters',
      );
    }
    this.adminTokenHash = options.adminToken
      ? createHash('sha256').update(options.adminToken).digest()
      : null;
    this.logger = options.logger ?? jsonLineLogger;
    this.now = options.now ?? Date.now;
  }

  // Health ------------------------------------------------------------------

  /** Readiness: schema migrated and object store reachable. */
  async ready(): Promise<{ ready: boolean; reason?: string }> {
    try {
      const missing = await this.store.missingTables();
      for (const table of VAULT_RELAY_LEASE_TABLES) {
        if (!(await this.store.db.tableExists(table))) missing.push(table);
      }
      if (missing.length > 0) return { ready: false, reason: 'schema_missing' };
      await this.objects.check();
      return { ready: true };
    } catch (error) {
      this.logger.warn('readiness_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return { ready: false, reason: 'dependency_unavailable' };
    }
  }

  private async health(path: string): Promise<Response | null> {
    if (path === '/healthz') return json(200, { status: 'ok' });
    if (path === '/readyz') {
      const result = await this.ready();
      return json(result.ready ? 200 : 503, {
        status: result.ready ? 'ready' : 'not_ready',
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
    return null;
  }

  // Device API --------------------------------------------------------------

  /** Device-facing handler (public listener). */
  async handle(request: Request): Promise<Response> {
    const started = this.now();
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    let route: DeviceRoute | null = null;
    let handle: string | undefined;
    let response: Response;
    try {
      if (method === 'GET') {
        const health = await this.health(url.pathname);
        if (health) return health;
      }
      route = matchDeviceRoute(method, url.pathname);
      if (!route) throw new RelayError(404, 'not_found');
      const device = await this.authenticate(
        request,
        method,
        `${url.pathname}${url.search}`,
      );
      handle = device.handle;
      await this.refuseSuperseded(route, request.method, device.accountId);
      await this.requireEntitlement(device.accountId);
      response = await this.dispatch(route, request, device);
    } catch (error) {
      response = this.toErrorResponse(error, handle);
    }
    this.logger.info('request', {
      route: route?.name ?? 'unmatched',
      method,
      status: response.status,
      ms: this.now() - started,
      ...(handle ? { account: handle } : {}),
    });
    return response;
  }

  private toErrorResponse(error: unknown, handle?: string): Response {
    if (error instanceof RelayError) return errorResponse(error);
    if (error instanceof FeatureUnavailableError) return error.toResponse();
    this.logger.error('request_failed', {
      error: error instanceof Error ? error.name : 'unknown',
      ...(handle ? { account: handle } : {}),
    });
    return json(500, { error: 'internal_error' });
  }

  private async authenticate(
    request: Request,
    method: string,
    pathAndQuery: string,
  ): Promise<AuthenticatedDevice> {
    const parsed = parseSignatureHeaders(method, pathAndQuery, request.headers);
    // One answer for every authentication failure: no oracle for which
    // accounts or devices exist, or whether a device was revoked.
    const denied = new RelayError(401, 'unauthorized');
    if (!parsed) throw denied;
    const now = this.now();
    const skew = this.policy.limits.maxClockSkewMs;
    if (Math.abs(now - parsed.fields.timestamp) > skew) throw denied;
    const device = await this.store.getDevice(
      parsed.fields.accountId,
      parsed.fields.deviceId,
    );
    if (device?.status !== 'active') throw denied;
    const key = importDevicePublicKey(device.publicKey);
    if (!key || !verifySignature(parsed, key)) throw denied;
    await this.pruneNoncesIfDue(now);
    const fresh = await this.store.consumeNonce(
      parsed.fields.accountId,
      parsed.fields.deviceId,
      parsed.fields.nonce,
      parsed.fields.timestamp + skew + 1,
    );
    if (!fresh) throw denied;
    return {
      accountId: parsed.fields.accountId,
      deviceId: parsed.fields.deviceId,
      handle: accountHandle(parsed.fields.accountId),
      contentSha256: parsed.fields.contentSha256,
    };
  }

  /**
   * An account the account layer replaced (#4817) takes no new writes and
   * offers no snapshot to restore-latest: its devices would publish into a
   * data line nobody follows, and a restore would hand back the old vault.
   * Lease status answers it too: that refusal is how a device proves, before
   * it follows the new account, that the old one was replaced. What only
   * removes state (lease release, aborting an upload) and reads by explicit
   * sequence stay open. The refusal names no other
   * account: the client never follows the relay to a new account.
   */
  private async refuseSuperseded(
    route: DeviceRoute,
    method: string,
    accountId: string,
  ): Promise<void> {
    const open =
      route.name === 'lease-release' ||
      route.name === 'abort' ||
      route.name === 'chunk' ||
      (route.name === 'snapshot' && method.toUpperCase() === 'GET');
    if (open) return;
    if (await this.store.getSupersession(accountId)) {
      throw new RelayError(409, 'account_superseded');
    }
  }

  private async pruneNoncesIfDue(now: number): Promise<void> {
    if (now - this.lastNoncePrune < NONCE_PRUNE_INTERVAL_MS) return;
    this.lastNoncePrune = now;
    await this.store.pruneNonces(now);
  }

  /** The `backup.vault` gate, resolved server-side for the account's tenant. */
  private async requireEntitlement(accountId: string): Promise<void> {
    const tenantId =
      this.entitlements.tenantForAccount?.(accountId) ?? accountId;
    try {
      const grantSource = this.entitlements.grantSource
        ? await this.entitlements.grantSource()
        : undefined;
      await requireFeature(FEATURE_BACKUP_VAULT, {
        resolver: this.entitlements.resolver,
        tenantId,
        ...(grantSource !== undefined ? { grantSource } : {}),
      });
    } catch (error) {
      if (error instanceof FeatureUnavailableError) throw error;
      // Fail closed: an entitlement lookup that cannot complete denies.
      this.logger.error('entitlement_check_failed', {
        error: error instanceof Error ? error.name : 'unknown',
        account: accountHandle(accountId),
      });
      throw new RelayError(503, 'entitlement_unavailable');
    }
  }

  /** Reject a body on a route that takes none, and bind the empty digest. */
  private async requireEmptyBody(
    request: Request,
    device: AuthenticatedDevice,
  ): Promise<void> {
    const body = await readBoundedBody(request, 0);
    if (body.length !== 0) throw new RelayError(400, 'unexpected_body');
    if (device.contentSha256 !== EMPTY_SHA256) {
      throw new RelayError(400, 'content_digest_mismatch');
    }
  }

  /** A bounded JSON body whose digest is the signed one. */
  private async readJson(
    request: Request,
    device: AuthenticatedDevice,
  ): Promise<Record<string, unknown>> {
    const body = await readBoundedBody(request, MAX_JSON_BODY_BYTES);
    if (sha256Hex(body) !== device.contentSha256) {
      throw new RelayError(400, 'content_digest_mismatch');
    }
    return parseJsonObject(body);
  }

  private async dispatchLease(
    route: DeviceRoute,
    request: Request,
    device: AuthenticatedDevice,
  ): Promise<Response> {
    const now = this.now();
    if (route.name === 'lease-status') {
      await this.requireEmptyBody(request, device);
      const status = await this.leases.status(device.accountId, now);
      return json(200, {
        ...status,
        expiresAt: status.expiresAt === null ? null : iso(status.expiresAt),
      });
    }
    const input = await this.readJson(request, device);
    if (route.name === 'lease-acquire') {
      const result = await this.leases.acquire(
        device.accountId,
        device.deviceId,
        nonNegativeSafeInteger(input.baseSequence, 'baseSequence'),
        requestedTtlMs(input),
        now,
      );
      if (!result.ok) throw refusalError(result.refusal);
      return json(200, {
        fencingToken: result.grant.fencingToken,
        expiresAt: iso(result.grant.expiresAt),
        ttlMs: result.grant.expiresAt - now,
        headSequence: result.grant.headSequence,
      });
    }
    const fencingToken = positiveSafeInteger(
      input.fencingToken,
      'fencingToken',
    );
    if (route.name === 'lease-renew') {
      const result = await this.leases.renew(
        device.accountId,
        device.deviceId,
        fencingToken,
        requestedTtlMs(input),
        now,
      );
      if (!result.ok) throw refusalError(result.refusal);
      return json(200, {
        fencingToken: result.grant.fencingToken,
        expiresAt: iso(result.grant.expiresAt),
        ttlMs: result.grant.expiresAt - now,
        headSequence: result.grant.headSequence,
      });
    }
    await this.leases.release(device.accountId, device.deviceId, fencingToken);
    return json(204, null);
  }

  private async dispatch(
    route: DeviceRoute,
    request: Request,
    device: AuthenticatedDevice,
  ): Promise<Response> {
    switch (route.name) {
      case 'lease-status':
      case 'lease-acquire':
      case 'lease-renew':
      case 'lease-release':
        return this.dispatchLease(route, request, device);
      case 'list': {
        await this.requireEmptyBody(request, device);
        const snapshots = await this.store.listSnapshots(
          device.accountId,
          'committed',
        );
        return json(200, { snapshots: snapshots.map(snapshotView) });
      }
      case 'latest': {
        await this.requireEmptyBody(request, device);
        const latest = await this.store.latestCommitted(device.accountId);
        if (!latest) throw new RelayError(404, 'no_snapshot');
        return json(200, snapshotView(latest));
      }
      case 'snapshot': {
        await this.requireEmptyBody(request, device);
        const record = await this.store.getCommitted(
          device.accountId,
          route.sequence,
        );
        if (!record) throw new RelayError(404, 'no_snapshot');
        if (request.method.toUpperCase() === 'DELETE') {
          return this.deleteSnapshotForDevice(record, device);
        }
        return json(200, snapshotView(record));
      }
      case 'chunk':
        await this.requireEmptyBody(request, device);
        return this.downloadChunk(device, route.sequence, route.index);
      case 'begin':
        return this.beginUpload(request, device);
      case 'upload-chunk':
        return this.uploadChunk(request, device, route.uploadId, route.index);
      case 'commit':
        await this.requireEmptyBody(request, device);
        return this.commitUpload(device, route.uploadId);
      case 'abort': {
        await this.requireEmptyBody(request, device);
        const record = await this.store.getByUpload(
          device.accountId,
          route.uploadId,
        );
        if (record?.status !== 'pending') {
          throw new RelayError(404, 'no_upload');
        }
        await this.removeSnapshot(record, device.handle, 'pending');
        return json(204, null);
      }
    }
  }

  private async beginUpload(
    request: Request,
    device: AuthenticatedDevice,
  ): Promise<Response> {
    const input = await this.readJson(request, device);
    const sequence = positiveSafeInteger(input.sequence, 'sequence');
    const fencingToken = positiveSafeInteger(
      input.fencingToken,
      'fencingToken',
    );
    const byteSize = positiveSafeInteger(input.byteSize, 'byteSize');
    const chunkSize = positiveSafeInteger(input.chunkSize, 'chunkSize');
    if (!isSha256Hex(input.sha256)) {
      throw new RelayError(400, 'invalid_request', { field: 'sha256' });
    }
    const { quota, limits } = this.policy;
    if (chunkSize > limits.maxChunkBytes) {
      throw new RelayError(413, 'chunk_too_large', {
        maxChunkBytes: limits.maxChunkBytes,
      });
    }
    if (byteSize > quota.maxBytes) {
      throw new RelayError(413, 'quota_exceeded', {
        maxBytes: quota.maxBytes,
        maxSnapshots: quota.maxSnapshots,
      });
    }
    const chunkCount = Math.ceil(byteSize / chunkSize);
    if (chunkCount > MAX_CHUNKS_PER_SNAPSHOT) {
      throw new RelayError(400, 'too_many_chunks');
    }

    const now = this.now();
    await this.store.ensureAccount(device.accountId, now);
    await this.sweepExpired(now);
    const usage = await this.store.getUsage(device.accountId);
    if (usage && sequence <= usage.highWaterSequence) {
      throw new RelayError(409, 'stale_sequence', {
        highWaterSequence: usage.highWaterSequence,
      });
    }
    // The device picks the sequence and a commit raises the mark for good, so
    // bound the step before reserving anything.
    this.assertSequenceStep(sequence, usage?.highWaterSequence ?? 0);
    // Divergence detection: only the lease holder, at the head, may publish.
    const refused = await this.leases.admitUpload(
      device.accountId,
      device.deviceId,
      fencingToken,
      sequence,
      now,
    );
    if (refused) throw refusalError(refused);
    // Reserve before inserting, so a failure in between can only over-count.
    const reserved = await this.store.reserve(
      device.accountId,
      byteSize,
      quota.maxBytes,
      quota.maxSnapshots,
    );
    if (!reserved) {
      throw new RelayError(413, 'quota_exceeded', {
        maxBytes: quota.maxBytes,
        maxSnapshots: quota.maxSnapshots,
      });
    }
    const uploadId = randomUUID();
    const created = await this.store.createPending({
      accountId: device.accountId,
      sequence,
      uploadId,
      deviceId: device.deviceId,
      byteSize,
      chunkSize,
      chunkCount,
      sha256: input.sha256,
      createdAt: now,
    });
    if (!created) {
      await this.store.release(device.accountId, byteSize);
      const latest = await this.store.getUsage(device.accountId);
      if (latest && sequence <= latest.highWaterSequence) {
        throw new RelayError(409, 'stale_sequence', {
          highWaterSequence: latest.highWaterSequence,
        });
      }
      throw new RelayError(409, 'sequence_exists');
    }
    await this.leaseStore.recordFence(device.accountId, uploadId, fencingToken);
    return json(201, {
      uploadId,
      sequence,
      byteSize,
      chunkSize,
      chunkCount,
      expiresAt: iso(now + limits.uploadTtlMs),
    });
  }

  /**
   * A sequence may not jump more than `maxSequenceJump` above the account's
   * high-water mark. Without the bound, one commit at the largest safe
   * integer would make every later upload `stale_sequence` with no way back
   * short of editing the database.
   */
  private assertSequenceStep(sequence: number, highWater: number): void {
    const { maxSequenceJump } = this.policy.limits;
    if (sequence - highWater > maxSequenceJump) {
      throw new RelayError(400, 'sequence_too_far', {
        highWaterSequence: highWater,
        maxSequenceJump,
      });
    }
  }

  private async pendingUpload(
    device: AuthenticatedDevice,
    uploadId: string,
  ): Promise<SnapshotRecord> {
    const record = await this.store.getByUpload(device.accountId, uploadId);
    if (record?.status !== 'pending') {
      throw new RelayError(404, 'no_upload');
    }
    if (this.now() - record.createdAt > this.policy.limits.uploadTtlMs) {
      await this.removeSnapshot(record, device.handle, 'pending');
      throw new RelayError(404, 'no_upload');
    }
    return record;
  }

  private async uploadChunk(
    request: Request,
    device: AuthenticatedDevice,
    uploadId: string,
    index: number,
  ): Promise<Response> {
    const record = await this.pendingUpload(device, uploadId);
    if (index >= record.chunkCount) throw new RelayError(404, 'no_chunk');
    const expected = expectedChunkBytes(record, index);
    const body = await readBoundedBody(
      request,
      this.policy.limits.maxChunkBytes,
      expected,
    );
    const digest = sha256Hex(body);
    if (digest !== device.contentSha256) {
      throw new RelayError(400, 'content_digest_mismatch');
    }
    // Each attempt gets its own object; the row insert below decides which
    // attempt counts, and only while the upload is still pending.
    const objectId = randomBytes(16).toString('hex');
    const key = chunkObjectKey(device.handle, record.uploadId, index, objectId);
    await this.objects.put(key, body);
    const added = await this.store.addChunk(device.accountId, record.uploadId, {
      index,
      byteSize: body.length,
      sha256: digest,
      objectId,
    });
    if (added) {
      // On PostgreSQL the insert's pending check takes no lock, so a removal
      // can commit while the insert is in flight and miss this row. Re-check:
      // either the remover saw the row, or this check sees the upload gone
      // and cleans up, so the object is never left outside quota.
      const parent = await this.store.getByUpload(
        device.accountId,
        record.uploadId,
      );
      if (!parent) {
        if (
          await this.store.deleteChunkAttempt(record.uploadId, index, objectId)
        ) {
          await this.deleteObject(key, device.handle);
        }
        throw new RelayError(404, 'no_upload');
      }
    } else {
      await this.deleteObject(key, device.handle);
      const existing = await this.store.getChunk(record.uploadId, index);
      const current = await this.store.getByUpload(
        device.accountId,
        record.uploadId,
      );
      // A retry of the same bytes is idempotent; anything else is refused.
      if (existing?.sha256 !== digest || current?.status !== 'pending') {
        throw new RelayError(
          current?.status === 'pending' ? 409 : 404,
          current?.status === 'pending' ? 'chunk_exists' : 'no_upload',
        );
      }
    }
    return json(200, { index, byteSize: body.length, sha256: digest });
  }

  private async commitUpload(
    device: AuthenticatedDevice,
    uploadId: string,
  ): Promise<Response> {
    const record = await this.pendingUpload(device, uploadId);
    const chunks = await this.store.listChunks(record.uploadId);
    const complete =
      chunks.length === record.chunkCount &&
      chunks.every(
        (chunk, position) =>
          chunk.index === position &&
          chunk.byteSize === expectedChunkBytes(record, position),
      );
    if (!complete) throw new RelayError(409, 'incomplete_upload');

    // Hash the stored ciphertext, one bounded chunk at a time.
    const whole = createHash('sha256');
    for (const chunk of chunks) {
      const bytes = await this.objects.get(
        chunkObjectKey(
          device.handle,
          record.uploadId,
          chunk.index,
          chunk.objectId,
        ),
      );
      if (!bytes || sha256Hex(bytes) !== chunk.sha256) {
        throw new RelayError(409, 'incomplete_upload');
      }
      whole.update(bytes);
    }
    if (whole.digest('hex') !== record.sha256) {
      throw new RelayError(422, 'snapshot_digest_mismatch');
    }

    // Advance the lease head first, conditional on the holder, the token
    // recorded at begin, and the upload still pending. A publish that lost
    // its lease is refused and discarded: the device must restore first.
    const leaseNow = this.now();
    const fence = await this.leaseStore.getFence(
      device.accountId,
      record.uploadId,
    );
    if (leaseNow - record.createdAt > this.policy.limits.uploadTtlMs) {
      await this.removeSnapshot(record, device.handle, 'pending');
      throw new RelayError(404, 'no_upload');
    }
    if (
      fence === null ||
      !(await this.leaseStore.advanceHead(
        device.accountId,
        device.deviceId,
        record.uploadId,
        fence,
        record.sequence,
        leaseNow,
      ))
    ) {
      const refusal = await this.leases.mustRestore(device.accountId);
      await this.removeSnapshot(record, device.handle, 'pending');
      throw refusalError(refusal);
    }

    if (
      !(await this.store.advanceHighWater(
        device.accountId,
        record.sequence,
        this.policy.limits.maxSequenceJump,
      ))
    ) {
      await this.removeSnapshot(record, device.handle, 'pending');
      const latest = await this.store.getUsage(device.accountId);
      if (latest && record.sequence > latest.highWaterSequence) {
        this.assertSequenceStep(record.sequence, latest.highWaterSequence);
      }
      throw new RelayError(409, 'stale_sequence');
    }
    const now = this.now();
    if (
      !(await this.store.markCommitted(device.accountId, record.uploadId, now))
    ) {
      throw new RelayError(409, 'no_upload');
    }
    await this.leaseStore.deleteFence(record.uploadId);
    await this.applyRetention(device.accountId, device.handle, now);
    const committed = await this.store.getCommitted(
      device.accountId,
      record.sequence,
    );
    return json(
      201,
      committed ? snapshotView(committed) : { sequence: record.sequence },
    );
  }

  /**
   * Device-initiated delete. The account's last committed snapshot is never
   * removable from the device API: a compromised or mistaken device would
   * otherwise erase the only restorable copy. The refusal and every removal
   * are audited by device and sequence; the operator can still act through
   * the admin listener.
   */
  private async deleteSnapshotForDevice(
    record: SnapshotRecord,
    device: AuthenticatedDevice,
  ): Promise<Response> {
    // Below the head and below the latest committed snapshot only (#4805): the
    // head and the last committed snapshot are never deletable here.
    const removed = await this.leaseStore.deleteCommittedBelowHead(
      record.accountId,
      record.uploadId,
    );
    if (!removed) {
      const stillThere = await this.store.getCommitted(
        record.accountId,
        record.sequence,
      );
      if (!stillThere) throw new RelayError(404, 'no_snapshot');
      // Two refusals, one rule (the snapshot is the latest committed one and
      // the lease head): the account's only committed snapshot is
      // `last_snapshot`; the newest of several is `head_snapshot`. Both are
      // audited, and a device or client can tell them apart.
      const committed = await this.store.listSnapshots(
        record.accountId,
        'committed',
      );
      const sole = committed.length <= 1;
      this.logger.warn('snapshot_delete_refused', {
        account: device.handle,
        device: device.deviceId,
        sequence: record.sequence,
        reason: sole ? 'last_committed' : 'head',
      });
      throw new RelayError(409, sole ? 'last_snapshot' : 'head_snapshot', {
        sequence: record.sequence,
      });
    }
    await this.discardRemoved(removed, device.handle);
    this.logger.info('snapshot_deleted', {
      account: device.handle,
      device: device.deviceId,
      sequence: removed.sequence,
    });
    return json(204, null);
  }

  private async downloadChunk(
    device: AuthenticatedDevice,
    sequence: number,
    index: number,
  ): Promise<Response> {
    const record = await this.store.getCommitted(device.accountId, sequence);
    if (!record) throw new RelayError(404, 'no_snapshot');
    const chunk = await this.store.getChunk(record.uploadId, index);
    if (!chunk) throw new RelayError(404, 'no_chunk');
    const bytes = await this.objects.get(
      chunkObjectKey(device.handle, record.uploadId, index, chunk.objectId),
    );
    if (!bytes || sha256Hex(bytes) !== chunk.sha256) {
      this.logger.error('stored_chunk_unreadable', {
        account: device.handle,
        sequence,
        index,
      });
      throw new RelayError(500, 'storage_integrity');
    }
    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'cache-control': 'no-store',
        'x-vault-chunk-sha256': chunk.sha256,
      },
    });
  }

  // Retention and cleanup ----------------------------------------------------

  /**
   * Remove a snapshot or upload while it still has `status`: the row first (so
   * it can never be listed or served half-deleted, and a concurrent publish
   * or abort cannot be undone), then counters, then chunk rows and objects.
   */
  private async removeSnapshot(
    record: SnapshotRecord,
    handle: string,
    status: SnapshotRecord['status'],
  ): Promise<void> {
    const removed = await this.store.deleteSnapshotRow(
      record.accountId,
      record.uploadId,
      status,
    );
    if (!removed) return;
    await this.discardRemoved(removed, handle);
  }

  /** Counters, fence, chunk rows and objects of a snapshot row already deleted. */
  private async discardRemoved(
    removed: SnapshotRecord,
    handle: string,
  ): Promise<void> {
    await this.store.release(removed.accountId, removed.byteSize);
    await this.leaseStore.deleteFence(removed.uploadId);
    const chunks = await this.store.deleteChunks(removed.uploadId);
    for (const chunk of chunks) {
      await this.deleteObject(
        chunkObjectKey(handle, removed.uploadId, chunk.index, chunk.objectId),
        handle,
      );
    }
  }

  private async deleteObject(key: string, handle: string): Promise<void> {
    try {
      await this.objects.delete(key);
    } catch (error) {
      this.logger.warn('object_delete_failed', {
        account: handle,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /** Keep the newest `keepLast` committed snapshots plus any within the window. */
  private async applyRetention(
    accountId: string,
    handle: string,
    now: number,
  ): Promise<void> {
    const { keepLast, keepWithinMs } = this.policy.retention;
    const committed = await this.store.listSnapshots(accountId, 'committed');
    for (const [position, record] of committed.entries()) {
      if (position < keepLast) continue;
      const age = now - (record.committedAt ?? record.createdAt);
      if (age <= keepWithinMs) continue;
      await this.removeSnapshot(record, handle, 'committed');
    }
  }

  /** Abort pending uploads older than the upload TTL; returns how many. */
  async sweepExpired(now: number = this.now()): Promise<number> {
    const stale = await this.store.stalePending(
      now - this.policy.limits.uploadTtlMs,
      SWEEP_BATCH,
    );
    for (const record of stale) {
      await this.removeSnapshot(
        record,
        accountHandle(record.accountId),
        'pending',
      );
    }
    await this.store.pruneNonces(now);
    return stale.length;
  }

  // Account-layer hooks ------------------------------------------------------

  /**
   * Register a device's Ed25519 public key (raw 32 bytes, base64url) for an
   * account. Idempotent for the same key; a revoked device id or a different
   * key under an existing id is a conflict.
   */
  async registerDevice(
    accountId: string,
    deviceId: string,
    publicKey: string,
  ): Promise<'registered' | 'unchanged' | 'conflict'> {
    if (!isIdentifier(accountId) || !isIdentifier(deviceId)) {
      throw new Error('vault relay: invalid account or device id');
    }
    if (!importDevicePublicKey(publicKey)) {
      throw new Error('vault relay: invalid Ed25519 public key');
    }
    const now = this.now();
    await this.store.ensureAccount(accountId, now);
    return this.store.registerDevice(accountId, deviceId, publicKey, now);
  }

  /** Revoke a device; its signatures fail from the next request on. */
  async revokeDevice(accountId: string, deviceId: string): Promise<boolean> {
    if (!isIdentifier(accountId) || !isIdentifier(deviceId)) return false;
    const revoked = await this.store.revokeDevice(
      accountId,
      deviceId,
      this.now(),
    );
    // After the revocation, so an acquire racing it cannot keep the lease;
    // the token bump fences anything recorded under the old token.
    await this.leaseStore.clearHolder(accountId, deviceId);
    return revoked;
  }

  /**
   * Operator reset of an account's sequence high-water mark, for an account
   * whose mark was pushed out of reach (every later upload is
   * `stale_sequence`). The new mark must not be above the current one. Any
   * snapshot or pending upload above it is refused with its sequence listed,
   * unless `removeSnapshotsAbove` is set, in which case those rows and their
   * objects are deleted first. Every call that changes anything is logged with
   * the previous mark, the new mark, and the removed sequences.
   */
  async resetHighWater(
    accountId: string,
    highWaterSequence: number,
    options: { removeSnapshotsAbove?: boolean } = {},
  ): Promise<{
    previous: number;
    highWaterSequence: number;
    removed: number[];
  }> {
    if (!isIdentifier(accountId)) throw new RelayError(404, 'not_found');
    if (!Number.isSafeInteger(highWaterSequence) || highWaterSequence < 0) {
      throw new RelayError(400, 'invalid_request', {
        field: 'highWaterSequence',
      });
    }
    const usage = await this.store.getUsage(accountId);
    if (!usage) throw new RelayError(404, 'no_account');
    if (highWaterSequence > usage.highWaterSequence) {
      throw new RelayError(409, 'not_a_reset', {
        highWaterSequence: usage.highWaterSequence,
      });
    }
    const handle = accountHandle(accountId);
    const above = (await this.store.listSnapshots(accountId)).filter(
      (record) => record.sequence > highWaterSequence,
    );
    if (above.length > 0 && options.removeSnapshotsAbove !== true) {
      throw new RelayError(409, 'snapshots_above_high_water', {
        sequences: above.map((record) => record.sequence),
      });
    }
    for (const record of above) {
      await this.removeSnapshot(record, handle, record.status);
    }
    if (!(await this.store.resetHighWater(accountId, highWaterSequence))) {
      // A snapshot appeared above the new mark, or the mark moved: nothing
      // was reset, so the operator can look again.
      throw new RelayError(409, 'high_water_changed');
    }
    // The lease head follows the mark down, or the next acquire (which must
    // name the head) and publish (which must exceed it) could never succeed.
    await this.leaseStore.resetHead(accountId);
    this.logger.warn('high_water_reset', {
      account: handle,
      previous: usage.highWaterSequence,
      to: highWaterSequence,
      removed: above.length,
      removedSequences: above.map((record) => record.sequence).join(','),
    });
    return {
      previous: usage.highWaterSequence,
      highWaterSequence,
      removed: above.map((record) => record.sequence),
    };
  }

  /**
   * Mark `accountId` replaced by `supersededBy` (#4817), for the account
   * layer once it has provisioned the new account and registered a device in
   * it. Admin only: no device route can set or clear it, so a stolen device
   * cannot silence or redirect an account. The old account's snapshots stay
   * in place (readable by explicit sequence); it takes no new writes and
   * offers nothing to restore-latest. Idempotent for the same target.
   */
  async supersedeAccount(
    accountId: string,
    supersededBy: string,
  ): Promise<'superseded' | 'unchanged'> {
    if (!isIdentifier(accountId)) throw new RelayError(404, 'not_found');
    if (!isIdentifier(supersededBy) || supersededBy === accountId) {
      throw new RelayError(400, 'invalid_request', { field: 'supersededBy' });
    }
    if (!(await this.store.getUsage(accountId))) {
      throw new RelayError(404, 'no_account');
    }
    // The replacement must already be usable, and must not itself be
    // replaced, nor may the replaced account be someone's replacement (no
    // chains, so no cycles).
    if (await this.store.isSupersessionTarget(accountId)) {
      throw new RelayError(409, 'account_is_target');
    }
    if ((await this.store.countActiveDevices(supersededBy)) < 1) {
      throw new RelayError(409, 'target_not_ready');
    }
    if (await this.store.getSupersession(supersededBy)) {
      throw new RelayError(409, 'target_superseded');
    }
    const result = await this.store.setSupersession(
      accountId,
      supersededBy,
      this.now(),
    );
    if (result === 'conflict') throw new RelayError(409, 'already_superseded');
    if (result === 'superseded') {
      this.logger.warn('account_superseded', {
        account: accountHandle(accountId),
        supersededBy: accountHandle(supersededBy),
      });
    }
    return result;
  }

  /** Undo {@link supersedeAccount}, for an operator mistake. */
  async clearSupersession(accountId: string): Promise<boolean> {
    if (!isIdentifier(accountId)) return false;
    const cleared = await this.store.clearSupersession(accountId);
    if (cleared) {
      this.logger.warn('account_supersession_cleared', {
        account: accountHandle(accountId),
      });
    }
    return cleared;
  }

  /** Sizes, dates, and device state for one account; never content. */
  async operatorView(accountId: string): Promise<OperatorAccountView> {
    const [usage, snapshots, devices, supersession] = await Promise.all([
      this.store.getUsage(accountId),
      this.store.listSnapshots(accountId),
      this.store.listDevices(accountId),
      this.store.getSupersession(accountId),
    ]);
    return {
      usage,
      supersededBy: supersession?.supersededBy ?? null,
      snapshots: snapshots.map((record) => ({
        sequence: record.sequence,
        status: record.status,
        byteSize: record.byteSize,
        chunkCount: record.chunkCount,
        sha256: record.sha256,
        createdAt: iso(record.createdAt),
        committedAt:
          record.committedAt === null ? null : iso(record.committedAt),
      })),
      devices: devices.map((device) => ({
        deviceId: device.deviceId,
        status: device.status,
        registeredAt: iso(device.registeredAt),
        revokedAt: device.revokedAt === null ? null : iso(device.revokedAt),
      })),
    };
  }

  // Admin API ---------------------------------------------------------------

  private adminAuthorized(request: Request): boolean {
    if (!this.adminTokenHash) return false;
    const header = request.headers.get('authorization') ?? '';
    const match = /^Bearer ([^\s]{1,512})$/.exec(header);
    if (!match) return false;
    const presented = createHash('sha256').update(match[1]).digest();
    return timingSafeEqual(presented, this.adminTokenHash);
  }

  /** Operator and account-layer handler (private listener). */
  async handleAdmin(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname;
    let status = 500;
    try {
      if (method === 'GET') {
        const health = await this.health(path);
        if (health) return health;
      }
      if (!this.adminTokenHash) throw new RelayError(404, 'not_found');
      if (!this.adminAuthorized(request)) {
        throw new RelayError(401, 'unauthorized');
      }
      const response = await this.dispatchAdmin(method, path, request);
      status = response.status;
      return response;
    } catch (error) {
      const response = this.toErrorResponse(error);
      status = response.status;
      return response;
    } finally {
      this.logger.info('admin_request', { method, status });
    }
  }

  private async dispatchAdmin(
    method: string,
    path: string,
    request: Request,
  ): Promise<Response> {
    if (path === '/admin/v1/sweep' && method === 'POST') {
      return json(200, { expired: await this.sweepExpired() });
    }
    let m = /^\/admin\/v1\/accounts\/([^/]+)$/.exec(path);
    if (m && method === 'GET') {
      if (!isIdentifier(m[1])) throw new RelayError(404, 'not_found');
      return json(200, await this.operatorView(m[1]));
    }
    m = /^\/admin\/v1\/accounts\/([^/]+)\/reconcile$/.exec(path);
    if (m && method === 'POST') {
      if (!isIdentifier(m[1])) throw new RelayError(404, 'not_found');
      await this.store.reconcileUsage(m[1]);
      return json(200, { usage: await this.store.getUsage(m[1]) });
    }
    m = /^\/admin\/v1\/accounts\/([^/]+)\/high-water$/.exec(path);
    if (m && method === 'POST') {
      if (!isIdentifier(m[1])) throw new RelayError(404, 'not_found');
      const input = parseJsonObject(
        await readBoundedBody(request, MAX_JSON_BODY_BYTES),
      );
      if (
        input.removeSnapshotsAbove !== undefined &&
        typeof input.removeSnapshotsAbove !== 'boolean'
      ) {
        throw new RelayError(400, 'invalid_request', {
          field: 'removeSnapshotsAbove',
        });
      }
      return json(
        200,
        await this.resetHighWater(m[1], input.highWaterSequence as number, {
          removeSnapshotsAbove: input.removeSnapshotsAbove === true,
        }),
      );
    }
    m = /^\/admin\/v1\/accounts\/([^/]+)\/superseded-by$/.exec(path);
    if (m && (method === 'PUT' || method === 'DELETE')) {
      if (!isIdentifier(m[1])) throw new RelayError(404, 'not_found');
      if (method === 'DELETE') {
        if (!(await this.clearSupersession(m[1]))) {
          throw new RelayError(404, 'no_supersession');
        }
        return json(204, null);
      }
      const input = parseJsonObject(
        await readBoundedBody(request, MAX_JSON_BODY_BYTES),
      );
      if (typeof input.supersededBy !== 'string') {
        throw new RelayError(400, 'invalid_request', {
          field: 'supersededBy',
        });
      }
      const result = await this.supersedeAccount(m[1], input.supersededBy);
      return json(result === 'superseded' ? 201 : 200, { result });
    }
    m = /^\/admin\/v1\/accounts\/([^/]+)\/devices\/([^/]+)$/.exec(path);
    if (m) {
      const [, accountId, deviceId] = m;
      if (!isIdentifier(accountId) || !isIdentifier(deviceId)) {
        throw new RelayError(404, 'not_found');
      }
      if (method === 'PUT') {
        const input = parseJsonObject(
          await readBoundedBody(request, MAX_JSON_BODY_BYTES),
        );
        if (
          typeof input.publicKey !== 'string' ||
          !importDevicePublicKey(input.publicKey)
        ) {
          throw new RelayError(400, 'invalid_request', { field: 'publicKey' });
        }
        const result = await this.registerDevice(
          accountId,
          deviceId,
          input.publicKey,
        );
        if (result === 'conflict') throw new RelayError(409, 'device_conflict');
        return json(result === 'registered' ? 201 : 200, { result });
      }
      if (method === 'DELETE') {
        const revoked = await this.revokeDevice(accountId, deviceId);
        if (!revoked) throw new RelayError(404, 'no_active_device');
        return json(204, null);
      }
    }
    throw new RelayError(404, 'not_found');
  }
}
