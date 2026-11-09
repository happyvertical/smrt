/**
 * Relay policy: per-account quotas, retention, and request bounds.
 *
 * Quotas and retention are owner decisions and have no defaults. The request
 * bounds are technical limits with defaults that match the snapshot format.
 */

/** Hard ceiling on one chunk, whatever the configuration says. */
export const MAX_CHUNK_BYTES_CEILING = 64 * 1024 * 1024;
/** Default chunk bound: one 8 MiB v1 vault envelope plus framing headroom. */
export const DEFAULT_MAX_CHUNK_BYTES = 8 * 1024 * 1024 + 64 * 1024;
/** Object keys allow at most six decimal digits for the chunk index. */
export const MAX_CHUNKS_PER_SNAPSHOT = 999_999;
export const DEFAULT_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
/**
 * How far above the account's sequence high-water mark one upload may begin
 * or commit. Sequences are chosen by the device, and a commit raises the mark
 * permanently, so an unbounded jump (one commit at 2^53-1) would make every
 * later upload `stale_sequence`. A device that makes a backup every few
 * minutes needs a few thousand sequences in a decade; 1000 per step leaves
 * room for a device that skipped sequences while offline. An owner decision
 * may raise it with `VAULT_RELAY_MAX_SEQUENCE_JUMP`.
 */
export const DEFAULT_MAX_SEQUENCE_JUMP = 1000;
/** Upper bound of a JSON request body (begin upload, device registration). */
export const MAX_JSON_BODY_BYTES = 4096;

export interface VaultRelayQuota {
  /** Bytes per account, counting committed snapshots and pending uploads. */
  maxBytes: number;
  /** Snapshots per account, counting pending uploads. */
  maxSnapshots: number;
}

export interface VaultRelayRetention {
  /** Always keep this many newest committed snapshots (at least 1). */
  keepLast: number;
  /** Also keep committed snapshots younger than this many milliseconds. */
  keepWithinMs: number;
}

export interface VaultRelayLimits {
  maxChunkBytes: number;
  uploadTtlMs: number;
  maxClockSkewMs: number;
  /** Largest `sequence - highWaterSequence` a begin or commit may carry. */
  maxSequenceJump: number;
}

export interface VaultRelayPolicy {
  quota: VaultRelayQuota;
  retention: VaultRelayRetention;
  limits: VaultRelayLimits;
}

export interface VaultRelayPolicyInput {
  quota: VaultRelayQuota;
  retention: VaultRelayRetention;
  limits?: Partial<VaultRelayLimits>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`vault relay: ${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`vault relay: ${name} must be a non-negative integer`);
  }
  return value;
}

/**
 * Validate and complete a policy. Retention must leave room for one upload
 * under the snapshot quota, or steady-state accounts could never back up.
 */
export function resolvePolicy(input: VaultRelayPolicyInput): VaultRelayPolicy {
  const quota = {
    maxBytes: positiveInteger(input.quota.maxBytes, 'quota.maxBytes'),
    maxSnapshots: positiveInteger(
      input.quota.maxSnapshots,
      'quota.maxSnapshots',
    ),
  };
  const retention = {
    keepLast: positiveInteger(input.retention.keepLast, 'retention.keepLast'),
    keepWithinMs: nonNegativeInteger(
      input.retention.keepWithinMs,
      'retention.keepWithinMs',
    ),
  };
  if (retention.keepLast >= quota.maxSnapshots) {
    throw new Error(
      'vault relay: retention.keepLast must be below quota.maxSnapshots so a new upload fits',
    );
  }
  const limits = {
    maxChunkBytes: positiveInteger(
      input.limits?.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES,
      'limits.maxChunkBytes',
    ),
    uploadTtlMs: positiveInteger(
      input.limits?.uploadTtlMs ?? DEFAULT_UPLOAD_TTL_MS,
      'limits.uploadTtlMs',
    ),
    maxClockSkewMs: positiveInteger(
      input.limits?.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS,
      'limits.maxClockSkewMs',
    ),
    maxSequenceJump: positiveInteger(
      input.limits?.maxSequenceJump ?? DEFAULT_MAX_SEQUENCE_JUMP,
      'limits.maxSequenceJump',
    ),
  };
  if (limits.maxChunkBytes > MAX_CHUNK_BYTES_CEILING) {
    throw new Error(
      `vault relay: limits.maxChunkBytes may not exceed ${MAX_CHUNK_BYTES_CEILING}`,
    );
  }
  return { quota, retention, limits };
}
