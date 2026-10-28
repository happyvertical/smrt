/**
 * Principal-bound, read-only data-surface tools (#2447).
 *
 * This module deliberately does not know how an application discovers or
 * executes a surface.  Applications provide a small, server-side catalog and
 * executor; this package supplies the principal, allow-list, catalog/RBAC,
 * tenant, projection, ordering, and result-boundary enforcement around them.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { AITool } from '@happyvertical/ai';
import {
  createDataQueryFingerprint,
  DataQueryValidationError,
  DEFAULT_DATA_QUERY_RESULT_BYTES,
  MAX_DATA_QUERY_FILTERS,
  MAX_DATA_QUERY_REQUEST_BYTES,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  normalizeDataQuerySchema,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import type {
  DataQueryFieldDescriptor,
  DataQueryRequest,
  DataQueryResult,
  DataQueryRow,
  DataQuerySchema,
} from '@happyvertical/smrt-types';
import type { PrincipalRun } from './execute-as-principal.js';
import type { PrincipalTool, PrincipalToolContext } from './invoke-agent.js';

export const DATA_DISCOVER_TOOL_SLUG = 'data.discover';
export const DATA_INSPECT_TOOL_SLUG = 'data.inspect';
export const DATA_QUERY_TOOL_SLUG = 'data.query';

export const DATA_DISCOVER_FUNCTION_NAME = 'data-discover';
export const DATA_INSPECT_FUNCTION_NAME = 'data-inspect';
export const DATA_QUERY_FUNCTION_NAME = 'data-query';

export const DEFAULT_DATA_SURFACE_DEADLINE_MS = 5_000;
export const MAX_DATA_SURFACE_DEADLINE_MS = 30_000;

/** Longest summary-mode `description`, in characters, including the ellipsis. */
export const MAX_DATA_SURFACE_SUMMARY_DESCRIPTION_CHARS = 160;
/** Longest accepted string `rowCountHint` label, in characters. */
export const MAX_DATA_SURFACE_ROW_COUNT_HINT_CHARS = 32;

/**
 * How much `data.discover` returns per surface (#4329).
 *
 * - `full` (default): the complete descriptor `data.inspect` returns.
 * - `summary`: `id`, `label`, a one-line `description`, and `rowCountHint`
 *   only; the model calls `data.inspect` for fields, operators, and limits.
 */
export type DataSurfaceDiscoverDetail = 'full' | 'summary';

/**
 * Host-supplied size hint shown at discovery: a non-negative safe integer, or
 * a short single-line label such as `"~2k"` or `"1k-10k"` of at most
 * {@link MAX_DATA_SURFACE_ROW_COUNT_HINT_CHARS} characters. It is never
 * computed by querying the surface, so it reveals only what the host chooses.
 */
export type DataSurfaceRowCountHint = number | string;

/** Summary-mode `data.discover` entry. */
export interface DataSurfaceSummary {
  id: string;
  label: string;
  description?: string;
  rowCountHint?: DataSurfaceRowCountHint;
}

/** Declarative, non-authoritative metadata that a server-owned catalog may expose. */
export type DataSurfaceMetadataValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<string | number | boolean | null>;

export type DataSurfaceFieldMetadata = Readonly<
  Record<string, DataSurfaceMetadataValue>
>;

/** Surface-level metadata is descriptive only; it never enters query normalization. */
export type DataSurfaceMetadata = Readonly<
  Record<string, DataSurfaceMetadataValue>
>;

/** A data field plus server-owned visibility policy annotations. */
export interface DataSurfaceField extends DataQueryFieldDescriptor {
  sensitive?: boolean;
  readPermission?: string;
  metadata?: DataSurfaceFieldMetadata;
}

/** Server-owned schema; policy annotations never cross the core query boundary. */
export interface DataSurfaceSchema extends Omit<DataQuerySchema, 'fields'> {
  fields: DataSurfaceField[];
}

/** A server-owned data source. Never construct this from model/tool input. */
export interface DataSurfaceDefinition {
  /** Stable opaque id presented to the model. */
  id: string;
  /** Permission-catalog collection used for the read gate. */
  collection: string;
  /** Optional backing SMRT class, useful to registry-backed executors. */
  className?: string;
  label?: string;
  description?: string;
  /** Safe catalog metadata, returned only after the read gate succeeds. */
  metadata?: DataSurfaceMetadata;
  /**
   * Optional host-supplied size hint, returned by discovery and inspection
   * after the read gate succeeds. Invalid values are omitted, never fatal.
   */
  rowCountHint?: DataSurfaceRowCountHint;
  schema: DataSurfaceSchema;
  /** Optional surface-specific executor. */
  execute?: DataSurfaceExecutor;
}

export interface DataSurfacePrincipal {
  /** The authenticated execution principal, copied from the live run. */
  userId: string;
  /** The authenticated tenant scope, copied from the live run. */
  tenantId: string | null;
}

export interface DataSurfaceExecutionContext {
  run: PrincipalRun;
  principal: DataSurfacePrincipal;
  db?: SmrtClassOptions['db'];
  /** Signal for adapters that can cancel database work. */
  signal: AbortSignal;
}

export type DataSurfaceExecutorResult =
  | DataQueryResult
  | DataQueryRow[]
  | {
      rows?: DataQueryRow[];
      total?: DataQueryResult['total'];
      facets?: DataQueryResult['facets'];
      freshness?: DataQueryResult['freshness'];
      warnings?: string[];
      truncated?: boolean;
      nextCursor?: string;
      hasMore?: boolean;
    };

export type DataSurfaceExecutor = (
  surface: DataSurfaceDefinition,
  request: DataQueryRequest,
  context: DataSurfaceExecutionContext,
) => Promise<DataSurfaceExecutorResult>;

export interface DataSurfaceAuditEntry {
  action: 'discover' | 'inspect' | 'query';
  surfaceId?: string;
  requestId?: string;
  userId: string;
  tenantId: string | null;
  rowCount?: number;
  truncated?: boolean;
  /** Set on a refused call (#4387); `reason` says why. */
  denied?: boolean;
  reason?: DataSurfaceDenialReason;
}

/** A data tool action. */
export type DataSurfaceAction = 'discover' | 'inspect' | 'query';

/**
 * Why a data tool call was refused (#4387), value-free:
 * - `not_visible`: the surface does not exist for this principal, or the
 *   request named no visible surface (indistinguishable on purpose);
 * - `action_not_permitted`: the surface is visible for a lesser action
 *   (discover / inspect) but not for this one;
 * - `tool_not_allowed`: the tool itself is not on the principal's
 *   allow-list (no surface involved).
 */
export type DataSurfaceDenialReason =
  | 'not_visible'
  | 'action_not_permitted'
  | 'tool_not_allowed';

/** What the host's {@link DataSurfaceToolsOptions.onDenied} sink receives. */
export interface DataSurfaceDeniedEntry {
  action: DataSurfaceAction;
  /** Only for a surface visible to the principal; never an unknown id. */
  surfaceId?: string;
  /** The model-supplied `request.requestId`, when it sent one (≤ 256 chars). */
  requestId?: string;
  /**
   * The run's user. Omitted when the run has none (success entries cannot
   * occur then: they resolve the same principal and refuse without a user).
   */
  userId?: string;
  tenantId: string | null;
  reason: DataSurfaceDenialReason;
}

export type DataSurfaceDeniedSink = (
  entry: DataSurfaceDeniedEntry,
) => void | Promise<void>;

/** Passed to a function catalog: the action it is evaluated for (#4387). */
export interface DataSurfaceCatalogContext {
  action: DataSurfaceAction;
}

export type DataSurfaceAuditSink = (
  entry: DataSurfaceAuditEntry,
) => void | Promise<void>;

type DataSurfaceAuditInput = Omit<DataSurfaceAuditEntry, 'userId' | 'tenantId'>;

export interface DataSurfaceToolsOptions {
  /** Server-owned catalog. A function is evaluated per authenticated run. */
  surfaces:
    | readonly DataSurfaceDefinition[]
    | ((
        run: PrincipalRun,
        context: DataSurfaceCatalogContext,
      ) =>
        | readonly DataSurfaceDefinition[]
        | Promise<readonly DataSurfaceDefinition[]>);
  /** Shared executor used when a definition does not provide one. */
  execute?: DataSurfaceExecutor;
  /** Audit sink for individual tool actions. */
  audit?: DataSurfaceAuditSink;
  /** Deadline for an adapter call. Defaults to five seconds. */
  deadlineMs?: number;
  /** Receives detailed server-side failures; never surfaced to the model. */
  onFailure?: DataSurfaceFailureSink;
  /**
   * Per-surface detail of `data.discover`. Defaults to `'full'`; `'summary'`
   * returns {@link DataSurfaceSummary} entries for two-step discovery with
   * `data.inspect`. Permissions, audit, and failures are identical in both.
   */
  discoverDetail?: DataSurfaceDiscoverDetail;

