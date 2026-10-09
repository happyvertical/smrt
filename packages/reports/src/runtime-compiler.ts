/**
 * Runtime report compiler and runner (#3711).
 *
 * `compileRuntimeReportSpec()` turns a parsed `RuntimeReportSpec` into the same
 * `AggregateSpec` the declared-report compiler targets, and
 * `runRuntimeReport()` executes it through the SDK `buildAggregate()` builder.
 * Nothing the spec says is ever interpolated into SQL text:
 *
 * - Source tables and columns come ONLY from the ObjectRegistry, resolved from
 *   a server-owned source allow-list (`context.sources`). A spec names a
 *   source id and registry field names; it can never name a table or column.
 * - Fields are admitted by the same exposure policy the report adapter uses:
 *   sensitive/secret fields, `readPermission`-gated fields the live principal
 *   lacks, transient/non-column/json fields, `_`-prefixed internals and the
 *   tenant column are un-nameable. A hidden field is reported exactly like an
 *   absent one so the compiler is not an existence oracle.
 * - Filter and having values travel as bound parameters through the SDK
 *   `buildWhere()` builder, coerced to the field's type first.
 * - Output aliases are prefixed (`r_<alias>`) inside the SQL so they can never
 *   collide with, shadow, or probe a source column.
 * - Tenant isolation is added explicitly (raw aggregates bypass the tenancy
 *   interceptors) and fails closed: a tenant-scoped source with no tenant in
 *   scope reads only NULL-tenant rows when tenancy is enabled. There is no
 *   cross-tenant option.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { toSnakeCase } from '@happyvertical/smrt-core/utils';
import {
  getTenantId,
  isTenancyEnabled,
  isTenantScopedClass,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface, SqlAdapterType } from '@happyvertical/sql';
import { buildAggregate } from './aggregate.js';
import { adapterTypeFromDb, tenantColumn } from './refresh.js';
import {
  RUNTIME_REPORT_LIMITS,
  type RuntimeReportChart,
  RuntimeReportError,
  type RuntimeReportFilter,
  type RuntimeReportSpec,
  runtimeReportSpecHash,
} from './runtime-spec.js';
import type { AggregateSelectExpr, AggregateSpec } from './types.js';

/** A server-owned report source. The spec refers to it only by `id`. */
export interface RuntimeReportSourceDefinition {
  /** Opaque id the spec names; defaults to nothing, always explicit. */
  id: string;
  /** Registered `ObjectRegistry` class (qualified or bare name). */
  className: string;
  label?: string;
  /** Permission-catalog collection the host authorizes reads against. */
  collection?: string;
  description?: string;
}

export interface RuntimeReportCompileContext {
  /** Server-owned allow-list. A spec can reach nothing outside it. */
  sources: readonly RuntimeReportSourceDefinition[];
  /**
   * The live principal's permission slugs. A `readPermission`-gated field is
   * admitted only when its permission is present. Omitted means none.
   */
  permissions?: readonly string[];
  /**
   * Tenant to scope tenant-scoped sources to. Defaults to the ambient tenant
   * context. There is intentionally no way to widen this to other tenants.
   */
  tenantId?: string | null;
  /** Host authorization for reading the source (for example RBAC `read`). */
  authorizeSource?: (
    source: RuntimeReportSourceDefinition,
  ) => void | Promise<void>;
}

export type RuntimeReportColumnType =
  | 'string'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'id';

export interface RuntimeReportColumn {
  id: string;
  label: string;
  role: 'dimension' | 'measure';
  type: RuntimeReportColumnType;
  /** Source field this column derives from (absent for a row count). */
  field?: string;
  fn?: string;
  bucket?: string;
  /** Field format hint carried from the model (for example `money`). */
  format?: string;
}

export interface CompiledRuntimeReport {
  version: 1;
  specHash: string;
  spec: RuntimeReportSpec;
  source: {
    id: string;
    className: string;
    label: string;
    table: string;
  };
  columns: RuntimeReportColumn[];
  /** Aggregate plan; output aliases carry the internal `r_` prefix. */
  aggregate: AggregateSpec;
  limit: number;
  tenant: { scoped: boolean; tenantId: string | null };
}

