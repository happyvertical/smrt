/**
 * Relay metadata in the service database: accounts (sequence high-water mark
 * and quota counters), registered device keys, consumed request nonces,
 * snapshot rows, and per-chunk rows. Content is never stored here, only
 * sizes, dates, sequences, and ciphertext SHA-256 digests.
 *
 * Every state change that guards a security property is one conditional
 * statement, so it holds on SQLite and PostgreSQL without an explicit
 * transaction: quota reservation (`used + n <= max`), sequence advance
 * (`high_water <= sequence`), publish (`status = 'pending'`), and nonce
 * consumption (primary-key insert). Counter updates that follow a delete can
 * be lost on a crash; they only ever over-count, which denies rather than
 * grants, and {@link VaultRelayStore.reconcileUsage} repairs them.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { toSafeInteger } from './encoding.js';

export const VAULT_RELAY_TABLES = [
  'vault_relay_accounts',
  'vault_relay_devices',
  'vault_relay_nonces',
  'vault_relay_snapshots',
  'vault_relay_chunks',
] as const;

const SCHEMA_V1 = [
  `CREATE TABLE IF NOT EXISTS vault_relay_accounts (
    account_id TEXT PRIMARY KEY,
    high_water_sequence BIGINT NOT NULL DEFAULT 0,
    used_bytes BIGINT NOT NULL DEFAULT 0,
    used_snapshots BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vault_relay_devices (
    account_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    registered_at BIGINT NOT NULL,
    revoked_at BIGINT,
    PRIMARY KEY (account_id, device_id)
  )`,
  `CREATE TABLE IF NOT EXISTS vault_relay_nonces (
    account_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (account_id, device_id, nonce)
  )`,
  `CREATE INDEX IF NOT EXISTS vault_relay_nonces_expiry
    ON vault_relay_nonces (expires_at)`,
  `CREATE TABLE IF NOT EXISTS vault_relay_snapshots (
    account_id TEXT NOT NULL,
    sequence BIGINT NOT NULL CHECK (sequence > 0),
    upload_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
    byte_size BIGINT NOT NULL CHECK (byte_size > 0),
    chunk_size BIGINT NOT NULL CHECK (chunk_size > 0),
    chunk_count INTEGER NOT NULL CHECK (chunk_count > 0),
    sha256 TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    committed_at BIGINT,
    PRIMARY KEY (account_id, sequence)
  )`,
  `CREATE INDEX IF NOT EXISTS vault_relay_snapshots_pending
    ON vault_relay_snapshots (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS vault_relay_chunks (
    upload_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    byte_size BIGINT NOT NULL CHECK (byte_size > 0),
    sha256 TEXT NOT NULL,
    object_id TEXT NOT NULL,
    PRIMARY KEY (upload_id, chunk_index)
  )`,
];

/**
 * Create the relay tables. Idempotent (`IF NOT EXISTS`); run it from the
 * deployment's migration step, never from request handling. Works on SQLite
 * and PostgreSQL.
 */
export async function migrateVaultRelayV1(
  db: DatabaseInterface,
): Promise<void> {
  for (const statement of SCHEMA_V1) {
    await db.query(statement);
  }
}

export type DeviceStatus = 'active' | 'revoked';

export interface DeviceRecord {
  accountId: string;
  deviceId: string;
  /** Raw Ed25519 public key, base64url. */
  publicKey: string;
  status: DeviceStatus;
  registeredAt: number;
  revokedAt: number | null;
}

export type SnapshotStatus = 'pending' | 'committed';

export interface SnapshotRecord {
  accountId: string;
  sequence: number;
  uploadId: string;
  deviceId: string;
  status: SnapshotStatus;
  byteSize: number;
  /** Size of every chunk but the last, which holds the remainder. */
  chunkSize: number;
  chunkCount: number;
  sha256: string;
  createdAt: number;
  committedAt: number | null;
}

