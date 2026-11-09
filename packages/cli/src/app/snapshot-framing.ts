/**
 * Encrypted snapshot framing (HVSF v1, #4797).
 *
 * A v1 vault envelope from `@happyvertical/encryption/vault-snapshot` holds at
 * most 8 MiB, so a snapshot is a clear file header followed by
 * length-prefixed envelopes: one per plaintext chunk, then an authenticated
 * manifest. Every envelope binds account, device and snapshot sequence through
 * the envelope's own authenticated context, and its payload starts with an
 * exact copy of the file header (random snapshot ID, key generation, chunk
 * size, count and total length) plus the record type and index. Truncation,
 * reordering, duplication, cross-snapshot splicing, header edits and key
 * generation substitution therefore all fail authentication or a structural
 * check. Format, limits and failure modes: `agents/encrypted-snapshots.md`.
 *
 * Keys come from an injected {@link SnapshotKeyProvider}; this module never
 * stores or logs them. It derives one purpose subkey per operation
 * (HKDF-SHA256, info `smrt-hvsf-v1`) and seals and opens every envelope with
 * that subkey only, so an HVSF envelope never authenticates under the raw
 * vault data key or for another consumer of the same data key.
 */

import {
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  openVaultSnapshot,
  sealVaultSnapshot,
} from '@happyvertical/encryption/vault-snapshot';
import { errorCode } from './errors.js';
import { extractDataRootArchive } from './snapshot-archive.js';

/** What a snapshot's plaintext is. */
export type SnapshotKind = 'data-root' | 'export-bundle';

/** Authenticated envelope context shared by every record of one snapshot. */
export interface SnapshotContext {
  accountId: string;
  /** The device that produced the snapshot. */
  deviceId: string;
  /** Snapshot sequence; callers that need rollback protection track it. */
  sequence: bigint;
}

/**
 * Key and context for sealing one new snapshot. Ownership of `key` passes to
 * the framing, which zeroes it once the snapshot is written or fails.
 */
export interface SnapshotSealingKey extends SnapshotContext {
  /** Vault key generation (>= 1), recorded so rotated keys stay readable. */
  generation: bigint;
  /** 32 lowercase hex digits identifying `key`. */
  keyId: string;
  /** Raw 32-byte snapshot data key. */
  key: Uint8Array;
}

/**
 * Expected context for opening a snapshot. Only `accountId` is required (it
 * names the vault key). A restore on a new device, which has neither the
 * producing device ID nor the sequence, omits both and takes them from the
 * file; a caller that knows them (for example to enforce rollback protection)
 * passes them and the snapshot must match exactly.
 */
export interface SnapshotOpenContext {
  accountId: string;
  /** Producing device; defaults to the one recorded in the clear header. */
  deviceId?: string;
  /** Snapshot sequence; defaults to the clear header's (no rollback check). */
  sequence?: bigint;
}

/** Which key a stored snapshot needs. Values are read from its clear header. */
export interface SnapshotKeyReference {
  accountId: string;
  generation: bigint;
  keyId: string;
}

/**
 * Key custody seam. The vault key lifecycle (#4785) implements it; this
 * module only consumes it.
 */
export interface SnapshotKeyProvider {
  /** Current key, identity and a fresh sequence for one new snapshot. */
  sealingKey(): Promise<SnapshotSealingKey>;
  /**
   * The key for an existing generation, or `undefined` when this account has
   * no such key. Ownership of the returned bytes passes to the caller.
   */
  openingKey(reference: SnapshotKeyReference): Promise<Uint8Array | undefined>;
}

/** Failure of an encrypted snapshot integrity, format or key check. */
export class EncryptedSnapshotError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EncryptedSnapshotError';
  }
}

/** File extension used for default encrypted snapshot destinations. */
export const ENCRYPTED_SNAPSHOT_EXTENSION = '.hvsnap';
/**
 * Fixed part of the clear header. The producing device ID (1 to 255 UTF-8
 * bytes, length in the fixed part) follows it immediately.
 */
