/**
 * Declarative runtime report specification (#3711).
 *
 * A runtime report is DATA, never code: a closed, versioned structure that a
 * user (or the assistant on a user's behalf) can propose at runtime. The spec
 * grammar deliberately has no free-form SQL, no expression language, no raw
 * identifiers and no join syntax. Every name in it is later resolved against
 * the ObjectRegistry field policy by `compileRuntimeReportSpec()`; this module
 * only enforces the STRUCTURE (shape, bounds, alias hygiene) and normalizes
 * defaults so equal specs hash equally.
 *
 * The parser accepts no authority. Nothing in a spec names a tenant, a
 * principal, a permission, a table, a column alias that is not a plain
 * identifier, or an SQL fragment.
 */

import { createHash } from 'node:crypto';

export const RUNTIME_REPORT_SPEC_VERSION = 1 as const;

export const RUNTIME_REPORT_LIMITS = Object.freeze({
  maxTitleLength: 120,
  maxDescriptionLength: 500,
  maxDimensions: 4,
  maxMeasures: 6,
  maxFilters: 12,
  maxHaving: 4,
  maxSort: 3,
  maxInValues: 100,
  maxStringValueLength: 256,
  defaultRowLimit: 100,
  maxRowLimit: 1000,
  maxAliasLength: 40,
  maxFieldNameLength: 64,
  maxSourceIdLength: 120,
});

export const RUNTIME_REPORT_BUCKETS = [
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;
export type RuntimeReportBucket = (typeof RUNTIME_REPORT_BUCKETS)[number];

export const RUNTIME_REPORT_MEASURE_FNS = [
  'count',
  'countDistinct',
  'sum',
  'avg',
  'min',
  'max',
] as const;
export type RuntimeReportMeasureFn =
  (typeof RUNTIME_REPORT_MEASURE_FNS)[number];

export const RUNTIME_REPORT_FILTER_OPS = [
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
] as const;
export type RuntimeReportFilterOp = (typeof RUNTIME_REPORT_FILTER_OPS)[number];

export const RUNTIME_REPORT_HAVING_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
] as const;
export type RuntimeReportHavingOp = (typeof RUNTIME_REPORT_HAVING_OPS)[number];

export const RUNTIME_REPORT_CHART_TYPES = [
  'table',
  'bar',
  'line',
  'pie',
  'stat',
] as const;
export type RuntimeReportChartType =
  (typeof RUNTIME_REPORT_CHART_TYPES)[number];

export type RuntimeReportScalar = string | number | boolean;

export interface RuntimeReportDimension {
  /** Source field name as declared on the model (for example `issuedAt`). */
  field: string;
  /** Output column alias. Defaults to the snake_case field (plus bucket). */
  as: string;
  /** Time bucket; only valid on datetime fields. */
  bucket?: RuntimeReportBucket;
}

export interface RuntimeReportMeasure {
  fn: RuntimeReportMeasureFn;
  /** Source field; omitted only for a plain row `count`. */
  field?: string;
  as: string;
}

export interface RuntimeReportFilter {
  field: string;
  op: RuntimeReportFilterOp;
  /** Scalar, or a bounded array for `in`/`notIn`; absent for null tests. */
  value?: RuntimeReportScalar | RuntimeReportScalar[];
}

export interface RuntimeReportHaving {
  /** A measure alias declared by this spec. */
  measure: string;
  op: RuntimeReportHavingOp;
  value: number;
}

export interface RuntimeReportSort {
  /** A dimension or measure alias declared by this spec. */
  by: string;
  direction: 'asc' | 'desc';
}

export interface RuntimeReportChart {
  type: RuntimeReportChartType;
  /** Dimension alias for the category/x axis. */
  x?: string;
  /** Measure aliases for the value/y axis. */
  y?: string[];
}

export interface RuntimeReportSpec {
  version: typeof RUNTIME_REPORT_SPEC_VERSION;
  title: string;
  description?: string;
  /** A server-owned source id; resolved against an allow-list at compile. */
  source: string;
  dimensions: RuntimeReportDimension[];
  measures: RuntimeReportMeasure[];
  filters: RuntimeReportFilter[];
  having: RuntimeReportHaving[];
  sort: RuntimeReportSort[];
  limit: number;
  chart: RuntimeReportChart;
}

export type RuntimeReportErrorCode =
  | 'invalid_spec'
  | 'unknown_source'
  | 'unknown_field'
  | 'invalid_operation'
  | 'invalid_value'
  | 'tenant_required'
  | 'unsupported_source'
  | 'invalid_result';