export interface RuntimeReportResult {
  version: 1;
  specHash: string;
  title: string;
  columns: RuntimeReportColumn[];
  rows: Record<string, string | number | boolean | null>[];
  rowCount: number;
  /** True when more rows existed than the spec/host limit. */
  truncated: boolean;
  ranAt: string;
  chart: RuntimeReportChart;
}

const ALIAS_PREFIX = 'r_';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RegistryFieldShape {
  type?: string;
  transient?: boolean;
  sensitive?: boolean;
  sensitivity?: unknown;
  readPermission?: unknown;
  description?: unknown;
  format?: unknown;
  columnName?: string;
  _meta?: Record<string, unknown>;
}

interface SourceField {
  name: string;
  column: string;
  type: RuntimeReportColumnType;
  format?: string;
  label: string;
}

function humanize(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (value) => value.toUpperCase());
}

function columnTypeFor(
  type: string | undefined,
): RuntimeReportColumnType | null {
  switch (type) {
    case 'text':
      return 'string';
    case 'integer':
      return 'integer';
    case 'decimal':
      return 'decimal';
    case 'boolean':
      return 'boolean';
    case 'datetime':
      return 'datetime';
    case 'foreignKey':
    case 'crossPackageRef':
      return 'id';
    default:
      return null;
  }
}

function explicitColumn(field: RegistryFieldShape): string | undefined {
  const metaColumn = field._meta?.columnName;
  if (typeof field.columnName === 'string') return field.columnName;
  return typeof metaColumn === 'string' ? metaColumn : undefined;
}

function strictFormat(field: RegistryFieldShape): string | undefined {
  const candidates = [field.format, field._meta?.format];
  return candidates.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * Standard SMRT columns that exist on every object table. They are exposed
 * even when a class registers no explicit field for them.
 */
const BASE_FIELDS: Record<string, RuntimeReportColumnType> = {
  id: 'id',
  slug: 'string',
  createdAt: 'datetime',
  updatedAt: 'datetime',
};

function isExcluded(
  name: string,
  field: RegistryFieldShape,
  tenantField: string | null,
  permissions: ReadonlySet<string>,
): boolean {
  if (name.startsWith('_')) return true;
  const meta = field._meta ?? {};
  if (field.transient === true || meta.transient === true) return true;
  const sensitivity = [field.sensitivity, meta.sensitivity].find(
    (value): value is string => typeof value === 'string',
  );
  if (
    field.sensitive === true ||
    meta.sensitive === true ||
    sensitivity === 'sensitive' ||
    sensitivity === 'secret'
  ) {
    return true;
  }
  const readPermission =
    typeof field.readPermission === 'string'
      ? field.readPermission
      : typeof meta.readPermission === 'string'
        ? meta.readPermission
        : undefined;
  if (readPermission && !permissions.has(readPermission)) return true;
  const tenancy = meta.__tenancy as { isTenantIdField?: boolean } | undefined;
  if (tenancy?.isTenantIdField === true) return true;
  if (name === 'tenantId' || name === 'tenant_id') return true;
  if (tenantField && toSnakeCase(name) === tenantField) return true;
  return false;
}

async function loadSourceFields(
  qualifiedName: string,
  tenantField: string | null,
  permissions: ReadonlySet<string>,
): Promise<Map<string, SourceField>> {
  const registered = (await ObjectRegistry.getAllFields(qualifiedName)) as Map<
    string,
    RegistryFieldShape
  >;
  const fields = new Map<string, SourceField>();
  for (const [name, field] of registered) {
    if (isExcluded(name, field, tenantField, permissions)) continue;
    const type = columnTypeFor(field.type);
    if (!type) continue;
    const format = strictFormat(field);
    fields.set(name, {
      name,
      column: toSnakeCase(explicitColumn(field) ?? name),
      type,
      ...(format ? { format } : {}),
      label:
        typeof field.description === 'string' && field.description.length > 0
          ? field.description
          : humanize(name),
    });
  }
  for (const [name, type] of Object.entries(BASE_FIELDS)) {
    if (fields.has(name) || registered.has(name)) continue;
    fields.set(name, {
      name,
      column: toSnakeCase(name),
      type,
      label: humanize(name),
    });
  }
  return fields;
}

function unknownField(path: string, name: string): never {
  throw new RuntimeReportError(
    'unknown_field',
    path,
    `'${name}' is not a field available on this source`,
  );
}

function badOperation(path: string, message: string): never {
  throw new RuntimeReportError('invalid_operation', path, message);
}

function badValue(path: string, message: string): never {
  throw new RuntimeReportError('invalid_value', path, message);
}

type Condition = Record<string, unknown>;

const OPERATORS_BY_TYPE: Record<
  RuntimeReportColumnType,
  readonly RuntimeReportFilter['op'][]
> = {
  string: [
    'eq',
    'ne',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'notIn',
    'contains',
    'isNull',
    'isNotNull',
  ],
  integer: [
    'eq',
    'ne',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'notIn',
    'isNull',
    'isNotNull',
  ],
  decimal: [
    'eq',
    'ne',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'notIn',
    'isNull',
    'isNotNull',
  ],
  datetime: [
    'eq',
    'ne',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'notIn',
    'isNull',
    'isNotNull',
  ],
  boolean: ['eq', 'ne', 'isNull', 'isNotNull'],
  id: ['eq', 'ne', 'in', 'notIn', 'isNull', 'isNotNull'],
};

function coerceValue(
  type: RuntimeReportColumnType,
  value: unknown,
  path: string,
): string | number | boolean | Date {
  switch (type) {
    case 'string':
      if (typeof value !== 'string') badValue(path, 'must be a string');
      return value;
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        badValue(path, 'must be a safe integer');
      }
      return value;
    case 'decimal':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        badValue(path, 'must be a finite number');
      }
      return value;
    case 'boolean':
      if (typeof value !== 'boolean') badValue(path, 'must be true or false');
      return value;
    case 'datetime': {
      if (typeof value !== 'string')
        badValue(path, 'must be an ISO-8601 string');
      const parsed = new Date(value);
      if (Number.isNaN(parsed.getTime()) || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
        badValue(path, 'must be an ISO-8601 date or timestamp');
      }
      return parsed;
    }
    case 'id':
      if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        badValue(path, 'must be a UUID');
      }
      return value.toLowerCase();
  }
}

