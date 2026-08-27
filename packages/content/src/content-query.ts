/**
 * Bounded, tenant-safe content data queries (#2452) over the canonical
 * transport-neutral query protocol (#2444).
 *
 * `ContentList` (and any other consumer) sends a `DataQueryRequest`; this
 * module normalizes it against a schema derived from the registered `Content`
 * field metadata, executes it through `SmrtCollection.list/count/facets` — never
 * raw SQL, never a full collection hydration — and returns a validated
 * `DataQueryResult`.
 *
 * Three independent boundaries protect a read:
 *
 * 1. **Schema** — `buildContentQuerySchema()` declares the only field ids a
 *    caller may name. `sensitive`, `readPermission`-gated, transient,
 *    non-column-backed, tenant, and internal (`_`-prefixed) fields are never
 *    declared, so `normalizeDataQueryRequest()` rejects them outright.
 * 2. **Collection** — every projection, order term, and predicate still passes
 *    through `SmrtCollection`, which independently refuses sensitive and
 *    permission-gated fields. A schema bug alone cannot expose a field.
 * 3. **Scope** — trusted, server-derived conditions are ANDed into every branch
 *    of the caller's filter, so a request can only ever narrow the read.
 */

import {
  createDataQueryFingerprint,
  DataQueryValidationError,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  getCurrentTenant,
  isSuperAdminBypass,
  isSystemContext,
  isTenancyEnabled,
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

/** Registered qualified name of the STI base every content query reads. */
export const CONTENT_QUERY_CLASS_NAME = '@happyvertical/smrt-content:Content';

/** Row identity for every content query. Never a page or display index. */
export const CONTENT_QUERY_IDENTITY_FIELD = 'id';

/**
 * Deterministic default ordering: most recently updated first, tie-broken by
 * id. `updated_at` is chosen over `publish_date` deliberately — it is always
 * populated, so ordering never depends on engine-specific NULL placement, and
 * it matches the ordering the rest of the `Contents` collection already uses.
 */
export const CONTENT_QUERY_DEFAULT_SORT: DataQuerySort[] = [
  { field: 'updated_at', direction: 'desc' },
  { field: CONTENT_QUERY_IDENTITY_FIELD, direction: 'asc' },
];

/** Page bounds. Content rows can carry long text, so the ceiling is modest. */
export const CONTENT_QUERY_DEFAULT_PAGE_LIMIT = 50;
export const CONTENT_QUERY_MAX_PAGE_LIMIT = 200;
export const CONTENT_QUERY_MAX_RESULT_BYTES = 1_000_000;

/**
 * Fields the content query never declares even though they are column-backed.
 *
 * `body` is a document, not list data: the canonical envelope caps a scalar at
 * {@link DATA_QUERY_MAX_STRING_LENGTH} characters, so a real body could only
 * ever be returned mangled. Read a body through the item route
 * (`GET /api/v1/contents/{id}`), which serializes it in full.
 */
export const CONTENT_QUERY_EXCLUDED_FIELD_IDS: readonly string[] = ['body'];

/**
 * The protocol's hard scalar cap (`dataQueryScalar` in
 * `@happyvertical/smrt-core`): a string value longer than this makes the whole
 * result invalid, so long values are truncated and flagged instead.
 */
export const DATA_QUERY_MAX_STRING_LENGTH = 4_096;

/**
 * The protocol's limits for a `json` field, mirrored from
 * `canonicalJson` in `@happyvertical/smrt-core`. Exceeding any of them makes
 * the whole result invalid rather than the one value, so the adapter bounds a
 * JSON document itself (see `boundJsonValue`).
 */
export const DATA_QUERY_MAX_JSON_STRING_LENGTH = 65_536;
export const DATA_QUERY_MAX_JSON_CONTAINER_ITEMS = 1_000;
export const DATA_QUERY_MAX_JSON_DEPTH = 16;

/**
 * Keys `plainObject` refuses outright (`FORBIDDEN_DATA_QUERY`), mirrored from
 * `@happyvertical/smrt-core`. This is a *validity* rule rather than a size
 * limit, and it is the reachable one: `metadata` is the documented extension
 * point, it is writable through the generated REST API and through
 * `Content.mirror()` ingestion, and `JSON.parse` of the stored column creates
 * an own `__proto__` property. One row carrying such a key would otherwise make
 * every query projecting that field return 400 for the whole page, with no way
 * to page past it.
 */
export const DATA_QUERY_FORBIDDEN_JSON_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Bytes held back from the row budget for the envelope itself (request id,
 * fingerprint, page, total, freshness, warnings). The normalizer re-checks the
 * complete serialized envelope against `maxResultBytes`, so the row budget must
 * leave room for it.
 */
const RESULT_ENVELOPE_RESERVE_BYTES = 4_096;

/**
 * Upper bound on OR branches handed to the collection query builder.
 *
 * Exported so a client can mirror it: the null-safe `ne`/`notIn` lowering below
 * turns one predicate into two branches, and an `all` of them multiplies, so a
 * caller has to be able to stop short of the ceiling rather than be refused.
 */
export const MAX_CONTENT_QUERY_OR_BRANCHES = 128;

const encoder = new TextEncoder();

/** One AND-ed group of SMRT `where` conditions. */
type WhereCondition = Record<string, unknown>;

/** Bounded disjunctive-normal-form `where`: outer OR of inner AND groups. */
type WhereDnf = WhereCondition[][];

/**
 * The subset of `SmrtCollection` a content query needs. Structural so this
 * module never imports `Contents` (which imports this one) and so a host can
 * supply an application-owned collection that preserves the same boundary.
 */
export interface ContentQueryCollection {
  list(options: {
    select?: readonly string[];
    where?: WhereCondition | WhereDnf;
    offset?: number;
    limit?: number;
    orderBy?: string | string[];
  }): Promise<Record<string, unknown>[]>;
  count(options?: { where?: WhereCondition | WhereDnf }): Promise<number>;
  facets(options: {
    fields: readonly { field: string; limit?: number }[];
    where?: WhereCondition | WhereDnf;
  }): Promise<{ field: string; values: { value: unknown; count: number }[] }[]>;
}

/**
 * Trusted, server-derived narrowing conditions.
 *
 * Each entry is a plain SMRT `where` condition object (`{ status: 'published' }`,
 * `{ 'publish_date <=': someInstant }`, `{ category: ['news', 'sport'] }`).
 * Every condition is ANDed into **every** OR branch of the caller's filter.
 */
export type ContentQueryScope = WhereCondition | readonly WhereCondition[];

export interface ContentQueryOptions {
  /**
   * Application-supplied narrowing conditions derived from the authenticated
   * server-side context — never from the request body.
   *
   * This is how an application expresses site, organization, workspace, or
   * ownership scoping. The framework deliberately does not model site or
   * organization: `Content` carries tenancy plus a freeform `metadata` blob and
   * nothing else, so the host that knows what "site" means for its deployment
   * passes the conditions that mean it here (a subclass column, a denormalized
   * id column, a pre-resolved id list, and so on).
   *
   * SECURITY INVARIANT: scope may only come from trusted server-side context. A
   * `DataQueryRequest` has no way to supply, replace, widen, or remove a scope
   * condition — scope conditions are ANDed into every branch of the caller's
   * filter, including inside `any`/`not` branches, so a request can only ever
   * narrow the result set. Never derive `scope` from client input.
   */
  scope?: ContentQueryScope;
  /**
   * Trusted adapter policy override. Defaults to the memoized `Content` schema.
   * This is adapter configuration, never caller input; it exists so a host (or
   * a test) can execute the same bounded protocol against another registered
   * class. Supplying a schema does NOT relax the collection-level field checks.
   */
  schema?: DataQuerySchema;
}

/**
 * Resolve the fail-closed tenant read scope for a content query.
 *
 * Mirrors the generated route helpers `tenantReadScope()` /
 * `tenantReadOptionsScope()`: with tenancy enabled and no active tenant
 * context, reads are restricted to NULL-tenant (global) rows rather than
 * passing through unfiltered, because `Content` is
 * `@TenantScoped({ mode: 'optional' })` and the interceptor alone would not
 * filter an anonymous read. `withSystemContext()` and super-admin bypass remain
 * the explicit, deliberate cross-tenant paths.
 */
export function resolveContentTenantReadScope():
  | { tenantId: string | null }
  | undefined {
  if (!isTenancyEnabled()) return undefined;
  if (isSuperAdminBypass() || isSystemContext()) return undefined;
  return { tenantId: getCurrentTenant()?.tenantId ?? null };
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
    // `meta`, `oneToMany`, `manyToMany`, and anything a future scanner adds are
    // not column-backed scalars. Fail closed by leaving them undeclared.
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
    // JSON columns store serialized documents; there is no portable predicate
    // for them at the collection boundary, so they stay unfilterable.
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

function isTenantField(name: string, field: RegistryFieldLike): boolean {
  const fieldMeta = meta(field);
  const tenancy = isPlainRecord(field.__tenancy)
    ? field.__tenancy
    : isPlainRecord(fieldMeta.__tenancy)
      ? fieldMeta.__tenancy
      : undefined;
  return (
    tenancy?.isTenantIdField === true ||
    name === 'tenantId' ||
    name === 'tenant_id'
  );
}

/**
 * Build a `DataQuerySchema` from registered field metadata.
 *
 * Excluded, and therefore un-nameable by any caller:
 * - `sensitive` and `readPermission`-gated fields (exposure boundary);
 * - transient and non-column-backed fields (`meta`, `oneToMany`, `manyToMany`);
 * - the tenant field — tenancy is enforced by the executor, and a caller must
 *   never be able to filter, sort, project, or facet on it;
 * - internal `_`-prefixed fields such as the STI discriminator.
 */
async function buildQuerySchemaForClass(
  qualifiedName: string,
  excluded: ReadonlySet<string>,
): Promise<DataQuerySchema> {
  const registered = (await ObjectRegistry.getAllFields(qualifiedName)) as Map<
    string,
    RegistryFieldLike
  >;
  const fields: DataQueryFieldDescriptor[] = [];
  for (const [name, field] of registered) {
    if (name.startsWith('_')) continue;
    if (excluded.has(name)) continue;
    if (isRestrictedField(field)) continue;
    if (isTransientField(field)) continue;
    if (isTenantField(name, field)) continue;
    const type = queryFieldType(field.type);
    if (!type) continue;
    const filterOperators = filterOperatorsFor(type);
    fields.push({
      id: name,
      type,
      projectable: true,
      // JSON documents have no portable ordering at the SQL layer.
      sortable: type !== 'json',
      // Facets group by the stored column: only bounded scalar domains are
      // useful, and the identity field is unique by definition.
      facetable:
        name !== CONTENT_QUERY_IDENTITY_FIELD &&
        (type === 'string' || type === 'boolean' || type === 'number'),
      ...(filterOperators ? { filterOperators } : {}),
    });
  }

  const identity = fields.find(
    (field) => field.id === CONTENT_QUERY_IDENTITY_FIELD,
  );
  if (!identity) {
    throw new Error(
      `${qualifiedName} does not declare a queryable '${CONTENT_QUERY_IDENTITY_FIELD}' field`,
    );
  }

  const declared = new Set(fields.map((field) => field.id));
  const defaultSort = CONTENT_QUERY_DEFAULT_SORT.filter((term) =>
    declared.has(term.field),
  );

  return {
    version: 1,
    identityField: CONTENT_QUERY_IDENTITY_FIELD,
    fields,
    defaultPageLimit: CONTENT_QUERY_DEFAULT_PAGE_LIMIT,
    maxPageLimit: CONTENT_QUERY_MAX_PAGE_LIMIT,
    maxResultBytes: CONTENT_QUERY_MAX_RESULT_BYTES,
    ...(defaultSort.length > 0 ? { defaultSort } : {}),
    supports: {
      // Offset paging only: cursor paging would need an opaque, query-bound
      // cursor the collection read path does not issue today.
      cursorPagination: false,
      // Live table reads; no snapshot or as-of capability.
      consistency: false,
      facets: true,
    },
  };
}

const schemaCache = new Map<string, Promise<DataQuerySchema>>();

/**
 * Memoized query schema for one registered class (keyed by qualified name).
 * The schema is derived from immutable registration metadata, so it is built
 * once per process rather than per request.
 */
export function buildDataQuerySchemaForClass(
  qualifiedName: string,
  options: { exclude?: readonly string[] } = {},
): Promise<DataQuerySchema> {
  const excluded = [...new Set(options.exclude ?? [])].sort();
  const key = `${qualifiedName}::${excluded.join(',')}`;
  const cached = schemaCache.get(key);
  if (cached) return cached;
  const pending = buildQuerySchemaForClass(
    qualifiedName,
    new Set(excluded),
  ).catch((cause) => {
    schemaCache.delete(key);
    throw cause;
  });
  schemaCache.set(key, pending);
  return pending;
}

/** Memoized bounded query schema for `Content`. */
export function buildContentQuerySchema(): Promise<DataQuerySchema> {
  return buildDataQuerySchemaForClass(CONTENT_QUERY_CLASS_NAME, {
    exclude: CONTENT_QUERY_EXCLUDED_FIELD_IDS,
  });
}

/** Testing seam: drop memoized schemas so a rebuild re-reads the registry. */
export function clearContentQuerySchemaCache(): void {
  schemaCache.clear();
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
        'Content queries cannot negate a like predicate',
        'DATA_QUERY_UNSUPPORTED',
      );
  }
}

