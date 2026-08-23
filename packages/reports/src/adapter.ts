import {
  createDataQueryFingerprint,
  DataQueryValidationError,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  ObjectRegistry,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import type {
  DataQueryCondition,
  DataQueryFieldDescriptor,
  DataQueryFilter,
  DataQueryFilterOperator,
  DataQueryFreshness,
  DataQueryRequest,
  DataQueryResult,
  DataQuerySchema,
} from '@happyvertical/smrt-types';
import { buildReportDefinition } from './compiler.js';
import {
  getReportLifecycle,
  type ReportLifecycleOptions,
  type ReportLifecycleSnapshot,
} from './lifecycle.js';
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

/**
 * Source-query clause a field belongs to. The materialized read executor
 * applies both kinds through its tenant-scoped collection, but consumers use
 * this declaration to keep dimensions/periods (WHERE) distinct from measures
 * (HAVING) when constructing drilldowns, saved views, or a live query.
 */
export type ReportFilterScope = 'where' | 'having';

export interface ReportColumnDescriptor extends DataQueryFieldDescriptor {
  /** Stable output column id (never a property path). */
  id: string;
  fieldName: string;
  label: string;
  kind: ReportColumnKind;
  filterScope: ReportFilterScope;
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
  queryExecution: ReportQueryExecutionDescriptor;
  dataTable: ReportDataTableDescriptor;
  drilldown: ReportDrilldownDescriptor;
  refresh: ReportRefreshDescriptor;
}

/**
 * Delivery choices for the same bounded report query. They never add
 * authority: a host owns visible state and background-job execution.
 */
export type ReportQueryExecutionMode = 'visible' | 'background' | 'silent';

export interface ReportQueryExecutionDescriptor {
  modes: ReportQueryExecutionMode[];
  /** The caller may apply the returned rows to an already-authorized surface. */
  visible: { delivery: 'result' };
  /** A host queues the authority-free task and returns no materialized rows yet. */
  background: { delivery: 'queued'; requiresHost: true };
  /** The caller receives rows but the adapter makes no visible-surface change. */
  silent: { delivery: 'result'; mutatesVisibleSurface: false };
}

/**
 * The exact bounded request a background host may persist. Tenant, principal,
 * collection, database, and display state deliberately remain with that host.
 */
export interface ReportBackgroundQueryTask {
  version: 1;
  execution: 'background';
  resourceId: string;
  reportClassName: string;
  request: DataQueryRequest;
  inherits: Array<
    'principal' | 'tenant' | 'report-definition' | 'field-policy'
  >;
}

/** Queuing a background query returns a handle, never rows from another scope. */
export interface ReportBackgroundQueryResult {
  version: 1;
  execution: 'background';
  status: 'queued';
  taskId: string;
  queryFingerprint: string;
}

/** One row value that can safely constrain a source-record drilldown. */
export interface ReportDrilldownFieldDescriptor {
  /** Stable report column id; never a display label. */
  id: string;
  /** Declared source field/column chosen by report metadata, not caller input. */
  sourceColumn: string;
  kind: 'group' | 'bucket';
  /** A bucket stays declarative so the source adapter preserves report timezone semantics. */
  bucket?: ReportTimeBucketUnit;
}

/**
 * Declarative source-query handoff for a report row. No client can supply a
 * principal, tenant, report definition, or arbitrary source field here.
 */
export interface ReportDrilldownDescriptor {
  id: 'drilldown';
  sourceClassName: string;
  fields: ReportDrilldownFieldDescriptor[];
  inherits: Array<
    'principal' | 'tenant' | 'report-definition' | 'field-policy'
  >;
}

export interface ReportDrilldownConstraint {
  id: string;
  sourceColumn: string;
  kind: 'group' | 'bucket';
  value: unknown;
  bucket?: ReportTimeBucketUnit;
}

/** A server adapter uses this authority-free handoff to execute a source drilldown. */
export interface ReportDrilldownQuery {
  version: 1;
  resourceId: string;
  reportClassName: string;
  sourceClassName: string;
  constraints: ReportDrilldownConstraint[];
  inherits: Array<
    'principal' | 'tenant' | 'report-definition' | 'field-policy'
  >;
}

/** Structural DataTable view hints; deliberately not a smrt-ui dependency. */
export interface ReportDataTableHeaderPathSegment {
  /** Stable group identity within a header level. */
  id: string;
  /** Human-readable grouped-header label. */
  label: string;
}

/** Responsive metadata that maps directly to a consumer's table contract. */
export interface ReportDataTableColumnResponsive {
  /** Higher values make a column more important during responsive collapse. */
  priority?: number;
  /** Keep key dimensions reachable during responsive collapse. */
  keepVisible?: boolean;
}

/**
 * A rendering instruction for a raw materialized value. Formatting is never
 * applied to a query row, so sorting, export, and agent consumers retain it.
 */
export type ReportDataTableValueFormat =
  | 'text'
  | 'date'
  | 'datetime'
  | 'percentage'
  | 'count'
  | 'money'
  | 'number';

export type ReportDataTableColumnRole = 'data' | 'status' | 'action';

export interface ReportDataTableColumn {
  id: string;
  label: string;
  accessor: string;
  sortable: boolean;
  searchable: false;
  filterable: boolean;
  /** Group ancestry for consumers with multi-level table headers. */
  headerPath: ReportDataTableHeaderPathSegment[];
  /** Consumer-side display instruction; materialized rows remain raw. */
  valueFormat: ReportDataTableValueFormat;
  /** The default alignment for the formatted display value. */
  align: 'left' | 'right';
  /** Generic semantic role for status/action columns introduced by later slices. */
  role: ReportDataTableColumnRole;
  responsive: ReportDataTableColumnResponsive;
}

export type ReportDataTableStructuralRowKind =
  | 'summary'
  | 'subtotal'
  | 'aggregate'
  | 'footer';

/** Input supplied by a report consumer that computes a summary or subtotal. */
export interface ReportDataTableStructuralRowInput {
  id: string;
  kind: ReportDataTableStructuralRowKind;
  label: string;
  /** Raw values keyed by the adapter's stable column id. */
  values?: Readonly<Record<string, unknown>>;
  /** Column that renders this row's accessible row header. */
  labelColumnId?: string;
}

/**
 * Structural rows are intentionally separate from materialized data rows.
 * Consumers pass them to their DataTable's structural-row slot/prop, never its
 * selectable data collection.
 */
export interface ReportDataTableStructuralRow
  extends ReportDataTableStructuralRowInput {
  selection: 'excluded';
  actions: 'excluded';
}

/** Per-column presentation overrides owned by the consuming report surface. */
export interface ReportDataTableColumnOverride {
  label?: string;
  headerPath?: readonly ReportDataTableHeaderPathSegment[];
  valueFormat?: ReportDataTableValueFormat;
  align?: 'left' | 'right';
  role?: ReportDataTableColumnRole;
  responsive?: ReportDataTableColumnResponsive;
}

export interface ReportDataTablePresentationOptions {
  /** Overrides are keyed by stable adapter column id, not display labels. */
  columns?: Readonly<Record<string, ReportDataTableColumnOverride>>;
  /** Summary/subtotal rows remain structural rather than materialized data rows. */
  structuralRows?: readonly ReportDataTableStructuralRowInput[];
}

export interface ReportDataTableDescriptor {
  rowKey: 'id';
  manualPagination: true;
  manualSorting: true;
  enableFiltering: true;
  enableSearch: false;
  columns: ReportDataTableColumn[];
  structuralRows: ReportDataTableStructuralRow[];
}

export interface ReportAdapterOptions {
  /** Scope used only to make a stable resource id; it is not authority. */
  tenantScope?: 'current' | 'global' | 'tenant';
  /** Permission that a lifecycle action host must require before refresh. */
  refreshPermission?: string;
  /** Consumer-owned presentational preferences; they never affect query rows. */
  dataTable?: ReportDataTablePresentationOptions;
}

interface ReportQueryCommonOptions {
  /** Injected collection seam for tests and application-owned adapters. */
  collection?: {
    list(
      options: Record<string, unknown>,
    ): Promise<Array<Record<string, unknown>>>;
    count(options?: Record<string, unknown>): Promise<number>;
    facets?(options: Record<string, unknown>): Promise<
      Array<{
        field: string;
        values: Array<{
          value: string | number | boolean | null;
          count: number;
        }>;
      }>
    >;
  };
  db?: import('@happyvertical/sql').DatabaseInterface;
  /**
   * Opt in to a tenant-safe lifecycle snapshot alongside this materialized
   * read. It never makes a generic read mutate.
   */
  lifecycle?: Omit<ReportLifecycleOptions, 'db'>;
}

/** Visible is the default; silent has identical data authority but no UI intent. */
export interface ReportQueryOptions extends ReportQueryCommonOptions {
  execution?: 'visible' | 'silent';
}

/** Background execution is possible only through an application-owned queue host. */
export interface ReportBackgroundQueryOptions extends ReportQueryCommonOptions {
  execution: 'background';
  enqueueBackgroundQuery(
    task: ReportBackgroundQueryTask,
  ): Promise<{ taskId: string }>;
}

/** Lifecycle context attached only when a caller explicitly opts in. */
export interface ReportMaterializedReadLifecycle {
  snapshot: ReportLifecycleSnapshot;
  /** Whether this collection read appears to have completed a TTL refresh. */
  read: 'current' | 'stale' | 'refresh-triggered';
}

export interface ReportDataQueryResult extends DataQueryResult {
  /** Delivery intent only; the adapter never mutates a visible surface. */
  execution: 'visible' | 'silent';
  reportLifecycle?: ReportMaterializedReadLifecycle;
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
  const filterOperators = filterOperatorsFor(type);
  const base: ReportColumnDescriptor = {
    id,
    fieldName: field.fieldName,
    label: registryField?.description || labelFor(field.fieldName),
    kind: report.kind,
    filterScope: report.kind === 'aggregate' ? 'having' : 'where',
    type,
    projectable: true,
    sortable: true,
    facetable: report.kind !== 'aggregate',
    ...(filterOperators ? { filterOperators } : {}),
    capabilities: [
      'project',
      'read',
      ...(filterOperators ? (['filter'] as const) : []),
      'sort',
      ...(report.kind !== 'aggregate' ? (['facet'] as const) : []),
      ...(report.kind === 'aggregate'
        ? (['aggregate'] as const)
        : report.kind === 'group'
          ? (['group'] as const)
          : []),
    ],
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
    filterScope: 'where',
    type: 'string',
    projectable: true,
    sortable: true,
    facetable: false,
    filterOperators: filterOperatorsFor('string'),
    capabilities: ['project', 'read', 'filter', 'sort'],
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
    sortable: column.sortable === true,
    facetable: column.facetable === true,
    ...(column.filterOperators === undefined
      ? {}
      : { filterOperators: [...column.filterOperators] }),
  };
}

function filterOperatorsFor(
  type: DataQueryFieldDescriptor['type'],
): DataQueryFilterOperator[] | undefined {
  switch (type) {
    case 'string':
      return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn', 'like'];
    case 'number':
    case 'datetime':
      return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn'];
    case 'boolean':
      return ['eq', 'ne', 'in', 'notIn'];
    case 'json':
      return undefined;
  }
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

const VALUE_FORMAT_ALIASES: Readonly<
  Record<string, ReportDataTableValueFormat>
> = {
  text: 'text',
  date: 'date',
  datetime: 'datetime',
  'date-time': 'datetime',
  percentage: 'percentage',
  percent: 'percentage',
  count: 'count',
  money: 'money',
  currency: 'money',
  number: 'number',
  decimal: 'number',
  integer: 'number',
};

const VALUE_FORMATS = new Set<ReportDataTableValueFormat>(
  Object.values(VALUE_FORMAT_ALIASES),
);
const COLUMN_ROLES = new Set<ReportDataTableColumnRole>([
  'data',
  'status',
  'action',
]);
const STRUCTURAL_ROW_KINDS = new Set<ReportDataTableStructuralRowKind>([
  'summary',
  'subtotal',
  'aggregate',
  'footer',
]);

function valueFormat(
  column: ReportColumnDescriptor,
): ReportDataTableValueFormat {
  const configured = column.format?.trim().toLowerCase();
  if (configured && Object.hasOwn(VALUE_FORMAT_ALIASES, configured)) {
    return VALUE_FORMAT_ALIASES[configured];
  }
  if (column.kind === 'bucket') {
    return column.bucket === 'minute' || column.bucket === 'hour'
      ? 'datetime'
      : 'date';
  }
  if (column.kind === 'aggregate' && column.aggregate === 'count') {
    return 'count';
  }
  if (column.type === 'datetime') return 'datetime';
  if (column.type === 'number') return 'number';
  return 'text';
}

function headerPath(
  column: ReportColumnDescriptor,
): ReportDataTableHeaderPathSegment[] {
  if (column.kind === 'aggregate') {
    return [
      { id: 'measures', label: 'Measures' },
      {
        id: `aggregate:${column.aggregate ?? 'value'}`,
        label: labelFor(column.aggregate ?? 'value'),
      },
    ];
  }
  if (column.kind === 'bucket') {
    return [
      { id: 'dimensions', label: 'Dimensions' },
      { id: 'time', label: 'Time' },
    ];
  }
  if (column.kind === 'group') {
    return [
      { id: 'dimensions', label: 'Dimensions' },
      { id: 'groups', label: 'Groups' },
    ];
  }
  return [{ id: 'dimensions', label: 'Dimensions' }];
}

function responsive(
  column: ReportColumnDescriptor,
): ReportDataTableColumnResponsive {
  if (column.kind === 'group' || column.kind === 'bucket') {
    return { priority: 100, keepVisible: true };
  }
  if (column.kind === 'identity') return { priority: 80 };
  return { priority: 20 };
}

function assertHeaderPath(
  columnId: string,
  path: readonly ReportDataTableHeaderPathSegment[],
): ReportDataTableHeaderPathSegment[] {
  if (!Array.isArray(path)) {
    throw new TypeError(
      `Report DataTable headerPath for ${columnId} must be an array`,
    );
  }
  return path.map((segment) => {
    if (
      !segment ||
      typeof segment.id !== 'string' ||
      segment.id.trim().length === 0 ||
      typeof segment.label !== 'string' ||
      segment.label.trim().length === 0
    ) {
      throw new TypeError(
        `Report DataTable headerPath entries for ${columnId} require non-empty id and label`,
      );
    }
    return { id: segment.id, label: segment.label };
  });
}

function dataTableColumn(
  column: ReportColumnDescriptor,
  override?: ReportDataTableColumnOverride,
): ReportDataTableColumn {
  const format = override?.valueFormat ?? valueFormat(column);
  const path = override?.headerPath ?? headerPath(column);
  if (!VALUE_FORMATS.has(format)) {
    throw new TypeError(
      `Report DataTable valueFormat for ${column.id} is not supported: ${String(format)}`,
    );
  }
  if (override?.role !== undefined && !COLUMN_ROLES.has(override.role)) {
    throw new TypeError(
      `Report DataTable role for ${column.id} is not supported: ${String(override.role)}`,
    );
  }
  if (
    override?.label !== undefined &&
    (typeof override.label !== 'string' || override.label.trim().length === 0)
  ) {
    throw new TypeError(
      `Report DataTable label for ${column.id} must not be empty`,
    );
  }
  if (
    override?.align !== undefined &&
    override.align !== 'left' &&
    override.align !== 'right'
  ) {
    throw new TypeError(
      `Report DataTable align for ${column.id} is not supported: ${String(override.align)}`,
    );
  }
  if (
    override?.responsive?.priority !== undefined &&
    (!Number.isFinite(override.responsive.priority) ||
      override.responsive.priority < 0)
  ) {
    throw new TypeError(
      `Report DataTable responsive priority for ${column.id} must be a non-negative finite number`,
    );
  }
  if (
    override?.responsive?.keepVisible !== undefined &&
    typeof override.responsive.keepVisible !== 'boolean'
  ) {
    throw new TypeError(
      `Report DataTable keepVisible for ${column.id} must be a boolean`,
    );
  }
  return {
    id: column.id,
    label: override?.label ?? column.label,
    accessor: column.id,
    sortable: column.sortable === true,
    searchable: false,
    filterable: column.filterOperators !== undefined,
    headerPath: assertHeaderPath(column.id, path),
    valueFormat: format,
    align:
      override?.align ??
      (['count', 'money', 'number', 'percentage'].includes(format)
        ? 'right'
        : 'left'),
    role: override?.role ?? 'data',
    responsive: { ...responsive(column), ...override?.responsive },
  };
}

function structuralRows(
  columnIds: ReadonlySet<string>,
  rows: readonly ReportDataTableStructuralRowInput[] = [],
): ReportDataTableStructuralRow[] {
  const ids = new Set<string>();
  return rows.map((row) => {
    if (
      !row ||
      typeof row.id !== 'string' ||
      row.id.trim().length === 0 ||
      typeof row.label !== 'string' ||
      row.label.trim().length === 0
    ) {
      throw new TypeError(
        'Report structural rows require non-empty id and label values',
      );
    }
    if (ids.has(row.id)) {
      throw new TypeError(`Report structural row id must be unique: ${row.id}`);
    }
    if (!STRUCTURAL_ROW_KINDS.has(row.kind)) {
      throw new TypeError(
        `Report structural row kind is not supported: ${String(row.kind)}`,
      );
    }
    if (row.labelColumnId !== undefined) {
      if (
        typeof row.labelColumnId !== 'string' ||
        row.labelColumnId.trim().length === 0 ||
        !columnIds.has(row.labelColumnId)
      ) {
        throw new TypeError(
          `Report structural row labelColumnId must name an adapter column: ${String(row.labelColumnId)}`,
        );
      }
    }
    if (
      row.values !== undefined &&
      (typeof row.values !== 'object' ||
        row.values === null ||
        Array.isArray(row.values))
    ) {
      throw new TypeError('Report structural row values must be an object');
    }
    if (
      row.values &&
      Object.keys(row.values).some((columnId) => !columnIds.has(columnId))
    ) {
      throw new TypeError(
        'Report structural row values must use adapter column ids',
      );
    }
    ids.add(row.id);
    return {
      id: row.id,
      kind: row.kind,
      label: row.label,
      ...(row.values !== undefined
        ? {
            values: jsonSafeValue(row.values) as Record<string, unknown>,
          }
        : {}),
      ...(row.labelColumnId !== undefined
        ? { labelColumnId: row.labelColumnId }
        : {}),
      selection: 'excluded' as const,
      actions: 'excluded' as const,
    };
  });
}

function drilldownDescriptor(
  columns: readonly ReportColumnDescriptor[],
  sourceClassName: string,
): ReportDrilldownDescriptor {
  return {
    id: 'drilldown',
    sourceClassName,
    fields: columns
      .filter(
        (
          column,
        ): column is ReportColumnDescriptor & {
          kind: 'group' | 'bucket';
          sourceColumn: string;
        } =>
          (column.kind === 'group' || column.kind === 'bucket') &&
          typeof column.sourceColumn === 'string',
      )
      .map((column) => ({
        id: column.id,
        sourceColumn: column.sourceColumn,
        kind: column.kind,
        ...(column.kind === 'bucket' && column.bucket
          ? { bucket: column.bucket }
          : {}),
      })),
    inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
  };
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
    supports: { cursorPagination: false, consistency: false, facets: true },
  };
  const dataTable: ReportDataTableDescriptor = {
    rowKey: 'id',
    manualPagination: true,
    manualSorting: true,
    enableFiltering: true,
    enableSearch: false,
    columns: columns.map((column) =>
      dataTableColumn(column, options.dataTable?.columns?.[column.id]),
    ),
    structuralRows: structuralRows(
      new Set(columns.map((column) => column.id)),
      options.dataTable?.structuralRows,
    ),
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
    queryExecution: {
      modes: ['visible', 'background', 'silent'],
      visible: { delivery: 'result' },
      background: { delivery: 'queued', requiresHost: true },
      silent: { delivery: 'result', mutatesVisibleSurface: false },
    },
    dataTable,
    drilldown: drilldownDescriptor(columns, definition.sourceClassName),
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

/**
 * Bind a materialized report row to its declared source dimensions. This is a
 * query handoff, not an executor: an authenticated source adapter must apply
 * the inherited principal, tenant, definition, and field policy before it
 * reads source records.
 */
export async function buildReportDrilldownQuery(
  reportCtor: new (...args: any[]) => SmrtObject,
  row: Readonly<Record<string, unknown>>,
  options: ReportAdapterOptions = {},
): Promise<ReportDrilldownQuery> {
  const descriptor = await buildReportAdapterDescriptor(reportCtor, options);
  const constraints = descriptor.drilldown.fields.map((field) => {
    if (!Object.hasOwn(row, field.id)) {
      throw new DataQueryValidationError(
        `Report drilldown row is missing grouping field: ${field.id}`,
        'DATA_QUERY_RESULT_INVALID',
      );
    }
    return {
      id: field.id,
      sourceColumn: field.sourceColumn,
      kind: field.kind,
      value: jsonSafeValue(row[field.id]),
      ...(field.bucket ? { bucket: field.bucket } : {}),
    };
  });
  return {
    version: 1,
    resourceId: descriptor.resourceId,
    reportClassName: descriptor.reportClassName,
    sourceClassName: descriptor.drilldown.sourceClassName,
    constraints,
    inherits: [...descriptor.drilldown.inherits],
  };
}

type MaterializedWhere = Array<Array<Record<string, unknown>>>;

/** Keep OR expansion bounded before it reaches the database collection. */
const MAX_REPORT_FILTER_OR_GROUPS = 128;

function reportFilterError(message: string): never {
  throw new DataQueryValidationError(message, 'DATA_QUERY_UNSUPPORTED');
}

function crossProductWhere(
  left: MaterializedWhere,
  right: MaterializedWhere,
): MaterializedWhere {
  if (left.length * right.length > MAX_REPORT_FILTER_OR_GROUPS) {
    return reportFilterError(
      `Report filter expands beyond ${MAX_REPORT_FILTER_OR_GROUPS} OR groups`,
    );
  }
  return left.flatMap((leftGroup) =>
    right.map((rightGroup) => [...leftGroup, ...rightGroup]),
  );
}

function inverseOperator(
  operator: DataQueryFilterOperator,
): DataQueryFilterOperator {
  switch (operator) {
    case 'eq':
      return 'ne';
    case 'ne':
      return 'eq';
    case 'gt':
      return 'lte';
    case 'gte':
      return 'lt';
    case 'lt':
      return 'gte';
    case 'lte':
      return 'gt';
    case 'in':
      return 'notIn';
    case 'notIn':
      return 'in';
    case 'like':
      return reportFilterError(
        'Report filters do not support negating a LIKE predicate',
      );
  }
}

function collectionCondition(
  field: string,
  operator: DataQueryFilterOperator,
  value: DataQueryCondition['value'],
): MaterializedWhere {
  const keyFor = (suffix: string) => (suffix ? `${field} ${suffix}` : field);
  const scalar = (key: string, scalarValue: unknown): MaterializedWhere => [
    [{ [key]: scalarValue }],
  ];

  if (operator === 'in') {
    const values = value as Array<string | number | boolean | null>;
    const nonNull = values.filter((entry) => entry !== null);
    if (nonNull.length === 0) return scalar(field, null);
    if (nonNull.length === values.length) return scalar(keyFor('in'), nonNull);
    // SQL IN does not match NULL. Model the user-visible union explicitly.
    return [[{ [field]: null }], [{ [keyFor('in')]: nonNull }]];
  }

  if (operator === 'notIn') {
    const values = value as Array<string | number | boolean | null>;
    // `buildWhere()` does not have a `NOT IN` primitive. A bounded AND of
    // inequality predicates has the same null-safe semantics and remains fully
    // validated by the collection.
    return [values.map((entry) => ({ [keyFor('!=')]: entry }))];
  }

  const suffix: Record<
    Exclude<DataQueryFilterOperator, 'in' | 'notIn'>,
    string
  > = {
    eq: '',
    ne: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    like: 'like',
  };
  return scalar(keyFor(suffix[operator]), value);
}

function materializedWhereForFilter(
  filter: DataQueryFilter,
  fields: Map<string, string>,
  negate = false,
): MaterializedWhere {
  if (filter.kind === 'condition') {
    const field = fields.get(filter.field);
    if (!field) {
      return reportFilterError(
        `Report filter field is not declared: ${filter.field}`,
      );
    }
    return collectionCondition(
      field,
      negate ? inverseOperator(filter.operator) : filter.operator,
      filter.value,
    );
  }

  if (filter.kind === 'not') {
    return materializedWhereForFilter(filter.filter, fields, !negate);
  }

  const combineWithAnd =
    (filter.kind === 'all' && !negate) || (filter.kind === 'any' && negate);
  if (combineWithAnd) {
    return filter.filters.reduce<MaterializedWhere>(
      (combined, child) =>
        crossProductWhere(
          combined,
          materializedWhereForFilter(child, fields, negate),
        ),
      [[]],
    );
  }

  const groups = filter.filters.flatMap((child) =>
    materializedWhereForFilter(child, fields, negate),
  );
  if (groups.length > MAX_REPORT_FILTER_OR_GROUPS) {
    return reportFilterError(
      `Report filter expands beyond ${MAX_REPORT_FILTER_OR_GROUPS} OR groups`,
    );
  }
  return groups;
}

/**
 * Converts a normalized report filter to collection-owned, parameterized
 * predicates. The returned DNF form gives each OR branch a complete AND
 * clause, so tenant interception can add its tenant predicate to every branch.
 */
function materializedWhere(
  filter: DataQueryFilter | undefined,
  fields: Map<string, string>,
): MaterializedWhere | undefined {
  return filter ? materializedWhereForFilter(filter, fields) : undefined;
}

function filterScopeForColumn(
  column: ReportColumnDescriptor,
): ReportFilterScope {
  return column.filterScope;
}

/**
 * Split the declared filter language by report semantics for consumers that
 * construct a live source query. Mixed AND expressions are represented as two
 * independent clauses; mixed OR/NOT expressions are rejected because moving
 * either half across WHERE/HAVING would change their meaning.
 */
export function splitReportFilterScopes(
  descriptor: ReportAdapterDescriptor,
  filter: DataQueryFilter | undefined,
): { where?: DataQueryFilter; having?: DataQueryFilter } {
  if (!filter) return {};
  const columns = new Map(
    descriptor.columns.map((column) => [column.id, column]),
  );
  const combineAll = (
    filters: DataQueryFilter[],
  ): DataQueryFilter | undefined => {
    const flattened = filters.flatMap((candidate) =>
      candidate.kind === 'all' ? candidate.filters : [candidate],
    );
    return flattened.length === 0
      ? undefined
      : flattened.length === 1
        ? flattened[0]
        : { kind: 'all', filters: flattened };
  };
  const split = (
    candidate: DataQueryFilter,
  ): { where?: DataQueryFilter; having?: DataQueryFilter } => {
    if (candidate.kind === 'condition') {
      const column = columns.get(candidate.field);
      if (!column) {
        reportFilterError(
          `Report filter field is not declared: ${candidate.field}`,
        );
      }
      return filterScopeForColumn(column) === 'where'
        ? { where: candidate }
        : { having: candidate };
    }

    if (candidate.kind === 'all') {
      const children = candidate.filters.map(split);
      const where = combineAll(
        children.flatMap((child) => (child.where ? [child.where] : [])),
      );
      const having = combineAll(
        children.flatMap((child) => (child.having ? [child.having] : [])),
      );
      return {
        ...(where ? { where } : {}),
        ...(having ? { having } : {}),
      };
    }

    const children =
      candidate.kind === 'not'
        ? [split(candidate.filter)]
        : candidate.filters.map(split);
    const scopes = new Set(
      children.flatMap((child) => [
        ...(child.where ? (['where'] as const) : []),
        ...(child.having ? (['having'] as const) : []),
      ]),
    );
    if (scopes.size !== 1) {
      reportFilterError(
        'Report WHERE and HAVING filters cannot be mixed inside one OR or NOT expression',
      );
    }
    const scope = scopes.has('where') ? 'where' : 'having';
    const filters = children.flatMap((child) => {
      const filter = scope === 'where' ? child.where : child.having;
      return filter ? [filter] : [];
    });
    if (candidate.kind === 'not') {
      const [filter] = filters;
      if (!filter) {
        reportFilterError('Report NOT expressions must contain one filter');
      }
      return scope === 'where'
        ? { where: { kind: 'not', filter } }
        : { having: { kind: 'not', filter } };
    }
    return scope === 'where'
      ? { where: { kind: 'any', filters } }
      : { having: { kind: 'any', filters } };
  };

  return split(filter);
}

function jsonSafeValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    const numeric = Number(value);
    if (!Number.isSafeInteger(numeric)) {
      throw new RangeError(
        'Materialized bigint values must be safely representable as numbers',
      );
    }
    return numeric;
  }
  if (value && typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new TypeError('Values must not contain circular references');
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((entry) => jsonSafeValue(entry, ancestors));
      }
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          jsonSafeValue(entry, ancestors),
        ]),
      );
    } finally {
      ancestors.delete(value);
    }
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

