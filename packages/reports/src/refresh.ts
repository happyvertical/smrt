import { createHash, randomUUID } from 'node:crypto';
import { ObjectRegistry, type SmrtObject } from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import {
  buildAggregate,
  buildWhere,
  type DatabaseInterface,
  type SqlAdapterType,
  tableExists,
  validateColumnName,
} from '@happyvertical/sql';
import {
  buildReportDefinition,
  compileReportDefinition,
  getReportGroupingColumns,
} from './compiler.js';
import {
  assertReportTablesReady,
  REPORT_LOCKS_TABLE,
  REPORT_RUNS_TABLE,
  REPORT_WATERMARKS_TABLE,
  scopeKeyForTenant,
} from './state.js';
import type {
  AggregateSelectExpr,
  AggregateSpec,
  ReportDefinition,
  ReportRefreshMode,
  ReportRefreshOptions,
  ReportRefreshResult,
  ReportSource,
} from './types.js';

type ReportCtor = new (...args: any[]) => SmrtObject;

interface RefreshScope {
  tenantId: string | null;
  scopeKey: string;
  sourceTenantColumn: string | null;
  reportTenantColumn: string | null;
}

interface WatermarkConfig {
  watermarkColumn: string;
  softDeleteColumn: string;
}

interface RefreshWorkResult {
  rowCount: number;
  changedGroupCount: number;
  watermarkBefore?: string | null;
  watermarkAfter?: string | null;
  mode: ReportRefreshMode;
}

interface ReportLockHandle {
  ownerId: string;
  release(): Promise<void>;
}

function isSqlAdapterType(value: unknown): value is SqlAdapterType {
  return (
    value === 'sqlite' ||
    value === 'postgres' ||
    value === 'duckdb' ||
    value === 'json'
  );
}

function adapterTypeFromDb(
  db: DatabaseInterface,
  fallback?: SqlAdapterType,
): SqlAdapterType {
  if (isSqlAdapterType(fallback)) return fallback;

  const url = String(db.url ?? '');
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return 'postgres';
  }
  if (url.endsWith('.duckdb')) {
    return 'duckdb';
  }
  if (url === ':memory:' || url.endsWith('.sqlite') || url.endsWith('.db')) {
    return 'sqlite';
  }
  throw new Error(
    'Report refresh requires a database adapter type. Pass { adapterType }.',
  );
}

function stableReportId(values: unknown[]): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(values))
    .digest('hex');
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `4${hash.slice(13, 16)}`,
    `${variant}${hash.slice(17, 20)}`,
    hash.slice(20, 32),
  ].join('-');
}

function getReportTableName(reportCtor: ReportCtor): string {
  const registered =
    ObjectRegistry.getClassByConstructor(reportCtor) ??
    ObjectRegistry.getClass(reportCtor.name);
  const tableName = registered
    ? ObjectRegistry.getTableName(registered.qualifiedName ?? registered.name)
    : ObjectRegistry.getTableName(reportCtor.name);
  if (!tableName) {
    throw new Error(`No report table registered for ${reportCtor.name}`);
  }
  return tableName;
}

function getActualGroupingColumns(
  definition: Pick<ReportDefinition, 'fields'>,
): string[] {
  return definition.fields
    .filter(
      (field) =>
        field.report?.kind === 'group' || field.report?.kind === 'bucket',
    )
    .map((field) => field.columnName ?? toSnakeCase(field.fieldName));
}

function materializeRows(
  rows: Record<string, any>[],
  definition: ReportDefinition,
  refreshedAt: Date,
  scope: RefreshScope,
): Record<string, any>[] {
  const groupingColumns = getActualGroupingColumns(definition);
  const now = refreshedAt.toISOString();

  return rows.map((row, index) => {
    const groupingValues =
      groupingColumns.length === 0
        ? [definition.reportClassName, scope.scopeKey, index]
        : [
            definition.reportClassName,
            scope.scopeKey,
            ...groupingColumns.map((column) => row[column]),
          ];
    const id = stableReportId(groupingValues);
    const tenantFields = scope.reportTenantColumn
      ? { [scope.reportTenantColumn]: scope.tenantId }
      : {};

    return {
      id,
      slug: id,
      context: scope.scopeKey,
      ...tenantFields,
      ...row,
      refreshed_at: now,
      created_at: now,
      updated_at: now,
    };
  });
}

function sourceClassName(source: ReportSource): string {
  if (typeof source === 'string') return source;
  return source.name;
}