export const SNAPSHOT_HEADER_BYTES = 72;
/** Offset of the device ID length (u16) inside the fixed header. */
const HEADER_DEVICE_LENGTH_OFFSET = 6;
const MAX_DEVICE_ID_BYTES = 255;
/** Largest plaintext a v1 vault envelope accepts. */
const ENVELOPE_MAX_DECODED_BYTES = 8 * 1024 * 1024;
/**
 * Fixed header copy, record type and record index precede every payload. The
 * device ID is not copied: the envelope context authenticates it, and the
 * copied length bytes bind how much of the file it occupies.
 */
const PAYLOAD_PREFIX_BYTES = SNAPSHOT_HEADER_BYTES + 1 + 4;
/** Manifest payload: prefix, total length and SHA-256 digest. */
const MANIFEST_PAYLOAD_BYTES = PAYLOAD_PREFIX_BYTES + 8 + 32;
/** Largest plaintext chunk that still fits one envelope with its prefix. */
export const MAX_SNAPSHOT_CHUNK_BYTES =
  ENVELOPE_MAX_DECODED_BYTES - PAYLOAD_PREFIX_BYTES;
/** Smallest accepted chunk size; bounds the record count of a large file. */
export const MIN_SNAPSHOT_CHUNK_BYTES = 4096;
/** Default plaintext bytes per chunk. */
export const DEFAULT_SNAPSHOT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Largest snapshot plaintext (1 TiB). */
export const MAX_SNAPSHOT_TOTAL_BYTES = 2 ** 40;
const MAX_CHUNK_COUNT = 0xffff_ffff;
const MAX_UINT64 = (1n << 64n) - 1n;
/**
 * v1 envelope without payload or ID bytes: clear header, tag, then the
 * sealed message (header copy, two ID length bytes, sequence).
 */
const ENVELOPE_FIXED_BYTES = 47 + 16 + 47 + 1 + 1 + 8;
const ENVELOPE_KEY_ID_OFFSET = 7;
const MAGIC = Buffer.from('HVSF', 'ascii');
const FORMAT_VERSION = 1;
const RECORD_CHUNK = 1;
const RECORD_MANIFEST = 2;
const KIND_CODES: Record<SnapshotKind, number> = {
  'data-root': 1,
  'export-bundle': 2,
};
const KEY_ID_PATTERN = /^[0-9a-f]{32}$/;
const KEY_BYTES = 32;
/** HKDF `info` that binds the derived subkey to HVSF v1. */
export const SNAPSHOT_SUBKEY_INFO = 'smrt-hvsf-v1';

/** Parsed clear header. Trust it only after {@link decryptSnapshot} succeeds. */
export interface SnapshotHeader {
  formatVersion: 1;
  kind: SnapshotKind;
  generation: bigint;
  sequence: bigint;
  /** Producing device; lets a new device restore from the file alone. */
  deviceId: string;
  keyId: string;
  /** 32 hex digits, random per snapshot. */
  snapshotId: string;
  chunkSize: number;
  chunkCount: number;
  totalLength: number;
}

/** Summary of a written or verified snapshot. Carries no secret values. */
export interface EncryptedSnapshotSummary {
  format: 'hvsf-v1';
  kind: SnapshotKind;
  generation: string;
  sequence: string;
  /** Device that produced the snapshot (clear in the file header). */
  deviceId: string;
  keyId: string;
  snapshotId: string;
  chunkCount: number;
  totalLength: number;
  /** SHA-256 of the plaintext, hex. */
  digest: string;
}

function contextIdBytes(value: unknown, label: string): number {
  if (typeof value !== 'string') {
    throw new EncryptedSnapshotError(`Snapshot ${label} must be a string`);
  }
  const length = Buffer.byteLength(value, 'utf8');
  if (length < 1 || length > MAX_DEVICE_ID_BYTES) {
    throw new EncryptedSnapshotError(
      `Snapshot ${label} must be 1 to 255 UTF-8 bytes`,
    );
  }
  return length;
}

/** A device ID is stored in the clear and printed, so no control characters. */
function deviceIdBytes(value: unknown): number {
  const length = contextIdBytes(value, 'device ID');
  if (/\p{Cc}/u.test(value as string)) {
    throw new EncryptedSnapshotError(
      'Snapshot device ID must not contain control characters',
    );
  }
  return length;
}

function assertUint64(value: unknown, label: string, minimum = 0n): bigint {
  if (typeof value !== 'bigint' || value < minimum || value > MAX_UINT64) {
    throw new EncryptedSnapshotError(`Snapshot ${label} is out of range`);
  }
  return value;
}