function filterCondition(
  filter: RuntimeReportFilter,
  field: SourceField,
  path: string,
): Condition {
  if (!OPERATORS_BY_TYPE[field.type].includes(filter.op)) {
    badOperation(
      `${path}.op`,
      `'${filter.op}' is not valid for ${field.type} fields`,
    );
  }
  const column = field.column;
  switch (filter.op) {
    case 'isNull':
      return { [column]: null };
    case 'isNotNull':
      return { [`${column} !=`]: null };
    case 'in':
    case 'notIn': {
      const values = (filter.value as unknown[]).map((entry, index) =>
        coerceValue(field.type, entry, `${path}.value[${index}]`),
      );
      return { [`${column} ${filter.op === 'in' ? 'in' : 'not in'}`]: values };
    }
    case 'contains':
      return {
        [`${column} contains`]: coerceValue(
          field.type,
          filter.value,
          `${path}.value`,
        ),
      };
    default: {
      const suffix = {
        eq: '',
        ne: ' !=',
        gt: ' >',
        gte: ' >=',
        lt: ' <',
        lte: ' <=',
      }[filter.op];
      return {
        [`${column}${suffix}`]: coerceValue(
          field.type,
          filter.value,
          `${path}.value`,
        ),
      };
    }
  }
}

function measureColumnType(
  fn: string,
  field: SourceField | undefined,
): RuntimeReportColumnType {
  if (fn === 'count' || fn === 'countDistinct') return 'integer';
  if (fn === 'avg') return 'decimal';
  return field?.type ?? 'decimal';
}

function resolveSource(
  context: RuntimeReportCompileContext,
  id: string,
): RuntimeReportSourceDefinition {
  const source = context.sources.find((candidate) => candidate.id === id);
  if (!source) {
    // Same answer for "absent" and "not offered to this host/principal".
    throw new RuntimeReportError(
      'unknown_source',
      'spec.source',
      `'${id}' is not an available report source`,
    );
  }
  return source;
}

