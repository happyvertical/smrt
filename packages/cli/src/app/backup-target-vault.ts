/**
 * Vault relay backup target (#4804): a client for the blind snapshot relay
 * (`packages/vault-relay`, protocol `smrt-vault-relay-v1`).
 *
 * - Every request is signed by a device signer supplied through the
 *   {@link VaultDeviceSigner} seam; the private key never enters this module.
 * - Upload is a chunked stream: begin (reserves quota), one `PUT` per chunk
 *   (each retried, which the relay treats idempotently), then commit, which is
 *   the only step that publishes. Any earlier failure aborts the upload, so no
 *   partial snapshot is ever listed.
 * - The cached device entitlement must grant `backup.vault` before anything is
 *   sent. That check is a courtesy; the relay enforces the same gate on every
 *   route from server-side grants.
 * - The relay is not trusted to be honest: every response is checked against
 *   what was asked (sequence, sizes, digests, ordering) and a download is
 *   verified chunk by chunk and as a whole, and its clear header must carry the
 *   requested sequence. A mismatch is a `protocol` or `integrity` failure,
 *   never data. The ciphertext's own authenticated context (account, device,
 *   sequence) is checked again when a snapshot is decrypted.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  type BackupObject,
  type BackupPutRequest,
  type BackupTarget,
  BackupTargetError,
  rechunk,
  verifiedCiphertext,
} from './backup-targets.js';
import {
  parseSnapshotHeader,
  SNAPSHOT_HEADER_BYTES,
} from './snapshot-framing.js';

/** Feature key the relay gates every route on. */
export const VAULT_FEATURE_KEY = 'backup.vault';
/** Signature protocol tag the relay verifies. */
export const VAULT_SIGNATURE_PROTOCOL = 'smrt-vault-relay-v1';
/** Default plaintext-independent upload chunk size (below the relay default cap). */
export const DEFAULT_VAULT_CHUNK_BYTES = 4 * 1024 * 1024;

const JSON_LIMIT_BYTES = 256 * 1024;
const LIST_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_LISTED = 10_000;
/** Chunk bounds: the relay's own ceiling, and the smallest useful chunk. */
const MIN_CHUNK_BYTES = 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_CHUNK_COUNT = 999_999;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UPLOAD_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OBJECT_ID = /^[1-9][0-9]{0,15}$/;
const EMPTY_SHA256 = createHash('sha256').digest('hex');

const UPGRADE_MESSAGE =
  'Vault backups need the Vault plan (feature backup.vault), which this installation does not have. Upgrade to enable them, or back up to a local file or your own Google Drive.';

/**
 * Device identity and signing, held by the vault key lifecycle (#4785) or the
 * embedding host. `sign` returns the raw 64-byte Ed25519 signature of the
 * message; the key itself stays with its custodian.
 */
export interface VaultDeviceSigner {
  readonly accountId: string;
  readonly deviceId: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** The slice of the device entitlement cache this target reads. */
export interface VaultEntitlementSource {
  status(): Promise<{ featureKeys: readonly string[] }>;
}

/** Options for {@link VaultRelayBackupTarget}. */
export interface VaultRelayBackupTargetOptions {
  name: string;
  /** Relay origin: `https://…`, or `http://` on a loopback host only. */
  url: string;
  signer: () => Promise<VaultDeviceSigner | undefined>;
  entitlements?: VaultEntitlementSource;
  fetch?: typeof fetch;
  /** Upload chunk size. Default 4 MiB. */
  chunkBytes?: number;
  /** Attempts per retryable request. Default 3. */
  attempts?: number;
  /** Base backoff between attempts. Default 500 ms. */
  retryDelayMs?: number;
  /** Per-request timeout. Default 120 s. */
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Validate and normalize a relay URL to its origin. */
export function normalizeRelayUrl(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw new BackupTargetError('invalid_config', 'The relay URL is invalid.');
  }
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]';
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new BackupTargetError(
      'invalid_config',
      'The relay URL must be an https origin (http only for localhost) with no path, query or credentials.',
    );
  }
  return url.origin;
}

interface SnapshotView {
  sequence: number;
  byteSize: number;
  chunkSize: number;
  chunkCount: number;
  sha256: string;
  committedAt: Date;
}

function protocolError(): BackupTargetError {
  return new BackupTargetError(
    'protocol',
    'The vault relay sent a response that does not match the request; it was ignored.',
  );
}

function positiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw protocolError();
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSnapshotView(value: unknown): SnapshotView {
  if (!isRecord(value)) throw protocolError();
  const sequence = positiveSafeInteger(value.sequence);
  const byteSize = positiveSafeInteger(value.byteSize);
  const chunkSize = positiveSafeInteger(value.chunkSize);
  const chunkCount = positiveSafeInteger(value.chunkCount);
  // A hostile record must not make the client buffer or request without
  // bound, and every real snapshot holds at least its clear header.
  if (
    byteSize <= SNAPSHOT_HEADER_BYTES ||
    chunkSize < MIN_CHUNK_BYTES ||
    chunkSize > MAX_CHUNK_BYTES ||
    chunkCount > MAX_CHUNK_COUNT ||
    chunkCount !== Math.ceil(byteSize / chunkSize) ||
    typeof value.sha256 !== 'string' ||
    !SHA256_HEX.test(value.sha256) ||
    typeof value.committedAt !== 'string'
  ) {
    throw protocolError();
  }
  const committedAt = new Date(value.committedAt);
  if (Number.isNaN(committedAt.getTime())) throw protocolError();
  return {
    sequence,
    byteSize,
    chunkSize,
    chunkCount,
    sha256: value.sha256,
    committedAt,
  };
}

function expectedChunkBytes(view: SnapshotView, index: number): number {
  return index < view.chunkCount - 1
    ? view.chunkSize
    : view.byteSize - view.chunkSize * (view.chunkCount - 1);
}

async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw protocolError();
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw protocolError();
    }
    parts.push(value);
  }
  return Buffer.concat(parts, total);
}

async function readJson(
  response: Response,
  limit = JSON_LIMIT_BYTES,
): Promise<unknown> {
  const bytes = await readBounded(response, limit);
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw protocolError();
  }
}

/** Stores snapshots on the blind vault relay. */
export class VaultRelayBackupTarget implements BackupTarget {
  readonly kind = 'vault' as const;
  readonly name: string;
  readonly #origin: string;
  readonly #signer: () => Promise<VaultDeviceSigner | undefined>;
  readonly #entitlements?: VaultEntitlementSource;
  readonly #fetch: typeof fetch;
  readonly #chunkBytes: number;
  readonly #attempts: number;
  readonly #retryDelayMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;

  constructor(options: VaultRelayBackupTargetOptions) {
    this.name = options.name;
    this.#origin = normalizeRelayUrl(options.url);
    this.#signer = options.signer;
    this.#entitlements = options.entitlements;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#chunkBytes = options.chunkBytes ?? DEFAULT_VAULT_CHUNK_BYTES;
    this.#attempts = options.attempts ?? 3;
    this.#retryDelayMs = options.retryDelayMs ?? 500;
    this.#timeoutMs = options.requestTimeoutMs ?? 120_000;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    if (
      !Number.isSafeInteger(this.#chunkBytes) ||
      this.#chunkBytes < MIN_CHUNK_BYTES ||
      this.#chunkBytes > MAX_CHUNK_BYTES ||
      this.#attempts < 1
    ) {
      throw new BackupTargetError(
        'invalid_config',
        'The vault chunk size or attempt count is invalid.',
      );
    }
  }

  // Authorization ------------------------------------------------------------

