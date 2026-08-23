/**
 * Canonical bounded data-query normalization (#2444).
 *
 * The shared package supplies only portable types. This server/runtime module
 * makes the contract executable at every trust boundary: it accepts only an
 * adapter-declared field/operator allowlist, canonicalizes equivalent
 * requests, creates a collision-resistant match fingerprint, and validates
 * that adapters return bounded, policy-filtered rows. It deliberately does
 * not execute SQL or resolve tenant/principal state; authenticated domain
 * adapters supply the schema and perform those responsibilities separately.
 */

import { createHash } from 'node:crypto';
import type {
  DataQueryCondition,
  DataQueryConsistency,
  DataQueryFacetRequest,
  DataQueryFacetResult,
  DataQueryFieldDescriptor,
  DataQueryFilter,
  DataQueryFilterOperator,
  DataQueryFreshness,
  DataQueryPage,
  DataQueryRequest,
  DataQueryResult,
  DataQueryRow,
  DataQueryScalar,
  DataQuerySchema,
  DataQuerySort,
  DataQueryTotal,
} from '@happyvertical/smrt-types';
import { ValidationError } from './errors';

/** Default and hard ceilings for normalized data-query input and output. */
export const DEFAULT_DATA_QUERY_PAGE_LIMIT = 50;
export const MAX_DATA_QUERY_PAGE_LIMIT = 1_000;
export const DEFAULT_DATA_QUERY_RESULT_BYTES = 1_000_000;
export const MAX_DATA_QUERY_RESULT_BYTES = 10_000_000;
export const MAX_DATA_QUERY_REQUEST_BYTES = 100_000;
export const MAX_DATA_QUERY_OFFSET = 1_000_000;
export const MAX_DATA_QUERY_FILTER_DEPTH = 8;
export const MAX_DATA_QUERY_FILTERS = 50;
export const MAX_DATA_QUERY_IN_VALUES = 100;
export const MAX_DATA_QUERY_FACETS = 20;
export const MAX_DATA_QUERY_WARNINGS = 100;
export const MAX_DATA_QUERY_CURSOR_LENGTH = 2_048;
export const MAX_DATA_QUERY_JSON_DEPTH = 16;
export const MAX_DATA_QUERY_JSON_CONTAINER_ITEMS = 1_000;
export const MAX_DATA_QUERY_JSON_STRING_LENGTH = 65_536;

const FILTER_OPERATORS = new Set<DataQueryFilterOperator>([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'like',
]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** A typed 400-class failure for malformed or policy-disallowed data queries. */
export class DataQueryValidationError extends ValidationError {
  readonly status = 400;
  readonly publicMessage: string;

  constructor(
    message: string,
    code = 'INVALID_DATA_QUERY',
    details?: Record<string, unknown>,
  ) {
    super(message, code, details);
    this.name = 'DataQueryValidationError';
    this.publicMessage = message;
  }
}

type JsonObject = Record<string, unknown>;

interface JsonBudget {
  remaining: number;
  failureCode: string;
}

const encoder = new TextEncoder();
const RFC_3339_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function fail(
  message: string,
  code = 'INVALID_DATA_QUERY',
  details?: Record<string, unknown>,
): never {
  throw new DataQueryValidationError(message, code, details);
}

function plainObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return fail(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(`${label} must be a plain object`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return fail(`${label} contains a forbidden key`, 'FORBIDDEN_DATA_QUERY');
    }
  }
  return value as JsonObject;
}

function exactKeys(
  object: JsonObject,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) {
      fail(
        `${label} contains unsupported key "${key}"`,
        'FORBIDDEN_DATA_QUERY',
      );
    }
  }
}

function stringValue(value: unknown, label: string, maxLength = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    return fail(
      `${label} must be a non-empty string up to ${maxLength} characters`,
    );
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const normalized = nonNegativeInteger(value, label);
  if (normalized === 0) return fail(`${label} must be a positive safe integer`);
  return normalized;
}

function normalizedInstant(value: unknown, label: string): string {
  const input = stringValue(value, label, 128);
  const match = RFC_3339_INSTANT.exec(input);
  if (!match) return fail(`${label} must be an RFC 3339 instant`);
  const [year, month, day] = match.slice(1, 4).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(0, 0, 0, 0);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return fail(`${label} must be an RFC 3339 instant`);
  }
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds)) {
    return fail(`${label} must be an RFC 3339 instant`);
  }
  return new Date(milliseconds).toISOString();
}

function dataQueryScalar(value: unknown, label: string): DataQueryScalar {
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 4_096) {
      return fail(`${label} cannot exceed 4096 characters`);
    }
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail(`${label} must be a JSON scalar`);
}

function consumeJsonSegment(
  budget: JsonBudget | undefined,
  text: string,
  label: string,
): void {
  if (!budget) return;
  if (text.length > budget.remaining) {
    fail(`${label} exceeds the maximum byte limit`, budget.failureCode);
  }
  const bytes = encoder.encode(text).byteLength;
  if (bytes > budget.remaining) {
    fail(`${label} exceeds the maximum byte limit`, budget.failureCode);
  }
  budget.remaining -= bytes;
}