  /**
   * Receives every refused data tool call (#4387) — allow-list refusals and
   * surface denials — with the action, the surface id only when visible, the
   * principal and a value-free reason. Request-validation errors (including
   * hidden fields) are not denials and never reach it. A separate sink from `onFailure`
   * because a denial is an authorization outcome, not a server failure: it
   * carries no error object, and hosts route it to access logs instead of
   * incident alerts. A throw is ignored.
   */
  onDenied?: DataSurfaceDeniedSink;
}

export interface DataSurfaceFailureEntry {
  action: 'discover' | 'inspect' | 'query';
  surfaceId?: string;
  requestId?: string;
  userId: string;
  tenantId: string | null;
  error: unknown;
}

export type DataSurfaceFailureSink = (
  entry: DataSurfaceFailureEntry,
) => void | Promise<void>;

export class DataSurfaceDeniedError extends Error {
  readonly status = 403;

  constructor() {
    // Deliberately generic: callers must not learn whether a surface exists.
    super('Data surface is not available.');
    this.name = 'DataSurfaceDeniedError';
  }
}

/**
 * A surface the principal can see for a lesser action (discover / inspect)
 * but not for this one (#4387). Unlike {@link DataSurfaceDeniedError} it names
 * the action and the surface — only one the principal can already see — so
 * the model stops retrying. A surface the principal cannot see at all keeps
 * the generic denial.
 */
export class DataSurfaceActionDeniedError extends DataSurfaceDeniedError {
  readonly code = 'DATA_SURFACE_ACTION_DENIED';

  constructor(action: 'inspect' | 'query', surfaceId: string) {
    super();
    this.message = `${action === 'query' ? 'Querying' : 'Inspecting'} '${surfaceId}' is not permitted for you; answer without this data or ask an administrator.`;
    this.name = 'DataSurfaceActionDeniedError';
  }
}

export class DataSurfaceDeadlineError extends Error {
  readonly status = 504;

  constructor() {
    super('Data surface query exceeded its execution deadline.');
    this.name = 'DataSurfaceDeadlineError';
  }
}

/** Adapter output was not in the requested deterministic order. */
export class DataSurfaceResultOrderError extends Error {
  readonly status = 502;

  constructor() {
    // Do not include field/row values in the public error.
    super('Data surface returned results in an invalid order.');
    this.name = 'DataSurfaceResultOrderError';
  }
}

/** Stable public failure for executor and result-boundary errors. */
export class DataSurfaceQueryError extends Error {
  readonly status = 502;
  readonly code = 'DATA_SURFACE_QUERY_FAILED';

  constructor() {
    super('Data surface query failed.');
    this.name = 'DataSurfaceQueryError';
  }
}

// Audit failures are reported at the point where the audit sink rejects. Keep
// the wrapped public error marked so the query boundary does not report it a
// second time when it unwinds through the outer executor catch.
const reportedFailureErrors = new WeakSet<object>();

/**
 * A caller's query request was malformed or named something the surface does
 * not offer.
 *
 * The message says what was wrong and what is allowed instead, so an agent can
 * correct its next call rather than retry blind. It is built only from the
 * caller's own input and the schema already visible to that caller: a hidden
 * (`sensitive`/`readPermission`) field is absent from that schema, so naming
 * one produces exactly the message a field that does not exist produces, and
 * the allowed-value lists never include it.
 */
export class DataSurfaceRequestError extends Error {
  readonly status = 400;
  readonly code = 'DATA_SURFACE_REQUEST_INVALID';
  /** The underlying `DataQueryValidationError` code, when there was one. */
  readonly reason?: string;

  constructor(
    message = 'Data surface query request is invalid.',
    reason?: string,
  ) {
    super(message);
    this.name = 'DataSurfaceRequestError';
    if (reason !== undefined) this.reason = reason;
  }
}

/** Compact request grammar appended to structural request errors. */
const DATA_QUERY_REQUEST_SHAPE_HINT =
  'Request shape: {"mode":"rows"|"count"|"facets", "projection":[field], ' +
  '"filter":{"kind":"condition","field":f,"operator":op,"value":v} | ' +
  '{"kind":"condition","field":f,"operator":"isNull"|"isNotNull"} | ' +
  '{"kind":"all"|"any","filters":[filter]} | {"kind":"not","filter":filter}, ' +
  '"sort":[{"field":f,"direction":"asc"|"desc"}], ' +
  '"page":{"kind":"offset","offset":0,"limit":n}, "facets":[{"field":f,"limit":n}]}. ' +
  'projection/sort/page are for rows mode only; facets for facets mode only. ' +
  'Datetime values are RFC 3339 instants such as 2026-09-01T00:00:00Z. ' +
  'Call data.inspect for the fields and operators this surface accepts.';

/**
 * Codes an adapter/executor may raise for a problem with the caller's request
 * (as opposed to its own result). They cross the boundary as a 400 with the
 * adapter's public message instead of collapsing into `DataSurfaceQueryError`.
 */
const EXECUTOR_REQUEST_ERROR_CODES = new Set([
  'DATA_QUERY_VALUE_INVALID',
  'DATA_QUERY_OPERATOR_NOT_ALLOWED',
  'DATA_QUERY_UNSUPPORTED',
]);

/**
 * Core error codes a malformed filter raises — the only failures that can
 * stem from a null-test attempt, so the only ones that carry its hint.
 */
const NULL_HINT_ERROR_CODES: ReadonlySet<string> = new Set([
  'INVALID_DATA_QUERY',
  'FORBIDDEN_DATA_QUERY',
  'DATA_QUERY_OPERATOR_NOT_ALLOWED',
  'DATA_QUERY_VALUE_NOT_ALLOWED',
]);

function fieldList(
  schema: DataQuerySchema,
  predicate: (field: DataQuerySchema['fields'][number]) => boolean,
): string[] {
  return schema.fields.filter(predicate).map((field) => field.id);
}

function listOrNone(label: string, ids: readonly string[], none: string) {
  return ids.length > 0 ? `${label}: ${ids.join(', ')}.` : none;
}