function conditionToDnf(
  field: string,
  operator: DataQueryFilterOperator,
  value: unknown,
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
    // SQL `IN` never matches NULL; model the caller-visible union explicitly.
    return [[{ [field]: null }], [{ [key('in')]: nonNull }]];
  }

  if (operator === 'notIn') {
    const values = (value as unknown[]) ?? [];
    if (values.length === 0) {
      // The normalizer refuses an empty list, so this is unreachable; failing
      // is still the only safe answer, because "excludes nothing" would have to
      // be an unbounded OR branch.
      return queryFail(
        'Content query notIn requires at least one value',
        'DATA_QUERY_UNSUPPORTED',
      );
    }
    // `buildWhere()` has no NOT IN primitive. A bounded AND of inequalities has
    // the same null-safe semantics and stays fully validated by the collection.
    const inequalities = values
      .filter((entry) => entry !== null)
      .map((entry) => ({ [key('!=')]: entry }));
    if (values.some((entry) => entry === null)) {
      // A listed `null` says "rows with no value are excluded too", so the
      // null-safe union below must NOT be added — it would return exactly the
      // rows the caller asked to exclude, and would make `in [x, null]` and its
      // negation overlap. `{ field '!=': null }` is `IS NOT NULL`.
      return [[...inequalities, { [key('!=')]: null }]];
    }
    // No `null` was listed. SQL's `<>` is UNKNOWN for NULL, so a bare AND of
    // inequalities silently excludes rows with no value at all — while the
    // caller-visible meaning of "not one of these" includes them, and the local
    // evaluator agrees. Model that union explicitly, exactly as `in` does
    // above, so the same shared link returns the same rows whether the list is
    // server-backed or not.
    return [[{ [field]: null }], inequalities];
  }

  if (operator === 'ne' && value !== null) {
    // Same reasoning as `notIn`. A `ne null` is left alone: it is the
    // `isNotNull` predicate, and unioning IS NULL into it would match every row.
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
  return single(key(suffixes[operator]), value);
}

