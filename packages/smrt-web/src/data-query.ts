/**
 * Browser transport for the canonical bounded data-query envelope (#2444).
 *
 * This is a textual structural mirror of `@happyvertical/smrt-types` rather
 * than an import: smrt-web deliberately has no inter-SMRT dependencies. The
 * authenticated server adapter owns allowlist, authorization, fingerprint,
 * and byte-limit enforcement. This module gives browser callers a stable
 * request/result shape and rejects malformed response envelopes before they
 * reach a mounted surface.
 */

export type SmrtWebDataQueryScalar = string | number | boolean | null;
export type SmrtWebDataQueryFilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'like';

export type SmrtWebDataQueryFilter =
  | {
      kind: 'condition';
      field: string;
      operator: SmrtWebDataQueryFilterOperator;
      value: SmrtWebDataQueryScalar | SmrtWebDataQueryScalar[];
    }
  | { kind: 'all' | 'any'; filters: SmrtWebDataQueryFilter[] }
  | { kind: 'not'; filter: SmrtWebDataQueryFilter };

export interface SmrtWebDataQueryRequest {
  version: 1;
  requestId: string;
  mode: 'rows' | 'count' | 'facets';
  projection?: string[];
  filter?: SmrtWebDataQueryFilter;
  sort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  page?:
    | { kind: 'offset'; offset: number; limit: number }
    | { kind: 'cursor'; after?: string; limit: number };
  consistency?: { mode: 'eventual' | 'snapshot'; asOf?: string };
  facets?: Array<{ field: string; limit: number }>;
}

export type SmrtWebDataQueryTotal =
  | { kind: 'exact' | 'estimated'; value: number; asOf?: string }
  | { kind: 'unavailable'; reason?: string };

export interface SmrtWebDataQueryFacetResult {
  field: string;
  values: Array<{ value: SmrtWebDataQueryScalar; count: number }>;
  truncated: boolean;
}

export interface SmrtWebDataQueryResult {
  version: 1;
  requestId: string;
  queryFingerprint: string;
  identityField: string;
  rows: Array<Record<string, unknown>>;
  page?:
    | { kind: 'offset'; limit: number; offset: number; hasMore: boolean }
    | {
        kind: 'cursor';
        limit: number;
        nextCursor?: string;
        hasMore: boolean;
      };
  total: SmrtWebDataQueryTotal;
  facets?: SmrtWebDataQueryFacetResult[];
  freshness: { state: 'fresh' | 'stale' | 'unknown'; asOf?: string };
  warnings: string[];
  truncated: boolean;
}

