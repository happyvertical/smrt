/**
 * Primary-writer lease (#4805): one row per account naming the device that
 * may publish, a fencing token, and the account's head sequence.
 *
 * `head_sequence` is the sequence the account's data line is at. Only the
 * lease holder advances it (at commit, before the snapshot is published), so
 * holding a current token means the holder's local root is at the head. Every
 * lease decision is one conditional statement on this row, which serializes
 * acquire, renew, release, revoke and the commit-time head advance on SQLite
 * and PostgreSQL alike.
 *
 * A *hole* is a head whose upload never committed (aborted or expired after
 * the head advanced). Committed snapshots at or above the head, and the latest
 * committed snapshot, can never be deleted (see
 * {@link VaultRelayLeaseStore.deleteCommittedBelowHead}), so a missing row at
 * the head is always a hole, and acquire then accepts the latest committed
 * sequence as the base.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { toSafeInteger } from './encoding.js';
import type { SnapshotRecord } from './metadata-store.js';

export const VAULT_RELAY_LEASE_TABLES = [
  'vault_relay_leases',
  'vault_relay_upload_fences',
] as const;

const SCHEMA_LEASES_V1 = [
  `CREATE TABLE IF NOT EXISTS vault_relay_leases (
    account_id TEXT PRIMARY KEY,
    holder_device_id TEXT,
    fencing_token BIGINT NOT NULL DEFAULT 0,
    head_sequence BIGINT NOT NULL DEFAULT 0,
    expires_at BIGINT NOT NULL DEFAULT 0,
    acquired_at BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS vault_relay_upload_fences (
    upload_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    fencing_token BIGINT NOT NULL
  )`,
];

/**
 * Create the lease tables. Idempotent; run from the deployment's migration
 * step together with `migrateVaultRelayV1`.
 */
export async function migrateVaultRelayLeasesV1(
  db: DatabaseInterface,
): Promise<void> {
  for (const statement of SCHEMA_LEASES_V1) {
    await db.query(statement);
  }
}

/** Current lease state of one account. */
export interface LeaseRecord {
  accountId: string;
  holderDeviceId: string | null;
  fencingToken: number;
  headSequence: number;
  expiresAt: number;
}

/** A granted or renewed lease. */
export interface LeaseGrant {
  fencingToken: number;
  expiresAt: number;
  headSequence: number;
}

type Row = Record<string, unknown>;

function leaseFromRow(row: Row): LeaseRecord {
  return {
    accountId: String(row.account_id),
    holderDeviceId:
      row.holder_device_id === null || row.holder_device_id === undefined
        ? null
        : String(row.holder_device_id),
    fencingToken: toSafeInteger(row.fencing_token, 'fencing_token'),
    headSequence: toSafeInteger(row.head_sequence, 'head_sequence'),
    expiresAt: toSafeInteger(row.expires_at, 'expires_at'),
  };
}

const HEAD_ROW = `SELECT 1 FROM vault_relay_snapshots s
  WHERE s.account_id = vault_relay_leases.account_id
    AND s.sequence = vault_relay_leases.head_sequence`;
const LATEST_COMMITTED = `SELECT COALESCE(MAX(c.sequence), 0)
  FROM vault_relay_snapshots c
 WHERE c.account_id = vault_relay_leases.account_id
   AND c.status = 'committed'`;

/** Typed access to the lease tables. */
export class VaultRelayLeaseStore {
  readonly db: DatabaseInterface;

  constructor(db: DatabaseInterface) {
    this.db = db;
  }