/** The first condition in a raw filter whose operator its field does not allow. */
function disallowedCondition(
  filter: unknown,
  schema: DataQuerySchema,
  depth = 0,
): { field: string; allowed: readonly string[] } | undefined {
  if (!isRecord(filter) || depth > 16) return undefined;
  if (filter.kind === 'condition' && typeof filter.field === 'string') {
    const descriptor = schema.fields.find((field) => field.id === filter.field);
    const allowed = descriptor?.filterOperators ?? [];
    return descriptor && !allowed.includes(filter.operator as never)
      ? { field: filter.field, allowed }
      : undefined;
  }
  const children = Array.isArray(filter.filters)
    ? filter.filters
    : [filter.filter];
  for (const child of children) {
    const found = disallowedCondition(child, schema, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * A one-line valid `data.query` call for this surface (#4378), appended to
 * every request error so a small model can copy the shape. Built only from
 * the surface id and the caller-visible schema (field ids, operators) with
 * `<value>` placeholders — never from the caller's own arguments. The mode
 * follows the failed request's mode (count when unknown).
 */
function validQueryExample(
  surfaceId: string,
  schema: DataQuerySchema,
  request: unknown,
): string {
  const mode =
    isRecord(request) && (request.mode === 'rows' || request.mode === 'facets')
      ? request.mode
      : 'count';
  const filterable = schema.fields.filter(
    (field) => (field.filterOperators?.length ?? 0) > 0,
  );
  const inField = filterable.find((field) =>
    field.filterOperators?.includes('in'),
  );
  const field = inField ?? filterable[0];
  const nullTest = nullTestAttempt(request, schema);
  const firstOperator = field?.filterOperators?.[0];
  const filter = nullTest
    ? `,"filter":${nullTestFilter(nullTest)}`
    : field
      ? inField
        ? `,"filter":{"kind":"condition","field":${JSON.stringify(field.id)},"operator":"in","value":["<value>","<value>"]}`
        : `,"filter":{"kind":"condition","field":${JSON.stringify(field.id)},"operator":${JSON.stringify(firstOperator)}${
            firstOperator && NULL_TEST_OPERATORS.has(firstOperator)
              ? ''
              : ',"value":"<value>"'
          }}`
      : '';
  let body: string;
  if (mode === 'facets') {
    const facet = schema.fields.find((candidate) => candidate.facetable);
    body = facet
      ? `"mode":"facets","facets":[{"field":${JSON.stringify(facet.id)},"limit":10}]`
      : `"mode":"count"${filter}`;
  } else if (mode === 'rows') {
    body = `"mode":"rows","projection":[${JSON.stringify(schema.identityField)}]${filter},"page":{"kind":"offset","offset":0,"limit":${Math.min(10, schema.maxPageLimit ?? 10)}}`;
  } else {
    body = `"mode":"count"${filter}`;
  }
  return `Valid example: {"surfaceId":${JSON.stringify(surfaceId)},"request":{${body}}}`;
}

const FILTER_KINDS = new Set(['condition', 'all', 'any', 'not']);

/** Null tests (#4448): condition operators that take no value. */
const NULL_TEST_OPERATORS: ReadonlySet<string> = new Set([
  'isNull',
  'isNotNull',
]);

/** Strings a model writes when it means "no value" rather than the literal text. */
const NULL_LIKE_TEXT = /^\s*(?:null|nil|none|undefined|empty|missing)?\s*$/i;

/**
 * Operator or kind names a model reaches for when it wants a null test. Any
 * name in this vocabulary that the field does not declare is read as one.
 */
const NULL_TEST_NAME =
  /^(?:is_?)?(?:not_?)?(?:null|nil|none|empty|missing|blank|exists?|present|defined|undefined|set|unset)$/i;

/** Names whose intent is "has a value", so the example uses `isNotNull`. */
const NOT_NULL_INTENT =
  /not_?(?:null|nil|none|empty|missing|blank)|^(?:is_?)?(?:exists?|present|defined|set)$/i;

interface NullTestAttempt {
  field: string;
  operator: 'isNull' | 'isNotNull';
}

/**
 * The first filter node that looks like an attempt to test a nullable field
 * for an empty value (#4448): `eq`/`ne` with `null`, `"null"`, `""`, or `[]`;
 * a `not` filter naming a `field` directly; or a kind/operator such as
 * `"exists"` or `"is_null"`. Only fields that declare `isNull` in the visible
 * schema qualify, and only the schema's field id and a fixed operator ever
 * reach the message — never caller text.
 */
function nullTestAttempt(
  request: unknown,
  schema: DataQuerySchema,
): NullTestAttempt | undefined {
  let found: NullTestAttempt | undefined;
  // `negated` counts enclosing `not` filters, so `not(eq "null")` suggests
  // isNotNull rather than its opposite.
  const walk = (filter: unknown, depth: number, negated: boolean) => {
    if (found || !isRecord(filter) || depth > 16) return;
    const descriptor =
      typeof filter.field === 'string'
        ? schema.fields.find((field) => field.id === filter.field)
        : undefined;
    if (descriptor?.filterOperators?.includes('isNull')) {
      const operator =
        typeof filter.operator === 'string' ? filter.operator : undefined;
      const kind = typeof filter.kind === 'string' ? filter.kind : undefined;
      const value = filter.value;
      const nullLikeValue =
        value === undefined ||
        value === null ||
        (typeof value === 'string' && NULL_LIKE_TEXT.test(value)) ||
        (Array.isArray(value) && value.length === 0);
      const declared = (name: string | undefined) =>
        name !== undefined &&
        (descriptor.filterOperators as readonly string[]).includes(name);
      const nullName = (name: string | undefined) =>
        name !== undefined && !declared(name) && NULL_TEST_NAME.test(name);
      const attempted =
        (kind === 'condition' &&
          (operator === 'eq' || operator === 'ne') &&
          nullLikeValue) ||
        (kind === 'not' && filter.filter === undefined) ||
        nullName(kind) ||
        nullName(operator);
      if (attempted) {
        const notNull =
          operator === 'ne' ||
          [kind, operator].some(
            (name) => name !== undefined && NOT_NULL_INTENT.test(name),
          );
        // A `not` that names the field itself negates its own operator, if any.
        const flip = negated !== (kind === 'not' && operator !== undefined);
        found = {
          field: descriptor.id,
          operator: notNull !== flip ? 'isNotNull' : 'isNull',
        };
        return;
      }
    }
    const children = Array.isArray(filter.filters)
      ? filter.filters
      : [filter.filter];
    const childNegated = filter.kind === 'not' ? !negated : negated;
    for (const child of children) walk(child, depth + 1, childNegated);
  };
  walk(isRecord(request) ? request.filter : undefined, 0, false);
  return found;
}

function nullTestFilter(attempt: NullTestAttempt): string {
  return `{"kind":"condition","field":${JSON.stringify(attempt.field)},"operator":"${attempt.operator}"}`;
}

/** The hint naming the null-test operators for a detected attempt (#4448). */
function nullTestHint(request: unknown, schema: DataQuerySchema): string {
  const attempt = nullTestAttempt(request, schema);
  if (!attempt) return '';
  return (
    `To test whether ${attempt.field} is empty, use operator "isNull" with no value ` +
    `(or "isNotNull" for rows that have one): ${nullTestFilter(attempt)}. `
  );
}

/**
 * A targeted hint when a filter's `kind` is not one of the four (#4378):
 * small models write `"kind":"in"` or `"kind":"or"`. Names a misused
 * operator only from the fixed operator vocabulary, never free model text.
 */
function filterKindHint(request: unknown): string {
  const seen = new Set<string>();
  const walk = (filter: unknown, depth: number) => {
    if (!isRecord(filter) || depth > 16) return;
    if (typeof filter.kind === 'string' && !FILTER_KINDS.has(filter.kind)) {
      seen.add(filter.kind);
    }
    const children = Array.isArray(filter.filters)
      ? filter.filters
      : [filter.filter];
    for (const child of children) walk(child, depth + 1);
  };
  walk(isRecord(request) ? request.filter : undefined, 0);
  if (seen.size === 0) return '';
  const operators = [...seen].filter((kind) =>
    (DATA_QUERY_OPERATORS as readonly string[]).includes(kind),
  );
  const logical = [...seen].some((kind) => kind === 'or' || kind === 'and');
  return (
    'A filter kind is condition, all, any or not. ' +
    (operators.length > 0
      ? `${operators.join(', ')} is an operator: use {"kind":"condition","field":f,"operator":${JSON.stringify(operators[0])}${
          NULL_TEST_OPERATORS.has(operators[0]) ? '' : ',"value":v'
        }}. `
      : '') +
    (logical
      ? 'For OR use {"kind":"any","filters":[...]}; for AND use {"kind":"all","filters":[...]}. '
      : '')
  );
}

/**
 * Turn a core `DataQueryValidationError` into an actionable
 * `DataSurfaceRequestError`: the original reason plus what the visible schema
 * does allow in its place, and a one-line valid example for the surface.
 */
function explainRequestError(
  error: DataQueryValidationError,
  schema: DataQuerySchema,
  request: unknown,
  surfaceId: string,
): DataSurfaceRequestError {
  const reason = error.publicMessage.replace(/\.?$/, '.');
  // A rejected filter that looks like a null test on a nullable field points
  // at isNull/isNotNull first (#4448); other request errors keep their hint.
  const nullHint = NULL_HINT_ERROR_CODES.has(error.code)
    ? nullTestHint(request, schema)
    : '';
  let hint: string;
  switch (error.code) {
    case 'DATA_QUERY_FIELD_NOT_ALLOWED':
      hint = listOrNone(
        'Filterable fields',
        fieldList(schema, (field) => (field.filterOperators?.length ?? 0) > 0),
        'This surface has no filterable fields; omit filter.',
      );
      break;
    case 'DATA_QUERY_OPERATOR_NOT_ALLOWED': {
      const found = isRecord(request)
        ? disallowedCondition(request.filter, schema)
        : undefined;
      hint = found
        ? found.allowed.length > 0
          ? `Allowed operators for ${found.field}: ${found.allowed.join(', ')}.`
          : `${found.field} cannot be filtered.`
        : 'Call data.inspect for each field’s filterOperators.';
      break;
    }
    case 'DATA_QUERY_PROJECTION_NOT_ALLOWED':
      hint = listOrNone(
        'Projectable fields',
        fieldList(
          schema,
          (field) =>
            field.projectable !== false || field.id === schema.identityField,
        ),
        'Omit projection.',
      );
      break;
    case 'DATA_QUERY_SORT_NOT_ALLOWED':
      hint = listOrNone(
        'Sortable fields',
        fieldList(
          schema,
          (field) =>
            field.sortable === true || field.id === schema.identityField,
        ),
        'Omit sort.',
      );
      break;
    case 'DATA_QUERY_FACET_NOT_ALLOWED':
      hint = listOrNone(
        'Facetable fields',
        fieldList(schema, (field) => field.facetable === true),
        'This surface has no facetable fields; use mode "count" or "rows".',
      );
      break;
    case 'DATA_QUERY_VALUE_NOT_ALLOWED':
      hint = 'Call data.inspect for each field’s values and their labels.';
      break;
    case 'DATA_QUERY_UNSUPPORTED': {
      const supports = schema.supports ?? {};
      hint = `This surface supports offset paging${
        supports.cursorPagination ? ', cursor paging' : ''
      }${supports.facets ? ', facets' : ''}${
        supports.consistency ? ', consistency options' : ''
      }.`;
      break;
    }
    default:
      hint = `${filterKindHint(request)}${DATA_QUERY_REQUEST_SHAPE_HINT}`;
  }
  return new DataSurfaceRequestError(
    `${reason} ${nullHint}${hint} ${validQueryExample(surfaceId, schema, request)}`,
    error.code,
  );
}

function normalizeSurfaceRequest(
  value: unknown,
  schema: DataQuerySchema,
  surfaceId: string,
): DataQueryRequest {
  try {
    return normalizeDataQueryRequest(value, schema);
  } catch (error) {
    if (error instanceof DataQueryValidationError) {
      throw explainRequestError(error, schema, value, surfaceId);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDataQueryRows(value: unknown[]): value is DataQueryRow[] {
  return value.every(isRecord);
}

function dataQueryRowsOrThrow(value: unknown[]): DataQueryRow[] {
  if (!isDataQueryRows(value)) throw new DataSurfaceQueryError();
  return value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function principalFromRun(run: PrincipalRun): DataSurfacePrincipal {
  const userId = run.context.userId;
  if (!userId) throw new DataSurfaceDeniedError();
  return { userId, tenantId: run.context.tenantId };
}

function coreSchema(schema: DataSurfaceSchema): DataQuerySchema {
  return {
    ...schema,
    fields: schema.fields.map(
      ({
        sensitive: _sensitive,
        readPermission: _readPermission,
        metadata: _metadata,
        ...field
      }) => field,
    ),
  };
}

function visibleSchema(
  schema: DataSurfaceSchema,
  run: PrincipalRun,
): DataQuerySchema {
  const fields = schema.fields.filter((field) => {
    if (field.sensitive === true) return false;
    const readPermission = field.readPermission;
    if (readPermission && !run.permissions.includes(readPermission)) {
      return false;
    }
    return true;
  });
  if (!fields.some((field) => field.id === schema.identityField)) {
    throw new DataSurfaceDeniedError();
  }
  return normalizeDataQuerySchema(coreSchema({ ...schema, fields }));
}

/**
 * Control, format (bidi overrides, zero-width, BOM, soft hyphen, tag
 * characters), and line/paragraph-separator code points: never valid in a hint.
 */
const ROW_COUNT_HINT_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
/** Separators plus Unicode "blank" letters/symbols that render as nothing. */
const INVISIBLE_CHARACTERS = /[\p{Z}\u115F\u1160\u2800\u3164\uFFA0]/gu;

/**
 * Validate a host-supplied row-count hint: a non-negative safe integer, or a
 * trimmed single-line label of 1-32 characters with no control, format, or
 * separator characters and at least one visible character. Anything else is
 * `undefined`.
 */
export function normalizeDataSurfaceRowCountHint(
  value: unknown,
): DataSurfaceRowCountHint | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  // Check the raw value: `trim()` would silently drop an edge U+FEFF/U+2028.
  if (typeof value !== 'string' || ROW_COUNT_HINT_FORBIDDEN.test(value)) {
    return undefined;
  }
  const label = value.trim();
  if (
    label.replace(INVISIBLE_CHARACTERS, '').length === 0 ||
    Array.from(label).length > MAX_DATA_SURFACE_ROW_COUNT_HINT_CHARS
  ) {
    return undefined;
  }
  return label;
}

function rowCountHintEntry(surface: DataSurfaceDefinition): {
  rowCountHint?: DataSurfaceRowCountHint;
} {
  const rowCountHint = normalizeDataSurfaceRowCountHint(surface.rowCountHint);
  return rowCountHint === undefined ? {} : { rowCountHint };
}

/** CRLF, LF, VT, FF, CR, NEL, and the Unicode line/paragraph separators. */
const SUMMARY_LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;
/** Format characters: bidi controls, zero-width characters, BOM, soft hyphen. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/** Remaining control characters (tabs, NUL, ESC, ...), each made a space. */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * First non-empty line of model-facing summary text, with format characters
 * removed and control characters replaced by spaces.
 */
function firstSummaryLine(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  for (const rawLine of text.split(SUMMARY_LINE_BREAK)) {
    const line = rawLine
      .replace(FORMAT_CHARACTERS, '')
      .replace(CONTROL_CHARACTERS, ' ')
      .trim();
    if (line.length > 0) return line;
  }
  return undefined;
}

/** Summary description: its first non-empty line, bounded with an ellipsis. */
function summaryDescription(description: unknown): string | undefined {
  const line = firstSummaryLine(description);
  if (line === undefined) return undefined;
  const characters = Array.from(line);
  if (characters.length <= MAX_DATA_SURFACE_SUMMARY_DESCRIPTION_CHARS) {
    return line;
  }
  return `${characters
    .slice(0, MAX_DATA_SURFACE_SUMMARY_DESCRIPTION_CHARS - 1)
    .join('')
    .trimEnd()}\u2026`;
}

function summary(surface: DataSurfaceDefinition): DataSurfaceSummary {
  const description = summaryDescription(surface.description);
  return {
    id: surface.id,
    label: firstSummaryLine(surface.label) ?? surface.id,
    ...(description ? { description } : {}),
    ...rowCountHintEntry(surface),
  };
}

function descriptor(surface: DataSurfaceDefinition, schema: DataQuerySchema) {
  const metadataByFieldId = new Map(
    surface.schema.fields.map((field) => [field.id, field.metadata]),
  );
  return {
    id: surface.id,
    label: surface.label ?? surface.id,
    ...(surface.description ? { description: surface.description } : {}),
    ...rowCountHintEntry(surface),
    ...(surface.metadata ? { metadata: surface.metadata } : {}),
    collection: surface.collection,
    identityField: schema.identityField,
    fields: schema.fields.map((field) => ({
      id: field.id,
      type: field.type,
      projectable: field.projectable !== false,
      sortable: field.sortable === true,
      facetable: field.facetable === true,
      filterOperators: [...(field.filterOperators ?? [])].sort(),
      ...(field.values
        ? {
            values: field.values.map((entry) => ({ ...entry })),
            valuesEnforced: field.valuesEnforced !== false,
          }
        : {}),
      ...(metadataByFieldId.get(field.id)
        ? { metadata: metadataByFieldId.get(field.id) }
        : {}),
    })),
    supports: schema.supports ?? {},
    limits: {
      defaultPageLimit: schema.defaultPageLimit,
      maxPageLimit: schema.maxPageLimit,
      maxResultBytes: schema.maxResultBytes,
    },
  };
}

async function availableSurfaces(
  options: DataSurfaceToolsOptions,
  run: PrincipalRun,
  action: DataSurfaceAction,
): Promise<Array<{ surface: DataSurfaceDefinition; schema: DataQuerySchema }>> {
  const configured =
    typeof options.surfaces === 'function'
      ? await options.surfaces(run, { action })
      : options.surfaces;
  const result: Array<{
    surface: DataSurfaceDefinition;
    schema: DataQuerySchema;
  }> = [];
  for (const surface of configured) {
    if (
      !surface ||
      !nonEmptyString(surface.id) ||
      !nonEmptyString(surface.collection)
    )
      continue;
    try {
      // A missing catalog permission is intentionally indistinguishable from a
      // missing surface.  The allow-list gate is checked before this function.
      await run.assertOperation(surface.collection, 'read');
      result.push({ surface, schema: visibleSchema(surface.schema, run) });
    } catch {
      // Do not leak unauthorized surface ids, schemas, or permission errors.
    }
  }
  return result.sort((left, right) =>
    left.surface.id === right.surface.id
      ? 0
      : left.surface.id < right.surface.id
        ? -1
        : 1,
  );
}

function findSurface(
  surfaces: Array<{ surface: DataSurfaceDefinition; schema: DataQuerySchema }>,
  id: unknown,
) {
  return surfaces.find((entry) => entry.surface.id === id);
}

function sortRows(
  rows: DataQueryRow[],
  request: DataQueryRequest,
  schema: DataQuerySchema,
): DataQueryRow[] {
  const terms = request.sort ?? [];
  return [...rows].sort((left, right) =>
    compareRows(left, right, terms, schema),
  );
}

function compareDataValues(
  left: unknown,
  right: unknown,
  type: DataQuerySchema['fields'][number]['type'],
): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (type === 'number') return Number(left) - Number(right);
  if (type === 'datetime') {
    const leftTime = Date.parse(String(left));
    const rightTime = Date.parse(String(right));
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
      return leftTime - rightTime;
    }
  }
  if (type === 'boolean') return Number(Boolean(left)) - Number(Boolean(right));
  const leftString = String(left);
  const rightString = String(right);
  return leftString === rightString ? 0 : leftString < rightString ? -1 : 1;
}

function compareRows(
  left: DataQueryRow,
  right: DataQueryRow,
  terms: readonly NonNullable<DataQueryRequest['sort']>[number][],
  schema: DataQuerySchema,
): number {
  for (const term of terms) {
    const type =
      schema.fields.find((field) => field.id === term.field)?.type ?? 'string';
    const result = compareDataValues(left[term.field], right[term.field], type);
    if (result !== 0) return term.direction === 'desc' ? -result : result;
  }
  const identityType =
    schema.fields.find((field) => field.id === schema.identityField)?.type ??
    'string';
  return compareDataValues(
    left[schema.identityField],
    right[schema.identityField],
    identityType,
  );
}

function isCanonicalOrder(
  rows: DataQueryRow[],
  request: DataQueryRequest,
  schema: DataQuerySchema,
): boolean {
  const terms = request.sort ?? [];
  for (let index = 1; index < rows.length; index += 1) {
    if (compareRows(rows[index - 1], rows[index], terms, schema) > 0) {
      return false;
    }
  }
  return true;
}

function projectionForResult(request: DataQueryRequest): string[] {
  return request.projection ?? [];
}

function externalValidationRequest(
  request: DataQueryRequest,
  schema: DataQuerySchema,
): DataQueryRequest {
  if (
    request.mode !== 'rows' ||
    !request.projection ||
    request.projection.length <= MAX_DATA_QUERY_FILTERS
  ) {
    return request;
  }
  return {
    ...request,
    projection: request.projection.filter(
      (field) => field !== schema.identityField,
    ),
  };
}

function canonicalRequestValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequestValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalRequestValue(value[key])]),
    );
  }
  return value;
}

