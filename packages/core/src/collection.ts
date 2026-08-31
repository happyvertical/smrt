import { createLogger } from '@happyvertical/logger';
import { buildWhere, type DatabaseInterface } from '@happyvertical/sql';
import type { SmrtClassOptions } from './class';
import { SmrtClass } from './class';
import {
  buildQueryCacheKey,
  type CollectionCacheConfig,
  ensureCacheInvalidationListener,
  getCachedRows,
  getCacheGeneration,
  invalidateCollectionCache,
  registerCrossProcessCacheInterest,
  resolveDbCacheKey,
  setCachedRows,
} from './collection-cache';
// Leaf-module import (not './dispatch'): the dispatch barrel re-exports
// DispatchCollection, which extends SmrtCollection — importing the barrel from
// this module would create an evaluation-order cycle.
import {
  isTenantScopedClassResolved,
  resolveDispatchTenantScope,
} from './dispatch/tenant-resolver.js';
import { EmbeddingProvider } from './embeddings/provider';
import { EmbeddingStorage } from './embeddings/storage';
import type { ClassEmbeddingConfig } from './embeddings/types';
import {
  createInterceptorContext,
  GlobalInterceptors,
  type ListOptions as InterceptorListOptions,
  resolveGetStringFilter,
} from './interceptors';
import type { SmrtObject } from './object';
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  QueryBoundsError,
  QueryOrderByError,
} from './query-bounds';
import { ObjectRegistry } from './registry';
import type { SmrtObjectConstructor } from './registry/types';
import { detectEngine } from './schema/ddl/index';
import { verifyPersistenceTable } from './schema/table-verifier';
import {
  classnameToTablename,
  fieldsFromClass,
  formatDataJs,
  toCamelCase,
  toSafeInteger,
  toSnakeCase,
} from './utils';
import { chunkArray, IN_LIST_CHUNK_SIZE } from './utils/chunk';

const logger = createLogger({ level: 'info' });

/** SQL words outside comments and quoted literals/identifiers. */
function executableSqlWords(sql: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    const next = sql[index + 1];
    if (character === '-' && next === '-') {
      index = sql.indexOf('\n', index + 2);
      if (index === -1) break;
      continue;
    }
    if (character === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1;
          index += 2;
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth > 0) break;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      const backslashEscapes =
        quote === "'" &&
        index > 0 &&
        /[eE]/.test(sql[index - 1]) &&
        (index === 1 || !/[A-Za-z0-9_$]/.test(sql[index - 2]));
      index += 1;
      while (index < sql.length) {
        if (backslashEscapes && sql[index] === '\\') {
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (character === '$') {
      const tag = sql
        .slice(index)
        .match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (tag) {
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) break;
        index = end + tag.length;
        continue;
      }
    }
    if (/[A-Za-z_]/.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1;
      words.push(sql.slice(start, index).toLowerCase());
      continue;
    }
    index += 1;
  }
  return words;
}

function isMutatingSql(words: readonly string[]): boolean {
  return words.some((word, index) => {
    const next = words[index + 1];
    return (
      word === 'update' ||
      (word === 'insert' && next === 'into') ||
      (word === 'delete' && next === 'from') ||
      (word === 'merge' && next === 'into') ||
      (word === 'truncate' && next === 'table') ||
      (word === 'replace' && next === 'into')
    );
  });
}

/**
 * `_smrt_contexts.owner_id` value for collection-level (as opposed to
 * per-object) memory. Tenant-scoped collections suffix the active tenant id
 * (`__collection__:<tenantId>`) so learned memory never crosses tenants —
 * see {@link SmrtCollection.resolveCollectionMemoryOwnerId} (#2365).
 */
const COLLECTION_MEMORY_OWNER_ID = '__collection__';

/** Maximum number of independent facet fields accepted by one call. */
export const MAX_FACET_FIELDS = 20;

/** Default number of distinct values returned for each facet field. */
export const DEFAULT_FACET_LIMIT = DEFAULT_LIST_LIMIT;

/** Hard ceiling for distinct values returned for one facet field. */
export const MAX_FACET_LIMIT = MAX_LIST_LIMIT;

/** Maximum number of qualified STI discriminators accepted by one read. */
export const MAX_STI_READ_SCOPE_TYPES = 50;

/**
 * Validate an optional collection-level list bound (#2367).
 *
 * @returns the bound, or `undefined` when the option was not supplied
 * @throws {QueryBoundsError} when the option is present but not a positive
 *   integer — a `maxListLimit` of `0` or `-1` would silently make every read on
 *   the collection return nothing
 */
function assertOptionalListBound(
  value: number | undefined,
  optionName: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new QueryBoundsError(
      `Invalid ${optionName}: expected a positive integer, got ${String(value)}.`,
      'INVALID_QUERY_BOUNDS',
      { optionName, value },
    );
  }
  return value;
}

/**
 * Validate a per-query `limit`/`offset` before it is bound (#2367).
 *
 * `0` is allowed — `LIMIT 0` and `OFFSET 0` are both meaningful — but `NaN`,
 * `Infinity`, negatives and fractions are not: they used to be bound verbatim
 * and surface as a driver-level 500 for what is a caller error.
 *
 * @returns the bound, or `undefined` when the caller supplied none
 * @throws {QueryBoundsError} when the value is not a non-negative integer
 */
function assertQueryBound(
  value: number | undefined,
  parameterName: string,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QueryBoundsError(
      `Invalid ${parameterName}: expected a non-negative integer, got ${String(value)}.`,
      'INVALID_QUERY_BOUNDS',
      { parameterName, value },
    );
  }
  return value;
}

/**
 * Resolve _meta_type in WHERE clause from simple class name to qualified name (Issue #713)
 *
 * This helper function allows queries like { _meta_type: 'Image' } to work correctly
 * when the database stores qualified names like '@happyvertical/smrt-assets:Image'.
 *
 * @param where - The original WHERE clause object
 * @returns Modified WHERE clause with qualified _meta_type, or original if no resolution needed
 */
function resolveMetaTypeInWhere<T extends Record<string, unknown>>(
  where: T | T[][] | undefined,
): T | T[][] | undefined {
  if (Array.isArray(where)) {
    return where.map((group) =>
      group.map((condition) => resolveMetaTypeInWhere(condition) as T),
    );
  }
  if (!where?._meta_type || typeof where._meta_type !== 'string') {
    return where;
  }

  const metaTypeValue = where._meta_type as string;

  // Only resolve if it's a simple class name (no ':' means not qualified)
  if (metaTypeValue.includes(':')) {
    return where;
  }

  const registeredClass = ObjectRegistry.getClass(metaTypeValue);
  if (registeredClass?.qualifiedName) {
    return {
      ...where,
      _meta_type: registeredClass.qualifiedName,
    };
  }

  return where;
}

/** Add an AND predicate without collapsing a caller's DNF OR branches. */
function andWhereCondition<T extends Record<string, unknown>>(
  where: T | T[][] | undefined,
  condition: T,
): T | T[][] {
  if (Array.isArray(where)) {
    return where.map((group) => [condition, ...group]);
  }
  // The collection-owned predicate is an enforcement boundary (for example,
  // an STI child collection's discriminator), so it must win when a caller
  // supplies the same key.
  return { ...(where ?? {}), ...condition } as T;
}

/**
 * Field names that carry a stored embedding vector for a class (Issue #2281)
 *
 * `SmrtObject.generateEmbeddings()` writes one vector per configured field and,
 * when `combinedField` is set, an extra vector under `combinedField.name`. Any
 * of those names is a legitimate target for the collection's semantic-search
 * methods, so validation and error messages should describe the whole set.
 *
 * @param config - Resolved embedding configuration for the class
 * @returns Configured field names, plus the combined field name when distinct
 */
function getSearchableEmbeddingFields(
  config: Pick<ClassEmbeddingConfig, 'fields' | 'combinedField'>,
): string[] {
  const combinedName = config.combinedField?.name;
  if (!combinedName || config.fields.includes(combinedName)) {
    return config.fields;
  }
  return [...config.fields, combinedName];
}

/**
 * Keys from SmrtObject and SmrtClass that should not appear as user-facing
 * create/update input fields. These are framework-internal properties.
 */
type SmrtInternalKeys =
  | keyof SmrtClass
  | '_tableName'
  | '_loadedRelationships'
  | '_id'
  | '_slug'
  | '_context'
  | '_ai'
  | '_fs'
  | '_db'
  | '_className'
  | 'options'
  | '_skipLoad'
  | '_skipAutoEmbeddings'
  | '_extractingFields'
  | 'initialize'
  | 'save'
  | 'delete'
  | 'loadFromId'
  | 'loadFromSlug'
  | 'is'
  | 'do'
  | 'toJSON'
  | 'transformJSON';

/**
 * Input type for `collection.create()`. Constrains input to valid model fields
 * while preserving backwards compatibility via an index signature escape hatch.
 *
 * Provides IDE autocompletion for known fields from the model class while still
 * accepting arbitrary keys for dynamic usage patterns (e.g., STI meta fields).
 *
 * @example
 * ```typescript
 * // IDE will suggest: name, price, quantity, categoryId, etc.
 * await productCollection.create({
 *   name: 'Widget',
 *   price: 9.99,
 *   _meta_type: 'SpecialProduct', // STI discriminator
 * });
 * ```
 */
export type SmrtCreateInput<T extends SmrtObject> = Partial<
  Omit<
    {
      [K in keyof T as T[K] extends (...args: never[]) => unknown
        ? never
        : K]: T[K];
    },
    SmrtInternalKeys
  >
> & {
  /** STI discriminator for polymorphic creation */
  _meta_type?: string;
  /** Skip database loading (framework internal) */
  _skipLoad?: boolean;
  /** Skip save-time embedding auto-generation (framework internal) */
  _skipAutoEmbeddings?: boolean;
  /**
   * Persist via a plain INSERT instead of the natural-key upsert: a collision
   * on the primary key or any unique constraint raises a typed error rather
   * than dedup-updating an existing row in place. For write paths where row
   * identity is an explicit client-supplied `id` (sync-apply, #1759).
   */
  _insertOnly?: boolean;
  /** Allow arbitrary additional fields for dynamic usage */
  [key: string]: unknown;
};

/**
 * Basic WHERE clause type for point lookups and AND-only collection reads.
 *
 * Uses `Record<string, unknown>` because WHERE keys often include operator
 * suffixes (e.g., `'price >'`, `'name like'`, `'status in'`) which can't be
 * expressed as mapped types from model properties. Runtime validation in
 * `convertWhereKeys()` handles field and operator checking.
 */
export type SmrtWhereClause<T extends SmrtObject> = Record<string, unknown>;

/**
 * Bounded disjunctive-normal-form WHERE clause for collection list/count/facet
 * reads. Inner arrays are ANDed and outer arrays are ORed by the SQL adapter.
 * Keeping this at the collection boundary preserves field validation, STI, and
 * tenant interception for callers that need an allowlisted `any` filter.
 */
export type SmrtListWhereClause<T extends SmrtObject> =
  | SmrtWhereClause<T>
  | SmrtWhereClause<T>[][];

type SmrtModelData<T extends SmrtObject> = Omit<
  {
    [K in keyof T as T[K] extends (...args: never[]) => unknown
      ? never
      : K]: T[K];
  },
  SmrtInternalKeys
>;

/**
 * Logical field names accepted by `collection.list({ select })`.
 *
 * `select` is intentionally a column-backed projection primitive: callers pass
 * SMRT field names such as `parentId`, and the collection maps them to database
 * columns such as `parent_id` while returning rows keyed by the original SMRT
 * field names.
 */
export type SmrtSelectField<T extends SmrtObject> =
  | Extract<keyof SmrtModelData<T>, string>
  | 'id'
  | 'slug'
  | 'context'
  | 'created_at'
  | 'updated_at'
  | '_meta_type';

type SmrtCoreSelectedFieldData = {
  id: string | null | undefined;
  slug: string | null | undefined;
  context: string;
  created_at: Date | null | undefined;
  updated_at: Date | null | undefined;
  _meta_type: string;
};

/**
 * Plain row shape returned by `collection.list({ select })`.
 */
export type SmrtSelectedRow<
  T extends SmrtObject,
  Select extends readonly SmrtSelectField<T>[],
> = {
  [Field in Select[number]]: Field extends keyof SmrtCoreSelectedFieldData
    ? SmrtCoreSelectedFieldData[Field]
    : Field extends keyof SmrtModelData<T>
      ? SmrtModelData<T>[Field]
      : unknown;
};

/** A field requested by {@link SmrtCollection.facets}. */
export interface SmrtFacetRequest<T extends SmrtObject> {
  /** A column-backed SMRT field name (for example, `status`). */
  field: SmrtSelectField<T>;
  /**
   * Maximum number of values to return. Omit to use the collection's
   * `defaultListLimit` or 50, subject to `maxListLimit` and the hard maximum
   * facet limit.
   */
  limit?: number;
}

/** One distinct facet value and the number of matching rows containing it. */
export interface SmrtFacetValue {
  value: unknown;
  count: number;
}

/** Database-backed values returned for one requested facet field. */
export interface SmrtFacetResult {
  field: string;
  values: SmrtFacetValue[];
}

/** Options for a database-backed facet query. */
export interface SmrtFacetOptions<T extends SmrtObject> {
  /**
   * One or more fields (at most {@link MAX_FACET_FIELDS}). Each field may
   * optionally carry its own value limit.
   */
  fields: readonly (SmrtSelectField<T> | SmrtFacetRequest<T>)[];
  /** The same SMRT WHERE syntax accepted by {@link SmrtCollection.list}. */
  where?: SmrtListWhereClause<T>;
  /** Explicit sibling discriminator scope for an STI child collection. */
  stiScope?: SmrtStiReadScope;
}

/** Exact unfiltered and filtered row counts for a list scope. */
export interface SmrtCollectionCounts {
  total: number;
  filtered: number;
}

/**
 * Explicit, bounded discriminator scope for reads through an STI child
 * collection. Every entry must be a registered qualified type in the same STI
 * hierarchy as the collection item.
 */
export interface SmrtStiReadScope {
  types: readonly string[];
}

export interface SmrtListOptions<ModelType extends SmrtObject> {
  where?: SmrtListWhereClause<ModelType>;
  offset?: number;
  limit?: number;
  orderBy?: string | string[];
  /**
   * Column-backed field projection. When present, `list()` returns plain rows
   * instead of hydrated model instances.
   */
  select?: readonly SmrtSelectField<ModelType>[];
  /**
   * Relationships to eagerly load. Only supported for hydrated list() calls.
   */
  include?: string[];
  /**
   * Opt-in read-through cache for this call (issue #1498).
   */
  cache?: CollectionCacheConfig | false;
  /**
   * Opt in to reading an allowlist of sibling types through an STI child
   * collection. Omit to retain the child-only discriminator scope.
   */
  stiScope?: SmrtStiReadScope;
}

/**
 * Declarative latest-row configuration for a declared `@oneToMany` relation.
 *
 * `orderBy` determines which related row wins for each parent. `sortBy`, when
 * supplied, orders parent rows by a field on that winning row before the
 * parent's own `limit`/`offset` are applied. Related rows are returned as
 * plain selected data rather than hydrated objects so this remains a bounded
 * read primitive.
 */
export interface SmrtLatestRelatedOptions {
  /** The `@oneToMany` field on the parent collection's item class. */
  relation: string;
  /** Related field(s) used to select the latest row, e.g. `createdAt DESC`. */
  orderBy: string | string[];
  /** Column-backed related fields returned in `latestRelated`. Defaults to the declared related primary key. */
  select?: readonly string[];
  /** Related field(s) used to order parent rows by the selected latest row. */
  sortBy?: string | string[];
}

/** Options accepted by {@link SmrtCollection.listWithLatestRelated}. */
export type SmrtLatestRelatedListOptions<ModelType extends SmrtObject> = Omit<
  SmrtListOptions<ModelType>,
  'select' | 'include' | 'cache'
> & {
  latestRelated: SmrtLatestRelatedOptions;
};

/** A hydrated parent paired with its selected latest related row, if present. */
export interface SmrtLatestRelatedRow<ModelType extends SmrtObject> {
  parent: ModelType;
  latestRelated: Record<string, unknown> | null;
}

/**
 * Minimal runtime shape of a field definition as consumed by the collection's
 * query/hydration helpers (`getFieldsSync()`, `convertWhereKeys()`,
 * `formatDataJs()`). These come from `fieldsFromClass()` /
 * `ObjectRegistry.getFields()` and only a few members are read here: `type`
 * (for `formatDataJs` value coercion) and the field-level access markers. The
 * index signature keeps the bag open for the other registry-attached members
 * without forcing `any`.
 */
interface CollectionFieldDefinition {
  type?: string;
  primaryKey?: boolean;
  transient?: boolean;
  sensitive?: boolean;
  readPermission?: string;
  _meta?: {
    sensitive?: boolean;
    readPermission?: string;
    transient?: boolean;
    primaryKey?: boolean;
    __smrtSystemField?: boolean;
  } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Configuration options for SmrtCollection
 */
export interface SmrtCollectionOptions extends SmrtClassOptions {
  /**
   * Page size `list()` applies when the caller passes no `limit` (#2367).
   *
   * Unset by default — `list()` is the framework's bulk-read primitive and its
   * internal callers expect every matching row, so an implicit default would
   * truncate correct queries. Set this on collections whose reads are always
   * paged.
   */
  defaultListLimit?: number;

  /**
   * Ceiling `list()` clamps every `limit` down to (#2367).
   *
   * Unset by default. The generated REST/SvelteKit/MCP surfaces enforce
   * `MAX_LIST_LIMIT` on their own untrusted input regardless of this option;
   * set it to extend the same ceiling to direct programmatic reads.
   */
  maxListLimit?: number;
}

// S4 #1579: the constructor `options` and static `create(options)` params are
// left as `any` deliberately. This type is satisfied by every concrete model
// class (`static readonly _itemClass = Product`), whose constructor/`create`
// option bag is contravariant — narrowing to `SmrtCreateInput<ModelType>` or
// `unknown` rejects those assignments. Mirrors the `SmrtObjectConstructor`
// escape hatch in registry/types.
export type SmrtCollectionItemClass<ModelType extends SmrtObject> = (new (
  // biome-ignore lint/suspicious/noExplicitAny: contravariant constructor option bag — narrowing to `SmrtCreateInput<ModelType>`/`unknown` rejects every concrete `static _itemClass = Product` assignment. Mirrors `SmrtObjectConstructor`. S4 #1579.
  options: any,
) => ModelType) & {
  // biome-ignore lint/suspicious/noExplicitAny: contravariant `create()` option bag — same variance constraint as the constructor above. S4 #1579.
  create(options: any): ModelType | Promise<ModelType>;
};

/**
 * Typed CRUD collection for a specific `SmrtObject` subclass.
 *
 * Each concrete collection pairs with exactly one model class via the required
 * `static readonly _itemClass` property. Use the static `create()` factory —
 * not `new` — to get a fully initialized, ready-to-query instance.
 *
 * Key capabilities:
 * - **Query**: `list()`, `get()`, `count()`, `query()` (raw SQL), `listByIds()`
 * - **Mutation**: `create()`, `getOrUpsert()`, `delete()`
 * - **Eager loading**: pass `include: ['fieldName']` to `list()` to avoid N+1 queries
 * - **STI support**: automatically filters by `_meta_type` for child collections;
 *   polymorphically hydrates the correct subclass when listing/getting
 * - **Interceptors**: all read/write paths run `GlobalInterceptors` hooks
 *   (used by multi-tenancy, audit logging, etc.)
 *
 * @typeParam ModelType - The `SmrtObject` subclass managed by this collection
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   name: string = '';
 *   price: number = 0.0;
 * }
 *
 * @smrt()
 * class Products extends SmrtCollection<Product> {
 *   static readonly _itemClass = Product;
 * }
 *
 * const products = await Products.create({ db: myDb });
 * const widget = await products.create({ name: 'Widget', price: 9.99 });
 * const all = await products.list({ where: { 'price >': 5 }, orderBy: 'price ASC' });
 * ```
 */
export class SmrtCollection<ModelType extends SmrtObject> extends SmrtClass {
  /**
   * Cached fields for sync access during queries.
   * Populated during create() to avoid async getFields() calls on every query.
   * @private
   */
  private _cachedFields: Record<string, CollectionFieldDefinition> | null =
    null;

  /**
   * Opt-in list bounds (#2367). See {@link SmrtCollectionOptions.defaultListLimit}
   * and {@link SmrtCollectionOptions.maxListLimit}.
   * @private
   */
  private _defaultListLimit: number | undefined;
  private _maxListLimit: number | undefined;

  private getRegisteredItemClass() {
    return (
      ObjectRegistry.getClassByConstructor(
        this._itemClass as unknown as SmrtObjectConstructor,
      ) || ObjectRegistry.getClass(this._itemClass.name)
    );
  }

  private getResolvedItemClassName(): string {
    return this.getRegisteredItemClass()?.name || this._itemClass.name;
  }

  private getResolvedItemQualifiedName(): string {
    const registered = this.getRegisteredItemClass();
    return (
      registered?.qualifiedName || registered?.name || this._itemClass.name
    );
  }

