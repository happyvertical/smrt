import { createLogger } from '@happyvertical/logger';
import { buildWhere } from '@happyvertical/sql';
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
import { EmbeddingProvider } from './embeddings/provider';
import { EmbeddingStorage } from './embeddings/storage';
import {
  createInterceptorContext,
  GlobalInterceptors,
  type ListOptions as InterceptorListOptions,
} from './interceptors';
import type { SmrtObject } from './object';
import { ObjectRegistry } from './registry';
import type { SmrtObjectConstructor } from './registry/types';
import { verifyPersistenceTable } from './schema/table-verifier';
import {
  classnameToTablename,
  fieldsFromClass,
  formatDataJs,
  toCamelCase,
  toSnakeCase,
} from './utils';
import { chunkArray, IN_LIST_CHUNK_SIZE } from './utils/chunk';

const logger = createLogger({ level: 'info' });

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
  where: T | undefined,
): T | undefined {
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
  /** Allow arbitrary additional fields for dynamic usage */
  [key: string]: unknown;
};

/**
 * WHERE clause type for `collection.list()`.
 *
 * Uses `Record<string, unknown>` because WHERE keys often include operator
 * suffixes (e.g., `'price >'`, `'name like'`, `'status in'`) which can't be
 * expressed as mapped types from model properties. Runtime validation in
 * `convertWhereKeys()` handles field and operator checking.
 */
export type SmrtWhereClause<T extends SmrtObject> = Record<string, unknown>;

/**
 * Minimal runtime shape of a field definition as consumed by the collection's
 * query/hydration helpers (`getFieldsSync()`, `convertWhereKeys()`,
 * `formatDataJs()`). These come from `fieldsFromClass()` /
 * `ObjectRegistry.getFields()` and only a few members are read here: `type`
 * (for `formatDataJs` value coercion) and the `sensitive` markers (for the
 * `@field({ sensitive: true })` WHERE guard, #1540). The index signature keeps
 * the bag open for the other registry-attached members without forcing `any`.
 */
interface CollectionFieldDefinition {
  type?: string;
  sensitive?: boolean;
  _meta?: { sensitive?: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Configuration options for SmrtCollection
 */
export interface SmrtCollectionOptions extends SmrtClassOptions {}

// S4 #1579: the constructor `options` and static `create(options)` params are
// left as `any` deliberately. This type is satisfied by every concrete model
// class (`static readonly _itemClass = Product`), whose constructor/`create`
// option bag is contravariant — narrowing to `SmrtCreateInput<ModelType>` or
// `unknown` rejects those assignments. Mirrors the `SmrtObjectConstructor`
// escape hatch in registry/types.
export type SmrtCollectionItemClass<ModelType extends SmrtObject> = (new (
  options: any,
) => ModelType) & {
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
    where: Record<string, unknown>,
  ): Record<string, unknown> {
    // Whitelist of allowed SQL operators
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
      'contains',
    ];

    // Get schema fields for validation (sync from cache)
    const fields = this.getFieldsSync();
    const validFieldNames = new Set(
      Object.keys(fields).map((f) => toSnakeCase(f)),
    );

    // Security (#1540): collect snake_case names of `@field({ sensitive: true })`
    // columns so they can't be used as `where` filter keys. Filtering on a
    // secret column turns the generated REST/MCP `where` surface into a value
    // oracle (e.g. `apiSecret[like]=sk-%`), exfiltrating the secret one
    // character at a time even though it's excluded from serialization.
    const sensitiveFieldNames = new Set<string>();
    const collectSensitive = (
      fieldMap: Record<string, unknown> | Map<string, unknown>,
    ) => {
      const entries =
        fieldMap instanceof Map ? fieldMap.entries() : Object.entries(fieldMap);
      for (const [fieldName, rawDef] of entries) {
        const def = rawDef as
          | { sensitive?: boolean; _meta?: { sensitive?: boolean } }
          | null
          | undefined;
        if (def && (def.sensitive === true || def._meta?.sensitive === true)) {
          // Store both the snake_case column form and the raw property name so
          // STI `@meta` fields probed via `_meta_data.<prop>` JSON paths (which
          // keep the camelCase key) are also rejected.
          sensitiveFieldNames.add(toSnakeCase(fieldName));
          sensitiveFieldNames.add(fieldName);
        }
      }
    };
    collectSensitive(fields);

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
        collectSensitive(ancestorFields);
      }