async function fieldColumn(
  className: string,
  requested: string,
): Promise<string | null> {
  const fields = await ObjectRegistry.getAllFields(className);
  const requestedColumn = toSnakeCase(requested);

  for (const [fieldName] of fields.entries()) {
    if (fieldName === requested || toSnakeCase(fieldName) === requestedColumn) {
      return requestedColumn;
    }
  }

  return null;
}

async function tenantColumn(className: string): Promise<string | null> {
  const registered = ObjectRegistry.getClass(className);
  const configuredField = registered?.tenantScopedConfig?.field;
  if (configuredField) {
    return toSnakeCase(configuredField);
  }

  const fields = await ObjectRegistry.getAllFields(className);
  for (const [fieldName, field] of fields.entries()) {
    if (field?._meta?.__tenancy?.isTenantIdField) {
      return toSnakeCase(fieldName);
    }
  }

  const tenantIdField = await fieldColumn(className, 'tenantId');
  return tenantIdField;
}

async function resolveScope(
  definition: ReportDefinition,
  options: ReportRefreshOptions,
): Promise<RefreshScope> {
  const tenantId =
    options.tenantId !== undefined ? options.tenantId : (getTenantId() ?? null);
  const sourceTenantColumn = await tenantColumn(definition.sourceClassName);
  const reportTenantColumn = await tenantColumn(definition.reportClassName);

  if (tenantId && !sourceTenantColumn) {
    throw new Error(
      `Tenant-scoped refresh for ${definition.reportClassName} requires source ` +
        `${definition.sourceClassName} to expose a tenantId field.`,
    );
  }
  if (tenantId && !reportTenantColumn) {
    throw new Error(
      `Tenant-scoped refresh for ${definition.reportClassName} requires the report table to expose a tenantId field.`,
    );
  }

  return {
    tenantId,
    scopeKey: scopeKeyForTenant(tenantId),
    sourceTenantColumn,
    reportTenantColumn,
  };
}

function tenantWhere(scope: RefreshScope): Record<string, unknown> {
  if (!scope.sourceTenantColumn) return {};
  return { [scope.sourceTenantColumn]: scope.tenantId };
}

function andWhere(
  base: AggregateSpec['where'],
  extra: Record<string, unknown>,
): AggregateSpec['where'] {
  if (Object.keys(extra).length === 0) return base;
  if (!base) return extra;
  if (Array.isArray(base)) {
    return base.map((andGroup) => [...andGroup, extra]);
  }
  return { ...base, ...extra };
}

function andHaving(
  base: AggregateSpec['having'],
  extra: Record<string, unknown>,
): AggregateSpec['having'] {
  if (Object.keys(extra).length === 0) return base;
  if (!base) return extra;
  if (Array.isArray(base)) {
    return base.map((andGroup) => [...andGroup, extra]);
  }
  return { ...base, ...extra };
}

function withRefreshFilters(
  spec: AggregateSpec,
  scope: RefreshScope,
  extraWhere: Record<string, unknown> = {},
): AggregateSpec {
  return {
    ...spec,
    where: andWhere(spec.where, {
      ...tenantWhere(scope),
      ...extraWhere,
    }),
  };
}

async function resolveWatermarkConfig(
  definition: ReportDefinition,
): Promise<WatermarkConfig> {
  const configured = definition.refresh ?? {};
  const watermarkField = configured.watermarkColumn ?? 'updatedAt';
  const softDeleteField = configured.softDeleteColumn ?? 'deletedAt';
  const watermarkColumn = await fieldColumn(
    definition.sourceClassName,
    watermarkField,
  );
  const softDeleteColumn = await fieldColumn(
    definition.sourceClassName,
    softDeleteField,
  );

  if (!watermarkColumn) {
    throw new Error(
      `Incremental report ${definition.reportClassName} requires source ` +
        `${definition.sourceClassName} to define watermark column '${watermarkField}'.`,
    );
  }
  if (!softDeleteColumn) {
    throw new Error(
      `Incremental report ${definition.reportClassName} requires source ` +
        `${definition.sourceClassName} to define soft-delete column '${softDeleteField}'.`,
    );
  }

  return { watermarkColumn, softDeleteColumn };
}