function queryFreshness(
  lifecycle: ReportLifecycleSnapshot,
): DataQueryFreshness {
  switch (lifecycle.state) {
    case 'current':
      return {
        state: 'fresh',
        ...(lifecycle.asOf ? { asOf: lifecycle.asOf } : {}),
      };
    case 'stale':
    case 'lock-skipped':
    case 'failed':
      return {
        state: 'stale',
        ...(lifecycle.asOf ? { asOf: lifecycle.asOf } : {}),
      };
    case 'refreshing':
      return lifecycle.hasUsableRows
        ? {
            state: 'stale',
            ...(lifecycle.asOf ? { asOf: lifecycle.asOf } : {}),
          }
        : { state: 'unknown' };
  }
}

/**
 * Execute bounded materialized report reads through the canonical query
 * envelope. Every predicate is an adapter-declared field/operator pair; the
 * collection converts it to parameterized SQL and applies tenant interceptors
 * to list, count, and facet reads alike.
 */
export function queryReportMaterializedRows(
  reportCtor: new (...args: any[]) => SmrtObject,
  input: unknown,
  options: ReportBackgroundQueryOptions,
): Promise<ReportBackgroundQueryResult>;
export function queryReportMaterializedRows(
  reportCtor: new (...args: any[]) => SmrtObject,
  input: unknown,
  options?: ReportQueryOptions,
): Promise<ReportDataQueryResult>;
export async function queryReportMaterializedRows(
  reportCtor: new (...args: any[]) => SmrtObject,
  input: unknown,
  options: ReportQueryOptions | ReportBackgroundQueryOptions = {},
): Promise<ReportDataQueryResult | ReportBackgroundQueryResult> {
  const descriptor = await buildReportAdapterDescriptor(reportCtor);
  const request = normalizeDataQueryRequest(input, descriptor.schema);
  // Validate the semantic split even though materialized-row reads execute the
  // complete predicate against one persisted table. It prevents an adapter
  // consumer from silently treating a mixed source WHERE/HAVING expression as
  // either side of the aggregate boundary.
  splitReportFilterScopes(descriptor, request.filter);
  const queryFingerprint = createDataQueryFingerprint(
    request,
    descriptor.schema,
  );
  if (options.execution === 'background') {
    const queued = await options.enqueueBackgroundQuery({
      version: 1,
      execution: 'background',
      resourceId: descriptor.resourceId,
      reportClassName: descriptor.reportClassName,
      request,
      inherits: ['principal', 'tenant', 'report-definition', 'field-policy'],
    });
    if (typeof queued.taskId !== 'string' || queued.taskId.length === 0) {
      throw new Error('Background report query hosts must return a task id');
    }
    return {
      version: 1,
      execution: 'background',
      status: 'queued',
      taskId: queued.taskId,
      queryFingerprint,
    };
  }
  const execution = options.execution ?? 'visible';
  const lifecycleDb = options.db;
  if (options.lifecycle && !lifecycleDb) {
    throw new Error('Report lifecycle disclosure requires a database handle');
  }
  const lifecycleOptions =
    options.lifecycle && lifecycleDb
      ? { db: lifecycleDb, ...options.lifecycle }
      : undefined;
  const lifecycleBefore = lifecycleOptions
    ? await getReportLifecycle(reportCtor, lifecycleOptions)
    : undefined;
  const fieldMap = publicFieldMap(descriptor);
  const where = materializedWhere(request.filter, fieldMap);
  const collection: NonNullable<ReportQueryOptions['collection']> =
    options.collection ??
    ((await ObjectRegistry.getCollection(descriptor.reportClassName, {
      db: options.db,
    })) as unknown as NonNullable<ReportQueryOptions['collection']>);
  let rows: Record<string, unknown>[] = [];
  let page: DataQueryResult['page'];
  let total: number;
  let facets: DataQueryResult['facets'];
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
      ...(where === undefined ? {} : { where }),
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
    total = await collection.count(where === undefined ? undefined : { where });
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
      ...(where === undefined ? {} : { where }),
    });
    total = await collection.count(where === undefined ? undefined : { where });
    if (request.mode === 'facets') {
      if (!collection.facets) {
        throw new Error(
          'Report materialized facet reads require a collection facets() implementation',
        );
      }
      const requested = request.facets ?? [];
      const sourceFacets = await collection.facets({
        fields: requested.map((facet) => ({
          field: fieldMap.get(facet.field) ?? facet.field,
          limit: facet.limit,
        })),
        ...(where === undefined ? {} : { where }),
      });
      const byField = new Map(
        sourceFacets.map((facet) => [facet.field, facet]),
      );
      facets = requested.map((facet) => {
        const sourceField = fieldMap.get(facet.field) ?? facet.field;
        const values = byField.get(sourceField)?.values ?? [];
        return {
          field: facet.field,
          values: values.map((value) => ({
            value: value.value,
            count: value.count,
          })),
          // The collection deliberately bounds this database grouping query;
          // an exactly-full page may have more values, so report conservatively.
          truncated: values.length >= facet.limit,
        };
      });
    }
  }
  const result = {
    version: 1 as const,
    requestId: request.requestId,
    queryFingerprint,
    identityField: descriptor.identityField,
    rows,
    ...(page ? { page } : {}),
    total: { kind: 'exact' as const, value: total },
    ...(facets === undefined ? {} : { facets }),
    freshness: { state: 'unknown' as const },
    warnings: [],
    truncated: false,
  };
  const normalized = normalizeDataQueryResult(
    result,
    request,
    descriptor.schema,
  );
  if (!lifecycleBefore || !lifecycleOptions) {
    return { ...normalized, execution };
  }

  const lifecycleAfter = await getReportLifecycle(reportCtor, lifecycleOptions);
  return {
    ...normalized,
    execution,
    freshness: queryFreshness(lifecycleAfter),
    reportLifecycle: {
      snapshot: lifecycleAfter,
      read:
        lifecycleBefore.state !== 'current' &&
        lifecycleAfter.state === 'current'
          ? 'refresh-triggered'
          : lifecycleAfter.state === 'current'
            ? 'current'
            : 'stale',
    },
  };
}

/** Read the already-materialized primary key; never use a display/page index. */
export function reportMaterializedRowKey(row: Record<string, unknown>): string {
  const id = row.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('Materialized report rows require a non-empty string id');
  }
  return id;
}
