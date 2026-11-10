import type { RuntimeReportSpec } from './types.js';

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const ALIAS = /^[a-z][a-z0-9_]*$/;
const SOURCE = /^[A-Za-z@][A-Za-z0-9_@./:-]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: mirrors the server grammar's printable-text guard
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const BUCKETS = new Set([
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);
const MEASURES = new Set([
  'count',
  'countDistinct',
  'sum',
  'avg',
  'min',
  'max',
]);
const FILTERS = new Set([
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
]);
const HAVING = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
const CHARTS = new Set(['table', 'bar', 'line', 'pie', 'stat']);
const RESERVED = new Set([
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

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function text(value: unknown, max: number, optional = false): boolean {
  if (value === undefined) return optional;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= max &&
    trimmed === value &&
    !CONTROL.test(trimmed)
  );
}

function field(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 64 && IDENTIFIER.test(value)
  );
}

function alias(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 40 &&
    ALIAS.test(value) &&
    !RESERVED.has(value)
  );
}

function scalar(value: unknown): boolean {
  return (
    (typeof value === 'string' &&
      value.length <= 256 &&
      !value.includes('\u0000')) ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'boolean'
  );
}

/** Browser-safe validation of the server's already-normalized closed grammar. */
export function validRuntimeReportSpec(
  value: unknown,
): value is RuntimeReportSpec {
  const spec = record(value);
  if (
    !spec ||
    !keys(spec, [
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
    ]) ||
    spec.version !== 1 ||
    !text(spec.title, 120) ||
    !text(spec.description, 500, true) ||
    typeof spec.source !== 'string' ||
    spec.source.length === 0 ||
    spec.source.length > 120 ||
    !SOURCE.test(spec.source) ||
    !Array.isArray(spec.dimensions) ||
    spec.dimensions.length > 4 ||
    !Array.isArray(spec.measures) ||
    spec.measures.length < 1 ||
    spec.measures.length > 6 ||
    !Array.isArray(spec.filters) ||
    spec.filters.length > 12 ||
    !Array.isArray(spec.having) ||
    spec.having.length > 4 ||
    !Array.isArray(spec.sort) ||
    spec.sort.length > 3 ||
    !Number.isSafeInteger(spec.limit) ||
    (spec.limit as number) < 1 ||
    (spec.limit as number) > 1000
  )
    return false;

  const dimensions = new Set<string>();
  const measures = new Set<string>();
  const aliases = new Set<string>();
  for (const value of spec.dimensions) {
    const item = record(value);
    if (
      !item ||
      !keys(item, ['field', 'as', 'bucket']) ||
      !field(item.field) ||
      !alias(item.as) ||
      (item.bucket !== undefined &&
        (typeof item.bucket !== 'string' || !BUCKETS.has(item.bucket))) ||
      aliases.has(item.as)
    )
      return false;
    aliases.add(item.as);
    dimensions.add(item.as);
  }
  for (const value of spec.measures) {
    const item = record(value);
    if (
      !item ||
      !keys(item, ['fn', 'field', 'as']) ||
      typeof item.fn !== 'string' ||
      !MEASURES.has(item.fn) ||
      !alias(item.as) ||
      aliases.has(item.as) ||
      (item.field !== undefined && !field(item.field)) ||
      (item.fn !== 'count' && item.field === undefined)
    )
      return false;
    aliases.add(item.as);
    measures.add(item.as);
  }
  for (const value of spec.filters) {
    const item = record(value);
    if (
      !item ||
      !keys(item, ['field', 'op', 'value']) ||
      !field(item.field) ||
      typeof item.op !== 'string' ||
      !FILTERS.has(item.op)
    )
      return false;
    if (item.op === 'isNull' || item.op === 'isNotNull') {
      if (item.value !== undefined) return false;
    } else if (item.op === 'in' || item.op === 'notIn') {
      if (
        !Array.isArray(item.value) ||
        item.value.length < 1 ||
        item.value.length > 100 ||
        !item.value.every(scalar)
      )
        return false;
    } else if (
      !scalar(item.value) ||
      (item.op === 'contains' && typeof item.value !== 'string')
    )
      return false;
  }
  for (const value of spec.having) {
    const item = record(value);
    if (
      !item ||
      !keys(item, ['measure', 'op', 'value']) ||
      !alias(item.measure) ||
      !measures.has(item.measure) ||
      typeof item.op !== 'string' ||
      !HAVING.has(item.op) ||
      typeof item.value !== 'number' ||
      !Number.isFinite(item.value)
    )
      return false;
  }
  for (const value of spec.sort) {
    const item = record(value);
    if (
      !item ||
      !keys(item, ['by', 'direction']) ||
      !alias(item.by) ||
      !aliases.has(item.by) ||
      (item.direction !== 'asc' && item.direction !== 'desc')
    )
      return false;
  }
  const chart = record(spec.chart);
  if (
    !chart ||
    !keys(chart, ['type', 'x', 'y']) ||
    typeof chart.type !== 'string' ||
    !CHARTS.has(chart.type) ||
    (chart.x !== undefined && (!alias(chart.x) || !dimensions.has(chart.x))) ||
    (chart.y !== undefined &&
      (!Array.isArray(chart.y) ||
        chart.y.length > 6 ||
        !chart.y.every((name) => alias(name) && measures.has(name))))
  )
    return false;
  return true;
}

export function runtimeReportSpecFromWire(
  value: unknown,
): RuntimeReportSpec | null {
  let candidate = value;
  if (typeof value === 'string') {
    if (value.length > 64 * 1024) return null;
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return validRuntimeReportSpec(candidate) ? candidate : null;
}