export interface ChunkRecord {
  index: number;
  byteSize: number;
  sha256: string;
  /** Random id of the stored object attempt this row points at. */
  objectId: string;
}

export interface AccountUsage {
  accountId: string;
  highWaterSequence: number;
  usedBytes: number;
  usedSnapshots: number;
}

export type RegisterDeviceResult = 'registered' | 'unchanged' | 'conflict';

type Row = Record<string, unknown>;

function deviceFromRow(row: Row): DeviceRecord {
  return {
    accountId: String(row.account_id),
    deviceId: String(row.device_id),
    publicKey: String(row.public_key),
    status: row.status === 'active' ? 'active' : 'revoked',
    registeredAt: toSafeInteger(row.registered_at, 'registered_at'),
    revokedAt:
      row.revoked_at === null || row.revoked_at === undefined
        ? null
        : toSafeInteger(row.revoked_at, 'revoked_at'),
  };
}

function snapshotFromRow(row: Row): SnapshotRecord {
  return {
    accountId: String(row.account_id),
    sequence: toSafeInteger(row.sequence, 'sequence'),
    uploadId: String(row.upload_id),
    deviceId: String(row.device_id),
    status: row.status === 'committed' ? 'committed' : 'pending',
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

function chunkFromRow(row: Row): ChunkRecord {
  return {
    index: toSafeInteger(row.chunk_index, 'chunk_index'),
    byteSize: toSafeInteger(row.byte_size, 'byte_size'),
    sha256: String(row.sha256),
    objectId: String(row.object_id),
  };
}

const SNAPSHOT_COLUMNS =
  'account_id, sequence, upload_id, device_id, status, byte_size, chunk_size, chunk_count, sha256, created_at, committed_at';

/** Typed access to the relay tables. */
export class VaultRelayStore {
  readonly db: DatabaseInterface;

  constructor(db: DatabaseInterface) {
    this.db = db;
  }

  /** Names of relay tables that do not exist (empty when migrated). */
  async missingTables(): Promise<string[]> {
    const missing: string[] = [];
    for (const table of VAULT_RELAY_TABLES) {
      if (!(await this.db.tableExists(table))) missing.push(table);
    }
    return missing;
  }

  async ensureAccount(accountId: string, now: number): Promise<void> {
    await this.db.query(
      `INSERT INTO vault_relay_accounts
         (account_id, high_water_sequence, used_bytes, used_snapshots, created_at)
       VALUES (?, 0, 0, 0, ?)
       ON CONFLICT (account_id) DO NOTHING`,
      accountId,
      now,
    );
  }

  async getUsage(accountId: string): Promise<AccountUsage | null> {
    const found = await this.db.query(
      `SELECT account_id, high_water_sequence, used_bytes, used_snapshots
         FROM vault_relay_accounts WHERE account_id = ?`,
      accountId,
    );
    const row = found.rows[0];
    if (!row) return null;
    return {
      accountId: String(row.account_id),
      highWaterSequence: toSafeInteger(
        row.high_water_sequence,
        'high_water_sequence',
      ),
      usedBytes: toSafeInteger(row.used_bytes, 'used_bytes'),
      usedSnapshots: toSafeInteger(row.used_snapshots, 'used_snapshots'),
    };
  }

  // Devices -------------------------------------------------------------

  async registerDevice(
    accountId: string,
    deviceId: string,
    publicKey: string,
    now: number,
  ): Promise<RegisterDeviceResult> {
    const inserted = await this.db.query(
      `INSERT INTO vault_relay_devices
         (account_id, device_id, public_key, status, registered_at, revoked_at)
       VALUES (?, ?, ?, 'active', ?, NULL)
       ON CONFLICT (account_id, device_id) DO NOTHING
       RETURNING device_id`,
      accountId,
      deviceId,
      publicKey,
      now,
    );
    if (inserted.rows.length === 1) return 'registered';
    const existing = await this.getDevice(accountId, deviceId);
    // A device id is never reused: a revoked id, or the same id with a
    // different key, is a conflict, not a silent re-activation.
    return existing?.status === 'active' && existing.publicKey === publicKey
      ? 'unchanged'
      : 'conflict';
  }

  async revokeDevice(
    accountId: string,
    deviceId: string,
    now: number,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE vault_relay_devices SET status = 'revoked', revoked_at = ?
        WHERE account_id = ? AND device_id = ? AND status = 'active'
        RETURNING device_id`,
      now,
      accountId,
      deviceId,
    );
    return updated.rows.length === 1;
  }

  async getDevice(
    accountId: string,
    deviceId: string,
  ): Promise<DeviceRecord | null> {
    const found = await this.db.query(
      `SELECT account_id, device_id, public_key, status, registered_at, revoked_at
         FROM vault_relay_devices WHERE account_id = ? AND device_id = ?`,
      accountId,
      deviceId,
    );
    return found.rows[0] ? deviceFromRow(found.rows[0]) : null;
  }

  async listDevices(accountId: string): Promise<DeviceRecord[]> {
    const found = await this.db.query(
      `SELECT account_id, device_id, public_key, status, registered_at, revoked_at
         FROM vault_relay_devices WHERE account_id = ? ORDER BY registered_at, device_id`,
      accountId,
    );
    return found.rows.map(deviceFromRow);
  }

  // Nonces --------------------------------------------------------------

  /** Record a nonce; `false` when it was already used (a replay). */
  async consumeNonce(
    accountId: string,
    deviceId: string,
    nonce: string,
    expiresAt: number,
  ): Promise<boolean> {
    const inserted = await this.db.query(
      `INSERT INTO vault_relay_nonces (account_id, device_id, nonce, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, device_id, nonce) DO NOTHING
       RETURNING nonce`,
      accountId,
      deviceId,
      nonce,
      expiresAt,
    );
    return inserted.rows.length === 1;
  }

  async pruneNonces(now: number): Promise<void> {
    await this.db.query(
      'DELETE FROM vault_relay_nonces WHERE expires_at < ?',
      now,
    );
  }

  // Quota counters ---------------------------------------------------------

  /** Reserve bytes and one snapshot slot; `false` when it would exceed quota. */
  async reserve(
    accountId: string,
    bytes: number,
    maxBytes: number,
    maxSnapshots: number,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE vault_relay_accounts
          SET used_bytes = used_bytes + ?, used_snapshots = used_snapshots + 1
        WHERE account_id = ?
          AND used_bytes + ? <= ?
          AND used_snapshots + 1 <= ?
        RETURNING account_id`,
      bytes,
      accountId,
      bytes,
      maxBytes,
      maxSnapshots,
    );
    return updated.rows.length === 1;
  }

  async release(accountId: string, bytes: number): Promise<void> {
    await this.db.query(
      `UPDATE vault_relay_accounts
          SET used_bytes = CASE WHEN used_bytes >= ? THEN used_bytes - ? ELSE 0 END,
              used_snapshots = CASE WHEN used_snapshots >= 1 THEN used_snapshots - 1 ELSE 0 END
        WHERE account_id = ?`,
      bytes,
      bytes,
      accountId,
    );
  }

  /** Recompute the quota counters from the snapshot rows, in one statement. */
  async reconcileUsage(accountId: string): Promise<void> {
    await this.db.query(
      `UPDATE vault_relay_accounts SET
         used_bytes = (SELECT COALESCE(SUM(byte_size), 0)
                         FROM vault_relay_snapshots WHERE account_id = ?),
         used_snapshots = (SELECT COUNT(*)
                             FROM vault_relay_snapshots WHERE account_id = ?)
        WHERE account_id = ?`,
      accountId,
      accountId,
      accountId,
    );
  }

  // Snapshots --------------------------------------------------------------

  /**
   * Insert a pending snapshot. `false` when the sequence already exists or is
   * at or below the account's high-water mark (it was published before, even
   * if since deleted).
   */
  async createPending(record: {
    accountId: string;
    sequence: number;
    uploadId: string;
    deviceId: string;
    byteSize: number;
    chunkSize: number;
    chunkCount: number;
    sha256: string;
    createdAt: number;
  }): Promise<boolean> {
    const inserted = await this.db.query(
      `INSERT INTO vault_relay_snapshots
         (${SNAPSHOT_COLUMNS})
       SELECT ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL
        WHERE NOT EXISTS (
          SELECT 1 FROM vault_relay_accounts
           WHERE account_id = ? AND high_water_sequence >= ?)
       ON CONFLICT DO NOTHING
       RETURNING upload_id`,
      record.accountId,
      record.sequence,
      record.uploadId,
      record.deviceId,
      record.byteSize,
      record.chunkSize,
      record.chunkCount,
      record.sha256,
      record.createdAt,
      record.accountId,
      record.sequence,
    );
    return inserted.rows.length === 1;
  }

  async getByUpload(
    accountId: string,
    uploadId: string,
  ): Promise<SnapshotRecord | null> {
    const found = await this.db.query(
      `SELECT ${SNAPSHOT_COLUMNS} FROM vault_relay_snapshots
        WHERE account_id = ? AND upload_id = ?`,
      accountId,
      uploadId,
    );
    return found.rows[0] ? snapshotFromRow(found.rows[0]) : null;
  }

  async getCommitted(
    accountId: string,
    sequence: number,
  ): Promise<SnapshotRecord | null> {
    const found = await this.db.query(
      `SELECT ${SNAPSHOT_COLUMNS} FROM vault_relay_snapshots
        WHERE account_id = ? AND sequence = ? AND status = 'committed'`,
      accountId,
      sequence,
    );
    return found.rows[0] ? snapshotFromRow(found.rows[0]) : null;
  }

  async latestCommitted(accountId: string): Promise<SnapshotRecord | null> {
    const found = await this.db.query(
      `SELECT ${SNAPSHOT_COLUMNS} FROM vault_relay_snapshots
        WHERE account_id = ? AND status = 'committed'
        ORDER BY sequence DESC LIMIT 1`,
      accountId,
    );
    return found.rows[0] ? snapshotFromRow(found.rows[0]) : null;
  }

  /** Every snapshot of the account, newest sequence first. */
  async listSnapshots(
    accountId: string,
    status?: SnapshotStatus,
  ): Promise<SnapshotRecord[]> {
    const found = status
      ? await this.db.query(
          `SELECT ${SNAPSHOT_COLUMNS} FROM vault_relay_snapshots
            WHERE account_id = ? AND status = ? ORDER BY sequence DESC`,
          accountId,
          status,
        )
      : await this.db.query(
          `SELECT ${SNAPSHOT_COLUMNS} FROM vault_relay_snapshots
            WHERE account_id = ? ORDER BY sequence DESC`,
          accountId,
        );
    return found.rows.map(snapshotFromRow);
  }

  /** Pending uploads created before `cutoff`, across accounts. */
  async stalePending(cutoff: number, limit: number): Promise<SnapshotRecord[]> {
    const found = await this.db.query(
      `SELECT ${SNAPSHOT_COLUMNS} FROM vault_relay_snapshots
        WHERE status = 'pending' AND created_at < ?
        ORDER BY created_at LIMIT ?`,
      cutoff,
      limit,
    );
    return found.rows.map(snapshotFromRow);
  }

  /**
   * Raise the account's sequence high-water mark to `sequence`. Fails when a
   * higher sequence is already published, so a stale upload can never become
   * latest and an old sequence can never be republished.
   */
  async advanceHighWater(
    accountId: string,
    sequence: number,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE vault_relay_accounts SET high_water_sequence = ?
        WHERE account_id = ? AND high_water_sequence <= ?
        RETURNING account_id`,
      sequence,
      accountId,
      sequence,
    );
    return updated.rows.length === 1;
  }

  /** Publish a pending upload; `false` when it is not pending any more. */
  async markCommitted(
    accountId: string,
    uploadId: string,
    now: number,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE vault_relay_snapshots SET status = 'committed', committed_at = ?
        WHERE account_id = ? AND upload_id = ? AND status = 'pending'
        RETURNING upload_id`,
      now,
      accountId,
      uploadId,
    );
    return updated.rows.length === 1;
  }

  /**
   * Delete the snapshot row only while it still has `status`, so removing a
   * pending upload can never delete a snapshot that was published meanwhile.
   * Returns the row when this call removed it.
   */
  async deleteSnapshotRow(
    accountId: string,
    uploadId: string,
    status: SnapshotStatus,
  ): Promise<SnapshotRecord | null> {
    const deleted = await this.db.query(
      `DELETE FROM vault_relay_snapshots
        WHERE account_id = ? AND upload_id = ? AND status = ?
        RETURNING ${SNAPSHOT_COLUMNS}`,
      accountId,
      uploadId,
      status,
    );
    return deleted.rows[0] ? snapshotFromRow(deleted.rows[0]) : null;
  }

  // Chunks -----------------------------------------------------------------

  /**
   * Record a stored chunk object, only while its upload is still pending for
   * the account and only if the index has no object yet. Returns `false`
   * otherwise; the caller then removes the object it wrote, so a late write
   * after an abort, expiry, or commit leaves nothing behind.
   */
  async addChunk(
    accountId: string,
    uploadId: string,
    chunk: ChunkRecord,
  ): Promise<boolean> {
    const inserted = await this.db.query(
      `INSERT INTO vault_relay_chunks
         (upload_id, chunk_index, byte_size, sha256, object_id)
       SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM vault_relay_snapshots
           WHERE account_id = ? AND upload_id = ? AND status = 'pending')
       ON CONFLICT (upload_id, chunk_index) DO NOTHING
       RETURNING chunk_index`,
      uploadId,
      chunk.index,
      chunk.byteSize,
      chunk.sha256,
      chunk.objectId,
      accountId,
      uploadId,
    );
    return inserted.rows.length === 1;
  }

  async listChunks(uploadId: string): Promise<ChunkRecord[]> {
    const found = await this.db.query(
      `SELECT chunk_index, byte_size, sha256, object_id FROM vault_relay_chunks
        WHERE upload_id = ? ORDER BY chunk_index`,
      uploadId,
    );
    return found.rows.map(chunkFromRow);
  }

  async getChunk(uploadId: string, index: number): Promise<ChunkRecord | null> {
    const found = await this.db.query(
      `SELECT chunk_index, byte_size, sha256, object_id FROM vault_relay_chunks
        WHERE upload_id = ? AND chunk_index = ?`,
      uploadId,
      index,
    );
    return found.rows[0] ? chunkFromRow(found.rows[0]) : null;
  }

  /** Delete one recorded chunk attempt; `true` when this call removed it. */
  async deleteChunkAttempt(
    uploadId: string,
    index: number,
    objectId: string,
  ): Promise<boolean> {
    const deleted = await this.db.query(
      `DELETE FROM vault_relay_chunks
        WHERE upload_id = ? AND chunk_index = ? AND object_id = ?
        RETURNING chunk_index`,
      uploadId,
      index,
      objectId,
    );
    return deleted.rows.length === 1;
  }

  /** Delete every chunk row of an upload; returns the removed rows. */
  async deleteChunks(uploadId: string): Promise<ChunkRecord[]> {
    const deleted = await this.db.query(
      `DELETE FROM vault_relay_chunks WHERE upload_id = ?
        RETURNING chunk_index, byte_size, sha256, object_id`,
      uploadId,
    );
    return deleted.rows.map(chunkFromRow);
  }
}
