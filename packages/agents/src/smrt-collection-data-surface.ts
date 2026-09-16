/**
 * Generic `SmrtObject` collection to `DataSurface` adapter (#2905).
 *
 * `@happyvertical/smrt-content`'s `content-list-data-surface.ts` proved the
 * discover/inspect/query shape but is hard-wired to `ContentQueryCollection`
 * and `executeContentQuery`. This module extracts the registry-driven schema
 * building, field-policy redaction, and DNF filter/scope lowering into a
 * generic adapter keyed off `ObjectRegistry.getAllFields()` /
 * `ObjectRegistry.getAllSchemasAsDefinitions()`, so any registered
 * `SmrtObject` collection (events, ad zones, schedules, social accounts, …)
 * can mount a `DataSurfaceDefinition` without a bespoke, hand-written adapter.
 *
 * Placement: `@happyvertical/smrt-agents` already owns the `DataSurface*`
 * contracts (`./data-surface.ts`) and already depends on
 * `@happyvertical/smrt-core` (for `ObjectRegistry`) and
 * `@happyvertical/smrt-tenancy`. `@happyvertical/smrt-content` depends on
 * `@happyvertical/smrt-agents`, not the other way around, so putting this
 * adapter in `content` (or in `core`, which nothing but framework primitives
 * should own) would either create a dependency cycle or force every
 * non-Content consumer (events, ad zones, schedules, …) to pull in
 * `smrt-content`'s unrelated OCR/PDF/image/document dependencies just to
 * mount a generic surface. `agents` is the only package that can depend on
 * `core` for `ObjectRegistry` and expose the `DataSurfaceDefinition` contract
 * without creating a cycle or forcing an unrelated dependency.
 *
 * Follow-up: this module intentionally does NOT port
 * `executeContentQuery`'s per-value byte-shrinking/truncation engine (the
 * "shrink each oversized string/JSON field until the page fits" behavior in
 * `packages/content/src/content-query.ts`). That machinery is tightly coupled
 * to Content's long-text columns and is high-risk to move verbatim; a result
 * that would not fit `maxResultBytes` here fails normalization instead of
 * being shrunk. `createContentListDataSurfaceDefinition` is therefore not
 * reimplemented as a thin wrapper over this adapter in this change — doing so
 * safely needs that engine ported first. Tracked as a follow-up in #2912.
 */