interface PreparedSource {
  source: RuntimeReportSourceDefinition;
  registeredName: string;
  qualifiedName: string;
  table: string;
  tenantCol: string | null;
  fields: Map<string, SourceField>;
}

async function prepareSource(
  context: RuntimeReportCompileContext,
  id: string,
): Promise<PreparedSource> {
  const source = resolveSource(context, id);
  await context.authorizeSource?.(source);

  const registered = ObjectRegistry.getClass(source.className);
  if (!registered) {
    throw new RuntimeReportError(
      'unknown_source',
      'spec.source',
      `'${id}' is not an available report source`,
    );
  }
  const qualifiedName = registered.qualifiedName ?? registered.name;
  const table = ObjectRegistry.getTableName(qualifiedName);
  if (!table) {
    throw new RuntimeReportError(
      'unsupported_source',
      'spec.source',
      'this source has no registered table',
    );
  }

  const tenantCol = await tenantColumn(qualifiedName);
  if (isTenantScopedClass(qualifiedName) && !tenantCol) {
    throw new RuntimeReportError(
      'unsupported_source',
      'spec.source',
      'this tenant-scoped source does not expose a tenant column',
    );
  }
  const fields = await loadSourceFields(
    qualifiedName,
    tenantCol,
    new Set(context.permissions ?? []),
  );
  return {
    source,
    registeredName: registered.name,
    qualifiedName,
    table,
    tenantCol,
    fields,
  };
}

export interface RuntimeReportSourceDescription {
  id: string;
  label: string;
  description?: string;
  /** Fields the live principal may group by, filter on or aggregate. */
  fields: {
    name: string;
    label: string;
    type: RuntimeReportColumnType;
    format?: string;
    filterOperators: readonly string[];
    aggregates: readonly string[];
  }[];
}

/**
 * Describe what a spec may reference on one source for the live principal:
 * exactly the field set the compiler would admit, so a model never has to
 * guess names and never learns about hidden ones.
 */
export async function describeRuntimeReportSource(
  context: RuntimeReportCompileContext,
  sourceId: string,
): Promise<RuntimeReportSourceDescription> {
  const prepared = await prepareSource(context, sourceId);
  return {
    id: prepared.source.id,
    label: prepared.source.label ?? humanize(prepared.registeredName),
    ...(prepared.source.description
      ? { description: prepared.source.description }
      : {}),
    fields: [...prepared.fields.values()].map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      ...(field.format ? { format: field.format } : {}),
      filterOperators: OPERATORS_BY_TYPE[field.type],
      aggregates: aggregatesFor(field.type),
    })),
  };
}

function aggregatesFor(type: RuntimeReportColumnType): readonly string[] {
  if (type === 'integer' || type === 'decimal') {
    return ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'];
  }
  if (type === 'datetime') return ['count', 'countDistinct', 'min', 'max'];
  return ['count', 'countDistinct'];
}

/**
 * Validate a parsed spec against the registry, the live principal's field
 * policy, and tenancy, and compile it to an executable aggregate plan.
 */
