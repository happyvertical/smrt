/**
 * Runtime report planning rules shared by the SQL compiler and the in-memory
 * runner (#3711, #4100).
 *
 * Everything here is a pure function of a parsed spec and a resolved field
 * set: which operators and aggregates a field type admits, how filter values
 * are coerced, how result columns are described and how cells are normalized.
 * `compileRuntimeReportSpec()` (server, ObjectRegistry + SQL) and
 * `runRuntimeReportInMemory()` (browser-safe) both call these, so the two
 * paths cannot disagree about what a spec means. Browser-safe: no Node
 * built-ins, no registry.
 */

import {
  type RuntimeReportChart,
  RuntimeReportError,
  type RuntimeReportFilter,
  type RuntimeReportSpec,
} from './runtime-spec.js';

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

/** A nameable source field after every exposure rule has been applied. */
export interface RuntimeReportPlanField {
  name: string;
  type: RuntimeReportColumnType;
  format?: string;
  label: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function humanizeRuntimeReportName(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (value) => value.toUpperCase());
}

export function unknownRuntimeReportField(path: string, name: string): never {
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

export const RUNTIME_REPORT_OPERATORS_BY_TYPE: Readonly<
  Record<RuntimeReportColumnType, readonly RuntimeReportFilter['op'][]>
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

export function runtimeReportAggregatesFor(
  type: RuntimeReportColumnType,
): readonly string[] {
  if (type === 'integer' || type === 'decimal') {
    return ['count', 'countDistinct', 'sum', 'avg', 'min', 'max'];
  }
  if (type === 'datetime') return ['count', 'countDistinct', 'min', 'max'];
  return ['count', 'countDistinct'];
}

/** Reject an operator the field's type does not admit. */
export function assertRuntimeReportFilterOperator(
  filter: RuntimeReportFilter,
  type: RuntimeReportColumnType,
  path: string,
): void {
  if (!RUNTIME_REPORT_OPERATORS_BY_TYPE[type].includes(filter.op)) {
    badOperation(
      `${path}.op`,
      `'${filter.op}' is not valid for ${type} fields`,
    );
  }
}

/** Coerce one filter value to the field's type (ids lower-cased, datetimes to `Date`). */
export function coerceRuntimeReportValue(
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

/**
 * Resolve a source's `fields` allow-list and `excludeFields` deny-list against
 * the canonical names it declares. Unknown or malformed names reject the whole
 * source (`unsupported_source`), misspelled exclusions included.
 */
export function resolveRuntimeReportFieldPolicy(
  source: {
    fields?: readonly string[];
    excludeFields?: readonly string[];
  },
  knownNames: ReadonlySet<string>,
): { included?: Set<string>; excluded?: Set<string> } {
  const policy = (key: 'fields' | 'excludeFields'): Set<string> | undefined => {
    const value = source[key];
    if (value === undefined) return undefined;
    if (
      !Array.isArray(value) ||
      Array.from(value).some(
        (name) => typeof name !== 'string' || !knownNames.has(name),
      )
    ) {
      throw new RuntimeReportError(
        'unsupported_source',
        `source.${key}`,
        `${key} must contain canonical field names declared on the source`,
      );
    }
    return new Set(value);
  };
  const included = policy('fields');
  const excluded = policy('excludeFields');
  return {
    ...(included ? { included } : {}),
    ...(excluded ? { excluded } : {}),
  };
}

function measureColumnType(
  fn: string,
  field: RuntimeReportPlanField | undefined,
): RuntimeReportColumnType {
  if (fn === 'count' || fn === 'countDistinct') return 'integer';
  if (fn === 'avg') return 'decimal';
  return field?.type ?? 'decimal';
}

/**
 * Validate the spec's dimensions and measures against the resolved fields and
 * describe the result columns, dimensions first. Filters are validated by the
 * caller, after this, so error order matches across both runners.
 */
export function planRuntimeReportColumns(
  spec: RuntimeReportSpec,
  fields: ReadonlyMap<string, RuntimeReportPlanField>,
): RuntimeReportColumn[] {
  const lookup = (name: string, path: string): RuntimeReportPlanField => {
    const field = fields.get(name);
    if (!field) unknownRuntimeReportField(path, name);
    return field;
  };
  const columns: RuntimeReportColumn[] = [];
  for (const [index, dimension] of spec.dimensions.entries()) {
    const path = `spec.dimensions[${index}]`;
    const field = lookup(dimension.field, `${path}.field`);
    if (dimension.bucket && field.type !== 'datetime') {
      badOperation(
        `${path}.bucket`,
        'buckets are only valid on datetime fields',
      );
    }
    columns.push({
      id: dimension.as,
      label: humanizeRuntimeReportName(dimension.as),
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
    const keepsFormat =
      field?.format &&
      (measure.fn === 'sum' ||
        measure.fn === 'min' ||
        measure.fn === 'max' ||
        measure.fn === 'avg');
    columns.push({
      id: measure.as,
      label: humanizeRuntimeReportName(measure.as),
      role: 'measure',
      type: measureColumnType(measure.fn, field),
      ...(field ? { field: field.name } : {}),
      fn: measure.fn,
      ...(keepsFormat ? { format: field?.format } : {}),
    });
  }
  return columns;
}

/** Describe what a spec may reference on a source with these resolved fields. */
export function describeRuntimeReportFields(
  fields: Iterable<RuntimeReportPlanField>,
): RuntimeReportSourceDescription['fields'] {
  return [...fields].map((field) => ({
    name: field.name,
    label: field.label,
    type: field.type,
    ...(field.format ? { format: field.format } : {}),
    filterOperators: RUNTIME_REPORT_OPERATORS_BY_TYPE[field.type],
    aggregates: runtimeReportAggregatesFor(field.type),
  }));
}

/** Normalize one result cell to the wire shape (safe integers, ISO datetimes). */
export function normalizeRuntimeReportCell(
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