function crossProduct(left: WhereDnf, right: WhereDnf): WhereDnf {
  if (left.length * right.length > MAX_CONTENT_QUERY_OR_BRANCHES) {
    return queryFail(
      `Content query filter expands beyond ${MAX_CONTENT_QUERY_OR_BRANCHES} OR branches`,
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
    // The normalizer already rejected undeclared fields; re-check so a schema
    // and an executor can never disagree about what is queryable.
    if (!declared.has(filter.field)) {
      return queryFail(
        `Content query filter field is not declared: ${filter.field}`,
        'DATA_QUERY_FILTER_NOT_ALLOWED',
      );
    }
    return conditionToDnf(
      filter.field,
      negate ? inverseOperator(filter.operator) : filter.operator,
      filter.value,
    );
  }

  if (filter.kind === 'not') {
    return filterToDnf(filter.filter, declared, !negate);
  }

  // De Morgan: a negated `any` behaves as an `all` of negated children.
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
  if (branches.length > MAX_CONTENT_QUERY_OR_BRANCHES) {
    return queryFail(
      `Content query filter expands beyond ${MAX_CONTENT_QUERY_OR_BRANCHES} OR branches`,
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  return branches;
}

function normalizeScopeConditions(
  scope: ContentQueryScope | undefined,
): WhereCondition[] {
  if (scope === undefined) return [];
  const candidates = Array.isArray(scope)
    ? (scope as readonly unknown[])
    : [scope];
  return candidates.map((candidate) => {
    if (!isPlainRecord(candidate) || Object.keys(candidate).length === 0) {
      throw new Error(
        'Content query scope conditions must be non-empty plain objects',
      );
    }
    return { ...candidate };
  });
}

/**
 * AND every trusted scope condition into every OR branch of the caller's
 * filter.
 *
 * This is the whole widening story: a branch can only ever gain conditions, and
 * conjunction is monotonically narrowing, so no filter shape — including
 * `any` (OR) and `not` (negation) — can produce a branch that escapes the base
 * scope. A caller predicate on a scoped field can contradict the scope (and
 * return nothing); it can never replace it.
 *
 * Returns `undefined` only when there is neither a scope nor a filter, so the
 * collection sees a plain unfiltered read rather than an empty DNF branch.
 */
export function mergeContentQueryScope(
  scope: ContentQueryScope | undefined,
  callerWhere: WhereDnf | undefined,
): WhereDnf | undefined {
  const scopeConditions = normalizeScopeConditions(scope);
  const branches: WhereDnf =
    callerWhere && callerWhere.length > 0 ? callerWhere : [[]];
  const merged = branches.map((branch) => [...scopeConditions, ...branch]);
  if (merged.length === 1 && merged[0].length === 0) return undefined;
  if (merged.some((branch) => branch.length === 0)) {
    // An empty OR branch matches every row, which would widen the read.
    return queryFail(
      'Content query filter produced an unbounded OR branch',
      'DATA_QUERY_UNSUPPORTED',
    );
  }
  return merged;
}

/**
 * The result normalizer's warning rule: at most 100 entries, each a non-empty
 * string of at most 512 characters. A warning that names a field list derived
 * from a host-supplied schema could otherwise exceed it and fail the result
 * this warning exists to explain.
 */
export const DATA_QUERY_MAX_WARNINGS = 100;
export const DATA_QUERY_MAX_WARNING_LENGTH = 512;

/** Appends a warning bounded to what `normalizeDataQueryResult` accepts. */
function pushWarning(warnings: string[], message: string): void {
  if (warnings.length >= DATA_QUERY_MAX_WARNINGS) return;
  const text =
    message.length > DATA_QUERY_MAX_WARNING_LENGTH
      ? `${message.slice(0, DATA_QUERY_MAX_WARNING_LENGTH - 1)}\u2026`
      : message;
  if (text.length > 0) warnings.push(text);
}

/** Records values the adapter had to shorten so the caller is told. */
interface TruncationLog {
  fields: Set<string>;
}

/**
 * Cut an over-long string to the protocol's scalar cap without leaving a lone
 * surrogate behind.
 */
function capString(
  value: string,
  limit = DATA_QUERY_MAX_STRING_LENGTH,
): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Bound one JSON document the same way {@link capString} bounds a scalar.
 *
 * `normalizeDataQueryResult` validates a `json` field with `canonicalJson`,
 * which *rejects the whole result* — not just the offending value — when a
 * nested string exceeds {@link DATA_QUERY_MAX_JSON_STRING_LENGTH}, a container
 * exceeds {@link DATA_QUERY_MAX_JSON_CONTAINER_ITEMS}, nesting passes
 * {@link DATA_QUERY_MAX_JSON_DEPTH}, a number is non-finite, a value is not a
 * plain JSON type, or the document contains a cycle. One row with a large
 * `metadata` blob would therefore fail an otherwise valid page.
 *
 * Every one of those is bounded here instead, and the field is flagged so the
 * caller sees `truncated` plus a warning naming it.
 */
function boundJsonValue(
  value: unknown,
  descriptor: DataQueryFieldDescriptor,
  truncation: TruncationLog | undefined,
  depth = 0,
  ancestors = new Set<object>(),
): unknown {
  const flag = (): void => {
    truncation?.fields.add(descriptor.id);
  };
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.length > DATA_QUERY_MAX_JSON_STRING_LENGTH) {
      flag();
      return capString(value, DATA_QUERY_MAX_JSON_STRING_LENGTH);
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      flag();
      return null;
    }
    return value;
  }
  if (typeof value === 'bigint') {
    const safe =
      value <= BigInt(Number.MAX_SAFE_INTEGER) &&
      value >= BigInt(Number.MIN_SAFE_INTEGER);
    if (!safe) {
      flag();
      return null;
    }
    return Number(value);
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  // Deeper than the validator accepts: keep the row, drop the sub-document.
  if (depth >= DATA_QUERY_MAX_JSON_DEPTH) {
    flag();
    return null;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      flag();
      return null;
    }
    ancestors.add(value);
    try {
      let entries = value;
      if (entries.length > DATA_QUERY_MAX_JSON_CONTAINER_ITEMS) {
        flag();
        entries = entries.slice(0, DATA_QUERY_MAX_JSON_CONTAINER_ITEMS);
      }
      return entries.map((entry) =>
        boundJsonValue(entry, descriptor, truncation, depth + 1, ancestors),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainRecord(value)) {
    // A class instance, function, or symbol would fail `plainObject` outright.
    flag();
    return null;
  }
  if (ancestors.has(value)) {
    flag();
    return null;
  }
  ancestors.add(value);
  try {
    let keys = Object.keys(value);
    if (keys.length > DATA_QUERY_MAX_JSON_CONTAINER_ITEMS) {
      flag();
      keys = keys.slice(0, DATA_QUERY_MAX_JSON_CONTAINER_ITEMS);
    }
    // A null prototype, so writing a key named `__proto__` stores an own
    // property instead of invoking the inherited setter — which would silently
    // drop the key AND change this object's prototype, failing `plainObject`'s
    // prototype check on the way out. `Object.prototype` and `null` are the two
    // prototypes the validator accepts.
    const bounded = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      if (key.length > DATA_QUERY_MAX_JSON_STRING_LENGTH) {
        flag();
        continue;
      }
      // `plainObject` REJECTS the whole result for one of these keys, and
      // `JSON.parse` of a stored `metadata` column creates an own `__proto__`
      // property, so a single row could otherwise brick every query that
      // projects the field. Dropping the key keeps the row readable.
      if (DATA_QUERY_FORBIDDEN_JSON_KEYS.has(key)) {
        flag();
        continue;
      }
      Object.defineProperty(bounded, key, {
        value: boundJsonValue(
          value[key],
          descriptor,
          truncation,
          depth + 1,
          ancestors,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return bounded;
  } finally {
    ancestors.delete(value);
  }
}

function toDeclaredValue(
  value: unknown,
  descriptor: DataQueryFieldDescriptor,
  truncation?: TruncationLog,
): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  // A json field is validated as a document, not a scalar: it has its own,
  // larger limits, and the scalar cap would corrupt a serialized payload.
  if (descriptor.type === 'json') {
    return boundJsonValue(value, descriptor, truncation);
  }
  if (
    typeof value === 'string' &&
    value.length > DATA_QUERY_MAX_STRING_LENGTH
  ) {
    // The envelope rejects any scalar longer than the cap, which would turn one
    // long row into a failed query. Shorten it and say so instead.
    truncation?.fields.add(descriptor.id);
    return capString(value);
  }
  if (typeof value === 'bigint') {
    if (
      value > BigInt(Number.MAX_SAFE_INTEGER) ||
      value < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      return queryFail(
        `Content query value for ${descriptor.id} exceeds the safe integer range`,
        'DATA_QUERY_RESULT_INVALID',
      );
    }
    return Number(value);
  }
  if (descriptor.type === 'boolean' && typeof value === 'number') {
    // SQLite/DuckDB surface booleans as 0/1.
    return value !== 0;
  }
  return value;
}

function jsonByteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value) ?? 'null').byteLength;
}

interface BoundedRows {
  rows: DataQueryRow[];
  truncated: boolean;
}

/**
 * Keep the returned rows inside the schema byte budget.
 *
 * The normalizer *rejects* an oversized result rather than trimming it, and a
 * single content body can be megabytes, so the adapter must bound the payload
 * itself: trailing rows are dropped and the result is flagged `truncated`.
 */
function boundRowBytes(
  rows: DataQueryRow[],
  maxResultBytes: number,
): BoundedRows {
  const budget = Math.max(
    0,
    (maxResultBytes || CONTENT_QUERY_MAX_RESULT_BYTES) -
      RESULT_ENVELOPE_RESERVE_BYTES,
  );
  const kept: DataQueryRow[] = [];
  // Opening and closing brackets of the serialized rows array.
  let used = 2;
  for (const row of rows) {
    const cost = jsonByteLength(row) + 1;
    if (used + cost > budget) {
      return { rows: kept, truncated: true };
    }
    used += cost;
    kept.push(row);
  }
  return { rows: kept, truncated: false };
}

function orderByTerms(sort: DataQuerySort[] | undefined): string[] | undefined {
  if (!sort || sort.length === 0) return undefined;
  return sort.map((term) => `${term.field} ${term.direction.toUpperCase()}`);
}

/**
 * Execute one bounded content query.
 *
 * Every read goes through `SmrtCollection.list({ select, where, orderBy,
 * offset, limit })`, `count()`, and `facets()` — the collection remains the
 * authorization, tenancy-interception, and SQL boundary. The full collection is
 * never hydrated to filter or page in memory.
 *
 * Tenancy is applied by this function itself (see
 * {@link resolveContentTenantReadScope}) in addition to any application
 * `scope`; a caller cannot opt out of it.
 *
 * @param collection Content collection to read through.
 * @param rawRequest Untrusted `DataQueryRequest` (typically an HTTP body).
 * @param options Trusted adapter configuration — never derived from the caller.
 */
export async function executeContentQuery(
  collection: ContentQueryCollection,
  rawRequest: unknown,
  options: ContentQueryOptions = {},
): Promise<DataQueryResult> {
  const schema = options.schema ?? (await buildContentQuerySchema());
  const request: DataQueryRequest = normalizeDataQueryRequest(
    rawRequest,
    schema,
  );
  const queryFingerprint = createDataQueryFingerprint(request, schema);
  const descriptors = new Map(schema.fields.map((field) => [field.id, field]));
  const declared = new Set(descriptors.keys());

  const callerWhere = request.filter
    ? filterToDnf(request.filter, declared)
    : undefined;
  // Tenancy first, then the application scope: both are trusted, both narrow.
  const scopeConditions = [
    ...normalizeScopeConditions(resolveContentTenantReadScope()),
    ...normalizeScopeConditions(options.scope),
  ];
  const where = mergeContentQueryScope(scopeConditions, callerWhere);
  const countOptions = where === undefined ? undefined : { where };

  const warnings: string[] = [];
  let truncated = false;
  let facets: DataQueryFacetResult[] | undefined;

  if (request.mode === 'rows') {
    const projection = request.projection ?? [schema.identityField];
    const offset = request.page?.kind === 'offset' ? request.page.offset : 0;
    const limit =
      request.page?.limit ??
      schema.defaultPageLimit ??
      CONTENT_QUERY_DEFAULT_PAGE_LIMIT;
    const orderBy = orderByTerms(request.sort);
    const listed = await collection.list({
      select: projection,
      offset,
      limit,
      ...(orderBy
        ? { orderBy: orderBy.length === 1 ? orderBy[0] : orderBy }
        : {}),
      ...(where === undefined ? {} : { where }),
    });
    const truncation: TruncationLog = { fields: new Set() };
    const mapped = listed.map((row) => {
      const out: DataQueryRow = {};
      for (const field of projection) {
        const descriptor = descriptors.get(field);
        if (!descriptor) {
          return queryFail(
            `Content query returned an undeclared field: ${field}`,
            'DATA_QUERY_RESULT_NOT_ALLOWED',
          );
        }
        out[field] = toDeclaredValue(row[field], descriptor, truncation);
      }
      return out;
    });
    const bounded = boundRowBytes(
      mapped,
      schema.maxResultBytes ?? CONTENT_QUERY_MAX_RESULT_BYTES,
    );
    const rows: DataQueryRow[] = bounded.rows;
    truncated = bounded.truncated || truncation.fields.size > 0;
    if (bounded.truncated) {
      pushWarning(
        warnings,
        'Content query result was truncated to fit its maximum result bytes; request fewer fields or a smaller page.',
      );
    }
    if (truncation.fields.size > 0) {
      pushWarning(
        warnings,
        `Content query shortened over-long values in: ${[...truncation.fields].sort().join(', ')}.`,
      );
    }
    const total = await collection.count(countOptions);
    const page: DataQueryResult['page'] = {
      kind: 'offset',
      offset,
      limit,
      hasMore: bounded.truncated || offset + rows.length < total,
    };
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
        truncated,
      },
      request,
      schema,
    );
  }

  const total = await collection.count(countOptions);

  if (request.mode === 'facets') {
    const requested = request.facets ?? [];
    const sourceFacets = await collection.facets({
      fields: requested.map((facet) => ({
        field: facet.field,
        limit: facet.limit,
      })),
      ...(where === undefined ? {} : { where }),
    });
    const byField = new Map(sourceFacets.map((facet) => [facet.field, facet]));
    const facetTruncation: TruncationLog = { fields: new Set() };
    // Facet values go through the SAME shared byte budget the rows do: two text
    // facets of 200 distinct 4096-character values are inside every per-value
    // cap and still over the 1 MB result limit, which would make the normalizer
    // reject an otherwise valid response.
    let facetBudget = Math.max(
      0,
      (schema.maxResultBytes ?? CONTENT_QUERY_MAX_RESULT_BYTES) -
        RESULT_ENVELOPE_RESERVE_BYTES,
    );
    let facetBudgetExhausted = false;
    facets = requested.map((facet) => {
      const descriptor = descriptors.get(facet.field);
      if (!descriptor) {
        return queryFail(
          `Content query returned an undeclared facet: ${facet.field}`,
          'DATA_QUERY_RESULT_NOT_ALLOWED',
        );
      }
      const values = byField.get(facet.field)?.values ?? [];
      // The envelope around one facet: field name, brackets, and flags.
      facetBudget -= jsonByteLength(facet.field) + 48;
      const kept: Array<{
        value: string | number | boolean | null;
        count: number;
      }> = [];
      let boundedOut = false;
      for (const entry of values.slice(0, facet.limit)) {
        const value = toDeclaredValue(
          entry.value,
          descriptor,
          facetTruncation,
        ) as string | number | boolean | null;
        const cost = jsonByteLength({ value, count: entry.count }) + 1;
        if (cost > facetBudget) {
          boundedOut = true;
          facetBudgetExhausted = true;
          break;
        }
        facetBudget -= cost;
        kept.push({ value, count: entry.count });
      }
      return {
        field: facet.field,
        values: kept,
        // The collection bounds this grouping query in the database; an exactly
        // full page may have more values, so report conservatively.
        truncated: boundedOut || values.length >= facet.limit,
      };
    });
    if (facetTruncation.fields.size > 0) {
      pushWarning(
        warnings,
        `Content query shortened over-long values in: ${[...facetTruncation.fields].sort().join(', ')}.`,
      );
    }
    if (facetBudgetExhausted) {
      pushWarning(
        warnings,
        'Content query facets were truncated to fit their maximum result bytes; request fewer facets or a smaller facet limit.',
      );
    }
    truncated =
      facets.some((facet) => facet.truncated) ||
      facetTruncation.fields.size > 0;
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
      truncated,
    },
    request,
    schema,
  );
}
