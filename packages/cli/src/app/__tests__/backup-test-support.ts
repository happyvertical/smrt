/** Shared fixtures for the backup target tests (#4804). */

import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DriveFilesystem } from '../backup-target-gdrive.js';
import type {
  VaultDeviceSigner,
  VaultEntitlementSource,
} from '../backup-target-vault.js';
import type { BackupPutRequest } from '../backup-targets.js';
import {
  MIN_SNAPSHOT_CHUNK_BYTES,
  type SnapshotKeyProvider,
  writeEncryptedSnapshot,
} from '../snapshot-framing.js';

export const ACCOUNT = 'account-1';
export const DEVICE = 'device-1';
export const KEY_ID = 'ab'.repeat(16);
export const KEY = Buffer.alloc(32, 9);

export function tempRoot(roots: string[], prefix = 'smrt-backup-'): string {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)));
  roots.push(root);
  return root;
}

export async function* pieces(
  bytes: Uint8Array,
  size = 1500,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

export interface Sealed {
  sequence: bigint;
  bytes: Buffer;
  byteSize: number;
  sha256: string;
  plaintext: Buffer;
  request(overrides?: Partial<BackupPutRequest>): BackupPutRequest;
}

/** Seal real HVSF ciphertext (multi-chunk) with the shared test key. */
export async function seal(
  directory: string,
  sequence: bigint,
  plaintext: Buffer = randomBytes(9000),
): Promise<Sealed> {
  mkdirSync(directory, { recursive: true });
  const destination = join(
    directory,
    `sealed-${sequence}-${randomBytes(4).toString('hex')}.hvsnap`,
  );
  await writeEncryptedSnapshot({
    destination,
    kind: 'export-bundle',
    totalLength: plaintext.length,
    source: [plaintext],
    sealing: {
      accountId: ACCOUNT,
      deviceId: DEVICE,
      sequence,
      generation: 1n,
      keyId: KEY_ID,
      key: new Uint8Array(KEY),
    },
    chunkSize: MIN_SNAPSHOT_CHUNK_BYTES,
  });
  const bytes = readFileSync(destination);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    sequence,
    bytes,
    byteSize: bytes.length,
    sha256,
    plaintext,
    request: (overrides = {}) => ({
      sequence,
      byteSize: bytes.length,
      sha256,
      source: pieces(bytes),
      ...overrides,
    }),
  };
}

export function keyring(
  sequence = 1n,
): SnapshotKeyProvider & { sealed: number } {
  let next = sequence;
  const ring = {
    sealed: 0,
    async sealingKey() {
      ring.sealed += 1;
      return {
        accountId: ACCOUNT,
        deviceId: DEVICE,
        sequence: next++,
        generation: 1n,
        keyId: KEY_ID,
        key: new Uint8Array(KEY),
      };
    },
    async openingKey({
      generation,
      keyId,
    }: {
      generation: bigint;
      keyId: string;
    }) {
      return generation === 1n && keyId === KEY_ID
        ? new Uint8Array(KEY)
        : undefined;
    },
  };
  return ring;
}

export async function collect(
  source: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of source) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

// Fake Drive ---------------------------------------------------------------------

class NamedError extends Error {
  code?: string;
  constructor(name: string, message: string, code?: string) {
    super(message);
    this.name = name;
    this.code = code;
  }
}

export function driveError(
  kind: 'grant' | 'permission' | 'quota' | 'missing' | 'other',
  secret = '',
): Error {
  switch (kind) {
    case 'grant':
      return new NamedError(
        'FilesystemError',
        `Google Drive API error: invalid_grant ${secret}`,
        '400',
      );
    case 'permission':
      return new NamedError('PermissionError', `denied ${secret}`, 'EACCES');
    case 'quota':
      return new NamedError(
        'FilesystemError',
        `Google Drive API error: storageQuotaExceeded ${secret}`,
        '403',
      );
    case 'missing':
      return new NamedError('FileNotFoundError', `missing ${secret}`, 'ENOENT');
    default:
      return new NamedError('FilesystemError', `boom ${secret}`, 'UNKNOWN');
  }
}

/** In-memory Drive with the SDK provider's path semantics and trash-on-delete. */
export class FakeDrive implements DriveFilesystem {
  files = new Map<string, Buffer>();
  dirs = new Set<string>();
  trashed: string[] = [];
  writes = 0;
  /** Fail the next call to this method. */
  failOn = new Map<string, Error>();
  /** Store only this many bytes of every write (simulates a cut upload). */
  truncateTo: number | undefined;
  /** Paths a second file with the same name exists for (Drive allows it). */
  duplicates = new Set<string>();
  duplicateOnMove = false;
  readExtra = false;
  /** Throw after the bytes are stored (a lost write acknowledgement). */
  failAfterWrite: Error | undefined;