/**
 * Create the fingerprint for the already-normalized request passed to a
 * surface executor. This supports internal projections beyond core's public
 * 50-field projection limit; callers must use the exact request received.
 */
export function createDataSurfaceQueryFingerprint(
  request: DataQueryRequest,
): string {
  const { requestId: _requestId, page: _page, ...semanticQuery } = request;
  return `dq1_${createHash('sha256')
    .update(JSON.stringify(canonicalRequestValue(semanticQuery)))
    .digest('base64url')}`;
}

function shorthandResultCandidate(
  request: DataQueryRequest,
  schema: DataQuerySchema,
  rawRecord: Record<string, unknown> | undefined,
  rows: readonly unknown[],
): Record<string, unknown> {
  const rawPage = isRecord(rawRecord?.page) ? rawRecord.page : undefined;
  const explicitHasMore =
    typeof rawPage?.hasMore === 'boolean'
      ? rawPage.hasMore
      : typeof rawRecord?.hasMore === 'boolean'
        ? rawRecord.hasMore
        : undefined;
  const nextCursor =
    typeof rawPage?.nextCursor === 'string'
      ? rawPage.nextCursor
      : typeof rawRecord?.nextCursor === 'string'
        ? rawRecord.nextCursor
        : undefined;
  if (
    request.page &&
    rows.length === request.page.limit &&
    explicitHasMore === undefined &&
    !nextCursor
  ) {
    // An exact-limit shorthand page may have more rows. Require the adapter
    // to provide continuation metadata instead of falsely declaring a final
    // page and silently truncating a result set.
    throw new DataSurfaceQueryError();
  }
  return {
    version: 1,
    requestId: request.requestId,
    queryFingerprint: createDataQueryFingerprint(request, schema),
    identityField: schema.identityField,
    rows,
    ...(request.page
      ? {
          page:
            request.page.kind === 'offset'
              ? {
                  kind: 'offset',
                  offset: request.page.offset,
                  limit: request.page.limit,
                  hasMore: explicitHasMore ?? Boolean(nextCursor),
                }
              : {
                  kind: 'cursor',
                  limit: request.page.limit,
                  hasMore: explicitHasMore ?? Boolean(nextCursor),
                  ...(nextCursor ? { nextCursor } : {}),
                },
        }
      : {}),
    total: rawRecord?.total ?? { kind: 'unavailable' },
    ...(rawRecord?.facets ? { facets: rawRecord.facets } : {}),
    freshness: rawRecord?.freshness ?? { state: 'unknown' },
    warnings: Array.isArray(rawRecord?.warnings) ? rawRecord.warnings : [],
    truncated: rawRecord?.truncated === true,
  };
}