function compileChangedGroupSpec(
  definition: ReportDefinition,
  scope: RefreshScope,
  watermark: WatermarkConfig,
  watermarkBefore: string,
): AggregateSpec {
  const spec = compileReportDefinition(definition);
  const select = spec.select.filter(
    (expr): expr is AggregateSelectExpr => !('fn' in expr),
  );

  return withRefreshFilters(
    {
      ...spec,
      select:
        select.length > 0
          ? select
          : [{ fn: 'count', as: '__smrt_changed_count' }],
      groupBy: select.length > 0 ? spec.groupBy : [],
      having: undefined,
    },
    scope,
    { [`${watermark.watermarkColumn} >`]: watermarkBefore },
  );
}

function compileAffectedGroupSpec(
  definition: ReportDefinition,
  scope: RefreshScope,
  watermark: WatermarkConfig,
  groupRow: Record<string, unknown>,
): AggregateSpec {
  const groupingColumns = getActualGroupingColumns(definition);
  const groupHaving = Object.fromEntries(
    groupingColumns.map((column) => [column, groupRow[column]]),
  );
  const spec = withRefreshFilters(compileReportDefinition(definition), scope, {
    [watermark.softDeleteColumn]: null,
  });
  return {
    ...spec,
    having: andHaving(spec.having, groupHaving),
  };
}

function conflictColumns(
  definition: ReportDefinition,
  scope: RefreshScope,
): string[] {
  const groupingColumns = getActualGroupingColumns(definition);
  if (groupingColumns.length === 0) return ['id'];
  return [
    ...(scope.reportTenantColumn ? [scope.reportTenantColumn] : []),
    ...groupingColumns,
  ];
}

