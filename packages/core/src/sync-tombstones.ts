import type { DatabaseInterface } from '@happyvertical/sql';
import {
  isPostgresDatabase,
  usesPostgresDialect,
} from './embedded-write-queue.js';
import { RuntimeError, ValidationError } from './errors.js';
import { buildWhere } from './host.js';
import {
  isJsonAdapterHandle,
  isKnownNativeDuckDbHandle,
} from './native-duckdb.js';
import { getDatabaseSyncDeviceId } from './sync-device.js';

export const SYNC_TOMBSTONES_TABLE = '_smrt_sync_tombstones';

export interface SyncRevision {
  originDeviceId: string;
  revision: number;
}

export interface SyncRowIdentity {
  tableName: string;
  model: string;
  tenantColumn?: string;
  sti?: boolean;
}

function dialect(db: DatabaseInterface) {
  return usesPostgresDialect(db)
    ? 'postgres'
    : isKnownNativeDuckDbHandle(db)
      ? 'duckdb'
      : 'sqlite';
}

/** DuckDB binds JavaScript integer numbers as INT32, even for BIGINT columns. */
export function bindSyncRevision(revision: number, nativeDuckDb: boolean) {
  return nativeDuckDb ? BigInt(revision) : revision;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function compareSyncRevisions(left: SyncRevision, right: SyncRevision) {
  return (
    left.revision - right.revision ||
    (left.originDeviceId > right.originDeviceId
      ? 1
      : left.originDeviceId < right.originDeviceId
        ? -1
        : 0)
  );
}

export function validateSyncRevision(
  originDeviceId: unknown,
  revision: unknown,
): SyncRevision {
  if (
    typeof originDeviceId !== 'string' ||
    !originDeviceId.trim() ||
    originDeviceId.length > 255 ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new ValidationError(
      'Invalid sync revision or missing local sync device',
      'VALIDATION_SYNC_METADATA',
    );
  }
  return { originDeviceId, revision };
}

export function syncRevisionConflict(id: unknown) {
  return new RuntimeError(
    'Incoming sync revision does not advance the row',
    'RUNTIME_SYNC_REVISION_CONFLICT',
    { id },
  );
}

export async function lockSyncRowIdentity(
  db: DatabaseInterface,
  tableName: string,
  rowId: string,
): Promise<void> {
  if (!isPostgresDatabase(db)) return;
  await db.query(
    'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
    JSON.stringify([SYNC_TOMBSTONES_TABLE, tableName, rowId]),
  );
}

export async function putSyncTombstone(
  db: DatabaseInterface,
  identity: SyncRowIdentity,
  rowId: string,
  model: string,
  tenantId: string | null,
  revision: SyncRevision,
): Promise<void> {
  const filter = { table_name: identity.tableName, row_id: rowId };
  const old = await db.get(SYNC_TOMBSTONES_TABLE, filter);
  if (old) {
    if (
      old.model !== model ||
      (old.tenant_id ?? null) !== tenantId ||
      compareSyncRevisions(
        revision,
        validateSyncRevision(old.origin_device_id, Number(old.revision)),
      ) <= 0
    ) {
      throw syncRevisionConflict(rowId);
    }
    await db.update(SYNC_TOMBSTONES_TABLE, filter, {
      origin_device_id: revision.originDeviceId,
      revision: bindSyncRevision(
        revision.revision,
        isKnownNativeDuckDbHandle(db),
      ),
      deleted_at: new Date().toISOString(),
    });
    return;
  }
  await db.insert(SYNC_TOMBSTONES_TABLE, {
    ...filter,
    model,
    tenant_id: tenantId,
    origin_device_id: revision.originDeviceId,
    revision: bindSyncRevision(
      revision.revision,
      isKnownNativeDuckDbHandle(db),
    ),
    deleted_at: new Date().toISOString(),
  });
}

/** Must run inside the same transaction as the enclosing delete/cascade. */
export async function deleteSyncRows(
  db: DatabaseInterface,
  identity: SyncRowIdentity,
  filter: Record<string, unknown>,
  didDelete: (count: number) => void,
  incoming?: { rowId: string; tenantId: string | null; revision: SyncRevision },
): Promise<{ affected: number }> {
  if (isJsonAdapterHandle(db)) {
    if (incoming)
      throw RuntimeError.invalidState('Sync tombstones require a SQL database');
    const result = await db.delete(identity.tableName, filter);
    didDelete(result.affected);
    return result;
  }
  const { sql, values } = buildWhere(filter, 1, dialect(db));
  const tenant = identity.tenantColumn
    ? ', CAST(' +
      quote(identity.tenantColumn) +
      ' AS VARCHAR) AS _sync_deleted_tenant'
    : '';
  const discriminator = identity.sti ? ', _meta_type' : '';
  const result = await db.query(
    'DELETE FROM ' +
      quote(identity.tableName) +
      ' ' +
      sql +
      ' RETURNING CAST(id AS VARCHAR) AS _sync_deleted_id, _sync_origin_device_id, _sync_revision' +
      tenant +
      discriminator,
    ...values,
  );
  didDelete(result.rows.length);
  for (const row of result.rows) {
    if (!incoming && row._sync_origin_device_id == null) continue;
    const rowId = String(row._sync_deleted_id);
    const model =
      typeof row._meta_type === 'string' && row._meta_type.includes(':')
        ? row._meta_type
        : identity.model;
    const tenantId = (row._sync_deleted_tenant ?? null) as string | null;
    if (
      incoming &&
      (rowId !== incoming.rowId ||
        model !== identity.model ||
        tenantId !== incoming.tenantId)
    ) {
      throw syncRevisionConflict(rowId);
    }
    const prior =
      row._sync_origin_device_id == null
        ? undefined
        : validateSyncRevision(
            row._sync_origin_device_id,
            Number(row._sync_revision),
          );
    const revision =
      incoming?.revision ??
      validateSyncRevision(
        getDatabaseSyncDeviceId(db),
        (prior?.revision ?? 0) + 1,
      );
    if (prior && compareSyncRevisions(revision, prior) <= 0) {
      throw syncRevisionConflict(rowId);
    }
    await putSyncTombstone(db, identity, rowId, model, tenantId, revision);
  }
  return { affected: result.rows.length };
}

export async function nullSyncReference(
  db: DatabaseInterface,
  tableName: string,
  column: string,
  filter: Record<string, unknown>,
  didUpdate: (count: number) => void,
): Promise<void> {
  if (isJsonAdapterHandle(db)) {
    const result = await db.update(tableName, filter, { [column]: null });
    didUpdate(result.affected);
    return;
  }
  const engine = dialect(db);
  const parameter = (index: number) =>
    engine === 'postgres' ? `$${index}` : '?';
  const { sql, values } = buildWhere(filter, 3, engine);
  const device = getDatabaseSyncDeviceId(db);
  const tracked = '_sync_origin_device_id IS NOT NULL';
  const nextTimestamp =
    engine === 'sqlite'
      ? `max(${parameter(1)}, coalesce(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds'), ''))`
      : `greatest(CAST(${parameter(1)} AS ${engine === 'postgres' ? 'TIMESTAMPTZ' : 'TIMESTAMP'}), updated_at + INTERVAL '1 millisecond')`;
  const result = await db.query(
    `UPDATE ${quote(tableName)}
        SET ${quote(column)} = NULL,
            updated_at = CASE WHEN ${tracked} THEN ${nextTimestamp} ELSE updated_at END,
            _sync_origin_device_id = CASE WHEN ${tracked} THEN COALESCE(${parameter(2)}, _sync_origin_device_id) ELSE NULL END,
            _sync_revision = CASE WHEN ${tracked} THEN _sync_revision + 1 ELSE _sync_revision END
      ${sql} RETURNING _sync_origin_device_id, _sync_revision`,
    new Date().toISOString(),
    device ?? null,
    ...values,
  );
  didUpdate(result.rows.length);
  for (const row of result.rows) {
    if (row._sync_origin_device_id != null) {
      validateSyncRevision(device, Number(row._sync_revision));
    }
  }
}