function normalizeWideRows(
  rawRecord: Record<string, unknown> | undefined,
  rawRows: unknown[],
  request: DataQueryRequest,
  resultRequest: DataQueryRequest,
  schema: DataQuerySchema,
  internal: { request: DataQueryRequest; schema: DataQuerySchema },
): DataQueryResult {
  const hasVersionedResult =
    rawRecord !== undefined && Object.hasOwn(rawRecord, 'version');
  if (
    hasVersionedResult &&
    (rawRecord.version !== 1 ||
      rawRecord.requestId !== internal.request.requestId ||
      rawRecord.identityField !== internal.schema.identityField ||
      rawRecord.queryFingerprint !==
        createDataSurfaceQueryFingerprint(internal.request))
  ) {
    throw new DataSurfaceQueryError();
  }
  const requestedFields = resultRequest.projection ?? [schema.identityField];
  const sortOnlyFields = new Set(
    (request.sort ?? [])
      .map((term) => term.field)
      .filter((field) => !requestedFields.includes(field)),
  );
  const chunkSize = MAX_DATA_QUERY_FILTERS - 1;
  const chunks: DataQueryResult[] = [];
  for (let offset = 0; offset < requestedFields.length; offset += chunkSize) {
    const fields = requestedFields.slice(offset, offset + chunkSize);
    const allowedFields = new Set([
      schema.identityField,
      ...requestedFields,
      ...sortOnlyFields,
    ]);
    const chunkFields = new Set([schema.identityField, ...fields]);
    const chunkRows = rawRows.map((row) => {
      if (!isRecord(row)) return row;
      if (Object.keys(row).some((field) => !allowedFields.has(field))) {
        return row;
      }
      return Object.fromEntries(
        Object.entries(row).filter(([field]) => chunkFields.has(field)),
      );
    });
    // Chunk validation checks field values and page bounds; ordering is
    // validated separately against the complete internal request below.
    const chunkRequest = { ...resultRequest, projection: fields, sort: [] };
    // Correlation fields on a versioned result are checked above before this
    // per-chunk validation envelope is constructed.  The chunk fingerprint
    // is necessarily different from the full internal projection's
    // fingerprint because core's normalizer has a 50-field projection cap.
    const candidate = hasVersionedResult
      ? {
          ...rawRecord,
          requestId: chunkRequest.requestId,
          queryFingerprint: createDataQueryFingerprint(chunkRequest, schema),
          identityField: schema.identityField,
          rows: chunkRows,
        }
      : shorthandResultCandidate(chunkRequest, schema, rawRecord, chunkRows);
    chunks.push(normalizeDataQueryResult(candidate, chunkRequest, schema));
  }
  if (chunks.length === 0) {
    throw new DataSurfaceQueryError();
  }
  const rows = chunks[0].rows.map((_, index) =>
    Object.assign({}, ...chunks.map((chunk) => chunk.rows[index])),
  );
  const result = {
    ...chunks[0],
    requestId: request.requestId,
    queryFingerprint: createDataSurfaceQueryFingerprint(request),
    identityField: schema.identityField,
    rows,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
  if (bytes > (schema.maxResultBytes ?? DEFAULT_DATA_QUERY_RESULT_BYTES)) {
    throw new DataSurfaceQueryError();
  }
  return result;
}

function addSortOnlyValues(
  rows: DataQueryRow[],
  rawRows: DataQueryRow[],
  request: DataQueryRequest,
  internalSchema: DataQuerySchema,
  rawRecord: Record<string, unknown> | undefined,
): DataQueryRow[] {
  const projection = new Set(
    request.projection ?? [internalSchema.identityField],
  );
  const sortOnly = (request.sort ?? [])
    .map((term) => term.field)
    .filter((field) => !projection.has(field));
  if (sortOnly.length === 0) return rows;
  const chunkSize = MAX_DATA_QUERY_FILTERS - 1;
  const validatedChunks: DataQueryResult[] = [];
  for (let offset = 0; offset < sortOnly.length; offset += chunkSize) {
    const fields = sortOnly.slice(offset, offset + chunkSize);
    const validationProjection = [
      ...new Set([internalSchema.identityField, ...fields]),
    ].sort();
    const validationRequest = {
      ...request,
      projection: validationProjection,
      sort: [],
    };
    const validationRows = rawRows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([field]) =>
          validationProjection.includes(field),
        ),
      ),
    );
    validatedChunks.push(
      normalizeDataQueryResult(
        shorthandResultCandidate(
          validationRequest,
          internalSchema,
          rawRecord,
          validationRows,
        ),
        validationRequest,
        internalSchema,
      ),
    );
  }
  return rows.map((row, index) => {
    const result = { ...row };
    for (const field of sortOnly) {
      for (const chunk of validatedChunks) {
        const validatedRow = chunk.rows[index];
        if (Object.hasOwn(validatedRow, field)) {
          result[field] = validatedRow[field];
          break;
        }
      }
    }
    return result;
  });
}

