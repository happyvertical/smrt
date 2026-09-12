import { createHash, randomUUID } from 'node:crypto';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { DataSurfaceActionResult } from '@happyvertical/smrt-ui/data';
import type { DatabaseInterface } from '@happyvertical/sql';
import type {
  DataSurfaceActionStateStore,
  DataSurfaceIdempotencyRecord,
  DataSurfaceIdempotencyRecoveryEvidence,
  DataSurfaceIdempotencyReservation,
  DataSurfacePreviewTokenRecord,
} from './data-surface-actions.js';

const TOKEN_TABLE = '_smrt_data_surface_action_tokens';
const IDEMPOTENCY_TABLE = '_smrt_data_surface_action_idempotency';

const INTERNAL_SURFACE = {
  api: false,
  cli: false,
  mcp: false,
} as const;

@smrt({ tableName: '_smrt_data_surface_action_tokens', ...INTERNAL_SURFACE })
export class DataSurfaceActionTokenState extends SmrtObject {
  @field({ type: 'text', required: true, unique: true })
  tokenHash: string = '';

  @field({ type: 'json', required: true })
  record: DataSurfacePreviewTokenRecord = emptyTokenRecord();

  @field({ type: 'text', nullable: true })
  consumedBy: string | null = null;
}

@smrt({
  tableName: '_smrt_data_surface_action_idempotency',
  ...INTERNAL_SURFACE,
})
export class DataSurfaceActionIdempotencyState extends SmrtObject {
  @field({ type: 'text', required: true, unique: true })
  keyHash: string = '';

  @field({ type: 'text', required: true })
  status: 'reserved' | 'completed' = 'reserved';

  @field({ type: 'text', required: true })
  requestFingerprint: string = '';

  @field({ type: 'text', nullable: true })
  ownerHash: string | null = null;

  @field({ type: 'text', nullable: true })
  reservedAt: string | null = null;

  @field({ type: 'json', nullable: true })
  result: DataSurfaceActionResult | null = null;

  @field({ type: 'json', nullable: true })
  recovery: DataSurfaceIdempotencyRecoveryEvidence | null = null;
}

export interface DataSurfaceIdempotencyRecoveryRequest {
  requestFingerprint: string;
  reservedAt: number;
  result: DataSurfaceActionResult;
  authorizedBy: string;
  evidence: string;
}

export interface SqlDataSurfaceActionStateStoreOptions {
  db: DatabaseInterface;
  now?: () => number;
  authorizeRecovery?: (
    request: Readonly<DataSurfaceIdempotencyRecoveryRequest>,
  ) => boolean | Promise<boolean>;
}

export class DataSurfaceActionStateCorruptionError extends Error {
  constructor(table: string) {
    super(`Malformed durable data-surface action state in ${table}`);
    this.name = 'DataSurfaceActionStateCorruptionError';
  }
}

/**
 * SQL-backed action state shared by server processes.
 *
 * Preview tokens and owner nonces are stored only as hashes. Runtime schema
 * creation remains the application's normal SMRT migration responsibility.
 * An orphaned reservation is never expired or released automatically: a host
 * may only reconcile it to a concrete terminal result after its live authority
 * callback accepts immutable evidence for the exact reservation timestamp.
 */