function canonicalJson(
  value: unknown,
  label = 'Data query JSON',
  budget?: JsonBudget,
  depth = 0,
  ancestors = new Set<object>(),
): unknown {
  if (depth > MAX_DATA_QUERY_JSON_DEPTH) {
    return fail(`${label} exceeds the JSON depth limit`);
  }
  if (value === null || typeof value === 'boolean') {
    consumeJsonSegment(budget, JSON.stringify(value), label);
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > MAX_DATA_QUERY_JSON_STRING_LENGTH) {
      return fail(`${label} exceeds the JSON string limit`);
    }
    consumeJsonSegment(budget, JSON.stringify(value), label);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      return fail(`${label} cannot contain a non-finite number`);
    const normalized = value === 0 ? 0 : value;
    consumeJsonSegment(budget, JSON.stringify(normalized), label);
    return normalized;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_DATA_QUERY_JSON_CONTAINER_ITEMS) {
      return fail(`${label} exceeds the JSON container-item limit`);
    }
    if (ancestors.has(value)) return fail(`${label} cannot contain a cycle`);
    ancestors.add(value);
    try {
      const result: unknown[] = [];
      consumeJsonSegment(budget, '[', label);
      for (const [index, entry] of value.entries()) {
        if (index > 0) consumeJsonSegment(budget, ',', label);
        result.push(
          canonicalJson(
            entry,
            `${label}[${index}]`,
            budget,
            depth + 1,
            ancestors,
          ),
        );
      }
      consumeJsonSegment(budget, ']', label);
      return result;
    } finally {
      ancestors.delete(value);
    }
  }
  const object = plainObject(value, label);
  const keys = Object.keys(object).sort(compareCanonicalStrings);
  if (keys.length > MAX_DATA_QUERY_JSON_CONTAINER_ITEMS) {
    return fail(`${label} exceeds the JSON container-item limit`);
  }
  if (ancestors.has(object)) return fail(`${label} cannot contain a cycle`);
  ancestors.add(object);
  try {
    const result: JsonObject = Object.create(null) as JsonObject;
    consumeJsonSegment(budget, '{', label);
    for (const [index, key] of keys.entries()) {
      if (key.length > MAX_DATA_QUERY_JSON_STRING_LENGTH) {
        return fail(`${label}.${key} exceeds the JSON string limit`);
      }
      if (index > 0) consumeJsonSegment(budget, ',', label);
      consumeJsonSegment(budget, JSON.stringify(key), `${label}.${key}`);
      consumeJsonSegment(budget, ':', label);
      Object.defineProperty(result, key, {
        value: canonicalJson(
          object[key],
          `${label}.${key}`,
          budget,
          depth + 1,
          ancestors,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    consumeJsonSegment(budget, '}', label);
    return result;
  } finally {
    ancestors.delete(object);
  }
}

function signature(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

/** Reject an over-limit raw request before canonicalization can collapse it. */
function assertBoundedRawRequest(value: unknown): void {
  const budget: JsonBudget = {
    remaining: MAX_DATA_QUERY_REQUEST_BYTES,
    failureCode: 'DATA_QUERY_REQUEST_TOO_LARGE',
  };
  const ancestors = new Set<object>();

  const measure = (candidate: unknown, label: string, depth = 0): void => {
    if (depth > MAX_DATA_QUERY_JSON_DEPTH) {
      fail(`${label} exceeds the JSON depth limit`);
    }
    if (candidate === null || typeof candidate === 'boolean') {
      consumeJsonSegment(budget, JSON.stringify(candidate), label);
      return;
    }
    if (typeof candidate === 'string') {
      consumeJsonSegment(budget, JSON.stringify(candidate), label);
      return;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        fail(`${label} cannot contain a non-finite number`);
      }
      consumeJsonSegment(
        budget,
        JSON.stringify(candidate === 0 ? 0 : candidate),
        label,
      );
      return;
    }
    if (Array.isArray(candidate)) {
      if (ancestors.has(candidate)) fail(`${label} cannot contain a cycle`);
      ancestors.add(candidate);
      try {
        consumeJsonSegment(budget, '[', label);
        for (const [index, entry] of candidate.entries()) {
          if (index > 0) consumeJsonSegment(budget, ',', label);
          measure(entry, `${label}[${index}]`, depth + 1);
        }
        consumeJsonSegment(budget, ']', label);
      } finally {
        ancestors.delete(candidate);
      }
      return;
    }
    const object = plainObject(candidate, label);
    if (ancestors.has(object)) fail(`${label} cannot contain a cycle`);
    ancestors.add(object);
    try {
      consumeJsonSegment(budget, '{', label);
      for (const [index, key] of Object.keys(object).entries()) {
        if (index > 0) consumeJsonSegment(budget, ',', label);
        consumeJsonSegment(budget, JSON.stringify(key), `${label}.${key}`);
        consumeJsonSegment(budget, ':', label);
        measure(object[key], `${label}.${key}`, depth + 1);
      }
      consumeJsonSegment(budget, '}', label);
    } finally {
      ancestors.delete(object);
    }
  };

  measure(value, 'Data query request');
}

/** Locale-independent ordering for canonical envelopes and fingerprints. */
function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeFieldDescriptor(value: unknown): DataQueryFieldDescriptor {
  const object = plainObject(value, 'Data query schema field');
  exactKeys(
    object,
    ['id', 'type', 'projectable', 'sortable', 'facetable', 'filterOperators'],
    'Data query schema field',
  );
  const id = stringValue(object.id, 'Data query field id');
  const type = stringValue(object.type, `Data query field ${id} type`);
  if (!['string', 'number', 'boolean', 'datetime', 'json'].includes(type)) {
    return fail(`Unsupported data query field type: ${type}`);
  }
  for (const flag of ['projectable', 'sortable', 'facetable'] as const) {
    if (object[flag] !== undefined && typeof object[flag] !== 'boolean') {
      fail(`Data query field ${id} ${flag} must be boolean`);
    }
  }
  let filterOperators: DataQueryFilterOperator[] | undefined;
  if (object.filterOperators !== undefined) {
    if (!Array.isArray(object.filterOperators)) {
      return fail(`Data query field ${id} filterOperators must be an array`);
    }
    filterOperators = [
      ...new Set(
        object.filterOperators.map((operator) => {
          const normalized = stringValue(
            operator,
            `Data query field ${id} filter operator`,
          ) as DataQueryFilterOperator;
          if (!FILTER_OPERATORS.has(normalized)) {
            fail(`Unsupported data query filter operator: ${normalized}`);
          }
          return normalized;
        }),
      ),
    ].sort();
  }
  const projectable =
    typeof object.projectable === 'boolean' ? object.projectable : undefined;
  const sortable =
    typeof object.sortable === 'boolean' ? object.sortable : undefined;
  const facetable =
    typeof object.facetable === 'boolean' ? object.facetable : undefined;
  return {
    id,
    type: type as DataQueryFieldDescriptor['type'],
    ...(projectable === undefined ? {} : { projectable }),
    ...(sortable === undefined ? {} : { sortable }),
    ...(facetable === undefined ? {} : { facetable }),
    ...(filterOperators ? { filterOperators } : {}),
  };
}

/** Validate and canonicalize trusted adapter query policy before use. */
export function normalizeDataQuerySchema(value: unknown): DataQuerySchema {
  const object = plainObject(value, 'Data query schema');
  exactKeys(
    object,
    [
      'version',
      'identityField',
      'fields',
      'defaultPageLimit',
      'maxPageLimit',
      'maxResultBytes',
      'defaultSort',
      'supports',
    ],
    'Data query schema',
  );
  if (object.version !== 1)
    return fail('Unsupported data query schema version');
  if (!Array.isArray(object.fields) || object.fields.length === 0) {
    return fail('Data query schema fields must be a non-empty array');
  }
  const fields = object.fields
    .map(normalizeFieldDescriptor)
    .sort((left, right) => compareCanonicalStrings(left.id, right.id));
  if (new Set(fields.map((field) => field.id)).size !== fields.length) {
    return fail('Data query schema field ids must be unique');
  }
  const identityField = stringValue(
    object.identityField,
    'Data query identity field',
  );
  const identity = fields.find((field) => field.id === identityField);
  if (!identity) return fail('Data query identity field must be declared');
  if (identity.projectable === false) {
    return fail('Data query identity field must be projectable');
  }
  if (!['string', 'number', 'datetime'].includes(identity.type)) {
    return fail(
      'Data query identity field must use a string, number, or datetime type',
    );
  }
  const maxPageLimit =
    object.maxPageLimit === undefined
      ? MAX_DATA_QUERY_PAGE_LIMIT
      : positiveInteger(object.maxPageLimit, 'Data query maximum page limit');
  if (maxPageLimit > MAX_DATA_QUERY_PAGE_LIMIT) {
    return fail(
      `Data query maximum page limit cannot exceed ${MAX_DATA_QUERY_PAGE_LIMIT}`,
    );
  }
  const defaultPageLimit =
    object.defaultPageLimit === undefined
      ? Math.min(DEFAULT_DATA_QUERY_PAGE_LIMIT, maxPageLimit)
      : positiveInteger(
          object.defaultPageLimit,
          'Data query default page limit',
        );
  if (defaultPageLimit > maxPageLimit) {
    return fail(
      'Data query default page limit cannot exceed the maximum page limit',
    );
  }
  const maxResultBytes =
    object.maxResultBytes === undefined
      ? DEFAULT_DATA_QUERY_RESULT_BYTES
      : positiveInteger(
          object.maxResultBytes,
          'Data query maximum result bytes',
        );
  if (maxResultBytes > MAX_DATA_QUERY_RESULT_BYTES) {
    return fail(
      `Data query maximum result bytes cannot exceed ${MAX_DATA_QUERY_RESULT_BYTES}`,
    );
  }
  let supports: DataQuerySchema['supports'];
  if (object.supports !== undefined) {
    const supportObject = plainObject(
      object.supports,
      'Data query schema supports',
    );
    exactKeys(
      supportObject,
      ['cursorPagination', 'consistency', 'facets'],
      'Data query schema supports',
    );
    for (const key of ['cursorPagination', 'consistency', 'facets'] as const) {
      if (
        supportObject[key] !== undefined &&
        typeof supportObject[key] !== 'boolean'
      ) {
        fail(`Data query schema supports.${key} must be boolean`);
      }
    }
    const cursorPagination =
      typeof supportObject.cursorPagination === 'boolean'
        ? supportObject.cursorPagination
        : undefined;
    const consistency =
      typeof supportObject.consistency === 'boolean'
        ? supportObject.consistency
        : undefined;
    const facets =
      typeof supportObject.facets === 'boolean'
        ? supportObject.facets
        : undefined;
    supports = {
      ...(cursorPagination === undefined ? {} : { cursorPagination }),
      ...(consistency === undefined ? {} : { consistency }),
      ...(facets === undefined ? {} : { facets }),
    };
  }
  const fieldMap = new Map(fields.map((field) => [field.id, field]));
  const defaultSort = normalizeSort(
    object.defaultSort,
    fieldMap,
    identityField,
    'Data query default sort',
    false,
  );
  return {
    version: 1,
    identityField,
    fields,
    defaultPageLimit,
    maxPageLimit,
    maxResultBytes,
    ...(defaultSort.length > 0 ? { defaultSort } : {}),
    ...(supports ? { supports } : {}),
  };
}

interface FilterBudget {
  nodes: number;
}

function scalarForField(
  value: unknown,
  descriptor: DataQueryFieldDescriptor,
  label: string,
): DataQueryScalar {
  const scalar = dataQueryScalar(value, label);
  if (scalar === null) return scalar;
  if (descriptor.type === 'number' && typeof scalar !== 'number') {
    return fail(`${label} must be a number for ${descriptor.id}`);
  }
  if (descriptor.type === 'boolean' && typeof scalar !== 'boolean') {
    return fail(`${label} must be a boolean for ${descriptor.id}`);
  }
  if (descriptor.type === 'string' && typeof scalar !== 'string') {
    return fail(`${label} must be a string for ${descriptor.id}`);
  }
  if (descriptor.type === 'datetime') {
    if (typeof scalar !== 'string') {
      return fail(`${label} must be an RFC 3339 instant for ${descriptor.id}`);
    }
    return normalizedInstant(scalar, label);
  }
  return scalar;
}

function normalizeFilter(
  value: unknown,
  fields: Map<string, DataQueryFieldDescriptor>,
  depth = 0,
  budget: FilterBudget = { nodes: 0 },
): DataQueryFilter {
  if (depth > MAX_DATA_QUERY_FILTER_DEPTH) {
    return fail(
      `Data query filter cannot exceed depth ${MAX_DATA_QUERY_FILTER_DEPTH}`,
    );
  }
  budget.nodes += 1;
  if (budget.nodes > MAX_DATA_QUERY_FILTERS) {
    return fail(
      `Data query filter cannot exceed ${MAX_DATA_QUERY_FILTERS} expressions`,
    );
  }
  const object = plainObject(value, 'Data query filter');
  const kind = stringValue(object.kind, 'Data query filter kind');
  if (kind === 'condition') {
    exactKeys(
      object,
      ['kind', 'field', 'operator', 'value'],
      'Data query condition',
    );
    const field = stringValue(object.field, 'Data query condition field');
    const descriptor = fields.get(field);
    if (!descriptor)
      return fail(
        `Data query field is not declared: ${field}`,
        'DATA_QUERY_FIELD_NOT_ALLOWED',
      );
    const operator = stringValue(
      object.operator,
      'Data query condition operator',
    ) as DataQueryFilterOperator;
    if (
      !FILTER_OPERATORS.has(operator) ||
      !descriptor.filterOperators?.includes(operator)
    ) {
      return fail(
        `Data query operator ${operator} is not allowed for ${field}`,
        'DATA_QUERY_OPERATOR_NOT_ALLOWED',
      );
    }
    if (operator === 'in' || operator === 'notIn') {
      if (!Array.isArray(object.value) || object.value.length === 0) {
        return fail(`Data query ${operator} value must be a non-empty array`);
      }
      if (object.value.length > MAX_DATA_QUERY_IN_VALUES) {
        return fail(
          `Data query ${operator} value cannot exceed ${MAX_DATA_QUERY_IN_VALUES} items`,
        );
      }
      const values = object.value.map((entry, index) =>
        scalarForField(
          entry,
          descriptor,
          `Data query ${operator} value ${index}`,
        ),
      );
      const canonicalValues = [
        ...new Map(values.map((entry) => [signature(entry), entry])).values(),
      ].sort((left, right) =>
        compareCanonicalStrings(signature(left), signature(right)),
      );
      return { kind: 'condition', field, operator, value: canonicalValues };
    }
    if (Array.isArray(object.value)) {
      return fail(`Data query ${operator} value must be a scalar`);
    }
    const scalar = scalarForField(
      object.value,
      descriptor,
      `Data query ${operator} value`,
    );
    if (operator === 'like' && descriptor.type !== 'string') {
      return fail('Data query like is only available for string fields');
    }
    if (operator === 'like' && typeof scalar !== 'string') {
      return fail('Data query like value must be a string');
    }
    if (
      ['gt', 'gte', 'lt', 'lte'].includes(operator) &&
      !['number', 'string', 'datetime'].includes(descriptor.type)
    ) {
      return fail(
        `Data query ${operator} is not available for ${descriptor.type} fields`,
      );
    }
    if (
      ['gt', 'gte', 'lt', 'lte', 'like'].includes(operator) &&
      scalar === null
    ) {
      return fail(`Data query ${operator} value cannot be null`);
    }
    return {
      kind: 'condition',
      field,
      operator,
      value: scalar,
    } as DataQueryCondition;
  }
  if (kind === 'all' || kind === 'any') {
    exactKeys(object, ['kind', 'filters'], `Data query ${kind} filter`);
    if (!Array.isArray(object.filters) || object.filters.length === 0) {
      return fail(`Data query ${kind} filter must contain at least one child`);
    }
    if (object.filters.length > MAX_DATA_QUERY_FILTERS) {
      return fail(
        `Data query ${kind} filter cannot exceed ${MAX_DATA_QUERY_FILTERS} children`,
      );
    }
    const filters = object.filters
      .map((filter) => normalizeFilter(filter, fields, depth + 1, budget))
      .sort((left, right) =>
        compareCanonicalStrings(signature(left), signature(right)),
      );
    return { kind, filters };
  }
  if (kind === 'not') {
    exactKeys(object, ['kind', 'filter'], 'Data query not filter');
    return {
      kind: 'not',
      filter: normalizeFilter(object.filter, fields, depth + 1, budget),
    };
  }
  return fail(`Unsupported data query filter kind: ${kind}`);
}

function normalizeSort(
  value: unknown,
  fields: Map<string, DataQueryFieldDescriptor>,
  identityField: string,
  label: string,
  appendIdentity: boolean,
): DataQuerySort[] {
  if (value === undefined)
    return appendIdentity ? [{ field: identityField, direction: 'asc' }] : [];
  if (!Array.isArray(value)) return fail(`${label} must be an array`);
  if (value.length > MAX_DATA_QUERY_FILTERS) {
    return fail(`${label} cannot exceed ${MAX_DATA_QUERY_FILTERS} terms`);
  }
  const sort = value.map((entry) => {
    const object = plainObject(entry, label);
    exactKeys(object, ['field', 'direction'], label);
    const field = stringValue(object.field, `${label} field`);
    if (!fields.get(field)?.sortable && field !== identityField) {
      fail(
        `Data query sort field is not allowed: ${field}`,
        'DATA_QUERY_SORT_NOT_ALLOWED',
      );
    }
    const direction = stringValue(object.direction, `${label} direction`);
    if (direction !== 'asc' && direction !== 'desc') {
      fail(`Data query sort direction must be asc or desc`);
    }
    return { field, direction } as DataQuerySort;
  });
  if (new Set(sort.map((term) => term.field)).size !== sort.length) {
    return fail(`${label} field ids must be unique`);
  }
  if (appendIdentity && !sort.some((term) => term.field === identityField)) {
    sort.push({ field: identityField, direction: 'asc' });
  }
  return sort;
}

function normalizePage(value: unknown, schema: DataQuerySchema): DataQueryPage {
  if (value === undefined) {
    return {
      kind: 'offset',
      offset: 0,
      limit: schema.defaultPageLimit ?? DEFAULT_DATA_QUERY_PAGE_LIMIT,
    };
  }
  const object = plainObject(value, 'Data query page');
  const kind = stringValue(object.kind, 'Data query page kind');
  if (kind === 'offset') {
    exactKeys(object, ['kind', 'offset', 'limit'], 'Data query offset page');
    const offset = nonNegativeInteger(object.offset, 'Data query offset');
    if (offset > MAX_DATA_QUERY_OFFSET) {
      return fail(`Data query offset cannot exceed ${MAX_DATA_QUERY_OFFSET}`);
    }
    return {
      kind,
      offset,
      limit: Math.min(
        positiveInteger(object.limit, 'Data query page limit'),
        schema.maxPageLimit ?? MAX_DATA_QUERY_PAGE_LIMIT,
      ),
    };
  }
  if (kind === 'cursor') {
    if (!schema.supports?.cursorPagination) {
      return fail(
        'Data query cursor pagination is not supported',
        'DATA_QUERY_UNSUPPORTED',
      );
    }
    exactKeys(object, ['kind', 'after', 'limit'], 'Data query cursor page');
    const after =
      object.after === undefined
        ? undefined
        : stringValue(
            object.after,
            'Data query cursor',
            MAX_DATA_QUERY_CURSOR_LENGTH,
          );
    return {
      kind,
      ...(after === undefined ? {} : { after }),
      limit: Math.min(
        positiveInteger(object.limit, 'Data query page limit'),
        schema.maxPageLimit ?? MAX_DATA_QUERY_PAGE_LIMIT,
      ),
    };
  }
  return fail(`Unsupported data query page kind: ${kind}`);
}

function normalizeConsistency(
  value: unknown,
  schema: DataQuerySchema,
): DataQueryConsistency | undefined {
  if (value === undefined) return undefined;
  if (!schema.supports?.consistency) {
    return fail(
      'Data query consistency options are not supported',
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  const object = plainObject(value, 'Data query consistency');
  exactKeys(object, ['mode', 'asOf'], 'Data query consistency');
  if (object.mode !== 'eventual' && object.mode !== 'snapshot')
    return fail('Unsupported data query consistency mode');
  const asOf =
    object.asOf === undefined
      ? undefined
      : normalizedInstant(object.asOf, 'Data query consistency asOf');
  return {
    mode: object.mode,
    ...(asOf === undefined ? {} : { asOf }),
  } as DataQueryConsistency;
}

function normalizeFacets(
  value: unknown,
  schema: DataQuerySchema,
  fields: Map<string, DataQueryFieldDescriptor>,
): DataQueryFacetRequest[] {
  if (!schema.supports?.facets) {
    return fail(
      'Data query facets are not supported',
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  if (!Array.isArray(value) || value.length === 0) {
    return fail('Data query facets must be a non-empty array');
  }
  if (value.length > MAX_DATA_QUERY_FACETS) {
    return fail(`Data query facets cannot exceed ${MAX_DATA_QUERY_FACETS}`);
  }
  const facets = value.map((entry) => {
    const object = plainObject(entry, 'Data query facet request');
    exactKeys(object, ['field', 'limit'], 'Data query facet request');
    const field = stringValue(object.field, 'Data query facet field');
    if (!fields.get(field)?.facetable) {
      fail(
        `Data query facet field is not allowed: ${field}`,
        'DATA_QUERY_FACET_NOT_ALLOWED',
      );
    }
    return {
      field,
      limit: Math.min(
        positiveInteger(object.limit, 'Data query facet limit'),
        schema.maxPageLimit ?? MAX_DATA_QUERY_PAGE_LIMIT,
      ),
    };
  });
  if (new Set(facets.map((facet) => facet.field)).size !== facets.length) {
    return fail('Data query facet fields must be unique');
  }
  return facets.sort((left, right) =>
    compareCanonicalStrings(left.field, right.field),
  );
}

function boundRequestSize(request: DataQueryRequest): DataQueryRequest {
  const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  if (bytes > MAX_DATA_QUERY_REQUEST_BYTES) {
    return fail(
      'Data query request exceeds its maximum byte limit',
      'DATA_QUERY_REQUEST_TOO_LARGE',
    );
  }
  return request;
}

/**
 * Normalize an untrusted request against its trusted adapter schema. Equivalent
 * projection/filter/facet orderings produce byte-identical output; sort order
 * remains intact because it is semantically meaningful. The identity field is
 * always projected even when a caller omits it.
 */
export function normalizeDataQueryRequest(
  value: unknown,
  inputSchema: unknown,
): DataQueryRequest {
  const schema = normalizeDataQuerySchema(inputSchema);
  const fields = new Map(schema.fields.map((field) => [field.id, field]));
  const object = plainObject(value, 'Data query request');
  assertBoundedRawRequest(value);
  exactKeys(
    object,
    [
      'version',
      'requestId',
      'mode',
      'projection',
      'filter',
      'sort',
      'page',
      'consistency',
      'facets',
    ],
    'Data query request',
  );
  if (object.version !== 1)
    return fail('Unsupported data query request version');
  const requestId = stringValue(object.requestId, 'Data query request id', 128);
  const mode = stringValue(object.mode, 'Data query mode');
  if (!['rows', 'count', 'facets'].includes(mode))
    return fail(`Unsupported data query mode: ${mode}`);
  const filter =
    object.filter === undefined
      ? undefined
      : normalizeFilter(object.filter, fields);
  const consistency = normalizeConsistency(object.consistency, schema);
  if (mode === 'rows') {
    if (object.facets !== undefined)
      return fail('Rows queries cannot request facets');
    if (object.projection !== undefined && !Array.isArray(object.projection)) {
      return fail('Data query projection must be an array');
    }
    if (
      Array.isArray(object.projection) &&
      object.projection.length > MAX_DATA_QUERY_FILTERS
    ) {
      return fail(
        `Data query projection cannot exceed ${MAX_DATA_QUERY_FILTERS} fields`,
      );
    }
    const requestedProjection = (object.projection ?? []).map((field) =>
      stringValue(field, 'Data query projection field'),
    );
    for (const field of requestedProjection) {
      if (!fields.get(field)?.projectable && field !== schema.identityField) {
        fail(
          `Data query projection field is not allowed: ${field}`,
          'DATA_QUERY_PROJECTION_NOT_ALLOWED',
        );
      }
    }
    const projection = [
      ...new Set([...requestedProjection, schema.identityField]),
    ].sort();
    const sort = normalizeSort(
      object.sort === undefined ? schema.defaultSort : object.sort,
      fields,
      schema.identityField,
      'Data query sort',
      true,
    );
    return boundRequestSize({
      version: 1,
      requestId,
      mode,
      projection,
      ...(filter === undefined ? {} : { filter }),
      sort,
      page: normalizePage(object.page, schema),
      ...(consistency === undefined ? {} : { consistency }),
    });
  }
  if (
    object.projection !== undefined ||
    object.sort !== undefined ||
    object.page !== undefined
  ) {
    return fail(`${mode} data queries cannot carry projection, sort, or page`);
  }
  if (mode === 'facets') {
    return boundRequestSize({
      version: 1,
      requestId,
      mode,
      ...(filter === undefined ? {} : { filter }),
      ...(consistency === undefined ? {} : { consistency }),
      facets: normalizeFacets(object.facets, schema, fields),
    });
  }
  if (object.facets !== undefined)
    return fail('Count data queries cannot request facets');
  return boundRequestSize({
    version: 1,
    requestId,
    mode: 'count',
    ...(filter === undefined ? {} : { filter }),
    ...(consistency === undefined ? {} : { consistency }),
  });
}

/** Canonical match/query form used for stable fingerprints (no request id/page). */
export function canonicalizeDataQuery(value: unknown, schema: unknown): string {
  const request = normalizeDataQueryRequest(value, schema);
  const { requestId: _requestId, page: _page, ...semanticQuery } = request;
  return signature(semanticQuery);
}

/** Collision-resistant canonical fingerprint for result correlation and selection scope. */
export function createDataQueryFingerprint(
  value: unknown,
  schema: unknown,
): string {
  return `dq1_${createHash('sha256').update(canonicalizeDataQuery(value, schema)).digest('base64url')}`;
}

function normalizeResultFieldValue(
  value: unknown,
  descriptor: DataQueryFieldDescriptor,
  label: string,
  budget: JsonBudget,
): unknown {
  if (descriptor.type === 'json') return canonicalJson(value, label, budget);
  const normalized = scalarForField(value, descriptor, label);
  consumeJsonSegment(budget, JSON.stringify(normalized), label);
  return normalized;
}

function normalizeRow(
  value: unknown,
  projection: readonly string[],
  identityField: string,
  fields: Map<string, DataQueryFieldDescriptor>,
  budget: JsonBudget,
): DataQueryRow {
  const object = plainObject(value, 'Data query row');
  const allowed = new Set(projection);
  const normalized: JsonObject = Object.create(null) as JsonObject;
  consumeJsonSegment(budget, '{', 'Data query row');
  for (const [index, key] of Object.keys(object).entries()) {
    if (!allowed.has(key)) {
      fail(
        `Data query row returned a non-projected field: ${key}`,
        'DATA_QUERY_RESULT_NOT_ALLOWED',
      );
    }
    const descriptor = fields.get(key);
    if (!descriptor) {
      return fail(
        `Data query row returned an undeclared field: ${key}`,
        'DATA_QUERY_RESULT_NOT_ALLOWED',
      );
    }
    if (index > 0) consumeJsonSegment(budget, ',', 'Data query row');
    consumeJsonSegment(budget, JSON.stringify(key), `Data query row ${key}`);
    consumeJsonSegment(budget, ':', `Data query row ${key}`);
    normalized[key] = normalizeResultFieldValue(
      object[key],
      descriptor,
      `Data query row ${key}`,
      budget,
    );
  }
  consumeJsonSegment(budget, '}', 'Data query row');
  const identity = normalized[identityField];
  if (
    (typeof identity !== 'string' && typeof identity !== 'number') ||
    identity === ''
  ) {
    fail(
      'Data query row must return a string or number identity field',
      'DATA_QUERY_RESULT_INVALID',
    );
  }
  return normalized as DataQueryRow;
}

function normalizeTotal(value: unknown): DataQueryTotal {
  const object = plainObject(value, 'Data query total');
  const kind = stringValue(object.kind, 'Data query total kind');
  if (kind === 'unavailable') {
    exactKeys(object, ['kind', 'reason'], 'Data query unavailable total');
    const reason =
      object.reason === undefined
        ? undefined
        : stringValue(object.reason, 'Data query total reason');
    return { kind, ...(reason === undefined ? {} : { reason }) };
  }
  if (kind !== 'exact' && kind !== 'estimated') {
    return fail(`Unsupported data query total kind: ${kind}`);
  }
  exactKeys(object, ['kind', 'value', 'asOf'], 'Data query total');
  const asOf =
    object.asOf === undefined
      ? undefined
      : normalizedInstant(object.asOf, 'Data query total asOf');
  return {
    kind,
    value: nonNegativeInteger(object.value, 'Data query total value'),
    ...(asOf === undefined ? {} : { asOf }),
  };
}

function normalizeFreshness(value: unknown): DataQueryFreshness {
  const object = plainObject(value, 'Data query freshness');
  exactKeys(object, ['state', 'asOf'], 'Data query freshness');
  const state = stringValue(object.state, 'Data query freshness state');
  if (!['fresh', 'stale', 'unknown'].includes(state)) {
    return fail(`Unsupported data query freshness state: ${state}`);
  }
  const asOf =
    object.asOf === undefined
      ? undefined
      : normalizedInstant(object.asOf, 'Data query freshness asOf');
  return {
    state: state as DataQueryFreshness['state'],
    ...(asOf === undefined ? {} : { asOf }),
  };
}

function normalizeFacetsResult(
  value: unknown,
  requested: readonly DataQueryFacetRequest[],
  fields: Map<string, DataQueryFieldDescriptor>,
  budget: JsonBudget,
): DataQueryFacetResult[] {
  if (!Array.isArray(value))
    return fail('Data query result facets must be an array');
  if (value.length > requested.length) {
    return fail('Data query result returned too many facets');
  }
  const limits = new Map(requested.map((facet) => [facet.field, facet.limit]));
  consumeJsonSegment(budget, '[', 'Data query result facets');
  const results = value.map((entry, index) => {
    if (index > 0) consumeJsonSegment(budget, ',', 'Data query result facets');
    const object = plainObject(entry, 'Data query facet result');
    exactKeys(
      object,
      ['field', 'values', 'truncated'],
      'Data query facet result',
    );
    const field = stringValue(object.field, 'Data query facet result field');
    const limit = limits.get(field);
    if (limit === undefined)
      return fail(`Data query returned an unrequested facet: ${field}`);
    if (!Array.isArray(object.values) || object.values.length > limit) {
      return fail(`Data query facet ${field} exceeds its requested limit`);
    }
    if (typeof object.truncated !== 'boolean')
      return fail('Data query facet truncated must be boolean');
    const descriptor = fields.get(field);
    if (!descriptor)
      return fail(`Data query facet field is not declared: ${field}`);
    consumeJsonSegment(budget, '{"field":', `Data query facet ${field}`);
    consumeJsonSegment(
      budget,
      JSON.stringify(field),
      `Data query facet ${field}`,
    );
    consumeJsonSegment(budget, ',"values":[', `Data query facet ${field}`);
    const values = object.values.map((candidate, valueIndex) => {
      if (valueIndex > 0)
        consumeJsonSegment(budget, ',', `Data query facet ${field}`);
      const facet = plainObject(candidate, 'Data query facet value');
      exactKeys(facet, ['value', 'count'], 'Data query facet value');
      const normalizedValue = scalarForField(
        facet.value,
        descriptor,
        `Data query facet ${field} value`,
      );
      const count = nonNegativeInteger(facet.count, 'Data query facet count');
      consumeJsonSegment(
        budget,
        `{"value":${JSON.stringify(normalizedValue)},"count":${JSON.stringify(count)}}`,
        `Data query facet ${field} value`,
      );
      return {
        value: normalizedValue,
        count,
      };
    });
    consumeJsonSegment(
      budget,
      `],"truncated":${object.truncated}}`,
      `Data query facet ${field}`,
    );
    return { field, values, truncated: object.truncated };
  });
  consumeJsonSegment(budget, ']', 'Data query result facets');
  if (new Set(results.map((facet) => facet.field)).size !== results.length) {
    return fail('Data query result facet fields must be unique');
  }
  return results.sort((left, right) =>
    compareCanonicalStrings(left.field, right.field),
  );
}

/**
 * Validate an adapter result against the normalized request and its schema.
 * This is the final projection boundary: undeclared fields, malformed totals,
 * forged fingerprints, oversized rows, and authority-shaped prototype payloads
 * cannot cross into REST, MCP, WebMCP, or browser consumers unnoticed.
 */
export function normalizeDataQueryResult(
  value: unknown,
  inputRequest: unknown,
  inputSchema: unknown,
): DataQueryResult {
  const schema = normalizeDataQuerySchema(inputSchema);
  const request = normalizeDataQueryRequest(inputRequest, schema);
  const fields = new Map(schema.fields.map((field) => [field.id, field]));
  const object = plainObject(value, 'Data query result');
  exactKeys(
    object,
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
  if (object.version !== 1)
    return fail('Unsupported data query result version');
  if (
    stringValue(object.requestId, 'Data query result request id', 128) !==
    request.requestId
  ) {
    return fail(
      'Data query result request id does not match its request',
      'DATA_QUERY_RESULT_INVALID',
    );
  }
  const fingerprint = createDataQueryFingerprint(request, schema);
  if (
    stringValue(
      object.queryFingerprint,
      'Data query result fingerprint',
      128,
    ) !== fingerprint
  ) {
    return fail(
      'Data query result fingerprint does not match its request',
      'DATA_QUERY_RESULT_INVALID',
    );
  }
  if (
    stringValue(object.identityField, 'Data query result identity field') !==
    schema.identityField
  ) {
    return fail(
      'Data query result identity field does not match its schema',
      'DATA_QUERY_RESULT_INVALID',
    );
  }
  if (!Array.isArray(object.rows))
    return fail('Data query result rows must be an array');
  const projection =
    request.mode === 'rows'
      ? (request.projection ?? [schema.identityField])
      : [];
  const page = request.mode === 'rows' ? request.page : undefined;
  if (request.mode !== 'rows' && object.rows.length > 0) {
    return fail(`${request.mode} data query results cannot return rows`);
  }
  if (page && object.rows.length > page.limit) {
    return fail('Data query result rows exceed its requested page limit');
  }
  const budget: JsonBudget = {
    remaining: schema.maxResultBytes ?? DEFAULT_DATA_QUERY_RESULT_BYTES,
    failureCode: 'DATA_QUERY_RESULT_TOO_LARGE',
  };
  consumeJsonSegment(budget, '[', 'Data query result rows');
  const rows = object.rows.map((row, index) => {
    if (index > 0) consumeJsonSegment(budget, ',', 'Data query result rows');
    return normalizeRow(row, projection, schema.identityField, fields, budget);
  });
  consumeJsonSegment(budget, ']', 'Data query result rows');
  let normalizedPage: DataQueryResult['page'];
  if (page) {
    const pageObject = plainObject(object.page, 'Data query result page');
    exactKeys(
      pageObject,
      ['kind', 'limit', 'offset', 'nextCursor', 'hasMore'],
      'Data query result page',
    );
    if (
      pageObject.kind !== page.kind ||
      nonNegativeInteger(pageObject.limit, 'Data query result page limit') !==
        page.limit
    ) {
      return fail('Data query result page does not match its request');
    }
    if (typeof pageObject.hasMore !== 'boolean')
      return fail('Data query result page hasMore must be boolean');
    if (page.kind === 'offset') {
      if (
        nonNegativeInteger(pageObject.offset, 'Data query result offset') !==
        page.offset
      ) {
        return fail('Data query result offset does not match its request');
      }
      if (pageObject.nextCursor !== undefined)
        return fail('Offset data query results cannot return a cursor');
      normalizedPage = {
        kind: 'offset',
        limit: page.limit,
        offset: page.offset,
        hasMore: pageObject.hasMore,
      };
    } else {
      if (pageObject.offset !== undefined) {
        return fail('Cursor data query results cannot return an offset');
      }
      const nextCursor =
        pageObject.nextCursor === undefined
          ? undefined
          : stringValue(
              pageObject.nextCursor,
              'Data query result next cursor',
              MAX_DATA_QUERY_CURSOR_LENGTH,
            );
      if (pageObject.hasMore !== Boolean(nextCursor)) {
        return fail('Data query cursor result hasMore must match nextCursor');
      }
      normalizedPage = {
        kind: 'cursor',
        limit: page.limit,
        hasMore: pageObject.hasMore,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    }
  } else if (object.page !== undefined) {
    return fail(`${request.mode} data query results cannot return a page`);
  }
  const total = normalizeTotal(object.total);
  const freshness = normalizeFreshness(object.freshness);
  if (
    !Array.isArray(object.warnings) ||
    object.warnings.length > MAX_DATA_QUERY_WARNINGS ||
    object.warnings.some(
      (warning) =>
        typeof warning !== 'string' ||
        warning.length === 0 ||
        warning.length > 512,
    )
  ) {
    return fail('Data query result warnings must be at most 100 short strings');
  }
  if (typeof object.truncated !== 'boolean')
    return fail('Data query result truncated must be boolean');
  const facets =
    request.mode === 'facets'
      ? normalizeFacetsResult(
          object.facets,
          request.facets ?? [],
          fields,
          budget,
        )
      : object.facets === undefined
        ? undefined
        : fail(`${request.mode} data query results cannot return facets`);
  const normalized: DataQueryResult = {
    version: 1,
    requestId: request.requestId,
    queryFingerprint: fingerprint,
    identityField: schema.identityField,
    rows,
    ...(normalizedPage === undefined ? {} : { page: normalizedPage }),
    total,
    ...(facets === undefined ? {} : { facets }),
    freshness,
    warnings: [...new Set(object.warnings)].sort(),
    truncated: object.truncated,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(normalized)).byteLength;
  if (bytes > (schema.maxResultBytes ?? DEFAULT_DATA_QUERY_RESULT_BYTES)) {
    return fail(
      'Data query result exceeds its maximum byte limit',
      'DATA_QUERY_RESULT_TOO_LARGE',
    );
  }
  return normalized;
}
