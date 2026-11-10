/**
 * Backup targets for encrypted snapshots (#4804).
 *
 * A target stores finished HVSF ciphertext (see `snapshot-framing.ts`) and
 * nothing else. Three implementations share this contract: a local directory
 * (`backup-target-file.ts`), the user's own Google Drive through the SDK files
 * provider (`backup-target-gdrive.ts`), and the blind vault relay
 * (`backup-target-vault.ts`). Contract and threat model:
 * `agents/backup-targets.md`.
 *
 * Invariants every target keeps:
 * - Only encrypted snapshots are accepted. {@link verifiedCiphertext} checks
 *   the clear HVSF header, the declared sequence, the byte count and the
 *   SHA-256 of the stream before a target publishes anything.
 * - An interrupted or failed upload is never visible to `list` or `get`.
 * - Errors carry a stable code and a fixed, secret-free message. Provider
 *   error text, tokens, signatures and key material never reach a message.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  EncryptedSnapshotError,
  parseSnapshotHeader,
  SNAPSHOT_HEADER_BYTES,
  type SnapshotHeader,
  snapshotHeaderLength,
} from './snapshot-framing.js';

/**
 * Parse the clear header once enough bytes are buffered: the fixed part
 * names the device ID length, so the whole header is longer than
 * {@link SNAPSHOT_HEADER_BYTES}. Returns `null` until it is complete and
 * throws {@link EncryptedSnapshotError} when the bytes are not a snapshot.
 */
export function parseBufferedSnapshotHeader(
  buffered: Uint8Array,
): { header: SnapshotHeader; length: number } | null {
  if (buffered.length < SNAPSHOT_HEADER_BYTES) return null;
  const length = snapshotHeaderLength(
    buffered.subarray(0, SNAPSHOT_HEADER_BYTES),
  );
  if (buffered.length < length) return null;
  return { header: parseSnapshotHeader(buffered.subarray(0, length)), length };
}

/** The three supported target kinds. */
export type BackupTargetKind = 'file' | 'gdrive' | 'vault';

/** Machine-readable failure categories. */
export type BackupTargetErrorCode =
  | 'invalid_config'
  | 'invalid_snapshot'
  | 'integrity'
  | 'already_exists'
  | 'not_found'
  | 'entitlement_required'
  | 'subscription_lapsed'
  | 'retention_expired'
  | 'credentials_unavailable'
  | 'scope_too_wide'
  | 'grant_expired'
  | 'quota_or_access'
  | 'limit'
  | 'protocol'
  | 'unauthorized'
  | 'stale_sequence'
  | 'must_restore_first'
  | 'lease_held'
  | 'lease_lost'
  | 'account_superseded'
  | 'account_mismatch'
  | 'last_snapshot'
  | 'head_snapshot'
  | 'position_unrecorded'
  | 'unavailable';

/**
 * Failure of a backup target. The message is fixed text chosen by this
 * package: never provider output, so it cannot carry a token or signature.
 */
export class BackupTargetError extends Error {
  readonly code: BackupTargetErrorCode;
  constructor(code: BackupTargetErrorCode, message: string) {
    super(message);
    this.name = 'BackupTargetError';
    this.code = code;
  }
}

/** One stored snapshot as a target reports it. */
export interface BackupObject {
  /** Target-local identifier; opaque to callers. */
  id: string;
  /** Snapshot sequence (from the object name or the relay's record). */
  sequence: bigint;
  byteSize: number;
  createdAt: Date;
  /** Hex SHA-256 of the ciphertext when the target records it. */
  sha256?: string;
}

/** A finished ciphertext to store. */
export interface BackupPutRequest {
  /** Sequence from the snapshot's own header; checked against the stream. */
  sequence: bigint;
  /** Exact ciphertext length. */
  byteSize: number;
  /** Lowercase hex SHA-256 of the whole ciphertext. */
  sha256: string;
  /** The ciphertext, streamed. Consumed once. */
  source: AsyncIterable<Uint8Array>;
}