export async function compileRuntimeReportSpec(
  spec: RuntimeReportSpec,
  context: RuntimeReportCompileContext,
): Promise<CompiledRuntimeReport> {
  const { source, registeredName, qualifiedName, table, tenantCol, fields } =
    await prepareSource(context, spec.source);

  const lookup = (name: string, path: string): SourceField => {
    const field = fields.get(name);
    if (!field) unknownField(path, name);
    return field;
  };

  const columns: RuntimeReportColumn[] = [];
  const select: AggregateSelectExpr[] = [];
  const groupBy: string[] = [];

  for (const [index, dimension] of spec.dimensions.entries()) {
    const path = `spec.dimensions[${index}]`;
    const field = lookup(dimension.field, `${path}.field`);
    if (dimension.bucket && field.type !== 'datetime') {
      badOperation(
        `${path}.bucket`,
        'buckets are only valid on datetime fields',
      );
    }
    const sqlAlias = `${ALIAS_PREFIX}${dimension.as}`;
    if (dimension.bucket) {
      select.push({
        bucket: dimension.bucket,
        column: field.column,
        as: sqlAlias,
      });
    } else {
      select.push({ column: field.column, as: sqlAlias });
    }
    groupBy.push(sqlAlias);
    columns.push({
      id: dimension.as,
      label: humanize(dimension.as),
      role: 'dimension',
      type: dimension.bucket ? 'datetime' : field.type,
      field: field.name,
      ...(dimension.bucket ? { bucket: dimension.bucket } : {}),
      ...(field.format && !dimension.bucket ? { format: field.format } : {}),
    });
  }

  for (const [index, measure] of spec.measures.entries()) {
    const path = `spec.measures[${index}]`;
    const field = measure.field
      ? lookup(measure.field, `${path}.field`)
      : undefined;
    if (
      (measure.fn === 'sum' || measure.fn === 'avg') &&
      field?.type !== 'integer' &&
      field?.type !== 'decimal'
    ) {
      badOperation(`${path}.fn`, `${measure.fn} requires a numeric field`);
    }
    if (
      (measure.fn === 'min' || measure.fn === 'max') &&
      field?.type !== 'integer' &&
      field?.type !== 'decimal' &&
      field?.type !== 'datetime'
    ) {
      badOperation(
        `${path}.fn`,
        `${measure.fn} requires a numeric or datetime field`,
      );
    }
    const sqlAlias = `${ALIAS_PREFIX}${measure.as}`;
    select.push({
      fn: measure.fn === 'countDistinct' ? 'count' : measure.fn,
      ...(field ? { column: field.column } : {}),
      as: sqlAlias,
      ...(measure.fn === 'countDistinct' ? { distinct: true } : {}),
    });
    const keepsFormat =
      field?.format &&
      (measure.fn === 'sum' ||
        measure.fn === 'min' ||
        measure.fn === 'max' ||
        measure.fn === 'avg');
    columns.push({
      id: measure.as,
      label: humanize(measure.as),
      role: 'measure',
      type: measureColumnType(measure.fn, field),
      ...(field ? { field: field.name } : {}),
      fn: measure.fn,
      ...(keepsFormat ? { format: field?.format } : {}),
    });
  }

  const conditions: Condition[] = [];

  // Tenancy: explicit, never widened. See module doc.
  const tenantId =
    context.tenantId !== undefined ? context.tenantId : (getTenantId() ?? null);
  if (tenantCol) {
    if (tenantId) {
      conditions.push({ [tenantCol]: tenantId });
    } else if (isTenancyEnabled() || isTenantScopedClass(qualifiedName)) {
      conditions.push({ [tenantCol]: null });
    }
  }

  // Soft delete: honour it when the source declares it.
  const registeredFields = (await ObjectRegistry.getAllFields(
    qualifiedName,
  )) as Map<string, RegistryFieldShape>;
  if (registeredFields.has('deletedAt')) conditions.push({ deleted_at: null });

  // STI child sources share a table with siblings: keep to the child's rows.
  if (ObjectRegistry.getTableStrategy(qualifiedName) === 'sti') {
    const base = ObjectRegistry.getSTIBase(qualifiedName);
    if (base !== null && base !== qualifiedName) {
      conditions.push({ _meta_type: qualifiedName });
    }
  }

  for (const [index, filter] of spec.filters.entries()) {
    const path = `spec.filters[${index}]`;
    const field = lookup(filter.field, `${path}.field`);
    conditions.push(filterCondition(filter, field, path));
  }

  const having: Condition[] = spec.having.map((entry) => {
    const suffix = {
      eq: '',
      ne: ' !=',
      gt: ' >',
      gte: ' >=',
      lt: ' <',
      lte: ' <=',
    }[entry.op];
    return { [`${ALIAS_PREFIX}${entry.measure}${suffix}`]: entry.value };
  });

  const orderBy = spec.sort.map(
    (entry) =>
      `${ALIAS_PREFIX}${entry.by} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`,
  );
  if (orderBy.length === 0 && spec.dimensions.length > 0) {
    orderBy.push(`${ALIAS_PREFIX}${spec.dimensions[0].as} ASC`);
  }

  const aggregate: AggregateSpec = {
    from: table,
    select,
    groupBy,
    ...(conditions.length > 0 ? { where: [conditions] } : {}),
    ...(having.length > 0 ? { having: [having] } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
    limit: Math.min(spec.limit, RUNTIME_REPORT_LIMITS.maxRowLimit) + 1,
  };

  return {
    version: 1,
    specHash: runtimeReportSpecHash(spec),
    spec,
    source: {
      id: source.id,
      className: qualifiedName,
      label: source.label ?? humanize(registeredName),
      table,
    },
    columns,
    aggregate,
    limit: spec.limit,
    tenant: {
      scoped: Boolean(tenantCol),
      tenantId: tenantCol ? tenantId : null,
    },
  };
}

function adaptWhere(
  where: AggregateSpec['where'],
  adapterType: SqlAdapterType,
): AggregateSpec['where'] {
  if (!where || !Array.isArray(where)) return where;
  // SQLite binds booleans as integers; other adapters accept native booleans.
  const adapt = (value: unknown): unknown =>
    adapterType === 'sqlite' && typeof value === 'boolean'
      ? value
        ? 1
        : 0
      : value;
  return where.map((group) =>
    group.map((condition: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(condition).map(([key, value]) => [
          key,
          Array.isArray(value) ? value.map(adapt) : adapt(value),
        ]),
      ),
    ),
  );
}

function normalizeCell(
  column: RuntimeReportColumn,
  value: unknown,
): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new RuntimeReportError(
        'invalid_result',
        column.id,
        'integer result exceeds the JavaScript safe range',
      );
    }
    return asNumber;
  }
  if (column.type === 'boolean') {
    if (value === 1 || value === '1' || value === 'true' || value === true) {
      return true;
    }
    if (value === 0 || value === '0' || value === 'false' || value === false) {
      return false;
    }
  }
  if (column.type === 'integer' || column.type === 'decimal') {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      throw new RuntimeReportError(
        'invalid_result',
        column.id,
        'numeric result is not finite',
      );
    }
    if (column.type === 'integer' && !Number.isSafeInteger(numeric)) {
      throw new RuntimeReportError(
        'invalid_result',
        column.id,
        'integer result exceeds the JavaScript safe range',
      );
    }
    return numeric;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return String(value);
}