function buildInternalQuery(
  request: DataQueryRequest,
  schema: DataQuerySchema,
): { request: DataQueryRequest; schema: DataQuerySchema } {
  const sort = request.sort ?? [];
  if (request.mode !== 'rows' || sort.length === 0) {
    return { request, schema };
  }
  const sortFields = new Set(sort.map((term) => term.field));
  const internalSchema = {
    ...schema,
    fields: schema.fields.map((field) =>
      sortFields.has(field.id) ? { ...field, projectable: true } : field,
    ),
  };
  const projection = [
    ...new Set([
      ...(request.projection ?? [schema.identityField]),
      ...sortFields,
    ]),
  ].sort();
  const internalRequest = { ...request, projection };
  const requestBytes = new TextEncoder().encode(
    JSON.stringify(internalRequest),
  ).byteLength;
  if (requestBytes > MAX_DATA_QUERY_REQUEST_BYTES) {
    throw new DataSurfaceQueryError();
  }
  return {
    schema: internalSchema,
    request: internalRequest,
  };
}

function requireSortValues(
  rows: DataQueryRow[],
  request: DataQueryRequest,
): void {
  for (const row of rows) {
    for (const term of request.sort ?? []) {
      if (!Object.hasOwn(row, term.field)) {
        throw new DataSurfaceResultOrderError();
      }
    }
  }
}

function stripInternalProjection(
  rows: DataQueryRow[],
  request: DataQueryRequest,
): DataQueryRow[] {
  const projection = projectionForResult(request).filter(Boolean);
  return rows.map((row) =>
    Object.fromEntries(
      projection
        .filter((field) => Object.hasOwn(row, field))
        .map((field) => [field, row[field]]),
    ),
  );
}

async function reportFailure(
  options: DataSurfaceToolsOptions,
  run: PrincipalRun,
  action: DataSurfaceFailureEntry['action'],
  surfaceId: string | undefined,
  requestId: string | undefined,
  error: unknown,
): Promise<void> {
  try {
    const principal = principalFromRun(run);
    await options.onFailure?.({
      action,
      ...(surfaceId !== undefined ? { surfaceId } : {}),
      requestId,
      ...principal,
      error,
    });
  } catch {
    // Failure telemetry must never alter the stable public error contract.
  }
}

async function bounded<T>(
  promise: Promise<T>,
  deadlineMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Adapters may observe this signal and cancel their database request.
      controller.abort();
      reject(new DataSurfaceDeadlineError());
    }, deadlineMs);
  });
  const abort = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => reject(new DataSurfaceDeadlineError()),
      { once: true },
    );
  });
  try {
    return await Promise.race([promise, timeout, abort]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The model-facing request, with envelope defaults filled in.
 *
 * `version` and `requestId` are transport correlation, meaningless to an
 * agent, and `mode`/`page.kind`/`page.offset` have one obvious default; an
 * agent that omits them should not burn a step learning the envelope. Nothing
 * here widens what a request can ask for — every value still goes through
 * `normalizeDataQueryRequest` against the visible schema. A flat call (the
 * request's keys beside `surfaceId`, no `request` object) is accepted too.
 */
/** Request-grammar keys a model sometimes misplaces next to `request`. */
const DATA_QUERY_REQUEST_KEYS = [
  'mode',
  'projection',
  'filter',
  'sort',
  'page',
  'facets',
  'version',
  'requestId',
] as const;

/** Valid-shape example used before the surface is known. */
const GENERIC_QUERY_EXAMPLE =
  'Valid example: {"surfaceId":"<surface id from data.discover>","request":{"mode":"count",' +
  '"filter":{"kind":"condition","field":"<field>","operator":"in","value":["<value>","<value>"]}}}';

/**
 * Put `surfaceId` where `data.query` / `data.inspect` read it (#4378). Small
 * models nest it inside `request` (or wrap the request in `query`), and a
 * missing top-level id used to surface as the generic "not available"
 * denial, which reads as a permission problem.
 *
 * - A `request.surfaceId` string is lifted to the top level and removed
 *   from `request` (the value is used, nothing is dropped). A top-level
 *   `query` object standing in for `request`, or a `query` object that is
 *   `request`'s only key, is unwrapped the same way: the intent is
 *   unambiguous and every key inside it is then validated as usual.
 * - Two different ids (top level vs nested) are a request error.
 * - No id at all is a request error, never a denial.
 *
 * Only an id that names no visible surface still gets the generic denial.
 * Messages never echo the ids or other values.
 */
function placeSurfaceId(
  args: Record<string, unknown>,
  tool: 'query' | 'inspect',
): Record<string, unknown> {
  let next: Record<string, unknown> = { ...args };
  if (
    tool === 'query' &&
    !Object.hasOwn(next, 'request') &&
    isRecord(next.query) &&
    Object.keys(next).every((key) => key === 'surfaceId' || key === 'query')
  ) {
    const { query, ...rest } = next;
    next = { ...rest, request: query };
  }
  const nested: unknown[] = [];
  if (isRecord(next.request)) {
    let request: Record<string, unknown> = { ...next.request };
    const keys = Object.keys(request).filter((key) => key !== 'surfaceId');
    if (keys.length === 1 && keys[0] === 'query' && isRecord(request.query)) {
      const { query, ...rest } = request;
      if (Object.hasOwn(query as Record<string, unknown>, 'surfaceId')) {
        nested.push((query as Record<string, unknown>).surfaceId);
      }
      request = { ...(query as Record<string, unknown>), ...rest };
    }
    if (Object.hasOwn(request, 'surfaceId')) {
      nested.push(request.surfaceId);
      delete request.surfaceId;
    }
    next.request = request;
  }
  const top = next.surfaceId;
  const candidates = [
    ...(top !== undefined && top !== null ? [top] : []),
    ...nested,
  ];
  const example =
    tool === 'inspect'
      ? 'Valid example: {"surfaceId":"<surface id from data.discover>"}'
      : GENERIC_QUERY_EXAMPLE;
  if (
    candidates.length === 0 ||
    candidates.some((id) => typeof id !== 'string' || !id)
  ) {
    throw new DataSurfaceRequestError(
      `surfaceId is required at the top level${tool === 'query' ? ', next to request' : ''}, as a surface id string from data.discover. ${example}`,
      'DATA_QUERY_SURFACE_ID_REQUIRED',
    );
  }
  if (new Set(candidates).size > 1) {
    throw new DataSurfaceRequestError(
      `surfaceId was given twice with different values. Give it once, at the top level${tool === 'query' ? ', next to request' : ''}. ${example}`,
      'DATA_QUERY_SURFACE_ID_CONFLICT',
    );
  }
  next.surfaceId = candidates[0];
  return next;
}

function requestFromArgs(
  args: Record<string, unknown>,
  example: () => string,
): unknown {
  let raw: unknown;
  if (Object.hasOwn(args, 'request')) {
    // `data.query` takes exactly {surfaceId, request} (#4378): a `filter`
    // beside `request` used to be dropped silently, so a filtered count
    // counted every row. Name only the fixed grammar keys that were
    // misplaced — never the model's own keys or values.
    const stray = Object.keys(args).filter(
      (key) => key !== 'surfaceId' && key !== 'request',
    );
    if (stray.length > 0) {
      const misplaced = DATA_QUERY_REQUEST_KEYS.filter((key) =>
        stray.includes(key),
      );
      throw new DataSurfaceRequestError(
        'data.query accepts only surfaceId and request at the top level' +
          (misplaced.length > 0
            ? `; move ${misplaced.join(', ')} inside request.`
            : '; put every query option inside request.') +
          ` ${example()}`,
        'DATA_QUERY_ARGUMENTS_UNEXPECTED',
      );
    }
    raw = args.request;
  } else {
    const { surfaceId: _surfaceId, ...rest } = args;
    raw = rest;
  }
  if (!isRecord(raw)) return raw;
  const request: Record<string, unknown> = {
    ...raw,
    version: raw.version ?? 1,
    requestId: raw.requestId ?? `dq_${randomUUID()}`,
    mode: raw.mode ?? (raw.facets !== undefined ? 'facets' : 'rows'),
  };
  if (isRecord(raw.page)) {
    const kind = raw.page.kind ?? 'offset';
    request.page = {
      ...raw.page,
      kind,
      ...(kind === 'offset' ? { offset: raw.page.offset ?? 0 } : {}),
    };
  }
  return request;
}

const DATA_QUERY_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'like',
  'isNull',
  'isNotNull',
] as const;

const DATA_QUERY_SCALAR_SCHEMA = [
  { type: 'string' },
  { type: 'number' },
  { type: 'boolean' },
  { type: 'null' },
];

/**
 * JSON schema for `data.query`'s arguments: the exact request grammar
 * `normalizeDataQueryRequest` accepts. Per-surface capability (which fields
 * are projectable/sortable/facetable, each field's operators, page limits)
 * comes from `data.inspect`, which the description points at.
 */
export const DATA_QUERY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  required: ['surfaceId', 'request'],
  additionalProperties: false,
  properties: {
    surfaceId: {
      type: 'string',
      description: 'A surface id from data.discover.',
    },
    request: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['rows', 'count', 'facets'],
          description:
            'rows (default): matching records. count: only the total (no projection, sort, or page). facets: value counts for facetable fields.',
        },
        projection: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 50,
          description:
            'rows only. Projectable fields to return; the identity field is always included.',
        },
        filter: {
          type: 'object',
          description:
            'Optional. A condition {"kind":"condition","field":f,"operator":op,"value":v}; ' +
            '{"kind":"all"|"any","filters":[...]} to AND/OR nested filters; or {"kind":"not","filter":{...}}. ' +
            'field must list op in its filterOperators (data.inspect). value is a scalar, or a non-empty array (max 100) for in/notIn. ' +
            'isNull/isNotNull test for an empty value and take no value: {"kind":"condition","field":f,"operator":"isNull"}. ' +
            'like takes SQL wildcards (%council%) on string fields. Datetimes are RFC 3339 instants (2026-09-01T00:00:00Z). ' +
            'String fields whose only value operators are eq/ne/in/notIn (isNull/isNotNull aside) hold ids: compare them with complete id values.',
          properties: {
            kind: { type: 'string', enum: ['condition', 'all', 'any', 'not'] },
            field: { type: 'string' },
            operator: { type: 'string', enum: [...DATA_QUERY_OPERATORS] },
            value: {
              anyOf: [
                ...DATA_QUERY_SCALAR_SCHEMA,
                {
                  type: 'array',
                  items: { anyOf: DATA_QUERY_SCALAR_SCHEMA },
                },
              ],
            },
            filters: { type: 'array', items: { type: 'object' } },
            filter: { type: 'object' },
          },
          required: ['kind'],
        },
        sort: {
          type: 'array',
          description:
            'rows only. Sortable fields, earlier terms first. Empty values sort first ascending and last descending.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['field', 'direction'],
            properties: {
              field: { type: 'string' },
              direction: { type: 'string', enum: ['asc', 'desc'] },
            },
          },
        },
        page: {
          type: 'object',
          additionalProperties: false,
          description:
            'rows only. {"kind":"offset","offset":0,"limit":10}; kind defaults to offset and offset to 0. limit is capped at the surface maxPageLimit. ' +
            'Use {"kind":"cursor","after":nextCursor,"limit":n} only where supports.cursorPagination.',
          properties: {
            kind: { type: 'string', enum: ['offset', 'cursor'] },
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1 },
            after: { type: 'string' },
          },
          required: ['limit'],
        },
        facets: {
          type: 'array',
          description:
            'facets mode only (supports.facets). One entry per facetable field.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['field', 'limit'],
            properties: {
              field: { type: 'string' },
              limit: { type: 'integer', minimum: 1 },
            },
          },
        },
        version: {
          type: 'integer',
          enum: [1],
          description: 'Optional; defaults to 1.',
        },
        requestId: {
          type: 'string',
          description: 'Optional correlation id; generated when omitted.',
        },
      },
    },
  },
};