function assertContext(context: SnapshotContext): number {
  if (!context || typeof context !== 'object') {
    throw new EncryptedSnapshotError('Snapshot context is required');
  }
  assertUint64(context.sequence, 'sequence');
  return (
    contextIdBytes(context.accountId, 'account ID') +
    deviceIdBytes(context.deviceId)
  );
}

function assertKey(key: unknown): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    throw new EncryptedSnapshotError('Snapshot key must be 32 bytes');
  }
  return key;
}

/**
 * Derive the HVSF v1 purpose subkey from a raw vault data key (HKDF-SHA256,
 * empty salt, info `smrt-hvsf-v1`). The caller zeroes the result.
 */
export function deriveSnapshotSubkey(dataKey: Uint8Array): Uint8Array {
  return new Uint8Array(
    hkdfSync(
      'sha256',
      assertKey(dataKey),
      Buffer.alloc(0),
      SNAPSHOT_SUBKEY_INFO,
      KEY_BYTES,
    ),
  );
}

function chunkCountFor(totalLength: number, chunkSize: number): number {
  return Math.ceil(totalLength / chunkSize);
}

function chunkLength(header: SnapshotHeader, index: number): number {
  return index < header.chunkCount - 1
    ? header.chunkSize
    : header.totalLength - header.chunkSize * (header.chunkCount - 1);
}

/** Fixed 72-byte part of the clear header. */
function encodeHeader(header: SnapshotHeader): Buffer {
  const bytes = Buffer.alloc(SNAPSHOT_HEADER_BYTES);
  MAGIC.copy(bytes, 0);
  bytes[4] = FORMAT_VERSION;
  bytes[5] = KIND_CODES[header.kind];
  bytes.writeUInt16BE(
    Buffer.byteLength(header.deviceId, 'utf8'),
    HEADER_DEVICE_LENGTH_OFFSET,
  );
  bytes.writeBigUInt64BE(header.generation, 8);
  bytes.writeBigUInt64BE(header.sequence, 16);
  Buffer.from(header.keyId, 'hex').copy(bytes, 24);
  Buffer.from(header.snapshotId, 'hex').copy(bytes, 40);
  bytes.writeUInt32BE(header.chunkSize, 56);
  bytes.writeUInt32BE(header.chunkCount, 60);
  bytes.writeBigUInt64BE(BigInt(header.totalLength), 64);
  return bytes;
}

/**
 * Total clear header length (fixed part plus device ID) declared by the first
 * {@link SNAPSHOT_HEADER_BYTES} bytes of a file. Bounds-checked here so a
 * caller can read the rest of the header without trusting the file further.
 */
export function snapshotHeaderLength(fixed: Uint8Array): number {
  const bytes = Buffer.from(fixed.buffer, fixed.byteOffset, fixed.length);
  if (
    bytes.length < SNAPSHOT_HEADER_BYTES ||
    !bytes.subarray(0, 4).equals(MAGIC)
  ) {
    throw new EncryptedSnapshotError('Not an encrypted SMRT snapshot');
  }
  const deviceLength = bytes.readUInt16BE(HEADER_DEVICE_LENGTH_OFFSET);
  if (deviceLength < 1 || deviceLength > MAX_DEVICE_ID_BYTES) {
    throw new EncryptedSnapshotError('Snapshot device ID length is invalid');
  }
  return SNAPSHOT_HEADER_BYTES + deviceLength;
}

/**
 * Parse and bound-check a clear header: the fixed part plus the device ID,
 * exactly {@link snapshotHeaderLength} bytes. Every limit is checked here,
 * before any allocation that depends on the header.
 */