/** Browser transport seam; REST, WebMCP, and test transports share it. */
export interface SmrtWebDataQueryTransport {
  query(
    request: SmrtWebDataQueryRequest,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Mirrors core's hard output limits without adding an inter-SMRT dependency. */
export const MAX_SMRT_WEB_DATA_QUERY_RESULT_BYTES = 10_000_000;
export const MAX_SMRT_WEB_DATA_QUERY_ROWS = 1_000;
export const MAX_SMRT_WEB_DATA_QUERY_FACETS = 20;
export const MAX_SMRT_WEB_DATA_QUERY_FACET_VALUES = 1_000;
export const MAX_SMRT_WEB_DATA_QUERY_WARNINGS = 100;
export const MAX_SMRT_WEB_DATA_QUERY_PAGE_LIMIT = 1_000;
export const MAX_SMRT_WEB_DATA_QUERY_OFFSET = 1_000_000;
export const MAX_SMRT_WEB_DATA_QUERY_CONTAINER_ITEMS = 1_000;
export const MAX_SMRT_WEB_DATA_QUERY_STRING_LENGTH = 65_536;

interface JsonBudget {
  remaining: number;
}

function consumeBytes(budget: JsonBudget, text: string, label: string): void {
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > budget.remaining) {
    throw new TypeError(`${label} exceeds the maximum byte limit`);
  }
  budget.remaining -= bytes;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new TypeError(`${label} contains a forbidden key`);
    }
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${label} contains ${key}`);
  }
}

function stringValue(value: unknown, label: string, maxLength = 2_048): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function scalar(
  value: unknown,
  label: string,
  budget: JsonBudget,
): SmrtWebDataQueryScalar {
  if (typeof value === 'string') {
    if (value.length > MAX_SMRT_WEB_DATA_QUERY_STRING_LENGTH) {
      throw new TypeError(`${label} exceeds the string limit`);
    }
    consumeBytes(budget, JSON.stringify(value), label);
    return value;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    consumeBytes(budget, JSON.stringify(value), label);
    return value;
  }
  throw new TypeError(`${label} must be a JSON scalar`);
}

function jsonValue(
  value: unknown,
  label: string,
  budget: JsonBudget,
  depth = 0,
): unknown {
  if (depth > 16) throw new TypeError(`${label} exceeds JSON depth`);
  if (typeof value === 'string') {
    if (value.length > MAX_SMRT_WEB_DATA_QUERY_STRING_LENGTH) {
      throw new TypeError(`${label} exceeds the string limit`);
    }
    consumeBytes(budget, JSON.stringify(value), label);
    return value;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    consumeBytes(budget, JSON.stringify(value), label);
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_SMRT_WEB_DATA_QUERY_CONTAINER_ITEMS) {
      throw new TypeError(`${label} exceeds the container-item limit`);
    }
    consumeBytes(budget, '[', label);
    const result: unknown[] = [];
    for (const [index, item] of value.entries()) {
      if (index > 0) consumeBytes(budget, ',', label);
      result.push(jsonValue(item, `${label}[${index}]`, budget, depth + 1));
    }
    consumeBytes(budget, ']', label);
    return result;
  }
  const object = plainObject(value, label);
  if (Object.keys(object).length > MAX_SMRT_WEB_DATA_QUERY_CONTAINER_ITEMS) {
    throw new TypeError(`${label} exceeds the container-item limit`);
  }
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  consumeBytes(budget, '{', label);
  for (const [index, key] of Object.keys(object).sort().entries()) {
    if (key.length > MAX_SMRT_WEB_DATA_QUERY_STRING_LENGTH) {
      throw new TypeError(`${label}.${key} exceeds the string limit`);
    }
    if (index > 0) consumeBytes(budget, ',', label);
    consumeBytes(budget, JSON.stringify(key), `${label}.${key}`);
    consumeBytes(budget, ':', label);
    result[key] = jsonValue(object[key], `${label}.${key}`, budget, depth + 1);
  }
  consumeBytes(budget, '}', label);
  return result;
}

function normalizeTotal(value: unknown): SmrtWebDataQueryTotal {
  const total = plainObject(value, 'Data query total');
  const kind = stringValue(total.kind, 'Data query total kind');
  if (kind === 'unavailable') {
    exactKeys(total, ['kind', 'reason'], 'Data query unavailable total');
    return {
      kind,
      ...(total.reason === undefined
        ? {}
        : { reason: stringValue(total.reason, 'Data query total reason') }),
    };
  }
  if (kind !== 'exact' && kind !== 'estimated') {
    throw new TypeError('Data query total kind is invalid');
  }
  exactKeys(total, ['kind', 'value', 'asOf'], 'Data query total');
  return {
    kind,
    value: nonNegativeInteger(total.value, 'Data query total value'),
    ...(total.asOf === undefined
      ? {}
      : { asOf: stringValue(total.asOf, 'Data query total asOf', 128) }),
  };
}

function normalizeFacets(
  value: unknown,
  budget: JsonBudget,
): SmrtWebDataQueryFacetResult[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new TypeError('Data query facets must be an array');
  if (value.length > MAX_SMRT_WEB_DATA_QUERY_FACETS) {
    throw new TypeError('Data query facets exceed the maximum');
  }
  const fields = new Set<string>();
  return value.map((candidate, index) => {
    const facet = plainObject(candidate, `Data query facet ${index}`);
    exactKeys(facet, ['field', 'values', 'truncated'], 'Data query facet');
    const field = stringValue(facet.field, 'Data query facet field');
    if (fields.has(field))
      throw new TypeError('Data query facet fields must be unique');
    fields.add(field);
    if (!Array.isArray(facet.values)) {
      throw new TypeError('Data query facet values must be an array');
    }
    if (facet.values.length > MAX_SMRT_WEB_DATA_QUERY_FACET_VALUES) {
      throw new TypeError('Data query facet values exceed the maximum');
    }
    if (typeof facet.truncated !== 'boolean') {
      throw new TypeError('Data query facet truncated must be boolean');
    }
    return {
      field,
      values: facet.values.map((value, valueIndex) => {
        const entry = plainObject(
          value,
          `Data query facet ${index} value ${valueIndex}`,
        );
        exactKeys(entry, ['value', 'count'], 'Data query facet value');
        return {
          value: scalar(entry.value, 'Data query facet value', budget),
          count: nonNegativeInteger(entry.count, 'Data query facet count'),
        };
      }),
      truncated: facet.truncated,
    };
  });
}

/**
 * Check the server-produced, normalized result envelope before a browser
 * surface consumes it. This validates portable shape only; the server's core
 * normalizer remains the authorization, projection, and query-policy boundary.
 */
export function normalizeSmrtWebDataQueryResult(
  value: unknown,
): SmrtWebDataQueryResult {
  const result = plainObject(value, 'Data query result');
  exactKeys(
    result,
    [
      'version',
      'requestId',
      'queryFingerprint',
      'identityField',
      'rows',
      'page',
      'total',
      'facets',
      'freshness',
      'warnings',
      'truncated',
    ],
    'Data query result',
  );
  if (result.version !== 1)
    throw new TypeError('Unsupported data query version');
  const identityField = stringValue(
    result.identityField,
    'Data query identity field',
  );
  if (!Array.isArray(result.rows))
    throw new TypeError('Data query rows must be an array');
  if (result.rows.length > MAX_SMRT_WEB_DATA_QUERY_ROWS) {
    throw new TypeError('Data query rows exceed the maximum');
  }
  const budget: JsonBudget = {
    remaining: MAX_SMRT_WEB_DATA_QUERY_RESULT_BYTES,
  };
  const rows = result.rows.map((row, index) => {
    const normalized = jsonValue(row, `Data query row ${index}`, budget);
    const object = plainObject(normalized, `Data query row ${index}`);
    const identity = object[identityField];
    if (
      (typeof identity !== 'string' && typeof identity !== 'number') ||
      identity === ''
    ) {
      throw new TypeError('Data query row is missing its stable identity');
    }
    return object;
  });
  let page: SmrtWebDataQueryResult['page'];
  if (result.page !== undefined) {
    const candidate = plainObject(result.page, 'Data query page');
    exactKeys(
      candidate,
      ['kind', 'limit', 'offset', 'nextCursor', 'hasMore'],
      'Data query page',
    );
    const kind = stringValue(candidate.kind, 'Data query page kind');
    if (kind !== 'offset' && kind !== 'cursor') {
      throw new TypeError('Data query page kind is invalid');
    }
    if (typeof candidate.hasMore !== 'boolean') {
      throw new TypeError('Data query page hasMore must be boolean');
    }
    const limit = nonNegativeInteger(candidate.limit, 'Data query page limit');
    if (limit === 0)
      throw new TypeError('Data query page limit must be positive');
    if (limit > MAX_SMRT_WEB_DATA_QUERY_PAGE_LIMIT) {
      throw new TypeError('Data query page limit exceeds the maximum');
    }
    if (kind === 'offset') {
      if (
        candidate.nextCursor !== undefined ||
        candidate.offset === undefined
      ) {
        throw new TypeError('Offset data query page must carry only an offset');
      }
      const offset = nonNegativeInteger(candidate.offset, 'Data query offset');
      if (offset > MAX_SMRT_WEB_DATA_QUERY_OFFSET) {
        throw new TypeError('Data query offset exceeds the maximum');
      }
      page = {
        kind,
        limit,
        offset,
        hasMore: candidate.hasMore,
      };
    } else {
      if (candidate.offset !== undefined) {
        throw new TypeError('Cursor data query page cannot carry an offset');
      }
      const nextCursor =
        candidate.nextCursor === undefined
          ? undefined
          : stringValue(candidate.nextCursor, 'Data query next cursor');
      if (candidate.hasMore !== Boolean(nextCursor)) {
        throw new TypeError(
          'Cursor data query page hasMore must match nextCursor',
        );
      }
      page = {
        kind,
        limit,
        hasMore: candidate.hasMore,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    }
  }
  if (page && rows.length > page.limit) {
    throw new TypeError('Data query rows exceed the declared page limit');
  }
  const freshness = plainObject(result.freshness, 'Data query freshness');
  exactKeys(freshness, ['state', 'asOf'], 'Data query freshness');
  const state = stringValue(freshness.state, 'Data query freshness state');
  if (state !== 'fresh' && state !== 'stale' && state !== 'unknown') {
    throw new TypeError('Data query freshness state is invalid');
  }
  if (
    !Array.isArray(result.warnings) ||
    result.warnings.length > MAX_SMRT_WEB_DATA_QUERY_WARNINGS ||
    result.warnings.some((item) => typeof item !== 'string')
  ) {
    throw new TypeError('Data query warnings must be strings');
  }
  if (typeof result.truncated !== 'boolean') {
    throw new TypeError('Data query truncated must be boolean');
  }
  const facets = normalizeFacets(result.facets, budget);
  const warnings = result.warnings.map((warning) =>
    stringValue(warning, 'Data query warning', 512),
  );
  const normalized: SmrtWebDataQueryResult = {
    version: 1,
    requestId: stringValue(result.requestId, 'Data query request id'),
    queryFingerprint: stringValue(
      result.queryFingerprint,
      'Data query fingerprint',
    ),
    identityField,
    rows,
    ...(page === undefined ? {} : { page }),
    total: normalizeTotal(result.total),
    ...(facets === undefined ? {} : { facets }),
    freshness: {
      state: state as SmrtWebDataQueryResult['freshness']['state'],
      ...(freshness.asOf === undefined
        ? {}
        : {
            asOf: stringValue(freshness.asOf, 'Data query freshness asOf', 128),
          }),
    },
    warnings: [...new Set(warnings)].sort(),
    truncated: result.truncated,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
  if (bytes > MAX_SMRT_WEB_DATA_QUERY_RESULT_BYTES) {
    throw new TypeError('Data query result exceeds the maximum byte limit');
  }
  return normalized;
}

/** Run a browser transport and return the defensive normalized envelope. */
export async function executeSmrtWebDataQuery(
  transport: SmrtWebDataQueryTransport,
  request: SmrtWebDataQueryRequest,
  options?: { signal?: AbortSignal },
): Promise<SmrtWebDataQueryResult> {
  const result = normalizeSmrtWebDataQueryResult(
    await transport.query(request, options),
  );
  if (result.requestId !== request.requestId) {
    throw new TypeError(
      'Data query result request id does not match its request',
    );
  }
  return result;
}