  #maybeFail(method: string): void {
    const error = this.failOn.get(method);
    if (error) {
      this.failOn.delete(method);
      throw error;
    }
  }

  async exists(path: string): Promise<boolean> {
    this.#maybeFail('exists');
    return this.files.has(path) || this.dirs.has(path);
  }

  async createDirectory(path: string): Promise<void> {
    this.#maybeFail('createDirectory');
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      this.dirs.add(parts.slice(0, index).join('/'));
    }
  }

  async write(path: string, content: string | Buffer): Promise<void> {
    this.#maybeFail('write');
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent && !this.dirs.has(parent)) throw driveError('missing');
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    this.writes += 1;
    this.files.set(
      path,
      this.truncateTo === undefined
        ? bytes
        : bytes.subarray(0, this.truncateTo),
    );
    if (this.failAfterWrite) throw this.failAfterWrite;
  }

  async read(path: string): Promise<string | Buffer> {
    this.#maybeFail('read');
    const bytes = this.files.get(path);
    if (!bytes) throw driveError('missing');
    return this.readExtra
      ? Buffer.concat([bytes, Buffer.from('x')])
      : Buffer.from(bytes);
  }

  async delete(path: string): Promise<void> {
    this.#maybeFail('delete');
    if (!this.files.delete(path)) throw driveError('missing');
    this.trashed.push(path);
  }

  async move(from: string, to: string): Promise<void> {
    this.#maybeFail('move');
    const bytes = this.files.get(from);
    if (!bytes) throw driveError('missing');
    this.files.delete(from);
    this.files.set(to, bytes);
    if (this.duplicateOnMove) this.duplicates.add(to);
  }

  async getStats(path: string) {
    this.#maybeFail('getStats');
    const bytes = this.files.get(path);
    if (!bytes) throw driveError('missing');
    return {
      size: bytes.length,
      mtime: new Date('2026-11-01T00:00:00Z'),
    } as never;
  }

  async list(path: string) {
    this.#maybeFail('list');
    const prefix = `${path}/`;
    const entries: unknown[] = [];
    for (const [name, bytes] of this.files) {
      if (name.startsWith(prefix) && !name.slice(prefix.length).includes('/')) {
        entries.push({
          name: name.slice(prefix.length),
          path: name,
          size: bytes.length,
          isDirectory: false,
          lastModified: new Date('2026-11-01T00:00:00Z'),
        });
        if (this.duplicates.has(name)) {
          entries.push({
            name: name.slice(prefix.length),
            path: name,
            size: bytes.length,
            isDirectory: false,
            lastModified: new Date('2026-11-01T00:00:00Z'),
          });
        }
      }
    }
    return entries as never;
  }

  folders(): string[] {
    return [...this.dirs].filter((dir) => !dir.includes('/'));
  }

  visible(folder: string): string[] {
    return [...this.files.keys()].filter((name) =>
      name.startsWith(`${folder}/snapshots/`),
    );
  }

  staged(folder: string): string[] {
    return [...this.files.keys()].filter((name) =>
      name.startsWith(`${folder}/staging/`),
    );
  }
}

// Fake vault relay ---------------------------------------------------------------

export function newSigner(): {
  signer: VaultDeviceSigner;
  publicKey: KeyObject;
  signed: number;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const state = {
    signed: 0,
    publicKey,
    signer: {
      accountId: ACCOUNT,
      deviceId: DEVICE,
      async sign(message: Uint8Array) {
        state.signed += 1;
        return new Uint8Array(sign(null, message, privateKey));
      },
    } satisfies VaultDeviceSigner,
  };
  return state;
}

export const entitled: VaultEntitlementSource = {
  async status() {
    return { featureKeys: ['backup.vault'] };
  },
};

export const unentitled: VaultEntitlementSource = {
  async status() {
    return { featureKeys: [] };
  },
};

interface StoredSnapshot {
  sequence: number;
  byteSize: number;
  chunkSize: number;
  chunkCount: number;
  sha256: string;
  chunks: Buffer[];
  committedAt: string;
}

interface PendingUpload extends Omit<StoredSnapshot, 'committedAt'> {
  uploadId: string;
  fencingToken: number;
}

export interface RelayCall {
  method: string;
  path: string;
}

/**
 * A faithful in-memory model of the relay protocol that also verifies the
 * client's request signature. `tamper` rewrites answers to model a hostile or
 * confused relay; `fail` forces transport and status failures.
 */