import { createHash } from 'node:crypto';
import {
  canonicalizeDataQuery,
  createDataQueryFingerprint,
  DataQueryValidationError,
  MAX_DATA_QUERY_OFFSET,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  normalizeDataQuerySchema,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  getTenantScopedConfig,
  isSuperAdminBypass,
  isSystemContext,
  isTenancyEnabled,
  isTenantScopedClass,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type {
  DataQueryFacetResult,
  DataQueryFieldDescriptor,
  DataQueryFilter,
  DataQueryFilterOperator,
  DataQueryRequest,
  DataQueryResult,
  DataQueryRow,
  DataQuerySchema,
  DataQuerySort,
} from '@happyvertical/smrt-types';
import type {
  DataSurfaceDefinition,
  DataSurfaceExecutionContext,
  DataSurfaceField,
  DataSurfaceSchema,
} from './data-surface.js';

/** One AND-ed group of SMRT `where` conditions. */
type WhereCondition = Record<string, unknown>;
/** Bounded disjunctive-normal-form `where`: outer OR of inner AND groups. */
type WhereDnf = WhereCondition[][];

/**
 * The subset of `SmrtCollection` a generic collection query needs. Structural
 * so this module never imports a concrete collection class: any object
 * exposing this shape (including a real `SmrtCollection<T>`) can back a
 * surface.
 */
export interface SmrtCollectionQueryCollection {
  list(options: {
    select?: readonly string[];
    where?: WhereCondition | WhereDnf;
    offset?: number;
    limit?: number;
    orderBy?: string | string[];
  }): Promise<Record<string, unknown>[]>;
  count(options?: { where?: WhereCondition | WhereDnf }): Promise<number>;
  facets?(options: {
    fields: readonly { field: string; limit?: number }[];
    where?: WhereCondition | WhereDnf;
  }): Promise<{ field: string; values: { value: unknown; count: number }[] }[]>;
}

/** Trusted, server-derived narrowing conditions; never from request input. */
export type SmrtCollectionQueryScope =
  | WhereCondition
  | readonly WhereCondition[];

/** A declarative, non-authoritative row/bulk action a mounted surface exposes. */
export interface SmrtCollectionDataSurfaceAction {
  id: string;
  label: string;
  description?: string;
  bulk?: boolean;
  requiresConfirmation?: boolean;
}

export interface CreateSmrtCollectionDataSurfaceOptions {
  /** Stable opaque id presented to the model. Defaults to the collection name. */
  id?: string;
  /** Registered `ObjectRegistry` qualified (or bare) class name to introspect. */
  qualifiedName: string;
  /** Permission-catalog collection checked by the generic agent tools. */
  collectionName?: string;
  label?: string;
  description?: string;
  metadata?: NonNullable<DataSurfaceDefinition['metadata']>;
  /** Row identity field. Defaults to `id`. */
  identityField?: string;
  /** Extra field ids to exclude beyond the standard field-policy exclusions. */
  exclude?: readonly string[];
  /** Defaults to `min(50, maxPageLimit)` when omitted. */
  defaultPageLimit?: number;
  /**
   * Upper bound on `page.limit`. `SmrtCollectionQueryCollection` is
   * structural, so the adapter cannot read a host collection's own
   * `maxListLimit`; hosts MUST set this to a value <= the collection's
   * actual `maxListLimit`, or a clamped response will under-report the
   * effective page size (detected and warned about, but not corrected).
   */
  maxPageLimit?: number;
  maxResultBytes?: number;
  defaultSort?: DataQuerySort[];
  /** Whether the surface advertises opaque cursor paging. Defaults to true. */
  cursorPagination?: boolean;
  /**
   * Whether the surface advertises facet queries. Defaults to
   * `typeof collection.facets === 'function'` when `collection` is a static
   * object; defaults to `true` when `collection` is a resolver function
   * (its shape is unknown until called), so a resolver-backed surface whose
   * collection lacks `facets()` MUST set this to `false` explicitly.
   */
  facets?: boolean;
  /** Descriptive row/bulk action catalog, surfaced only via `metadata.actions`. */
  actions?: readonly SmrtCollectionDataSurfaceAction[];
  /** Resolve a collection from the live principal context, never model input. */
  collection:
    | SmrtCollectionQueryCollection
    | ((
        context: DataSurfaceExecutionContext,
      ) =>
        | SmrtCollectionQueryCollection
        | Promise<SmrtCollectionQueryCollection>);
  /** Trusted application narrowing applied in addition to tenant isolation. */
  scope?:
    | SmrtCollectionQueryScope
    | ((
        context: DataSurfaceExecutionContext,
      ) =>
        | SmrtCollectionQueryScope
        | undefined
        | Promise<SmrtCollectionQueryScope | undefined>);
  /** Trusted policy override; defaults to the registry-derived schema. */
  schema?: DataSurfaceSchema;
}

const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_MAX_PAGE_LIMIT = 200;
const DEFAULT_MAX_RESULT_BYTES = 1_000_000;
const RESULT_ENVELOPE_RESERVE_BYTES = 4_096;
const MIN_RESULT_ROW_BYTES = 512;
const MIN_RESULT_BYTES = RESULT_ENVELOPE_RESERVE_BYTES + MIN_RESULT_ROW_BYTES;
const MAX_OR_BRANCHES = 128;

function requiredName(
  value: string | undefined,
  fallback: string,
  label: string,
): string {
  const resolved = value ?? fallback;
  if (resolved.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return resolved;
}

function queryFail(message: string, code = 'INVALID_DATA_QUERY'): never {
  throw new DataQueryValidationError(message, code);
}

function isPlainRecord(value: unknown): value is WhereCondition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function queryFieldType(
  type: unknown,
): DataQueryFieldDescriptor['type'] | undefined {
  switch (type) {
    case 'text':
    case 'foreignKey':
    case 'crossPackageRef':
      return 'string';
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
      return undefined;
  }
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

interface RegistryFieldLike {
  type?: unknown;
  sensitive?: unknown;
  readPermission?: unknown;
  transient?: unknown;
  _meta?: Record<string, unknown>;
  __tenancy?: Record<string, unknown>;
  [key: string]: unknown;
}

function meta(field: RegistryFieldLike): Record<string, unknown> {
  return isPlainRecord(field._meta) ? field._meta : {};
}

/** `sensitive`/`readPermission` may be declared top-level or under `_meta`. */
function isRestrictedField(field: RegistryFieldLike): boolean {
  const fieldMeta = meta(field);
  return (
    field.sensitive === true ||
    fieldMeta.sensitive === true ||
    typeof field.readPermission === 'string' ||
    typeof fieldMeta.readPermission === 'string'
  );
}

function isTransientField(field: RegistryFieldLike): boolean {
  return field.transient === true || meta(field).transient === true;
}

function isTenantField(
  name: string,
  field: RegistryFieldLike,
  tenantField: string,
): boolean {
  const fieldMeta = meta(field);
  const tenancy = isPlainRecord(field.__tenancy)
    ? field.__tenancy
    : isPlainRecord(fieldMeta.__tenancy)
      ? fieldMeta.__tenancy
      : undefined;
  return (
    tenancy?.isTenantIdField === true ||
    name === tenantField ||
    name === 'tenantId' ||
    name === 'tenant_id'
  );
}

/** Shared field-policy predicate: registry `_`-prefixed/restricted/transient/tenant/caller-excluded. */
function isPolicyExcludedField(
  name: string,
  field: RegistryFieldLike,
  tenantField: string,
  exclude: ReadonlySet<string>,
): boolean {
  return (
    name.startsWith('_') ||
    exclude.has(name) ||
    isRestrictedField(field) ||
    isTransientField(field) ||
    isTenantField(name, field, tenantField)
  );
}

/**
 * The set of registry field ids a host-supplied `options.schema` override
 * must never be able to re-advertise: restricted (`sensitive`/
 * `readPermission`), transient, the configured tenant field, `_`-prefixed
 * internal fields, and caller-supplied `exclude` ids. Used to intersect an
 * override schema with the same policy the registry-derived schema enforces,
 * so a host cannot widen exposure by supplying its own `schema` field list.
 */
async function registryFieldPolicyExclusionSet(
  qualifiedName: string,
  exclude: ReadonlySet<string>,
): Promise<Set<string>> {
  const registered = (await ObjectRegistry.getAllFields(qualifiedName)) as Map<
    string,
    RegistryFieldLike
  >;
  const tenantField = getTenantScopedConfig(qualifiedName)?.field ?? 'tenantId';
  const excluded = new Set<string>();
  for (const [name, field] of registered) {
    if (isPolicyExcludedField(name, field, tenantField, exclude)) {
      excluded.add(name);
    }
  }
  return excluded;
}

/**
 * Build a `DataQuerySchema` from `ObjectRegistry`-registered field metadata
 * for an arbitrary `SmrtObject` class.
 *
 * Excluded, and therefore un-nameable by any caller:
 * - `sensitive` and `readPermission`-gated fields (exposure boundary);
 * - transient and non-column-backed fields (`meta`, `oneToMany`, `manyToMany`);
 * - the tenant field — tenancy is enforced by the executor;
 * - internal `_`-prefixed fields such as the STI discriminator;
 * - caller-supplied `exclude` ids.
 */
async function buildQuerySchemaForClass(
  qualifiedName: string,
  options: {
    exclude: ReadonlySet<string>;
    identityField: string;
    defaultPageLimit: number;
    maxPageLimit: number;
    maxResultBytes: number;
    defaultSort?: DataQuerySort[];
    cursorPagination: boolean;
    facets: boolean;
  },
): Promise<DataQuerySchema> {
  const registered = (await ObjectRegistry.getAllFields(qualifiedName)) as Map<
    string,
    RegistryFieldLike
  >;
  const tenantField = getTenantScopedConfig(qualifiedName)?.field ?? 'tenantId';
  const fields: DataQueryFieldDescriptor[] = [];
  for (const [name, field] of registered) {
    if (isPolicyExcludedField(name, field, tenantField, options.exclude))
      continue;
    const type = queryFieldType(field.type);
    if (!type) continue;
    const filterOperators = filterOperatorsFor(type);
    fields.push({
      id: name,
      type,
      projectable: true,
      sortable: type !== 'json',
      facetable:
        name !== options.identityField &&
        (type === 'string' || type === 'boolean' || type === 'number'),
      ...(filterOperators ? { filterOperators } : {}),
    });
  }

  const identity = fields.find((field) => field.id === options.identityField);
  if (!identity) {
    throw new Error(
      `${qualifiedName} does not declare a queryable '${options.identityField}' field`,
    );
  }

  const declared = new Set(fields.map((field) => field.id));
  const defaultSort = (options.defaultSort ?? []).filter((term) =>
    declared.has(term.field),
  );

  return {
    version: 1,
    identityField: options.identityField,
    fields,
    defaultPageLimit: options.defaultPageLimit,
    maxPageLimit: options.maxPageLimit,
    maxResultBytes: options.maxResultBytes,
    ...(defaultSort.length > 0 ? { defaultSort } : {}),
    supports: {
      cursorPagination: options.cursorPagination,
      consistency: false,
      facets: options.facets,
    },
  };
}

const schemaCache = new Map<string, Promise<DataQuerySchema>>();

/**
 * Memoized query schema for one registered class. The schema is derived from
 * immutable registration metadata, so it is built once per process rather
 * than per request.
 */
export function buildDataQuerySchemaForClass(
  qualifiedName: string,
  options: {
    exclude?: readonly string[];
    identityField?: string;
    defaultPageLimit?: number;
    maxPageLimit?: number;
    maxResultBytes?: number;
    defaultSort?: DataQuerySort[];
    cursorPagination?: boolean;
    facets?: boolean;
  } = {},
): Promise<DataQuerySchema> {
  const identityField = options.identityField ?? 'id';
  const excluded = [...new Set(options.exclude ?? [])].sort();
  const maxPageLimit = options.maxPageLimit ?? DEFAULT_MAX_PAGE_LIMIT;
  const defaultPageLimit =
    options.defaultPageLimit ?? Math.min(DEFAULT_PAGE_LIMIT, maxPageLimit);
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const cursorPagination = options.cursorPagination ?? true;
  const facets = options.facets ?? true;
  const canonicalDefaultSort = (options.defaultSort ?? [])
    .map((term) => `${term.field}:${term.direction}`)
    .join(',');
  const key = [
    qualifiedName,
    identityField,
    excluded.join(','),
    defaultPageLimit,
    maxPageLimit,
    maxResultBytes,
    canonicalDefaultSort,
    cursorPagination,
    facets,
  ].join('::');
  const cached = schemaCache.get(key);
  if (cached) return cached;
  const pending = buildQuerySchemaForClass(qualifiedName, {
    exclude: new Set(excluded),
    identityField,
    defaultPageLimit,
    maxPageLimit,
    maxResultBytes,
    defaultSort: options.defaultSort,
    cursorPagination,
    facets,
  }).catch((cause) => {
    schemaCache.delete(key);
    throw cause;
  });
  schemaCache.set(key, pending);
  return pending;
}

/** Testing seam: drop memoized schemas so a rebuild re-reads the registry. */
export function clearSmrtCollectionQuerySchemaCache(): void {
  schemaCache.clear();
}

/**
 * Field-policy redaction boundary, mirroring the Content adapter's
 * `querySchema()`: strip `sensitive`/`readPermission`/`metadata` annotations
 * and drop any field they mark, so a host descriptor built from this schema
 * never advertises — and a direct execution can never return — a restricted
 * field, even if a caller supplies a schema override that tried to include
 * one.
 */
function redactedQuerySchema(schema: DataSurfaceSchema): DataQuerySchema {
  return {
    ...schema,
    fields: schema.fields
      .filter(({ sensitive, readPermission }) => {
        if (sensitive) return false;
        return !readPermission;
      })
      .map(
        ({
          sensitive: _sensitive,
          readPermission: _readPermission,
          metadata: _metadata,
          ...field
        }) => field,
      ),
  };
}

function assertUsableResultBudget(schema: DataQuerySchema): void {
  const budget = schema.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  if (budget >= MIN_RESULT_BYTES) return;
  throw new Error(
    `Data query schema maxResultBytes must be at least ${MIN_RESULT_BYTES} ` +
      `(${RESULT_ENVELOPE_RESERVE_BYTES} reserved for the result envelope, ` +
      `${MIN_RESULT_ROW_BYTES} for rows); received ${budget}.`,
  );
}

/** Validate a host-supplied schema before anything depends on it. */
export function assertSmrtCollectionQuerySchema(schema: DataQuerySchema): void {
  normalizeDataQuerySchema(schema);
  assertUsableResultBudget(schema);
}

/**
 * Resolve the fail-closed tenant read scope, mirroring the generated route
 * helpers: with tenancy enabled and no active tenant context, reads are
 * restricted to NULL-tenant (global) rows rather than passing through
 * unfiltered. `withSystemContext()` and super-admin bypass remain the
 * explicit, deliberate cross-tenant paths.
 */
function resolveTenantReadScope(
  qualifiedName: string,
): WhereCondition | undefined {
  if (!isTenancyEnabled()) return undefined;
  if (!isTenantScopedClass(qualifiedName)) return undefined;
  if (isSuperAdminBypass() || isSystemContext()) return undefined;
  const tenantField = getTenantScopedConfig(qualifiedName)?.field ?? 'tenantId';
  return { [tenantField]: getCurrentTenant()?.tenantId ?? null };
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
      return queryFail(
        'Data queries cannot negate a like predicate',
        'DATA_QUERY_UNSUPPORTED',
      );
  }
}

/** Lower one condition to bounded DNF (see content-query.ts for the full rationale). */
function conditionToDnf(
  field: string,
  operator: DataQueryFilterOperator,
  value: unknown,
  negated = false,
): WhereDnf {
  const key = (suffix: string) => (suffix ? `${field} ${suffix}` : field);
  const single = (whereKey: string, whereValue: unknown): WhereDnf => [
    [{ [whereKey]: whereValue }],
  ];

  if (operator === 'in') {
    const values = (value as unknown[]) ?? [];
    const nonNull = values.filter((entry) => entry !== null);
    if (nonNull.length === 0) return single(field, null);
    if (nonNull.length === values.length) return single(key('in'), nonNull);
    return [[{ [field]: null }], [{ [key('in')]: nonNull }]];
  }

  if (operator === 'notIn') {
    const values = (value as unknown[]) ?? [];
    if (values.length === 0) {
      return queryFail(
        'Data query notIn requires at least one value',
        'DATA_QUERY_UNSUPPORTED',
      );
    }
    const inequalities = values
      .filter((entry) => entry !== null)
      .map((entry) => ({ [key('!=')]: entry }));
    if (values.some((entry) => entry === null)) {
      return [[...inequalities, { [key('!=')]: null }]];
    }
    return [[{ [field]: null }], inequalities];
  }

  if (operator === 'ne' && value !== null) {
    return [[{ [field]: null }], [{ [key('!=')]: value }]];
  }

  const suffixes: Record<
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

  if (
    negated &&
    (operator === 'gt' ||
      operator === 'gte' ||
      operator === 'lt' ||
      operator === 'lte')
  ) {
    return [[{ [field]: null }], [{ [key(suffixes[operator])]: value }]];
  }

  return single(key(suffixes[operator]), value);
}

function crossProduct(left: WhereDnf, right: WhereDnf): WhereDnf {
  if (left.length * right.length > MAX_OR_BRANCHES) {
    return queryFail(
      `Data query filter expands beyond ${MAX_OR_BRANCHES} OR branches`,
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  return left.flatMap((leftGroup) =>
    right.map((rightGroup) => [...leftGroup, ...rightGroup]),
  );
}

function filterToDnf(
  filter: DataQueryFilter,
  declared: ReadonlySet<string>,
  negate = false,
): WhereDnf {
  if (filter.kind === 'condition') {
    if (!declared.has(filter.field)) {
      return queryFail(
        `Data query filter field is not declared: ${filter.field}`,
        'DATA_QUERY_FILTER_NOT_ALLOWED',
      );
    }
    return conditionToDnf(
      filter.field,
      negate ? inverseOperator(filter.operator) : filter.operator,
      filter.value,
      negate,
    );
  }

  if (filter.kind === 'not') {
    return filterToDnf(filter.filter, declared, !negate);
  }

  const combineWithAnd =
    (filter.kind === 'all' && !negate) || (filter.kind === 'any' && negate);
  if (combineWithAnd) {
    return filter.filters.reduce<WhereDnf>(
      (combined, child) =>
        crossProduct(combined, filterToDnf(child, declared, negate)),
      [[]],
    );
  }

  const branches = filter.filters.flatMap((child) =>
    filterToDnf(child, declared, negate),
  );
  if (branches.length > MAX_OR_BRANCHES) {
    return queryFail(
      `Data query filter expands beyond ${MAX_OR_BRANCHES} OR branches`,
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  return branches;
}

function normalizeScopeConditions(
  scope: SmrtCollectionQueryScope | undefined,
): WhereCondition[] {
  if (scope === undefined) return [];
  const candidates = Array.isArray(scope)
    ? (scope as readonly unknown[])
    : [scope];
  return candidates.map((candidate) => {
    if (!isPlainRecord(candidate) || Object.keys(candidate).length === 0) {
      throw new Error(
        'Data query scope conditions must be non-empty plain objects',
      );
    }
    return { ...candidate };
  });
}

/**
 * Normalize the caller's trusted application scope. An explicit,
 * normalized-empty scope (deny-all) is handled by a short-circuit in
 * `executeSmrtCollectionQuery` before this is ever reached, so this never
 * needs a nullable-identity sentinel to represent "no rows."
 */
function normalizeApplicationScope(
  scope: SmrtCollectionQueryScope | undefined,
  _identityField: string,
): WhereCondition[] {
  if (scope === undefined) return [];
  return normalizeScopeConditions(scope);
}

/**
 * AND every trusted scope condition into every OR branch of the caller's
 * filter. A caller predicate can never widen past the scope; see
 * `mergeContentQueryScope` in `content-query.ts` for the full invariant.
 */
function mergeQueryScope(
  scope: SmrtCollectionQueryScope | undefined,
  callerWhere: WhereDnf | undefined,
): WhereDnf | undefined {
  const scopeConditions = normalizeScopeConditions(scope);
  const branches: WhereDnf =
    callerWhere && callerWhere.length > 0 ? callerWhere : [[]];
  const merged = branches.map((branch) => [...scopeConditions, ...branch]);
  if (merged.length === 1 && merged[0].length === 0) return undefined;
  if (merged.some((branch) => branch.length === 0)) {
    return queryFail(
      'Data query filter produced an unbounded OR branch',
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  return merged;
}

function orderByTerms(sort: DataQuerySort[] | undefined): string[] | undefined {
  if (!sort || sort.length === 0) return undefined;
  return sort.map((term) =>
    term.direction === 'desc' ? `${term.field} desc` : term.field,
  );
}

/**
 * Fingerprint binding a cursor to the exact query (and trusted scope) that
 * produced it: the normalized request minus `requestId`/`page` (via
 * `canonicalizeDataQuery`, which already strips both) plus the merged
 * tenant/application `where` scope, so a cursor cannot be replayed against a
 * different filter, sort, projection, or — critically — a different tenant.
 */
function computeCursorBinding(
  request: DataQueryRequest,
  schema: DataQuerySchema,
  where: WhereDnf | undefined,
): string {
  const canonicalRequest = canonicalizeDataQuery(request, schema);
  return createHash('sha256')
    .update(canonicalRequest)
    .update('\0')
    .update(JSON.stringify(where ?? null))
    .digest('base64url');
}

/** Opaque cursor: base64url JSON of `{ binding, offset }`. Never introspect. */
function encodeCursor(offset: number, binding: string): string {
  return Buffer.from(JSON.stringify({ binding, offset }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string | undefined, binding: string): number {
  if (!cursor) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return queryFail('Data query cursor is invalid', 'DATA_QUERY_UNSUPPORTED');
  }
  if (
    !isPlainRecord(parsed) ||
    typeof parsed.binding !== 'string' ||
    typeof parsed.offset !== 'number'
  ) {
    return queryFail('Data query cursor is invalid', 'DATA_QUERY_UNSUPPORTED');
  }
  if (!Number.isInteger(parsed.offset) || parsed.offset < 0) {
    return queryFail('Data query cursor is invalid', 'DATA_QUERY_UNSUPPORTED');
  }
  if (parsed.offset > MAX_DATA_QUERY_OFFSET) {
    return queryFail(
      `Data query cursor offset cannot exceed ${MAX_DATA_QUERY_OFFSET}`,
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  if (parsed.binding !== binding) {
    return queryFail(
      'Data query cursor does not match the current query',
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  return parsed.offset;
}

async function resolveCollection(
  options: CreateSmrtCollectionDataSurfaceOptions,
  context: DataSurfaceExecutionContext,
): Promise<SmrtCollectionQueryCollection> {
  return typeof options.collection === 'function'
    ? options.collection(context)
    : options.collection;
}

async function resolveScope(
  options: CreateSmrtCollectionDataSurfaceOptions,
  context: DataSurfaceExecutionContext,
): Promise<SmrtCollectionQueryScope | undefined> {
  return typeof options.scope === 'function'
    ? options.scope(context)
    : options.scope;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('Data query was aborted', 'AbortError');
  }
}

/**
 * Execute one bounded `DataQueryRequest` against an arbitrary
 * `SmrtCollectionQueryCollection`. Every projection, order term, and
 * predicate still passes through `collection.list/count/facets` — never raw
 * SQL, never a full collection hydration.
 */
export async function executeSmrtCollectionQuery(
  collection: SmrtCollectionQueryCollection,
  rawRequest: unknown,
  options: {
    schema: DataQuerySchema;
    qualifiedName: string;
    scope?: SmrtCollectionQueryScope;
    signal?: AbortSignal;
  },
): Promise<DataQueryResult> {
  const schema = options.schema;
  assertUsableResultBudget(schema);
  const request: DataQueryRequest = normalizeDataQueryRequest(
    rawRequest,
    schema,
  );
  const signal = options.signal;
  if (signal) assertNotAborted(signal);
  const queryFingerprint = createDataQueryFingerprint(request, schema);
  const descriptors = new Map(schema.fields.map((field) => [field.id, field]));
  const declared = new Set(descriptors.keys());
  const warnings: string[] = [];

  // Deny-all application scope: an explicit, normalized-empty scope means
  // "no rows are ever in bounds," never a `{ [identityField]: null }`
  // sentinel that depends on a nullable identity column. Short-circuit
  // without ever calling the collection.
  if (
    options.scope !== undefined &&
    normalizeScopeConditions(options.scope).length === 0
  ) {
    if (request.mode === 'rows') {
      const isCursor = request.page?.kind === 'cursor';
      const offset =
        !isCursor && request.page?.kind === 'offset' ? request.page.offset : 0;
      const limit =
        request.page?.limit ?? schema.defaultPageLimit ?? DEFAULT_PAGE_LIMIT;
      const page: DataQueryResult['page'] = isCursor
        ? { kind: 'cursor', limit, hasMore: false }
        : { kind: 'offset', offset, limit, hasMore: false };
      return normalizeDataQueryResult(
        {
          version: 1 as const,
          requestId: request.requestId,
          queryFingerprint,
          identityField: schema.identityField,
          rows: [],
          page,
          total: { kind: 'exact' as const, value: 0 },
          freshness: {
            state: 'fresh' as const,
            asOf: new Date().toISOString(),
          },
          warnings,
          truncated: false,
        },
        request,
        schema,
      );
    }
    let deniedFacets: DataQueryFacetResult[] | undefined;
    if (request.mode === 'facets') {
      deniedFacets = (request.facets ?? []).map((facet) => {
        if (!descriptors.has(facet.field)) {
          return queryFail(
            `Data query returned an undeclared facet: ${facet.field}`,
            'DATA_QUERY_RESULT_NOT_ALLOWED',
          );
        }
        return { field: facet.field, values: [], truncated: false };
      });
    }
    return normalizeDataQueryResult(
      {
        version: 1 as const,
        requestId: request.requestId,
        queryFingerprint,
        identityField: schema.identityField,
        rows: [],
        total: { kind: 'exact' as const, value: 0 },
        ...(deniedFacets === undefined ? {} : { facets: deniedFacets }),
        freshness: { state: 'fresh' as const, asOf: new Date().toISOString() },
        warnings,
        truncated: false,
      },
      request,
      schema,
    );
  }

  const callerWhere = request.filter
    ? filterToDnf(request.filter, declared)
    : undefined;
  const scopeConditions = [
    ...normalizeScopeConditions(resolveTenantReadScope(options.qualifiedName)),
    ...normalizeApplicationScope(options.scope, schema.identityField),
  ];
  const where = mergeQueryScope(
    scopeConditions.length > 0 ? scopeConditions : undefined,
    callerWhere,
  );
  const countOptions = where === undefined ? undefined : { where };
  const cursorBinding = computeCursorBinding(request, schema, where);

  if (request.mode === 'rows') {
    const projection = request.projection ?? [schema.identityField];
    const isCursor = request.page?.kind === 'cursor';
    const offset = isCursor
      ? decodeCursor(
          request.page?.kind === 'cursor' ? request.page.after : undefined,
          cursorBinding,
        )
      : request.page?.kind === 'offset'
        ? request.page.offset
        : 0;
    const limit =
      request.page?.limit ?? schema.defaultPageLimit ?? DEFAULT_PAGE_LIMIT;
    const orderBy = orderByTerms(request.sort);
    if (signal) assertNotAborted(signal);
    const listed = await collection.list({
      select: projection,
      offset,
      limit,
      ...(orderBy
        ? { orderBy: orderBy.length === 1 ? orderBy[0] : orderBy }
        : {}),
      ...(where === undefined ? {} : { where }),
    });
    const rows: DataQueryRow[] = listed.map((row) => {
      const out: DataQueryRow = {};
      for (const field of projection) {
        if (!descriptors.has(field)) {
          return queryFail(
            `Data query returned an undeclared field: ${field}`,
            'DATA_QUERY_RESULT_NOT_ALLOWED',
          );
        }
        out[field] = row[field] ?? null;
      }
      return out;
    });
    if (signal) assertNotAborted(signal);
    const total = await collection.count(countOptions);
    if (signal) assertNotAborted(signal);
    const hasMore = offset + rows.length < total;
    // `SmrtCollectionQueryCollection` is structural, so the adapter cannot
    // read a host collection's own `maxListLimit`. Detect the collection
    // having silently clamped the requested limit (fewer rows than asked
    // for, but more rows still exist) and warn about it; the returned
    // `page.limit` must still equal the requested limit — the shared result
    // normalizer requires exact agreement with the request — so a clamp is
    // reported, not corrected. `hasMore`/`nextCursor` are computed from the
    // actual `rows.length`, and the cursor path already resumes from
    // `offset + rows.length`, so the next page still lines up with what the
    // collection actually returned; only the *reported* limit for that page
    // stays nominal. See the `maxPageLimit` <= host `maxListLimit`
    // requirement documented on `CreateSmrtCollectionDataSurfaceOptions`.
    if (rows.length < limit && offset + rows.length < total) {
      warnings.push(
        'The collection returned fewer rows than requested; it may enforce ' +
          'its own maximum list limit below this schema’s maxPageLimit.',
      );
    }
    const page: DataQueryResult['page'] = isCursor
      ? {
          kind: 'cursor',
          limit,
          hasMore,
          ...(hasMore
            ? { nextCursor: encodeCursor(offset + rows.length, cursorBinding) }
            : {}),
        }
      : { kind: 'offset', offset, limit, hasMore };
    return normalizeDataQueryResult(
      {
        version: 1 as const,
        requestId: request.requestId,
        queryFingerprint,
        identityField: schema.identityField,
        rows,
        page,
        total: { kind: 'exact' as const, value: total },
        freshness: { state: 'fresh' as const, asOf: new Date().toISOString() },
        warnings,
        truncated: false,
      },
      request,
      schema,
    );
  }

  if (signal) assertNotAborted(signal);
  const total = await collection.count(countOptions);
  if (signal) assertNotAborted(signal);
  let facets: DataQueryFacetResult[] | undefined;

  if (request.mode === 'facets') {
    if (!collection.facets) {
      return queryFail(
        'This collection does not support facet queries',
        'DATA_QUERY_UNSUPPORTED',
      );
    }
    const requested = request.facets ?? [];
    if (signal) assertNotAborted(signal);
    const sourceFacets = await collection.facets({
      fields: requested.map((facet) => ({
        field: facet.field,
        limit: facet.limit,
      })),
      ...(where === undefined ? {} : { where }),
    });
    if (signal) assertNotAborted(signal);
    const byField = new Map(sourceFacets.map((facet) => [facet.field, facet]));
    facets = requested.map((facet) => {
      if (!descriptors.has(facet.field)) {
        return queryFail(
          `Data query returned an undeclared facet: ${facet.field}`,
          'DATA_QUERY_RESULT_NOT_ALLOWED',
        );
      }
      const values = (byField.get(facet.field)?.values ?? []).slice(
        0,
        facet.limit,
      );
      // Fewer facet values than requested is indistinguishable from a
      // collection-side clamp (same structural limitation as row limit
      // clamping above); this is documented rather than guessed at.
      return {
        field: facet.field,
        values: values.map((entry) => ({
          value: entry.value as string | number | boolean | null,
          count: entry.count,
        })),
        truncated:
          (byField.get(facet.field)?.values.length ?? 0) >= facet.limit,
      };
    });
  }

  return normalizeDataQueryResult(
    {
      version: 1 as const,
      requestId: request.requestId,
      queryFingerprint,
      identityField: schema.identityField,
      rows: [],
      total: { kind: 'exact' as const, value: total },
      ...(facets === undefined ? {} : { facets }),
      freshness: { state: 'fresh' as const, asOf: new Date().toISOString() },
      warnings,
      truncated: false,
    },
    request,
    schema,
  );
}

/**
 * Build one server-owned `DataSurfaceDefinition` for `data.discover`,
 * `data.inspect`, and silent/background `data.query` calls, generic across
 * any registered `SmrtObject` collection.
 *
 * The returned executor resolves its collection and application scope from
 * the live principal context. The request can only narrow that trusted
 * scope, and every projection/count/facet/page passes through the resolved
 * collection's own `list`/`count`/`facets`, never raw SQL.
 */
export async function createSmrtCollectionDataSurfaceDefinition(
  options: CreateSmrtCollectionDataSurfaceOptions,
): Promise<DataSurfaceDefinition> {
  const identityField = options.identityField ?? 'id';
  let schema: DataSurfaceSchema;
  if (options.schema) {
    // A host-supplied schema is a trusted override, but it must never be
    // able to re-advertise a field the registry-derived schema would have
    // excluded (e.g. re-adding a registry-sensitive field without its own
    // `sensitive`/`readPermission` annotation). Intersect it with the same
    // registry-derived exclusion set before redaction runs.
    const excludedByRegistry = await registryFieldPolicyExclusionSet(
      options.qualifiedName,
      new Set(options.exclude ?? []),
    );
    schema = {
      ...options.schema,
      fields: options.schema.fields.filter(
        (field) => !excludedByRegistry.has(field.id),
      ),
    };
  } else {
    schema = (await buildDataQuerySchemaForClass(options.qualifiedName, {
      exclude: options.exclude,
      identityField,
      defaultPageLimit: options.defaultPageLimit,
      maxPageLimit: options.maxPageLimit,
      maxResultBytes: options.maxResultBytes,
      defaultSort: options.defaultSort,
      cursorPagination: options.cursorPagination,
      facets:
        options.facets ??
        (typeof options.collection === 'function'
          ? true
          : typeof options.collection.facets === 'function'),
    })) as DataSurfaceSchema;
  }
  const executableSchema = redactedQuerySchema(schema);
  assertSmrtCollectionQuerySchema(executableSchema);

  return {
    id: requiredName(
      options.id,
      options.collectionName ?? options.qualifiedName,
      'SmrtObject collection data surface id',
    ),
    collection: requiredName(
      options.collectionName,
      options.qualifiedName,
      'SmrtObject collection permission collection',
    ),
    className: options.qualifiedName,
    label: options.label ?? options.qualifiedName,
    description:
      options.description ??
      'Bounded, tenant-safe rows, counts, facets, and continuations.',
    metadata: {
      domain: 'smrt-collection',
      adapter: 'SmrtCollection',
      queryModes: ['rows', 'count', 'facets'],
      ...(options.actions
        ? {
            actions: options.actions.map((action) => action.id),
            // Descriptive only (id/label/description/bulk/requiresConfirmation
            // per entry); `DataSurfaceMetadataValue` has no object variant, so
            // the catalog is carried as a JSON string rather than widening
            // that shared contract type.
            actionCatalog: JSON.stringify(options.actions),
          }
        : {}),
      ...options.metadata,
    },
    schema: executableSchema,
    execute: async (_surface, request, context) => {
      normalizeDataQueryRequest(request, executableSchema);
      assertNotAborted(context.signal);
      const run = async () =>
        executeSmrtCollectionQuery(
          await resolveCollection(options, context),
          request,
          {
            schema: executableSchema,
            qualifiedName: options.qualifiedName,
            scope: await resolveScope(options, context),
            signal: context.signal,
          },
        );
      // Tenant-scoped collections (`@TenantScoped({ mode: 'required' })`)
      // refuse `list()`/`count()` outside an active `TenantContext`, even
      // though `resolveTenantReadScope()` already ANDs the tenant condition
      // into the `where`. Establish that context from the same authenticated
      // principal the scope is derived from, so a required-mode collection
      // works out of the box. Never clobber an existing system/bypass/tenant
      // context already in force: only enter a new one when tenancy is
      // enabled, no tenant context is currently active, and the caller is
      // not already running under a system-context or super-admin bypass.
      if (isTenancyEnabled()) {
        const activeTenant = getCurrentTenant();
        if (
          activeTenant === undefined &&
          context.principal.tenantId &&
          !isSystemContext() &&
          !isSuperAdminBypass()
        ) {
          return withTenant({ tenantId: context.principal.tenantId }, run);
        }
        // An ambient tenant context (e.g. from a caller nested on the same
        // async chain, such as `executeAsPrincipal({ enterTenantContext:
        // false })`) is trusted only when it agrees with the authenticated
        // principal this execution is bound to, or when the caller is
        // explicitly and deliberately in a system-context/super-admin-bypass
        // path. Otherwise `resolveTenantReadScope()` would silently scope
        // rows to whatever tenant happens to be ambient rather than the
        // principal actually authorized for this call — a silent
        // cross-tenant disclosure with no upstream gate. Compare against
        // `context.principal.tenantId ?? null` (not the truthy value alone)
        // so a tenant-less principal (`tenantId: null`) is still refused
        // when a mismatched ambient tenant context is active, rather than
        // silently falling through to `run()`.
        if (
          activeTenant !== undefined &&
          activeTenant.tenantId !== (context.principal.tenantId ?? null) &&
          !isSystemContext() &&
          !isSuperAdminBypass()
        ) {
          throw new Error(
            'Data surface execution refused: an active tenant context ' +
              `('${activeTenant.tenantId}') does not match the authenticated ` +
              `principal's tenant ('${context.principal.tenantId ?? 'null'}').`,
          );
        }
      }
      return run();
    },
  };
}

export type { DataSurfaceField };