/** Storage for encrypted snapshots. */
export interface BackupTarget {
  readonly name: string;
  readonly kind: BackupTargetKind;
  /**
   * Cheap checks that must pass before a snapshot is sealed and uploaded
   * (entitlement, credentials, scope). Spends no snapshot sequence.
   */
  preflight(): Promise<void>;
  /** Store a snapshot; it becomes visible only once complete and verified. */
  put(request: BackupPutRequest): Promise<BackupObject>;
  /** Stored snapshots, newest sequence first. */
  list(): Promise<BackupObject[]>;
  /**
   * Stream one snapshot's ciphertext. A consumer must discard what it read if
   * iteration throws: integrity is only proven once the stream ends.
   */
  get(id: string): AsyncIterable<Uint8Array>;
  /** Remove one snapshot. */
  delete(id: string): Promise<void>;
  /**
   * Release anything `preflight` or `put` acquired (the vault writer lease).
   * Optional; callers invoke it when finished, success or failure.
   */
  close?(): Promise<void>;
  /**
   * The vault account this target publishes into, for targets that belong to
   * one (the vault relay). The backup refuses to seal for any other account:
   * a key of another account must never land in this target's data line.
   */
  accountId?(): Promise<string>;
}

/** Retention applied per target. */
export interface BackupRetention {
  /** Newest snapshots always kept (at least 1). */
  keepLast: number;
  /** Also keep snapshots created within this many days (0 for none). */
  keepWithinDays?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Result of {@link planRetention}. */
export interface RetentionPlan {
  keep: BackupObject[];
  remove: BackupObject[];
}

/**
 * Decide what retention keeps. Order is by sequence, not by clock, so a skewed
 * clock cannot make the newest snapshot look old; the newest is always kept.
 * `protectIds` are kept regardless of rank (the object a backup just stored),
 * so a device whose sequence restarted below the target's maximum cannot have
 * its fresh upload removed as "oldest".
 */
export function planRetention(
  objects: readonly BackupObject[],
  retention: BackupRetention,
  now: number = Date.now(),
  protectIds: Iterable<string> = [],
): RetentionPlan {
  assertRetention(retention);
  const ordered = [...objects].sort((a, b) =>
    a.sequence === b.sequence ? 0 : a.sequence > b.sequence ? -1 : 1,
  );
  const cutoff = now - (retention.keepWithinDays ?? 0) * DAY_MS;
  const protectedIds = new Set(protectIds);
  const keep: BackupObject[] = [];
  const remove: BackupObject[] = [];
  for (const [index, object] of ordered.entries()) {
    const recent =
      (retention.keepWithinDays ?? 0) > 0 &&
      object.createdAt.getTime() >= cutoff;
    (index < retention.keepLast || recent || protectedIds.has(object.id)
      ? keep
      : remove
    ).push(object);
  }
  return { keep, remove };
}

/** Validate a retention policy; throws `invalid_config`. */
export function assertRetention(retention: BackupRetention): void {
  if (
    !retention ||
    !Number.isSafeInteger(retention.keepLast) ||
    retention.keepLast < 1 ||
    retention.keepLast > 10_000
  ) {
    throw new BackupTargetError(
      'invalid_config',
      'Retention keepLast must be a whole number from 1 to 10000.',
    );
  }
  const days = retention.keepWithinDays;
  if (
    days !== undefined &&
    (!Number.isSafeInteger(days) || days < 0 || days > 36_500)
  ) {
    throw new BackupTargetError(
      'invalid_config',
      'Retention keepWithinDays must be a whole number from 0 to 36500.',
    );
  }
}

const SEQUENCE_DIGITS = 20;
const OBJECT_NAME = /^snapshot-(\d{20})\.hvsnap$/;

/** Object name used by the file and Drive targets for a sequence. */
export function objectNameForSequence(sequence: bigint): string {
  if (typeof sequence !== 'bigint' || sequence < 0n) {
    throw new BackupTargetError(
      'invalid_snapshot',
      'Invalid snapshot sequence.',
    );
  }
  const digits = sequence.toString(10);
  if (digits.length > SEQUENCE_DIGITS) {
    throw new BackupTargetError(
      'invalid_snapshot',
      'Invalid snapshot sequence.',
    );
  }
  return `snapshot-${digits.padStart(SEQUENCE_DIGITS, '0')}.hvsnap`;
}

/** The sequence encoded in an object name, or `null` for any other name. */
export function sequenceFromObjectName(name: string): bigint | null {
  const match = OBJECT_NAME.exec(name);
  return match ? BigInt(match[1] as string) : null;
}

/** Newest sequence first. */
export function sortNewestFirst(objects: BackupObject[]): BackupObject[] {
  return objects.sort((a, b) =>
    a.sequence === b.sequence ? 0 : a.sequence > b.sequence ? -1 : 1,
  );
}

function asBytes(chunk: Uint8Array): Uint8Array {
  return chunk;
}

/**
 * Pass `request.source` through while proving it is the declared encrypted
 * snapshot. Nothing is yielded until the first bytes parse as a complete
 * HVSF v1 header (fixed part plus device ID) whose sequence equals `request.sequence`, so a
 * plaintext archive or export never reaches a target. After the last byte the
 * count and SHA-256 must match the declaration; the caller publishes only
 * after the generator finishes without throwing.
 */
export async function* verifiedCiphertext(
  request: BackupPutRequest,
): AsyncGenerator<Uint8Array> {
  const { byteSize, sha256 } = request;
  if (
    !Number.isSafeInteger(byteSize) ||
    byteSize < SNAPSHOT_HEADER_BYTES ||
    typeof sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new BackupTargetError(
      'invalid_snapshot',
      'The snapshot size or digest is invalid.',
    );
  }
  const hash = createHash('sha256');
  let total = 0;
  let validated = false;
  const head: Uint8Array[] = [];
  let headBytes = 0;

  /** Validate once the whole clear header is buffered; `false` if not yet. */
  const validate = (): boolean => {
    try {
      const buffered = parseBufferedSnapshotHeader(Buffer.concat(head));
      if (!buffered) return false;
      const parsed = buffered.header;
      if (parsed.sequence !== request.sequence) {
        throw new BackupTargetError(
          'invalid_snapshot',
          'The snapshot header does not carry the declared sequence.',
        );
      }
      if (byteSize <= buffered.length + parsed.totalLength) {
        throw new BackupTargetError(
          'invalid_snapshot',
          'The snapshot is shorter than its header requires.',
        );
      }
    } catch (error) {
      if (error instanceof BackupTargetError) throw error;
      if (error instanceof EncryptedSnapshotError) {
        throw new BackupTargetError(
          'invalid_snapshot',
          'Backup targets accept only encrypted snapshots.',
        );
      }
      throw error;
    }
    validated = true;
    return true;
  };

  for await (const raw of request.source) {
    const chunk = asBytes(raw);
    if (chunk.length === 0) continue;
    total += chunk.length;
    if (total > byteSize) {
      throw new BackupTargetError(
        'integrity',
        'The snapshot is longer than its declared size.',
      );
    }
    hash.update(chunk);
    if (validated) {
      yield chunk;
      continue;
    }
    head.push(chunk);
    headBytes += chunk.length;
    if (headBytes >= SNAPSHOT_HEADER_BYTES && validate()) {
      for (const part of head.splice(0)) yield part;
    }
  }
  if (!validated) {
    throw new BackupTargetError(
      'invalid_snapshot',
      'Backup targets accept only encrypted snapshots.',
    );
  }
  if (total !== byteSize || hash.digest('hex') !== sha256) {
    throw new BackupTargetError(
      'integrity',
      'The snapshot does not match its declared size and digest.',
    );
  }
}

/** Read a file as bounded chunks (for hashing and uploading a staged file). */
export function readFileChunks(
  path: string,
  highWaterMark = 1024 * 1024,
): AsyncIterable<Uint8Array> {
  return createReadStream(path, { highWaterMark });
}

/** Lowercase hex SHA-256 and length of a file, streamed. */
export async function digestFile(
  path: string,
): Promise<{ sha256: string; byteSize: number }> {
  const hash = createHash('sha256');
  let byteSize = 0;
  for await (const chunk of readFileChunks(path)) {
    hash.update(chunk);
    byteSize += chunk.length;
  }
  return { sha256: hash.digest('hex'), byteSize };
}

/** Re-chunk a stream into pieces of exactly `size` bytes (last may be short). */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  size: number,
): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  for await (const raw of source) {
    pending.push(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
    pendingBytes += raw.length;
    while (pendingBytes >= size) {
      const joined = Buffer.concat(pending, pendingBytes);
      yield Buffer.from(joined.subarray(0, size));
      const rest = joined.subarray(size);
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
    }
  }
  if (pendingBytes > 0) yield Buffer.concat(pending, pendingBytes);
}

/** Slice a buffer into bounded pieces for streaming `get` results. */
export function* sliceBuffer(
  bytes: Uint8Array,
  size = 1024 * 1024,
): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}