  /**
   * Create the account's lease row if missing, with no holder and the head at
   * the account's published high-water mark (publishing always needs the
   * lease, so no upload can be in flight before the row exists). When the
   * newest published snapshots were deleted before the lease existed, the
   * head is then a hole and acquire accepts the latest committed base.
   */
  async ensureLease(accountId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO vault_relay_leases
         (account_id, holder_device_id, fencing_token, head_sequence, expires_at, acquired_at)
       SELECT ?, NULL, 0,
              COALESCE((SELECT high_water_sequence FROM vault_relay_accounts
                         WHERE account_id = ?), 0),
              0, NULL
        WHERE 1 = 1
       ON CONFLICT (account_id) DO NOTHING`,
      accountId,
      accountId,
    );
  }

  async getLease(accountId: string): Promise<LeaseRecord | null> {
    const found = await this.db.query(
      `SELECT account_id, holder_device_id, fencing_token, head_sequence, expires_at
         FROM vault_relay_leases WHERE account_id = ?`,
      accountId,
    );
    return found.rows[0] ? leaseFromRow(found.rows[0]) : null;
  }

  /** Latest committed sequence of the account (0 when none). */
  async latestCommittedSequence(accountId: string): Promise<number> {
    const found = await this.db.query(
      `SELECT COALESCE(MAX(sequence), 0) AS latest FROM vault_relay_snapshots
        WHERE account_id = ? AND status = 'committed'`,
      accountId,
    );
    return toSafeInteger(found.rows[0]?.latest ?? 0, 'latest');
  }

  /** Status of the snapshot row at `sequence`, or `null` when none exists. */
  async snapshotStatusAt(
    accountId: string,
    sequence: number,
  ): Promise<SnapshotRecord['status'] | null> {
    const found = await this.db.query(
      'SELECT status FROM vault_relay_snapshots WHERE account_id = ? AND sequence = ?',
      accountId,
      sequence,
    );
    const status = found.rows[0]?.status;
    if (status === undefined) return null;
    return status === 'committed' ? 'committed' : 'pending';
  }

  /**
   * Grant the lease to `deviceId`, in one statement, when it is free, expired
   * or already this device's, and the device's `baseSequence` is the head:
   * either the head itself with no publish in flight, or, for a hole, the
   * latest committed sequence. Every grant increments the fencing token, so a
   * re-acquire also fences an earlier process on the same device.
   */
  async acquire(
    accountId: string,
    deviceId: string,
    baseSequence: number,
    now: number,
    expiresAt: number,
  ): Promise<LeaseGrant | null> {
    const updated = await this.db.query(
      `UPDATE vault_relay_leases
          SET holder_device_id = ?, fencing_token = fencing_token + 1,
              expires_at = ?, acquired_at = ?
        WHERE account_id = ?
          AND (holder_device_id IS NULL OR holder_device_id = ? OR expires_at <= ?)
          AND EXISTS (SELECT 1 FROM vault_relay_devices d
                       WHERE d.account_id = vault_relay_leases.account_id
                         AND d.device_id = ? AND d.status = 'active')
          AND (
            (head_sequence = ?
              AND NOT EXISTS (${HEAD_ROW} AND s.status = 'pending'))
            OR
            (NOT EXISTS (${HEAD_ROW})
              AND ? = (${LATEST_COMMITTED}))
          )
        RETURNING fencing_token, expires_at, head_sequence`,
      deviceId,
      expiresAt,
      now,
      accountId,
      deviceId,
      now,
      deviceId,
      baseSequence,
      baseSequence,
    );
    const row = updated.rows[0];
    if (!row) return null;
    return {
      fencingToken: toSafeInteger(row.fencing_token, 'fencing_token'),
      expiresAt: toSafeInteger(row.expires_at, 'expires_at'),
      headSequence: toSafeInteger(row.head_sequence, 'head_sequence'),
    };
  }

  /** Extend an unexpired lease held by this device with this exact token. */
  async renew(
    accountId: string,
    deviceId: string,
    fencingToken: number,
    now: number,
    expiresAt: number,
  ): Promise<LeaseGrant | null> {
    const updated = await this.db.query(
      `UPDATE vault_relay_leases SET expires_at = ?
        WHERE account_id = ? AND holder_device_id = ? AND fencing_token = ?
          AND expires_at > ?
        RETURNING fencing_token, expires_at, head_sequence`,
      expiresAt,
      accountId,
      deviceId,
      fencingToken,
      now,
    );
    const row = updated.rows[0];
    if (!row) return null;
    return {
      fencingToken: toSafeInteger(row.fencing_token, 'fencing_token'),
      expiresAt: toSafeInteger(row.expires_at, 'expires_at'),
      headSequence: toSafeInteger(row.head_sequence, 'head_sequence'),
    };
  }

  /** Give up the lease; only the holder with the current token can. */
  async release(
    accountId: string,
    deviceId: string,
    fencingToken: number,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE vault_relay_leases SET holder_device_id = NULL, expires_at = 0
        WHERE account_id = ? AND holder_device_id = ? AND fencing_token = ?
        RETURNING account_id`,
      accountId,
      deviceId,
      fencingToken,
    );
    return updated.rows.length === 1;
  }

  /**
   * Clear a lease held by a revoked device and bump the token, so nothing
   * recorded under the old token can publish. Run after the revocation.
   */
  async clearHolder(accountId: string, deviceId: string): Promise<void> {
    await this.db.query(
      `UPDATE vault_relay_leases
          SET holder_device_id = NULL, expires_at = 0,
              fencing_token = fencing_token + 1
        WHERE account_id = ? AND holder_device_id = ?`,
      accountId,
      deviceId,
    );
  }

  /**
   * Advisory begin-time check: this device holds an unexpired lease with this
   * token and `sequence` is above the head. Begin is several statements, so
   * only {@link advanceHead} at commit enforces the lease.
   */
  async holds(
    accountId: string,
    deviceId: string,
    fencingToken: number,
    sequence: number,
    now: number,
  ): Promise<boolean> {
    const found = await this.db.query(
      `SELECT 1 AS ok FROM vault_relay_leases
        WHERE account_id = ? AND holder_device_id = ? AND fencing_token = ?
          AND expires_at > ? AND head_sequence < ?`,
      accountId,
      deviceId,
      fencingToken,
      now,
      sequence,
    );
    return found.rows.length === 1;
  }

  /**
   * Move the head to `sequence` for a pending upload, in one statement: only
   * the holder with the token recorded at begin, only while the upload is
   * still pending, and only forward under an unexpired lease. A head already
   * at `sequence` (a commit retried after the relay failed between the head
   * advance and the publish) is accepted without the expiry check: nobody
   * else can have acquired while that upload is pending at the head.
   */
  async advanceHead(
    accountId: string,
    deviceId: string,
    uploadId: string,
    fencingToken: number,
    sequence: number,
    now: number,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE vault_relay_leases SET head_sequence = ?
        WHERE account_id = ? AND holder_device_id = ? AND fencing_token = ?
          AND EXISTS (SELECT 1 FROM vault_relay_snapshots
                       WHERE account_id = ? AND upload_id = ?
                         AND sequence = ? AND status = 'pending')
          AND ((expires_at > ? AND head_sequence < ?) OR head_sequence = ?)
        RETURNING head_sequence`,
      sequence,
      accountId,
      deviceId,
      fencingToken,
      accountId,
      uploadId,
      sequence,
      now,
      sequence,
      sequence,
    );
    return updated.rows.length === 1;
  }

  // Upload fences ----------------------------------------------------------

  async recordFence(
    accountId: string,
    uploadId: string,
    fencingToken: number,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO vault_relay_upload_fences (upload_id, account_id, fencing_token)
       VALUES (?, ?, ?)`,
      uploadId,
      accountId,
      fencingToken,
    );
  }

  async getFence(accountId: string, uploadId: string): Promise<number | null> {
    const found = await this.db.query(
      `SELECT fencing_token FROM vault_relay_upload_fences
        WHERE account_id = ? AND upload_id = ?`,
      accountId,
      uploadId,
    );
    const row = found.rows[0];
    return row ? toSafeInteger(row.fencing_token, 'fencing_token') : null;
  }

  async deleteFence(uploadId: string): Promise<void> {
    await this.db.query(
      'DELETE FROM vault_relay_upload_fences WHERE upload_id = ?',
      uploadId,
    );
  }

  /**
   * Operator reset of the account's high-water mark (the one way the head
   * moves back): the head becomes the latest committed sequence that remains
   * and the holder is cleared with a bumped token, so nothing recorded under
   * the old position can publish and the next acquire starts from the
   * restored head.
   */
  async resetHead(accountId: string): Promise<void> {
    await this.db.query(
      `UPDATE vault_relay_leases
          SET head_sequence = COALESCE((SELECT MAX(sequence)
                                          FROM vault_relay_snapshots
                                         WHERE account_id = ?
                                           AND status = 'committed'), 0),
              holder_device_id = NULL, expires_at = 0,
              fencing_token = fencing_token + 1
        WHERE account_id = ?`,
      accountId,
      accountId,
    );
  }

  /**
   * Delete a committed snapshot only when it is below the head and below the
   * latest committed snapshot, in one statement. The head never moves back,
   * so a stale read can only refuse more. Returns the row when removed.
   */
  async deleteCommittedBelowHead(
    accountId: string,
    uploadId: string,
  ): Promise<SnapshotRecord | null> {
    const deleted = await this.db.query(
      `DELETE FROM vault_relay_snapshots
        WHERE account_id = ? AND upload_id = ? AND status = 'committed'
          AND sequence < (SELECT head_sequence FROM vault_relay_leases
                           WHERE account_id = ?)
          AND sequence < (SELECT MAX(sequence) FROM vault_relay_snapshots
                           WHERE account_id = ? AND status = 'committed')
        RETURNING account_id, sequence, upload_id, device_id, status, byte_size,
                  chunk_size, chunk_count, sha256, created_at, committed_at`,
      accountId,
      uploadId,
      accountId,
      accountId,
    );
    const row = deleted.rows[0];
    if (!row) return null;
    return {
      accountId: String(row.account_id),
      sequence: toSafeInteger(row.sequence, 'sequence'),
      uploadId: String(row.upload_id),
      deviceId: String(row.device_id),
      status: 'committed',
      byteSize: toSafeInteger(row.byte_size, 'byte_size'),
      chunkSize: toSafeInteger(row.chunk_size, 'chunk_size'),
      chunkCount: toSafeInteger(row.chunk_count, 'chunk_count'),
      sha256: String(row.sha256),
      createdAt: toSafeInteger(row.created_at, 'created_at'),
      committedAt:
        row.committed_at === null || row.committed_at === undefined
          ? null
          : toSafeInteger(row.committed_at, 'committed_at'),
    };
  }
}
