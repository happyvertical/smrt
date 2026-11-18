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