/**
 * Raised for any spec or compile rejection. The message is safe to hand back
 * to a model so it can repair the spec; it never echoes restricted-field
 * metadata (a hidden field is reported exactly like an absent one).
 */
export class RuntimeReportError extends Error {
  readonly code: RuntimeReportErrorCode;
  readonly path: string;
  /**
   * HTTP-style status so tool loops classify it: 4xx input problems are
   * repairable by the caller, `tenant_required` is a denial, results that
   * cannot be represented are server errors.
   */
  readonly status: number;

  constructor(code: RuntimeReportErrorCode, path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = 'RuntimeReportError';
    this.code = code;
    this.path = path;
    this.status =
      code === 'tenant_required' ? 403 : code === 'invalid_result' ? 500 : 422;
  }
}

function fail(path: string, message: string): never {
  throw new RuntimeReportError('invalid_spec', path, message);
}

/** Output aliases that would be reserved words in at least one SQL dialect. */
const RESERVED_ALIASES: ReadonlySet<string> = new Set([
  'all',
  'and',
  'as',
  'asc',
  'between',
  'by',
  'case',
  'cast',
  'check',
  'column',
  'constraint',
  'create',
  'cross',
  'default',
  'delete',
  'desc',
  'distinct',
  'drop',
  'else',
  'end',
  'except',
  'exists',
  'false',
  'for',
  'foreign',
  'from',
  'full',
  'group',
  'having',
  'in',
  'inner',
  'insert',
  'intersect',
  'into',
  'is',
  'join',
  'left',
  'like',
  'limit',
  'natural',
  'not',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'primary',
  'references',
  'right',
  'select',
  'set',
  'table',
  'then',
  'to',
  'true',
  'union',
  'unique',
  'update',
  'user',
  'using',
  'values',
  'when',
  'where',
  'with',
]);

