import {
  getClassName,
  isQualifiedName,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import { quoteIdentifier } from './db-command-utils.js';

/** A database row as returned by the raw `query` API: keyed by column name. */
type DbRow = Record<string, unknown>;

/**
 * Result of a raw `query` call. Adapters return either a bare row array or an
 * envelope with `rows`/`rowCount`; both shapes are narrowed at the use site.
 */
type QueryResult = DbRow[] | { rows?: DbRow[]; rowCount?: number };

type QueryableDb = {
  query(sql: string, ...params: unknown[]): Promise<QueryResult>;
};

export type StiDiscriminatorUpgradeResult =
  | {
      action: 'skip';
      reason: 'already-current' | 'ambiguous' | 'unregistered' | 'unqualified';
    }
  | {
      action: 'upgrade';
      className: string;
      currentQualifiedName: string;
      sourceKind: 'simple' | 'stale-qualified';
    };

export interface StiDiscriminatorRepairConflict {
  tableName: string;
  legacyMetaType: string;
  qualifiedMetaType: string;
  legacyId: string | null;
  qualifiedId: string | null;
  conflictIdentity: Record<string, unknown>;
}

export interface StiDiscriminatorRepairResult {
  tableName: string;
  legacyMetaType: string;
  qualifiedMetaType: string;
  checkedRows: number;
  updatedRows: number;
  wouldUpdateRows: number;
  conflicts: StiDiscriminatorRepairConflict[];
}

export function resolveStiDiscriminatorUpgrade(
  metaType: string,
): StiDiscriminatorUpgradeResult {
  const className = isQualifiedName(metaType)
    ? getClassName(metaType)
    : metaType;
  const matches = ObjectRegistry.findClassesByName(className);

  if (matches.length === 0) {
    return { action: 'skip', reason: 'unregistered' };
  }

  if (matches.length > 1) {
    return { action: 'skip', reason: 'ambiguous' };
  }

  const registeredClass = matches[0];
  const currentQualifiedName = registeredClass.qualifiedName;

  if (!currentQualifiedName) {
    return { action: 'skip', reason: 'unqualified' };
  }

  if (metaType === currentQualifiedName) {
    return { action: 'skip', reason: 'already-current' };
  }

  return {
    action: 'upgrade',
    className,
    currentQualifiedName,
    sourceKind: isQualifiedName(metaType) ? 'stale-qualified' : 'simple',
  };
}

function rowsFromResult(result: QueryResult): DbRow[] {
  if (Array.isArray(result)) {
    return result;
  }
  return Array.isArray(result?.rows) ? result.rows : [];
}

function getRowCount(result: QueryResult): number | undefined {
  return !Array.isArray(result) && typeof result?.rowCount === 'number'
    ? result.rowCount
    : undefined;
}

function buildNullSafeIdentityPredicate(columns: string[]): string {
  return columns
    .map((column) => {
      const quoted = quoteIdentifier(column);
      return `(${quoted} = ? OR (${quoted} IS NULL AND ? IS NULL))`;
    })
    .join(' AND ');
}

/**
 * Read a row's `id` as a nullable string. STI tables always key on a string
 * `id`; this normalizes the loosely-typed row value for the conflict report
 * without altering the underlying value semantics.
 */
function getRowId(row: DbRow): string | null {
  const id = row.id;
  return id == null ? null : (id as string);
}

function getIdentityParams(row: DbRow, columns: string[]): unknown[] {
  const params: unknown[] = [];
  for (const column of columns) {
    params.push(row[column], row[column]);
  }
  return params;
}

export function getStiConflictIdentityColumns(className: string): string[] {
  return ObjectRegistry.getConflictColumns(className).filter(
    (column) => column !== '_meta_type',
  );
}

export async function repairStiDiscriminatorRows(options: {
  db: QueryableDb;
  tableName: string;
  className: string;
  legacyMetaType: string;
  qualifiedMetaType: string;
  dryRun?: boolean;
}): Promise<StiDiscriminatorRepairResult> {
  const {
    db,
    tableName,
    className,
    legacyMetaType,
    qualifiedMetaType,
    dryRun = false,
  } = options;
  const identityColumns = getStiConflictIdentityColumns(className);
  const selectColumns = Array.from(new Set(['id', ...identityColumns]));
  const quotedTable = quoteIdentifier(tableName);
  const selectSql = `SELECT ${selectColumns.map(quoteIdentifier).join(', ')} FROM ${quotedTable} WHERE ${quoteIdentifier('_meta_type')} = ?`;
  const legacyRows = rowsFromResult(await db.query(selectSql, legacyMetaType));
  const result: StiDiscriminatorRepairResult = {
    tableName,
    legacyMetaType,
    qualifiedMetaType,
    checkedRows: legacyRows.length,
    updatedRows: 0,
    wouldUpdateRows: 0,
    conflicts: [],
  };

  for (const row of legacyRows) {
    const conflictIdentity = Object.fromEntries(
      identityColumns.map((column) => [column, row[column]]),
    );
    const identityPredicate = buildNullSafeIdentityPredicate(identityColumns);
    const duplicateSql = [
      `SELECT ${quoteIdentifier('id')} FROM ${quotedTable}`,
      `WHERE ${quoteIdentifier('_meta_type')} = ?`,
      identityPredicate ? `AND ${identityPredicate}` : '',
      'LIMIT 1',
    ]
      .filter(Boolean)
      .join(' ');
    const duplicateRows = rowsFromResult(
      await db.query(
        duplicateSql,
        qualifiedMetaType,
        ...getIdentityParams(row, identityColumns),
      ),
    );

    if (duplicateRows.length > 0) {
      result.conflicts.push({
        tableName,
        legacyMetaType,
        qualifiedMetaType,
        legacyId: getRowId(row),
        qualifiedId: getRowId(duplicateRows[0]),
        conflictIdentity,
      });
      continue;
    }

    if (dryRun) {
      result.wouldUpdateRows++;
      continue;
    }

    const updateResult = await db.query(
      `UPDATE ${quotedTable} SET ${quoteIdentifier('_meta_type')} = ? WHERE ${quoteIdentifier('id')} = ?`,
      qualifiedMetaType,
      row.id,
    );
    result.updatedRows += getRowCount(updateResult) ?? 1;
  }

  return result;
}
