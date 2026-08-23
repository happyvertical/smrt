import {
  createDataQueryFingerprint,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  ObjectRegistry,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import type {
  DataQueryFieldDescriptor,
  DataQueryResult,
  DataQuerySchema,
} from '@happyvertical/smrt-types';
import { buildReportDefinition } from './compiler.js';
import type {
  ReportAggregateFn,
  ReportDefinition,
  ReportFieldDefinition,
  ReportRefreshConfig,
  ReportTimeBucketUnit,
} from './types.js';

/** Presentation and policy metadata understood by the report adapter. */
export type ReportColumnSensitivity =
  | 'public'
  | 'personal'
  | 'sensitive'
  | 'secret';

export type ReportColumnCapability =
  | 'read'
  | 'project'
  | 'filter'
  | 'sort'
  | 'facet'
  | 'group'
  | 'aggregate';

export type ReportColumnKind = 'identity' | 'group' | 'bucket' | 'aggregate';

export interface ReportColumnDescriptor extends DataQueryFieldDescriptor {
  /** Stable output column id (never a property path). */
  id: string;
  fieldName: string;
  label: string;
  kind: ReportColumnKind;
  /** Capabilities available from this adapter revision. */
  capabilities: ReportColumnCapability[];
  format?: string;
  sensitivity?: ReportColumnSensitivity;
  sourceColumn?: string;
  bucket?: ReportTimeBucketUnit;
  aggregate?: ReportAggregateFn;
  distinct?: boolean;
}

export interface ReportRefreshDescriptor {
  mode: 'rebuild' | 'incremental';
  /**
   * Whether the report configuration lets a registered SmrtReportCollection
   * synchronously refresh a stale read. Generic collection reads stay
   * read-only and report unknown freshness until the lifecycle adapter runs.
   */
  mayRefreshOnRead: boolean;
  ttlMs?: number;
  triggers: Array<'manual' | 'schedule' | 'change' | 'ttl' | 'job'>;
  /** Declared only; the lifecycle adapter owns authorization, audit, and run state. */
  action: ReportRefreshActionDescriptor;
}

/** A report-wide lifecycle action, never a mutation performed by this adapter. */
export interface ReportRefreshActionDescriptor {
  id: 'refresh';
  label: 'Refresh report';
  scope: 'surface';
  phases: Array<'preview' | 'apply'>;
  requiresPermission: true;
  requiredPermission: string;
  auditRequired: true;
}

/**
 * The report-owned, transport-neutral descriptor. Consumers can map `schema`
 * to the canonical data-query runtime and `columns` to their presentation
 * contract without importing smrt-ui or a report domain class.
 */
export interface ReportAdapterDescriptor {
  version: 1;
  resourceId: string;
  reportClassName: string;
  sourceClassName: string;
  tenantScoped: boolean;
  tenantField?: string;
  identityField: 'id';
  columns: ReportColumnDescriptor[];
  schema: DataQuerySchema;
  dataTable: ReportDataTableDescriptor;
  refresh: ReportRefreshDescriptor;
}

/** Structural DataTable view hints; deliberately not a smrt-ui dependency. */
export interface ReportDataTableColumn {
  id: string;
  label: string;
  accessor: string;
  sortable: boolean;
  searchable: false;
  filterable: false;
}

export interface ReportDataTableDescriptor {
  rowKey: 'id';
  manualPagination: true;
  manualSorting: true;
  enableFiltering: false;
  enableSearch: false;
  columns: ReportDataTableColumn[];
}

export interface ReportAdapterOptions {
  /** Scope used only to make a stable resource id; it is not authority. */
  tenantScope?: 'current' | 'global' | 'tenant';
  /** Permission that a lifecycle action host must require before refresh. */
  refreshPermission?: string;
}

export interface ReportQueryOptions {
  /** Injected collection seam for tests and application-owned adapters. */
  collection?: {
    list(
      options: Record<string, unknown>,
    ): Promise<Array<Record<string, unknown>>>;
    count(options?: Record<string, unknown>): Promise<number>;
  };
  db?: import('@happyvertical/sql').DatabaseInterface;
}

type RegistryField = {
  type?: string;
  transient?: boolean;
  description?: string;
  sensitive?: boolean;
  readPermission?: string;
  format?: unknown;
  sensitivity?: unknown;
  _meta?: Record<string, unknown>;
};
const SENSITIVITIES = new Set<ReportColumnSensitivity>([
  'public',
  'personal',
  'sensitive',
  'secret',
]);

function registeredClass(
  ctor: new (...args: any[]) => SmrtObject,
): ReturnType<typeof ObjectRegistry.getClassByConstructor> {
  return (
    ObjectRegistry.getClassByConstructor(ctor) ??
    ObjectRegistry.getClass(ctor.name)
  );
}

function fieldPolicy(field: RegistryField | undefined): {
  sensitive: boolean;
  readPermission?: string;
} {
  const meta = field?._meta ?? {};
  const sensitivity = [field?.sensitivity, meta.sensitivity].find(
    (value): value is string => typeof value === 'string',
  );
  return {
    sensitive:
      field?.sensitive === true ||
      meta.sensitive === true ||
      sensitivity === 'sensitive' ||
      sensitivity === 'secret',
    readPermission:
      typeof field?.readPermission === 'string'
        ? field.readPermission
        : typeof meta.readPermission === 'string'
          ? meta.readPermission
          : undefined,
  };
}

function descriptorMetadata(field: RegistryField | undefined): {
  format?: string;
  sensitivity?: ReportColumnSensitivity;
} {
  const metadata = field?._meta ?? {};
  const format = [field?.format, metadata.format].find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const rawSensitivity = [field?.sensitivity, metadata.sensitivity].find(
    (value): value is string =>
      typeof value === 'string' &&
      SENSITIVITIES.has(value as ReportColumnSensitivity),
  );
  return {
    ...(format ? { format } : {}),
    ...(rawSensitivity
      ? { sensitivity: rawSensitivity as ReportColumnSensitivity }
      : {}),
  };
}

function labelFor(fieldName: string): string {
  return fieldName
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (value) => value.toUpperCase());
}

