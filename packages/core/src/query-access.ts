/**
 * Which fields a caller may filter and sort a list by.
 *
 * A filter is a comparison, and a comparison against a value answers a
 * question about it. So a request-facing list, count or get-by-filter may
 * filter on a field only when the caller may read that field: the same
 * decision `toPublicJSON({ permissions })` makes when it projects the row.
 *
 * - A `sensitive` field is never read by anyone, so it is never a filter key.
 * - A `readPermission` field is a filter key for a caller whose permissions
 *   include its slug.
 * - The whole `_meta_data` column holds every `@meta` value of an STI row,
 *   readable or not, so it is neither a filter nor a sort key. `_meta_type`
 *   is.
 *
 * Every refusal is the same typed 400 with the same text, whether the field
 * is unknown to the model or unreadable by this caller.
 *
 * This is a request-boundary check. `collection.list({ where })` called by
 * server code is not a request and keeps filtering on any column; it still
 * refuses `sensitive` fields itself. Each transport calls
 * {@link assertQueryAccess} with the caller's projection options before the
 * query reaches the collection.
 */

import { ValidationError } from './errors';
import type { PublicJsonOptions } from './object';
import { QueryOrderByError } from './query-bounds';
import { ObjectRegistry } from './registry';
import { getRegistryGeneration } from './registry/generation.js';
import type { RegisteredField } from './registry/types';
import { toSnakeCase } from './utils/naming';
import {
  resolveWhereKey,
  WhereClauseError,
  whereColumnName,
} from './where-keys';

/**
 * A filter key this caller may not use.
 *
 * Extends `ValidationError` so the retry classifier never retries it, and
 * carries `status` / `publicMessage` so `normalizeTypedHttpError()` renders it
 * as a structured 400 and MCP reports it as a tool failure with a code.
 */
export class QueryFieldError extends ValidationError {
  readonly status = 400;
  readonly publicMessage: string;

  constructor(field: string) {
    // One text for every reason: the answer never says whether the model has
    // such a field.
    const message = `Invalid filter field: '${field}'.`;
    super(message, 'QUERY_FIELD_NOT_ALLOWED', { field });
    this.name = 'QueryFieldError';
    this.publicMessage = message;
  }
}

/** A caller-supplied filter and ordering, as they arrived. */
export interface RequestQuery {
  /** A where record, or the DNF form: an array of arrays of records. */
  where?: unknown;
  /** One `'<field> [ASC|DESC]'` term, a comma-separated list, or an array. */
  orderBy?: unknown;
}

interface ModelQueryPolicy {
  /** Whether anything is registered to check a key against. */
  known: boolean;
  /** Columns a filter may name. */
  columns: Set<string>;
  /** Columns (and raw field names) no caller reads. */
  sensitive: Set<string>;
  /** Columns (and raw field names) and the permission slugs that read them. */
  readPermissions: Map<string, Set<string>>;
  /**
   * The declared field type of each column, as every registration that
   * declares it agrees. A column two declarations (family members, a parent
   * and a child) give different types maps to `null`. A query-string value
   * is decoded only for a column whose single type is `boolean` or
   * `datetime`.
   */
  columnTypes: Map<string, string | null>;
}

const META_DATA_COLUMNS = new Set(['_meta_data', 'meta_data']);
const SYSTEM_COLUMNS = ['id', 'slug', 'context', 'created_at', 'updated_at'];

const policies = new Map<string, ModelQueryPolicy>();
let policiesGeneration = -1;

function fieldsOf(name: string): Map<string, RegisteredField> {
  const registered = ObjectRegistry.getClass(name);
  return registered?.inheritedFields || ObjectRegistry.getFields(name);
}

function addPolicies(
  fields: Map<string, RegisteredField>,
  policy: ModelQueryPolicy,
): void {
  for (const [name, definition] of fields) {
    const names = [toSnakeCase(name), name];
    // A registration without a type declares nothing to agree or disagree
    // with; any two declared types that differ leave the column undecoded.
    if (typeof definition?.type === 'string') {
      const column = whereColumnName(name);
      const known = policy.columnTypes.get(column);
      policy.columnTypes.set(
        column,
        known === undefined || known === definition.type
          ? definition.type
          : null,
      );
    }
    if (
      definition?.sensitive === true ||
      definition?._meta?.sensitive === true
    ) {
      for (const key of names) policy.sensitive.add(key);
    }
    const permission =
      typeof definition?.readPermission === 'string'
        ? definition.readPermission
        : typeof definition?._meta?.readPermission === 'string'
          ? definition._meta.readPermission
          : undefined;
    if (permission) {
      for (const key of names) {
        const required = policy.readPermissions.get(key) ?? new Set<string>();
        required.add(permission);
        policy.readPermissions.set(key, required);
      }
    }
  }
}

