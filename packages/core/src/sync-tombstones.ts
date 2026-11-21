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

/**
 * An extra SQL predicate ANDed onto a statement's `WHERE`, with its own bound
 * values. `sql` receives the 1-based index of its first parameter (PostgreSQL
 * numbers placeholders; SQLite and DuckDB use `?` and ignore it). Used for a
 * predicate `buildWhere` cannot express with a bounded number of parameters.
 */
export interface RawPredicate {
  sql: (firstParameter: number) => string;
  values: unknown[];
}

/** `where` (from `buildWhere`) with `raw` ANDed on. */
export function withRawPredicate(
  where: { sql: string; values: unknown[] },
  raw: RawPredicate | undefined,
  firstParameter: number,
): { sql: string; values: unknown[] } {
  if (!raw) return where;
  const clause = raw.sql(firstParameter + where.values.length);
  return {
    sql: where.sql.trim() ? `${where.sql} AND ${clause}` : `WHERE ${clause}`,
    values: [...where.values, ...raw.values],
  };
}

export interface SyncRevision {
  originDeviceId: string;
  revision: number;
}

export interface SyncRowIdentity {
  tableName: string;
  model: string;
  tenantColumn?: string;
  sti?: boolean;
  /**
   * Ownership columns to return for each deleted row (as text), so the
   * caller attributes the row the statement actually removed.
   */
  ownerColumns?: readonly string[];
  /**
   * Return every deleted row's id even when `ownerColumns` is empty (a
   * cascade records a change-feed entry for each row it removes, owned or
   * global).
   */
  returnRows?: boolean;
}

/**
 * Each deleted row's id (as the statement returned it, as text) and its
 * returned ownership columns. The caller matches ids in the engine's
 * canonical id form; ids are never case-folded here, so two text ids that
 * differ only in case stay two rows. A column the row does not carry (a JSON
 * row without the key) is left out, never filled in as empty.
 */
export type DeletedRowOwners = Array<{
  id: string;
  columns: Record<string, unknown>;
  /** The row's STI discriminator, when the statement returned one. */
  metaType?: string;
}>;

function ownerAlias(index: number): string {
  return `_smrt_owner_${index}`;
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
  raw?: RawPredicate,
): Promise<{ affected: number; owners?: DeletedRowOwners }> {
  if (raw && isJsonAdapterHandle(db)) {
    throw RuntimeError.invalidState(
      'A raw SQL predicate requires a SQL database',
    );
  }
  const ownerColumns = identity.ownerColumns ?? [];
  const returnRows = ownerColumns.length > 0 || identity.returnRows === true;
  if (isJsonAdapterHandle(db)) {
    if (incoming)
      throw RuntimeError.invalidState('Sync tombstones require a SQL database');
    // No RETURNING here; the embedded write queue serializes framework
    // writes, so the rows read just before the delete are the rows it removes.
    const before = returnRows
      ? await db.list(identity.tableName, filter)
      : undefined;
    const result = await db.delete(identity.tableName, filter);
    didDelete(result.affected);
    if (!before) return result;
    const owners: DeletedRowOwners = before.map((row) => ({
      id: String(row.id),
      columns: Object.fromEntries(
        ownerColumns
          .filter((column) => Object.hasOwn(row, column))
          .map((column) => [column, row[column]]),
      ),
      ...(identity.sti && typeof row._meta_type === 'string'
        ? { metaType: row._meta_type }
        : {}),
    }));
    return { affected: result.affected, owners };
  }
  const { sql, values } = withRawPredicate(
    buildWhere(filter, 1, dialect(db)),
    raw,
    1,
  );
  const tenant = identity.tenantColumn
    ? ', CAST(' +
      quote(identity.tenantColumn) +
      ' AS VARCHAR) AS _sync_deleted_tenant'
    : '';
  const discriminator = identity.sti ? ', _meta_type' : '';
  // Cast to text in the statement: native DuckDB would otherwise return a
  // UUID owner as a HUGEINT wrapper rather than its canonical string.
  const owner = ownerColumns
    .map(
      (column, index) =>
        `, CAST(${quote(column)} AS VARCHAR) AS ${ownerAlias(index)}`,
    )
    .join('');
  const result = await db.query(
    'DELETE FROM ' +
      quote(identity.tableName) +
      ' ' +
      sql +
      ' RETURNING CAST(id AS VARCHAR) AS _sync_deleted_id, _sync_origin_device_id, _sync_revision' +
      tenant +
      discriminator +
      owner,
    ...values,
  );
  didDelete(result.rows.length);
  const owners: DeletedRowOwners | undefined = returnRows
    ? result.rows.map((row) => ({
        id: String(row._sync_deleted_id),
        columns: Object.fromEntries(
          ownerColumns.flatMap((column, index) =>
            Object.hasOwn(row, ownerAlias(index))
              ? [[column, row[ownerAlias(index)]]]
              : [],
          ),
        ),
        ...(identity.sti && typeof row._meta_type === 'string'
          ? { metaType: row._meta_type }
          : {}),
      }))
    : undefined;
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
  return { affected: result.rows.length, owners };
}

/**
 * The ids (as text) of the rows stored under `ids` — the proof a delete that
 * removed nothing needs before treating its id as absent. Reads only `id`,
 * which the delete's own `RETURNING` already needs, so it asks for no
 * privilege the delete did not.
 */