function queryType(type: string | undefined): DataQueryFieldDescriptor['type'] {
  switch (type) {
    case 'integer':
    case 'decimal':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'datetime':
      return 'datetime';
    case 'json':
      return 'json';
    default:
      return 'string';
  }
}

function configuredTenantField(configured?: string): string | undefined {
  return configured ? toSnakeCase(configured) : undefined;
}

function isColumnBackedField(field: RegistryField | undefined): boolean {
  if (!field) return false;
  if (field.transient === true || field._meta?.transient === true) return false;
  return !['meta', 'oneToMany', 'manyToMany'].includes(field.type ?? '');
}

function reportColumn(
  field: ReportFieldDefinition,
  registryField: RegistryField | undefined,
): ReportColumnDescriptor | undefined {
  const policy = fieldPolicy(registryField);
  // A descriptor is an exposure boundary. Without a principal/permission
  // context, sensitive, permission-gated, and non-column fields fail closed.
  if (
    policy.sensitive ||
    policy.readPermission ||
    !isColumnBackedField(registryField)
  ) {
    return undefined;
  }

  const id = field.columnName ?? toSnakeCase(field.fieldName);
  const report = field.report;
  if (!report) return undefined;
  const type = queryType(field.type ?? registryField?.type);
  const base: ReportColumnDescriptor = {
    id,
    fieldName: field.fieldName,
    label: registryField?.description || labelFor(field.fieldName),
    kind: report.kind,
    type,
    projectable: true,
    sortable: false,
    facetable: false,
    capabilities: ['project', 'read'],
    ...(report.kind === 'group'
      ? { sourceColumn: toSnakeCase(report.sourceColumn ?? field.fieldName) }
      : {}),
    ...(report.kind === 'bucket'
      ? { bucket: report.unit, sourceColumn: toSnakeCase(report.sourceColumn) }
      : {}),
    ...(report.kind === 'aggregate'
      ? {
          aggregate: report.fn,
          ...(report.column
            ? { sourceColumn: toSnakeCase(report.column) }
            : {}),
          ...(report.distinct === undefined
            ? {}
            : { distinct: report.distinct }),
        }
      : {}),
    ...descriptorMetadata(registryField),
  };
  return base;
}