/**
 * The filterable columns and field policies of a model, mirroring what its
 * collection accepts (`collectQueryableFieldNames`) and what its rows redact
 * (`getPublicFieldPolicies`): the model's own and inherited fields, and for a
 * shared table the fields of every member of the family.
 */
function queryPolicyFor(model: string): ModelQueryPolicy {
  const generation = getRegistryGeneration();
  if (policiesGeneration !== generation) {
    policies.clear();
    policiesGeneration = generation;
  }
  const cached = policies.get(model);
  if (cached) return cached;

  const registered = ObjectRegistry.getClass(model);
  const name = registered?.qualifiedName ?? registered?.name ?? model;
  const policy: ModelQueryPolicy = {
    known: !!registered,
    columns: new Set(SYSTEM_COLUMNS),
    sensitive: new Set(),
    readPermissions: new Map(),
    columnTypes: new Map([
      ['created_at', 'datetime'],
      ['updated_at', 'datetime'],
    ]),
  };
  const include = (fields: Map<string, RegisteredField>) => {
    for (const field of fields.keys()) policy.columns.add(toSnakeCase(field));
    addPolicies(fields, policy);
  };

  include(fieldsOf(name));
  include(ObjectRegistry.getFields(name));
  for (const ancestor of ObjectRegistry.getInheritanceChain(name)) {
    if (ancestor === 'SmrtObject' || ancestor === 'SmrtClass') continue;
    include(ObjectRegistry.getFields(ancestor));
  }

  const config = ObjectRegistry.getConfig(name);
  if (config.display?.label && typeof config.display.label === 'object') {
    policy.columns.add('display_label');
  }
  for (const link of Object.values(config.writeThrough ?? {})) {
    for (const field of [
      ...link.fields,
      ...Object.keys(link.virtualFields ?? {}),
    ]) {
      policy.columns.add(toSnakeCase(field));
    }
  }

  if (ObjectRegistry.getTableStrategy(name) === 'sti') {
    policy.columns.add('_meta_type');
    policy.columns.add('meta_type');
    // A row of a shared table may be any member of the family, and a member's
    // `@meta` values travel in every row's serialised form.
    const base = ObjectRegistry.getSTIBase(name);
    if (base) {
      addPolicies(fieldsOf(base), policy);
      for (const member of ObjectRegistry.getDescendants(base)) {
        addPolicies(fieldsOf(member), policy);
      }
    }
  }

  policies.set(model, policy);
  return policy;
}

function heldPermissions(caller: PublicJsonOptions): ReadonlySet<string> {
  const permissions = caller.permissions;
  if (!permissions) return new Set();
  return permissions instanceof Set ? permissions : new Set(permissions);
}