export class SqlDataSurfaceActionStateStore
  implements DataSurfaceActionStateStore
{
  private readonly db: DatabaseInterface;
  private readonly now: () => number;
  private readonly authorizeRecovery?: SqlDataSurfaceActionStateStoreOptions['authorizeRecovery'];

  constructor(options: SqlDataSurfaceActionStateStoreOptions) {
    this.db = options.db;
    this.now = options.now ?? Date.now;
    this.authorizeRecovery = options.authorizeRecovery;
  }

  async putToken(
    token: string,
    record: DataSurfacePreviewTokenRecord,
  ): Promise<void> {
    const timestamp = new Date(this.now()).toISOString();
    await this.db.query(
      `INSERT INTO ${TOKEN_TABLE}
        (id, slug, context, created_at, updated_at, token_hash, record, consumed_by)
       VALUES (?, ?, '', ?, ?, ?, ?, NULL)
       ON CONFLICT(token_hash) DO NOTHING`,
      randomUUID(),
      `action-token-${randomUUID()}`,
      timestamp,
      timestamp,
      secretHash(token),
      JSON.stringify(record),
    );
  }

  async getToken(
    token: string,
  ): Promise<DataSurfacePreviewTokenRecord | undefined> {
    const found = await this.db.query(
      `SELECT record, consumed_by FROM ${TOKEN_TABLE} WHERE token_hash = ? LIMIT 1`,
      secretHash(token),
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record = tokenRecord(parseObject(row.record, TOKEN_TABLE));
    return {
      ...record,
      ...(typeof row.consumed_by === 'string'
        ? { consumedBy: row.consumed_by }
        : {}),
    };
  }

  async markTokenConsumed(
    token: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE ${TOKEN_TABLE}
          SET consumed_by = ?, updated_at = ?
        WHERE token_hash = ? AND consumed_by IS NULL
        RETURNING token_hash`,
      secretHash(idempotencyKey),
      new Date(this.now()).toISOString(),
      secretHash(token),
    );
    return updated.rows.length === 1;
  }

  async consumeTokenAndReserveIdempotency(
    token: string,
    idempotencyKey: string,
    scope: string,
    reservation: DataSurfaceIdempotencyReservation,
  ): Promise<DataSurfaceIdempotencyRecord | undefined> {
    const transaction = this.db.transaction;
    if (!transaction) {
      throw new Error(
        'Durable data-surface action state requires database transactions',
      );
    }
    return (await transaction.call(this.db, async (tx) => {
      const timestamp = new Date(this.now()).toISOString();
      const consumed = await tx.query(
        `UPDATE ${TOKEN_TABLE}
            SET consumed_by = ?, updated_at = ?
          WHERE token_hash = ?
            AND (consumed_by IS NULL OR consumed_by = ?)
          RETURNING token_hash`,
        secretHash(idempotencyKey),
        timestamp,
        secretHash(token),
        secretHash(idempotencyKey),
      );
      if (consumed.rows.length !== 1) return undefined;
      await tx.query(
        `INSERT INTO ${IDEMPOTENCY_TABLE}
          (id, slug, context, created_at, updated_at, key_hash, status,
           request_fingerprint, owner_hash, reserved_at, result, recovery)
         VALUES (?, ?, '', ?, ?, ?, 'reserved', ?, ?, ?, NULL, NULL)
         ON CONFLICT(key_hash) DO NOTHING`,
        randomUUID(),
        `action-idempotency-${randomUUID()}`,
        timestamp,
        timestamp,
        secretHash(scope),
        reservation.requestFingerprint,
        secretHash(reservation.ownerToken),
        String(reservation.reservedAt),
      );
      const current = await this.getIdempotencyWithOwner(
        scope,
        reservation.ownerToken,
        tx,
      );
      if (!current) {
        throw new DataSurfaceActionStateCorruptionError(IDEMPOTENCY_TABLE);
      }
      return current;
    })) as DataSurfaceIdempotencyRecord | undefined;
  }

  async getIdempotency(
    key: string,
  ): Promise<DataSurfaceIdempotencyRecord | undefined> {
    const found = await this.db.query(
      `SELECT status, request_fingerprint, owner_hash, reserved_at, result, recovery
         FROM ${IDEMPOTENCY_TABLE} WHERE key_hash = ? LIMIT 1`,
      secretHash(key),
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    return row ? idempotencyRecord(row) : undefined;
  }

  async reserveIdempotency(
    key: string,
    reservation: DataSurfaceIdempotencyReservation,
  ): Promise<DataSurfaceIdempotencyRecord> {
    const timestamp = new Date(this.now()).toISOString();
    await this.db.query(
      `INSERT INTO ${IDEMPOTENCY_TABLE}
        (id, slug, context, created_at, updated_at, key_hash, status,
         request_fingerprint, owner_hash, reserved_at, result, recovery)
       VALUES (?, ?, '', ?, ?, ?, 'reserved', ?, ?, ?, NULL, NULL)
       ON CONFLICT(key_hash) DO NOTHING`,
      randomUUID(),
      `action-idempotency-${randomUUID()}`,
      timestamp,
      timestamp,
      secretHash(key),
      reservation.requestFingerprint,
      secretHash(reservation.ownerToken),
      String(reservation.reservedAt),
    );
    const current = await this.getIdempotencyWithOwner(
      key,
      reservation.ownerToken,
    );
    if (!current)
      throw new DataSurfaceActionStateCorruptionError(IDEMPOTENCY_TABLE);
    return current;
  }

  async completeIdempotency(
    key: string,
    ownerToken: string,
    result: DataSurfaceActionResult,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE ${IDEMPOTENCY_TABLE}
          SET status = 'completed', result = ?, owner_hash = NULL,
              reserved_at = NULL, updated_at = ?
        WHERE key_hash = ? AND status = 'reserved' AND owner_hash = ?
        RETURNING key_hash`,
      JSON.stringify(result),
      new Date(this.now()).toISOString(),
      secretHash(key),
      secretHash(ownerToken),
    );
    return updated.rows.length === 1;
  }

  async releaseIdempotency(key: string, ownerToken: string): Promise<boolean> {
    const removed = await this.db.query(
      `DELETE FROM ${IDEMPOTENCY_TABLE}
        WHERE key_hash = ? AND status = 'reserved' AND owner_hash = ?
        RETURNING key_hash`,
      secretHash(key),
      secretHash(ownerToken),
    );
    return removed.rows.length === 1;
  }

  async reconcileIdempotency(
    key: string,
    request: DataSurfaceIdempotencyRecoveryRequest,
  ): Promise<boolean> {
    if (
      !request.requestFingerprint ||
      !Number.isSafeInteger(request.reservedAt) ||
      request.reservedAt < 0 ||
      !request.authorizedBy ||
      request.authorizedBy.length > 256 ||
      !request.evidence ||
      request.evidence.length > 2_048
    ) {
      return false;
    }
    if (
      !this.authorizeRecovery ||
      !(await this.authorizeRecovery(Object.freeze({ ...request })))
    ) {
      return false;
    }
    const recovery: DataSurfaceIdempotencyRecoveryEvidence = {
      authorizedBy: request.authorizedBy,
      evidence: request.evidence,
      reconciledAt: this.now(),
    };
    const updated = await this.db.query(
      `UPDATE ${IDEMPOTENCY_TABLE}
          SET status = 'completed', result = ?, recovery = ?, owner_hash = NULL,
              reserved_at = NULL, updated_at = ?
        WHERE key_hash = ? AND status = 'reserved'
          AND request_fingerprint = ? AND reserved_at = ?
        RETURNING key_hash`,
      JSON.stringify(request.result),
      JSON.stringify(recovery),
      new Date(recovery.reconciledAt).toISOString(),
      secretHash(key),
      request.requestFingerprint,
      String(request.reservedAt),
    );
    return updated.rows.length === 1;
  }

  private async getIdempotencyWithOwner(
    key: string,
    ownerToken: string,
    db: DatabaseInterface = this.db,
  ): Promise<DataSurfaceIdempotencyRecord | undefined> {
    const found = await db.query(
      `SELECT status, request_fingerprint, owner_hash, reserved_at, result, recovery
         FROM ${IDEMPOTENCY_TABLE} WHERE key_hash = ? LIMIT 1`,
      secretHash(key),
    );
    const row = found.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const record = idempotencyRecord(row);
    if (
      record.status === 'reserved' &&
      row.owner_hash === secretHash(ownerToken)
    ) {
      return { ...record, ownerToken };
    }
    return record;
  }
}