function identityColumn(): ReportColumnDescriptor {
  return {
    id: 'id',
    fieldName: 'id',
    label: 'ID',
    kind: 'identity',
    type: 'string',
    projectable: true,
    sortable: true,
    capabilities: ['project', 'read', 'sort'],
  };
}

function toQueryField(
  column: ReportColumnDescriptor,
): DataQueryFieldDescriptor {
  return {
    id: column.id,
    type: column.type,
    ...(column.projectable === undefined
      ? {}
      : { projectable: column.projectable }),
    sortable: column.id === 'id',
    facetable: false,
  };
}

function refreshDescriptor(
  refresh?: ReportRefreshConfig,
  refreshPermission = 'reports.refresh',
): ReportRefreshDescriptor {
  const config = refresh ?? {};
  const triggers = new Set<ReportRefreshDescriptor['triggers'][number]>([
    'manual',
  ]);
  if (!config.manual) {
    const hasSchedule = Boolean(config.schedule || config.fullRebuildSchedule);
    const hasChangeTrigger = Boolean(config.onChange?.length);
    if (hasSchedule) triggers.add('schedule');
    if (hasChangeTrigger) triggers.add('change');
    if (config.ttl !== undefined && config.ttl > 0) triggers.add('ttl');
    // Scheduler and on-change refreshes enqueue a durable job in either mode;
    // incremental mode alone is not itself a trigger.
    if (hasSchedule || hasChangeTrigger) triggers.add('job');
  }
  return {
    mode: config.mode ?? 'rebuild',
    mayRefreshOnRead:
      config.ttl !== undefined && config.ttl > 0 && !config.manual,
    ...(config.ttl === undefined ? {} : { ttlMs: config.ttl }),
    triggers: [...triggers],
    action: {
      id: 'refresh',
      label: 'Refresh report',
      scope: 'surface',
      phases: ['preview', 'apply'],
      requiresPermission: true,
      requiredPermission:
        refreshPermission.trim().length > 0
          ? refreshPermission
          : 'reports.refresh',
      auditRequired: true,
    },
  };
}

function resourceId(
  definition: ReportDefinition,
  scope: ReportAdapterOptions['tenantScope'],
): string {
  return `${definition.reportClassName}#${scope ?? 'current'}`;
}

export async function buildReportAdapterDescriptor(
  reportCtor: new (...args: any[]) => SmrtObject,
  options: ReportAdapterOptions = {},
): Promise<ReportAdapterDescriptor> {
  const definition = await buildReportDefinition(reportCtor);
  const registered = registeredClass(reportCtor);
  const fields = (await ObjectRegistry.getAllFields(
    definition.reportClassName,
  )) as Map<string, RegistryField>;
  // A tenant-looking field is not an isolation boundary. Only registered
  // tenant scoping installs the collection interceptor used by the executor.
  const tenantField = configuredTenantField(
    registered?.tenantScopedConfig?.field,
  );
  const columns = [
    identityColumn(),
    ...definition.fields
      .map((field) => reportColumn(field, fields.get(field.fieldName)))
      .filter((field): field is ReportColumnDescriptor => Boolean(field)),
  ].sort((left, right) => left.id.localeCompare(right.id));
  const schema: DataQuerySchema = {
    version: 1,
    identityField: 'id',
    fields: columns.map(toQueryField),
    defaultSort: [{ field: 'id', direction: 'asc' }],
    supports: { cursorPagination: false, consistency: false, facets: false },
  };
  const dataTable: ReportDataTableDescriptor = {
    rowKey: 'id',
    manualPagination: true,
    manualSorting: true,
    enableFiltering: false,
    enableSearch: false,
    columns: columns.map((column) => ({
      id: column.id,
      label: column.label,
      accessor: column.id,
      sortable: column.id === 'id',
      searchable: false,
      filterable: false,
    })),
  };
  return {
    version: 1,
    resourceId: resourceId(definition, options.tenantScope),
    reportClassName: definition.reportClassName,
    sourceClassName: definition.sourceClassName,
    tenantScoped: Boolean(registered?.tenantScopedConfig),
    ...(tenantField ? { tenantField } : {}),
    identityField: 'id',
    columns,
    schema,
    dataTable,
    refresh: refreshDescriptor(definition.refresh, options.refreshPermission),
  };
}

