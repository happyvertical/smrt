/**
 * Transport-neutral, bounded data-query contract (#2444).
 *
 * This module intentionally has no runtime code. The core package owns
 * normalization, policy enforcement, canonical fingerprints, and result
 * validation; browser, REST, MCP, WebMCP, ContentList, and report adapters
 * share these serializable shapes without importing a server runtime.
 *
 * Authority is deliberately absent. A query can name only adapter-declared
 * field ids and operators; tenant, principal, SQL, relationship paths, and
 * execution details belong to the authenticated adapter, never this envelope.
 */

/** JSON scalar values accepted in predicates, facets, and normalized rows. */
export type DataQueryScalar = string | number | boolean | null;

/** A stable, adapter-defined field identifier. It is never a property path. */
export type DataQueryFieldId = string;

/** Operators map to an adapter's allowlisted, typed predicate implementation. */
export type DataQueryFilterOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'notIn'
  | 'like';

/** One typed predicate. `in` and `notIn` require a non-empty value array. */
export interface DataQueryCondition {
  kind: 'condition';
  field: DataQueryFieldId;
  operator: DataQueryFilterOperator;
  value: DataQueryScalar | DataQueryScalar[];
}

/** Bounded, recursive filter expression with explicit boolean semantics. */
export type DataQueryFilter =
  | DataQueryCondition
  | {
      kind: 'all' | 'any';
      filters: DataQueryFilter[];
    }
  | {
      kind: 'not';
      filter: DataQueryFilter;
    };

export type DataQuerySortDirection = 'asc' | 'desc';

/** Deterministic sort precedence; earlier terms take precedence. */
export interface DataQuerySort {
  field: DataQueryFieldId;
  direction: DataQuerySortDirection;
}

/** Offset pagination is explicit so callers cannot smuggle arbitrary bounds. */
export interface DataQueryOffsetPage {
  kind: 'offset';
  offset: number;
  limit: number;
}

/** Cursor values are opaque to callers and bound to a normalized query. */
export interface DataQueryCursorPage {
  kind: 'cursor';
  after?: string;
  limit: number;
}

export type DataQueryPage = DataQueryOffsetPage | DataQueryCursorPage;

/** Read consistency requested by a caller; adapters decide whether they support it. */
export type DataQueryConsistencyMode = 'eventual' | 'snapshot';

export interface DataQueryConsistency {
  /** Prefer the adapter's most recently available data. */
  mode: DataQueryConsistencyMode;
  /** Optional RFC 3339 instant requested by a time-travel capable adapter. */
  asOf?: string;
}

/** A bounded request for one declared facet. */
export interface DataQueryFacetRequest {
  field: DataQueryFieldId;
  limit: number;
}

/**
 * Canonical data-query request.
 *
 * A request id correlates transport logs and results only; it is intentionally
 * excluded from the semantic query fingerprint. The query does not contain
 * authority, raw database expressions, property paths, functions, or a
 * transport-specific filter object.
 */
export interface DataQueryRequest {
  version: 1;
  requestId: string;
  mode: 'rows' | 'count' | 'facets';
  projection?: DataQueryFieldId[];
  filter?: DataQueryFilter;
  sort?: DataQuerySort[];
  page?: DataQueryPage;
  consistency?: DataQueryConsistency;
  facets?: DataQueryFacetRequest[];
}

/** An explicitly declared query field and its capability allowlist. */
export interface DataQueryFieldDescriptor {
  id: DataQueryFieldId;
  type: 'string' | 'number' | 'boolean' | 'datetime' | 'json';
  projectable?: boolean;
  sortable?: boolean;
  facetable?: boolean;
  filterOperators?: DataQueryFilterOperator[];
}

/**
 * Per-adapter execution policy. It is trusted adapter configuration, never
 * client input, and therefore carries the field allowlists the normalizer
 * applies to requests and returned rows.
 */
export interface DataQuerySchema {
  version: 1;
  identityField: DataQueryFieldId;
  fields: DataQueryFieldDescriptor[];
  defaultPageLimit?: number;
  maxPageLimit?: number;
  maxResultBytes?: number;
  defaultSort?: DataQuerySort[];
  supports?: {
    cursorPagination?: boolean;
    consistency?: boolean;
    facets?: boolean;
  };
}

/** How a returned total was obtained, including the absence of a total. */
export type DataQueryTotal =
  | {
      kind: 'exact';
      value: number;
      asOf?: string;
    }
  | {
      kind: 'estimated';
      value: number;
      asOf?: string;
    }
  | {
      kind: 'unavailable';
      reason?: string;
    };

/** Freshness metadata is declarative; it does not grant access to a snapshot. */
export interface DataQueryFreshness {
  state: 'fresh' | 'stale' | 'unknown';
  asOf?: string;
}

/** A bounded facet value/count pair. */
export interface DataQueryFacetValue {
  value: DataQueryScalar;
  count: number;
}

export interface DataQueryFacetResult {
  field: DataQueryFieldId;
  values: DataQueryFacetValue[];
  truncated: boolean;
}

/** Rows use JSON-safe values; adapters must project only declared fields. */
export type DataQueryRow = Record<string, unknown>;

/**
 * Normalized adapter result. `queryFingerprint` identifies the semantic query
 * (not the request id or page cursor), while pagination state stays explicit.
 */
export interface DataQueryResult {
  version: 1;
  requestId: string;
  queryFingerprint: string;
  identityField: DataQueryFieldId;
  rows: DataQueryRow[];
  page?:
    | {
        kind: 'offset';
        limit: number;
        offset: number;
        hasMore: boolean;
      }
    | {
        kind: 'cursor';
        limit: number;
        nextCursor?: string;
        hasMore: boolean;
      };
  total: DataQueryTotal;
  facets?: DataQueryFacetResult[];
  freshness: DataQueryFreshness;
  warnings: string[];
  truncated: boolean;
}