export interface RunRuntimeReportOptions {
  db: DatabaseInterface;
  adapterType?: SqlAdapterType;
  /** Host row ceiling applied on top of the spec's own limit. */
  maxRows?: number;
  now?: () => Date;
}

/**
 * Execute a compiled plan. The caller owns authorization: compile with the
 * live principal each time rather than running a plan compiled for someone
 * else. Results are never cached here for exactly that reason.
 */
export async function runRuntimeReport(
  compiled: CompiledRuntimeReport,
  options: RunRuntimeReportOptions,
): Promise<RuntimeReportResult> {
  const adapterType = adapterTypeFromDb(options.db, options.adapterType);
  const aggregate = buildAggregate(
    {
      ...compiled.aggregate,
      where: adaptWhere(compiled.aggregate.where, adapterType),
    },
    1,
    adapterType,
  );
  const result = await options.db.query(aggregate.sql, ...aggregate.values);
  const rawRows = (result.rows ?? []) as Record<string, unknown>[];
  const limit = Math.min(
    compiled.limit,
    options.maxRows ?? RUNTIME_REPORT_LIMITS.maxRowLimit,
  );
  const truncated = rawRows.length > limit;
  const rows = rawRows.slice(0, limit).map((row) => {
    const out: Record<string, string | number | boolean | null> = {};
    for (const column of compiled.columns) {
      out[column.id] = normalizeCell(
        column,
        row[`${ALIAS_PREFIX}${column.id}`],
      );
    }
    return out;
  });
  return {
    version: 1,
    specHash: compiled.specHash,
    title: compiled.spec.title,
    columns: compiled.columns,
    rows,
    rowCount: rows.length,
    truncated,
    ranAt: (options.now?.() ?? new Date()).toISOString(),
    chart: compiled.spec.chart,
  };
}