function publicFieldMap(
  descriptor: ReportAdapterDescriptor,
): Map<string, string> {
  return new Map(
    descriptor.columns.map((column) => [column.id, column.fieldName]),
  );
}

function jsonSafeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, jsonSafeValue(entry)]),
    );
  }
  return value;
}

function mapMaterializedRow(
  row: Record<string, unknown>,
  projection: readonly string[],
  fieldMap: Map<string, string>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const id of projection) {
    const sourceField = fieldMap.get(id) ?? id;
    if (sourceField in row) mapped[id] = jsonSafeValue(row[sourceField]);
  }
  return mapped;
}

/**
 * Execute the bounded materialized-read slice owned by #2457.
 *
 * Dimension/measure filters, HAVING/WHERE mapping, facets, and caller-selected
 * dimension/measure ordering intentionally remain unsupported until their
 * report-specific adapter slice lands. Identity ordering stays available for
 * deterministic paging. The collection is the tenant boundary: callers may
 * inject one, but the default path resolves it through ObjectRegistry so the
 * normal SMRT tenancy interceptors apply.
 */
export async function queryReportMaterializedRows(
  reportCtor: new (...args: any[]) => SmrtObject,
  input: unknown,
  options: ReportQueryOptions = {},
): Promise<DataQueryResult> {
  const descriptor = await buildReportAdapterDescriptor(reportCtor);
  const request = normalizeDataQueryRequest(input, descriptor.schema);
  if (request.mode === 'facets') {
    throw new Error('Report materialized reads do not support facets yet');
  }
  const fieldMap = publicFieldMap(descriptor);
  const collection: NonNullable<ReportQueryOptions['collection']> =
    options.collection ??
    ((await ObjectRegistry.getCollection(descriptor.reportClassName, {
      db: options.db,
    })) as unknown as NonNullable<ReportQueryOptions['collection']>);
  let rows: Record<string, unknown>[] = [];
  let page: DataQueryResult['page'];
  let total: number;
  if (request.mode === 'rows') {
    const projection = request.projection ?? [descriptor.identityField];
    const select = projection.map((id) => fieldMap.get(id) ?? id);
    const offset = request.page?.kind === 'offset' ? request.page.offset : 0;
    const limit = request.page?.limit ?? 50;
    const orderBy = request.sort?.map(
      ({ field, direction }) =>
        `${fieldMap.get(field) ?? field} ${direction.toUpperCase()}`,
    );
    const materialized = await collection.list({
      select,
      offset,
      limit,
      orderBy: orderBy?.length === 1 ? orderBy[0] : orderBy,
    });
    rows = materialized.map((row) =>
      mapMaterializedRow(row, projection, fieldMap),
    );
    rows.forEach((row) => {
      if (typeof row.id !== 'string' || row.id.length === 0) {
        throw new Error(
          'Materialized report rows require a non-empty string id',
        );
      }
    });
    // SmrtReportCollection performs an eligible TTL refresh from list(). Count
    // must follow that operation so total/hasMore describe the same snapshot.
    total = await collection.count();
    page = {
      kind: 'offset',
      offset,
      limit,
      hasMore: offset + rows.length < total,
    };
  } else {
    // Count-only reads still enter SmrtReportCollection's list lifecycle to
    // refresh an eligible stale report before calculating its exact total.
    await collection.list({
      select: ['id'],
      offset: 0,
      limit: 1,
      orderBy: 'id ASC',
    });
    total = await collection.count();
  }
  const result = {
    version: 1 as const,
    requestId: request.requestId,
    queryFingerprint: createDataQueryFingerprint(request, descriptor.schema),
    identityField: descriptor.identityField,
    rows,
    ...(page ? { page } : {}),
    total: { kind: 'exact' as const, value: total },
    freshness: { state: 'unknown' as const },
    warnings: [],
    truncated: false,
  };
  return normalizeDataQueryResult(result, request, descriptor.schema);
}

/** Read the already-materialized primary key; never use a display/page index. */
export function reportMaterializedRowKey(row: Record<string, unknown>): string {
  const id = row.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Materialized report rows require a non-empty string id');
  }
  return id;
}