  async #requireEntitlement(): Promise<void> {
    let granted = false;
    try {
      const status = await this.#entitlements?.status();
      granted = status?.featureKeys.includes(VAULT_FEATURE_KEY) === true;
    } catch {
      granted = false;
    }
    if (!granted) {
      throw new BackupTargetError('entitlement_required', UPGRADE_MESSAGE);
    }
  }

  async #deviceSigner(): Promise<VaultDeviceSigner> {
    let signer: VaultDeviceSigner | undefined;
    try {
      signer = await this.#signer();
    } catch {
      signer = undefined;
    }
    if (
      !signer ||
      !IDENTIFIER.test(signer.accountId) ||
      !IDENTIFIER.test(signer.deviceId)
    ) {
      throw new BackupTargetError(
        'credentials_unavailable',
        'No vault device identity is available on this installation.',
      );
    }
    return signer;
  }

  async preflight(): Promise<void> {
    await this.#requireEntitlement();
    await this.#deviceSigner();
  }

  // Transport ----------------------------------------------------------------

  async #request(
    method: string,
    path: string,
    body?: Uint8Array,
  ): Promise<Response> {
    const signer = await this.#deviceSigner();
    const bytes = body ?? new Uint8Array();
    const contentSha256 = body
      ? createHash('sha256').update(body).digest('hex')
      : EMPTY_SHA256;
    const timestamp = this.#now();
    const nonce = randomBytes(18).toString('base64url');
    const canonical = Buffer.from(
      [
        VAULT_SIGNATURE_PROTOCOL,
        method.toUpperCase(),
        path,
        signer.accountId,
        signer.deviceId,
        String(timestamp),
        nonce,
        contentSha256,
      ].join('\n'),
      'utf8',
    );
    let signature: Uint8Array;
    try {
      signature = await signer.sign(canonical);
    } catch {
      throw new BackupTargetError(
        'credentials_unavailable',
        'The vault device key could not sign the request.',
      );
    }
    if (signature.length !== 64) {
      throw new BackupTargetError(
        'credentials_unavailable',
        'The vault device key returned an invalid signature.',
      );
    }
    const headers: Record<string, string> = {
      'x-vault-account': signer.accountId,
      'x-vault-device': signer.deviceId,
      'x-vault-timestamp': String(timestamp),
      'x-vault-nonce': nonce,
      'x-vault-content-sha256': contentSha256,
      'x-vault-signature': Buffer.from(signature).toString('base64url'),
    };
    if (body) {
      headers['content-length'] = String(bytes.length);
      headers['content-type'] =
        method === 'POST' ? 'application/json' : 'application/octet-stream';
    }
    return this.#fetch(`${this.#origin}${path}`, {
      method,
      headers,
      ...(body ? { body: Buffer.from(bytes) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  /** Map a non-success response to a stable, fixed-text failure. */
  async #failure(response: Response): Promise<BackupTargetError> {
    let detail: Record<string, unknown> = {};
    try {
      const parsed = await readJson(response);
      if (isRecord(parsed)) detail = parsed;
    } catch {
      detail = {};
    }
    // Feature denials carry a stable `code` and put prose in `error`; the
    // relay's own errors carry the stable code in `error`.
    const code =
      typeof detail.code === 'string'
        ? detail.code
        : typeof detail.error === 'string'
          ? detail.error
          : '';
    if (response.status === 401) {
      return new BackupTargetError(
        'unauthorized',
        'The vault relay did not accept this device (unknown or revoked device, or the clock is off).',
      );
    }
    if (response.status === 403) {
      return code === 'feature_upgrade_required' || code === 'feature_disabled'
        ? new BackupTargetError('entitlement_required', UPGRADE_MESSAGE)
        : new BackupTargetError(
            'unauthorized',
            'The vault relay refused this device.',
          );
    }
    if (response.status === 413 && code === 'quota_exceeded') {
      return new BackupTargetError(
        'quota_or_access',
        'The vault is full for this account; remove old snapshots or upgrade the plan.',
      );
    }
    if (response.status === 409 && code === 'stale_sequence') {
      return new BackupTargetError(
        'stale_sequence',
        'The vault already holds a newer snapshot than this one; restore it before backing up from this device.',
      );
    }
    if (response.status === 409 && code === 'sequence_exists') {
      return new BackupTargetError(
        'already_exists',
        'A snapshot with this sequence is already uploading or stored.',
      );
    }
    if (response.status === 404) {
      return new BackupTargetError('not_found', 'Unknown snapshot.');
    }
    return new BackupTargetError(
      'unavailable',
      'The vault relay could not complete the request.',
    );
  }

  static #retryable(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
  }

  /**
   * Send a request, re-signing for every attempt, and return the response when
   * its status is in `accept`. Used only for requests that are idempotent.
   */
  async #exchange(
    method: string,
    path: string,
    accept: readonly number[],
    body?: Uint8Array,
    retry = true,
    progress?: { attempts: number },
  ): Promise<Response> {
    let last: BackupTargetError | undefined;
    const attempts = retry ? this.#attempts : 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (progress) progress.attempts = attempt;
      let response: Response | undefined;
      try {
        response = await this.#request(method, path, body);
      } catch (error) {
        if (error instanceof BackupTargetError) throw error;
        last = new BackupTargetError(
          'unavailable',
          'The vault relay could not be reached.',
        );
      }
      if (response) {
        if (accept.includes(response.status)) return response;
        const failure = await this.#failure(response);
        if (
          failure.code !== 'unavailable' ||
          !VaultRelayBackupTarget.#retryable(response.status)
        ) {
          throw failure;
        }
        last = failure;
      }
      if (attempt < attempts) {
        await this.#sleep(this.#retryDelayMs * 2 ** (attempt - 1));
      }
    }
    throw (
      last ??
      new BackupTargetError(
        'unavailable',
        'The vault relay could not be reached.',
      )
    );
  }

  // Upload -------------------------------------------------------------------

  async #begin(
    request: BackupPutRequest,
    chunkSize: number,
    allowShrink: boolean,
  ): Promise<{ uploadId: string; chunkSize: number; chunkCount: number }> {
    const body = Buffer.from(
      JSON.stringify({
        sequence: Number(request.sequence),
        byteSize: request.byteSize,
        chunkSize,
        sha256: request.sha256,
      }),
      'utf8',
    );
    let response: Response;
    try {
      response = await this.#request('POST', '/v1/uploads', body);
    } catch (error) {
      if (error instanceof BackupTargetError) throw error;
      throw new BackupTargetError(
        'unavailable',
        'The vault relay could not be reached.',
      );
    }
    if (response.status !== 201) {
      if (response.status === 413 && allowShrink) {
        const detail = await readJson(response.clone()).catch(() => null);
        const limit = isRecord(detail) ? detail.maxChunkBytes : undefined;
        if (
          detail &&
          isRecord(detail) &&
          detail.error === 'chunk_too_large' &&
          Number.isSafeInteger(limit) &&
          (limit as number) >= MIN_CHUNK_BYTES &&
          (limit as number) < chunkSize
        ) {
          return this.#begin(request, limit as number, false);
        }
      }
      throw await this.#failure(response);
    }
    const view = await readJson(response);
    if (
      !isRecord(view) ||
      typeof view.uploadId !== 'string' ||
      !UPLOAD_ID.test(view.uploadId) ||
      view.sequence !== Number(request.sequence) ||
      view.byteSize !== request.byteSize ||
      view.chunkSize !== chunkSize ||
      view.chunkCount !== Math.ceil(request.byteSize / chunkSize) ||
      (view.chunkCount as number) > MAX_CHUNK_COUNT
    ) {
      throw protocolError();
    }
    return {
      uploadId: view.uploadId,
      chunkSize,
      chunkCount: view.chunkCount as number,
    };
  }

  async put(request: BackupPutRequest): Promise<BackupObject> {
    await this.#requireEntitlement();
    if (
      request.sequence < 1n ||
      request.sequence > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new BackupTargetError(
        'invalid_snapshot',
        'The snapshot sequence is outside the range the vault supports.',
      );
    }
    const upload = await this.#begin(request, this.#chunkBytes, true);
    try {
      let index = 0;
      for await (const piece of rechunk(
        verifiedCiphertext(request),
        upload.chunkSize,
      )) {
        if (index >= upload.chunkCount) throw protocolError();
        const digest = createHash('sha256').update(piece).digest('hex');
        const response = await this.#exchange(
          'PUT',
          `/v1/uploads/${upload.uploadId}/chunks/${index}`,
          [200],
          piece,
        );
        const echo = await readJson(response);
        if (
          !isRecord(echo) ||
          echo.index !== index ||
          echo.byteSize !== piece.length ||
          echo.sha256 !== digest
        ) {
          throw protocolError();
        }
        index += 1;
      }
      if (index !== upload.chunkCount) {
        throw new BackupTargetError(
          'integrity',
          'The snapshot ended before every declared chunk was sent.',
        );
      }
      const committed = await this.#commit(request, upload.uploadId);
      return {
        id: String(committed.sequence),
        sequence: BigInt(committed.sequence),
        byteSize: committed.byteSize,
        createdAt: committed.committedAt,
        sha256: committed.sha256,
      };
    } catch (error) {
      await this.#abort(upload.uploadId);
      throw error instanceof BackupTargetError
        ? error
        : new BackupTargetError(
            'unavailable',
            'The vault relay could not complete the upload.',
          );
    }
  }

  async #commit(
    request: BackupPutRequest,
    uploadId: string,
  ): Promise<SnapshotView> {
    const check = (view: SnapshotView): SnapshotView => {
      if (
        view.sequence !== Number(request.sequence) ||
        view.byteSize !== request.byteSize ||
        view.sha256 !== request.sha256
      ) {
        throw protocolError();
      }
      return view;
    };
    let response: Response | undefined;
    try {
      response = await this.#request('POST', `/v1/uploads/${uploadId}/commit`);
    } catch (error) {
      if (error instanceof BackupTargetError) throw error;
      response = undefined;
    }
    if (response?.status === 201) {
      return check(parseSnapshotView(await readJson(response)));
    }
    if (response && response.status < 500 && response.status !== 408) {
      throw await this.#failure(response);
    }
    // The commit may have succeeded with its answer lost: ask before giving up.
    try {
      const status = await this.#exchange(
        'GET',
        `/v1/snapshots/${Number(request.sequence)}`,
        [200],
      );
      return check(parseSnapshotView(await readJson(status)));
    } catch {
      throw new BackupTargetError(
        'unavailable',
        'The vault relay did not confirm that the snapshot was published.',
      );
    }
  }

  async #abort(uploadId: string): Promise<void> {
    try {
      await this.#exchange('DELETE', `/v1/uploads/${uploadId}`, [204, 404]);
    } catch {
      // The relay expires abandoned uploads; abort is best effort.
    }
  }

  // Listing and download -----------------------------------------------------

  async list(): Promise<BackupObject[]> {
    const response = await this.#exchange('GET', '/v1/snapshots', [200]);
    const body = await readJson(response, LIST_LIMIT_BYTES);
    if (!isRecord(body) || !Array.isArray(body.snapshots)) {
      throw protocolError();
    }
    if (body.snapshots.length > MAX_LISTED) throw protocolError();
    const objects: BackupObject[] = [];
    let previous = Number.POSITIVE_INFINITY;
    for (const entry of body.snapshots) {
      const view = parseSnapshotView(entry);
      if (view.sequence >= previous) throw protocolError();
      previous = view.sequence;
      objects.push({
        id: String(view.sequence),
        sequence: BigInt(view.sequence),
        byteSize: view.byteSize,
        createdAt: view.committedAt,
        sha256: view.sha256,
      });
    }
    return objects;
  }

  async *get(id: string): AsyncGenerator<Uint8Array> {
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
      throw new BackupTargetError('not_found', 'Unknown snapshot.');
    }
    const sequence = Number(id);
    if (!Number.isSafeInteger(sequence)) {
      throw new BackupTargetError('not_found', 'Unknown snapshot.');
    }
    const meta = parseSnapshotView(
      await readJson(
        await this.#exchange('GET', `/v1/snapshots/${sequence}`, [200]),
      ),
    );
    if (meta.sequence !== sequence) throw protocolError();
    const whole = createHash('sha256');
    let head = Buffer.alloc(0);
    let headChecked = false;
    for (let index = 0; index < meta.chunkCount; index += 1) {
      const expected = expectedChunkBytes(meta, index);
      const response = await this.#exchange(
        'GET',
        `/v1/snapshots/${sequence}/chunks/${index}`,
        [200],
      );
      const bytes = await readBounded(response, expected);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (
        bytes.length !== expected ||
        response.headers.get('x-vault-chunk-sha256') !== digest
      ) {
        throw new BackupTargetError(
          'integrity',
          'The vault relay returned a chunk that does not match its record.',
        );
      }
      whole.update(bytes);
      if (!headChecked) {
        head = Buffer.concat([head, bytes]).subarray(0, SNAPSHOT_HEADER_BYTES);
        if (head.length >= SNAPSHOT_HEADER_BYTES) {
          headChecked = true;
          let sequenceInHeader: bigint;
          try {
            sequenceInHeader = parseSnapshotHeader(head).sequence;
          } catch {
            throw new BackupTargetError(
              'integrity',
              'The vault relay returned data that is not an encrypted snapshot.',
            );
          }
          if (sequenceInHeader !== BigInt(sequence)) {
            throw new BackupTargetError(
              'integrity',
              'The vault relay returned a different snapshot than requested.',
            );
          }
        }
      }
      yield bytes;
    }
    if (!headChecked || whole.digest('hex') !== meta.sha256) {
      throw new BackupTargetError(
        'integrity',
        'The downloaded snapshot does not match its recorded digest.',
      );
    }
  }

  async delete(id: string): Promise<void> {
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
      throw new BackupTargetError('not_found', 'Unknown snapshot.');
    }
    // A retry after a lost 204 meets 404: the snapshot is gone, which is the
    // goal. A 404 on the first attempt means it never existed.
    const progress = { attempts: 0 };
    const response = await this.#exchange(
      'DELETE',
      `/v1/snapshots/${Number(id)}`,
      [204, 404],
      undefined,
      true,
      progress,
    );
    if (response.status === 404 && progress.attempts === 1) {
      throw new BackupTargetError('not_found', 'Unknown snapshot.');
    }
  }
}