export function parseSnapshotHeader(bytes: Uint8Array): SnapshotHeader {
  const header = Buffer.from(bytes);
  if (
    header.length < SNAPSHOT_HEADER_BYTES ||
    !header.subarray(0, 4).equals(MAGIC)
  ) {
    throw new EncryptedSnapshotError('Not an encrypted SMRT snapshot');
  }
  if (header[4] !== FORMAT_VERSION) {
    throw new EncryptedSnapshotError('Unsupported encrypted snapshot format');
  }
  if (header.length !== snapshotHeaderLength(header)) {
    throw new EncryptedSnapshotError('Snapshot header length is invalid');
  }
  let deviceId: string;
  try {
    deviceId = new TextDecoder('utf-8', { fatal: true }).decode(
      header.subarray(SNAPSHOT_HEADER_BYTES),
    );
    deviceIdBytes(deviceId);
  } catch (error) {
    if (error instanceof EncryptedSnapshotError) throw error;
    throw new EncryptedSnapshotError('Snapshot device ID is not valid UTF-8');
  }
  const kind = (Object.keys(KIND_CODES) as SnapshotKind[]).find(
    (candidate) => KIND_CODES[candidate] === header[5],
  );
  if (!kind) {
    throw new EncryptedSnapshotError('Unsupported encrypted snapshot kind');
  }
  const generation = header.readBigUInt64BE(8);
  const chunkSize = header.readUInt32BE(56);
  const chunkCount = header.readUInt32BE(60);
  const total = header.readBigUInt64BE(64);
  if (generation < 1n) {
    throw new EncryptedSnapshotError('Invalid snapshot key generation');
  }
  if (
    chunkSize < MIN_SNAPSHOT_CHUNK_BYTES ||
    chunkSize > MAX_SNAPSHOT_CHUNK_BYTES
  ) {
    throw new EncryptedSnapshotError('Snapshot chunk size is out of range');
  }
  if (total > BigInt(MAX_SNAPSHOT_TOTAL_BYTES)) {
    throw new EncryptedSnapshotError('Snapshot exceeds the supported size');
  }
  const totalLength = Number(total);
  if (chunkCount !== chunkCountFor(totalLength, chunkSize)) {
    throw new EncryptedSnapshotError(
      'Snapshot chunk count does not match its length',
    );
  }
  return {
    formatVersion: 1,
    kind,
    generation,
    sequence: header.readBigUInt64BE(16),
    deviceId,
    keyId: header.subarray(24, 40).toString('hex'),
    snapshotId: header.subarray(40, 56).toString('hex'),
    chunkSize,
    chunkCount,
    totalLength,
  };
}

function summary(header: SnapshotHeader, digest: string) {
  return {
    format: 'hvsf-v1',
    kind: header.kind,
    generation: header.generation.toString(),
    sequence: header.sequence.toString(),
    deviceId: header.deviceId,
    keyId: header.keyId,
    snapshotId: header.snapshotId,
    chunkCount: header.chunkCount,
    totalLength: header.totalLength,
    digest,
  } satisfies EncryptedSnapshotSummary;
}