function predicateSql(
  tableName: string,
  predicate: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  validateColumnName(tableName);
  const clauses: string[] = [];
  const values: unknown[] = [];

  for (const [column, value] of Object.entries(predicate)) {
    validateColumnName(column);
    if (value === null || value === undefined) {
      clauses.push(`${column} IS NULL`);
      continue;
    }
    clauses.push(`${column} = ?`);
    values.push(value);
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

async function deleteMaterializedGroup(
  db: DatabaseInterface,
  tableName: string,
  definition: ReportDefinition,
  scope: RefreshScope,
  groupRow: Record<string, unknown>,
): Promise<void> {
  const predicate: Record<string, unknown> = {};
  if (scope.reportTenantColumn) {
    predicate[scope.reportTenantColumn] = scope.tenantId;
  }
  for (const column of getActualGroupingColumns(definition)) {
    predicate[column] = groupRow[column];
  }

  const where = predicateSql(tableName, predicate);
  await db.query(
    `DELETE FROM ${validateColumnName(tableName)} ${where.sql}`,
    ...where.values,
  );
}

async function replaceRows(
  db: DatabaseInterface,
  tableName: string,
  rows: Record<string, any>[],
  scope: RefreshScope,
): Promise<void> {
  validateColumnName(tableName);
  const run = async (tx: DatabaseInterface) => {
    if (scope.reportTenantColumn) {
      const where = predicateSql(tableName, {
        [scope.reportTenantColumn]: scope.tenantId,
      });
      await tx.query(`DELETE FROM ${tableName} ${where.sql}`, ...where.values);
    } else {
      await tx.query(`DELETE FROM ${tableName}`);
    }
    if (rows.length > 0) {
      await tx.insert(tableName, rows);
    }
  };

  if (db.transaction) {
    await db.transaction(run);
    return;
  }

  await run(db);
}

function parseMaybeJson<T>(value: T | string | null | undefined): T | null {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return value as T;
  }
}

function watermarkValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function readWatermark(
  db: DatabaseInterface,
  definition: ReportDefinition,
  scope: RefreshScope,
  watermarkColumn: string,
): Promise<string | null> {
  const result = await db.query(
    `SELECT watermark_value FROM ${REPORT_WATERMARKS_TABLE}
      WHERE report_class = ?
        AND scope_key = ?
        AND source_class = ?
        AND watermark_column = ?
      LIMIT 1`,
    definition.reportClassName,
    scope.scopeKey,
    definition.sourceClassName,
    watermarkColumn,
  );
  const row = result.rows[0] as { watermark_value?: unknown } | undefined;
  return watermarkValue(row?.watermark_value);
}

async function writeWatermark(
  db: DatabaseInterface,
  definition: ReportDefinition,
  scope: RefreshScope,
  watermarkColumn: string,
  value: string | null,
  runId: string | undefined,
): Promise<void> {
  if (value === null) return;
  const id = stableReportId([
    'watermark',
    definition.reportClassName,
    scope.scopeKey,
    definition.sourceClassName,
    watermarkColumn,
  ]);
  const now = new Date().toISOString();
  await db.upsert(
    REPORT_WATERMARKS_TABLE,
    ['report_class', 'scope_key', 'source_class', 'watermark_column'],
    {
      id,
      slug: id,
      context: scope.scopeKey,
      tenant_id: scope.tenantId,
      scope_key: scope.scopeKey,
      report_class: definition.reportClassName,
      source_class: definition.sourceClassName,
      watermark_column: watermarkColumn,
      watermark_value: value,
      last_run_id: runId ?? null,
      created_at: now,
      updated_at: now,
    },
  );
}

async function maxWatermark(
  db: DatabaseInterface,
  definition: ReportDefinition,
  scope: RefreshScope,
  watermarkColumn: string,
  adapterType: SqlAdapterType,
): Promise<string | null> {
  const where = andWhere(undefined, tenantWhere(scope));
  const builtWhere = where
    ? buildWhere(where, 1, adapterType)
    : { sql: '', values: [] };
  const result = await db.query(
    `SELECT MAX(${validateColumnName(watermarkColumn)}) AS watermark FROM ${validateColumnName(definition.sourceTable)} ${builtWhere.sql}`,
    ...builtWhere.values,
  );
  const row = result.rows[0] as { watermark?: unknown } | undefined;
  return watermarkValue(row?.watermark);
}

async function startRun(
  db: DatabaseInterface,
  definition: ReportDefinition,
  scope: RefreshScope,
  options: ReportRefreshOptions,
  mode: ReportRefreshMode,
  watermarkBefore?: string | null,
): Promise<string | undefined> {
  if (options.trackRuns === false) return undefined;
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert(REPORT_RUNS_TABLE, {
    id,
    slug: id,
    context: scope.scopeKey,
    tenant_id: scope.tenantId,
    scope_key: scope.scopeKey,
    report_class: definition.reportClassName,
    source_class: definition.sourceClassName,
    mode,
    trigger: options.trigger ?? 'manual',
    status: 'running',
    started_at: now,
    row_count: 0,
    changed_group_count: 0,
    watermark_before: watermarkBefore ?? null,
    watermark_after: null,
    error: null,
    metadata: {
      scheduleId: options.scheduleId,
    },
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function completeRun(
  db: DatabaseInterface,
  runId: string | undefined,
  status: 'success' | 'failed' | 'skipped',
  data: {
    rowCount?: number;
    changedGroupCount?: number;
    watermarkAfter?: string | null;
    error?: unknown;
  } = {},
): Promise<void> {
  if (!runId) return;
  const error =
    data.error instanceof Error
      ? data.error.message
      : data.error
        ? String(data.error)
        : null;
  await db.update(
    REPORT_RUNS_TABLE,
    { id: runId },
    {
      status,
      completed_at: new Date().toISOString(),
      row_count: data.rowCount ?? 0,
      changed_group_count: data.changedGroupCount ?? 0,
      watermark_after: data.watermarkAfter ?? null,
      error,
      updated_at: new Date().toISOString(),
    },
  );
}

async function acquireLock(
  db: DatabaseInterface,
  definition: ReportDefinition,
  scope: RefreshScope,
  ttlMs: number,
): Promise<ReportLockHandle | null> {
  const now = new Date();
  const nowIso = now.toISOString();
  const ownerId = randomUUID();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const expiresAtIso = expiresAt.toISOString();
  const id = stableReportId([
    'lock',
    definition.reportClassName,
    scope.scopeKey,
  ]);
  await db.query(
    `INSERT INTO ${REPORT_LOCKS_TABLE} (
        id,
        slug,
        context,
        tenant_id,
        scope_key,
        report_class,
        owner_id,
        acquired_at,
        heartbeat_at,
        expires_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report_class, scope_key) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        owner_id = excluded.owner_id,
        acquired_at = excluded.acquired_at,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      WHERE ${REPORT_LOCKS_TABLE}.owner_id IS NULL
        OR ${REPORT_LOCKS_TABLE}.expires_at IS NULL
        OR ${REPORT_LOCKS_TABLE}.expires_at <= ?`,
    id,
    id,
    scope.scopeKey,
    scope.tenantId,
    scope.scopeKey,
    definition.reportClassName,
    ownerId,
    nowIso,
    nowIso,
    expiresAtIso,
    nowIso,
    nowIso,
    nowIso,
  );

  const claimed = await db.query(
    `SELECT owner_id FROM ${REPORT_LOCKS_TABLE}
      WHERE report_class = ? AND scope_key = ?
      LIMIT 1`,
    definition.reportClassName,
    scope.scopeKey,
  );
  const row = claimed.rows[0] as { owner_id?: unknown } | undefined;
  if (row?.owner_id !== ownerId) {
    return null;
  }

  return {
    ownerId,
    async release() {
      await db.query(
        `UPDATE ${REPORT_LOCKS_TABLE}
            SET owner_id = NULL,
                heartbeat_at = NULL,
                expires_at = NULL,
                updated_at = ?
          WHERE report_class = ?
            AND scope_key = ?
            AND owner_id = ?`,
        new Date().toISOString(),
        definition.reportClassName,
        scope.scopeKey,
        ownerId,
      );
    },
  };
}

async function rebuildReport(
  db: DatabaseInterface,
  definition: ReportDefinition,
  reportTable: string,
  scope: RefreshScope,
  adapterType: SqlAdapterType,
  runId: string | undefined,
): Promise<RefreshWorkResult> {
  const watermarkColumn =
    definition.refresh?.watermarkColumn &&
    (await fieldColumn(
      definition.sourceClassName,
      definition.refresh.watermarkColumn,
    ));
  const softDeleteColumn =
    definition.refresh?.softDeleteColumn &&
    (await fieldColumn(
      definition.sourceClassName,
      definition.refresh.softDeleteColumn,
    ));
  const deletedFilter = softDeleteColumn ? { [softDeleteColumn]: null } : {};
  const spec = withRefreshFilters(
    compileReportDefinition(definition),
    scope,
    deletedFilter,
  );
  const aggregate = buildAggregate(spec, 1, adapterType);
  const result = await db.query(aggregate.sql, ...aggregate.values);
  const refreshedAt = new Date();
  const rows = materializeRows(result.rows, definition, refreshedAt, scope);

  await replaceRows(db, reportTable, rows, scope);

  const watermarkAfter = watermarkColumn
    ? await maxWatermark(db, definition, scope, watermarkColumn, adapterType)
    : null;
  if (watermarkColumn) {
    await writeWatermark(
      db,
      definition,
      scope,
      watermarkColumn,
      watermarkAfter,
      runId,
    );
  }

  return {
    rowCount: rows.length,
    changedGroupCount: rows.length,
    watermarkAfter,
    mode: 'rebuild',
  };
}

async function incrementalReport(
  db: DatabaseInterface,
  definition: ReportDefinition,
  reportTable: string,
  scope: RefreshScope,
  adapterType: SqlAdapterType,
  runId: string | undefined,
): Promise<RefreshWorkResult> {
  const watermark = await resolveWatermarkConfig(definition);
  const watermarkBefore = await readWatermark(
    db,
    definition,
    scope,
    watermark.watermarkColumn,
  );

  if (!watermarkBefore) {
    const seeded = await rebuildReport(
      db,
      definition,
      reportTable,
      scope,
      adapterType,
      runId,
    );
    return {
      ...seeded,
      watermarkBefore,
    };
  }

  const changedSpec = compileChangedGroupSpec(
    definition,
    scope,
    watermark,
    watermarkBefore,
  );
  const changedAggregate = buildAggregate(changedSpec, 1, adapterType);
  const changed = await db.query(
    changedAggregate.sql,
    ...changedAggregate.values,
  );
  const changedGroups = changed.rows.map((row) =>
    parseMaybeJson<Record<string, unknown>>(row),
  );
  if (changedGroups.length === 0) {
    return {
      rowCount: 0,
      changedGroupCount: 0,
      watermarkBefore,
      watermarkAfter: watermarkBefore,
      mode: 'incremental',
    };
  }

  let rowCount = 0;
  const conflicts = conflictColumns(definition, scope);

  for (const groupRow of changedGroups) {
    if (!groupRow) continue;
    const affectedSpec = compileAffectedGroupSpec(
      definition,
      scope,
      watermark,
      groupRow,
    );
    const aggregate = buildAggregate(affectedSpec, 1, adapterType);
    const result = await db.query(aggregate.sql, ...aggregate.values);
    const refreshedAt = new Date();
    const rows = materializeRows(result.rows, definition, refreshedAt, scope);

    if (rows.length === 0) {
      await deleteMaterializedGroup(
        db,
        reportTable,
        definition,
        scope,
        groupRow,
      );
      continue;
    }

    for (const row of rows) {
      await db.upsert(reportTable, conflicts, row);
      rowCount += 1;
    }
  }

  const watermarkAfter = await maxWatermark(
    db,
    definition,
    scope,
    watermark.watermarkColumn,
    adapterType,
  );
  await writeWatermark(
    db,
    definition,
    scope,
    watermark.watermarkColumn,
    watermarkAfter,
    runId,
  );

  return {
    rowCount,
    changedGroupCount: changedGroups.length,
    watermarkBefore,
    watermarkAfter,
    mode: 'incremental',
  };
}

async function refreshReportOnce(
  reportCtor: ReportCtor,
  options: ReportRefreshOptions,
): Promise<ReportRefreshResult> {
  if (!options.db) {
    throw new Error('refreshReport requires a database handle');
  }

  const definition = await buildReportDefinition(reportCtor);
  const reportTable = getReportTableName(reportCtor);
  const requestedMode = options.mode ?? definition.refresh?.mode ?? 'rebuild';
  const exists = await tableExists(options.db, reportTable);
  if (!exists) {
    throw new Error(
      `Report table '${reportTable}' does not exist for ${reportCtor.name}. ` +
        `Run smrt db:migrate before refreshing reports.`,
    );
  }

  if (options.trackRuns !== false || options.lock !== false) {
    await assertReportTablesReady(options.db);
  } else if (requestedMode === 'incremental') {
    await assertReportTablesReady(options.db, [REPORT_WATERMARKS_TABLE]);
  }

  const adapterType = adapterTypeFromDb(options.db, options.adapterType);
  const scope = await resolveScope(definition, options);
  const lock =
    options.lock === false
      ? null
      : await acquireLock(
          options.db,
          definition,
          scope,
          options.lockTtlMs ?? 15 * 60 * 1000,
        );

  if (options.lock !== false && !lock) {
    const runId = await startRun(
      options.db,
      definition,
      scope,
      options,
      requestedMode,
    );
    await completeRun(options.db, runId, 'skipped');
    return {
      rowCount: 0,
      refreshedAt: new Date(),
      mode: requestedMode,
      tenantId: scope.tenantId,
      runId,
      changedGroupCount: 0,
      skipped: true,
    };
  }

  let runId: string | undefined;
  try {
    runId = await startRun(
      options.db,
      definition,
      scope,
      options,
      requestedMode,
    );
    const work =
      requestedMode === 'incremental'
        ? await incrementalReport(
            options.db,
            definition,
            reportTable,
            scope,
            adapterType,
            runId,
          )
        : await rebuildReport(
            options.db,
            definition,
            reportTable,
            scope,
            adapterType,
            runId,
          );

    await completeRun(options.db, runId, 'success', {
      rowCount: work.rowCount,
      changedGroupCount: work.changedGroupCount,
      watermarkAfter: work.watermarkAfter,
    });

    return {
      rowCount: work.rowCount,
      refreshedAt: new Date(),
      mode: work.mode,
      tenantId: scope.tenantId,
      runId,
      changedGroupCount: work.changedGroupCount,
    };
  } catch (error) {
    await completeRun(options.db, runId, 'failed', { error });
    throw error;
  } finally {
    await lock?.release();
  }
}

export async function refreshReport(
  reportCtor: ReportCtor,
  options: ReportRefreshOptions = {},
): Promise<ReportRefreshResult> {
  if (options.tenantIds && options.tenantIds.length > 0) {
    if (!options.db) {
      throw new Error('refreshReport requires a database handle');
    }
    const results: ReportRefreshResult[] = [];
    for (const tenantId of options.tenantIds) {
      const result = await withTenant({ tenantId }, () =>
        refreshReportOnce(reportCtor, {
          ...options,
          tenantId,
          tenantIds: undefined,
        }),
      );
      results.push(result);
    }
    return {
      rowCount: results.reduce((sum, result) => sum + result.rowCount, 0),
      refreshedAt: new Date(),
      mode: results[0]?.mode ?? options.mode ?? 'rebuild',
      tenantId: null,
      changedGroupCount: results.reduce(
        (sum, result) => sum + (result.changedGroupCount ?? 0),
        0,
      ),
      tenantResults: results,
    };
  }

  return refreshReportOnce(reportCtor, options);
}

export function reportRowIdentity(
  row: Record<string, any>,
  definition: ReportDefinition,
): string {
  const groupingColumns = getReportGroupingColumns(definition);
  return stableReportId(
    groupingColumns.map((column) => row[toSnakeCase(column)]),
  );
}

export function reportSourceClassName(source: ReportSource): string {
  return sourceClassName(source);
}