const ALIAS_PATTERN = /^[a-z][a-z0-9_]*$/;
const FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SOURCE_PATTERN = /^[A-Za-z@][A-Za-z0-9_@./:-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function strictObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}.${key}`, 'is not a known key');
  }
  return value;
}

function strictArray(
  value: unknown,
  path: string,
  max: number,
  min = 0,
): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(path, 'must be an array');
  if (value.length > max) fail(path, `must have at most ${max} entries`);
  if (value.length < min) fail(path, `must have at least ${min} entries`);
  return value;
}

function text(
  value: unknown,
  path: string,
  max: number,
  options: { optional?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    if (options.optional && value === undefined) return '';
    fail(path, 'must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 && !options.optional) {
    fail(path, 'must not be empty');
  }
  if (trimmed.length > max) fail(path, `must be at most ${max} characters`);
  // Titles/descriptions are echoed into UIs and prompts: keep them printable.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional guard
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) {
    fail(path, 'must not contain control characters');
  }
  return trimmed;
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function fieldName(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (
    value.length === 0 ||
    value.length > RUNTIME_REPORT_LIMITS.maxFieldNameLength ||
    !FIELD_PATTERN.test(value)
  ) {
    fail(path, 'must be a plain field name (letters, digits, underscore)');
  }
  return value;
}

function alias(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string');
  if (
    value.length === 0 ||
    value.length > RUNTIME_REPORT_LIMITS.maxAliasLength ||
    !ALIAS_PATTERN.test(value)
  ) {
    fail(
      path,
      `must be a lowercase identifier of at most ${RUNTIME_REPORT_LIMITS.maxAliasLength} characters (a-z, 0-9, underscore)`,
    );
  }
  if (RESERVED_ALIASES.has(value)) fail(path, `'${value}' is a reserved word`);
  return value;
}

function scalar(value: unknown, path: string): RuntimeReportScalar {
  if (typeof value === 'string') {
    if (value.length > RUNTIME_REPORT_LIMITS.maxStringValueLength) {
      fail(
        path,
        `must be at most ${RUNTIME_REPORT_LIMITS.maxStringValueLength} characters`,
      );
    }
    if (value.includes('\u0000')) fail(path, 'must not contain NUL');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite number');
    return value;
  }
  if (typeof value === 'boolean') return value;
  return fail(path, 'must be a string, number or boolean');
}

function snake(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

function parseDimension(value: unknown, path: string): RuntimeReportDimension {
  const raw = strictObject(value, path, ['field', 'as', 'bucket']);
  const field = fieldName(raw.field, `${path}.field`);
  const bucket =
    raw.bucket === undefined
      ? undefined
      : oneOf(raw.bucket, `${path}.bucket`, RUNTIME_REPORT_BUCKETS);
  const as =
    raw.as === undefined
      ? alias(bucket ? `${snake(field)}_${bucket}` : snake(field), `${path}.as`)
      : alias(raw.as, `${path}.as`);
  return { field, as, ...(bucket ? { bucket } : {}) };
}

function parseMeasure(value: unknown, path: string): RuntimeReportMeasure {
  const raw = strictObject(value, path, ['fn', 'field', 'as']);
  const fn = oneOf(raw.fn, `${path}.fn`, RUNTIME_REPORT_MEASURE_FNS);
  const field =
    raw.field === undefined ? undefined : fieldName(raw.field, `${path}.field`);
  if (!field && fn !== 'count') fail(`${path}.field`, `is required for ${fn}`);
  const as =
    raw.as === undefined
      ? alias(
          field ? `${snake(fn)}_${snake(field)}` : 'row_count',
          `${path}.as`,
        )
      : alias(raw.as, `${path}.as`);
  return { fn, ...(field ? { field } : {}), as };
}

function parseFilter(value: unknown, path: string): RuntimeReportFilter {
  const raw = strictObject(value, path, ['field', 'op', 'value']);
  const field = fieldName(raw.field, `${path}.field`);
  const op = oneOf(raw.op, `${path}.op`, RUNTIME_REPORT_FILTER_OPS);
  if (op === 'isNull' || op === 'isNotNull') {
    if (raw.value !== undefined)
      fail(`${path}.value`, `must be omitted for ${op}`);
    return { field, op };
  }
  if (raw.value === undefined) fail(`${path}.value`, `is required for ${op}`);
  if (op === 'in' || op === 'notIn') {
    const values = strictArray(
      raw.value,
      `${path}.value`,
      RUNTIME_REPORT_LIMITS.maxInValues,
      1,
    ).map((entry, index) => scalar(entry, `${path}.value[${index}]`));
    return { field, op, value: values };
  }
  if (Array.isArray(raw.value))
    fail(`${path}.value`, `must be a scalar for ${op}`);
  const parsed = scalar(raw.value, `${path}.value`);
  if (op === 'contains' && typeof parsed !== 'string') {
    fail(`${path}.value`, 'must be a string for contains');
  }
  return { field, op, value: parsed };
}

function parseHaving(value: unknown, path: string): RuntimeReportHaving {
  const raw = strictObject(value, path, ['measure', 'op', 'value']);
  const measure = alias(raw.measure, `${path}.measure`);
  const op = oneOf(raw.op, `${path}.op`, RUNTIME_REPORT_HAVING_OPS);
  if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
    fail(`${path}.value`, 'must be a finite number');
  }
  return { measure, op, value: raw.value };
}

function parseSort(value: unknown, path: string): RuntimeReportSort {
  const raw = strictObject(value, path, ['by', 'direction']);
  const by = alias(raw.by, `${path}.by`);
  const direction =
    raw.direction === undefined
      ? 'asc'
      : oneOf(raw.direction, `${path}.direction`, ['asc', 'desc'] as const);
  return { by, direction };
}

/**
 * Parse and normalize an untrusted spec (an object, or its JSON string form).
 *
 * Structural only: aliases are unique and well-formed, sort/having/chart refer
 * to aliases the spec itself declares, and every bound is enforced. Field,
 * source, permission and type checks happen at compile time because they
 * depend on the registry and the live principal.
 */
export function parseRuntimeReportSpec(input: unknown): RuntimeReportSpec {
  let candidate = input;
  if (typeof input === 'string') {
    if (input.length > 64 * 1024) fail('', 'spec JSON is too large');
    try {
      candidate = JSON.parse(input);
    } catch {
      fail('', 'spec is not valid JSON');
    }
  }
  const raw = strictObject(candidate, 'spec', [
    'version',
    'title',
    'description',
    'source',
    'dimensions',
    'measures',
    'filters',
    'having',
    'sort',
    'limit',
    'chart',
  ]);
  if (
    raw.version !== undefined &&
    raw.version !== RUNTIME_REPORT_SPEC_VERSION
  ) {
    fail(
      'spec.version',
      `unsupported version (expected ${RUNTIME_REPORT_SPEC_VERSION})`,
    );
  }
  const title = text(
    raw.title,
    'spec.title',
    RUNTIME_REPORT_LIMITS.maxTitleLength,
  );
  const description = text(
    raw.description,
    'spec.description',
    RUNTIME_REPORT_LIMITS.maxDescriptionLength,
    { optional: true },
  );
  if (
    typeof raw.source !== 'string' ||
    raw.source.length === 0 ||
    raw.source.length > RUNTIME_REPORT_LIMITS.maxSourceIdLength ||
    !SOURCE_PATTERN.test(raw.source)
  ) {
    fail('spec.source', 'must be a source id');
  }

  const dimensions = strictArray(
    raw.dimensions,
    'spec.dimensions',
    RUNTIME_REPORT_LIMITS.maxDimensions,
  ).map((entry, index) => parseDimension(entry, `spec.dimensions[${index}]`));
  const measures = strictArray(
    raw.measures,
    'spec.measures',
    RUNTIME_REPORT_LIMITS.maxMeasures,
    1,
  ).map((entry, index) => parseMeasure(entry, `spec.measures[${index}]`));
  const filters = strictArray(
    raw.filters,
    'spec.filters',
    RUNTIME_REPORT_LIMITS.maxFilters,
  ).map((entry, index) => parseFilter(entry, `spec.filters[${index}]`));
  const having = strictArray(
    raw.having,
    'spec.having',
    RUNTIME_REPORT_LIMITS.maxHaving,
  ).map((entry, index) => parseHaving(entry, `spec.having[${index}]`));
  const sort = strictArray(
    raw.sort,
    'spec.sort',
    RUNTIME_REPORT_LIMITS.maxSort,
  ).map((entry, index) => parseSort(entry, `spec.sort[${index}]`));

  const dimensionAliases = new Set<string>();
  const measureAliases = new Set<string>();
  const seen = new Set<string>();
  for (const [index, dimension] of dimensions.entries()) {
    if (seen.has(dimension.as)) {
      fail(`spec.dimensions[${index}].as`, `duplicate alias '${dimension.as}'`);
    }
    seen.add(dimension.as);
    dimensionAliases.add(dimension.as);
  }
  for (const [index, measure] of measures.entries()) {
    if (seen.has(measure.as)) {
      fail(`spec.measures[${index}].as`, `duplicate alias '${measure.as}'`);
    }
    seen.add(measure.as);
    measureAliases.add(measure.as);
  }
  for (const [index, entry] of having.entries()) {
    if (!measureAliases.has(entry.measure)) {
      fail(`spec.having[${index}].measure`, 'must be a declared measure alias');
    }
  }
  for (const [index, entry] of sort.entries()) {
    if (!seen.has(entry.by)) {
      fail(
        `spec.sort[${index}].by`,
        'must be a declared dimension or measure alias',
      );
    }
  }

  let limit: number = RUNTIME_REPORT_LIMITS.defaultRowLimit;
  if (raw.limit !== undefined) {
    if (
      typeof raw.limit !== 'number' ||
      !Number.isSafeInteger(raw.limit) ||
      raw.limit < 1 ||
      raw.limit > RUNTIME_REPORT_LIMITS.maxRowLimit
    ) {
      fail(
        'spec.limit',
        `must be an integer between 1 and ${RUNTIME_REPORT_LIMITS.maxRowLimit}`,
      );
    }
    limit = raw.limit;
  }

  let chart: RuntimeReportChart = { type: 'table' };
  if (raw.chart !== undefined) {
    const rawChart = strictObject(raw.chart, 'spec.chart', ['type', 'x', 'y']);
    const type = oneOf(
      rawChart.type,
      'spec.chart.type',
      RUNTIME_REPORT_CHART_TYPES,
    );
    const x =
      rawChart.x === undefined ? undefined : alias(rawChart.x, 'spec.chart.x');
    if (x !== undefined && !dimensionAliases.has(x)) {
      fail('spec.chart.x', 'must be a declared dimension alias');
    }
    const y = strictArray(
      rawChart.y,
      'spec.chart.y',
      RUNTIME_REPORT_LIMITS.maxMeasures,
    ).map((entry, index) => alias(entry, `spec.chart.y[${index}]`));
    for (const [index, name] of y.entries()) {
      if (!measureAliases.has(name)) {
        fail(`spec.chart.y[${index}]`, 'must be a declared measure alias');
      }
    }
    chart = { type, ...(x ? { x } : {}), ...(y.length > 0 ? { y } : {}) };
  }

  return {
    version: RUNTIME_REPORT_SPEC_VERSION,
    title,
    ...(description ? { description } : {}),
    source: raw.source as string,
    dimensions,
    measures,
    filters,
    having,
    sort,
    limit,
    chart,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

/** Stable fingerprint of a NORMALIZED spec; equal specs hash equally. */
export function runtimeReportSpecHash(spec: RuntimeReportSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(spec)))
    .digest('hex');
}

/** Stable JSON text for storage (sorted keys). */
export function serializeRuntimeReportSpec(spec: RuntimeReportSpec): string {
  return JSON.stringify(canonicalize(spec));
}