function temporarySibling(path: string, suffix: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}.${suffix}`,
  );
}

/** Publish `temporary` at `destination` without ever replacing a file. */
async function publishFile(
  temporary: string,
  destination: string,
  label: string,
): Promise<void> {
  try {
    await link(temporary, destination);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw new Error(`${label} already exists: ${destination}`);
    }
    throw error;
  }
}

/** Write every byte; `FileHandle.write` may write fewer than requested. */
async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.length - offset,
    );
    if (bytesWritten <= 0) {
      throw new EncryptedSnapshotError('Encrypted snapshot write failed');
    }
    offset += bytesWritten;
  }
}

/** Options for {@link writeEncryptedSnapshot}. */
export interface WriteEncryptedSnapshotOptions {
  /** New file; never replaced. Parent directories are created 0700. */
  destination: string;
  kind: SnapshotKind;
  /** Exact plaintext length `source` yields. */
  totalLength: number;
  /** Plaintext, streamed. Buffers are copied; the caller may reuse them. */
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  sealing: SnapshotSealingKey;
  chunkSize?: number;
  /** Label for the "already exists" error. */
  label?: string;
}

/**
 * Stream `source` into a new encrypted snapshot file. Only ciphertext ever
 * touches disk: the owner-only temporary file is published with `link()` and
 * removed on success or failure. Memory use is one chunk plus one envelope.
 */
export async function writeEncryptedSnapshot(
  options: WriteEncryptedSnapshotOptions,
): Promise<EncryptedSnapshotSummary> {
  const { sealing } = options;
  try {
    const dataKey = assertKey(sealing?.key);
    assertContext(sealing);
    const generation = assertUint64(sealing.generation, 'key generation', 1n);
    if (
      typeof sealing.keyId !== 'string' ||
      !KEY_ID_PATTERN.test(sealing.keyId)
    ) {
      throw new EncryptedSnapshotError(
        'Snapshot key ID must be 32 lowercase hex digits',
      );
    }
    const chunkSize = options.chunkSize ?? DEFAULT_SNAPSHOT_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(chunkSize) ||
      chunkSize < MIN_SNAPSHOT_CHUNK_BYTES ||
      chunkSize > MAX_SNAPSHOT_CHUNK_BYTES
    ) {
      throw new EncryptedSnapshotError('Snapshot chunk size is out of range');
    }
    const { totalLength } = options;
    if (
      !Number.isSafeInteger(totalLength) ||
      totalLength < 0 ||
      totalLength > MAX_SNAPSHOT_TOTAL_BYTES
    ) {
      throw new EncryptedSnapshotError('Snapshot exceeds the supported size');
    }
    const chunkCount = chunkCountFor(totalLength, chunkSize);
    if (chunkCount > MAX_CHUNK_COUNT) {
      throw new EncryptedSnapshotError('Snapshot has too many chunks');
    }
    const header: SnapshotHeader = {
      formatVersion: 1,
      kind: options.kind,
      generation,
      sequence: sealing.sequence,
      deviceId: sealing.deviceId,
      keyId: sealing.keyId,
      snapshotId: randomBytes(16).toString('hex'),
      chunkSize,
      chunkCount,
      totalLength,
    };
    if (!Object.hasOwn(KIND_CODES, options.kind)) {
      throw new EncryptedSnapshotError('Unsupported encrypted snapshot kind');
    }
    const headerBytes = encodeHeader(header);
    const context = {
      accountId: sealing.accountId,
      deviceId: sealing.deviceId,
      sequence: sealing.sequence,
    };

    await mkdir(dirname(options.destination), { recursive: true, mode: 0o700 });
    const temporary = temporarySibling(options.destination, 'tmp');
    const key = deriveSnapshotSubkey(dataKey);
    const payload = Buffer.alloc(PAYLOAD_PREFIX_BYTES + chunkSize);
    headerBytes.copy(payload, 0);
    payload[SNAPSHOT_HEADER_BYTES] = RECORD_CHUNK;
    const hash = createHash('sha256');
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      const output = handle;
      const deviceBytes = Buffer.from(sealing.deviceId, 'utf8');
      await writeAll(output, headerBytes);
      await writeAll(output, deviceBytes);
      let written = headerBytes.length + deviceBytes.length;
      const writeRecord = async (plaintext: Uint8Array) => {
        const envelope = sealVaultSnapshot(plaintext, {
          key,
          keyId: sealing.keyId,
          context,
        });
        const length = Buffer.alloc(4);
        length.writeUInt32BE(envelope.length, 0);
        await writeAll(output, length);
        await writeAll(output, envelope);
        written += 4 + envelope.length;
      };

      let index = 0;
      let filled = 0;
      let received = 0;
      const flush = async () => {
        payload.writeUInt32BE(index, SNAPSHOT_HEADER_BYTES + 1);
        await writeRecord(payload.subarray(0, PAYLOAD_PREFIX_BYTES + filled));
        index += 1;
        filled = 0;
      };
      for await (const piece of options.source) {
        const bytes = Buffer.from(piece.buffer, piece.byteOffset, piece.length);
        received += bytes.length;
        if (received > totalLength) {
          throw new EncryptedSnapshotError(
            'Snapshot source is longer than declared',
          );
        }
        hash.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const take = Math.min(chunkSize - filled, bytes.length - offset);
          bytes.copy(
            payload,
            PAYLOAD_PREFIX_BYTES + filled,
            offset,
            offset + take,
          );
          filled += take;
          offset += take;
          if (filled === chunkSize) await flush();
        }
      }
      if (received !== totalLength) {
        throw new EncryptedSnapshotError(
          'Snapshot source is shorter than declared',
        );
      }
      if (filled > 0) await flush();
      if (index !== chunkCount) {
        throw new EncryptedSnapshotError('Snapshot chunk count mismatch');
      }
      const digest = hash.digest();
      const manifest = Buffer.alloc(MANIFEST_PAYLOAD_BYTES);
      headerBytes.copy(manifest, 0);
      manifest[SNAPSHOT_HEADER_BYTES] = RECORD_MANIFEST;
      manifest.writeUInt32BE(chunkCount, SNAPSHOT_HEADER_BYTES + 1);
      manifest.writeBigUInt64BE(BigInt(totalLength), PAYLOAD_PREFIX_BYTES);
      digest.copy(manifest, PAYLOAD_PREFIX_BYTES + 8);
      await writeRecord(manifest);
      await output.sync();
      if ((await output.stat()).size !== written) {
        throw new EncryptedSnapshotError('Encrypted snapshot write was short');
      }
      await output.close();
      handle = undefined;
      await publishFile(
        temporary,
        options.destination,
        options.label ?? 'Snapshot destination',
      );
      return summary(header, digest.toString('hex'));
    } finally {
      payload.fill(0);
      key.fill(0);
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
    }
  } finally {
    if (sealing?.key instanceof Uint8Array) sealing.key.fill(0);
  }
}

/** Options shared by {@link verifySnapshot} and {@link decryptSnapshot}. */
export interface OpenSnapshotOptions {
  /** Encrypted snapshot file. */
  source: string;
  /**
   * Trusted expected context, supplied independently of the file. Device and
   * sequence are optional; see {@link SnapshotOpenContext}.
   */
  context: SnapshotOpenContext;
  keys: Pick<SnapshotKeyProvider, 'openingKey'>;
  /** Reject snapshots sealed with an older key generation. */
  minimumGeneration?: bigint;
  /** Reject a snapshot of a different kind. */
  expectedKind?: SnapshotKind;
}

async function readExact(
  handle: FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      length - offset,
      position + offset,
    );
    if (bytesRead === 0) {
      throw new EncryptedSnapshotError('Encrypted snapshot is truncated');
    }
    offset += bytesRead;
  }
  return buffer;
}

/**
 * Authenticate a snapshot record by record. Yields plaintext chunks in order;
 * the manifest is verified when the iterator finishes, so a consumer must
 * drain it before treating the plaintext as complete.
 */
async function* openSnapshotChunks(
  options: OpenSnapshotOptions,
  onHeader: (header: SnapshotHeader) => void,
): AsyncGenerator<Buffer, string> {
  if (!options.context || typeof options.context !== 'object') {
    throw new EncryptedSnapshotError('Snapshot context is required');
  }
  const accountBytes = contextIdBytes(options.context.accountId, 'account ID');
  if (options.context.deviceId !== undefined) {
    deviceIdBytes(options.context.deviceId);
  }
  if (options.context.sequence !== undefined) {
    assertUint64(options.context.sequence, 'sequence');
  }
  const handle = await open(options.source, 'r');
  let key: Uint8Array | undefined;
  let openingKey: Uint8Array | undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new EncryptedSnapshotError('Encrypted snapshot must be a file');
    }
    if (stat.size < SNAPSHOT_HEADER_BYTES) {
      throw new EncryptedSnapshotError('Not an encrypted SMRT snapshot');
    }
    const fixedBytes = await readExact(handle, SNAPSHOT_HEADER_BYTES, 0);
    const headerLength = snapshotHeaderLength(fixedBytes);
    if (stat.size < headerLength) {
      throw new EncryptedSnapshotError('Encrypted snapshot is truncated');
    }
    const header = parseSnapshotHeader(
      Buffer.concat([
        fixedBytes,
        await readExact(
          handle,
          headerLength - SNAPSHOT_HEADER_BYTES,
          SNAPSHOT_HEADER_BYTES,
        ),
      ]),
    );
    if (
      options.context.deviceId !== undefined &&
      options.context.deviceId !== header.deviceId
    ) {
      throw new EncryptedSnapshotError('Snapshot device does not match');
    }
    if (
      options.context.sequence !== undefined &&
      options.context.sequence !== header.sequence
    ) {
      throw new EncryptedSnapshotError('Snapshot sequence does not match');
    }
    const headerBytes = fixedBytes;
    const contextBytes =
      accountBytes + Buffer.byteLength(header.deviceId, 'utf8');
    if (
      options.minimumGeneration !== undefined &&
      header.generation < options.minimumGeneration
    ) {
      throw new EncryptedSnapshotError(
        'Snapshot key generation is older than allowed',
      );
    }
    if (options.expectedKind && header.kind !== options.expectedKind) {
      throw new EncryptedSnapshotError('Snapshot kind does not match');
    }
    const envelopeOverhead = ENVELOPE_FIXED_BYTES + contextBytes;
    let expectedSize =
      headerLength + 4 + envelopeOverhead + MANIFEST_PAYLOAD_BYTES;
    if (header.chunkCount > 0) {
      expectedSize +=
        header.chunkCount * (4 + envelopeOverhead + PAYLOAD_PREFIX_BYTES) +
        header.totalLength;
    }
    if (stat.size !== expectedSize) {
      throw new EncryptedSnapshotError(
        'Encrypted snapshot length does not match its header',
      );
    }
    onHeader(header);

    key = await options.keys.openingKey({
      accountId: options.context.accountId,
      generation: header.generation,
      keyId: header.keyId,
    });
    if (key === undefined) {
      throw new EncryptedSnapshotError(
        'No key is available for this snapshot generation',
      );
    }
    const subkey = deriveSnapshotSubkey(assertKey(key));
    openingKey = subkey;
    const keyIdBytes = headerBytes.subarray(24, 40);
    // The clear device and sequence are only a starting point: the envelope
    // context authenticates them, so an edited header fails to open.
    const context = {
      accountId: options.context.accountId,
      deviceId: header.deviceId,
      sequence: header.sequence,
    };
    let position = headerLength;
    const openRecord = async (
      index: number,
      payloadLength: number,
    ): Promise<Uint8Array> => {
      const declared = (await readExact(handle, 4, position)).readUInt32BE(0);
      const expectedLength = envelopeOverhead + payloadLength;
      if (declared !== expectedLength) {
        throw new EncryptedSnapshotError(
          `Encrypted snapshot record ${index} has an invalid length`,
        );
      }
      const envelope = await readExact(handle, declared, position + 4);
      position += 4 + declared;
      if (
        !envelope
          .subarray(ENVELOPE_KEY_ID_OFFSET, ENVELOPE_KEY_ID_OFFSET + 16)
          .equals(keyIdBytes)
      ) {
        throw new EncryptedSnapshotError(
          `Encrypted snapshot record ${index} uses a different key`,
        );
      }
      let payload: Uint8Array;
      try {
        payload = openVaultSnapshot(envelope, {
          context,
          resolveKey: (recordKeyId) =>
            recordKeyId === header.keyId ? subkey : undefined,
        });
      } catch (error) {
        throw new EncryptedSnapshotError(
          `Encrypted snapshot record ${index} failed authentication`,
          { cause: error },
        );
      }
      const prefix = Buffer.from(
        payload.buffer,
        payload.byteOffset,
        payload.length,
      );
      if (
        prefix.length !== payloadLength ||
        !prefix.subarray(0, SNAPSHOT_HEADER_BYTES).equals(headerBytes)
      ) {
        payload.fill(0);
        throw new EncryptedSnapshotError(
          `Encrypted snapshot record ${index} belongs to a different snapshot`,
        );
      }
      return payload;
    };

    const hash = createHash('sha256');
    for (let index = 0; index < header.chunkCount; index += 1) {
      const length = chunkLength(header, index);
      const payload = Buffer.from(
        await openRecord(index, PAYLOAD_PREFIX_BYTES + length),
      );
      try {
        if (
          payload[SNAPSHOT_HEADER_BYTES] !== RECORD_CHUNK ||
          payload.readUInt32BE(SNAPSHOT_HEADER_BYTES + 1) !== index
        ) {
          throw new EncryptedSnapshotError(
            `Encrypted snapshot chunk ${index} is out of order`,
          );
        }
        const data = payload.subarray(PAYLOAD_PREFIX_BYTES);
        hash.update(data);
        yield data;
      } finally {
        payload.fill(0);
      }
    }
    const manifest = Buffer.from(
      await openRecord(header.chunkCount, MANIFEST_PAYLOAD_BYTES),
    );
    const digest = hash.digest();
    if (
      manifest[SNAPSHOT_HEADER_BYTES] !== RECORD_MANIFEST ||
      manifest.readUInt32BE(SNAPSHOT_HEADER_BYTES + 1) !== header.chunkCount ||
      manifest.readBigUInt64BE(PAYLOAD_PREFIX_BYTES) !==
        BigInt(header.totalLength) ||
      !timingSafeEqual(manifest.subarray(PAYLOAD_PREFIX_BYTES + 8), digest)
    ) {
      throw new EncryptedSnapshotError(
        'Encrypted snapshot manifest does not match its contents',
      );
    }
    if (position !== stat.size) {
      throw new EncryptedSnapshotError('Encrypted snapshot has trailing bytes');
    }
    return digest.toString('hex');
  } finally {
    if (key instanceof Uint8Array) key.fill(0);
    openingKey?.fill(0);
    await handle.close();
  }
}

/**
 * Read a snapshot's clear header (including the producing device ID) without
 * authenticating it. Treat every field as a hint until a restore succeeds.
 */
export async function readSnapshotHeader(
  source: string,
): Promise<SnapshotHeader> {
  const handle = await open(source, 'r');
  try {
    const fixed = await readExact(handle, SNAPSHOT_HEADER_BYTES, 0);
    const length = snapshotHeaderLength(fixed);
    return parseSnapshotHeader(
      Buffer.concat([
        fixed,
        await readExact(
          handle,
          length - SNAPSHOT_HEADER_BYTES,
          SNAPSHOT_HEADER_BYTES,
        ),
      ]),
    );
  } finally {
    await handle.close();
  }
}

async function drain(
  chunks: AsyncGenerator<Buffer, string>,
  consume: (chunk: Buffer) => Promise<void> | void,
): Promise<string> {
  for (;;) {
    const next = await chunks.next();
    if (next.done) return next.value;
    await consume(next.value);
  }
}

/** Authenticate a whole snapshot without writing any plaintext. */
export async function verifySnapshot(
  options: OpenSnapshotOptions,
): Promise<EncryptedSnapshotSummary> {
  let header: SnapshotHeader | undefined;
  const digest = await drain(
    openSnapshotChunks(options, (parsed) => {
      header = parsed;
    }),
    () => undefined,
  );
  return summary(header as SnapshotHeader, digest);
}

/** Options for {@link decryptSnapshot}. */
export interface DecryptSnapshotOptions extends OpenSnapshotOptions {
  /**
   * Candidate path that must not exist: a new 0700 directory for a
   * `data-root` snapshot, a new 0600 file for an `export-bundle` snapshot.
   * It never replaces or swaps a live state root.
   */
  destination: string;
}

/**
 * Stream a snapshot's plaintext into a new restore candidate. Plaintext is
 * staged in an owner-only sibling and published only after every record and
 * the manifest authenticate; any failure removes the staging path, so no
 * partial restore is ever visible at `destination`.
 */
export async function decryptSnapshot(
  options: DecryptSnapshotOptions,
): Promise<EncryptedSnapshotSummary & { destination: string }> {
  const { destination } = options;
  await assertAbsent(destination);
  let header: SnapshotHeader | undefined;
  const chunks = openSnapshotChunks(options, (parsed) => {
    header = parsed;
  });
  // Pull the header first so the staging shape follows the snapshot kind.
  const first = await chunks.next();
  const parsed = header as SnapshotHeader;
  const staging = temporarySibling(destination, 'partial');
  let staged = false;
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    async function* remaining(): AsyncGenerator<Buffer, string> {
      if (first.done) return first.value;
      yield first.value;
      return yield* chunks;
    }
    let digest: string;
    if (parsed.kind === 'data-root') {
      await mkdir(staging, { mode: 0o700 });
      staged = true;
      digest = await extractDataRootArchive(remaining(), staging);
      await assertAbsent(destination);
      await rename(staging, destination);
    } else {
      const handle = await open(staging, 'wx', 0o600);
      staged = true;
      try {
        digest = await drain(remaining(), async (chunk) => {
          await writeAll(handle, chunk);
        });
        await handle.sync();
        if ((await handle.stat()).size !== parsed.totalLength) {
          throw new EncryptedSnapshotError('Restore write was short');
        }
      } finally {
        await handle.close();
      }
      await publishFile(staging, destination, 'Restore destination');
      await unlink(staging);
    }
    staged = false;
    return { ...summary(parsed, digest), destination };
  } catch (error) {
    await chunks.return('').catch(() => undefined);
    throw error;
  } finally {
    if (staged) await rm(staging, { recursive: true, force: true });
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw error;
  }
  throw new Error(`Restore destination already exists: ${path}`);
}