function assertWhereRecord(
  record: Record<string, unknown>,
  policy: ModelQueryPolicy,
  held: ReadonlySet<string>,
): void {
  for (const key of Object.keys(record)) {
    const { field, baseField, column } = resolveWhereKey(key);
    const refuse = () => {
      throw new QueryFieldError(field);
    };
    if (META_DATA_COLUMNS.has(column)) refuse();
    if (policy.sensitive.has(column) || policy.sensitive.has(baseField)) {
      refuse();
    }
    const required =
      policy.readPermissions.get(column) ??
      policy.readPermissions.get(baseField);
    if (required && ![...required].every((slug) => held.has(slug))) refuse();
    if (policy.known && !policy.columns.has(column)) refuse();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function orderByTerms(orderBy: unknown): string[] {
  const items = Array.isArray(orderBy) ? orderBy : [orderBy];
  return items
    .filter((item): item is string => typeof item === 'string')
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Refuse a caller's filter or ordering that names a field the caller may not
 * read, before it reaches the collection.
 *
 * @param model - Registry key of the model the request lists or counts
 * @param query - The caller's `where` and `orderBy`, unparsed
 * @param caller - The same options the transport passes to `toPublicJSON()`
 *   for this caller; no permissions means no `readPermission` field
 * @throws {QueryFieldError} `QUERY_FIELD_NOT_ALLOWED`, a typed 400, for a
 *   filter key that is unknown to the model or unreadable by the caller
 * @throws {WhereClauseError} a typed 400 when `where` is not an object of
 *   conditions (or the DNF array form)
 * @throws {QueryOrderByError} `INVALID_ORDER_BY_UNKNOWN_FIELD`, a typed 400
 *   with one text, for an ordering by the metadata column, a sensitive or
 *   permission-gated field, or a field the model does not have
 */
export function assertQueryAccess(
  model: string | undefined,
  query: RequestQuery,
  caller: PublicJsonOptions = {},
): void {
  if (!model) return;
  const { where, orderBy } = query;

  if (where !== undefined && where !== null) {
    const policy = queryPolicyFor(model);
    const held = heldPermissions(caller);
    if (isRecord(where)) {
      assertWhereRecord(where, policy, held);
    } else if (Array.isArray(where)) {
      for (const branch of where) {
        // The collection reports a malformed branch; only records are read.
        for (const condition of Array.isArray(branch) ? branch : []) {
          if (isRecord(condition)) assertWhereRecord(condition, policy, held);
        }
      }
    } else {
      throw new WhereClauseError(
        'Invalid WHERE clause: expected an object of conditions.',
      );
    }
  }

  // What is checked is what runs: an ordering is a string or a list of
  // strings. Anything else would reach the collection in a form (stringified)
  // this check never saw.
  if (
    orderBy !== undefined &&
    orderBy !== null &&
    typeof orderBy !== 'string' &&
    !(
      Array.isArray(orderBy) &&
      orderBy.every((entry) => typeof entry === 'string')
    )
  ) {
    throw new QueryOrderByError(
      'Invalid orderBy: expected a string or a list of strings.',
      'Invalid orderBy: expected a string or a list of strings.',
      'INVALID_ORDER_BY',
    );
  }
  const terms = orderByTerms(orderBy);
  if (terms.length === 0) return;
  const policy = queryPolicyFor(model);
  for (const term of terms) {
    const field = term.split(/\s+/)[0];
    const column = whereColumnName(field);
    // A declared `_name` field lives in the column `name`; the collection
    // accepts either spelling.
    const stripped = toSnakeCase(field);
    const names = [column, stripped, field];
    // One answer for every field a caller may not sort by: the metadata
    // column, a sensitive field, a permission-gated field (the collection
    // refuses ordering by those for every caller) and a field the model does
    // not have. The answer is the collection's own for an unknown field, so
    // it never says which of these the field is.
    if (
      META_DATA_COLUMNS.has(column) ||
      names.some(
        (name) =>
          policy.sensitive.has(name) || policy.readPermissions.has(name),
      ) ||
      (policy.known && !names.some((name) => policy.columns.has(name)))
    ) {
      throw new QueryOrderByError(
        `Invalid orderBy field: '${field}'. It is not a sort key for this caller.`,
        `Invalid orderBy field: '${field}'.`,
        'INVALID_ORDER_BY_UNKNOWN_FIELD',
        { field },
      );
    }
  }
}

/** Query-string operator tokens the list routes accept, as `field[op]`. */
const REST_LIST_OPERATORS: Readonly<Record<string, string>> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  ne: '!=',
  in: 'in',
  like: 'like',
};

/** Operators whose operand is compared as the column's type. */
const DECODED_OPERATORS = new Set(['=', '>', '>=', '<', '<=', '!=', 'in']);

/**
 * An ISO-8601 instant: a calendar date alone (read as UTC midnight), or a
 * date and time with seconds optional, any number of fractional digits and an
 * explicit `Z` or `±hh:mm` / `±hhmm` offset. Nothing else is an instant here:
 * an offset-less date-time would be read in the server's own zone.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-](\d{2}):?(\d{2})))?$/;

/**
 * The UTC ISO string of an {@link ISO_INSTANT}, keeping every fractional digit
 * (padded to at least milliseconds, the form SMRT writes), or `undefined` for
 * anything else. A string, not a `Date`: a `Date` holds milliseconds, and
 * PostgreSQL stores microseconds, so an exact or bounding comparison against
 * a finer value must bind the digits the caller sent.
 */
function normalizeIsoInstant(value: string): string | undefined {
  const match = ISO_INSTANT.exec(value);
  if (!match) return undefined;
  const [, y, mo, d, h = '00', mi = '00', s = '00', fraction = '', zone] =
    match;
  const fields = [y, mo, d, h, mi, s].map(Number);
  const [year, month, day, hour, minute, second] = fields;
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(local);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  let offsetMinutes = 0;
  if (zone && zone !== 'Z') {
    const offsetHours = Number(match[9]);
    const offsetMins = Number(match[10]);
    if (offsetHours > 23 || offsetMins > 59) return undefined;
    offsetMinutes =
      (zone.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetMins);
  }
  const utc = new Date(local - offsetMinutes * 60_000).toISOString();
  return `${utc.slice(0, 19)}.${fraction.padEnd(3, '0')}Z`;
}

function decodeListValue(value: string, type: string | undefined): unknown {
  if (type === 'boolean') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
    return value;
  }
  if (type === 'datetime') return normalizeIsoInstant(value) ?? value;
  return value;
}

/**
 * Read a list or count request's filter from its query string: the grammar
 * the generated client's `list(params)` writes and both list routes (runtime
 * REST and generated SvelteKit) read.
 *
 * - `limit`, `offset` and `orderBy` are not filters and are skipped.
 * - `field=value` is equality; `field[op]=value` applies `op` (`gt`, `gte`,
 *   `lt`, `lte`, `ne`, `in`, `like`). An `in` operand is one comma-separated
 *   value.
 * - Every parameter appears at most once. A repeated one is refused with a
 *   typed 400 (`REPEATED_QUERY_PARAMETER`) instead of keeping one of its
 *   values, so a filter never silently narrows to the last value sent.
 * - Two parameters that name the same predicate (`price[gte]` and
 *   `price >=`) are refused the same way, whichever comes first.
 * - With `model`, a value compared against a `boolean` field (`true`,
 *   `false`, `1`, `0`) becomes a boolean, and one compared against a
 *   `datetime` field that is an ISO-8601 instant with an explicit `Z` or
 *   offset (or a date alone, read as UTC) becomes its UTC ISO string with
 *   every fractional digit kept, so the comparison has the column's meaning
 *   on every adapter (SQLite stores booleans as integers and timestamps as
 *   ISO text). A column whose declarations disagree on its type is not
 *   decoded. A value that does not decode is passed through unchanged.
 *   Decoding never changes a key, so {@link assertQueryAccess} sees the same
 *   fields either way.
 * - The record has no prototype, so every parameter name, `__proto__`
 *   included, is an own key that {@link assertQueryAccess} checks.
 *
 * @throws {WhereClauseError} `REPEATED_QUERY_PARAMETER` for a repeated
 *   parameter or predicate
 */
export function parseRestListWhere(
  params: URLSearchParams,
  model?: string,
): Record<string, unknown> {
  const repeated = (parameter: string): never => {
    throw new WhereClauseError(
      `Invalid query: parameter '${parameter}' appears more than once. Send ` +
        'each parameter once; join the members of an [in] filter with commas.',
      'REPEATED_QUERY_PARAMETER',
      { parameter },
    );
  };
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) repeated(key);
    seen.add(key);
  }

  const columnTypes = model ? queryPolicyFor(model).columnTypes : undefined;
  const where: Record<string, unknown> = Object.create(null);
  for (const [key, value] of params.entries()) {
    if (key === 'limit' || key === 'offset' || key === 'orderBy') continue;
    const match = key.match(/^(.+)\[(.+)\]$/);
    const field = match ? match[1] : key;
    const operator = match
      ? Object.hasOwn(REST_LIST_OPERATORS, match[2])
        ? REST_LIST_OPERATORS[match[2]]
        : match[2]
      : '=';
    const predicate = match ? `${field} ${operator}` : key;
    if (Object.hasOwn(where, predicate)) repeated(key);
    const operand: string | string[] =
      operator === 'in' ? value.split(',') : value;
    // The operator the collection will apply decides the decoding: the
    // bracket token, or the operator written in a whitespace-form key
    // (`featured like` compares a string pattern, not a boolean).
    const resolved = columnTypes ? resolveWhereKey(field) : undefined;
    const effective = !resolved
      ? undefined
      : match
        ? resolved.operator === '='
          ? operator
          : undefined
        : resolved.operator.toLowerCase();
    const type =
      resolved &&
      resolved.path === null &&
      effective !== undefined &&
      DECODED_OPERATORS.has(effective) &&
      (effective !== 'in' || Array.isArray(operand))
        ? (columnTypes?.get(resolved.column) ?? undefined)
        : undefined;
    where[predicate] =
      type === 'boolean' || type === 'datetime'
        ? Array.isArray(operand)
          ? operand.map((item) => decodeListValue(item, type))
          : decodeListValue(operand, type)
        : operand;
  }
  return where;
}