export class FakeRelay {
  readonly snapshots = new Map<number, StoredSnapshot>();
  readonly pending = new Map<string, PendingUpload>();
  readonly calls: RelayCall[] = [];
  readonly nonces = new Set<string>();
  highWater = 0;
  tamper: Partial<{
    begin: (body: Record<string, unknown>) => Record<string, unknown>;
    chunkEcho: (body: Record<string, unknown>) => Record<string, unknown>;
    commit: (body: Record<string, unknown>) => Record<string, unknown>;
    list: (body: { snapshots: Record<string, unknown>[] }) => unknown;
    meta: (body: Record<string, unknown>) => Record<string, unknown>;
    chunkBytes: (bytes: Buffer, index: number) => Buffer;
    chunkHeader: (digest: string, index: number) => string;
  }> = {};
  /** Return this response for the first matching call, then clear it. */
  fail = new Map<string, () => Response | Promise<never>>();
  loseCommitAnswer = false;
  statusOverride: Response | undefined;
  /** Writer lease (#4805): the current fencing token and head sequence. */
  token = 0;
  leaseExpired = false;
  /** Refuse the next acquire with this relay error body (status 409). */
  refuseAcquire: Record<string, unknown> | undefined;

  constructor(
    private readonly publicKey: KeyObject,
    private readonly maxChunkBytes = 8_454_144,
  ) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    this.calls.push({ method, path: url.pathname });
    const headers = new Headers(init?.headers);
    const body = init?.body
      ? Buffer.from(init.body as Buffer)
      : Buffer.alloc(0);
    const key = `${method} ${url.pathname.replace(/[0-9a-f-]{36}/, ':id')}`;
    const forced = this.fail.get(key);
    if (forced) {
      this.fail.delete(key);
      return forced();
    }
    if (!this.#authentic(method, url.pathname, headers, body)) {
      return json(401, { error: 'unauthorized' });
    }
    return this.#route(method, url.pathname, body, key);
  };

  #authentic(
    method: string,
    path: string,
    headers: Headers,
    body: Buffer,
  ): boolean {
    const nonce = headers.get('x-vault-nonce') ?? '';
    if (this.nonces.has(nonce)) return false;
    this.nonces.add(nonce);
    const digest = createHash('sha256').update(body).digest('hex');
    if (headers.get('x-vault-content-sha256') !== digest) return false;
    const message = [
      'smrt-vault-relay-v1',
      method,
      path,
      headers.get('x-vault-account'),
      headers.get('x-vault-device'),
      headers.get('x-vault-timestamp'),
      nonce,
      digest,
    ].join('\n');
    return verify(
      null,
      Buffer.from(message),
      this.publicKey,
      Buffer.from(headers.get('x-vault-signature') ?? '', 'base64url'),
    );
  }

  #view(snapshot: StoredSnapshot): Record<string, unknown> {
    return {
      sequence: snapshot.sequence,
      byteSize: snapshot.byteSize,
      chunkSize: snapshot.chunkSize,
      chunkCount: snapshot.chunkCount,
      sha256: snapshot.sha256,
      deviceId: DEVICE,
      createdAt: snapshot.committedAt,
      committedAt: snapshot.committedAt,
    };
  }

  #lease(key: string, body: Buffer): Response | undefined {
    if (key === 'GET /v1/lease') {
      return json(200, {
        holder: this.token > 0 && !this.leaseExpired ? 'device' : null,
        headSequence: this.highWater,
        latestCommittedSequence: this.highWater,
        headIsHole: false,
      });
    }
    if (!key.startsWith('POST /v1/lease/')) return undefined;
    const input = JSON.parse(body.toString('utf8') || '{}') as Record<
      string,
      number
    >;
    if (key.endsWith('/acquire')) {
      if (this.refuseAcquire) {
        const refusal = this.refuseAcquire;
        this.refuseAcquire = undefined;
        return json(409, refusal);
      }
      if (input.baseSequence !== this.highWater) {
        return json(409, {
          error: 'must_restore_first',
          headSequence: this.highWater,
          latestSequence: this.highWater,
        });
      }
      this.token += 1;
      this.leaseExpired = false;
      return json(200, {
        fencingToken: this.token,
        ttlMs: 60_000,
        headSequence: this.highWater,
      });
    }
    if (key.endsWith('/renew')) {
      return input.fencingToken === this.token && !this.leaseExpired
        ? json(200, {
            fencingToken: this.token,
            ttlMs: 60_000,
            headSequence: this.highWater,
          })
        : json(409, { error: 'lease_lost' });
    }
    return new Response(null, { status: 204 });
  }

  #route(method: string, path: string, body: Buffer, key: string): Response {
    const lease = this.#lease(key, body);
    if (lease) return lease;
    if (key === 'POST /v1/uploads') {
      const input = JSON.parse(body.toString('utf8')) as Record<string, number>;
      if (input.chunkSize > this.maxChunkBytes) {
        return json(413, {
          error: 'chunk_too_large',
          maxChunkBytes: this.maxChunkBytes,
        });
      }
      if (input.sequence <= this.highWater) {
        return json(409, { error: 'stale_sequence' });
      }
      // Publishing needs the current holder's token (#4805).
      if (
        !Number.isSafeInteger(input.fencingToken) ||
        input.fencingToken !== this.token ||
        this.leaseExpired
      ) {
        return json(409, {
          error: 'must_restore_first',
          headSequence: this.highWater,
          latestSequence: this.highWater,
        });
      }
      const uploadId = crypto.randomUUID();
      const chunkCount = Math.ceil(input.byteSize / input.chunkSize);
      this.pending.set(uploadId, {
        uploadId,
        sequence: input.sequence as number,
        byteSize: input.byteSize as number,
        chunkSize: input.chunkSize as number,
        chunkCount,
        sha256: input.sha256 as unknown as string,
        chunks: [],
        fencingToken: input.fencingToken as number,
      });
      const answer = {
        uploadId,
        sequence: input.sequence,
        byteSize: input.byteSize,
        chunkSize: input.chunkSize,
        chunkCount,
        expiresAt: new Date().toISOString(),
      };
      return json(201, this.tamper.begin?.(answer) ?? answer);
    }
    const chunk = /^\/v1\/uploads\/([^/]+)\/chunks\/(\d+)$/.exec(path);
    if (chunk && method === 'PUT') {
      const upload = this.pending.get(chunk[1] as string);
      if (!upload) return json(404, { error: 'no_upload' });
      const index = Number(chunk[2]);
      upload.chunks[index] = body;
      const answer = {
        index,
        byteSize: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
      };
      return json(200, this.tamper.chunkEcho?.(answer) ?? answer);
    }
    const commit = /^\/v1\/uploads\/([^/]+)\/commit$/.exec(path);
    if (commit && method === 'POST') {
      const upload = this.pending.get(commit[1] as string);
      if (!upload) return json(404, { error: 'no_upload' });
      if (upload.fencingToken !== this.token || this.leaseExpired) {
        this.pending.delete(upload.uploadId);
        return json(409, {
          error: 'must_restore_first',
          headSequence: this.highWater,
          latestSequence: this.highWater,
        });
      }
      const whole = Buffer.concat(upload.chunks);
      if (
        upload.chunks.length !== upload.chunkCount ||
        createHash('sha256').update(whole).digest('hex') !== upload.sha256
      ) {
        return json(409, { error: 'incomplete_upload' });
      }
      this.pending.delete(upload.uploadId);
      this.highWater = upload.sequence;
      const stored: StoredSnapshot = {
        ...upload,
        committedAt: '2026-11-08T12:00:00.000Z',
      };
      this.snapshots.set(upload.sequence, stored);
      if (this.loseCommitAnswer) {
        this.loseCommitAnswer = false;
        throw new TypeError('connection reset');
      }
      const answer = this.#view(stored);
      return json(201, this.tamper.commit?.(answer) ?? answer);
    }
    const abort = /^\/v1\/uploads\/([^/]+)$/.exec(path);
    if (abort && method === 'DELETE') {
      return this.pending.delete(abort[1] as string)
        ? new Response(null, { status: 204 })
        : json(404, { error: 'no_upload' });
    }
    if (key === 'GET /v1/snapshots') {
      const list = {
        snapshots: [...this.snapshots.values()]
          .sort((a, b) => b.sequence - a.sequence)
          .map((snapshot) => this.#view(snapshot)),
      };
      return json(200, this.tamper.list?.(list) ?? list);
    }
    const chunkDownload = /^\/v1\/snapshots\/(\d+)\/chunks\/(\d+)$/.exec(path);
    if (chunkDownload && method === 'GET') {
      const snapshot = this.snapshots.get(Number(chunkDownload[1]));
      const index = Number(chunkDownload[2]);
      const bytes = snapshot?.chunks[index];
      if (!snapshot || !bytes) return json(404, { error: 'no_chunk' });
      const served = this.tamper.chunkBytes?.(bytes, index) ?? bytes;
      const digest = createHash('sha256').update(bytes).digest('hex');
      return new Response(served, {
        status: 200,
        headers: {
          'x-vault-chunk-sha256':
            this.tamper.chunkHeader?.(digest, index) ?? digest,
        },
      });
    }
    const meta = /^\/v1\/snapshots\/(\d+)$/.exec(path);
    if (meta) {
      const snapshot = this.snapshots.get(Number(meta[1]));
      if (!snapshot) return json(404, { error: 'no_snapshot' });
      if (method === 'DELETE') {
        this.snapshots.delete(snapshot.sequence);
        return new Response(null, { status: 204 });
      }
      const view = this.#view(snapshot);
      return json(200, this.tamper.meta?.(view) ?? view);
    }
    return json(404, { error: 'not_found' });
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function relayWithSigner(maxChunkBytes?: number) {
  const identity = newSigner();
  const relay = new FakeRelay(identity.publicKey, maxChunkBytes);
  return { identity, relay };
}