export function createSqlDataSurfaceActionStateStore(
  options: SqlDataSurfaceActionStateStoreOptions,
): SqlDataSurfaceActionStateStore {
  return new SqlDataSurfaceActionStateStore(options);
}

function secretHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseObject(value: unknown, table: string): Record<string, unknown> {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new DataSurfaceActionStateCorruptionError(table);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DataSurfaceActionStateCorruptionError(table);
  }
  return parsed as Record<string, unknown>;
}

function idempotencyRecord(
  row: Record<string, unknown>,
): DataSurfaceIdempotencyRecord {
  const requestFingerprint = row.request_fingerprint;
  if (typeof requestFingerprint !== 'string') {
    throw new DataSurfaceActionStateCorruptionError(IDEMPOTENCY_TABLE);
  }
  if (row.status === 'reserved') {
    const reservedAt = Number(row.reserved_at);
    if (
      typeof row.owner_hash !== 'string' ||
      !Number.isSafeInteger(reservedAt)
    ) {
      throw new DataSurfaceActionStateCorruptionError(IDEMPOTENCY_TABLE);
    }
    return {
      status: 'reserved',
      requestFingerprint,
      ownerToken: '',
      reservedAt,
    };
  }
  if (row.status !== 'completed') {
    throw new DataSurfaceActionStateCorruptionError(IDEMPOTENCY_TABLE);
  }
  const result = actionResult(parseObject(row.result, IDEMPOTENCY_TABLE));
  const recovery =
    row.recovery == null
      ? undefined
      : recoveryEvidence(parseObject(row.recovery, IDEMPOTENCY_TABLE));
  return {
    status: 'completed',
    requestFingerprint,
    result,
    ...(recovery ? { recovery } : {}),
  };
}

