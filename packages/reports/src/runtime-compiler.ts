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
import { describeRuntimeReportSourceFields } from './runtime-dimensions.js';
import {
  assertRuntimeReportFilterOperator,
  coerceRuntimeReportValue,
  humanizeRuntimeReportName,
  normalizeRuntimeReportCell,
  planRuntimeReportColumns,
  type RuntimeReportColumn,
  type RuntimeReportColumnType,
  type RuntimeReportResult,
  type RuntimeReportSourceDescription,
  resolveRuntimeReportFieldPolicy,
  unknownRuntimeReportField,
} from './runtime-plan.js';
import {
  RUNTIME_REPORT_LIMITS,
  RuntimeReportError,
  type RuntimeReportFilter,
  type RuntimeReportSpec,
} from './runtime-spec.js';
import { runtimeReportSpecHash } from './runtime-spec-hash.js';
import type { AggregateSelectExpr, AggregateSpec } from './types.js';

export type {
  RuntimeReportColumn,
  RuntimeReportColumnType,
  RuntimeReportResult,
  RuntimeReportSourceDescription,
} from './runtime-plan.js';

/** A server-owned report source. The spec refers to it only by `id`. */
export interface RuntimeReportSourceDefinition {
  /** Opaque id the spec names; defaults to nothing, always explicit. */
  id: string;
  /** Registered `ObjectRegistry` class (qualified or bare name). */
  className: string;
  label?: string;
  /**
   * Permission-catalog collection SLUG the host authorizes reads against (the
   * `<collection>` in `<collection>.read`, not a class name). Informational
   * to the compiler; the host's `authorizeSource` consumes it.
   */
  collection?: string;
  description?: string;
  /** Canonical public field names to expose; omitted means all eligible fields. */
  fields?: readonly string[];
  /** Canonical public field names to remove; exclusions always win. */
  excludeFields?: readonly string[];
  /** The natural date "by month" buckets (an invoice's issue date); derived when omitted. */
  timeField?: string;
  /** Fields worth grouping by, most useful first; derived when omitted. */
  dimensions?: readonly string[];
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

const ALIAS_PREFIX = 'r_';
interface RegistryFieldShape {
  type?: string;
  enum?: unknown;
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
  enum?: readonly string[];
  businessDate?: boolean;
}

/** Declared values of a closed text field (manifest `enum`). */
function enumOf(field: RegistryFieldShape): string[] | undefined {
  const values = [field.enum, field._meta?.enum].find(Array.isArray) as
    | unknown[]
    | undefined;
  const strings = values?.filter((v): v is string => typeof v === 'string');
  return strings?.length ? strings : undefined;
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
  // Manifests carry `@field({ ui: { format } })` as `_meta.ui.format`.
  const ui = field._meta?.ui as { format?: unknown } | undefined;
  const candidates = [field.format, field._meta?.format, ui?.format];
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
  source: RuntimeReportSourceDefinition,
): Promise<Map<string, SourceField>> {
  const registered = (await ObjectRegistry.getAllFields(qualifiedName)) as Map<
    string,
    RegistryFieldShape
  >;
  const baseNames = new Map(
    Object.keys(BASE_FIELDS).map((name) => [toSnakeCase(name), name]),
  );
  const columns = new Map<
    string,
    { name: string; field: RegistryFieldShape }[]
  >();
  for (const [name, field] of registered) {
    const column = toSnakeCase(explicitColumn(field) ?? name);
    const entries = columns.get(column) ?? [];
    entries.push({ name, field });
    columns.set(column, entries);
  }
  for (const [name, type] of Object.entries(BASE_FIELDS)) {
    const column = toSnakeCase(name);
    if (!columns.has(column) && !registered.has(name)) {
      columns.set(column, [
        {
          name,
          field: {
            type:
              type === 'id' ? 'foreignKey' : type === 'string' ? 'text' : type,
          },
        },
      ]);
    }
  }
  // Collapse base-column aliases before applying either model or host policy.
  // Any restriction on a physical column also protects its other spellings.
  const knownNames = new Set<string>();
  for (const [column, entries] of columns) {
    for (const entry of entries)
      knownNames.add(baseNames.get(column) ?? entry.name);
  }
  const { included, excluded } = resolveRuntimeReportFieldPolicy(
    source,
    knownNames,
  );
  const fields = new Map<string, SourceField>();
  for (const [column, entries] of columns) {
    if (
      column === tenantField ||
      column === 'tenant_id' ||
      entries.some(
        ({ name, field }) =>
          isExcluded(name, field, tenantField, permissions) ||
          excluded?.has(baseNames.get(column) ?? name),
      )
    )
      continue;
    for (const { name: registeredName, field } of entries) {
      const name = baseNames.get(column) ?? registeredName;
      if (fields.has(name) || (included && !included.has(name))) continue;
      const type = columnTypeFor(field.type);
      if (!type) continue;
      const format = strictFormat(field);
      const values = type === 'string' ? enumOf(field) : undefined;
      fields.set(name, {
        name,
        column,
        type,
        ...(format ? { format } : {}),
        ...(values ? { enum: values } : {}),
        ...(type === 'datetime' && format === 'date'
          ? { businessDate: true }
          : {}),
        label:
          typeof field.description === 'string' && field.description.length > 0
            ? field.description
            : humanizeRuntimeReportName(name),
      });
    }
  }
  return fields;
}

type Condition = Record<string, unknown>;

function filterCondition(
  filter: RuntimeReportFilter,
  field: SourceField,
  path: string,
): Condition {
  assertRuntimeReportFilterOperator(filter, field.type, path);
  const column = field.column;
  switch (filter.op) {
    case 'isNull':
      return { [column]: null };
    case 'isNotNull':
      return { [`${column} !=`]: null };
    case 'in':
    case 'notIn': {
      const values = (filter.value as unknown[]).map((entry, index) =>
        coerceRuntimeReportValue(field.type, entry, `${path}.value[${index}]`),
      );
      return { [`${column} ${filter.op === 'in' ? 'in' : 'not in'}`]: values };
    }
    case 'contains':
      return {
        [`${column} contains`]: coerceRuntimeReportValue(
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
        [`${column}${suffix}`]: coerceRuntimeReportValue(
          field.type,
          filter.value,
          `${path}.value`,
        ),
      };
    }
  }
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
    source,
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
    label:
      prepared.source.label ??
      humanizeRuntimeReportName(prepared.registeredName),
    ...(prepared.source.description
      ? { description: prepared.source.description }
      : {}),
    ...describeRuntimeReportSourceFields(prepared.fields, prepared.source),
  };
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
    if (!field) unknownRuntimeReportField(path, name);
    return field;
  };

  // Shared with the in-memory runner: validates dimensions and measures and
  // describes the result columns, so both paths agree on what a spec means.
  const columns = planRuntimeReportColumns(spec, fields);
  const select: AggregateSelectExpr[] = [];
  const groupBy: string[] = [];

  for (const dimension of spec.dimensions) {
    const field = fields.get(dimension.field) as SourceField;
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
  }

  for (const measure of spec.measures) {
    const field = measure.field ? fields.get(measure.field) : undefined;
    select.push({
      fn: measure.fn === 'countDistinct' ? 'count' : measure.fn,
      ...(field ? { column: field.column } : {}),
      as: `${ALIAS_PREFIX}${measure.as}`,
      ...(measure.fn === 'countDistinct' ? { distinct: true } : {}),
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
      label: source.label ?? humanizeRuntimeReportName(registeredName),
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
      out[column.id] = normalizeRuntimeReportCell(
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