const DATA_QUERY_TOOL_DESCRIPTION =
  'Run a bounded, read-only query against one data surface. Call data.inspect first: ' +
  'only the fields, operators, sort fields, facets, and page limits it lists are accepted. ' +
  'Use mode "count" for how-many questions and mode "facets" for breakdowns by value. ' +
  'Example request: {"mode":"rows","projection":["title","updated_at"],' +
  '"filter":{"kind":"condition","field":"status","operator":"eq","value":"published"},' +
  '"sort":[{"field":"updated_at","direction":"desc"}],"page":{"kind":"offset","offset":0,"limit":10}}. ' +
  'An invalid request fails with a message naming what was wrong and what is allowed.';

const DATA_DISCOVER_FULL_TOOL_DESCRIPTION =
  'List data surfaces and their safe, readable fields.';
const DATA_DISCOVER_SUMMARY_TOOL_DESCRIPTION =
  'List the data surfaces you can read (id, label, short description). ' +
  "Call data.inspect for a surface's fields and operators before querying.";

function tool(
  slug: string,
  functionName: string,
  description: string,
  parameters: Record<string, unknown>,
  execute: (context: PrincipalToolContext) => Promise<unknown>,
): PrincipalTool {
  const aiTool: AITool = {
    type: 'function',
    function: { name: functionName, description, parameters },
  };
  return { slug, aiTool, execute };
}