export async function existingRowIds(
  db: DatabaseInterface,
  tableName: string,
  ids: readonly unknown[],
): Promise<string[]> {
  if (ids.length === 0) return [];
  if (isJsonAdapterHandle(db)) {
    const rows = await db.list(tableName, { 'id in': [...ids] });
    return rows.map((row) => String(row.id));
  }
  const { sql, values } = buildWhere({ 'id in': [...ids] }, 1, dialect(db));
  const result = await db.query(
    `SELECT CAST(id AS VARCHAR) AS _smrt_existing_id FROM ${quote(tableName)} ${sql}`,
    ...values,
  );
  return result.rows.map((row) => String(row._smrt_existing_id));
}

/**
 * `UPDATE table SET … WHERE filter RETURNING columns` (each cast to text) in
 * one statement, so the caller learns the exact row it updated without a
 * separate read that could see another row version or, inside a
 * caller-managed PostgreSQL transaction, abort it on failure. SQL adapters
 * only.
 */
export async function updateRowsReturning(
  db: DatabaseInterface,
  tableName: string,
  filter: Record<string, unknown>,
  updates: Record<string, unknown>,
  columns: readonly string[],
): Promise<{ affected: number; rows: Array<Record<string, unknown>> }> {
  const engine = dialect(db);
  const entries = Object.entries(updates);
  const assignments = entries
    .map(
      ([column], index) =>
        `${quote(column)} = ${engine === 'postgres' ? `$${index + 1}` : '?'}`,
    )
    .join(', ');
  const { sql, values } = buildWhere(filter, entries.length + 1, engine);
  const returning = [
    'CAST(id AS VARCHAR) AS _smrt_updated_id',
    ...columns.map(
      (column, index) =>
        `CAST(${quote(column)} AS VARCHAR) AS ${ownerAlias(index)}`,
    ),
  ].join(', ');
  const result = await db.query(
    `UPDATE ${quote(tableName)} SET ${assignments} ${sql} RETURNING ${returning}`,
    ...entries.map(([, value]) => value),
    ...values,
  );
  return {
    affected: result.rows.length,
    rows: result.rows.map((row) =>
      Object.fromEntries(
        columns.map((column, index) => [column, row[ownerAlias(index)]]),
      ),
    ),
  };
}

/** What {@link nullSyncReference} returns for each row it updated. */
export interface NullReferenceReturning {
  /** Return each updated row's id; without it nothing is returned. */
  id: boolean;
  /** Ownership columns to return (as text), as the statement left them. */
  ownerColumns?: readonly string[];
  /** Return the STI discriminator (`_meta_type`). */
  metaType?: boolean;
}

/**
 * Null `column` on every row matching `filter`, advancing tracked rows' sync
 * revision. With `returning.id`, returns each updated row's id (as text), the
 * requested ownership columns as the statement left them (cast to text) and,
 * when asked, its STI discriminator, so the caller can record a change for
 * exactly the rows it changed. The caller passes only columns it proved the
 * table has and the role can read; without `returning` the statement is the
 * one this function always issued.
 */
export async function nullSyncReference(
  db: DatabaseInterface,
  tableName: string,
  column: string,
  filter: Record<string, unknown>,
  didUpdate: (count: number) => void,
  returning: NullReferenceReturning = { id: false },
  raw?: RawPredicate,
): Promise<{ affected: number; rows: DeletedRowOwners }> {
  const ownerColumns = returning.id ? (returning.ownerColumns ?? []) : [];
  if (raw && isJsonAdapterHandle(db)) {
    throw RuntimeError.invalidState(
      'A raw SQL predicate requires a SQL database',
    );
  }
  if (isJsonAdapterHandle(db)) {
    // No RETURNING here; the embedded write queue serializes framework
    // writes, so the rows read just before the update are the rows it changes.
    const before = returning.id ? await db.list(tableName, filter) : [];
    const result = await db.update(tableName, filter, { [column]: null });
    didUpdate(result.affected);
    return {
      affected: result.affected,
      rows: before.map((row) => ({
        id: String(row.id),
        columns: Object.fromEntries(
          ownerColumns
            .filter((owner) => Object.hasOwn(row, owner))
            .map((owner) => [owner, owner === column ? null : row[owner]]),
        ),
        ...(returning.metaType && typeof row._meta_type === 'string'
          ? { metaType: row._meta_type }
          : {}),
      })),
    };
  }
  const engine = dialect(db);
  const parameter = (index: number) =>
    engine === 'postgres' ? `$${index}` : '?';
  const { sql, values } = withRawPredicate(
    buildWhere(filter, 3, engine),
    raw,
    3,
  );
  const device = getDatabaseSyncDeviceId(db);
  const tracked = '_sync_origin_device_id IS NOT NULL';
  const owner = returning.id
    ? ', CAST(id AS VARCHAR) AS _smrt_nulled_id' +
      (returning.metaType ? ', _meta_type' : '') +
      ownerColumns
        .map(
          (ownerColumn, index) =>
            `, CAST(${quote(ownerColumn)} AS VARCHAR) AS ${ownerAlias(index)}`,
        )
        .join('')
    : '';
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
      ${sql} RETURNING _sync_origin_device_id, _sync_revision${owner}`,
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
  if (!returning.id) return { affected: result.rows.length, rows: [] };
  return {
    affected: result.rows.length,
    rows: result.rows.map((row) => ({
      id: String(row._smrt_nulled_id),
      columns: Object.fromEntries(
        ownerColumns.flatMap((ownerColumn, index) =>
          Object.hasOwn(row, ownerAlias(index))
            ? [[ownerColumn, row[ownerAlias(index)]]]
            : [],
        ),
      ),
      ...(returning.metaType && typeof row._meta_type === 'string'
        ? { metaType: row._meta_type }
        : {}),
    })),
  };
}