function tokenRecord(
  value: Record<string, unknown>,
): DataSurfacePreviewTokenRecord {
  const stringKeys = [
    'actorUserId',
    'identityKey',
    'actionId',
    'actionFingerprint',
    'queryFingerprint',
    'selectionFingerprint',
    'resolvedRowsFingerprint',
    'requestFingerprint',
  ] as const;
  if (
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(value.revision) ||
    stringKeys.some((key) => typeof value[key] !== 'string') ||
    !['tenantId', 'onBehalfOfUserId', 'actsAsProfileId', 'agentClass'].every(
      (key) => value[key] === null || typeof value[key] === 'string',
    )
  ) {
    throw new DataSurfaceActionStateCorruptionError(TOKEN_TABLE);
  }
  return value as unknown as DataSurfacePreviewTokenRecord;
}

function actionResult(value: Record<string, unknown>): DataSurfaceActionResult {
  if (
    value.version !== 1 ||
    typeof value.requestId !== 'string' ||
    typeof value.actionId !== 'string' ||
    value.phase !== 'apply' ||
    typeof value.ok !== 'boolean' ||
    !value.identity ||
    typeof value.identity !== 'object' ||
    Array.isArray(value.identity) ||
    (value.reason !== undefined && typeof value.reason !== 'string')
  ) {
    throw new DataSurfaceActionStateCorruptionError(IDEMPOTENCY_TABLE);
  }
  return value as unknown as DataSurfaceActionResult;
}

function recoveryEvidence(
  value: Record<string, unknown>,
): DataSurfaceIdempotencyRecoveryEvidence {
  if (
    typeof value.authorizedBy !== 'string' ||
    typeof value.evidence !== 'string' ||
    !Number.isSafeInteger(value.reconciledAt)
  ) {
    throw new DataSurfaceActionStateCorruptionError(IDEMPOTENCY_TABLE);
  }
  return value as unknown as DataSurfaceIdempotencyRecoveryEvidence;
}

function emptyTokenRecord(): DataSurfacePreviewTokenRecord {
  return {
    expiresAt: 0,
    actorUserId: '',
    tenantId: null,
    onBehalfOfUserId: null,
    actsAsProfileId: null,
    agentClass: null,
    identityKey: '',
    actionId: '',
    actionFingerprint: '',
    revision: 0,
    queryFingerprint: '',
    selectionFingerprint: '',
    resolvedRowsFingerprint: '',
    requestFingerprint: '',
  };
}