  /** Apply and validate this collection's owned STI discriminator predicate. */
  private applyStiReadScope(
    where: SmrtListWhereClause<ModelType> | undefined,
    stiScope: SmrtStiReadScope | undefined,
  ): SmrtListWhereClause<ModelType> | undefined {
    const itemQualifiedName = this.getResolvedItemQualifiedName();
    const isSTI = ObjectRegistry.getTableStrategy(itemQualifiedName) === 'sti';
    const stiBase = isSTI ? ObjectRegistry.getSTIBase(itemQualifiedName) : null;
    const isChild = stiBase !== null && stiBase !== itemQualifiedName;

    if (stiScope === undefined) {
      return isChild
        ? andWhereCondition(where, { _meta_type: itemQualifiedName })
        : where;
    }
    if (
      !stiScope ||
      typeof stiScope !== 'object' ||
      Array.isArray(stiScope) ||
      Object.keys(stiScope).some((key) => key !== 'types') ||
      !Array.isArray(stiScope.types)
    ) {
      throw new Error(
        'Invalid stiScope: expected { types: readonly qualified STI type[] }.',
      );
    }
    if (!isChild) {
      throw new Error(
        'Invalid stiScope: explicit discriminator scopes require an STI child collection.',
      );
    }
    if (stiScope.types.length === 0) {
      throw new Error('Invalid stiScope: types must not be empty.');
    }
    if (stiScope.types.length > MAX_STI_READ_SCOPE_TYPES) {
      throw new Error(
        `Invalid stiScope: at most ${MAX_STI_READ_SCOPE_TYPES} types are allowed.`,
      );
    }

    const seen = new Set<string>();
    for (const type of stiScope.types) {
      if (
        typeof type !== 'string' ||
        !/^@[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?:[A-Za-z_$][A-Za-z0-9_$]*$/.test(
          type,
        )
      ) {
        throw new Error(
          `Invalid stiScope type: '${String(type)}' must be a qualified SMRT type.`,
        );
      }
      if (seen.has(type)) {
        throw new Error(`Invalid stiScope: duplicate type '${type}'.`);
      }
      seen.add(type);

      const registered = ObjectRegistry.getClass(type);
      if (!registered || registered.qualifiedName !== type) {
        throw new Error(`Invalid stiScope: unknown type '${type}'.`);
      }
      const typeBase = ObjectRegistry.getSTIBase(type);
      if (
        ObjectRegistry.getTableStrategy(type) !== 'sti' ||
        typeBase !== stiBase
      ) {
        throw new Error(
          `Invalid stiScope: type '${type}' does not share STI root '${stiBase}'.`,
        );
      }
    }

    return andWhereCondition(where, {
      '_meta_type in': [...stiScope.types],
    });
  }

  /**
   * Resolve the identifier whitelist and the sensitive-column blocklist that
   * every caller-supplied identifier on this collection is checked against.
   *
   * Extracted from `convertWhereKeys()` so `orderBy` validation enforces the
   * *same* sets (#2367). `where` (#1540) and `select` (#1902) both rejected
   * sensitive columns while `orderBy` accepted any identifier, which made
   * `?orderBy=api_secret&limit=1` an ordering oracle over a column the same
   * request is forbidden to filter on or project.
   *
   * @returns the snake_case identifiers this collection accepts, the sensitive
   *   names it must refuse, and whether whitelist enforcement applies at all —
   *   classes with no registered fields (manifest-less inline test classes,
   *   #869) have nothing to validate against and fall through to SQL.
   * @private
   */
  private collectQueryableFieldNames(
    fields: Record<string, CollectionFieldDefinition>,
  ): {
    validFieldNames: Set<string>;
    sensitiveFieldNames: Set<string>;
    readPermissionFieldNames: Set<string>;
    skipFieldValidation: boolean;
  } {
    // `toSnakeCase()` — the SAME function `SchemaGenerator` names columns with
    // (`schema/generator.ts`) — so this set holds real column names. Note it
    // STRIPS a leading underscore, while `toDbColumnName()` preserves one; the
    // two disagree for a declared `_rank` field, whose actual column is `rank`.
    // `orderBy` reconciles that at the term (see `buildOrderBySql`).
    const validFieldNames = new Set(
      Object.keys(fields).map((f) => toSnakeCase(f)),
    );

    // Security (#1540): collect snake_case names of `@field({ sensitive: true })`
    // columns so they can't be used as `where` filter keys. Filtering on a
    // secret column turns the generated REST/MCP `where` surface into a value
    // oracle (e.g. `apiSecret[like]=sk-%`), exfiltrating the secret one
    // character at a time even though it's excluded from serialization.
    const sensitiveFieldNames = this.collectSensitiveFieldNames(fields);

    // Security (#2367): the same collection for `@field({ readPermission })`
    // columns. These are stripped from `toPublicJSON()` for callers without the
    // permission and are refused outright by `select`, so ordering by one is the
    // same oracle in a different door. Kept in its own set because `where`
    // (#1540) deliberately does not consult it and this must not change that.
    const readPermissionFieldNames =
      this.collectReadPermissionFieldNames(fields);

    // Add standard SMRT fields that are always valid
    validFieldNames.add('id');
    validFieldNames.add('slug');
    validFieldNames.add('context');
    validFieldNames.add('created_at');
    validFieldNames.add('updated_at');

    // Add STI discriminator field for polymorphic queries.
    // R5-canon: use the qualified item name as the lookup key so a
    // same-simple-name class in another package can't yield the wrong
    // tableStrategy.
    const itemClassName = this.getResolvedItemClassName();
    const itemQualifiedName = this.getResolvedItemQualifiedName();
    const tableStrategy = ObjectRegistry.getTableStrategy(itemQualifiedName);
    if (tableStrategy === 'sti') {
      // Add both with and without leading underscore (toSnakeCase strips leading _)
      validFieldNames.add('_meta_type');
      validFieldNames.add('meta_type');
      validFieldNames.add('_meta_data');
      validFieldNames.add('meta_data');

      // Issue #869: For STI classes, also include fields from all ancestor classes
      // This ensures child class collections can filter by parent class fields.
      //
      // inheritanceChain entries are qualified names (when the
      // registration has one). Compare self against the qualified form;
      // the framework-base sentinels stay as simple names since they're
      // never registered. The simple-name `itemClassName` is also checked
      // as a defensive fall-through for unqualified registrations.
      const inheritanceChain =
        ObjectRegistry.getInheritanceChain(itemQualifiedName);
      for (const ancestorName of inheritanceChain) {
        if (
          ancestorName === 'SmrtObject' ||
          ancestorName === 'SmrtClass' ||
          ancestorName === itemQualifiedName ||
          ancestorName === itemClassName
        ) {
          continue; // Skip framework base classes and self (already included)
        }
        const ancestorFields = ObjectRegistry.getFields(ancestorName);
        for (const fieldName of ancestorFields.keys()) {
          validFieldNames.add(toSnakeCase(fieldName));
        }
        this.collectSensitiveFieldNames(ancestorFields, sensitiveFieldNames);
        this.collectReadPermissionFieldNames(
          ancestorFields,
          readPermissionFieldNames,
        );
      }

      // Security (#1540): a base collection serializes (and so must protect)
      // STI descendant fields too — a child's `@meta` sensitive field lives in
      // `_meta_data` and would otherwise be probe-able via `_meta_data.<prop>`
      // from the base collection. Mirror toJSON()/getSensitiveFieldNames().
      const stiBase = ObjectRegistry.getSTIBase(itemQualifiedName);
      if (stiBase) {
        for (const descendant of ObjectRegistry.getDescendants(stiBase)) {
          const descendantFields = ObjectRegistry.getFields(descendant);
          this.collectSensitiveFieldNames(
            descendantFields,
            sensitiveFieldNames,
          );
          this.collectReadPermissionFieldNames(
            descendantFields,
            readPermissionFieldNames,
          );
        }
      }
    }

    // Issue #869: If no fields are registered (no manifest for test classes),
    // skip field validation. Invalid fields will fail at SQL level instead.
    // This commonly happens for inline test classes decorated with @smrt().
    return {
      readPermissionFieldNames,
      skipFieldValidation: Object.keys(fields).length === 0,
      sensitiveFieldNames,
      validFieldNames,
    };
  }

  /**
   * Build the `ORDER BY` clause for `list()`, validating every term against the
   * same whitelist and sensitive-column blocklist as `where` and `select`
   * (#2367).
   *
   * `orderBy` is interpolated UNPARAMETERIZED into the identifier position, and
   * it arrives from the generated REST/MCP/SvelteKit surfaces as caller input.
   * The identifier regex here has always blocked injection; what it did not
   * block was ordering by a column the caller may not read. Sorting is a
   * comparison, and a comparison against a secret is an oracle: repeatedly
   * requesting `?orderBy=api_secret&limit=1` (with a shrinking `where`) walks
   * the secret's value ordering without ever serializing the column.
   *
   * @param orderBy - one `'<field> [ASC|DESC]'` term or an array of them
   * @param fields - the collection's cached field definitions
   * @returns the `' ORDER BY ...'` fragment, or `''` when no ordering was asked
   *   for
   * @throws {QueryOrderByError} on a malformed term, an unknown column, or a
   *   sensitive column — all rendered as a 400 by the generated surfaces
   * @private
   */
  private buildOrderBySql(
    orderBy: string | string[] | undefined,
    fields: Record<string, CollectionFieldDefinition>,
  ): string {
    if (!orderBy) return '';

    const orderByItems = Array.isArray(orderBy) ? orderBy : [orderBy];
    if (orderByItems.length === 0) return '';

    const itemClassName = this.getResolvedItemClassName();
    const {
      readPermissionFieldNames,
      sensitiveFieldNames,
      skipFieldValidation,
      validFieldNames,
    } = this.collectQueryableFieldNames(fields);

    // Column → definition, so a term can be checked for column-backing after it
    // passes the name whitelist. Keyed by `toSnakeCase` because that is what
    // `SchemaGenerator` names the column with — a declared `_rank` field lives
    // in a column called `rank`, not `_rank`.
    const definitionByColumn = new Map<string, CollectionFieldDefinition>();
    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      definitionByColumn.set(toSnakeCase(fieldName), fieldDef);
    }

    // `id`/`slug`/`context` are added to the whitelist unconditionally, but the
    // schema generator omits them for a class that declares its own primary key.
    // Without this, `?orderBy=id` on such a model passes the whitelist, matches
    // no definition, and reaches the driver as `no such column: id` — a 500.
    // Same derivation `resolveProjectionSelect` uses for `select`.
    const customPrimaryKey = this.hasCustomPrimaryKey(fields);
    const registeredFields = ObjectRegistry.getFields(
      this.getResolvedItemQualifiedName(),
    );
    const explicitFieldNames = new Set(
      (registeredFields.size > 0
        ? registeredFields
        : ObjectRegistry.getFields(itemClassName)
      ).keys(),
    );

    const terms = orderByItems.map((item) => {
      const [field, direction = 'ASC'] = String(item).trim().split(/\s+/);

      // Validate field name
      if (!/^[a-zA-Z0-9_]+$/.test(field)) {
        throw new QueryOrderByError(
          `Invalid field name for ordering: ${field}`,
          `Invalid field name for ordering: ${field}`,
          'INVALID_ORDER_BY',
          { field },
        );
      }

      // Validate direction
      const normalizedDirection = direction.toUpperCase();
      if (normalizedDirection !== 'ASC' && normalizedDirection !== 'DESC') {
        throw new QueryOrderByError(
          `Invalid sort direction: ${direction}. Must be ASC or DESC.`,
          `Invalid sort direction: ${direction}. Must be ASC or DESC.`,
          'INVALID_ORDER_BY',
          { direction },
        );
      }

      // Resolve the term to a real column. The two normalizations disagree on a
      // leading underscore, and each is right for a different case:
      //
      // - a DECLARED field is named by `toSnakeCase`, which strips it, so
      //   `_rank` lives in a column called `rank`;
      // - the STI framework columns `_meta_type`/`_meta_data` really do carry
      //   the underscore and are never declared fields.
      //
      // Prefer the declared column when one exists, otherwise keep the
      // underscore-preserving form so `_metaType` still reaches `_meta_type`.
      // Emitting the resolved name (rather than one normalization applied
      // blindly) is what keeps a term that passes the whitelist from naming a
      // column that does not exist.
      const strippedName = toSnakeCase(field);
      const columnName = definitionByColumn.has(strippedName)
        ? strippedName
        : this.toDbColumnName(field);

      // Security (#2367): refuse sensitive columns before the whitelist check,
      // so the rejection reason for a secret is never "no such field" (which
      // would itself confirm the column exists elsewhere).
      if (
        sensitiveFieldNames.has(columnName) ||
        sensitiveFieldNames.has(field)
      ) {
        throw new QueryOrderByError(
          `Invalid orderBy field: '${field}'. Ordering by sensitive fields is not allowed.`,
          `Invalid orderBy field: '${field}'. Ordering by sensitive fields is not allowed.`,
          'INVALID_ORDER_BY_SENSITIVE',
          { field },
        );
      }

      // Security (#2367): same for `@field({ readPermission })` columns.
      // `toPublicJSON()` redacts them per caller and `select` refuses them, so
      // an ordering over one is the same oracle through a different door.
      if (
        readPermissionFieldNames.has(columnName) ||
        readPermissionFieldNames.has(field)
      ) {
        throw new QueryOrderByError(
          `Invalid orderBy field: '${field}'. Ordering by permission-gated fields is not allowed.`,
          `Invalid orderBy field: '${field}'. Ordering by permission-gated fields is not allowed.`,
          'INVALID_ORDER_BY_RESTRICTED',
          { field },
        );
      }

      // Whitelist, mirroring `where`. Skipped for manifest-less inline test
      // classes with no registered fields (#869), exactly as `where` does.
      if (!skipFieldValidation && !validFieldNames.has(columnName)) {
        throw new QueryOrderByError(
          `Invalid orderBy field: '${field}'. Field does not exist on ${itemClassName}. ` +
            `Valid fields: ${Array.from(validFieldNames).sort().join(', ')}`,
          // The public form omits the field list: the column list is schema
          // detail an unauthenticated caller has no need for.
          `Invalid orderBy field: '${field}'.`,
          'INVALID_ORDER_BY_UNKNOWN_FIELD',
          { field, itemClassName },
        );
      }

      // Being a registered field is not the same as being a column (#2367).
      // `oneToMany`/`manyToMany` are relationship-only, `meta` lives inside the
      // STI `_meta_data` blob, and `transient` is never persisted — the schema
      // generator emits no column for any of them. Ordering by one reached the
      // driver as `no such column`, which carries no 4xx status and so surfaced
      // as a 500 on a public endpoint. `select` already rejects the same set.
      const fieldDef = definitionByColumn.get(columnName);
      const fieldType = fieldDef?.type;
      const isTransient =
        fieldDef?.transient === true || fieldDef?._meta?.transient === true;
      if (
        fieldType === 'meta' ||
        fieldType === 'oneToMany' ||
        fieldType === 'manyToMany' ||
        isTransient ||
        this.isOmittedCustomPrimaryKeySystemField(
          columnName,
          customPrimaryKey,
          explicitFieldNames,
        )
      ) {
        throw new QueryOrderByError(
          `Invalid orderBy field: '${field}'. Field is not column-backed on ${itemClassName}.`,
          `Invalid orderBy field: '${field}'. Field is not column-backed.`,
          'INVALID_ORDER_BY_NOT_COLUMN_BACKED',
          { field, itemClassName },
        );
      }

      return `${columnName} ${normalizedDirection}`;
    });

    return ` ORDER BY ${terms.join(', ')}`;
  }

  /**
   * Apply this collection's configured list bounds (#2367).
   *
   * Both bounds are opt-in (`defaultListLimit` / `maxListLimit` collection
   * options) and default to unset. `list()` is the framework's bulk-read
   * primitive — relationship loaders, junction hydration and `listByIds()` all
   * go through it expecting every matching row — so a framework-wide implicit
   * default would silently truncate correct queries instead of bounding an
   * attack surface. The generated surfaces, where untrusted input actually
   * arrives, apply {@link DEFAULT_LIST_LIMIT}/{@link MAX_LIST_LIMIT}
   * unconditionally; an application that wants the same ceiling on its own
   * programmatic reads sets `maxListLimit` when constructing the collection.
   *
   * @private
   */
  private applyListBounds(limit: number | undefined): number | undefined {
    const effective = limit ?? this._defaultListLimit;
    if (effective === undefined) return undefined;
    return this._maxListLimit === undefined
      ? effective
      : Math.min(effective, this._maxListLimit);
  }

  /**
   * Convert WHERE clause field names from camelCase to snake_case while preserving operators.
   * Validates operators and field names to prevent SQL injection and invalid queries.
   *
   * Uses cached fields for sync access (issue #663) to avoid async overhead on every query.
   *
   * @param where - WHERE clause object with camelCase field names
   * @returns WHERE clause object with snake_case field names
   * @private
   *
   * @example
   * ```typescript
   * // Input: { 'typeId': 'foo', 'categoryId >': 100 }
   * // Output: { 'type_id': 'foo', 'category_id >': 100 }
   * ```
   */
  private convertWhereKeys(
    where: SmrtListWhereClause<ModelType>,
  ): SmrtListWhereClause<ModelType> {
    if (Array.isArray(where)) {
      if (
        where.length === 0 ||
        where.some((group) => !Array.isArray(group) || group.length === 0)
      ) {
        throw new Error(
          'Invalid DNF where clause: each OR branch must contain at least one condition.',
        );
      }
      return where.map((group) =>
        group.map((condition) => this.convertWhereKeysRecord(condition)),
      );
    }
    return this.convertWhereKeysRecord(where);
  }

  private convertWhereKeysRecord(
    where: Record<string, unknown>,
  ): Record<string, unknown> {
    // Whitelist of allowed SQL operators.
    //
    // This list is a contract, not a wish list (#2276): every entry must be an
    // operator `@happyvertical/sql`'s `parseConditionKey` recognises, because a
    // key this method accepts is passed straight to `buildWhere`. An operator
    // accepted here but unknown there is not "unimplemented" — `buildWhere`
    // fails to split it off the key, tries to read `"<field> <operator>"` as one
    // identifier, and throws `Invalid SQL identifier` from inside the query
    // builder. The caller gets a SQL-layer error naming SQL-layer concepts for a
    // query the API told them was valid. Keep this list in lockstep with
    // `VALID_OPERATORS` in `@happyvertical/sql`'s `shared/utils.ts`; the
    // "executes every accepted operator" test in
    // `src/__tests__/issue-2276-where-contract.test.ts` is what enforces it.
    const VALID_OPERATORS = [
      '=',
      '>',
      '<',
      '>=',
      '<=',
      '!=',
      'in',
      'not in',
      'like',
    ];

    // Operators callers reach for that this layer cannot honour, mapped to the
    // supported way to express the same intent. Being listed here only improves
    // the rejection message — these are rejected exactly like any other unknown
    // operator. A Map, not an object literal, because the lookup key is
    // caller-supplied: `{ 'name toString': 'x' }` would otherwise find
    // `Object.prototype.toString` and splice a function into the error text.
    const UNSUPPORTED_OPERATOR_HINTS = new Map<string, string>([
      // `contains` shipped in this whitelist but never existed in the SQL layer,
      // so it has always failed at execution (#2276). It is not re-implemented
      // here as `like '%value%'` because that would be a different operator
      // wearing its name: `%` and `_` in the value would silently become
      // wildcards (escaping them needs a `LIKE ... ESCAPE` clause `buildWhere`
      // cannot emit), and `LIKE` is case-insensitive on SQLite but
      // case-sensitive on PostgreSQL, so the same call would mean two things.
      // Restoring it belongs in the SQL layer, where the dialect is known —
      // tracked in happyvertical/sdk#1192.
      [
        'contains',
        "Use 'like' with explicit wildcards instead, e.g. { 'name like': '%term%' }.",
      ],
    ]);

    // Get schema fields for validation (sync from cache)
    const fields = this.getFieldsSync();
    const itemClassName = this.getResolvedItemClassName();
    const { sensitiveFieldNames, skipFieldValidation, validFieldNames } =
      this.collectQueryableFieldNames(fields);

    const converted: Record<string, unknown> = {};

    // Check for prototype pollution attempts using own properties only
    // __proto__ is a special property that doesn't show up in Object.entries()
    // but can still be checked with hasOwnProperty
    if (
      Object.hasOwn(where, '__proto__') ||
      Object.hasOwn(where, 'constructor') ||
      Object.hasOwn(where, 'prototype')
    ) {
      throw new Error(
        `Invalid WHERE clause: Prototype pollution attempts are not allowed. ` +
          `Detected dangerous properties in WHERE clause.`,
      );
    }

    for (const [key, value] of Object.entries(where)) {
      // Split field name and operator (e.g., "typeId >" → ["typeId", ">"])
      const parts = key.trim().split(/\s+/);
      const fieldName = parts[0];
      const operator = parts.slice(1).join(' ') || '=';

      // Check for dangerous prototype pollution field names
      if (
        fieldName === '__proto__' ||
        fieldName === 'constructor' ||
        fieldName === 'prototype' ||
        fieldName.includes('__proto__') ||
        fieldName.includes('constructor') ||
        fieldName.includes('prototype')
      ) {
        throw new Error(
          `Invalid WHERE clause field: '${fieldName}'. ` +
            `Prototype pollution attempts are not allowed.`,
        );
      }

      // Split a dot-notation JSON path (e.g. 'metadata.userId') into its base
      // column and path suffix. The suffix is rejected further down (#2276), but
      // it is parsed and reassembled first so the guards between here and there
      // — the #1379 identifier check, the #1540 sensitive-`@meta`-path check,
      // and the schema field whitelist — still see the whole key rather than a
      // truncated column name.
      const dotIndex = fieldName.indexOf('.');
      const baseFieldName =
        dotIndex >= 0 ? fieldName.substring(0, dotIndex) : fieldName;
      const jsonPath = dotIndex >= 0 ? fieldName.substring(dotIndex) : null;

      // Convert base field name to snake_case, preserving leading underscores
      const snakeBaseFieldName = baseFieldName.startsWith('_')
        ? `_${toSnakeCase(baseFieldName.slice(1))}`
        : toSnakeCase(baseFieldName);

      // Full snake_case field name with JSON path preserved
      const snakeFieldName = jsonPath
        ? `${snakeBaseFieldName}${jsonPath}`
        : snakeBaseFieldName;

      // Security (#1379): the field identifier — base column plus any
      // dot-notation JSON-path segments — is interpolated UNPARAMETERIZED into
      // the SQL field position by the downstream query builder. The manifest
      // whitelist below only validates the base column, and is skipped entirely
      // when a class has no registered fields (skipFieldValidation), so without
      // this guard a crafted key such as
      // `metadata.x))/**/UNION/**/SELECT/**/secret/**/FROM/**/users--`
      // (SQL comments substituting for blocked whitespace) injects arbitrary SQL
      // via the JSON-path suffix — remotely reachable through the generated
      // REST/MCP `where` surfaces and able to defeat the tenant filter. Enforce
      // that the whole identifier is a strict dot-separated identifier so no
      // parens/quotes/operators/whitespace can survive, regardless of whether
      // the manifest whitelist below runs.
      if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/.test(snakeFieldName)) {
        throw new Error(
          `Invalid WHERE clause field: '${fieldName}'. ` +
            `Field names must be identifiers (letters, digits, underscore) ` +
            `with optional dot-separated JSON-path segments.`,
        );
      }

      // Security (#1540): reject filters that target a sensitive column. This
      // runs before operator/field validation so the secret value-probing
      // oracle is closed even for otherwise-valid operators. We reject when the
      // base column itself is sensitive, OR when an STI `@meta` sensitive field
      // is probed via a `_meta_data.<prop>` JSON path (the prop keeps its
      // camelCase name). The JSON-path check is scoped to the `_meta_data`
      // column so legitimate filters on unrelated JSON fields (e.g.
      // `metadata.apiSecret` on a non-sensitive `metadata` column) aren't
      // falsely rejected.
      // Use the NORMALIZED column name so camelCase aliases (`_metaData`,
      // `metaData`) that also resolve to the `_meta_data` column are scoped in —
      // checking raw `baseFieldName` here let `_metaData.apiSecret` slip past
      // the segment check while still resolving to the meta column.
      const baseIsMetaData =
        snakeBaseFieldName === '_meta_data' ||
        snakeBaseFieldName === 'meta_data';
      const metaPathTargetsSensitive =
        baseIsMetaData &&
        !!jsonPath &&
        jsonPath
          .split('.')
          .filter(Boolean)
          .some(
            (segment) =>
              sensitiveFieldNames.has(segment) ||
              sensitiveFieldNames.has(toSnakeCase(segment)),
          );
      if (
        sensitiveFieldNames.has(snakeBaseFieldName) ||
        metaPathTargetsSensitive
      ) {
        throw new Error(
          `Invalid WHERE clause field: '${fieldName}'. ` +
            `Filtering on sensitive fields is not allowed.`,
        );
      }

      // Auto-detect IN operator when value is an array without explicit operator
      const effectiveOperator =
        operator === '=' && Array.isArray(value) ? 'in' : operator;

      // Validate operator
      if (!VALID_OPERATORS.includes(effectiveOperator)) {
        const hint = UNSUPPORTED_OPERATOR_HINTS.get(effectiveOperator);
        throw new Error(
          `Invalid WHERE clause operator: '${operator}'. ` +
            `Valid operators: ${VALID_OPERATORS.join(', ')}` +
            (hint ? `. ${hint}` : ''),
        );
      }

      // Validate field name exists in schema (validate base column name only)
      // Issue #869: Skip validation when no fields are registered (manifest-less test classes)
      if (!skipFieldValidation && !validFieldNames.has(snakeBaseFieldName)) {
        throw new Error(
          `Invalid WHERE clause field: '${fieldName}'. ` +
            `Field does not exist on ${itemClassName}. ` +
            `Valid fields: ${Array.from(validFieldNames).sort().join(', ')}`,
        );
      }

      // Reject dot-notation JSON paths (#2276).
      //
      // These validated but were never rewritten into a JSON extraction
      // expression, so `metadata.color` reached SQL verbatim, where it reads as
      // the qualified column reference `metadata.color` — a column `color` on a
      // table `metadata`. SQLite answers `no such column`, surfaced to the
      // caller as an opaque `DatabaseError: Failed to execute raw query` for a
      // query this method had just accepted.
      //
      // Rewriting them here would mean emitting dialect-specific extraction
      // (`json_extract(col, '$.path')` on SQLite, `col->>'path'` on
      // PostgreSQL/DuckDB) and resolving the comparison typing that differs
      // between them — `->>` yields text, so `metadata.count > 5` would compare
      // a string against a number on PostgreSQL while working on SQLite. That is
      // a feature with its own semantics to settle, not a repair of this
      // validator, so this rejects until it exists — tracked in #2282.
      //
      // Placed last among the field checks on purpose. Every guard above
      // describes a different problem with the same key, and each one's message
      // is more specific than this one: a sensitive `_meta_data.<prop>` path
      // must still report that it was rejected for being sensitive (#1540), and
      // a typo'd base column must still report that the column does not exist
      // rather than being told to "filter on the '<typo>' column itself". By
      // running here, the advice this message gives is only ever offered for a
      // column that actually exists — except under `skipFieldValidation`, where
      // the class has no registered fields and nothing knows which columns are
      // real (#869). There the base column named below is only the caller's own
      // word for it, exactly as it is for every other key on such a class.
      if (jsonPath) {
        throw new Error(
          `Invalid WHERE clause field: '${fieldName}'. ` +
            `Dot-notation JSON paths are not supported — the path is not ` +
            `rewritten into a JSON extraction expression, so it would reach SQL ` +
            `as a qualified column reference and fail at execution. ` +
            `Filter on the '${baseFieldName}' column itself, or filter the ` +
            `extracted values in application code.`,
        );
      }

      // Validate operator-specific value types
      if (
        (effectiveOperator === 'in' || effectiveOperator === 'not in') &&
        !Array.isArray(value)
      ) {
        throw new Error(
          `WHERE clause operator '${effectiveOperator}' requires an array value for field '${fieldName}', ` +
            `got ${typeof value}`,
        );
      }

      // Reject empty arrays for IN/NOT IN operators (generates invalid SQL)
      if (
        (effectiveOperator === 'in' || effectiveOperator === 'not in') &&
        Array.isArray(value) &&
        value.length === 0
      ) {
        throw new Error(
          `WHERE clause operator '${effectiveOperator}' requires a non-empty array for field '${fieldName}'. ` +
            `Use listByIds([]) for graceful empty array handling.`,
        );
      }

      if (effectiveOperator === 'like' && typeof value !== 'string') {
        throw new Error(
          `WHERE clause operator 'like' requires a string value for field '${fieldName}', ` +
            `got ${typeof value}`,
        );
      }

      // Reconstruct key with operator
      const newKey =
        effectiveOperator === '='
          ? snakeFieldName
          : `${snakeFieldName} ${effectiveOperator}`;

      converted[newKey] = value;
    }