      // Security (#1540): a base collection serializes (and so must protect)
      // STI descendant fields too — a child's `@meta` sensitive field lives in
      // `_meta_data` and would otherwise be probe-able via `_meta_data.<prop>`
      // from the base collection. Mirror toJSON()/getSensitiveFieldNames().
      const stiBase = ObjectRegistry.getSTIBase(itemQualifiedName);
      if (stiBase) {
        for (const descendant of ObjectRegistry.getDescendants(stiBase)) {
          collectSensitive(ObjectRegistry.getFields(descendant));
        }
      }
    }

    // Issue #869: If no fields are registered (no manifest for test classes),
    // skip field validation. Invalid fields will fail at SQL level instead.
    // This commonly happens for inline test classes decorated with @smrt().
    const hasRegisteredFields = Object.keys(fields).length > 0;
    const skipFieldValidation = !hasRegisteredFields;

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

      // Support dot-notation for JSON path queries (e.g., 'metadata.userId')
      // Validate against the first segment (the column name), pass full path through
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
        throw new Error(
          `Invalid WHERE clause operator: '${operator}'. ` +
            `Valid operators: ${VALID_OPERATORS.join(', ')}`,
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
  static async create<T extends SmrtCollection<any>>(
    this: new (
      options?: SmrtCollectionOptions,
    ) => T,
    options: SmrtClassOptions = {},
  ): Promise<T> {
    // Extract only collection-compatible options from broader SmrtClassOptions
    const {
      _className,
      db,
      persistence, // Also extract persistence alias
      ai,
      fs,
      logging,
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
      fs,
      logging,
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
   * @param ids - Array of UUIDs to fetch
   * @returns Promise resolving to array of objects (order not guaranteed)
   *
   * @example
   * ```typescript
   * const profiles = await profileCollection.listByIds(['id1', 'id2', 'id3']);
   * ```
   */
  public async listByIds(ids: string[]): Promise<ModelType[]> {
    if (ids.length === 0) return [];
    return this.list({ where: { id: ids } });
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
   * raw rows; hydration and read interceptors still run on every call.
   */
  private async queryRowsWithCache(
    sql: string,
    params: unknown[],
    cacheConfig: CollectionCacheConfig | undefined,
  ): Promise<Record<string, unknown>[]> {
    if (!cacheConfig) {
      const result = await this.db.query(sql, ...params);
      return result.rows;
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
    const result = await this.db.query(sql, ...params);
    setCachedRows(
      dbKey,
      this.tableName,
      queryKey,
      result.rows,
      cacheConfig.ttl,
      generation,
    );
    return result.rows;
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

    let where =
      typeof interceptedFilter === 'string'
        ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            interceptedFilter,
          )
          ? { id: interceptedFilter }
          : { slug: interceptedFilter, context: '' }
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

    const fullSQL = `SELECT * FROM ${this.tableName} ${whereSql}`;
    const rows = await this.queryRowsWithCache(
      fullSQL,
      whereValues,
      this.resolveReadCacheConfig(options.cache),
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
   * ```
   *
   * @returns Promise resolving to an array of model instances
   */
  public async list(
    options: {
      where?: SmrtWhereClause<ModelType>;
      offset?: number;
      limit?: number;
      orderBy?: string | string[];
      /**
       * Relationships to eagerly load (avoids N+1 query problem)
       * @example
       * ```typescript
       * // Load orders with their customers pre-loaded
       * const orders = await orderCollection.list({
       *   include: ['customerId']
       * });
       * // Access customer without additional query
       * orders[0].getRelated('customerId');
       * ```
       */
      include?: string[];
      /**
       * Opt-in read-through cache for this call (issue #1498).
       *
       * Pass `{ ttl }` (milliseconds) to memoize the result rows keyed by
       * the final query shape. Mutations through SMRT invalidate the
       * table's entries automatically. Pass `false` to force a fresh read
       * when the model opted in via `@smrt({ cache })`. Defaults to the
       * model-level config; uncached when neither is set.
       *
       * @example
       * ```typescript
       * const published = await resumes.list({
       *   where: { status: 'published' },
       *   cache: { ttl: 60_000 },
       * });
       * ```
       */
      cache?: CollectionCacheConfig | false;
    } = {},
  ): Promise<ModelType[]> {
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

    let { where, offset, limit, orderBy } = interceptedOptions;

    // STI: Child collections should automatically filter by _meta_type.
    // R5-canon: qualified-key lookup so a same-simple-name class in
    // another package can't yield the wrong table strategy / STI base.
    const tableStrategy = ObjectRegistry.getTableStrategy(itemQualifiedName);
    const isSTI = tableStrategy === 'sti';

    if (isSTI) {
      const stiBase = ObjectRegistry.getSTIBase(itemQualifiedName);
      if (stiBase && stiBase !== itemQualifiedName) {
        where = {
          _meta_type: itemQualifiedName,
          ...(where || {}),
        };
      }
    }

    // Resolve _meta_type to qualified name if user provided simple class name (Issue #713)
    where = resolveMetaTypeInWhere(where);

    // convertWhereKeys is now sync (issue #663) - no await needed
    const convertedWhere = this.convertWhereKeys(where || {});
    const { sql: whereSql, values: whereValues } = buildWhere(convertedWhere);

    let orderBySql = '';
    if (orderBy) {
      orderBySql = ' ORDER BY ';
      const orderByItems = Array.isArray(orderBy) ? orderBy : [orderBy];

      orderBySql += orderByItems
        .map((item) => {
          const [field, direction = 'ASC'] = item.split(' ');

          // Validate field name
          if (!/^[a-zA-Z0-9_]+$/.test(field)) {
            throw new Error(`Invalid field name for ordering: ${field}`);
          }

          // Validate direction
          const normalizedDirection = direction.toUpperCase();
          if (normalizedDirection !== 'ASC' && normalizedDirection !== 'DESC') {
            throw new Error(
              `Invalid sort direction: ${direction}. Must be ASC or DESC.`,
            );
          }

          // Convert field name to snake_case
          const snakeField = toSnakeCase(field);
          return `${snakeField} ${normalizedDirection}`;
        })
        .join(', ');
    }

    let limitOffsetSql = '';
    const limitOffsetValues: (number | undefined)[] = [];
    let paramIndex = whereValues.length + 1;

    if (limit !== undefined) {
      limitOffsetSql += ` LIMIT $${paramIndex++}`;
      limitOffsetValues.push(limit);
    }

    if (offset !== undefined) {
      limitOffsetSql += ` OFFSET $${paramIndex++}`;
      limitOffsetValues.push(offset);
    }

    const sql = `SELECT * FROM ${this.tableName} ${whereSql} ${orderBySql} ${limitOffsetSql}`;
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
    );
    const fields = this.getFieldsSync();

    // STI: Hydrate instances polymorphically based on _meta_type
    // Reuse tableStrategy and isSTI from earlier in the function
    const instances = await Promise.all(
      rows.map((item) => this.hydrateResultRow(item, fields, isSTI)),
    );

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
  public async count(options: { where?: SmrtWhereClause<ModelType> } = {}) {
    await this.ensureStorageReady();
    const itemQualifiedName = this.getResolvedItemQualifiedName();
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

    let { where } = interceptedOptions;

    // Fix for issue #386: Add _meta_type filter for STI child collections.
    // R5-canon: qualified-key lookup throughout — pass `itemQualifiedName`
    // to both `getTableStrategy` and `getSTIBase` so a colliding
    // simple-name class in another package can't yield the wrong table
    // strategy / STI base.
    const tableStrategy = ObjectRegistry.getTableStrategy(itemQualifiedName);
    const isSTI = tableStrategy === 'sti';

    if (isSTI) {
      const stiBase = ObjectRegistry.getSTIBase(itemQualifiedName);
      if (stiBase && stiBase !== itemQualifiedName) {
        where = {
          _meta_type: itemQualifiedName,
          ...(where || {}),
        };
      }
    }

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

    return Number.parseInt(result.rows[0].count, 10);
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

    const result = await this.db.query(
      interceptedQuery.sql,
      ...interceptedQuery.params,
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

    const instances = await Promise.all(
      result.rows.map((row) => this.hydrateResultRow(row, fields, isSTI)),
    );

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
  ): Promise<ModelType> {
    const formattedData = this.withHydratedCoreFields(
      formatDataJs(row, fields),
    );

    const metaType = formattedData._meta_type;
    if (isSTI && metaType) {
      const polymorphicInstance = await this.createPolymorphic(
        typeof metaType === 'string' ? metaType : String(metaType),
        formattedData,
        { hydrateOnly: true },
      );
      // Hydrated from an existing row — save() must update by primary key
      // even if natural-key fields change (issue #1472).
      polymorphicInstance.markAsPersisted();
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
    await instance.initialize();

    if (isSTI) {
      const registeredClass = ObjectRegistry.getClass(this._itemClass.name);
      // Dynamic STI discriminator write — `_meta_type` is a runtime-only field
      // not in the static SmrtObject shape; view as a writable bag.
      (instance as unknown as { _meta_type?: string })._meta_type =
        registeredClass?.qualifiedName || this._itemClass.name;
    }

    // Hydrated from an existing row — save() must update by primary key
    // even if natural-key fields change (issue #1472).
    instance.markAsPersisted();
    return instance;
  }

  /**
   * Remember collection-level context
   *
   * Stores context applicable to all instances of this collection type.
   * Use for patterns that apply to the entire collection (e.g., default parsing strategies).
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
        owner_id: '__collection__',
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

    // Use single() with template literals for custom SQL query.
    // The query projects `value` (a JSON string) and `confidence`.
    let result: Record<string, unknown> | null;
    if (options.minConfidence !== undefined) {
      result = await this.systemDb.single`
        SELECT value, confidence
        FROM _smrt_contexts
        WHERE owner_class = ${this._itemClass.name}
          AND owner_id = ${'__collection__'}
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
          AND owner_id = ${'__collection__'}
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
    const params: unknown[] = [this._itemClass.name, '__collection__'];

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
      '__collection__',
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
    const params: unknown[] = [this._itemClass.name, '__collection__'];

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
   * @param query - Text to search for
   * @param options - Search options
   * @param options.field - Specific field to search (defaults to first embedding field)
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

    // Determine which field to search
    const searchField = field || embeddingConfig.fields[0];
    if (!embeddingConfig.fields.includes(searchField)) {
      throw new Error(
        `Field '${searchField}' is not configured for embeddings on ${this._itemClass.name}. ` +
          `Available fields: ${embeddingConfig.fields.join(', ')}`,
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