/** Build the discover/inspect/query tools for a persona conversation. */
export function createDataSurfaceTools(
  options: DataSurfaceToolsOptions,
): PrincipalTool[] {
  const deadlineMs = Math.min(
    Math.max(options.deadlineMs ?? DEFAULT_DATA_SURFACE_DEADLINE_MS, 1),
    MAX_DATA_SURFACE_DEADLINE_MS,
  );
  const audit = async (
    entry: DataSurfaceAuditInput,
    run: PrincipalRun,
  ): Promise<void> => {
    try {
      const principal = principalFromRun(run);
      await options.audit?.({ ...entry, ...principal });
    } catch (error) {
      await reportFailure(
        options,
        run,
        entry.action,
        entry.surfaceId,
        entry.requestId,
        error,
      );
      const publicError = new DataSurfaceQueryError();
      reportedFailureErrors.add(publicError);
      throw publicError;
    }
  };
  const catalog = async (
    run: PrincipalRun,
    action: DataSurfaceFailureEntry['action'],
  ) => {
    try {
      return await availableSurfaces(options, run, action);
    } catch (error) {
      await reportFailure(options, run, action, undefined, undefined, error);
      throw new DataSurfaceQueryError();
    }
  };
  /**
   * Refuse a call (#4387): report it to `onDenied` and the audit sink, and
   * return the error the model sees. A requested id that is visible for a
   * lesser action gets the action-specific denial; anything else keeps the
   * generic one, so a hidden surface is never revealed. Lesser catalogs are
   * evaluated only for a function catalog that takes the `{ action }`
   * context (a static or one-argument catalog is the same for every action,
   * so the miss already answers), at most once per action per call; a
   * throwing lookup is reported to `onFailure` and counts as not visible.
   * Sink failures never change the outcome.
   */
  const deny = async (
    run: PrincipalRun,
    action: DataSurfaceAction,
    requestedId: unknown,
    reason?: DataSurfaceDenialReason,
    requestId?: unknown,
  ): Promise<DataSurfaceDeniedError> => {
    let surfaceId: string | undefined;
    let finalReason: DataSurfaceDenialReason = reason ?? 'not_visible';
    // Only a function catalog can differ per action. Its lesser catalogs
    // are evaluated on this denial path only — at most two calls, each
    // once — whatever the function's declared arity (default or rest
    // parameters and wrappers make arity detection unreliable).
    if (
      !reason &&
      typeof options.surfaces === 'function' &&
      typeof requestedId === 'string' &&
      requestedId
    ) {
      const lesser: Array<[DataSurfaceAction, string]> =
        action === 'query'
          ? [
              ['inspect', DATA_INSPECT_TOOL_SLUG],
              ['discover', DATA_DISCOVER_TOOL_SLUG],
            ]
          : [['discover', DATA_DISCOVER_TOOL_SLUG]];
      for (const [lesserAction, lesserSlug] of lesser) {
        // A lesser action counts only when its own tool is allowed, so a
        // query-only principal cannot probe which surfaces exist.
        if (!run.isToolAllowed(lesserSlug)) continue;
        let visible: Awaited<ReturnType<typeof availableSurfaces>>;
        try {
          visible = await availableSurfaces(options, run, lesserAction);
        } catch (error) {
          await reportFailure(
            options,
            run,
            lesserAction,
            undefined,
            undefined,
            error,
          );
          continue;
        }
        const entry = findSurface(visible, requestedId);
        if (entry) {
          surfaceId = entry.surface.id;
          finalReason = 'action_not_permitted';
          break;
        }
      }
    }
    const userId = run.context.userId || undefined;
    const tenantId = run.context.tenantId ?? null;
    try {
      await options.onDenied?.({
        action,
        ...(surfaceId ? { surfaceId } : {}),
        ...(typeof requestId === 'string' && requestId
          ? { requestId: requestId.slice(0, 256) }
          : {}),
        ...(userId ? { userId } : {}),
        tenantId,
        reason: finalReason,
      });
    } catch {
      // Host telemetry never changes the denial.
    }
    // The audit entry needs a user, as success entries do; a run without
    // one is reported to `onDenied` only.
    if (userId) {
      try {
        await options.audit?.({
          action,
          ...(surfaceId ? { surfaceId } : {}),
          userId,
          tenantId,
          denied: true,
          reason: finalReason,
        });
      } catch (error) {
        // The refusal stands; the broken audit sink is a server failure.
        await reportFailure(options, run, action, surfaceId, undefined, error);
      }
    }
    // `discover` is only ever refused at the allow-list (no surface), so
    // this guard is type narrowing for the action-specific constructor.
    return surfaceId && action !== 'discover'
      ? new DataSurfaceActionDeniedError(action, surfaceId)
      : new DataSurfaceDeniedError();
  };
  /** The allow-list gate, with the refusal reported (#4387). */
  const assertAllowed = async (
    run: PrincipalRun,
    action: DataSurfaceAction,
    slug: string,
  ) => {
    try {
      run.assertToolAllowed(slug);
    } catch (error) {
      await deny(run, action, undefined, 'tool_not_allowed');
      throw error;
    }
  };

  const summaryDiscovery = options.discoverDetail === 'summary';
  const discover = tool(
    DATA_DISCOVER_TOOL_SLUG,
    DATA_DISCOVER_FUNCTION_NAME,
    summaryDiscovery
      ? DATA_DISCOVER_SUMMARY_TOOL_DESCRIPTION
      : DATA_DISCOVER_FULL_TOOL_DESCRIPTION,
    { type: 'object', properties: {}, additionalProperties: false },
    async ({ run }) => {
      await assertAllowed(run, 'discover', DATA_DISCOVER_TOOL_SLUG);
      const entries = await catalog(run, 'discover');
      await audit({ action: 'discover' }, run);
      return entries.map(({ surface, schema }) =>
        summaryDiscovery ? summary(surface) : descriptor(surface, schema),
      );
    },
  );

  const inspect = tool(
    DATA_INSPECT_TOOL_SLUG,
    DATA_INSPECT_FUNCTION_NAME,
    'Inspect one readable data surface schema.',
    {
      type: 'object',
      required: ['surfaceId'],
      properties: { surfaceId: { type: 'string' } },
      additionalProperties: false,
    },
    async ({ run, args }) => {
      await assertAllowed(run, 'inspect', DATA_INSPECT_TOOL_SLUG);
      const placed = placeSurfaceId(args, 'inspect');
      const entry = findSurface(
        await catalog(run, 'inspect'),
        placed.surfaceId,
      );
      if (!entry) throw await deny(run, 'inspect', placed.surfaceId);
      await audit({ action: 'inspect', surfaceId: entry.surface.id }, run);
      return descriptor(entry.surface, entry.schema);
    },
  );

  const query = tool(
    DATA_QUERY_TOOL_SLUG,
    DATA_QUERY_FUNCTION_NAME,
    DATA_QUERY_TOOL_DESCRIPTION,
    DATA_QUERY_TOOL_PARAMETERS,
    async ({ run, args, db }) => {
      await assertAllowed(run, 'query', DATA_QUERY_TOOL_SLUG);
      const queryArgs = placeSurfaceId(args, 'query');
      const entry = findSurface(
        await catalog(run, 'query'),
        queryArgs.surfaceId,
      );
      if (!entry) {
        throw await deny(
          run,
          'query',
          queryArgs.surfaceId,
          undefined,
          isRecord(queryArgs.request) ? queryArgs.request.requestId : undefined,
        );
      }
      const surfaceId = entry.surface.id;
      const example = (raw?: unknown) =>
        validQueryExample(
          surfaceId,
          entry.schema,
          raw ?? (isRecord(queryArgs.request) ? queryArgs.request : queryArgs),
        );
      const request = normalizeSurfaceRequest(
        requestFromArgs(queryArgs, () => example()),
        entry.schema,
        surfaceId,
      );
      const principal = principalFromRun(run);
      const signal = new AbortController();
      const executor = entry.surface.execute ?? options.execute;
      if (!executor) {
        // A visible surface with nothing to run it is a host configuration
        // error, not a denial (#4387 review).
        await reportFailure(
          options,
          run,
          'query',
          surfaceId,
          undefined,
          new Error('Data surface has no executor.'),
        );
        throw new DataSurfaceQueryError();
      }
      try {
        const internal = buildInternalQuery(request, entry.schema);
        const raw = await bounded(
          executor(entry.surface, internal.request, {
            run,
            principal,
            db: run.context.database ?? db,
            signal: signal.signal,
          }).catch((error: unknown) => {
            // An adapter refusing the caller's request (e.g. a non-id value
            // for an id column) is the caller's error, not a failed query:
            // pass its public reason through instead of an opaque 502.
            if (
              error instanceof DataQueryValidationError &&
              EXECUTOR_REQUEST_ERROR_CODES.has(error.code)
            ) {
              throw new DataSurfaceRequestError(
                `${error.publicMessage.replace(/\.?$/, '.')} ${example(request)}`,
                error.code,
              );
            }
            throw error;
          }),
          deadlineMs,
          signal,
        );
        const rawRecord = isRecord(raw) ? raw : undefined;
        const rawRows = Array.isArray(raw)
          ? raw
          : rawRecord && Array.isArray(rawRecord.rows)
            ? rawRecord.rows
            : [];
        if (
          request.mode === 'rows' &&
          request.page &&
          rawRows.length > request.page.limit
        ) {
          throw new DataSurfaceQueryError();
        }
        const resultRequest = externalValidationRequest(request, entry.schema);
        const hasVersionedResult =
          rawRecord && Object.hasOwn(rawRecord, 'version');
        const canValidateInternal =
          (internal.request.projection?.length ?? 0) <= MAX_DATA_QUERY_FILTERS;
        const validated = canValidateInternal
          ? normalizeDataQueryResult(
              hasVersionedResult
                ? raw
                : shorthandResultCandidate(
                    internal.request,
                    internal.schema,
                    rawRecord,
                    rawRows,
                  ),
              internal.request,
              internal.schema,
            )
          : normalizeWideRows(
              rawRecord,
              rawRows,
              request,
              resultRequest,
              entry.schema,
              internal,
            );
        const rawOrderRows =
          request.mode === 'rows' && !canValidateInternal
            ? dataQueryRowsOrThrow(rawRows)
            : validated.rows;
        const orderRows =
          request.mode === 'rows' && !canValidateInternal
            ? addSortOnlyValues(
                validated.rows,
                rawOrderRows,
                request,
                internal.schema,
                rawRecord,
              )
            : rawOrderRows;
        if (request.mode === 'rows') {
          requireSortValues(orderRows, internal.request);
        }
        const orderedRows =
          request.mode === 'rows' && request.page === undefined
            ? sortRows(orderRows, internal.request, internal.schema)
            : orderRows;
        if (
          request.mode === 'rows' &&
          request.page !== undefined &&
          !isCanonicalOrder(orderedRows, internal.request, internal.schema)
        ) {
          throw new DataSurfaceResultOrderError();
        }
        const resultCandidate = {
          ...validated,
          requestId: resultRequest.requestId,
          queryFingerprint: canValidateInternal
            ? createDataQueryFingerprint(resultRequest, entry.schema)
            : createDataSurfaceQueryFingerprint(request),
          identityField: entry.schema.identityField,
          rows: stripInternalProjection(orderedRows, request),
        };
        const result: DataQueryResult = canValidateInternal
          ? normalizeDataQueryResult(
              resultCandidate,
              resultRequest,
              entry.schema,
            )
          : {
              ...resultCandidate,
              queryFingerprint: createDataSurfaceQueryFingerprint(request),
            };
        await audit(
          {
            action: 'query',
            surfaceId: entry.surface.id,
            requestId: result.requestId,
            rowCount: result.rows.length,
            truncated: result.truncated,
          },
          run,
        );
        return result;
      } catch (error) {
        // The caller's own mistake: not a server-side failure to report.
        if (error instanceof DataSurfaceRequestError) throw error;
        const alreadyReported =
          (typeof error === 'object' && error !== null) ||
          typeof error === 'function'
            ? reportedFailureErrors.has(error)
            : false;
        if (!alreadyReported) {
          await reportFailure(
            options,
            run,
            'query',
            entry.surface.id,
            request.requestId,
            error,
          );
        }
        if (
          error instanceof DataSurfaceDeadlineError ||
          error instanceof DataSurfaceResultOrderError ||
          error instanceof DataSurfaceQueryError
        ) {
          throw error;
        }
        throw new DataSurfaceQueryError();
      }
    },
  );

  return [discover, inspect, query];
}