    return converted;
  }

  private toDbColumnName(fieldName: string): string {
    return fieldName.startsWith('_')
      ? `_${toSnakeCase(fieldName.slice(1))}`
      : toSnakeCase(fieldName);
  }

  private assertSafeProjectionFieldName(fieldName: string): void {
    if (
      fieldName === '__proto__' ||
      fieldName === 'constructor' ||
      fieldName === 'prototype'
    ) {
      throw new Error(
        `Invalid select field: '${fieldName}'. Prototype pollution attempts are not allowed.`,
      );
    }

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName)) {
      throw new Error(
        `Invalid select field: '${fieldName}'. Field names must be identifiers (letters, digits, underscore).`,
      );
    }
  }

  private quoteProjectionIdentifier(identifier: string): string {
    this.assertSafeProjectionFieldName(identifier);
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private isSensitiveFieldDefinition(
    fieldDef: CollectionFieldDefinition | null | undefined,
  ): boolean {
    return fieldDef?.sensitive === true || fieldDef?._meta?.sensitive === true;
  }

  private getReadPermissionFieldDefinition(
    fieldDef: CollectionFieldDefinition | null | undefined,
  ): string | undefined {
    if (typeof fieldDef?.readPermission === 'string') {
      return fieldDef.readPermission;
    }
    if (typeof fieldDef?._meta?.readPermission === 'string') {
      return fieldDef._meta.readPermission;
    }
    return undefined;
  }

  private collectSensitiveFieldNames(
    fieldMap:
      | Record<string, CollectionFieldDefinition>
      | Map<string, CollectionFieldDefinition>,
    target = new Set<string>(),
  ): Set<string> {
    const entries =
      fieldMap instanceof Map ? fieldMap.entries() : Object.entries(fieldMap);

    for (const [fieldName, fieldDef] of entries) {
      if (this.isSensitiveFieldDefinition(fieldDef)) {
        // Store both the snake_case column form and the raw property name so
        // STI `@meta` fields probed via `_meta_data.<prop>` JSON paths (which
        // keep the camelCase key) are also rejected.
        target.add(toSnakeCase(fieldName));
        target.add(fieldName);
      }
    }

    return target;
  }

  /**
   * The `collectSensitiveFieldNames` sibling for `@field({ readPermission })`
   * columns (#2367).
   *
   * These are per-caller redacted by `toPublicJSON()` and refused outright by
   * `select`, so an ordering over one leaks comparisons about a value the
   * caller may not read. `list()` has no permission context, so — exactly as
   * `select` does — they are refused unconditionally rather than conditionally.
   */
  private collectReadPermissionFieldNames(
    fieldMap:
      | Record<string, CollectionFieldDefinition>
      | Map<string, CollectionFieldDefinition>,
    target = new Set<string>(),
  ): Set<string> {
    const entries =
      fieldMap instanceof Map ? fieldMap.entries() : Object.entries(fieldMap);

    for (const [fieldName, fieldDef] of entries) {
      if (this.getReadPermissionFieldDefinition(fieldDef) !== undefined) {
        target.add(toSnakeCase(fieldName));
        target.add(fieldName);
      }
    }

    return target;
  }

  private hasCustomPrimaryKey(
    fields: Record<string, CollectionFieldDefinition>,
  ): boolean {
    return Object.values(fields).some(
      (fieldDef) =>
        fieldDef.primaryKey === true || fieldDef._meta?.primaryKey === true,
    );
  }

  private resolvePrimaryKeyField(
    fields: Record<string, CollectionFieldDefinition>,
    label: string,
  ): { field: string; column: string } {
    const declared = Object.entries(fields)
      .filter(
        ([, fieldDef]) =>
          fieldDef.primaryKey === true || fieldDef._meta?.primaryKey === true,
      )
      .map(([field]) => field);
    if (declared.length > 1) {
      throw new Error(
        `${label} declares multiple primary-key fields (${declared.join(', ')}); listWithLatestRelated requires a single primary key.`,
      );
    }
    const field = declared[0] ?? 'id';
    return { field, column: this.toDbColumnName(field) };
  }

  private getDatabaseEngine(): ReturnType<typeof detectEngine> {
    const db = this.db as DatabaseInterface & {
      config?: { type?: string; url?: string };
      type?: string;
      client?: { constructor?: { name?: string }; connection?: unknown };
      exportTable?: unknown;
    };
    const clientName = db.client?.constructor?.name?.toLowerCase() ?? '';
    const isDuckDbConnection =
      clientName.includes('duckdb') ||
      (typeof db.exportTable === 'function' &&
        db.client !== undefined &&
        'connection' in db.client);
    return detectEngine(
      db.url || db.config?.url || '',
      this.getDatabaseEngineHint() ||
        db.type ||
        db.config?.type ||
        (isDuckDbConnection ? 'duckdb' : undefined),
    );
  }

  private getHydrationSelectSql(
    schema = ObjectRegistry.getSchema(this.getResolvedItemQualifiedName()) ??
      ObjectRegistry.getSchema(this.getResolvedItemClassName()),
  ): string {
    if (this.getDatabaseEngine() !== 'duckdb') return '*';
    const registeredFields =
      ObjectRegistry.getFields(this.getResolvedItemQualifiedName()).size > 0
        ? ObjectRegistry.getFields(this.getResolvedItemQualifiedName())
        : ObjectRegistry.getFields(this.getResolvedItemClassName());
    const itemColumns = new Set([
      'id',
      ...Array.from(registeredFields.keys(), (fieldName) =>
        this.toDbColumnName(fieldName),
      ),
    ]);
    const uuidColumns = Object.entries(schema?.columns ?? {})
      .filter(
        ([columnName, column]) =>
          itemColumns.has(columnName) &&
          String(column.type).toUpperCase() === 'UUID',
      )
      .map(([columnName]) => columnName);
    if (uuidColumns.length === 0) return '*';
    return `* REPLACE (${uuidColumns
      .map((columnName) => {
        const quoted = this.quoteProjectionIdentifier(columnName);
        return `CAST(${quoted} AS VARCHAR) AS ${quoted}`;
      })
      .join(', ')})`;
  }

  private hasDuckDbUuidColumnsOutsideHydrationSelect(): boolean {
    if (this.getDatabaseEngine() !== 'duckdb') return false;
    const qualifiedName = this.getResolvedItemQualifiedName();
    const className = this.getResolvedItemClassName();
    const schema =
      ObjectRegistry.getSchema(qualifiedName) ??
      ObjectRegistry.getSchema(className);
    const registeredFields =
      ObjectRegistry.getFields(qualifiedName).size > 0
        ? ObjectRegistry.getFields(qualifiedName)
        : ObjectRegistry.getFields(className);
    const selectedColumns = new Set([
      'id',
      ...Array.from(registeredFields.keys(), (fieldName) =>
        this.toDbColumnName(fieldName),
      ),
    ]);
    return Object.entries(schema?.columns ?? {}).some(
      ([columnName, column]) =>
        !selectedColumns.has(columnName) &&
        String(column.type).toUpperCase() === 'UUID',
    );
  }

  private isOmittedCustomPrimaryKeySystemField(
    fieldName: string,
    hasCustomPrimaryKey: boolean,
    explicitFieldNames: ReadonlySet<string>,
  ): boolean {
    return (
      hasCustomPrimaryKey &&
      !explicitFieldNames.has(fieldName) &&
      (fieldName === 'id' || fieldName === 'slug' || fieldName === 'context')
    );
  }

  private resolveProjectionSelect(
    select: readonly string[],
    fields: Record<string, CollectionFieldDefinition>,
    isSTI: boolean,
  ): { sql: string; outputFields: string[] } {
    if (!Array.isArray(select)) {
      throw new Error(
        'Invalid select option: expected an array of field names.',
      );
    }
    if (select.length === 0) {
      throw new Error(
        'Invalid select option: at least one field name is required.',
      );
    }

    const customPrimaryKey = this.hasCustomPrimaryKey(fields);
    const itemClassName = this.getResolvedItemClassName();
    const itemQualifiedName = this.getResolvedItemQualifiedName();
    const schema =
      ObjectRegistry.getSchema(itemQualifiedName) ??
      ObjectRegistry.getSchema(itemClassName);
    const schemaColumnNames = schema?.columns
      ? new Set(Object.keys(schema.columns))
      : undefined;
    const registeredFields = ObjectRegistry.getFields(itemQualifiedName);
    const explicitFields =
      registeredFields.size > 0
        ? registeredFields
        : ObjectRegistry.getFields(itemClassName);
    const explicitFieldNames = new Set(explicitFields.keys());

    const validFieldNames = new Set<string>();
    for (const [fieldName, fieldDef] of Object.entries(fields)) {
      if (
        this.isOmittedCustomPrimaryKeySystemField(
          fieldName,
          customPrimaryKey,
          explicitFieldNames,
        )
      ) {
        continue;
      }
      const columnName = this.toDbColumnName(fieldName);
      if (schemaColumnNames && !schemaColumnNames.has(columnName)) {
        continue;
      }
      validFieldNames.add(fieldName);
    }
    if (isSTI && (!schemaColumnNames || schemaColumnNames.has('_meta_type'))) {
      validFieldNames.add('_meta_type');
    }

    const seen = new Set<string>();
    const outputFields: string[] = [];
    const selectExpressions: string[] = [];

    for (const fieldName of select) {
      if (typeof fieldName !== 'string') {
        throw new Error(
          `Invalid select field: expected a string field name, got ${typeof fieldName}.`,
        );
      }
      this.assertSafeProjectionFieldName(fieldName);

      if (seen.has(fieldName)) {
        throw new Error(
          `Invalid select field: '${fieldName}' was requested more than once.`,
        );
      }
      seen.add(fieldName);

      if (!validFieldNames.has(fieldName)) {
        throw new Error(
          `Invalid select field: '${fieldName}'. Field does not exist on ${itemClassName}. ` +
            `Valid fields: ${Array.from(validFieldNames).sort().join(', ')}`,
        );
      }

      const fieldDef = fields[fieldName];
      const fieldType = fieldDef?.type;
      if (this.isSensitiveFieldDefinition(fieldDef)) {
        throw new Error(
          `Invalid select field: '${fieldName}' is sensitive and cannot be projected by collection.list({ select }).`,
        );
      }
      const readPermission = this.getReadPermissionFieldDefinition(fieldDef);
      if (readPermission) {
        throw new Error(
          `Invalid select field: '${fieldName}' is gated by readPermission '${readPermission}' and cannot be projected by collection.list({ select }).`,
        );
      }

      const isTransient =
        fieldDef?.transient === true || fieldDef?._meta?.transient === true;
      const isRelationshipOnly =
        fieldType === 'oneToMany' || fieldType === 'manyToMany';
      if (fieldType === 'meta' || isTransient || isRelationshipOnly) {
        throw new Error(
          `Invalid select field: '${fieldName}' is not a column-backed field on ${itemClassName}.`,
        );
      }

      const columnName = this.toDbColumnName(fieldName);
      const quotedColumn = this.quoteProjectionIdentifier(columnName);
      const selectValue =
        this.getDatabaseEngine() === 'duckdb' &&
        String(schema?.columns[columnName]?.type).toUpperCase() === 'UUID'
          ? `CAST(${quotedColumn} AS VARCHAR)`
          : quotedColumn;
      selectExpressions.push(
        `${selectValue} AS ${this.quoteProjectionIdentifier(fieldName)}`,
      );
      outputFields.push(fieldName);
    }

    return {
      sql: selectExpressions.join(', '),
      outputFields,
    };
  }

  /**
   * Parse and validate order terms while retaining the resolved database
   * column. The normal list order builder remains the source of truth for
   * field, sensitive-field, and permission validation; this companion shape
   * lets the latest-row CTE qualify the same safe identifiers with its alias.
   */
  private resolveOrderByTerms(
    orderBy: string | string[],
    fields: Record<string, CollectionFieldDefinition>,
    label: string,
  ): Array<{ field: string; column: string; direction: 'ASC' | 'DESC' }> {
    const validatedSql = this.buildOrderBySql(orderBy, fields);
    const items = Array.isArray(orderBy) ? orderBy : [orderBy];
    if (items.length === 0) {
      throw new Error(
        `Invalid ${label}: at least one order field is required.`,
      );
    }

    const validatedTerms = validatedSql
      .replace(/^ ORDER BY /, '')
      .split(', ')
      .map((term) => term.split(/\s+/));

    return items.map((item, index) => {
      const [field, direction = 'ASC'] = String(item).trim().split(/\s+/);
      if (!field) {
        throw new Error(`Invalid ${label}: an order field is required.`);
      }
      const normalizedDirection = direction.toUpperCase();
      if (normalizedDirection !== 'ASC' && normalizedDirection !== 'DESC') {
        throw new Error(
          `Invalid ${label} direction: ${direction}. Must be ASC or DESC.`,
        );
      }

      return {
        column: validatedTerms[index]?.[0] ?? this.toDbColumnName(field),
        direction: normalizedDirection,
        field,
      };
    });
  }

  private qualifyLatestOrderTerms(
    alias: string,
    terms: ReadonlyArray<{
      column: string;
      direction: 'ASC' | 'DESC';
    }>,
  ): string {
    return terms
      .flatMap((term) => {
        const column = `${alias}.${this.quoteProjectionIdentifier(term.column)}`;
        // Explicit NULLS LAST keeps ranking and parent sorting identical on
        // PostgreSQL, SQLite, DuckDB, and JSON-on-DuckDB.
        return [
          `CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END ASC`,
          `${column} ${term.direction}`,
        ];
      })
      .join(', ');
  }

  private qualifyLatestParentOrderTerms(
    alias: string,
    terms: ReadonlyArray<{
      column: string;
      direction: 'ASC' | 'DESC';
    }>,
  ): string {
    return terms
      .flatMap((term) => {
        const column = `${alias}.${this.quoteProjectionIdentifier(term.column)}`;
        return [
          `CASE WHEN ${column} IS NULL THEN 1 ELSE 0 END ASC`,
          `${column} ${term.direction}`,
        ];
      })
      .join(', ');
  }

  private resolveOneToManyInverseForeignKey(
    relationship: import('./registry').RelationshipMetadata,
  ): import('./registry').RelationshipMetadata {
    const inverseCandidates = ObjectRegistry.getInverseRelationshipsForSelf(
      this._itemClass.name,
    ).filter(
      (candidate) =>
        candidate.sourceClass === relationship.targetClass &&
        candidate.type === 'foreignKey',
    );
    const explicitForeignKey = relationship.options?.foreignKey as
      | string
      | undefined;
    const matchedForeignKey = explicitForeignKey
      ? inverseCandidates.find(
          (candidate) => candidate.fieldName === explicitForeignKey,
        )
      : undefined;
    if (explicitForeignKey && !matchedForeignKey) {
      throw new Error(
        `oneToMany ${relationship.fieldName} specifies foreignKey '${explicitForeignKey}', but ${relationship.targetClass} has no matching inverse foreignKey. Candidates: ${inverseCandidates.map((candidate) => candidate.fieldName).join(', ') || '(none)'}`,
      );
    }

    const inverseForeignKey =
      matchedForeignKey ??
      inverseCandidates.find(
        (candidate) => candidate.targetClass === this._itemClass.name,
      ) ??
      inverseCandidates[0];
    if (!inverseForeignKey) {
      throw new Error(
        `Could not find inverse foreignKey on ${relationship.targetClass} for oneToMany relationship ${relationship.fieldName}`,
      );
    }
    return inverseForeignKey;
  }

  /**
   * Load a page of hydrated parents with one selected latest row from a
   * declared `@oneToMany` relation. The parent page is sliced only after the
   * latest-row join and optional related sort are applied, so unrelated rows
   * are never hydrated in application code.
   *
   * Missing related rows return `latestRelated: null`. Related order and sort
   * fields place null values after non-null values consistently on all
   * supported adapters. The related row is a plain projection and is never a
   * full `SmrtObject` hydration.
   *
   * @example
   * ```typescript
   * const page = await opportunities.listWithLatestRelated({
   *   latestRelated: {
   *     relation: 'evaluations',
   *     orderBy: 'evaluatedAt DESC',
   *     select: ['score', 'evaluatedAt'],
   *     sortBy: 'score DESC',
   *   },
   *   limit: 25,
   *   offset: 0,
   * });
   * console.log(page[0].parent, page[0].latestRelated?.score);
   * ```
   */
  public async listWithLatestRelated(
    options: Omit<SmrtLatestRelatedListOptions<ModelType>, 'stiScope'> & {
      stiScope: SmrtStiReadScope;
    },
  ): Promise<SmrtLatestRelatedRow<SmrtObject>[]>;
  public async listWithLatestRelated(
    options: Omit<SmrtLatestRelatedListOptions<ModelType>, 'stiScope'> & {
      stiScope?: undefined;
    },
  ): Promise<SmrtLatestRelatedRow<ModelType>[]>;
  public async listWithLatestRelated(
    options: SmrtLatestRelatedListOptions<ModelType>,
  ): Promise<SmrtLatestRelatedRow<SmrtObject>[]>;
  public async listWithLatestRelated(
    options: SmrtLatestRelatedListOptions<ModelType>,
  ): Promise<SmrtLatestRelatedRow<SmrtObject>[]> {
    await this.ensureStorageReady();
    const itemClassName = this.getResolvedItemClassName();
    const itemQualifiedName = this.getResolvedItemQualifiedName();

    const interceptorContext = createInterceptorContext(
      itemClassName,
      'list',
      this.constructor.name,
    );
    const interceptedOptions =
      (await GlobalInterceptors.executeBeforeList(
        itemClassName,
        options as InterceptorListOptions,
        interceptorContext,
      )) ?? (options as InterceptorListOptions);

    let { where, offset, limit, orderBy, stiScope } =
      interceptedOptions as SmrtListOptions<ModelType>;
    const latestOptions =
      (interceptedOptions as SmrtLatestRelatedListOptions<ModelType>)
        .latestRelated ?? options.latestRelated;
    const tableStrategy = ObjectRegistry.getTableStrategy(itemQualifiedName);
    const isSTI = tableStrategy === 'sti';
    where = this.applyStiReadScope(where, stiScope);
    where = resolveMetaTypeInWhere(where);

    const relationship = ObjectRegistry.getRelationships(
      this._itemClass.name,
    ).find(
      (candidate) =>
        candidate.fieldName === latestOptions.relation &&
        candidate.type === 'oneToMany',
    );
    if (!relationship) {
      throw new Error(
        `latestRelated.relation '${latestOptions.relation}' is not a declared oneToMany relationship on ${itemClassName}.`,
      );
    }

    const inverseForeignKey =
      this.resolveOneToManyInverseForeignKey(relationship);
    const relatedCollection = await ObjectRegistry.getCollection(
      relationship.targetClass,
      this.options,
    );
    await relatedCollection.ensureStorageReady();
    const relatedFields = relatedCollection.getFieldsSync();
    const relatedItemClassName = relatedCollection.getResolvedItemClassName();
    const relatedQualifiedName =
      relatedCollection.getResolvedItemQualifiedName();
    const relatedIsSTI =
      ObjectRegistry.getTableStrategy(relatedQualifiedName) === 'sti';

    // Run the related collection's read-scope interceptors as well as the
    // parent's. Relation targets can have their own tenant or authorization
    // policy; omitting this scope would make the CTE a raw bypass of the
    // target collection's normal list contract.
    const relatedInterceptorContext = createInterceptorContext(
      relatedItemClassName,
      'list',
      relatedCollection.constructor.name,
    );
    const relatedInterceptedOptions =
      (await GlobalInterceptors.executeBeforeList(
        relatedItemClassName,
        { where: {} } as InterceptorListOptions,
        relatedInterceptorContext,
      )) ?? ({ where: {} } as InterceptorListOptions);
    let relatedWhere = (
      relatedInterceptedOptions as SmrtListOptions<SmrtObject>
    ).where;
    if (relatedIsSTI) {
      const relatedStiBase = ObjectRegistry.getSTIBase(relatedQualifiedName);
      if (relatedStiBase && relatedStiBase !== relatedQualifiedName) {
        relatedWhere = {
          _meta_type: relatedQualifiedName,
          ...(relatedWhere || {}),
        };
      }
    }
    relatedWhere = resolveMetaTypeInWhere(relatedWhere);
    const { sql: relatedWhereSql, values: relatedWhereValues } = buildWhere(
      relatedCollection.convertWhereKeys(relatedWhere || {}),
    );
    const relatedPrimaryKey = relatedCollection.resolvePrimaryKeyField(
      relatedFields,
      `Related model ${relatedItemClassName}`,
    );
    const relatedSelect = latestOptions.select ?? [relatedPrimaryKey.field];
    const relatedProjection = relatedCollection.resolveProjectionSelect(
      relatedSelect,
      relatedFields,
      relatedIsSTI,
    );
    const relatedOrderTerms = relatedCollection.resolveOrderByTerms(
      latestOptions.orderBy,
      relatedFields,
      'latestRelated.orderBy',
    );
    const relatedSortTerms = latestOptions.sortBy
      ? relatedCollection.resolveOrderByTerms(
          latestOptions.sortBy,
          relatedFields,
          'latestRelated.sortBy',
        )
      : [];

    const parentFields = this.getFieldsSync();
    const parentPrimaryKey = this.resolvePrimaryKeyField(
      parentFields,
      `Parent model ${itemClassName}`,
    );
    const relatedOutputFields = new Set(relatedProjection.outputFields);
    relatedOutputFields.add(relatedPrimaryKey.field);
    relatedOutputFields.add(inverseForeignKey.fieldName);
    if (parentFields.tenantId && relatedFields.tenantId) {
      relatedOutputFields.add('tenantId');
    }
    for (const term of [...relatedOrderTerms, ...relatedSortTerms]) {
      relatedOutputFields.add(term.field);
    }
    const relatedFieldColumns = new Map(
      [...relatedOrderTerms, ...relatedSortTerms].map((term) => [
        term.field,
        term.column,
      ]),
    );
    const parentSchema =
      ObjectRegistry.getSchema(itemQualifiedName) ??
      ObjectRegistry.getSchema(itemClassName);
    const liveParentSchema =
      typeof this.db.getTableSchema === 'function'
        ? await this.db.getTableSchema(this.tableName)
        : undefined;
    const parentColumnNames = Object.keys(
      liveParentSchema?.columns ?? parentSchema?.columns ?? {},
    );
    const occupiedParentIdentifiers = new Set([
      ...Object.keys(parentFields),
      ...Object.keys(parentFields).map((fieldName) =>
        this.toDbColumnName(fieldName),
      ),
      ...parentColumnNames,
      ...Object.keys(parentSchema?.columns ?? {}),
    ]);
    const relatedFieldAliases = new Map<string, string>();
    let nextAliasIndex = 0;
    for (const fieldName of relatedOutputFields) {
      let alias: string;
      do {
        alias = `__smrt_lr_${nextAliasIndex++}`;
      } while (
        occupiedParentIdentifiers.has(alias) ||
        [...relatedFieldAliases.values()].includes(alias)
      );
      relatedFieldAliases.set(fieldName, alias);
    }
    const parentSelectSql =
      parentColumnNames.length > 0
        ? parentColumnNames
            .map((columnName) => {
              const quoted = this.quoteProjectionIdentifier(columnName);
              return this.getDatabaseEngine() === 'duckdb' &&
                String(
                  parentSchema?.columns[columnName]?.type,
                ).toUpperCase() === 'UUID'
                ? `CAST(${quoted} AS VARCHAR) AS ${quoted}`
                : quoted;
            })
            .join(', ')
        : '*';
    const relatedAlias = (fieldName: string): string => {
      const alias = relatedFieldAliases.get(fieldName);
      if (!alias) {
        throw new Error(`Missing latest-related alias for '${fieldName}'.`);
      }
      return alias;
    };
    const relatedSelectExpressions = Array.from(relatedOutputFields).map(
      (fieldName) => {
        const column =
          relatedFieldColumns.get(fieldName) ??
          relatedCollection.toDbColumnName(fieldName);
        const alias = relatedAlias(fieldName);
        const quotedColumn =
          relatedCollection.quoteProjectionIdentifier(column);
        const relatedSchema =
          ObjectRegistry.getSchema(relatedQualifiedName) ??
          ObjectRegistry.getSchema(relatedItemClassName);
        const source = `r.${quotedColumn}`;
        const value =
          relatedCollection.getDatabaseEngine() === 'duckdb' &&
          String(relatedSchema?.columns[column]?.type).toUpperCase() === 'UUID'
            ? `CAST(${source} AS VARCHAR)`
            : source;
        return `${value} AS ${relatedCollection.quoteProjectionIdentifier(alias)}`;
      },
    );
    const relatedRankOrder = [
      relatedCollection.qualifyLatestOrderTerms('r', relatedOrderTerms),
      `r.${relatedCollection.quoteProjectionIdentifier(relatedPrimaryKey.column)} DESC`,
    ]
      .filter(Boolean)
      .join(', ');
    const latestRankAlias =
      relatedCollection.quoteProjectionIdentifier('__smrt_latest_rank');
    const latestRelatedAlias = (fieldName: string): string =>
      relatedCollection.quoteProjectionIdentifier(relatedAlias(fieldName));
    const relatedCte = `WITH ranked_latest_related AS (SELECT ${relatedSelectExpressions.join(
      ', ',
    )}, ROW_NUMBER() OVER (PARTITION BY r.${relatedCollection.quoteProjectionIdentifier(relatedCollection.toDbColumnName(inverseForeignKey.fieldName))} ORDER BY ${relatedRankOrder}) AS ${latestRankAlias} FROM ${relatedCollection.tableName} r${relatedWhereSql ? ` ${relatedWhereSql}` : ''}) `;

    const parentWhere = this.convertWhereKeys(where || {});
    const { sql: rawWhereSql, values: parentWhereValues } =
      buildWhere(parentWhere);
    const parentWhereSql = rawWhereSql.replace(
      /\$(\d+)/g,
      (_match, index: string) =>
        `$${Number(index) + relatedWhereValues.length}`,
    );
    const relatedJoinConditions = [
      `rr.${latestRankAlias} = 1`,
      `rr.${latestRelatedAlias(inverseForeignKey.fieldName)} = ${this.quoteProjectionIdentifier(parentPrimaryKey.column)}`,
    ];
    if (parentFields.tenantId && relatedFields.tenantId) {
      relatedJoinConditions.push(
        `(rr.${latestRelatedAlias('tenantId')} = ${this.quoteProjectionIdentifier('tenant_id')} OR (rr.${latestRelatedAlias('tenantId')} IS NULL AND ${this.quoteProjectionIdentifier('tenant_id')} IS NULL))`,
      );
    }

    const orderFragments: string[] = [];
    if (relatedSortTerms.length > 0) {
      orderFragments.push(
        relatedCollection.qualifyLatestParentOrderTerms(
          'rr',
          relatedSortTerms.map((term) => ({
            ...term,
            column: relatedAlias(term.field),
          })),
        ),
      );
    }
    if (orderBy) {
      const parentOrderTerms = this.resolveOrderByTerms(
        orderBy,
        parentFields,
        'orderBy',
      );
      orderFragments.push(
        parentOrderTerms
          .map(
            (term) =>
              `${this.quoteProjectionIdentifier(term.column)} ${term.direction}`,
          )
          .join(', '),
      );
    }
    orderFragments.push(
      `${this.quoteProjectionIdentifier(parentPrimaryKey.column)} ASC`,
    );

    const boundedLimit = this.applyListBounds(assertQueryBound(limit, 'limit'));
    const boundedOffset = assertQueryBound(offset, 'offset');
    let limitOffsetSql = '';
    const limitOffsetValues: number[] = [];
    let nextParameter =
      relatedWhereValues.length + parentWhereValues.length + 1;
    if (boundedLimit !== undefined) {
      limitOffsetSql += ` LIMIT $${nextParameter++}`;
      limitOffsetValues.push(boundedLimit);
    }
    if (boundedOffset !== undefined) {
      if (boundedLimit === undefined) {
        // SQLite requires LIMIT before OFFSET. SQLite uses -1 for an
        // unlimited limit; DuckDB and PostgreSQL use the standard LIMIT ALL.
        limitOffsetSql +=
          this.getDatabaseEngine() === 'sqlite' ? ' LIMIT -1' : ' LIMIT ALL';
      }
      limitOffsetSql += ` OFFSET $${nextParameter++}`;
      limitOffsetValues.push(boundedOffset);
    }

    const sql = `${relatedCte}SELECT ${parentSelectSql}, ${Array.from(
      relatedOutputFields,
    )
      .map(
        (fieldName) =>
          `rr.${latestRelatedAlias(fieldName)} AS ${this.quoteProjectionIdentifier(relatedAlias(fieldName))}`,
      )
      .join(
        ', ',
      )} FROM ${this.quoteProjectionIdentifier(this.tableName)} LEFT JOIN ranked_latest_related rr ON ${relatedJoinConditions.join(' AND ')} ${parentWhereSql} ${orderFragments.length > 0 ? `ORDER BY ${orderFragments.join(', ')}` : ''}${limitOffsetSql}`;
    const queryValues = [
      ...relatedWhereValues,
      ...parentWhereValues,
      ...limitOffsetValues,
    ];
    const rows = await this.queryDuckDbCanonicalSelectRows(sql, queryValues);

    // Hydrate in result order. initialize() hooks may issue queries through
    // the same transaction-bound PostgreSQL client, so overlapping hydration
    // would violate the collection-wide serial hydration invariant.
    const instances: ModelType[] = [];
    const relatedAliasNames = new Set(relatedFieldAliases.values());
    const polymorphicFields = new Map<
      string,
      Record<string, CollectionFieldDefinition>
    >();
    for (const row of rows) {
      const parentRow = Object.fromEntries(
        Object.entries(row).filter(([key]) => !relatedAliasNames.has(key)),
      );
      instances.push(
        await this.hydrateResultRow(
          parentRow,
          parentFields,
          isSTI,
          polymorphicFields,
        ),
      );
    }

    // Materialize the related projection by the parent primary key before
    // afterList hooks run. Hooks may filter or reorder hydrated parents; an
    // array-index pairing after those hooks could attach one parent's related
    // data to another parent.
    const relatedByParentId = new Map<string, Record<string, unknown> | null>();
    for (const row of rows) {
      const parentId = row[parentPrimaryKey.column];
      if (parentId === null || parentId === undefined) continue;

      const relatedRow = Object.fromEntries(
        relatedProjection.outputFields.map((fieldName) => [
          fieldName,
          row[relatedAlias(fieldName)],
        ]),
      );
      const relatedId = row[relatedAlias(relatedPrimaryKey.field)];
      relatedByParentId.set(
        String(parentId),
        relatedId === null || relatedId === undefined
          ? null
          : relatedCollection.formatProjectionRow(
              relatedRow,
              relatedFields,
              relatedProjection.outputFields,
            ),
      );
    }

    const finalInstances = await GlobalInterceptors.executeAfterList(
      itemClassName,
      instances,
      interceptorContext,
    );

    return finalInstances.map((parent) => {
      return {
        latestRelated:
          (parent as unknown as Record<string, unknown>)[
            parentPrimaryKey.field
          ] === null ||
          (parent as unknown as Record<string, unknown>)[
            parentPrimaryKey.field
          ] === undefined
            ? null
            : (relatedByParentId.get(
                String(
                  (parent as unknown as Record<string, unknown>)[
                    parentPrimaryKey.field
                  ],
                ),
              ) ?? null),
        parent,
      };
    });
  }

  private formatProjectionRow(
    row: Record<string, unknown>,
    fields: Record<string, CollectionFieldDefinition>,
    outputFields: readonly string[],
  ): Record<string, unknown> {
    const formattedData = this.withHydratedCoreFields(
      formatDataJs(row, fields),
    );
    const projected: Record<string, unknown> = {};

    for (const fieldName of outputFields) {
      projected[fieldName] = formattedData[fieldName];
    }

    return projected;
  }

  /**
   * Gets the class constructor for items in this collection
   */
  protected get _itemClass(): SmrtCollectionItemClass<ModelType> {
    const ctor = this.constructor as {
      readonly _itemClass?: SmrtCollectionItemClass<ModelType>;
    };
    if (!ctor._itemClass) {
      const className = this.constructor.name;
      const errorMessage = [
        `Collection "${className}" must define a static _itemClass property.`,
        '',
        'Example:',
        `  class ${className} extends SmrtCollection<YourItemClass> {`,
        '    static readonly _itemClass = YourItemClass;',
        '  }',
        '',
        'Make sure your item class is imported and defined before the collection class.',
      ].join('\n');

      throw new Error(errorMessage);
    }
    return ctor._itemClass;
  }

  /**
   * Gets the model class constructor handled by this collection.
   */
  public getItemClass(): SmrtCollectionItemClass<ModelType> {
    return this._itemClass;
  }

  /**
   * Static reference to the item class constructor.
   *
   * S4 #1579: kept as `any`. Subclasses assign a concrete model constructor
   * (`static readonly _itemClass = Product`) here; the base declares the slot
   * generically and `SmrtCollection` is invariant in `ModelType`, so a narrower
   * `SmrtObjectConstructor` / `SmrtCollectionItemClass<SmrtObject>` type rejects
   * the heterogeneous concrete assignments. Mirrors the registry escape hatch.
   */
  // biome-ignore lint/suspicious/noExplicitAny: subclasses assign a concrete `static _itemClass = Product`; `SmrtCollection` is invariant in `ModelType`, so a narrower constructor type rejects the heterogeneous assignments. S4 #1579.
  static readonly _itemClass: any;

  /**
   * Validates that the collection is properly configured
   * Call this during development to catch configuration issues early
   */
  static validate(): void {
    if (!SmrtCollection._itemClass) {
      const className = SmrtCollection.name;
      const errorMessage = [
        `Collection "${className}" is missing required static _itemClass property.`,
        '',
        'Fix by adding:',
        `  class ${className} extends SmrtCollection<YourItemClass> {`,
        '    static readonly _itemClass = YourItemClass;',
        '  }',
      ].join('\n');
      throw new Error(errorMessage);
    }

    // Validate that _itemClass has required methods
    if (typeof SmrtCollection._itemClass !== 'function') {
      throw new Error(
        `Collection "${SmrtCollection.name}"._itemClass must be a constructor function`,
      );
    }

    // Check if it has a create method (static or prototype)
    const hasCreateMethod =
      typeof SmrtCollection._itemClass.create === 'function' ||
      typeof SmrtCollection._itemClass.prototype?.create === 'function';

    if (!hasCreateMethod) {
      logger.warn(
        `Collection "${SmrtCollection.name}"._itemClass should have a create() method for optimal functionality`,
      );
    }
  }

  /**
   * Database table name for this collection
   */
  public _tableName!: string;

  /**
   * Creates a new SmrtCollection instance
   *
   * @deprecated Use the static create() factory method instead
   * @param options - Configuration options
   */
  constructor(options: SmrtCollectionOptions = {}) {
    super(options);

    // #2367: validate the configured bounds at construction, not at query time.
    // A bad ceiling that only surfaces on the first paged read is a production
    // incident; a bad ceiling that fails to construct is a startup error.
    this._defaultListLimit = assertOptionalListBound(
      options.defaultListLimit,
      'defaultListLimit',
    );
    this._maxListLimit = assertOptionalListBound(
      options.maxListLimit,
      'maxListLimit',
    );

    // Auto-register the collection if it's not the base SmrtCollection and has an _itemClass.
    // `this.constructor` is typed as the structureless `Function`; view it as the
    // collection-class shape (static `_itemClass` constructor + the new-able ctor
    // that `registerCollection` stores) so the static slot can be read and the
    // class registered without `any`.
    const collectionCtor = this.constructor as unknown as {
      _itemClass?: SmrtObjectConstructor;
    } & (new (
      options: SmrtCollectionOptions,
    ) => SmrtCollection<SmrtObject>);
    if (this.constructor !== SmrtCollection && collectionCtor._itemClass) {
      const itemClass = collectionCtor._itemClass;
      const itemClassName =
        ObjectRegistry.getClassByConstructor(itemClass)?.name || itemClass.name;
      ObjectRegistry.registerCollection(itemClassName, collectionCtor);
    }
  }

  /**
   * Factory method — the recommended way to instantiate a collection.
   *
   * Creates the collection instance, calls `initialize()`, and pre-populates
   * the field cache used by synchronous query helpers.
   *
   * Pass the same `options` object you received in a `SmrtObject` constructor
   * or a `SvelteKit` load function to share the database connection.
   *
   * @param options - Database, AI, filesystem, and other configuration options.
   *   At minimum, provide `db` (or `persistence`) to connect to a database.
   * @returns A fully initialized, ready-to-query collection instance
   *
   * @example
   * ```typescript
   * // Share a DB connection from a SvelteKit load function
   * const products = await Products.create(event.locals.smrtOptions);
   *
   * // Explicit configuration
   * const products = await Products.create({
   *   db: myDb,
   *   ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY },
   * });
   * ```
   */
  // S4 #1579: `SmrtCollection<any>` bound is irreducible. `SmrtCollection` is
  // invariant in `ModelType` (it has `create(options: SmrtCreateInput<ModelType>)`),
  // so a concrete `Products extends SmrtCollection<Product>` does not satisfy
  // `T extends SmrtCollection<SmrtObject>`. The `any` bound is the only constraint
  // every subclass collection satisfies.
  // biome-ignore lint/suspicious/noExplicitAny: `SmrtCollection` is invariant in `ModelType`, so concrete `Products extends SmrtCollection<Product>` fails `T extends SmrtCollection<SmrtObject>`; the `any` bound is the only one every subclass satisfies. S4 #1579.
  static async create<T extends SmrtCollection<any>>(
    this: new (
      options?: SmrtCollectionOptions,
    ) => T,
    // `SmrtCollectionOptions`, not `SmrtClassOptions`: the collection-only
    // options (#2367 list bounds) must be passable through the recommended
    // factory without a cast, and every `SmrtClassOptions` value still satisfies
    // this because the extra members are optional.
    options: SmrtCollectionOptions = {},
  ): Promise<T> {
    // Extract only collection-compatible options from the incoming bag.
    // This is an allowlist: an option absent from BOTH the destructuring and the
    // literal below never reaches the constructor, however it was passed.
    const {
      _className,
      db,
      defaultListLimit, // #2367
      persistence, // Also extract persistence alias
      ai,
      fs,
      logging,
      maxListLimit, // #2367
      metrics,
      pubsub,
      sanitization,
      signals,
    } = options;

    const collectionOptions: SmrtCollectionOptions = {
      _className,
      db,
      persistence, // Pass persistence through so initialize() can map it to db
      ai,
      defaultListLimit,
      fs,
      logging,
      maxListLimit,
      metrics,
      pubsub,
      sanitization,
      signals,
    };

    // Defense-in-depth: SmrtJunction subclasses MUST have their ITEM class
    // registered with ObjectRegistry — that's where the field metadata,
    // tableName, and conflictColumns come from, which byLeft/byRight/
    // attach/detach/setLinks all depend on. The scanner is supposed to
    // catch every junction subclass via the FRAMEWORK_BASE_CLASSES list
    // in packages/scanner, but if a future refactor adds a new abstract
    // junction base without updating that list, or if a class is loaded
    // outside the normal manifest pipeline, we'd silently fall through to
    // empty-field-metadata behavior (the issue #1132 class of bug). Fail
    // loudly here instead of producing wrong results later.
    //
    // We check the ITEM class registration (not the collection class) —
    // collection constructors are stored separately via
    // registerCollection(itemClassName, ctor), not in the classes map.
    // View the static `this` as the junction-aware collection-class shape so the
    // junction sentinel and item constructor can be read without `any`.
    const staticSelf = this as unknown as {
      name: string;
      _isJunctionBase?: boolean;
      _itemClass?: SmrtObjectConstructor;
    };
    if (staticSelf._isJunctionBase === true) {
      const itemCtor = staticSelf._itemClass;
      const itemRegistered =
        itemCtor && ObjectRegistry.getClassByConstructor(itemCtor);
      if (!itemRegistered) {
        throw new Error(
          `SmrtJunction subclass "${this.name}" has no registered item class. ` +
            `The scanner likely didn't pick up its model — usually because the ` +
            `consuming package's manifest doesn't include "${itemCtor?.name ?? '<unknown>'}". ` +
            `Check that the scanner's FRAMEWORK_BASE_CLASSES ` +
            `(packages/scanner/src/inheritance-resolver.ts) recognizes every ` +
            `framework abstract base in your inheritance chain, that the package ` +
            `has been built (manifest.json present in dist/), and that runtime ` +
            `manifest loading (__smrt-register__.ts) runs before any junction ` +
            `is instantiated.`,
        );
      }
    }

    // Create instance using protected constructor
    const instance = new this(collectionOptions);

    // Perform async initialization
    await instance.initialize();

    // Cache fields for sync access during queries (issue #663)
    // This eliminates async getFields() calls on every query
    const fields = await instance.getFields();
    instance._cachedFields = fields;

    // Return fully initialized instance
    return instance;
  }

  /**
   * Async initialization hook for the collection.
   *
   * Called automatically by the static `create()` factory. In most cases you
   * do not need to call this directly — use `create()` instead.
   *
   * Runtime schema checks are deferred until a query actually touches the
   * backing table. This keeps collection construction safe during SSR and
   * import-time module evaluation without mutating application schema.
   *
   * @returns This instance (enables chaining)
   */
  public async initialize(): Promise<this> {
    await super.initialize();

    // Defer table verification until the first real query. That keeps
    // construction lightweight while ensuring runtime never auto-creates app
    // tables behind the scenes.

    return this;
  }

  /**
   * Verify that the collection's backing table exists before running a query.
   *
   * This is a fail-fast check only. It does not create or alter schema.
   */
  public async ensureStorageReady(): Promise<void> {
    await verifyPersistenceTable(
      this.db,
      this.tableName,
      this.getResolvedItemClassName(),
    );
  }

  /**
   * Find a single record by criteria (convenience method - delegates to get())
   *
   * @param options - Query options with where clause
   * @returns Promise resolving to the object or null if not found
   *
   * @example
   * ```typescript
   * const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
   * const council = await councils.findOne({ where: { name: 'Example Council' } });
   * ```
   */
  public async findOne(options: {
    where: SmrtWhereClause<ModelType>;
  }): Promise<ModelType | null> {
    return await this.get(options.where);
  }

  /**
   * Find a record by ID (convenience method - delegates to get())
   *
   * @param id - Record ID to find (string or Field instance)
   * @returns Promise resolving to the object or null if not found
   *
   * @example
   * ```typescript
   * const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
   * const council = await councils.findById('uuid-123');
   *
   * // Also works with Field instances (e.g., from foreignKey fields)
   * const meeting = new Meeting({ councilId: 'uuid-123' });
   * const council = await councils.findById(meeting.councilId);
   * ```
   */
  public async findById(id: string): Promise<ModelType | null> {
    return await this.get(id);
  }

  /**
   * Find all records matching criteria (convenience method - delegates to list())
   *
   * @param options - Query options (where, orderBy, limit, etc.)
   * @returns Promise resolving to array of objects
   *
   * @example
   * ```typescript
   * const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
   * const active = await councils.findAll({ where: { status: 'active' } });
   * ```
   */
  public async findAll(
    options: {
      where?: SmrtWhereClause<ModelType>;
      orderBy?: string | string[];
      limit?: number;
      offset?: number;
      include?: string[];
    } = {},
  ): Promise<ModelType[]> {
    return await this.list(options);
  }

  /**
   * Find multiple objects by their IDs in a single query.
   *
   * This is a convenience method that avoids N+1 queries when you have
   * a list of IDs and need to fetch the corresponding records.
   *
   * The id list is chunked at `IN_LIST_CHUNK_SIZE` (#2367). `collection.list()`
   * expands an array-valued WHERE into one `id IN (?, ?, ...)` clause and does
   * not chunk it, so an unbounded caller-sized array hits the backend's
   * bind-variable ceiling — `SQLITE_MAX_VARIABLE_NUMBER` (999 pre-3.32, 32766
   * after) or PostgreSQL's 65535 — and the whole query fails before it runs.
   * The relationship, junction and hierarchy loaders have chunked at this value
   * for exactly this reason; `listByIds()` is the remaining path that took ids
   * straight from the caller and did not.
   *
   * @param ids - Array of UUIDs to fetch
   * @returns Promise resolving to array of objects (order not guaranteed;
   *   results are concatenated in chunk order)
   *
   * @example
   * ```typescript
   * const profiles = await profileCollection.listByIds(['id1', 'id2', 'id3']);
   * ```
   */
  public async listByIds(ids: string[]): Promise<ModelType[]> {
    if (ids.length === 0) return [];

    // Never chunk above a configured ceiling: an explicit `limit` is clamped by
    // `maxListLimit`, so a chunk larger than the ceiling would come back
    // truncated and silently drop ids the caller asked for.
    const chunkSize =
      this._maxListLimit === undefined
        ? IN_LIST_CHUNK_SIZE
        : Math.min(IN_LIST_CHUNK_SIZE, this._maxListLimit);

    const chunks = chunkArray(ids, chunkSize);
    if (chunks.length === 1) {
      return this.list({ limit: chunks[0].length, where: { id: chunks[0] } });
    }

    const results: ModelType[] = [];
    for (const idChunk of chunks) {
      results.push(
        ...(await this.list({ limit: idChunk.length, where: { id: idChunk } })),
      );
    }
    return results;
  }

  /**
   * Resolve the effective cache config for a read (issue #1498).
   *
   * Per-call options win: `false` forces a fresh read, `{ ttl }` enables
   * caching for this call. Otherwise falls back to the model-level
   * `@smrt({ cache })` config (inheritance-aware). Returns undefined when
   * the read should go straight to the database — the default.
   */
  private resolveReadCacheConfig(
    perCall?: CollectionCacheConfig | false,
  ): CollectionCacheConfig | undefined {
    if (perCall === false) return undefined;
    if (perCall) return perCall.ttl > 0 ? perCall : undefined;
    return ObjectRegistry.resolveCollectionCacheConfig(
      this.getResolvedItemQualifiedName(),
    );
  }

  /**
   * Execute a SELECT, optionally through the collection read cache.
   *
   * The cache key is the final SQL + bound parameters — computed after
   * interceptors (tenancy filters) and STI discriminators are applied, so
   * differently-scoped queries can never share an entry. Cached values are
   * raw rows; callers still run their normal post-query formatting path.
   */
  private async queryRowsWithCache(
    sql: string,
    params: unknown[],
    cacheConfig: CollectionCacheConfig | undefined,
    describeUuidOutputs: boolean,
  ): Promise<Record<string, unknown>[]> {
    if (!cacheConfig) {
      return await this.queryDuckDbCanonicalSelectRows(
        sql,
        params,
        describeUuidOutputs,
      );
    }

    const dbKey = resolveDbCacheKey(this.db);
    const queryKey = buildQueryCacheKey(sql, params);

    // Start consuming peer invalidations before the first cached read so
    // a remote write can't go unseen for longer than necessary, and record
    // table-scoped interest so this process's own writes broadcast even
    // when the crossProcess opt-in only exists at the call site.
    if (cacheConfig.crossProcess) {
      ensureCacheInvalidationListener(this.db);
      registerCrossProcessCacheInterest(dbKey, this.tableName);
    }

    const cached = getCachedRows(dbKey, this.tableName, queryKey);
    if (cached) {
      return cached;
    }

    // Capture the table's invalidation generation BEFORE the round-trip; if a
    // concurrent write invalidates while this SELECT is in flight, setCachedRows
    // sees the bumped generation and drops the now-stale result instead of
    // caching it for the full TTL.
    const generation = getCacheGeneration(dbKey, this.tableName);
    const rows = await this.queryDuckDbCanonicalSelectRows(
      sql,
      params,
      describeUuidOutputs,
    );
    setCachedRows(
      dbKey,
      this.tableName,
      queryKey,
      rows,
      cacheConfig.ttl,
      generation,
    );
    return rows;
  }

  /**
   * Describe a native DuckDB SELECT before executing it, then cast UUID output
   * columns in the one data-bearing execution. DuckDB's JavaScript binding
   * exposes UUID values as lossy HUGEINT wrappers, so they cannot be repaired
   * from the first result without replaying volatile SELECT expressions or
   * combining two different database snapshots.
   */
  private async queryDuckDbCanonicalSelectRows(
    sql: string,
    params: unknown[],
    describeUuidOutputs = true,
  ): Promise<Record<string, unknown>[]> {
    if (this.getDatabaseEngine() !== 'duckdb' || !describeUuidOutputs) {
      return (await this.db.query(sql, ...params)).rows;
    }
    const readSql = sql.trim().replace(/;$/, '');
    const words = executableSqlWords(readSql);
    // query() is documented as a SELECT hydration surface but remains a raw
    // escape hatch. Never reinterpret a mutating statement as a subquery, but
    // do ignore mutation words inside caller-authored comments and literals.
    if (isMutatingSql(words)) {
      return (await this.db.query(sql, ...params)).rows;
    }
    if (words[0] !== 'select' && words[0] !== 'with') {
      return (await this.db.query(sql, ...params)).rows;
    }
    const described = await this.db.query(`DESCRIBE ${readSql}`, ...params);
    const uuidColumns = described.rows
      .filter((row) => String(row.column_type).toUpperCase() === 'UUID')
      .map((row) => String(row.column_name));
    if (uuidColumns.length === 0) {
      return (await this.db.query(sql, ...params)).rows;
    }
    const alias = this.quoteProjectionIdentifier('__smrt_uuid_rows');
    const replacements = uuidColumns
      .map((column) => {
        const quoted = this.quoteProjectionIdentifier(column);
        return `CAST(${alias}.${quoted} AS VARCHAR) AS ${quoted}`;
      })
      .join(', ');
    return (
      await this.db.query(
        `SELECT ${alias}.* REPLACE (${replacements}) FROM (${readSql}) AS ${alias}`,
        ...params,
      )
    ).rows;
  }

  /**
   * Retrieves a single object from the collection by ID, slug, or a custom filter.
   *
   * Filter resolution:
   * - UUID string → `WHERE id = ?`
   * - Non-UUID string → `WHERE slug = ? AND context = ''`
   * - Object → `WHERE <key> = <value> [AND ...]`
   *
   * For STI child collections, an `AND _meta_type = '<qualifiedName>'` clause is
   * automatically appended so you only receive the correct subclass.
   *
   * Runs `beforeGet` / `afterGet` interceptors (used by multi-tenancy, etc.).
   *
   * @param filter - UUID string, slug string, or a WHERE conditions object
   * @param options.cache - Opt-in read-through cache for this call
   *   (`{ ttl }` in milliseconds), or `false` to force a fresh read when the
   *   model opted in via `@smrt({ cache })`. Defaults to the model config.
   * @returns The matching object instance, or `null` if not found
   *
   * @example
   * ```typescript
   * // By UUID
   * const product = await products.get('550e8400-e29b-41d4-a716-446655440000');
   *
   * // By slug
   * const product = await products.get('my-widget');
   *
   * // By custom filter
   * const product = await products.get({ sku: 'WID-001' });
   *
   * // Cached read (memoized for 60s, invalidated on writes)
   * const product = await products.get('my-widget', { cache: { ttl: 60_000 } });
   * ```
   *
   * @see {@link list} for multiple results
   * @see {@link findById} / {@link findOne} for convenience aliases
   */
  public async get(
    filter: string | SmrtWhereClause<ModelType>,
    options: { cache?: CollectionCacheConfig | false } = {},
  ): Promise<ModelType | null> {
    await this.ensureStorageReady();
    const itemClassName = this.getResolvedItemClassName();
    const itemQualifiedName = this.getResolvedItemQualifiedName();

    // Execute beforeGet interceptors (e.g., tenancy validation)
    const interceptorContext = createInterceptorContext(
      itemClassName,
      'get',
      this.constructor.name,
    );
    const interceptedFilter = await GlobalInterceptors.executeBeforeGet(
      itemClassName,
      filter,
      interceptorContext,
    );

    // String-filter resolution shares one helper with `beforeGet` interceptors
    // (#2365): an interceptor that rewrites the string into an object filter
    // must resolve id-vs-slug exactly the way this method would.
    let where: Record<string, unknown> =
      typeof interceptedFilter === 'string'
        ? resolveGetStringFilter(interceptedFilter)
        : interceptedFilter;

    // Fix for issue #386: Add _meta_type filter for STI child collections.
    // R5-canon: use the qualified item name as the LOOKUP KEY too, not
    // just for the comparison — passing the simple `itemClassName` can
    // resolve to another package's same-simple-name class via
    // `findClass`'s multi-strategy lookup, which would yield the WRONG
    // table-strategy / STI base.
    const tableStrategy = ObjectRegistry.getTableStrategy(itemQualifiedName);
    const isSTI = tableStrategy === 'sti';

    if (isSTI) {
      const stiBase = ObjectRegistry.getSTIBase(itemQualifiedName);
      if (stiBase && stiBase !== itemQualifiedName) {
        where = {
          _meta_type: itemQualifiedName,
          ...where,
        };
      }
    }

    // convertWhereKeys is now sync (issue #663) - no await needed
    const convertedWhere = this.convertWhereKeys(where);
    const { sql: whereSql, values: whereValues } = buildWhere(convertedWhere);

    // `get()` reads `rows[0]` and discards the rest, so the row cap belongs in
    // the query, not in JavaScript (#2367). Without it a filter that is not
    // backed by a unique index — `get({ status: 'active' })`, or any slug lookup
    // on a table whose natural-key index was replaced by custom
    // `conflictColumns` — streams every matching row through the driver and
    // hydrates none of them. The literal is safe to interpolate: it is not
    // caller-derived, and `$n` placeholders here would have to be numbered after
    // the WHERE values on PostgreSQL.
    const fullSQL = `SELECT ${this.getHydrationSelectSql()} FROM ${this.tableName} ${whereSql} LIMIT 1`;
    const rows = await this.queryRowsWithCache(
      fullSQL,
      whereValues,
      this.resolveReadCacheConfig(options.cache),
      this.hasDuckDbUuidColumnsOutsideHydrationSelect(),
    );

    if (!rows?.[0]) {
      // Execute afterGet with null result
      // Explicitly specify type parameter since TypeScript can't infer from null
      return await GlobalInterceptors.executeAfterGet<ModelType>(
        itemClassName,
        null,
        interceptorContext,
      );
    }

    const fields = this.getFieldsSync();
    const instance = await this.hydrateResultRow(rows[0], fields, isSTI);

    // Execute afterGet interceptors (e.g., tenant validation)
    return await GlobalInterceptors.executeAfterGet(
      itemClassName,
      instance,
      interceptorContext,
    );
  }

  /**
   * Lists records from the collection with flexible filtering options
   *
   * @param options - Query options object
   * @param options.where - Record of conditions to filter results. Each key can include an operator
   *                      separated by a space (e.g., 'price >', 'name like'). Default operator is '='.
   * @param options.offset - Number of records to skip
   * @param options.limit - Maximum number of records to return
   * @param options.orderBy - Field(s) to order results by, with optional direction
   * @param options.select - Column-backed fields to return as plain rows without hydrating model instances
   *
   * @example
   * ```typescript
   * // Find active products priced between $100-$200
   * await collection.list({
   *   where: {
   *     'price >': 100,
   *     'price <=': 200,
   *     'status': 'active',              // equals operator is default
   *     'category in': ['A', 'B', 'C'],  // IN operator for arrays
   *     'name like': '%shirt%',          // LIKE for pattern matching
   *     'deleted_at !=': null            // exclude deleted items
   *   },
   *   limit: 10,
   *   offset: 0
   * });
   *
   * // Find users matching pattern but not in specific roles
   * await users.list({
   *   where: {
   *     'email like': '%@company.com',
   *     'active': true,
   *     'role in': ['guest', 'blocked'],
   *     'last_login <': lastMonth
   *   }
   * });
   *
   * // Fetch compact page-key rows without constructing full objects
   * await collection.list({
   *   select: ['id', 'title', 'accountId'],
   *   where: { status: 'open' },
   *   orderBy: 'created_at DESC',
   *   limit: 50,
   * });
   * ```
   *
   * @returns Promise resolving to an array of model instances, or plain selected rows when `select` is present
   */
  public async list<const Select extends readonly SmrtSelectField<ModelType>[]>(
    options: Omit<SmrtListOptions<ModelType>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<Record<string, unknown>[]>;
  public async list<const Select extends readonly SmrtSelectField<ModelType>[]>(
    options: Omit<SmrtListOptions<ModelType>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope?: undefined;
    },
  ): Promise<SmrtSelectedRow<ModelType, Select>[]>;
  public async list(
    options: Omit<SmrtListOptions<ModelType>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<SmrtObject[]>;
  public async list(options?: undefined): Promise<ModelType[]>;
  public async list(
    options: Omit<SmrtListOptions<ModelType>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope?: undefined;
    },
  ): Promise<ModelType[]>;
  public async list(
    options:
      | (Omit<SmrtListOptions<ModelType>, 'select'> & {
          select?: undefined;
        })
      | undefined,
  ): Promise<SmrtObject[]>;
  public async list(
    options: SmrtListOptions<ModelType> | undefined,
  ): Promise<SmrtObject[] | Record<string, unknown>[]>;
  public async list(
    options: Omit<SmrtListOptions<ModelType>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope?: undefined;
    },
  ): Promise<ModelType[]>;
  public async list(
    options: SmrtListOptions<ModelType> = {},
  ): Promise<SmrtObject[] | Record<string, unknown>[]> {
    await this.ensureStorageReady();
    const itemClassName = this.getResolvedItemClassName();
    const itemQualifiedName = this.getResolvedItemQualifiedName();

    // Execute beforeList interceptors (e.g., tenancy filtering)
    const interceptorContext = createInterceptorContext(
      itemClassName,
      'list',
      this.constructor.name,
    );
    const interceptedOptions =
      (await GlobalInterceptors.executeBeforeList(
        itemClassName,
        options as InterceptorListOptions,
        interceptorContext,
      )) ??
      (options as InterceptorListOptions | undefined) ??
      {};

    let { where, offset, limit, orderBy, select, stiScope } =
      interceptedOptions as SmrtListOptions<ModelType>;

    // STI: Child collections should automatically filter by _meta_type.
    // R5-canon: qualified-key lookup so a same-simple-name class in
    // another package can't yield the wrong table strategy / STI base.
    const tableStrategy = ObjectRegistry.getTableStrategy(itemQualifiedName);
    const isSTI = tableStrategy === 'sti';

    where = this.applyStiReadScope(where, stiScope);

    // Resolve _meta_type to qualified name if user provided simple class name (Issue #713)
    where = resolveMetaTypeInWhere(where);

    // convertWhereKeys is now sync (issue #663) - no await needed
    const convertedWhere = this.convertWhereKeys(where || {});
    const { sql: whereSql, values: whereValues } = buildWhere(convertedWhere);

    const fields = this.getFieldsSync();
    const projection =
      select !== undefined
        ? this.resolveProjectionSelect(select, fields, isSTI)
        : undefined;
    if (
      projection &&
      interceptedOptions.include &&
      interceptedOptions.include.length > 0
    ) {
      throw new Error(
        'collection.list({ select }) returns plain projection rows and cannot eager-load relationships. Remove include or omit select.',
      );
    }

    const orderBySql = this.buildOrderBySql(orderBy, fields);

    let limitOffsetSql = '';
    const limitOffsetValues: (number | undefined)[] = [];
    let paramIndex = whereValues.length + 1;

    // #2367: reject a malformed bound here rather than binding it. A NaN or
    // fractional `limit` used to reach the driver verbatim, where PostgreSQL
    // answers `invalid input syntax for type bigint` — a 500 for what is a
    // caller error. Then apply the collection's opt-in default/ceiling.
    const boundedLimit = this.applyListBounds(assertQueryBound(limit, 'limit'));
    const boundedOffset = assertQueryBound(offset, 'offset');

    if (boundedLimit !== undefined) {
      limitOffsetSql += ` LIMIT $${paramIndex++}`;
      limitOffsetValues.push(boundedLimit);
    }

    if (boundedOffset !== undefined) {
      limitOffsetSql += ` OFFSET $${paramIndex++}`;
      limitOffsetValues.push(boundedOffset);
    }

    const selectSql = projection
      ? projection.sql
      : this.getHydrationSelectSql();
    const sql = `SELECT ${selectSql} FROM ${this.tableName} ${whereSql} ${orderBySql} ${limitOffsetSql}`;
    const params = [...whereValues, ...limitOffsetValues];

    // Resolve the cache preference from the post-interceptor options —
    // beforeList interceptors may legally set or clear `cache` (e.g. force
    // read-through on admin paths, enable caching per tenant).
    const rows = await this.queryRowsWithCache(
      sql,
      params,
      this.resolveReadCacheConfig(
        (interceptedOptions as { cache?: CollectionCacheConfig | false }).cache,
      ),
      !projection && this.hasDuckDbUuidColumnsOutsideHydrationSelect(),
    );

    if (projection) {
      // Projection is the no-hydration path. beforeList interceptors still ran
      // above, but afterList hooks are intentionally skipped because they are
      // defined around hydrated SmrtObject instances.
      return rows.map((item) =>
        this.formatProjectionRow(item, fields, projection.outputFields),
      );
    }

    // STI: Hydrate instances polymorphically based on _meta_type
    // Reuse tableStrategy and isSTI from earlier in the function
    const instances = await this.hydrateResultRows(rows, fields, isSTI);

    // Eager load specified relationships
    if (interceptedOptions.include && interceptedOptions.include.length > 0) {
      // Cast to ModelType[] - instances are guaranteed to be subtypes of ModelType
      // even in STI mode where they may be different subclasses
      await this.eagerLoadRelationships(
        instances as ModelType[],
        interceptedOptions.include,
      );
    }

    // Execute afterList interceptors (e.g., tenant validation)
    const finalInstances = await GlobalInterceptors.executeAfterList(
      itemClassName,
      instances,
      interceptorContext,
    );

    return finalInstances;
  }

  /**
   * Eagerly load relationships for a collection of instances
   *
   * Optimizes loading by batching queries for foreignKey relationships to avoid N+1 queries.
   *
   * @param instances - Array of object instances to load relationships for
   * @param relationships - Array of relationship field names to load
   * @private
   */
  private async eagerLoadRelationships(
    instances: ModelType[],
    relationships: string[],
  ): Promise<void> {
    if (instances.length === 0) return;

    for (const fieldName of relationships) {
      // Get relationship metadata
      const relationshipMeta = ObjectRegistry.getRelationships(
        this._itemClass.name,
      );
      const relationship = relationshipMeta.find(
        (r) => r.fieldName === fieldName,
      );

      if (!relationship) {
        logger.warn(
          `Relationship ${fieldName} not found on ${this._itemClass.name}, skipping eager load`,
        );
        continue;
      }

      if (
        relationship.type === 'foreignKey' ||
        relationship.type === 'crossPackageRef'
      ) {
        // crossPackageRef target lives in another package — make sure its
        // manifest is loaded before we try to instantiate the target collection.
        if (relationship.type === 'crossPackageRef') {
          await ObjectRegistry.ensureManifestLoaded(relationship.targetClass);
        }
        // Batch load foreignKey / crossPackageRef relationships
        await this.batchLoadForeignKeys(instances, fieldName, relationship);
      } else if (relationship.type === 'oneToMany') {
        // Load oneToMany relationships (less optimizable)
        await this.batchLoadOneToMany(instances, fieldName, relationship);
      } else if (relationship.type === 'manyToMany') {
        await this.batchLoadManyToMany(instances, fieldName, relationship);
      }
    }
  }

  /**
   * Batch load foreignKey relationships to avoid N+1 queries
   *
   * @param instances - Instances to load relationships for
   * @param fieldName - Name of the foreignKey field
   * @param relationship - Relationship metadata
   * @private
   */
  private async batchLoadForeignKeys(
    instances: ModelType[],
    fieldName: string,
    relationship: import('./registry').RelationshipMetadata,
  ): Promise<void> {
    // Collect all unique foreign key values
    const foreignKeyValues = new Set<string>();
    for (const instance of instances) {
      const value = instance[fieldName as keyof ModelType];
      if (value && typeof value === 'string') {
        foreignKeyValues.add(value);
      }
    }

    if (foreignKeyValues.size === 0) return;

    // Get or create cached collection instance
    let targetCollection: SmrtCollection<SmrtObject> | undefined;
    try {
      targetCollection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options,
      );
    } catch (error) {
      logger.warn(`Could not get collection for ${relationship.targetClass}`, {
        error,
      });
      return;
    }

    // Load all related objects, chunked to stay under SQLITE_MAX_VARIABLE_NUMBER (999).
    const fkValueList = Array.from(foreignKeyValues);
    const relatedObjects: SmrtObject[] = [];
    for (const idChunk of chunkArray(fkValueList, IN_LIST_CHUNK_SIZE)) {
      const batch = await targetCollection.list({
        where: { 'id in': idChunk },
      });
      relatedObjects.push(...batch);
    }

    // Build a map of ID to object for quick lookup
    const relatedMap = new Map<string, SmrtObject>();
    for (const obj of relatedObjects) {
      if (obj.id) relatedMap.set(obj.id, obj);
    }

    // Assign loaded objects to instances
    for (const instance of instances) {
      const foreignKeyValue = instance[fieldName as keyof ModelType];
      if (foreignKeyValue && typeof foreignKeyValue === 'string') {
        const relatedObject = relatedMap.get(foreignKeyValue);
        if (relatedObject) {
          // Prime the lazy-load cache through SmrtObject's sanctioned internal
          // setter rather than reaching into the private field directly.
          instance._setLoadedRelationship(fieldName, relatedObject);
        }
      }
    }
  }

  /**
   * Batch load oneToMany relationships
   *
   * @param instances - Instances to load relationships for
   * @param fieldName - Name of the oneToMany field
   * @param relationship - Relationship metadata
   * @private
   */
  private async batchLoadOneToMany(
    instances: ModelType[],
    fieldName: string,
    relationship: import('./registry').RelationshipMetadata,
  ): Promise<void> {
    // Find the inverse foreignKey field. An instance can satisfy an inverse FK
    // that targets its own class or any (STI) ancestor it inherits the
    // oneToMany from. Mirrors loadRelatedMany so lazy and eager (`include:`)
    // loading resolve the same inverse side.
    const inverseRelationships = ObjectRegistry.getInverseRelationshipsForSelf(
      this._itemClass.name,
    );
    const inverseCandidates = inverseRelationships.filter(
      (r) =>
        r.sourceClass === relationship.targetClass && r.type === 'foreignKey',
    );
    // Honor an explicit `@oneToMany(Target, { foreignKey })` when the target
    // declares multiple foreign keys back to this class; otherwise fall back
    // to the first match (legacy behavior).
    const explicitForeignKey = relationship.options?.foreignKey as
      | string
      | undefined;
    const matchedForeignKey = explicitForeignKey
      ? inverseCandidates.find((r) => r.fieldName === explicitForeignKey)
      : undefined;
    if (explicitForeignKey && !matchedForeignKey) {
      // A misspelled / stale `foreignKey` is a configuration error, not a
      // recoverable data condition — fail loudly here too so eager (`include:`)
      // loading behaves identically to lazy loadRelatedMany rather than
      // silently producing empty arrays.
      throw new Error(
        `oneToMany ${fieldName} specifies foreignKey '${explicitForeignKey}', but ${relationship.targetClass} has no matching inverse foreignKey. Candidates: ${inverseCandidates.map((r) => r.fieldName).join(', ') || '(none)'}`,
      );
    }
    // Prefer an inverse FK that targets this exact class before falling back
    // to an ancestor's (mirrors loadRelatedMany).
    const inverseForeignKey =
      matchedForeignKey ??
      inverseCandidates.find((r) => r.targetClass === this._itemClass.name) ??
      inverseCandidates[0];

    if (!inverseForeignKey) {
      logger.warn(
        `Could not find inverse foreignKey for oneToMany ${fieldName}`,
      );
      return;
    }

    // Collect all instance IDs
    const instanceIds = instances
      .map((i) => i.id)
      .filter((id): id is string => !!id);

    if (instanceIds.length === 0) return;

    // Get or create cached collection instance
    let targetCollection: SmrtCollection<SmrtObject> | undefined;
    try {
      targetCollection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options,
      );
    } catch (error) {
      logger.warn(`Could not get collection for ${relationship.targetClass}`, {
        error,
      });
      return;
    }

    // Load all related objects, chunked to stay under SQLITE_MAX_VARIABLE_NUMBER (999).
    const relatedObjects: SmrtObject[] = [];
    for (const idChunk of chunkArray(instanceIds, IN_LIST_CHUNK_SIZE)) {
      const batch = await targetCollection.list({
        where: { [`${inverseForeignKey.fieldName} in`]: idChunk },
      });
      relatedObjects.push(...batch);
    }

    // Group related objects by the foreign key value. The key type is `unknown`
    // (not `string`) to preserve the prior behavior exactly: a non-string FK
    // value still creates its own bucket rather than being skipped.
    const relatedMap = new Map<unknown, SmrtObject[]>();
    for (const obj of relatedObjects) {
      // Access dynamic property safely - obj is a SmrtObject with dynamic fields
      const foreignKeyValue = (obj as unknown as Record<string, unknown>)[
        inverseForeignKey.fieldName
      ];
      if (!relatedMap.has(foreignKeyValue)) {
        relatedMap.set(foreignKeyValue, []);
      }
      relatedMap.get(foreignKeyValue)?.push(obj);
    }

    // Assign loaded objects to instances
    for (const instance of instances) {
      const relatedArray = relatedMap.get(instance.id as string) || [];
      // Prime the lazy-load cache through SmrtObject's sanctioned internal
      // setter rather than reaching into the private field directly.
      instance._setLoadedRelationship(fieldName, relatedArray);
    }
  }

  /**
   * Batch-load manyToMany relationships through a junction table.
   *
   * Issues two queries instead of N: one against the junction table to map
   * source IDs to target IDs, and one against the target table to hydrate
   * the related rows. Results are grouped by source instance.
   *
   * @param instances - Instances whose manyToMany field should be populated
   * @param fieldName - Name of the @manyToMany decorated field
   * @param relationship - Relationship metadata from the registry
   * @private
   */
  private async batchLoadManyToMany(
    instances: ModelType[],
    fieldName: string,
    relationship: import('./registry').RelationshipMetadata,
  ): Promise<void> {
    const instanceIds = instances
      .map((i) => i.id)
      .filter((id): id is string => !!id);
    if (instanceIds.length === 0) return;

    // Delegate join-coordinate resolution to a sample instance — it shares the
    // same registry metadata as every other instance in this batch.
    let through: string;
    let sourceColumn: string;
    let targetColumn: string;
    let targetClassName: string;
    try {
      // `resolveManyToManyJoin` is a protected SmrtObject method; view the
      // sample instance as the shape exposing it. The call keeps `this` bound
      // (method invoked on the receiver), so registry metadata resolves on the
      // sample as intended.
      const sample = instances[0] as unknown as {
        resolveManyToManyJoin(
          fieldName: string,
          relationship: import('./registry').RelationshipMetadata,
        ): Promise<{
          through: string;
          sourceColumn: string;
          targetColumn: string;
          targetClassName: string;
        }>;
      };
      const join = await sample.resolveManyToManyJoin(fieldName, relationship);
      through = join.through;
      sourceColumn = join.sourceColumn;
      targetColumn = join.targetColumn;
      targetClassName = join.targetClassName;
    } catch (error) {
      logger.warn(
        `Could not resolve manyToMany join for ${fieldName} on ${this._itemClass.name}`,
        { error },
      );
      return;
    }

    // Default empty arrays for every instance so callers always see an array.
    // Seed through SmrtObject's sanctioned internal setter rather than reaching
    // into the private relationship-cache field directly.
    for (const instance of instances) {
      instance._setLoadedRelationship(fieldName, []);
    }

    // Pull junction rows in chunks. SQLite's default SQLITE_MAX_VARIABLE_NUMBER
    // is 999, so we cap each IN-list at IN_LIST_CHUNK_SIZE to stay well below
    // the limit on the supported backends (sqlite/libsql/postgres).
    const junctionRowsAll: Array<{
      [key: string]: unknown;
    }> = [];
    for (const idChunk of chunkArray(instanceIds, IN_LIST_CHUNK_SIZE)) {
      const placeholders = idChunk.map(() => '?').join(', ');
      const result = await this.db.query(
        `SELECT "${sourceColumn}", "${targetColumn}" FROM "${through}" WHERE "${sourceColumn}" IN (${placeholders})`,
        idChunk,
      );
      junctionRowsAll.push(...result.rows);
    }

    if (junctionRowsAll.length === 0) return;

    // sourceId -> [targetIds...]
    const sourceToTargets = new Map<string, string[]>();
    const allTargetIds = new Set<string>();
    for (const row of junctionRowsAll) {
      const sId = row[sourceColumn];
      const tId = row[targetColumn];
      if (typeof sId !== 'string' || typeof tId !== 'string') continue;
      allTargetIds.add(tId);
      const list = sourceToTargets.get(sId) ?? [];
      list.push(tId);
      sourceToTargets.set(sId, list);
    }

    if (allTargetIds.size === 0) return;

    // Hydrate all target objects. Also chunked so we don't blow the
    // placeholder limit on a wide manyToMany.
    let targetCollection: SmrtCollection<SmrtObject>;
    try {
      targetCollection = await ObjectRegistry.getCollection(
        targetClassName,
        this.options,
      );
    } catch (error) {
      logger.warn(
        `Could not get collection for manyToMany target ${targetClassName}`,
        { error },
      );
      return;
    }
    const targetIdList = Array.from(allTargetIds);
    const targetObjects: SmrtObject[] = [];
    for (const idChunk of chunkArray(targetIdList, IN_LIST_CHUNK_SIZE)) {
      const batch = await targetCollection.list({
        where: { 'id in': idChunk },
      });
      targetObjects.push(...batch);
    }

    const targetById = new Map<string, SmrtObject>();
    for (const obj of targetObjects) {
      if (obj.id) targetById.set(obj.id, obj);
    }

    // Assign grouped results
    for (const instance of instances) {
      const targetIds = sourceToTargets.get(instance.id as string) ?? [];
      const objects = targetIds
        .map((id) => targetById.get(id))
        .filter((o) => o !== undefined);
      // Seed through SmrtObject's sanctioned internal setter rather than reaching
      // into the private relationship-cache field directly.
      instance._setLoadedRelationship(fieldName, objects);
    }
  }

  /**
   * Creates and persists a new instance of the collection's item class.
   *
   * Instantiates the model with the given field values, calls `initialize()`,
   * assigns a UUID if none is provided, then calls `save()` to write the row
   * to the database.
   *
   * For STI collections, pass `_meta_type` to create a specific subclass.
   * The correct constructor is resolved via `ObjectRegistry` (polymorphic creation).
   *
   * @param options - Field values for the new object. Accepts any public field on
   *   the model class plus the STI `_meta_type` discriminator.
   * @returns The newly created and saved model instance
   * @throws {ValidationError} If a `required` field is missing or a unique constraint is violated
   * @throws {DatabaseError} If the write fails
   *
   * @example
   * ```typescript
   * // Regular creation
   * const product = await products.create({ name: 'Widget', price: 9.99 });
   * console.log(product.id); // UUID assigned during save
   *
   * // STI polymorphic creation
   * const article = await contents.create({
   *   _meta_type: '@happyvertical/smrt-content:Article',
   *   title: 'Hello World',
   * });
   * ```
   *
   * @see {@link getOrUpsert} to avoid duplicates by finding-or-creating
   */
  public async create(options: SmrtCreateInput<ModelType>) {
    let itemClassName = this.getResolvedItemClassName();

    // Ensure manifest is loaded before creating instance metadata; save() will
    // ensure the actual table exists right before persistence.
    await ObjectRegistry.ensureManifestLoaded(itemClassName);
    itemClassName = this.getResolvedItemClassName();
    const itemQualifiedName = this.getResolvedItemQualifiedName();

    // STI: Check for polymorphic instantiation.
    // R5-canon: qualified-key lookup so colliding simple names across
    // packages don't yield the wrong table strategy.
    const tableStrategy = ObjectRegistry.getTableStrategy(itemQualifiedName);

    if (tableStrategy === 'sti' && options._meta_type) {
      // Use polymorphic instantiation for STI child classes
      // Pass raw options (not params) - createPolymorphic() will add ai, db, _skipLoad
      const instance = await this.createPolymorphic(
        options._meta_type,
        options,
      );
      // Generate ID if not provided, then save. `_id` is a private SmrtObject
      // backing field; view as a writable bag for the runtime assignment.
      if (!instance.id) {
        (instance as unknown as { _id?: string })._id = crypto.randomUUID();
      }
      if (options._insertOnly === true) {
        instance.requireInsertOnSave();
      }
      await instance.save();
      return instance;
    }

    // For non-STI or STI base class without _meta_type, proceed with direct instantiation
    // Schema already initialized in Collection.create() static factory
    const params = {
      ai: this.options.ai,
      // Pass the actual database instance, not options
      // This ensures objects share the same connection as the collection
      // Critical for in-memory databases like DuckDB :memory: where each
      // connection gets a separate database
      db: this.db,
      _skipLoad: true, // Don't try to load from DB - this is a new object
      ...options,
    };

    // Direct instantiation - all SmrtObject classes support this pattern
    const instance = new this._itemClass(params);
    await instance.initialize();

    // For STI collections, set _meta_type to the qualified class name (fix for issue #442)
    // This ensures _meta_type is available immediately after creation, not just after DB load
    // Use constructor-based lookup to avoid name collision issues (issue #713)
    // When classes are registered with qualified names as keys (e.g., from consumer plugin),
    // name-based lookup fails. Constructor lookup uses a WeakMap index for O(1) lookups.
    if (tableStrategy === 'sti') {
      // `_meta_type` is a runtime-only STI field; view as a writable bag.
      (instance as unknown as { _meta_type?: string })._meta_type =
        itemQualifiedName;
    }
    // Generate ID if not provided, then save. `_id` is a private SmrtObject
    // backing field; view as a writable bag for the runtime assignment.
    if (!instance.id) {
      (instance as unknown as { _id?: string })._id = crypto.randomUUID();
    }
    if (options._insertOnly === true) {
      instance.requireInsertOnSave();
    }
    await instance.save();
    return instance;
  }

  /**
   * Creates an instance of the correct subclass for STI polymorphic queries
   *
   * @param className - Name of the class to instantiate (from _meta_type)
   * @param options - Data to initialize the instance with
   * @returns Promise resolving to the instance of the correct subclass
   * @private
   */
  private async createPolymorphic(
    className: string | null | undefined,
    options: Record<string, unknown>,
    hydrationOptions: { hydrateOnly?: boolean } = {},
  ): Promise<ModelType> {
    // Schema already initialized in Collection.create() static factory

    // Validate discriminator is present
    if (!className || className === null || className === undefined) {
      const { DatabaseError } = await import('./errors.js');
      throw DatabaseError.missingDiscriminator(
        this._itemClass.name,
        typeof options?.id === 'string' ? options.id : undefined,
      );
    }

    // Get the correct class constructor from ObjectRegistry
    // Support both qualified names (new format: @pkg:Class) and simple names (legacy)
    let registeredClass = ObjectRegistry.getClassByQualifiedName(className);
    if (!registeredClass) {
      // Fall back to simple name lookup for legacy data
      registeredClass = ObjectRegistry.getClass(className);
    }

    if (!registeredClass) {
      await ObjectRegistry.ensureManifestLoaded(className);
      registeredClass = ObjectRegistry.getClassByQualifiedName(className);
      if (!registeredClass) {
        registeredClass = ObjectRegistry.getClass(className);
      }
    }

    if (!registeredClass) {
      throw new Error(
        `STI polymorphic query failed: Class '${className}' not found in ObjectRegistry. ` +
          `Ensure the class is registered with @smrt() decorator or available via an installed SMRT manifest.`,
      );
    }

    const params = {
      ai: this.options.ai,
      db: this.db,
      _skipLoad: true,
      ...(hydrationOptions.hydrateOnly
        ? {
            _reuseInitializedDb: true,
            _deferRuntimeInitialization: true,
          }
        : {}),
      ...options,
    };

    // Instantiate the correct subclass
    const instance = new registeredClass.constructor(params);
    if (hydrationOptions.hydrateOnly) {
      // Models need to distinguish authoritative DB hydration from a fresh
      // `_skipLoad` instance while initialize() captures immutable state.
      instance.markAsPersisted();
    }
    await instance.initialize();

    // Ensure _meta_type is set on the instance (fix for issue #442)
    // Use qualified name if available, otherwise keep the input className
    // (which may already be qualified for new data or simple for legacy data).
    // `_meta_type` is a runtime-only STI field; view as a writable bag.
    (instance as unknown as { _meta_type?: string })._meta_type =
      registeredClass?.qualifiedName || className;

    return instance as ModelType;
  }

  /**
   * Finds an existing record matching `data` or creates it if not found.
   *
   * Look-up priority:
   * 1. `data.id` — query by primary key
   * 2. `data.slug` — query by slug + context
   * 3. Fallback — query by the full `data` object as a WHERE clause
   *
   * If a matching record is found, it is updated with any changed fields from
   * `data` (diffed against the existing record) and saved. If no match is
   * found, `defaults` are merged with `data` and a new record is created.
   *
   * @param data - The field values to find or upsert
   * @param defaults - Extra default values applied only when creating a new record
   * @returns The existing (possibly updated) or newly created object instance
   *
   * @example
   * ```typescript
   * // Find-or-create a tag by slug
   * const tag = await tags.getOrUpsert({ slug: 'javascript', name: 'JavaScript' });
   *
   * // With defaults applied only on creation
   * const user = await users.getOrUpsert(
   *   { email: 'alice@example.com' },
   *   { role: 'member', active: true },
   * );
   * ```
   *
   * @see {@link create} for always-insert semantics
   * @see {@link get} for read-only lookup
   */
  public async getOrUpsert(
    data: Record<string, unknown>,
    defaults: Record<string, unknown> = {},
  ) {
    const logicalData = this.normalizeLogicalData(data);
    const logicalDefaults = this.normalizeLogicalData(defaults);
    let where: Record<string, unknown> = {};
    const diffData = { ...logicalData };
    if (logicalData.id) {
      where = { id: logicalData.id };
      delete diffData.id;
      delete diffData.slug;
      delete diffData.context;
    } else if (logicalData.slug) {
      where = { slug: logicalData.slug, context: logicalData.context || '' };
      delete diffData.slug;
      delete diffData.context;
    } else {
      where = logicalData;
    }
    // Force a fresh read: this probe decides create-vs-update, so a stale cache
    // hit could update a row that no longer exists or miss one that does.
    const existing = await this.get(where, { cache: false });
    if (existing) {
      const diff = this.getDiffSync(existing, diffData);
      if (diff) {
        Object.assign(existing, diff);
        await existing.save();
      }
      return existing;
    }
    const createData = {
      ...logicalDefaults,
      ...logicalData,
    } as SmrtCreateInput<ModelType>;

    return await this.create(createData);
  }

  /**
   * Gets differences between an existing object and new data
   *
   * @param existing - Existing object
   * @param data - New data
   * @returns Object containing only the changed fields
   */
  async getDiff(
    existing: SmrtObject | Record<string, unknown>,
    data: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    return this.getDiffSync(existing, data);
  }

  private getDiffSync(
    existing: SmrtObject | Record<string, unknown>,
    data: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const fields = this.getFieldsSync();
    const validKeys = new Set([
      ...Object.keys(fields),
      'id',
      'slug',
      'context',
    ]);
    // `existing` may be a SmrtObject instance (no index signature); read its
    // dynamic fields through a record view.
    const existingRecord = existing as unknown as Record<string, unknown>;
    const diff = Object.keys(data).reduce(
      (acc, key) => {
        if (
          validKeys.has(key) &&
          !this.areEquivalentValues(existingRecord[key], data[key])
        ) {
          acc[key] = data[key];
        }
        return acc;
      },
      {} as Record<string, unknown>,
    );

    return Object.keys(diff).length > 0 ? diff : null;
  }

  /**
   * Gets field definitions for the collection's item class
   *
   * @returns Object containing field definitions
   */
  async getFields(): Promise<Record<string, CollectionFieldDefinition>> {
    // `fieldsFromClass` returns the open `Record<string, unknown>` field bag;
    // its entries structurally match `CollectionFieldDefinition` (`name`,
    // `type`, `_meta`). View through `unknown` at this boundary.
    return (await fieldsFromClass(this._itemClass)) as unknown as Record<
      string,
      CollectionFieldDefinition
    >;
  }

  /**
   * Normalize user input into the model's logical field names before diffing or creation.
   *
   * Accepts both camelCase and snake_case keys while preserving framework meta fields.
   */
  private normalizeLogicalData(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const fields = this.getFieldsSync();
    const normalized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) {
        normalized[key] = value;
        continue;
      }

      const camelKey = key.includes('_') ? toCamelCase(key) : key;
      const snakeKey = key.includes('_') ? key : toSnakeCase(key);
      const outputKey =
        key in fields
          ? key
          : camelKey in fields
            ? camelKey
            : snakeKey in fields
              ? snakeKey
              : key;

      normalized[outputKey] = value;
    }

    return normalized;
  }

  /**
   * Preserve persisted core timestamp fields during lightweight hydration.
   */
  private withHydratedCoreFields(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const hydratedData = { ...data };

    if (
      hydratedData.createdAt !== undefined &&
      hydratedData.created_at === undefined
    ) {
      hydratedData.created_at = hydratedData.createdAt;
    }

    if (
      hydratedData.updatedAt !== undefined &&
      hydratedData.updated_at === undefined
    ) {
      hydratedData.updated_at = hydratedData.updatedAt;
    }

    return hydratedData;
  }

  /**
   * Treat date-equivalent values as unchanged even if their runtime types differ.
   */
  private areEquivalentValues(
    existingValue: unknown,
    nextValue: unknown,
  ): boolean {
    if (existingValue instanceof Date || nextValue instanceof Date) {
      const existingTime = this.toComparableTime(existingValue);
      const nextTime = this.toComparableTime(nextValue);

      if (existingTime !== null && nextTime !== null) {
        return existingTime === nextTime;
      }
    }

    return existingValue === nextValue;
  }

  /**
   * Convert supported date inputs into comparable timestamps.
   */
  private toComparableTime(value: unknown): number | null {
    if (value instanceof Date) {
      const timestamp = value.getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    if (typeof value === 'string' && value.trim()) {
      const parsedDate = new Date(value);
      const timestamp = parsedDate.getTime();
      return Number.isNaN(timestamp) ? null : timestamp;
    }

    return null;
  }

  /**
   * Gets field definitions synchronously from cache.
   *
   * This method provides sync access to fields for use in query methods,
   * avoiding the async overhead of getFields() on every query.
   * Fields are cached during create() initialization.
   *
   * @returns Map containing field definitions
   * @private
   */
  getFieldsSync(): Record<string, CollectionFieldDefinition> {
    if (this._cachedFields) {
      return this._cachedFields;
    }
    // Fallback to ObjectRegistry sync method if cache not populated
    // This handles edge cases where collection wasn't created via static create()
    const className = this.getResolvedItemClassName();
    const fields = ObjectRegistry.getFields(className);
    // Convert Map to Record for consistency with getFields() return type.
    // Registry `RegisteredField`s are a structural superset of the members the
    // collection reads (`type`, `sensitive`, `_meta`); view through `unknown`.
    return Object.fromEntries(fields) as unknown as Record<
      string,
      CollectionFieldDefinition
    >;
  }

  /**
   * Generates database schema for the collection's item class
   *
   * Leverages ObjectRegistry's cached schema for instant retrieval.
   *
   * @returns Schema object for database setup
   */
  async generateSchema() {
    // Always generate fresh schema to ensure latest field mapping is used
    const { generateSchema } = await import('./schema/utils.js');
    return await generateSchema(this._itemClass);
  }

  /**
   * Gets the database table name for this collection
   */
  get tableName() {
    if (!this._tableName) {
      // For STI, use the base class's table name from schema (manifest-derived).
      // R5-canon: use the qualified item name as the lookup key so a
      // colliding simple name in another package can't yield the wrong
      // tableStrategy / STI base and route every downstream query
      // (get/list/count/create) to the wrong table.
      const className = this.getResolvedItemClassName();
      const qualifiedName = this.getResolvedItemQualifiedName();
      const tableStrategy = ObjectRegistry.getTableStrategy(qualifiedName);
      const fallbackTableName =
        (this._itemClass as unknown as { SMRT_TABLE_NAME?: string })
          .SMRT_TABLE_NAME || classnameToTablename(className);

      if (tableStrategy === 'sti') {
        const stiBase = ObjectRegistry.getSTIBase(qualifiedName);
        if (stiBase) {
          // Use base class's schema tableName (from manifest)
          const baseSchema = ObjectRegistry.getSchema(stiBase);
          if (baseSchema?.tableName) {
            this._tableName = baseSchema.tableName;
          } else {
            // Fallback to own schema tableName
            const ownSchema = ObjectRegistry.getSchema(className);
            this._tableName = ownSchema?.tableName || fallbackTableName;
          }
        } else {
          // Fallback to own schema tableName
          const ownSchema = ObjectRegistry.getSchema(className);
          this._tableName = ownSchema?.tableName || fallbackTableName;
        }
      } else {
        // CTI: Use own schema tableName
        const ownSchema = ObjectRegistry.getSchema(className);
        this._tableName = ownSchema?.tableName || fallbackTableName;
      }
    }
    return this._tableName;
  }

  /**
   * Generates a table name from the collection class name
   *
   * @returns Generated table name
   */
  generateTableName() {
    // Convert camelCase/PascalCase to snake_case and pluralize
    const tableName = this._className
      // Insert underscore between lower & upper case letters
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      // Convert to lowercase
      .toLowerCase()
      // Handle basic pluralization rules
      .replace(/([^s])$/, '$1s')
      // Handle special cases ending in 'y'
      .replace(/y$/, 'ies');

    return tableName;
  }

  /**
   * Deletes a record from the collection by ID
   *
   * Loads the object and calls its delete() method, ensuring all interceptors
   * and lifecycle hooks (beforeDelete/afterDelete) are executed correctly.
   *
   * @param id - The ID of the record to delete
   * @returns Promise resolving to true if deleted, false if not found
   *
   * @example
   * ```typescript
   * const success = await collection.delete('some-uuid');
   * if (success) {
   *   console.log('Record deleted');
   * }
   * ```
   */
  public async delete(id: string): Promise<boolean> {
    // Schema already initialized in Collection.create() static factory

    // Ensure manifest is loaded for external packages
    await ObjectRegistry.ensureManifestLoaded(this.getResolvedItemClassName());

    // Load the object first - if it doesn't exist, return false immediately.
    // Force a fresh read: this probe gates a mutation and decides the return
    // value, so a stale cache hit could delete a phantom (returning true for a
    // row another process already removed) or skip a real delete.
    const instance = await this.get(id, { cache: false });
    if (!instance) {
      return false;
    }

    // Call the object's delete() method, which handles:
    // - beforeDelete interceptors
    // - beforeDelete lifecycle hooks
    // - Database deletion
    // - afterDelete lifecycle hooks
    // - afterDelete interceptors
    await instance.delete();

    return true;
  }

  /**
   * Returns the number of records matching the given filter conditions.
   *
   * Executes a `SELECT COUNT(*)` query with the same WHERE conversion as
   * `list()` (camelCase field names, operator suffixes, STI auto-filtering).
   * `limit`, `offset`, and `orderBy` are not applicable and are ignored.
   *
   * Note: `count()` is never served from the read cache (issue #1498) — only
   * `list()`/`get()` are. On a page that caches `list()`, a `count()` issued
   * in the same request reflects the live database and may briefly diverge
   * from the cached rows within the TTL window.
   *
   * @param options.where - Filter conditions (same syntax as `list()`)
   * @returns Total count of matching records as an integer
   *
   * @example
   * ```typescript
   * const total = await products.count();
   * const activeCount = await products.count({ where: { status: 'active' } });
   * const expensiveCount = await products.count({ where: { 'price >': 100 } });
   * ```
   *
   * @see {@link list} for retrieving the actual records
   */
  public async count(
    options: {
      where?: SmrtListWhereClause<ModelType>;
      stiScope?: SmrtStiReadScope;
    } = {},
  ) {
    await this.ensureStorageReady();
    const itemClassName = this.getResolvedItemClassName();

    // Security (#1540): count() is a list-shaped read, so run the same
    // `beforeList` interceptors (tenant filtering, etc.). Without this, count()
    // bypasses tenant scoping and returns a cross-tenant total even when the
    // matching list() is correctly filtered — leaking row counts across tenants.
    const interceptorContext = createInterceptorContext(
      itemClassName,
      'list',
      this.constructor.name,
    );
    const interceptedOptions =
      (await GlobalInterceptors.executeBeforeList(
        itemClassName,
        options as InterceptorListOptions,
        interceptorContext,
      )) ??
      (options as InterceptorListOptions | undefined) ??
      {};

    let { where, stiScope } = interceptedOptions as SmrtListOptions<ModelType>;

    where = this.applyStiReadScope(where, stiScope);

    // Resolve _meta_type to qualified name if user provided simple class name (Issue #713)
    where = resolveMetaTypeInWhere(where);

    // convertWhereKeys is now sync (issue #663) - no await needed
    const { sql: whereSql, values: whereValues } = buildWhere(
      this.convertWhereKeys(where || {}),
    );

    const result = await this.db.query(
      `SELECT COUNT(*) as count FROM ${this.tableName} ${whereSql}`,
      ...whereValues,
    );

    return toSafeInteger(result.rows[0].count, 'Collection count');
  }

  /**
   * Return database-backed distinct values and row counts for one or more
   * column-backed fields.
   *
   * Each requested field is executed as a bounded `GROUP BY` query. Keeping
   * one query per field uses standard SQL while avoiding a full collection
   * read or model hydration. Scalar facet behavior is covered on SQLite and
   * DuckDB; optional PostgreSQL scalar coverage runs in the `test:postgres`
   * lane when `SMRT_TEST_POSTGRES_URL` is configured.
   * The same `beforeList` interceptors as `list()` and `count()` run first,
   * so tenancy and other read scopes are applied to every facet query.
   *
   * Facets group by the value stored in the column. SMRT does not split,
   * unnest, or otherwise interpret array/string-list fields; consumers that
   * need a facet per array member should maintain a scalar join table or use
   * a consumer-specific query. JSON fields are grouped by their stored JSON
   * value and decoded in the returned `value` when the field metadata allows
   * it. Array/JSON encoding behavior is adapter-specific and is covered by
   * the SQLite/DuckDB tests only; the optional PostgreSQL test covers scalar
   * grouping.
   *
   * @param options.fields One or more fields, optionally with per-field limits
   * @param options.where Filter conditions using the same syntax as `list()`
   * @returns One value/count list per requested field, in request order
   *
   * Limits are always bounded: an explicit per-field limit is clamped to
   * {@link MAX_FACET_LIMIT}, the collection's `maxListLimit` when configured,
   * and the lower of those ceilings. When omitted, the effective limit is the
   * collection's `defaultListLimit` or {@link DEFAULT_FACET_LIMIT}, subject to
   * the same ceilings. This keeps facet queries bounded even when collection
   * list bounds are unset.
   */
  public async facets(
    options: SmrtFacetOptions<ModelType>,
  ): Promise<SmrtFacetResult[]> {
    await this.ensureStorageReady();

    if (!options || !Array.isArray(options.fields)) {
      throw new Error('Invalid facets option: fields must be an array.');
    }
    if (options.fields.length === 0) {
      throw new Error('Invalid facets option: at least one field is required.');
    }
    if (options.fields.length > MAX_FACET_FIELDS) {
      throw new Error(
        `Invalid facets option: at most ${MAX_FACET_FIELDS} fields are allowed.`,
      );
    }

    const itemClassName = this.getResolvedItemClassName();
    const itemQualifiedName = this.getResolvedItemQualifiedName();
    const interceptorContext = createInterceptorContext(
      itemClassName,
      'list',
      this.constructor.name,
    );
    const interceptedOptions =
      (await GlobalInterceptors.executeBeforeList(
        itemClassName,
        options as unknown as InterceptorListOptions,
        interceptorContext,
      )) ??
      (options as unknown as InterceptorListOptions) ??
      {};

    let { where, stiScope } =
      interceptedOptions as unknown as SmrtFacetOptions<ModelType>;
    const isSTI = ObjectRegistry.getTableStrategy(itemQualifiedName) === 'sti';
    where = this.applyStiReadScope(where, stiScope);
    where = resolveMetaTypeInWhere(where);

    const { sql: whereSql, values: whereValues } = buildWhere(
      this.convertWhereKeys(where || {}),
    );
    const fields = this.getFieldsSync();
    const interceptedFields = (
      interceptedOptions as unknown as Partial<SmrtFacetOptions<ModelType>>
    ).fields;
    const effectiveFields = interceptedFields ?? options.fields;
    if (!Array.isArray(effectiveFields) || effectiveFields.length === 0) {
      throw new Error(
        'Invalid facets option: at least one field is required after interception.',
      );
    }
    if (effectiveFields.length > MAX_FACET_FIELDS) {
      throw new Error(
        `Invalid facets option: at most ${MAX_FACET_FIELDS} fields are allowed after interception.`,
      );
    }
    const requested = effectiveFields.map((entry) =>
      typeof entry === 'string' ? { field: entry } : entry,
    );
    const seen = new Set<string>();
    const results: SmrtFacetResult[] = [];

    for (const request of requested) {
      if (!request || typeof request.field !== 'string') {
        throw new Error(
          'Invalid facet field: expected a string or { field, limit }.',
        );
      }
      const field = request.field;
      if (seen.has(field)) {
        throw new Error(
          `Invalid facet field: '${field}' was requested more than once.`,
        );
      }
      seen.add(field);

      // Reuse projection validation so facets cannot expose sensitive,
      // readPermission-gated, relationship-only, transient, or unknown
      // fields. The returned SQL is intentionally not used: aggregation needs
      // the same safe column identifier without hydrating a projection row.
      this.resolveProjectionSelect([field], fields, isSTI);

      const columnName = this.toDbColumnName(field);
      const quotedColumn = this.quoteProjectionIdentifier(columnName);
      const quotedField = this.quoteProjectionIdentifier(field);
      const requestedLimit =
        request.limit === undefined
          ? (this._defaultListLimit ?? DEFAULT_FACET_LIMIT)
          : assertQueryBound(request.limit, `facet limit for '${field}'`);
      const collectionLimit = this._maxListLimit ?? MAX_FACET_LIMIT;
      const limit = Math.min(
        requestedLimit ?? DEFAULT_FACET_LIMIT,
        collectionLimit,
        MAX_FACET_LIMIT,
      );
      const sql =
        `SELECT ${quotedColumn} AS ${quotedField}, ` +
        `COUNT(*) AS "__smrt_facet_count" FROM ${this.tableName} ` +
        `${whereSql} GROUP BY ${quotedColumn} ` +
        `ORDER BY "__smrt_facet_count" DESC, ` +
        `CASE WHEN ${quotedColumn} IS NULL THEN 1 ELSE 0 END ASC, ` +
        `${quotedColumn} ASC ` +
        `LIMIT $${whereValues.length + 1}`;
      const params = [...whereValues, limit];
      const queryResult = await this.db.query(sql, ...params);

      results.push({
        field,
        values: queryResult.rows.map((row) => {
          const rawValue = row[field];
          const formatted = formatDataJs({ [columnName]: rawValue }, fields);
          const formattedKey = Object.hasOwn(formatted, field)
            ? field
            : toCamelCase(field);
          const value = Object.hasOwn(formatted, formattedKey)
            ? formatted[formattedKey]
            : rawValue;
          return {
            value,
            count: toSafeInteger(
              row.__smrt_facet_count,
              `Facet count for '${field}'`,
            ),
          };
        }),
      });
    }

    return results;
  }

  /**
   * Return both the tenant/read-scoped total and a filtered count.
   *
   * This intentionally issues two `COUNT(*)` queries rather than reading
   * rows into application memory. `count()` applies `beforeList` for each
   * query, so the unfiltered total remains tenant-scoped while the filtered
   * count adds the caller's `where` conditions.
   */
  public async counts(
    options: {
      where?: SmrtListWhereClause<ModelType>;
      stiScope?: SmrtStiReadScope;
    } = {},
  ): Promise<SmrtCollectionCounts> {
    const total = await this.count({ stiScope: options.stiScope });
    const filtered = await this.count(options);
    return { total, filtered };
  }

  /**
   * Resolve this collection's STI child discriminator — the qualified item
   * class name to use as a `_meta_type` scope — when the collection's item is
   * an STI **child** (shares a table with sibling subtypes), or `null` for STI
   * bases, CTI, and non-STI item classes.
   *
   * Mirrors the automatic `_meta_type` scoping that `list()` / `get()` apply
   * for STI child collections (#386), using the same `ObjectRegistry` source of
   * truth (`getTableStrategy` + `getSTIBase`). Raw-SQL helpers that bypass
   * `list()` — e.g. the tenant global / with-globals lookups in
   * `@happyvertical/smrt-tenancy` (#1600) — call this to scope a shared STI
   * table to the collection's own subtype, so they never surface sibling rows.
   * Deriving the scope here keeps every consumer consistent with `list()`
   * without each one hand-classifying its collection's table strategy.
   *
   * @returns The qualified `_meta_type` for an STI child collection, or `null`
   *   when no `_meta_type` scoping applies (STI base / CTI / non-STI).
   */
  public getStiChildMetaType(): string | null {
    const itemQualifiedName = this.getResolvedItemQualifiedName();
    if (ObjectRegistry.getTableStrategy(itemQualifiedName) !== 'sti') {
      return null;
    }
    const stiBase = ObjectRegistry.getSTIBase(itemQualifiedName);
    return stiBase && stiBase !== itemQualifiedName ? itemQualifiedName : null;
  }

  /**
   * Execute a raw SQL query and hydrate results as collection item instances
   *
   * Provides full SQL power for complex queries (JOINs, CTEs, NOT EXISTS, etc.)
   * while still returning properly hydrated SMRT objects.
   *
   * @param sql - Raw SQL query string (should select from this.tableName)
   * @param params - Query parameters for prepared statement
   * @returns Promise resolving to array of hydrated model instances
   *
   * @example
   * ```typescript
   * // Find meetings without corresponding recaps (NOT EXISTS pattern)
   * const meetings = await meetingCollection.query(`
   *   SELECT m.* FROM meetings m
   *   WHERE m.start_date < datetime('now')
   *   AND NOT EXISTS (
   *     SELECT 1 FROM contents c
   *     WHERE c.meeting_id = m.id
   *     AND c._meta_type = 'MeetingRecap'
   *   )
   *   ORDER BY m.start_date DESC
   *   LIMIT ?
   * `, [10]);
   *
   * // Complex JOIN query
   * const products = await productCollection.query(`
   *   SELECT p.* FROM products p
   *   INNER JOIN categories c ON p.category_id = c.id
   *   WHERE c.name = ? AND p.price > ?
   *   ORDER BY p.price ASC
   * `, ['Electronics', 100]);
   * ```
   */
  public async query(
    sql: string,
    params: unknown[] = [],
    options: { allowRawOnTenantScoped?: boolean } = {},
  ): Promise<ModelType[]> {
    await this.ensureStorageReady();

    // Execute beforeQuery interceptors (e.g., tenant raw SQL policy)
    const interceptorContext = createInterceptorContext(
      this._itemClass.name,
      'query',
      this.constructor.name,
    );
    const interceptedQuery = await GlobalInterceptors.executeBeforeQuery(
      this._itemClass.name,
      { sql, params, allowRawOnTenantScoped: options.allowRawOnTenantScoped },
      interceptorContext,
    );

    const rows = await this.queryDuckDbCanonicalSelectRows(
      interceptedQuery.sql,
      interceptedQuery.params,
    );

    // query() is a raw escape hatch documented for SELECTs, but it can run any
    // SQL. A write issued through it bypasses the save()/delete() invalidation
    // hooks, so conservatively bust this table's cache when the statement looks
    // like a mutation (issue #1498). The word-boundary match ignores column
    // names like `updated_at`/`deleted_at`; a false positive (e.g. SELECT ...
    // FOR UPDATE) only costs a cache miss, never a stale read.
    if (
      /\b(?:insert|update|delete|merge|truncate|replace)\b/i.test(
        interceptedQuery.sql,
      )
    ) {
      invalidateCollectionCache(resolveDbCacheKey(this.db), this.tableName);
    }

    const fields = this.getFieldsSync();

    // STI: Check if we need polymorphic hydration.
    // R5-canon: pass the qualified item name so a colliding simple
    // name in another package can't yield the wrong tableStrategy
    // and feed the wrong `isSTI` boolean into `hydrateResultRow`.
    const tableStrategy = ObjectRegistry.getTableStrategy(
      this.getResolvedItemQualifiedName(),
    );
    const isSTI = tableStrategy === 'sti';

    const instances = await this.hydrateResultRows(rows, fields, isSTI);

    // Execute afterQuery interceptors
    return await GlobalInterceptors.executeAfterQuery(
      this._itemClass.name,
      instances,
      interceptorContext,
    );
  }

  private async hydrateResultRow(
    row: Record<string, unknown>,
    fields: Record<string, CollectionFieldDefinition>,
    isSTI: boolean,
    polymorphicFields = new Map<
      string,
      Record<string, CollectionFieldDefinition>
    >(),
  ): Promise<ModelType> {
    const hydrationFields = await this.resolveHydrationFields(
      row,
      fields,
      isSTI,
      polymorphicFields,
    );
    const formattedData = this.withHydratedCoreFields(
      formatDataJs(row, hydrationFields),
    );

    const metaType = formattedData._meta_type;
    if (isSTI && metaType) {
      const polymorphicInstance = await this.createPolymorphic(
        typeof metaType === 'string' ? metaType : String(metaType),
        formattedData,
        { hydrateOnly: true },
      );
      return polymorphicInstance;
    }

    const instanceParams = {
      ai: this.options.ai,
      db: this.db,
      _skipLoad: true,
      _reuseInitializedDb: true,
      _deferRuntimeInitialization: true,
      ...formattedData,
    };

    const instance = new this._itemClass(instanceParams);
    // Mark before initialize() so model lifecycle guards can safely snapshot
    // authoritative hydrated values without probing the database. A fresh
    // caller-created `_skipLoad` instance remains unpersisted.
    instance.markAsPersisted();
    await instance.initialize();

    if (isSTI) {
      const registeredClass = ObjectRegistry.getClass(this._itemClass.name);
      // Dynamic STI discriminator write — `_meta_type` is a runtime-only field
      // not in the static SmrtObject shape; view as a writable bag.
      (instance as unknown as { _meta_type?: string })._meta_type =
        registeredClass?.qualifiedName || this._itemClass.name;
    }

    return instance;
  }

  /**
   * Resolve inherited field metadata for an STI row's concrete discriminator.
   * The caller-provided collection fields remain the safe fallback for
   * non-polymorphic, malformed, or not-yet-registered rows.
   */
  private async resolveHydrationFields(
    row: Record<string, unknown>,
    fallbackFields: Record<string, CollectionFieldDefinition>,
    isSTI: boolean,
    polymorphicFields: Map<string, Record<string, CollectionFieldDefinition>>,
  ): Promise<Record<string, CollectionFieldDefinition>> {
    if (!isSTI) return fallbackFields;

    const rawMetaType = row._meta_type ?? row._metaType;
    if (rawMetaType === null || rawMetaType === undefined) {
      return fallbackFields;
    }

    const metaType = String(rawMetaType);
    const cached = polymorphicFields.get(metaType);
    if (cached) return cached;
    if (!ObjectRegistry.getClass(metaType)) {
      await ObjectRegistry.ensureManifestLoaded(metaType);
    }

    const registeredFields = await ObjectRegistry.getAllFields(metaType);
    if (registeredFields.size === 0) return fallbackFields;

    const concreteFields: Record<string, CollectionFieldDefinition> = {};
    for (const [fieldName, field] of registeredFields) {
      concreteFields[fieldName] = { type: field.type };
    }
    polymorphicFields.set(metaType, concreteFields);
    return concreteFields;
  }

  /**
   * Hydrate rows in result order.
   *
   * A model's initialize() hook may query through the collection database.
   * PostgreSQL transaction adapters bind every query to one pg client, which
   * cannot execute overlapping client.query() calls once pg 9 removes its
   * deprecated per-client queue. Serial hydration therefore protects every
   * model hook without relying on driver queuing and preserves row order.
   */
  private async hydrateResultRows(
    rows: Record<string, unknown>[],
    fields: Record<string, CollectionFieldDefinition>,
    isSTI: boolean,
  ): Promise<ModelType[]> {
    const instances: ModelType[] = [];
    const polymorphicFields = new Map<
      string,
      Record<string, CollectionFieldDefinition>
    >();
    for (const row of rows) {
      instances.push(
        await this.hydrateResultRow(row, fields, isSTI, polymorphicFields),
      );
    }
    return instances;
  }

  /**
   * Resolve the `_smrt_contexts.owner_id` key for collection-level memory
   * (#2365).
   *
   * `_smrt_contexts` has no tenant column, so before this hook a tenant-scoped
   * collection's learned memory (`remember()`/`recall()`) was filed under one
   * shared `__collection__` key and leaked across tenants. For a tenant-scoped
   * item class under an active tenant context the key becomes
   * `__collection__:<tenantId>`; everything else (tenancy disabled, no active
   * tenant, system context, non-tenant-scoped class) keeps the shared
   * `__collection__` key. Tenant-keyed memory is strictly isolated — a tenant
   * recall does NOT fall back to the shared key, so memory learned outside a
   * tenant context is invisible inside one (and vice versa).
   *
   * Tenant resolution uses the same core-side trust anchors as the generated
   * REST read scope (#1782): `resolveDispatchTenantScope()` for the active
   * tenant and the triple tenant-scoped-class check covering `@smrt()` config,
   * manifest config, and the tenancy-filled `@TenantScoped()` resolver.
   */
  private resolveCollectionMemoryOwnerId(): string {
    const itemClassName = this.getResolvedItemClassName();
    const tenantScoped =
      ObjectRegistry.isTenantScoped(itemClassName) ||
      !!ObjectRegistry.getConfig(itemClassName)?.tenantScoped ||
      isTenantScopedClassResolved(itemClassName);
    if (!tenantScoped) {
      return COLLECTION_MEMORY_OWNER_ID;
    }
    const scope = resolveDispatchTenantScope();
    if (!scope.enforced || !scope.tenantId) {
      return COLLECTION_MEMORY_OWNER_ID;
    }
    return `${COLLECTION_MEMORY_OWNER_ID}:${scope.tenantId}`;
  }

  /**
   * Remember collection-level context
   *
   * Stores context applicable to all instances of this collection type.
   * Use for patterns that apply to the entire collection (e.g., default parsing strategies).
   *
   * Under an active tenant context on a tenant-scoped class, memory is keyed
   * per tenant and never shared across tenants (#2365) — see
   * {@link resolveCollectionMemoryOwnerId}.
   *
   * `expiresAt` is stored on the `_smrt_contexts` row as caller-managed metadata.
   * {@link recall} and {@link recallAll} do **not** filter on it, so an expired
   * entry is still returned; filter or delete expired entries yourself.
   *
   * @param options - Context options
   * @returns Promise that resolves when context is stored
   * @example
   * ```typescript
   * // Remember a default parsing strategy for all documents
   * await documentCollection.remember({
   *   scope: 'parser/default',
   *   key: 'selector',
   *   value: { pattern: '.content article' },
   *   confidence: 0.8
   * });
   *
   * // Update an existing context entry by specifying id
   * await documentCollection.remember({
   *   id: 'existing-context-id',
   *   scope: 'parser/default',
   *   key: 'selector',
   *   value: { pattern: '.content main article' },
   *   confidence: 0.85
   * });
   * ```
   */
  public async remember(options: {
    id?: string;
    scope: string;
    key: string;
    value: unknown;
    metadata?: unknown;
    confidence?: number;
    version?: number;
    expiresAt?: Date;
  }): Promise<void> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const id = options.id || crypto.randomUUID();
    const now = new Date();

    // Use upsert() for database-agnostic INSERT OR REPLACE
    // SQLite: INSERT OR REPLACE
    // Postgres/DuckDB: INSERT ... ON CONFLICT ... DO UPDATE
    await this.systemDb.upsert(
      '_smrt_contexts',
      // UNIQUE constraint: (owner_class, owner_id, scope, key, version)
      ['owner_class', 'owner_id', 'scope', 'key', 'version'],
      {
        id,
        owner_class: this._itemClass.name,
        owner_id: this.resolveCollectionMemoryOwnerId(),
        scope: options.scope,
        key: options.key,
        value: JSON.stringify(options.value),
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        version: options.version ?? 1,
        confidence: options.confidence ?? 1.0,
        success_count: 0,
        failure_count: 0,
        created_at: now,
        updated_at: now,
        last_used_at: now,
        expires_at: options.expiresAt ?? null,
      },
    );
  }

  /**
   * Recall collection-level context
   *
   * Retrieves context that applies to all instances of this collection.
   *
   * @param options - Recall options
   * @returns Promise resolving to the context value or null if not found
   * @example
   * ```typescript
   * // Recall default parsing strategy
   * const strategy = await documentCollection.recall({
   *   scope: 'parser/default',
   *   key: 'selector',
   *   minConfidence: 0.5
   * });
   * ```
   */
  public async recall(options: {
    scope: string;
    key: string;
    includeAncestors?: boolean;
    minConfidence?: number;
  }): Promise<unknown> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const ownerId = this.resolveCollectionMemoryOwnerId();

    // Use single() with template literals for custom SQL query.
    // The query projects `value` (a JSON string) and `confidence`.
    let result: Record<string, unknown> | null;
    if (options.minConfidence !== undefined) {
      result = await this.systemDb.single`
        SELECT value, confidence
        FROM _smrt_contexts
        WHERE owner_class = ${this._itemClass.name}
          AND owner_id = ${ownerId}
          AND scope = ${options.scope}
          AND key = ${options.key}
          AND confidence >= ${options.minConfidence}
        ORDER BY confidence DESC, version DESC
        LIMIT 1
      `;
    } else {
      result = await this.systemDb.single`
        SELECT value, confidence
        FROM _smrt_contexts
        WHERE owner_class = ${this._itemClass.name}
          AND owner_id = ${ownerId}
          AND scope = ${options.scope}
          AND key = ${options.key}
        ORDER BY confidence DESC, version DESC
        LIMIT 1
      `;
    }

    if (result) {
      // Guard against a corrupted _smrt_contexts row: a single malformed value
      // must not throw an uncaught SyntaxError out of recall(). Treat it as a
      // miss and continue to the ancestor fallback (#1378). `value` is the
      // queried JSON text column; the try/catch covers a non-string/corrupt row.
      try {
        return JSON.parse(result.value as string);
      } catch (error) {
        logger.warn('Skipping corrupted _smrt_contexts value in recall()', {
          ownerClass: this._itemClass.name,
          scope: options.scope,
          key: options.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Hierarchical fallback to parent scopes
    if (options.includeAncestors) {
      const scopeParts = options.scope.split('/');
      while (scopeParts.length > 0) {
        scopeParts.pop();
        const parentScope = scopeParts.join('/') || 'global';

        const parentResult = await this.recall({
          ...options,
          scope: parentScope,
          includeAncestors: false,
        });

        if (parentResult) return parentResult;
      }
    }

    return null;
  }

  /**
   * Recall all collection-level context in a scope
   *
   * Returns a Map of key -> value for all collection contexts matching the criteria.
   *
   * @param options - Recall options
   * @returns Promise resolving to Map of key -> value pairs
   * @example
   * ```typescript
   * // Get all default strategies
   * const strategies = await documentCollection.recallAll({
   *   scope: 'parser/default',
   *   minConfidence: 0.5
   * });
   * ```
   */
  public async recallAll(
    options: {
      scope?: string;
      includeDescendants?: boolean;
      minConfidence?: number;
    } = {},
  ): Promise<Map<string, unknown>> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const results = new Map<string, unknown>();

    let query = `
      SELECT key, value, confidence
      FROM _smrt_contexts
      WHERE owner_class = ? AND owner_id = ?
    `;
    const params: unknown[] = [
      this._itemClass.name,
      this.resolveCollectionMemoryOwnerId(),
    ];

    if (options.scope) {
      if (options.includeDescendants) {
        query += ` AND (scope = ? OR scope LIKE ?)`;
        params.push(options.scope, `${options.scope}/%`);
      } else {
        query += ` AND scope = ?`;
        params.push(options.scope);
      }
    }

    if (options.minConfidence !== undefined) {
      query += ` AND confidence >= ?`;
      params.push(options.minConfidence);
    }

    query += ` ORDER BY confidence DESC`;

    const { rows } = await this.systemDb.query(query, ...params);

    for (const row of rows) {
      // Skip a corrupted row rather than aborting the whole recallAll() (#1378).
      try {
        results.set(row.key, JSON.parse(row.value));
      } catch (error) {
        logger.warn('Skipping corrupted _smrt_contexts value in recallAll()', {
          ownerClass: this._itemClass.name,
          scope: options.scope,
          key: row.key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }

  /**
   * Forget collection-level context
   *
   * Deletes collection context by scope and key.
   *
   * @param options - Context identification
   * @returns Promise that resolves when context is deleted
   * @example
   * ```typescript
   * // Remove a default strategy
   * await documentCollection.forget({
   *   scope: 'parser/default',
   *   key: 'selector'
   * });
   * ```
   */
  public async forget(options: { scope: string; key: string }): Promise<void> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    await this.systemDb.query(
      `DELETE FROM _smrt_contexts
       WHERE owner_class = ? AND owner_id = ? AND scope = ? AND key = ?`,
      this._itemClass.name,
      this.resolveCollectionMemoryOwnerId(),
      options.scope,
      options.key,
    );
  }

  /**
   * Forget all collection-level context in a scope
   *
   * Deletes all collection contexts matching the scope pattern.
   *
   * @param options - Scope options
   * @returns Promise resolving to number of contexts deleted
   * @example
   * ```typescript
   * // Clear all default strategies
   * const count = await documentCollection.forgetScope({
   *   scope: 'parser/default',
   *   includeDescendants: true
   * });
   * ```
   */
  public async forgetScope(options: {
    scope: string;
    includeDescendants?: boolean;
  }): Promise<number> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    let query = `
      DELETE FROM _smrt_contexts
      WHERE owner_class = ? AND owner_id = ?
    `;
    const params: unknown[] = [
      this._itemClass.name,
      this.resolveCollectionMemoryOwnerId(),
    ];

    if (options.includeDescendants) {
      query += ` AND (scope = ? OR scope LIKE ?)`;
      params.push(options.scope, `${options.scope}/%`);
    } else {
      query += ` AND scope = ?`;
      params.push(options.scope);
    }

    const { rowCount } = await this.systemDb.query(query, ...params);
    return rowCount || 0;
  }

  // ============================================================================
  // Semantic Search Methods
  // ============================================================================

  /**
   * Semantic search by text query
   *
   * Generates an embedding for the query text and finds similar objects
   * based on cosine similarity of stored embeddings.
   *
   * Under an active tenant context on a tenant-scoped class, candidates are
   * restricted to the tenant's rows BEFORE top-K ranking (#2365), so results
   * are never starved by — and similarity ranks never leak — other tenants'
   * content.
   *
   * @param query - Text to search for
   * @param options - Search options
   * @param options.field - Specific field to search (defaults to first embedding
   *   field). Any configured embedding field, or the configured
   *   `combinedField.name`, is accepted.
   * @param options.limit - Maximum results to return (default: 10)
   * @param options.minSimilarity - Minimum similarity threshold 0-1 (default: 0)
   * @param options.where - Additional WHERE filters to apply
   * @returns Promise resolving to array of objects with _similarity score
   *
   * @example
   * ```typescript
   * const results = await articles.semanticSearch('machine learning trends', {
   *   limit: 10,
   *   minSimilarity: 0.7
   * });
   *
   * for (const article of results) {
   *   console.log(`${article.title} (similarity: ${article._similarity})`);
   * }
   *
   * // Search the combined vector built from `combinedField.template`
   * const combined = await articles.semanticSearch('machine learning trends', {
   *   field: 'content'
   * });
   * ```
   */
  public async semanticSearch(
    query: string,
    options: {
      field?: string;
      limit?: number;
      minSimilarity?: number;
      where?: SmrtWhereClause<ModelType>;
    } = {},
  ): Promise<Array<ModelType & { _similarity: number }>> {
    const { field, limit = 10, minSimilarity = 0, where } = options;

    // Get embedding config
    const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(
      this._itemClass.name,
    );

    if (!embeddingConfig) {
      throw new Error(
        `No embedding configuration found for ${this._itemClass.name}. ` +
          `Add embeddings config to @smrt() decorator.`,
      );
    }

    // Determine which field to search.
    // `generateEmbeddings()` also stores a vector under the configured
    // `combinedField.name`, and `findSimilar`/`findSimilarToEmbedding` happily
    // search it, so it belongs in the searchable set here too (#2281).
    const searchField = field || embeddingConfig.fields[0];
    const searchableFields = getSearchableEmbeddingFields(embeddingConfig);
    if (!searchableFields.includes(searchField)) {
      throw new Error(
        `Field '${searchField}' is not configured for embeddings on ${this._itemClass.name}. ` +
          `Available fields: ${searchableFields.join(', ')}`,
      );
    }

    // Create embedding provider from the resolved class/project config so
    // query embeddings use the same model as stored object embeddings.
    const provider = new EmbeddingProvider(
      {
        dimensions: embeddingConfig.dimensions,
        provider: embeddingConfig.provider,
        localModel: embeddingConfig.localModel,
        aiModel: embeddingConfig.aiModel,
        fallbackToAI: embeddingConfig.fallbackToAI,
      },
      this.ai,
    );

    // Generate embedding for query
    const [queryEmbedding] = await provider.embed(query);

    // Find similar embeddings
    return this.findSimilarToEmbedding(queryEmbedding, {
      field: searchField,
      limit,
      minSimilarity,
      where,
    });
  }

  /**
   * Find objects similar to a given object
   *
   * Uses stored embeddings to find objects most similar to the provided object.
   *
   * @param object - Object to find similar items for (or object ID)
   * @param options - Search options
   * @param options.field - Specific field to compare (defaults to first embedding field)
   * @param options.limit - Maximum results to return (default: 5)
   * @param options.excludeSelf - Whether to exclude the source object (default: true)
   * @returns Promise resolving to array of similar objects with _similarity score
   *
   * @example
   * ```typescript
   * const article = await articles.get('some-article-id');
   * const similar = await articles.findSimilar(article, {
   *   limit: 5,
   *   excludeSelf: true
   * });
   * ```
   */
  public async findSimilar(
    object: ModelType | string,
    options: {
      field?: string;
      limit?: number;
      excludeSelf?: boolean;
    } = {},
  ): Promise<Array<ModelType & { _similarity: number }>> {
    const { field, limit = 5, excludeSelf = true } = options;

    // Get the object if ID was provided
    let sourceObject: ModelType;
    if (typeof object === 'string') {
      const found = await this.get(object);
      if (!found) {
        throw new Error(`Object not found: ${object}`);
      }
      sourceObject = found;
    } else {
      sourceObject = object;
    }

    // Get embedding config
    const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(
      this._itemClass.name,
    );

    if (!embeddingConfig) {
      throw new Error(
        `No embedding configuration found for ${this._itemClass.name}.`,
      );
    }

    // Determine which field to use
    const searchField = field || embeddingConfig.fields[0];

    // Get the source object's embedding using consistent model name from EmbeddingProvider
    const provider = new EmbeddingProvider(
      {
        dimensions: embeddingConfig.dimensions,
        provider: embeddingConfig.provider,
        localModel: embeddingConfig.localModel,
        aiModel: embeddingConfig.aiModel,
        fallbackToAI: embeddingConfig.fallbackToAI,
      },
      this.ai,
    );
    const model = provider.getModelName();

    const storedEmbedding = await EmbeddingStorage.get(
      this.systemDb,
      this._itemClass.name,
      sourceObject.id as string,
      searchField,
      model,
    );

    if (!storedEmbedding) {
      throw new Error(
        `No embedding found for object ${sourceObject.id} field '${searchField}'. ` +
          `Generate embeddings first with object.generateEmbeddings().`,
      );
    }

    // Find similar using the embedding
    const where = excludeSelf ? { 'id !=': sourceObject.id } : undefined;

    return this.findSimilarToEmbedding(storedEmbedding.embedding, {
      field: searchField,
      limit,
      minSimilarity: 0,
      where,
    });
  }

  /**
   * Find objects similar to a raw embedding vector
   *
   * Low-level method for finding objects by embedding similarity.
   *
   * @param embedding - Embedding vector to compare against
   * @param options - Search options
   * @param options.field - Field name to search (defaults to first embedding field)
   * @param options.limit - Maximum results to return (default: 10)
   * @param options.minSimilarity - Minimum similarity threshold 0-1 (default: 0)
   * @param options.where - Additional WHERE filters to apply
   * @returns Promise resolving to array of objects with _similarity score
   *
   * @example
   * ```typescript
   * // Using a pre-computed embedding
   * const results = await articles.findSimilarToEmbedding(myEmbedding, {
   *   limit: 10,
   *   minSimilarity: 0.5
   * });
   * ```
   */
  public async findSimilarToEmbedding(
    embedding: number[],
    options: {
      field?: string;
      limit?: number;
      minSimilarity?: number;
      where?: SmrtWhereClause<ModelType>;
    } = {},
  ): Promise<Array<ModelType & { _similarity: number }>> {
    const { field, limit = 10, minSimilarity = 0, where } = options;

    // Get embedding config
    const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(
      this._itemClass.name,
    );

    if (!embeddingConfig) {
      throw new Error(
        `No embedding configuration found for ${this._itemClass.name}.`,
      );
    }

    // Determine which field to search
    const searchField = field || embeddingConfig.fields[0];

    // Get model name using EmbeddingProvider for consistency
    const provider = new EmbeddingProvider(
      {
        dimensions: embeddingConfig.dimensions,
        provider: embeddingConfig.provider,
        localModel: embeddingConfig.localModel,
        aiModel: embeddingConfig.aiModel,
        fallbackToAI: embeddingConfig.fallbackToAI,
      },
      this.ai,
    );
    const model = provider.getModelName();

    // Resolve storage strategy
    const projectConfig = ObjectRegistry.getProjectEmbeddingConfig();
    const storage = projectConfig?.storage || 'json';
    const vector = storage === 'native' ? this.systemDb.vector : undefined;

    // Tenant pre-filter (#2365): _smrt_embeddings has no tenant column, so
    // top-K used to rank across ALL tenants and only the final list() below
    // dropped foreign rows — starving results and soft-leaking which tenants
    // have similar content. Resolve the tenant read predicate through the
    // SAME beforeList interceptor pipeline that guards collection reads (an
    // empty where comes back either untouched — tenancy off, class not
    // scoped, bypass/system context — or with exactly the injected tenant
    // predicate, or beforeList throws for `mode: 'required'` without
    // context), then restrict the candidate id set BEFORE ranking.
    const itemClassName = this.getResolvedItemClassName();
    const tenantPrefilterContext = createInterceptorContext(
      itemClassName,
      'list',
      this.constructor.name,
    );
    const tenantPrefilter = await GlobalInterceptors.executeBeforeList(
      itemClassName,
      { where: {} },
      tenantPrefilterContext,
    );
    let candidateObjectIds: string[] | undefined;
    if (
      tenantPrefilter.where &&
      Object.keys(tenantPrefilter.where).length > 0
    ) {
      const candidateWhere = this.convertWhereKeys(tenantPrefilter.where);
      const { sql: candidateWhereSql, values: candidateValues } =
        buildWhere(candidateWhere);
      // Deliberately unbounded: _smrt_embeddings has no tenant column, so the
      // only exact way to scope ranking is the full id set of the tenant's
      // rows. Capping it here would silently drop rows from the ranking —
      // wrong results, not a perf tweak. The native path chunks the ids
      // against bind-variable limits (see searchSimilar); the id-only
      // projection keeps the row cost minimal. If this becomes a hot spot for
      // very large tenants, the durable fix is a tenant column on
      // _smrt_embeddings, not a cap.
      const { rows: candidateRows } = await this.db.query(
        `SELECT id FROM ${this.tableName} ${candidateWhereSql}`,
        ...candidateValues,
      );
      candidateObjectIds = candidateRows.map((row: Record<string, unknown>) =>
        String(row.id),
      );
      if (candidateObjectIds.length === 0) {
        return [];
      }
    }

    // Use unified search method (delegates to native or in-memory)
    const scored = await EmbeddingStorage.searchSimilar(
      this.systemDb,
      this._itemClass.name,
      embedding,
      {
        field: searchField,
        model,
        limit,
        minSimilarity,
        objectIds: candidateObjectIds,
      },
      vector,
    );

    if (scored.length === 0) {
      return [];
    }

    // Load the objects
    const objectIds = scored.map((s) => s.objectId);
    const similarityMap = new Map(
      scored.map((s) => [s.objectId, s.similarity]),
    );

    // Build where clause with additional filters
    const whereClause = where
      ? { 'id in': objectIds, ...where }
      : { 'id in': objectIds };

    const objects = await this.list({
      where: whereClause as SmrtWhereClause<ModelType>,
    });

    // Add similarity scores to objects and sort by similarity.
    // We directly assign _similarity to avoid losing class properties when
    // spreading; view as a writable bag for the computed transient field.
    const results = objects.map((obj) => {
      (obj as unknown as { _similarity: number })._similarity =
        similarityMap.get(obj.id as string) || 0;
      return obj as ModelType & { _similarity: number };
    });

    results.sort((a, b) => b._similarity - a._similarity);

    return results;
  }

  /**
   * Generate missing embeddings for all objects in the collection
   *
   * Batch generates embeddings for objects that don't have them yet
   * or have stale embeddings.
   *
   * @param options - Generation options
   * @param options.batchSize - Number of objects to process at once (default: 50)
   * @param options.onProgress - Progress callback
   * @returns Promise resolving to generation statistics
   *
   * @example
   * ```typescript
   * const stats = await articles.generateMissingEmbeddings({
   *   batchSize: 100,
   *   onProgress: ({ completed, total }) => {
   *     console.log(`Progress: ${completed}/${total}`);
   *   }
   * });
   *
   * console.log(`Generated: ${stats.generated}, Skipped: ${stats.skipped}`);
   * ```
   */
  public async generateMissingEmbeddings(
    options: {
      batchSize?: number;
      onProgress?: (progress: { completed: number; total: number }) => void;
    } = {},
  ): Promise<{ generated: number; skipped: number }> {
    const { batchSize = 50, onProgress } = options;

    // Get embedding config
    const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(
      this._itemClass.name,
    );

    if (!embeddingConfig) {
      throw new Error(
        `No embedding configuration found for ${this._itemClass.name}.`,
      );
    }

    // Count total objects
    const total = await this.count({});
    let completed = 0;
    let generated = 0;
    let skipped = 0;

    // Process in batches
    let offset = 0;
    while (offset < total) {
      const batch = await this.list({ limit: batchSize, offset });

      for (const obj of batch) {
        try {
          // Check if embeddings are stale. `hasStaleEmbeddings` /
          // `generateEmbeddings` are runtime SmrtObject embedding methods not in
          // the static shape; view as such and call on the receiver (keeps
          // `this` bound).
          const embeddable = obj as unknown as {
            hasStaleEmbeddings(): Promise<boolean>;
            generateEmbeddings(): Promise<unknown>;
          };
          const hasStale = await embeddable.hasStaleEmbeddings();
          if (hasStale) {
            await embeddable.generateEmbeddings();
            generated++;
          } else {
            skipped++;
          }
        } catch (error) {
          logger.warn(`Failed to generate embeddings for ${obj.id}`, {
            error: error instanceof Error ? error.message : error,
          });
          skipped++;
        }

        completed++;
        if (onProgress) {
          onProgress({ completed, total });
        }
      }

      offset += batchSize;
    }

    return { generated, skipped };
  }
}
