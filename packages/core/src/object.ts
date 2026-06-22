// import type { AIMessageOptions } from '@happyvertical/ai';

import type { AITool } from '@happyvertical/ai';
import { createLogger } from '@happyvertical/logger';
import type { SmrtClassOptions } from './class';
import { SmrtClass } from './class';
import {
  broadcastCacheInvalidation,
  hasCrossProcessCacheInterest,
  invalidateCollectionCache,
  resolveDbCacheKey,
} from './collection-cache';
import { ContentHasher } from './embeddings/hash';
import { EmbeddingProvider } from './embeddings/provider';
import { EmbeddingStorage } from './embeddings/storage';
import type { GenerateEmbeddingsOptions } from './embeddings/types';
import {
  DatabaseError,
  ErrorUtils,
  RuntimeError,
  TenantIsolationError,
  ValidationError,
} from './errors';
import { createInterceptorContext, GlobalInterceptors } from './interceptors';
import { ObjectRegistry } from './registry';
import { verifyPersistenceTable } from './schema/table-verifier';
import {
  executeToolCall as executeToolCallInternal,
  type ToolCall,
  type ToolCallResult,
} from './tools/tool-executor';
import { fieldsFromClass, tableNameFromClass, toSnakeCase } from './utils';

// DEBUG_STI raises the level to 'debug' so the env-gated STI hydration traces
// below (logger.debug, inside `if (process.env.DEBUG_STI)` guards) actually emit;
// otherwise they're filtered at the default 'info' level.
const logger = createLogger({
  level: process.env.DEBUG_STI ? 'debug' : 'info',
});

/**
 * Default maximum number of characters of serialized object data injected into
 * the AI prompts built by `is()`, `do()`, and `describe()`.
 *
 * Acts as a coarse token-budget guard so a very large instance (e.g. a long
 * document body) cannot blow past model context limits or inflate request
 * costs. At roughly four characters per token this is ~25k tokens of object
 * data — generous enough for typical records, while still capping pathological
 * cases. Override per call with the `maxDataLength` option.
 */
const AI_PROMPT_DATA_MAX_LENGTH = 100_000;

/**
 * Validate that _meta_type matches the expected class (Issue #713)
 *
 * Accepts both simple class name (e.g., 'Product') and qualified name
 * (e.g., '@happyvertical/smrt-core:Product') for namespace isolation support.
 *
 * @param actualMetaType - The _meta_type value from the data
 * @param className - The class name to validate against
 * @returns true if the meta type is valid for this class
 */
function isValidMetaType(actualMetaType: unknown, className: string): boolean {
  if (typeof actualMetaType !== 'string') {
    return false;
  }

  // Accept simple class name match
  if (actualMetaType === className) {
    return true;
  }

  // Accept qualified name match (namespace isolation)
  const registeredClass = ObjectRegistry.getClass(className);
  if (
    registeredClass?.qualifiedName &&
    actualMetaType === registeredClass.qualifiedName
  ) {
    return true;
  }

  return false;
}

/**
 * Get the expected qualified or simple name for a class (for error messages)
 */
function getExpectedMetaType(className: string): string {
  const registeredClass = ObjectRegistry.getClass(className);
  return registeredClass?.qualifiedName || className;
}

/**
 * Get all STI hierarchy members (base + descendants) for a class.
 *
 * R5-canon (Copilot follow-up): callers should pass a QUALIFIED name
 * (e.g. via `this.getResolvedQualifiedName()`). Passing a bare simple
 * name still works in single-package scenarios, but when two packages
 * register classes sharing the same simple name, `ObjectRegistry.
 * getClass(simpleName)` resolves to whichever match the multi-strategy
 * lookup picks first — which can be the wrong package. Passing the
 * qualified form makes STI sibling discovery collision-safe.
 */
function getSTIHierarchyMembers(qualifiedOrSimpleName: string): string[] {
  // Best-effort qualify in case a caller passed a simple name; the
  // collision risk for that case is documented in the docstring above.
  const registered = ObjectRegistry.getClass(qualifiedOrSimpleName);
  const lookupKey =
    registered?.qualifiedName ?? registered?.name ?? qualifiedOrSimpleName;
  const stiBase = ObjectRegistry.getSTIBase(lookupKey);
  if (!stiBase) {
    return [];
  }

  return Array.from(
    new Set([stiBase, ...ObjectRegistry.getDescendants(stiBase)]),
  );
}

type PersistenceWritePlan =
  | { type: 'upsert'; conflictColumns: string[] }
  | { type: 'updateById'; qualifiedMetaType: string };

/**
 * Warn once per process if a consumer has SMRT_SKIP_STI_REHYDRATE set.
 * The env variable is a no-op since Release C (#1134); without this
 * diagnostic anyone who followed the Release A changeset note would
 * silently lose the behavior they opted into.
 */
let didWarnSkipRehydrate = false;
function warnIfSkipRehydrateSet(): void {
  if (didWarnSkipRehydrate) return;
  didWarnSkipRehydrate = true;
  if (process.env.SMRT_SKIP_STI_REHYDRATE !== undefined) {
    logger.warn(
      '[smrt] SMRT_SKIP_STI_REHYDRATE is set but has no effect since ' +
        'Release C (#1134). The flag is retired; unconditional STI ' +
        'descendant rehydration is the only behavior. Remove the env ' +
        'variable from your configuration. See issue #1139 for the perf ' +
        'follow-up.',
    );
  }
}

/**
 * Options for SmrtObject initialization
 */
export interface SmrtObjectOptions extends SmrtClassOptions {
  /**
   * Unique identifier for the object
   */
  id?: string;

  /**
   * URL-friendly identifier
   */
  slug?: string;

  /**
   * Optional context to scope the slug (could be a path, domain, etc.)
   */
  context?: string;

  /**
   * Creation timestamp
   */
  created_at?: Date;

  /**
   * Last update timestamp
   */
  updated_at?: Date;

  /**
   * Flag to skip automatic field extraction (internal use)
   */
  _extractingFields?: boolean;

  /**
   * Flag to skip database loading (internal use)
   */
  _skipLoad?: boolean;

  /**
   * Flag to skip save-time embedding auto-generation (internal use).
   *
   * This is used when framework code will generate embeddings explicitly after
   * saving and wants to avoid racing a duplicate background generation.
   */
  _skipAutoEmbeddings?: boolean;

  /**
   * Allow arbitrary field values to be passed
   */
  [key: string]: any;
}

/**
 * Options for the relationship loaders {@link SmrtObject.loadRelated},
 * {@link SmrtObject.loadRelatedMany}, and {@link SmrtObject.getRelated}.
 */
export interface LoadRelatedOptions {
  /**
   * Bypass the cross-tenant isolation guard.
   *
   * By default, resolving a relationship from a tenant-scoped object to an
   * object in a *different*, non-null tenant throws a `TenantIsolationError`.
   * Set this to `true` for deliberate cross-tenant flows (admin tooling,
   * migrations, super-admin bypass paths) where the access is intentional.
   *
   * @default false
   */
  allowCrossTenant?: boolean;
}

/**
 * Base class for all persistent SMRT domain objects.
 *
 * Provides a full ORM lifecycle: construct with options, call `initialize()`,
 * then use `save()` / `delete()` for persistence. Objects are identified by a
 * UUID `id` and an optional URL-friendly `slug` (auto-generated from `name`,
 * `title`, `label`, or `id` if not provided).
 *
 * Key capabilities:
 * - **Persistence**: `save()` (upsert with retry), `delete()` (with hooks)
 * - **Loading**: `loadFromId()`, `loadFromSlug()` (called automatically by `initialize()`)
 * - **AI operations**: `is()` (boolean criteria check), `do()` (freeform instruction)
 * - **Relationships**: `loadRelated()` (foreignKey), `loadRelatedMany()` (oneToMany)
 * - **Context memory**: `remember()` / `recall()` / `recallAll()` / `forget()` / `forgetScope()`
 * - **STI support**: `_meta_type` discriminator, `_meta_data` JSONB for child fields
 * - **Serialization**: `toJSON()` (framework-managed, handles STI), `transformJSON()` (override hook)
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   name: string = '';
 *   price: number = 0.0;
 * }
 *
 * const product = new Product({ db: myDb, name: 'Widget', price: 9.99 });
 * await product.initialize();
 * await product.save();
 * console.log(product.id); // auto-generated UUID
 * ```
 */
export class SmrtObject extends SmrtClass {
  /**
   * Database table name for this object
   */
  public _tableName!: string;

  /**
   * Cache for loaded relationships to avoid repeated database queries
   * Maps fieldName to loaded object(s)
   */
  private _loadedRelationships: Map<string, any> = new Map();

  /**
   * Whether this object is backed by an existing database row.
   *
   * Set when the object is hydrated from the database (collection
   * get/list/query, `loadFromId()`, `loadFromSlug()`) and after a successful
   * `save()`. `save()` uses it to target the primary key on upsert instead
   * of the natural-key conflict columns, so natural-key edits (e.g. renaming
   * a slug) update the existing row rather than colliding on `*_pkey`
   * (issue #1472).
   */
  private _persisted = false;

  /**
   * Override options with SmrtObjectOptions type for proper type narrowing.
   * Initialized by parent constructor via super() call.
   */
  public declare options: SmrtObjectOptions;

  /**
   * Unique identifier for the object
   */
  protected _id: string | null | undefined;

  /**
   * URL-friendly identifier
   */
  protected _slug: string | null | undefined;

  /**
   * Optional context to scope the slug
   */
  protected _context: string | null | undefined;

  /**
   * Creation timestamp
   */
  public created_at: Date | null | undefined = null;

  /**
   * Last update timestamp
   */
  public updated_at: Date | null | undefined = null;

  /**
   * Creates a new SmrtObject instance
   *
   * @param options - Configuration options including identifiers and metadata
   * @throws Error if options is null
   */
  constructor(options: SmrtObjectOptions = {}) {
    super(options);
    // Explicitly set child's options property after parent initialization
    // This is required because the override declaration creates a new property slot
    this.options = options;
    if (options === null) {
      throw new Error('options cant be null');
    }
    this._id = options.id || null;
    this._slug = options.slug || null;
    this._context = options.context || '';

    // Auto-register the class if it's not already registered
    // and it's not the base SmrtObject class itself
    // Skip registration during field extraction to avoid infinite recursion
    if (
      this.constructor !== SmrtObject &&
      !ObjectRegistry.getClassByConstructor(
        this.constructor as typeof SmrtObject,
      ) &&
      !(options as any)?._skipRegistration
    ) {
      ObjectRegistry.register(this.constructor as typeof SmrtObject, {});
    }
  }

  private getRegisteredClassInfo() {
    return ObjectRegistry.getClassByConstructor(
      this.constructor as typeof SmrtObject,
    );
  }

  protected getResolvedClassName(): string {
    return this.getRegisteredClassInfo()?.name || this.constructor.name;
  }

  protected getResolvedQualifiedName(): string {
    const registered = this.getRegisteredClassInfo();
    return (
      registered?.qualifiedName || registered?.name || this.constructor.name
    );
  }

  private getCurrentMetaType(): string | undefined {
    const metaType = (this as any)._meta_type;
    return typeof metaType === 'string' ? metaType : undefined;
  }

  private isLegacySTIDiscriminatorUpgrade(
    currentMetaType: string | undefined,
    nextMetaType: unknown,
    className: string,
  ): currentMetaType is string {
    return (
      typeof nextMetaType === 'string' &&
      typeof currentMetaType === 'string' &&
      currentMetaType !== nextMetaType &&
      !currentMetaType.includes(':') &&
      isValidMetaType(currentMetaType, className) &&
      isValidMetaType(nextMetaType, className)
    );
  }

  private async planPersistenceWrite(
    className: string,
    tableStrategy: string,
    data: Record<string, any>,
    conflictColumns: string[],
  ): Promise<PersistenceWritePlan> {
    const upsertPlan: PersistenceWritePlan = {
      type: 'upsert',
      conflictColumns,
    };

    if (tableStrategy !== 'sti' || !data.id) {
      return upsertPlan;
    }

    const currentMetaType = this.getCurrentMetaType();
    const nextMetaType = data._meta_type;
    if (
      !this.isLegacySTIDiscriminatorUpgrade(
        currentMetaType,
        nextMetaType,
        className,
      )
    ) {
      return upsertPlan;
    }
    const qualifiedMetaType = String(nextMetaType);
    const conflictIdentity: Record<string, any> = {};
    for (const column of conflictColumns.filter(
      (conflictColumn) => conflictColumn !== '_meta_type',
    )) {
      if (!Object.hasOwn(data, column)) {
        return upsertPlan;
      }
      conflictIdentity[column] = data[column];
    }

    const id = String(data.id);
    const existingById = await ErrorUtils.withRetry(
      async () => {
        try {
          return await this.db.get(this.tableName, { id });
        } catch (error) {
          throw DatabaseError.queryFailed(
            `get(${this.tableName}, legacy STI id)`,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
      3,
      500,
    );

    if (!existingById || existingById._meta_type !== currentMetaType) {
      return upsertPlan;
    }

    const slug = String(data.slug ?? '');
    const context = String(data.context ?? '');
    const existingQualified = await ErrorUtils.withRetry(
      async () => {
        try {
          return await this.db.get(this.tableName, {
            ...conflictIdentity,
            _meta_type: qualifiedMetaType,
          });
        } catch (error) {
          throw DatabaseError.queryFailed(
            `get(${this.tableName}, qualified STI conflict identity)`,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
      3,
      500,
    );

    if (existingQualified && existingQualified.id !== id) {
      throw DatabaseError.stiDiscriminatorConflict({
        className,
        tableName: this.tableName,
        id,
        slug,
        context,
        conflictIdentity,
        legacyMetaType: currentMetaType,
        qualifiedMetaType,
        duplicateId: String(existingQualified.id),
      });
    }

    // This mirrors save()'s current last-writer-wins behavior: the probe and
    // update are not transactional, so concurrent saves may both choose this.
    return { type: 'updateById', qualifiedMetaType };
  }

  /**
   * Protected setter for ID to maintain type safety
   * Used internally by collection.create() and other framework code
   * @internal
   */
  protected setId(id: string): void {
    this._id = id;
  }

  /**
   * Whether this object is backed by an existing database row.
   *
   * True after hydration from the database (collection get/list/query,
   * `loadFromId()`, `loadFromSlug()`) or after a successful `save()`.
   */
  public get isPersisted(): boolean {
    return this._persisted;
  }

  /**
   * Marks this object as backed by an existing database row, so `save()`
   * targets the primary key instead of the natural-key conflict columns.
   * Called by framework hydration paths (issue #1472).
   * @internal
   */
  public markAsPersisted(): void {
    this._persisted = true;
  }

  protected async verifyStorageReady(): Promise<void> {
    await verifyPersistenceTable(
      this.db,
      this.tableName,
      this.constructor.name,
    );
  }

  /**
   * Protected setter for STI discriminator to maintain type safety
   * Used internally for Single Table Inheritance support
   * @internal
   */
  protected setMetaType(metaType: string): void {
    (this as any)._meta_type = metaType;
  }

  /**
   * Smart clone helper to avoid array/object aliasing (Issue #22)
   *
   * Clones values to prevent shared references between options and instance properties:
   * - Primitives (string, number, boolean, null, undefined): No clone needed
   * - Dates: No clone needed (immutable)
   * - Field instances: No clone needed (framework objects)
   * - Arrays: Shallow clone
   * - Plain objects: Shallow clone
   * - Other objects: Pass through (class instances, etc.)
   *
   * @param value - Value to clone
   * @returns Cloned value or original if no cloning needed
   * @private
   */
  private cloneValue(value: any): any {
    // Primitives and null/undefined - no clone needed
    if (value === null || value === undefined) return value;
    if (typeof value !== 'object') return value;

    // Dates - immutable, no clone needed
    if (value instanceof Date) return value;

    // Arrays - shallow clone to avoid aliasing
    if (Array.isArray(value)) return [...value];

    // Plain objects - shallow clone to avoid aliasing
    // Check if it's a plain object (created via {} or Object.create(null))
    const proto = Object.getPrototypeOf(value);
    if (proto === null || proto === Object.prototype) {
      return { ...value };
    }

    // Other objects (class instances, etc.) - pass through
    return value;
  }

  /**
   * Initialize properties from options after field initializers have run
   * This ensures option values take precedence over default field initializer values
   * Uses smart cloning to prevent array/object aliasing (Issue #22)
   */
  private async initializePropertiesFromOptions(): Promise<void> {
    const options = this.options;

    // Set base properties that exist on SmrtObject
    if (options.created_at !== undefined) this.created_at = options.created_at;
    if (options.updated_at !== undefined) this.updated_at = options.updated_at;

    // Set STI discriminator if present
    if (options._meta_type !== undefined) {
      this.setMetaType(options._meta_type);
    }

    // Get all fields (both Field instances and plain properties)
    const fields = await fieldsFromClass(
      this.constructor as new (
        ...args: any[]
      ) => any,
    );

    // Apply option values to all fields
    for (const [key, field] of Object.entries(fields)) {
      if (options[key] !== undefined) {
        // Clone value to avoid aliasing (Issue #22)
        const clonedValue = this.cloneValue(options[key]);

        // Check if property is writable before setting (Issue #61)
        // Get descriptor from instance or entire prototype chain
        let descriptor = Object.getOwnPropertyDescriptor(this, key);
        if (!descriptor) {
          let proto = Object.getPrototypeOf(this);
          while (proto && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(proto, key);
            proto = Object.getPrototypeOf(proto);
          }
        }

        // Only set if property has a setter or is writable
        // Skip readonly properties (e.g., tableName getter without setter)
        if (!descriptor || descriptor.set || descriptor.writable === true) {
          // Set the property value
          this[key as keyof this] = clonedValue;
        }
      }
    }
  }

  /**
   * Gets the unique identifier for this object
   */
  get id(): string | null | undefined {
    return this._id;
  }

  /**
   * Sets the unique identifier for this object
   *
   * @param value - The ID to set
   * @throws Error if the value is invalid
   */
  set id(value: string | null | undefined) {
    if (!value || value === 'undefined' || value === 'null') {
      throw new Error(`id is required, ${value} given`);
    }
    this._id = value;
  }

  /**
   * Gets the URL-friendly slug for this object
   */
  get slug(): string | null | undefined {
    return this._slug;
  }

  /**
   * Sets the URL-friendly slug for this object
   *
   * @param value - The slug to set
   * @throws Error if the value is invalid
   */
  set slug(value: string | null | undefined) {
    if (!value || value === 'undefined' || value === 'null') {
      throw new Error(`slug is invalid, ${value} given`);
    }

    this._slug = value;
  }

  /**
   * Gets the context that scopes this object's slug
   */
  get context(): string {
    return this._context || '';
  }

  /**
   * Sets the context that scopes this object's slug
   *
   * @param value - The context to set
   * @throws Error if the value is invalid
   */
  set context(value: string | null | undefined) {
    if (value !== '' && !value) {
      throw new Error(`context is invalid, ${value} given`);
    }
    this._context = value;
  }

  /**
   * Initializes this object and optionally loads its data from the database.
   *
   * Initialization order:
   * 1. Runs TypeScript field initializers (class property defaults)
   * 2. Applies `options` values on top of defaults (options win)
   * 3. If `options.id` is set, calls `loadFromId()` to hydrate from DB
   * 4. If `options.slug` is set (and no id), calls `loadFromSlug()` instead
   *
   * Runtime schema verification is deferred until the first actual DB
   * operation, which keeps initialization safe for SSR and prerendering
   * without mutating application schema.
   *
   * Called automatically by collection methods. Call manually only when
   * constructing objects outside of a collection.
   *
   * @returns This instance, ready to use (enables chaining)
   *
   * @example
   * ```typescript
   * const product = new Product({ db: myDb, id: 'existing-uuid' });
   * await product.initialize(); // loads product data from DB
   * console.log(product.name);
   * ```
   */
  public async initialize(): Promise<this> {
    await super.initialize();

    // Initialize properties from options AFTER all field initializers have run
    // This prevents TypeScript field initializers from overwriting option values
    // This must run for all classes (decorator-based or not) unless explicitly skipped
    if (!this.options._extractingFields) {
      await this.initializePropertiesFromOptions();
    }

    // Defer schema verification until an operation actually touches the
    // backing table. That keeps construction lightweight without hiding schema
    // mutation inside normal runtime flows.

    if (this._id && !(this.options as any)._skipLoad) {
      await this.loadFromId();
    } else if (this._slug && !(this.options as any)._skipLoad) {
      await this.loadFromSlug();
    }

    return this;
  }

  /**
   * Determines if this class needs automatic property initialization from options
   *
   * Decorator-based classes handle property assignment in their constructor,
   * so they don't need the automatic property initialization logic.
   * This optimization avoids redundant work and Field instance handling.
   *
   * @returns True if property initialization is needed, false otherwise
   * @private
   */
  private needsPropertyInitialization(): boolean {
    const className = this.getResolvedClassName();

    // Check if this class has decorator metadata in the registry
    // If it does, it's using decorators and handles its own initialization
    if (ObjectRegistry.hasClass(className)) {
      const hasDecorators = ObjectRegistry.hasFieldDecorators(className);
      if (hasDecorators) {
        // Class uses decorators - properties are set in constructor
        return false;
      }
    }

    // Default: assume it needs property initialization (field helpers pattern)
    return true;
  }

  /**
   * Loads data from a database row into this object's properties
   *
   * STI Support: If using Single Table Inheritance (tableStrategy: 'sti'):
   * - Merges _meta_data JSONB fields into the main data object
   * - Validates _meta_type discriminator matches class name
   *
   * @param data - Database row data (with snake_case column names)
   * @throws Error if STI validation fails
   */
  async loadDataFromDb(data: any) {
    const className = this.getResolvedClassName();

    if (process.env.DEBUG_STI) {
      logger.debug('[loadDataFromDb] Loading', {
        class: className,
        dataKeys: Object.keys(data),
        metaType: data._meta_type,
      });
    }

    // Get field definitions to pass to formatDataJs
    const fields = await this.getFields();

    if (process.env.DEBUG_STI) {
      logger.debug('[loadDataFromDb] Field definitions', {
        class: className,
        fieldKeys: Object.keys(fields),
      });
    }

    // Format data: Convert snake_case column names to camelCase property names
    // and convert date strings to Date objects (Issue #339)
    const { formatDataJs } = await import('./utils.js');
    const formattedData = formatDataJs(data, fields);

    // Check if this class uses STI (Single Table Inheritance).
    // R5-canon: pass the qualified name so a colliding simple name in
    // another package can't yield the wrong tableStrategy here.
    const tableStrategy = ObjectRegistry.getTableStrategy(
      this.getResolvedQualifiedName(),
    );
    const isSTI = tableStrategy === 'sti';

    if (process.env.DEBUG_STI) {
      logger.debug('[loadDataFromDb] After formatDataJs', {
        class: className,
        isSTI,
        formattedDataKeys: Object.keys(formattedData),
      });
    }

    // STI: Fail-fast validation for _meta_type discriminator
    if (isSTI) {
      // Validation 1: _meta_type must be present in database row
      if (!formattedData._meta_type) {
        throw new Error(
          `STI validation failed: Missing _meta_type discriminator in database row for ${className}. ` +
            `Ensure the row was saved with STI support enabled.`,
        );
      }

      // Validation 2: _meta_type must match the class being instantiated
      // Accept both simple class name and qualified name (namespace isolation - Issue #713)
      if (!isValidMetaType(formattedData._meta_type, className)) {
        throw new Error(
          `STI validation failed: Type mismatch when loading ${className}. ` +
            `Database row has _meta_type='${formattedData._meta_type}' but expected '${getExpectedMetaType(className)}'. ` +
            `This usually means you're trying to load a row with the wrong class.`,
        );
      }

      // Set _meta_type on the object
      this.setMetaType(formattedData._meta_type);
    }

    // STI: Meta fields are already merged by formatDataJs
    // No additional processing needed

    if (process.env.DEBUG_STI) {
      logger.debug('[loadDataFromDb] Starting field hydration', {
        class: className,
        fieldCount: Object.keys(fields).length,
      });
    }

    let hydratedCount = 0;
    let skippedCount = 0;

    for (const field in fields) {
      if (Object.hasOwn(fields, field)) {
        // Check if property is writable before setting (Issue #63)
        // Get descriptor from instance or entire prototype chain
        let descriptor = Object.getOwnPropertyDescriptor(this, field);
        if (!descriptor) {
          let proto = Object.getPrototypeOf(this);
          while (proto && !descriptor) {
            descriptor = Object.getOwnPropertyDescriptor(proto, field);
            proto = Object.getPrototypeOf(proto);
          }
        }

        // Only set if property has a setter or is writable
        // Skip readonly properties (e.g., tableName getter without setter)
        if (!descriptor || descriptor.set || descriptor.writable === true) {
          // Use formatted data (camelCase) instead of raw data (snake_case)
          // formatDataJs() already handles type conversions (dates, booleans, etc.)
          const value = formattedData[field];

          if (process.env.DEBUG_STI && value !== undefined) {
            logger.debug(`[loadDataFromDb] Setting field '${field}'`, {
              value,
              valueType: typeof value,
            });
          }

          this[field as keyof this] = value;
          hydratedCount++;
        } else {
          skippedCount++;
          if (process.env.DEBUG_STI) {
            logger.debug(`[loadDataFromDb] Skipping readonly field '${field}'`);
          }
        }
      }
    }

    if (process.env.DEBUG_STI) {
      logger.debug('[loadDataFromDb] Hydration complete', {
        class: className,
        hydratedCount,
        skippedCount,
        totalFields: Object.keys(fields).length,
      });
    }

    // The data came from an existing row, so subsequent saves must update
    // that row by primary key even if natural-key fields change (issue #1472).
    this._persisted = true;
  }

  /**
   * Gets the database table name for this object
   */
  get tableName() {
    if (!this._tableName) {
      // For STI, use the base class's table name from schema (manifest-derived).
      // R5-canon: use the qualified name as the lookup key so a colliding
      // simple name in another package can't yield the wrong tableStrategy
      // / STI base and route every query through the wrong table.
      const className = this.getResolvedClassName();
      const qualifiedName = this.getResolvedQualifiedName();
      const tableStrategy = ObjectRegistry.getTableStrategy(qualifiedName);

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
            this._tableName =
              ownSchema?.tableName || tableNameFromClass(this.constructor);
          }
        } else {
          // Fallback to own schema tableName
          const ownSchema = ObjectRegistry.getSchema(className);
          this._tableName =
            ownSchema?.tableName || tableNameFromClass(this.constructor);
        }
      } else {
        // CTI: Use own schema tableName
        const ownSchema = ObjectRegistry.getSchema(className);
        this._tableName =
          ownSchema?.tableName || tableNameFromClass(this.constructor);
      }
    }
    return this._tableName;
  }

  /**
   * Gets field definitions and current values for this object
   *
   * @returns Object containing field definitions with current values
   */
  async getFields() {
    const className = this.getResolvedClassName();
    const cachedFields = await ObjectRegistry.getAllFields(className);
    const fields: Record<string, any> = {};

    for (const [key, field] of cachedFields.entries()) {
      const meta = { ...(field._meta || {}) };
      delete meta.__smrtSystemField;

      fields[key] = {
        name: key,
        type: field.type || 'TEXT',
        _meta: meta,
      };
    }

    // Add current instance values to the fields
    // Use getPropertyValue to unwrap Field instances
    for (const key in fields) {
      fields[key].value = this.getPropertyValue(key);
    }

    return fields;
  }

  /**
   * Override hook for customizing JSON serialization output.
   *
   * This is the **only safe way** to customize serialization. Do **not** override
   * `toJSON()` directly — it manages STI discriminator assignment (`_meta_type`),
   * meta-field extraction into `_meta_data`, and manifest-driven field enumeration.
   * Overriding it will silently break STI persistence.
   *
   * The `data` argument already contains all persisted fields. Return a new object
   * (spread `data` and add/modify/remove keys) to change what is serialized.
   * Non-persisted computed properties added here are excluded from `save()` because
   * the DB write path uses `toJSON()` output, not this hook's additions — unless
   * those keys also correspond to real schema columns.
   *
   * @param data - Fully serialized object produced by the framework's `toJSON()` logic
   * @returns Transformed data to use as the final serialization result
   *
   * @example
   * ```typescript
   * class Article extends SmrtObject {
   *   body: string = '';
   *
   *   protected transformJSON(data: any): any {
   *     return {
   *       ...data,
   *       wordCount: this.body.split(/\s+/).length,
   *       preview: this.body.substring(0, 100),
   *     };
   *   }
   * }
   * ```
   *
   * @see {@link toJSON} for the framework implementation (do not override)
   */
  protected transformJSON(data: any): any {
    return data; // Default: no transformation
  }

  /**
   * Custom JSON serialization
   * Returns a plain object with all field values for proper JSON.stringify() behavior
   * Field instances automatically call their toJSON() method during serialization
   *
   * Issue #205: Filters out undefined values to prevent database errors
   *
   * Note: This method cannot be async because JSON.stringify() expects synchronous toJSON()
   * It uses direct property access instead of getFields() to avoid async issues
   *
   * STI Support: If using Single Table Inheritance (tableStrategy: 'sti'):
   * - Sets _meta_type discriminator to class name
   * - Extracts meta fields to _meta_data JSONB column
   *
   * **Customization:** Override `transformJSON()` instead of this method.
   * See transformJSON() documentation for safe customization patterns.
   */
  toJSON() {
    const className = this.getResolvedClassName();
    const data: any = {
      id: this.id,
      slug: this.slug,
      context: this.context,
      created_at: this.created_at,
      updated_at: this.updated_at,
    };

    // Check if this class uses STI (Single Table Inheritance)
    // R5-canon: qualified-key lookup so a colliding simple name in
    // another package can't yield the wrong STI strategy here.
    const tableStrategy = ObjectRegistry.getTableStrategy(
      this.getResolvedQualifiedName(),
    );
    const isSTI = tableStrategy === 'sti';

    // If STI, add discriminator and prepare meta_data container
    if (isSTI) {
      // Use qualified name for STI discriminator (namespace isolation)
      // The qualified name uses the child class's own package, not the parent's
      // This supports multi-package inheritance hierarchies (Issue #713)
      data._meta_type = this.getResolvedQualifiedName();
      data._meta_data = {};
    }

    // Get registered field definitions (synchronous access to already-loaded metadata)
    // For inheritance hierarchies, use cached inherited fields if available (populated by getAllFields())
    // This ensures multi-level STI classes serialize all parent fields correctly (Issue #332)
    const registered = ObjectRegistry.getClass(className);
    let registeredFields =
      registered?.inheritedFields || ObjectRegistry.getFields(className);

    // In STI mode, we need to know about ALL sibling class fields to provide default values
    // for fields that exist in siblings but not in this class (Issue #391).
    // R5-canon (Copilot follow-up): pass the qualified name so STI
    // sibling discovery is collision-safe across packages.
    if (isSTI) {
      const descendants = getSTIHierarchyMembers(
        this.getResolvedQualifiedName(),
      );
      if (descendants.length > 0) {
        const allSTIFields = new Map(registeredFields);

        // Merge fields from all sibling classes
        for (const descendant of descendants) {
          const descendantFields =
            ObjectRegistry.getClass(descendant)?.inheritedFields ||
            ObjectRegistry.getFields(descendant);
          for (const [key, value] of descendantFields) {
            if (!allSTIFields.has(key)) {
              allSTIFields.set(key, value);
            }
          }
        }

        registeredFields = allSTIFields;
      }
    }

    // Use manifest fields exclusively (manifest-first architecture)
    // All schema fields are in the manifest from AST scanning
    // Dynamic properties added at runtime are intentionally excluded (not part of schema)
    for (const key of registeredFields.keys()) {
      // Skip private properties, methods, and already-handled core fields
      if (
        key.startsWith('_') ||
        key === 'id' ||
        key === 'slug' ||
        key === 'context' ||
        key === 'created_at' ||
        key === 'updated_at' ||
        key === 'options' || // Skip options object (not a database column)
        typeof (this as any)[key] === 'function'
      ) {
        continue;
      }

      // Get field definition (used for transient check and type checking)
      const fieldDef = registeredFields.get(key);

      // Skip transient fields (non-persisted fields like functions, computed properties)
      // NOTE: This filtering logic must match SchemaGenerator.generateColumns()
      // Changes to field filtering should be applied in BOTH places
      if (fieldDef && (fieldDef.transient || fieldDef._meta?.transient)) {
        continue;
      }

      // Skip relationship fields that don't create columns
      // oneToMany and manyToMany are relationship metadata, not actual database columns
      // NOTE: This must match the filtering in SchemaGenerator.generateColumns()
      if (
        fieldDef &&
        (fieldDef.type === 'oneToMany' || fieldDef.type === 'manyToMany')
      ) {
        continue;
      }

      const prop = (this as any)[key];
      const value = this.getPropertyValue(key);

      // Handle undefined values (Issue #205, #391)
      // In STI, a child class may not have a property defined on a sibling class.
      // This logic ensures undefined properties are serialized correctly based on their type.
      if (value === undefined) {
        // Get field type from either the property instance (field helper) or the manifest
        const fieldType =
          (prop && typeof prop === 'object' && 'type' in prop && prop.type) ||
          fieldDef?.type;

        if (fieldType === 'text') {
          // Don't convert tenant ID fields to empty string (Issue #841)
          // Tenant fields should remain null/undefined for interceptor to auto-populate.
          // Check both the property instance and field definition for __tenancy marker.
          // Note: __tenancy can be at fieldDef.__tenancy (from @tenantId decorator) or
          // fieldDef._meta.__tenancy (from @smrt({ tenantScoped: true }))
          const hasTenancyMarker =
            (prop &&
              typeof prop === 'object' &&
              '__tenancy' in prop &&
              (prop as any).__tenancy?.isTenantIdField) ||
            (fieldDef as any)?.__tenancy?.isTenantIdField ||
            (fieldDef as any)?._meta?.__tenancy?.isTenantIdField;

          if (hasTenancyMarker) {
            // Leave tenant field as null so interceptor can auto-populate
            if (isSTI && fieldDef?.type === 'meta') {
              data._meta_data[key] = null;
            } else {
              data[key] = null;
            }
          } else {
            // For regular TEXT fields, convert undefined to an empty string.
            if (isSTI && fieldDef?.type === 'meta') {
              data._meta_data[key] = '';
            } else {
              data[key] = '';
            }
          }
        } else if (fieldType === 'json') {
          // For JSON fields, use the default value from manifest to prevent:
          // 1. Invalid JSON casting errors in DuckDB (empty string "")
          // 2. Runtime errors when code expects arrays/objects (null)
          const defaultValue = fieldDef?.default ?? null;

          if (isSTI && fieldDef?.type === 'meta') {
            data._meta_data[key] = defaultValue;
          } else {
            data[key] = defaultValue;
          }
        }

        // For all cases of 'undefined' (handled or not), we continue to the next field.
        // This prevents the undefined value from being assigned to the data object below,
        // allowing the database to use its default value for unhandled types.
        continue;
      }

      // STI: Separate meta fields from regular fields
      if (isSTI && fieldDef && fieldDef.type === 'meta') {
        // Meta fields go into _meta_data JSONB column
        data._meta_data[key] = value;
      } else {
        // Regular fields become table columns
        data[key] = value;
      }
    }

    // Call transformation hook to allow safe customization
    // This enables subclasses to add/modify fields without overriding toJSON()
    return this.transformJSON(data);
  }

  /**
   * Converts this object to a plain JavaScript object (POJO)
   *
   * Unlike toJSON() which returns an object that can still be a class instance,
   * this method returns a true plain object suitable for:
   * - SvelteKit's load function returns (requires serializable data)
   * - Passing data through web workers
   * - Any context requiring non-class objects
   *
   * @returns Plain JavaScript object with all field values
   *
   * @example
   * ```typescript
   * // In a SvelteKit +page.server.ts load function:
   * const users = await userCollection.list();
   * return {
   *   users: users.map(u => u.toPlainObject())
   * };
   * ```
   */
  toPlainObject(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this));
  }

  /**
   * Collects the property names of fields marked `@field({ sensitive: true })`
   * for this instance's class (and, under STI, every member of its hierarchy,
   * since `toJSON()` merges sibling fields into the serialized payload).
   *
   * Reads both the first-class `sensitive` flag and the `_meta.sensitive`
   * mirror so it works regardless of whether the field metadata came from the
   * AST manifest or a runtime `@field()` decorator registration.
   */
  private getSensitiveFieldNames(): Set<string> {
    const className = this.getResolvedClassName();
    const registered = ObjectRegistry.getClass(className);
    const fieldMaps: Map<string, any>[] = [
      registered?.inheritedFields || ObjectRegistry.getFields(className),
    ];

    const tableStrategy = ObjectRegistry.getTableStrategy(
      this.getResolvedQualifiedName(),
    );
    if (tableStrategy === 'sti') {
      const descendants = getSTIHierarchyMembers(
        this.getResolvedQualifiedName(),
      );
      for (const descendant of descendants) {
        fieldMaps.push(
          ObjectRegistry.getClass(descendant)?.inheritedFields ||
            ObjectRegistry.getFields(descendant),
        );
      }
    }

    const sensitive = new Set<string>();
    for (const fields of fieldMaps) {
      for (const [key, def] of fields) {
        if (def && (def.sensitive === true || def._meta?.sensitive === true)) {
          sensitive.add(key);
        }
      }
    }
    return sensitive;
  }

  /**
   * Public-safe serialization for network surfaces.
   *
   * Returns the same shape as `toJSON()` but with every `sensitive` field
   * removed (including STI meta fields nested under `_meta_data`). This is the
   * serializer used by the generated REST / MCP / SvelteKit routes so that
   * secret columns (API secrets, credentials, tax IDs) are never returned over
   * the wire, while `toJSON()` continues to carry them for database persistence.
   *
   * @returns A plain object safe to send to API consumers.
   */
  toPublicJSON(): Record<string, unknown> {
    const json = this.toJSON() as Record<string, unknown>;
    const sensitiveFields = this.getSensitiveFieldNames();
    if (sensitiveFields.size === 0) {
      return json;
    }

    const metaData =
      json._meta_data && typeof json._meta_data === 'object'
        ? (json._meta_data as Record<string, unknown>)
        : null;

    for (const name of sensitiveFields) {
      delete json[name];
      if (metaData) {
        delete metaData[name];
      }
    }
    return json;
  }

  /**
   * Gets or generates a unique ID for this object
   *
   * @returns Promise resolving to the object's ID
   */
  async getId() {
    if (this.slug) {
      await this.verifyStorageReady();

      // lookup by slug and context using adapter method
      const saved = await this.db.get(this.tableName, {
        slug: this.slug,
        context: this.context,
      });
      if (saved) {
        this.id = saved.id;
      }
    }

    if (!this.id) {
      this.id = crypto.randomUUID();
    }
    return this.id;
  }

  /**
   * Returns the slug for this object, generating one if not already set.
   *
   * Generation falls back through the following fields in order:
   * `name` → `title` → `label` → `id`
   *
   * The generated slug is lowercased, with non-alphanumeric characters
   * replaced by hyphens and leading/trailing hyphens stripped.
   *
   * Called automatically by `save()` when no slug is present.
   *
   * @returns The existing slug or a newly generated one (may be `null` if
   *   none of the fallback fields and `id` are set)
   *
   * @example
   * ```typescript
   * const product = new Product({ name: 'My Widget' });
   * console.log(await product.getSlug()); // 'my-widget'
   * ```
   */
  async getSlug() {
    if (!this.slug) {
      // Try multiple fallback fields in order: name, title, label, id
      let sourceField = null;

      if ((this as any).name) {
        sourceField = String((this as any).name);
      } else if ((this as any).title) {
        sourceField = String((this as any).title);
      } else if ((this as any).label) {
        sourceField = String((this as any).label);
      } else if (this.id) {
        // Final fallback: use ID
        sourceField = String(this.id);
      }

      if (sourceField) {
        // Generate slug from source field
        this.slug = sourceField
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/(^-|-$)/g, '');
      }
    }

    // check for existing slug and make unique?
    return this.slug;
  }

  /**
   * Gets the ID of this object if it's already saved in the database
   *
   * @returns Promise resolving to the saved ID or null if not saved
   */
  async getSavedId() {
    if (!this.id && !this.slug) {
      return null;
    }

    await this.verifyStorageReady();

    // Try to find by id first
    if (this.id) {
      const byId = await this.db.get(this.tableName, { id: this.id });
      if (byId) return byId.id;
    }

    // Fall back to finding by slug
    if (this.slug) {
      const bySlug = await this.db.get(this.tableName, { slug: this.slug });
      if (bySlug) return bySlug.id;
    }

    return null;
  }

  /**
   * Checks if this object is already saved in the database
   *
   * @returns Promise resolving to true if saved, false otherwise
   */
  async isSaved() {
    const saved = await this.getSavedId();
    return !!saved;
  }

  /**
   * Resolve the set of snake_case column names whose database type is `UUID`
   * for the table this object writes to.
   *
   * Declared foreign keys (`@foreignKey()`) and cross-package references
   * (`@crossPackageRef()`) generate native `UUID` columns (R11). Their default
   * declared value in TypeScript is the empty string (`''`), which is not a
   * valid UUID literal. Postgres rejects `''` on a `uuid` column with
   * `invalid input syntax for type uuid`, so any optional/unset declared FK
   * (a root entity's self-reference, an optional cross-package link, etc.)
   * would fail to insert. We coerce `''` → `NULL` for these columns before
   * binding (see {@link coerceEmptyUuidValuesToNull}); this method tells that
   * coercion which columns are UUID-typed.
   *
   * Resolution prefers the built schema (`getSchema().columns`), which already
   * reflects all reconciliation — e.g. a `@foreignKey()` whose target class
   * uses `idType: 'text'` is downgraded to `TEXT` and is therefore correctly
   * excluded here. For STI children, columns live on the STI base table, so we
   * union the base schema's columns. When no built schema is available (pure
   * runtime-registered classes without a manifest) we fall back to field
   * metadata, mirroring the schema-builder's field→SQL mapping.
   */
  private async resolveUuidColumnNames(
    className: string,
  ): Promise<Set<string>> {
    const uuidColumns = new Set<string>();

    const collectFromSchema = (schemaName: string | null | undefined): void => {
      if (!schemaName) return;
      const schema = ObjectRegistry.getSchema(schemaName);
      const columns = schema?.columns;
      if (!columns) return;
      for (const [columnName, columnDef] of Object.entries(columns)) {
        if ((columnDef as { type?: string })?.type === 'UUID') {
          uuidColumns.add(columnName);
        }
      }
    };

    // Own schema (covers non-STI and STI-base classes).
    collectFromSchema(className);

    // STI children: FK columns are declared on the base table.
    const qualifiedName = this.getResolvedQualifiedName();
    if (ObjectRegistry.getTableStrategy(qualifiedName) === 'sti') {
      collectFromSchema(ObjectRegistry.getSTIBase(qualifiedName));
    }

    if (uuidColumns.size > 0) {
      return uuidColumns;
    }

    // Fallback: derive UUID columns from field metadata when no built schema
    // is available. Mirrors schema-builder's field→SQL mapping so that a
    // text-id cross-package ref is not treated as UUID.
    try {
      const fields = await ObjectRegistry.getAllFields(className);
      for (const [fieldName, field] of fields.entries()) {
        if (!field) continue;
        const type = field.type;
        if (type !== 'foreignKey' && type !== 'crossPackageRef') {
          continue;
        }
        const metaSqlType = field._meta?.sqlType;
        if (metaSqlType) {
          if (metaSqlType === 'UUID') {
            uuidColumns.add(toSnakeCase(fieldName));
          }
          continue;
        }
        const isTextIdCrossRef =
          type === 'crossPackageRef' &&
          (field._meta?.idType === 'text' || field.idType === 'text');
        if (!isTextIdCrossRef) {
          uuidColumns.add(toSnakeCase(fieldName));
        }
      }
    } catch {
      // Best-effort fallback; never let UUID-column resolution block a save.
    }

    return uuidColumns;
  }

  /**
   * Coerce empty-string values to `NULL` for UUID-typed columns in the
   * snake_cased write payload.
   *
   * Framework-level fix for the whole class of bug where a declared FK field
   * defaults to `''` (the natural TypeScript default for `string`) and is left
   * unset on insert — e.g. creating a ROOT entity whose optional self-reference
   * (`previousFactId`, `parentPartnerId`, …) is empty. On Postgres `uuid`
   * columns, `''` raises `invalid input syntax for type uuid`. Coercing to
   * `NULL` here fixes every such field uniformly without per-field type churn
   * or consumer-facing type changes. Mutates `data` in place.
   */
  private async coerceEmptyUuidValuesToNull(
    className: string,
    data: Record<string, any>,
  ): Promise<void> {
    const uuidColumns = await this.resolveUuidColumnNames(className);
    if (uuidColumns.size === 0) return;
    for (const columnName of uuidColumns) {
      if (data[columnName] === '') {
        data[columnName] = null;
      }
    }
  }

  /**
   * Persists this object to the database using an upsert (insert or update).
   *
   * Steps performed on every save:
   * 1. Runs field-level validation (`validateBeforeSave()`)
   * 2. Executes `beforeSave` interceptors (e.g. tenant injection)
   * 3. Assigns a UUID `id` if not already set
   * 4. Generates a `slug` via `getSlug()` if not already set
   * 5. Updates `updated_at` (and sets `created_at` on first save)
   * 6. Upserts the row with automatic retry (3 attempts, 500 ms backoff)
   * 7. Executes `afterSave` interceptors
   * 8. Triggers embedding generation in the background if configured
   *
   * For STI classes, validates that `_meta_type` is present and correct
   * before writing to the database.
   *
   * @returns This instance after saving (enables chaining)
   * @throws {ValidationError} If a required field is missing or a unique constraint is violated
   * @throws {DatabaseError} If the table does not exist (`DB_SCHEMA_MISSING`) or the query fails
   * @throws {RuntimeError} For any other unexpected failure during save
   *
   * @example
   * ```typescript
   * const product = new Product({ db: myDb, name: 'Widget', price: 9.99 });
   * await product.initialize();
   * await product.save();
   * console.log(product.id); // UUID assigned during save
   *
   * // Update
   * product.price = 14.99;
   * await product.save();
   * ```
   */
  async save() {
    const className = this.getResolvedClassName();

    try {
      // Validate object state before saving
      await this.validateBeforeSave();

      // Validate cross-package references that opted into save-time validation
      await this.validateCrossPackageRefs();

      // Execute beforeSave interceptors (e.g., tenancy validation)
      const interceptorContext = createInterceptorContext(className, 'save');
      await GlobalInterceptors.executeBeforeSave(this, interceptorContext);

      if (!this.id) {
        this.id = crypto.randomUUID();
      }

      if (!this.slug) {
        this.slug = await this.getSlug();
      }

      // Update the updated_at timestamp
      this.updated_at = new Date();

      if (!this.created_at) {
        this.created_at = new Date();
      }

      await this.verifyStorageReady();

      // Execute save operation with retry logic for transient failures
      // Use per-adapter upsert method instead of generating SQL.
      // R5-canon: qualified-key lookup avoids cross-package collisions.

      const tableStrategy = ObjectRegistry.getTableStrategy(
        this.getResolvedQualifiedName(),
      );

      // Development-mode warning: Detect unsafe toJSON() overrides in STI classes
      if (process.env.NODE_ENV === 'development') {
        const hasOverride = this.toJSON !== SmrtObject.prototype.toJSON;
        const usesSTI = tableStrategy === 'sti';

        if (hasOverride && usesSTI) {
          logger.warn(
            `[SMRT STI Warning] ${this.constructor.name} overrides toJSON() but uses STI.\n` +
              `Ensure super.toJSON() is called or _meta_type is set manually.\n` +
              `This can cause "Missing _meta_type discriminator" errors.\n` +
              `Prefer using the transformJSON() hook instead of overriding toJSON().\n` +
              `See issue #377: https://github.com/happyvertical/smrt/issues/377`,
          );
        }
      }

      if (tableStrategy === 'sti') {
        // Release C (#1134) retired the SMRT_SKIP_STI_REHYDRATE env flag.
        // PR #1131's unconditional rehydration stays the single behavior:
        // it repairs stale-but-present `inheritedFields` caches that the
        // conservative hydration path would skip (see
        // external-runtime-hydration.test.ts:1071). Further optimizing
        // this loop away via eager invalidation at re-registration time
        // is tracked as a separate follow-up (#1139).
        warnIfSkipRehydrateSet();
        // R5-canon (Copilot follow-up): pass the qualified name to
        // `getSTIHierarchyMembers` so STI sibling discovery is
        // collision-safe across packages with same-simple-name classes.
        const qualifiedName = this.getResolvedQualifiedName();
        const classesNeedingFreshSTIFieldState = Array.from(
          new Set([qualifiedName, ...getSTIHierarchyMembers(qualifiedName)]),
        );
        for (const stiClassName of classesNeedingFreshSTIFieldState) {
          await ObjectRegistry.getAllFields(stiClassName);
        }
      }

      const jsonData = this.toJSON();

      // STI: Fail-fast validation for _meta_type discriminator
      if (tableStrategy === 'sti') {
        if (!jsonData._meta_type) {
          throw new Error(
            `STI validation failed: Missing _meta_type discriminator when saving ${className}. ` +
              `This should have been set automatically by toJSON(). Please report this bug.`,
          );
        }
        // Accept both simple class name and qualified name (namespace isolation - Issue #713)
        if (!isValidMetaType(jsonData._meta_type, className)) {
          throw new Error(
            `STI validation failed: _meta_type mismatch when saving ${className}. ` +
              `Expected '${getExpectedMetaType(className)}' but got '${jsonData._meta_type}'. ` +
              `This should not happen - please report this bug.`,
          );
        }
      }

      // Convert camelCase keys to snake_case for database columns
      // Preserve leading underscore for special fields like _meta_type, _meta_data
      const data: Record<string, any> = {};
      for (const [key, value] of Object.entries(jsonData)) {
        if (key.startsWith('_')) {
          // Preserve leading underscore for special fields
          data[key] = value;
        } else {
          data[toSnakeCase(key)] = value;
        }
      }

      // Coerce empty-string values to NULL for native UUID columns (declared
      // FKs / cross-package refs). The TypeScript default for an unset
      // `string`-typed FK is `''`, which Postgres rejects on a `uuid` column
      // ("invalid input syntax for type uuid"). This framework-level coercion
      // fixes every optional/unset declared-FK field uniformly.
      await this.coerceEmptyUuidValuesToNull(className, data);

      // Get conflict columns from registry (supports custom columns for junction tables)
      const conflictColumns = ObjectRegistry.getConflictColumns(className);
      const writePlan = await this.planPersistenceWrite(
        className,
        tableStrategy,
        data,
        conflictColumns,
      );

      // Issue #1472: objects backed by an existing row must conflict on the
      // primary key. With natural-key conflict columns, editing a natural-key
      // field (e.g. slug) makes the conflict target match no row, so the
      // upsert takes the INSERT path with the existing id and violates
      // `*_pkey`. New objects keep natural-key conflict so ingestion-style
      // dedup (create/getOrUpsert against a known slug) still updates in
      // place. planPersistenceWrite() intentionally still receives the
      // natural-key columns — its legacy-STI probe semantics are unchanged.
      const upsertConflictColumns =
        this._persisted && data.id ? ['id'] : conflictColumns;

      await ErrorUtils.withRetry(
        async () => {
          try {
            if (writePlan.type === 'updateById') {
              const { id: _id, ...updateData } = data;
              await this.db.update(this.tableName, { id: data.id }, updateData);
              this.setMetaType(writePlan.qualifiedMetaType);
            } else {
              await this.db.upsert(this.tableName, upsertConflictColumns, data);
            }
          } catch (error) {
            // Detect specific database error types
            if (error instanceof Error) {
              if (error.message.includes('UNIQUE constraint failed')) {
                const field = this.extractConstraintField(error.message);
                throw ValidationError.uniqueConstraint(
                  field,
                  this.getFieldValue(field),
                );
              }
              if (error.message.includes('NOT NULL constraint failed')) {
                const field = this.extractConstraintField(error.message);
                throw ValidationError.requiredField(field, className);
              }
              const operation =
                writePlan.type === 'updateById'
                  ? `UPDATE ${this.tableName} (id-targeted)`
                  : `UPSERT INTO ${this.tableName}`;
              throw DatabaseError.queryFailed(operation, error);
            }
            throw error;
          }
        },
        3,
        500,
      );

      // The row now exists, so any further save() must update it by primary
      // key even if natural-key fields change afterwards (issue #1472).
      this._persisted = true;

      // Bust cached collection reads for this table (issue #1498). SMRT owns
      // every mutation path, so this is the write-invalidation guarantee the
      // opt-in read cache relies on.
      this.invalidateCollectionReadCache();

      // Execute afterSave interceptors (e.g., tenant audit logging)
      await GlobalInterceptors.executeAfterSave(this, interceptorContext);

      // Auto-generate embeddings only when an AI client is configured. Manual
      // generation can still use local embeddings, but save-time background
      // work should not unexpectedly load a local transformer model.
      const embeddingConfig = ObjectRegistry.resolveEmbeddingConfig(className);
      const skipAutoEmbeddings = this.options._skipAutoEmbeddings === true;
      if (
        embeddingConfig &&
        embeddingConfig.autoGenerate !== false &&
        !skipAutoEmbeddings
      ) {
        const aiClient = await this.getOptionalAiClient();

        // Check if any embedding field content has changed
        if (aiClient) {
          const isStale = await this.hasStaleEmbeddings();
          if (isStale) {
            // Generate embeddings in background to avoid blocking save
            this.generateEmbeddings().catch((error) => {
              logger.warn(
                `Failed to auto-generate embeddings for ${this.constructor.name}`,
                { error: error instanceof Error ? error.message : error },
              );
            });
          }
        }
      }
      if (skipAutoEmbeddings) {
        this.options._skipAutoEmbeddings = false;
      }

      return this;
    } catch (error) {
      // Re-throw SMRT errors as-is, wrap others
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }

      throw RuntimeError.operationFailed(
        'save',
        `${className}#${this.id}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Validates object state before saving
   * Override in subclasses to add custom validation logic
   */
  protected async validateBeforeSave(): Promise<void> {
    const className = this.getResolvedClassName();

    // Priority 1: Use pre-computed validation rules from manifest (Issue #782)
    // This is the fastest path - rules are serializable and don't require closures
    const validationRules = ObjectRegistry.getValidationRules(className);

    if (validationRules && validationRules.length > 0) {
      const errors = await ObjectRegistry.validateWithRules(
        this,
        validationRules,
        className,
      );

      if (errors.length > 0) {
        throw errors[0];
      }
      return;
    }

    // Priority 2: Use compiled validators (backward compatibility)
    const validators = ObjectRegistry.getValidators(className);

    if (validators && validators.length > 0) {
      // Execute all cached validators
      const errors: ValidationError[] = [];

      for (const validator of validators) {
        const error = await validator(this);
        if (error) {
          errors.push(error);
        }
      }

      // If there are validation errors, throw the first one
      // (In the future, we could throw all errors as a ValidationReport)
      if (errors.length > 0) {
        throw errors[0];
      }
      return;
    }

    // Priority 3: Fallback to old validation logic if no cached validators
    // (for classes not registered with ObjectRegistry)
    const fields = await fieldsFromClass(this.constructor as any);

    for (const [fieldName, field] of Object.entries(fields)) {
      // With decorators, field definitions are plain objects with nested options
      if ((field as any).options?.required) {
        const value = this.getFieldValue(fieldName);
        if (value === null || value === undefined || value === '') {
          throw ValidationError.requiredField(fieldName, className);
        }
      }
    }
  }

  /**
   * Validates cross-package references that opted in via `validate: true`.
   *
   * Iterates registered fields of type `crossPackageRef`. For each one whose
   * field options include `validate: true` AND has a non-empty value, looks up
   * the referenced object via the target package's manifest and throws
   * `ValidationError` if the target row does not exist.
   *
   * Empty/null/undefined values are treated as "no reference set" and skipped.
   * Fields without `validate: true` are always skipped (the registered metadata
   * still powers eager loading and `loadRelated()`).
   */
  protected async validateCrossPackageRefs(): Promise<void> {
    const className = this.getResolvedClassName();
    const registered = ObjectRegistry.getClass(className);
    if (!registered) return;

    const fields = registered.inheritedFields || registered.fields;
    if (!fields || fields.size === 0) return;

    type CrossRefCheck = {
      fieldName: string;
      qualifiedTarget: string;
      value: string;
    };
    const checks: CrossRefCheck[] = [];

    for (const [fieldName, field] of fields) {
      if (field?.type !== 'crossPackageRef') continue;
      const opts = field._meta || field;
      if (!opts.validate) continue;
      if (!field.related) continue;

      const value = this.getFieldValue(fieldName);
      if (value === null || value === undefined || value === '') continue;

      checks.push({
        fieldName,
        qualifiedTarget: String(field.related),
        value: String(value),
      });
    }

    if (checks.length === 0) return;

    for (const check of checks) {
      await ObjectRegistry.ensureManifestLoaded(check.qualifiedTarget);

      const targetClass =
        ObjectRegistry.getClassByQualifiedName(check.qualifiedTarget) ??
        ObjectRegistry.getClass(check.qualifiedTarget);

      if (!targetClass) {
        throw new ValidationError(
          `crossPackageRef target ${check.qualifiedTarget} for ${className}.${check.fieldName} is not registered. ` +
            `Ensure the target package's manifest is discoverable at runtime.`,
          'VALIDATION_CROSS_PACKAGE_REF_UNREGISTERED',
          { className, fieldName: check.fieldName, value: check.value },
        );
      }

      const probe = new targetClass.constructor(this.options) as SmrtObject;
      await probe.initialize();
      await probe.verifyStorageReady();
      const row = await probe.db.get(probe.tableName, { id: check.value });
      if (!row) {
        throw new ValidationError(
          `crossPackageRef validation failed: ${className}.${check.fieldName} references ` +
            `${check.qualifiedTarget} id="${check.value}" but no such row exists.`,
          'VALIDATION_CROSS_PACKAGE_REF_MISSING',
          { className, fieldName: check.fieldName, value: check.value },
        );
      }
    }
  }

  /**
   * Gets the value of a field on this object
   */
  protected getFieldValue(fieldName: string): any {
    return (this as any)[fieldName];
  }

  /**
   * Gets the value of a property.
   *
   * @param key - Property name to get value from
   * @returns The property value
   */
  protected getPropertyValue(key: string): any {
    return (this as any)[key];
  }

  /**
   * Extracts field name from database constraint error messages
   */
  protected extractConstraintField(errorMessage: string): string {
    // Try to extract field name from common SQLite constraint patterns
    const patterns = [
      /UNIQUE constraint failed: \w+\.(\w+)/,
      /NOT NULL constraint failed: \w+\.(\w+)/,
      /constraint failed: (\w+)/i,
    ];

    for (const pattern of patterns) {
      const match = errorMessage.match(pattern);
      if (match?.[1]) {
        return match[1];
      }
    }

    return 'unknown_field';
  }

  /**
   * Hydrates this object from the database using its `id` property.
   *
   * Queries the database for a row matching `{ id: this._id }` and calls
   * `loadDataFromDb()` if found. Uses a 3-attempt retry with 250 ms initial
   * delay to handle transient failures.
   *
   * Called automatically by `initialize()` when `options.id` is provided.
   * Typically you do not need to call this directly.
   *
   * @returns Promise that resolves when loading is complete (no-op if not found)
   * @throws {ValidationError} If `this._id` is not set
   * @throws {DatabaseError} If the query fails after all retries
   *
   * @example
   * ```typescript
   * const product = new Product({ db: myDb });
   * await product.initialize();
   * product._id = 'some-uuid';
   * await product.loadFromId(); // hydrates from DB
   * ```
   */
  public async loadFromId() {
    try {
      if (!this._id) {
        throw ValidationError.requiredField('id', this.constructor.name);
      }

      await this.verifyStorageReady();

      await ErrorUtils.withRetry(
        async () => {
          try {
            const existing = await this.db.get(this.tableName, {
              id: this._id,
            });
            if (existing) {
              await this.loadDataFromDb(existing);
            }
          } catch (error) {
            throw DatabaseError.queryFailed(
              `get(${this.tableName}, { id: ${this._id} })`,
              error instanceof Error ? error : new Error(String(error)),
            );
          }
        },
        3,
        250,
      );
    } catch (error) {
      if (error instanceof ValidationError || error instanceof DatabaseError) {
        throw error;
      }

      throw RuntimeError.operationFailed(
        'loadFromId',
        `${this.constructor.name}#${this._id}`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Hydrates this object from the database using its `slug` (and `context`).
   *
   * Queries for a row matching `{ slug, context }`. The `context` defaults to
   * an empty string when not provided. Calls `loadDataFromDb()` if a matching
   * row is found.
   *
   * Called automatically by `initialize()` when `options.slug` is provided and
   * no `options.id` is set. Typically you do not need to call this directly.
   *
   * @returns Promise that resolves when loading is complete (no-op if not found)
   *
   * @example
   * ```typescript
   * const product = new Product({ db: myDb, slug: 'my-widget', context: 'shop' });
   * await product.initialize(); // calls loadFromSlug() automatically
   * console.log(product.name);
   * ```
   */
  public async loadFromSlug() {
    await this.verifyStorageReady();

    const existing = await this.db.get(this.tableName, {
      slug: this._slug,
      context: this._context || '',
    });
    if (existing) {
      await this.loadDataFromDb(existing);
    }
  }

  /**
   * Serializes this instance into the "content body" injected into the AI
   * prompts used by {@link is}, {@link do}, and {@link describe} so those
   * methods reason over the object's own field data, not just the caller's
   * instruction string.
   *
   * Uses {@link toPublicJSON} (never {@link toJSON}) so that
   * `@field({ sensitive: true })` values — API secrets, credentials, tax IDs —
   * are never sent to the model. The serialized payload is truncated to
   * `maxLength` characters as a coarse token-budget guard for large instances;
   * truncation appends a clear marker so the model knows the data was cut.
   *
   * @param maxLength - Maximum characters of object data to include
   *   (defaults to {@link AI_PROMPT_DATA_MAX_LENGTH}). A non-positive value
   *   disables truncation.
   * @returns A JSON string of the object's public (sensitive-stripped) fields
   */
  private serializeForAiPrompt(
    maxLength: number = AI_PROMPT_DATA_MAX_LENGTH,
  ): string {
    let serialized: string;
    try {
      serialized = JSON.stringify(this.toPublicJSON(), null, 2);
    } catch (error) {
      // Defensive: never let a serialization edge case break an AI call.
      // The instruction-only prompt still works; we just lose the data context.
      logger.warn(
        `Failed to serialize ${this.constructor.name} for AI prompt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      serialized = '{}';
    }

    if (
      Number.isFinite(maxLength) &&
      maxLength > 0 &&
      serialized.length > maxLength
    ) {
      const marker = `\n… [truncated: object data exceeded ${maxLength} characters]`;
      // Reserve room for the marker so the returned string never exceeds
      // maxLength — the budget is a hard ceiling, not "data + marker". For a
      // budget smaller than the marker itself, emit just the marker (an
      // unusably small budget still yields a clear truncation signal).
      const keep = Math.max(0, maxLength - marker.length);
      serialized = `${serialized.slice(0, keep)}${marker}`;
    }

    return serialized;
  }

  /**
   * Builds the optional "content body" section prepended to the AI prompts in
   * {@link is}, {@link do}, and {@link describe}.
   *
   * Returns an empty string when the caller opts out with `includeData: false`
   * — used by callers that already curate the object's relevant fields into
   * their own instruction/criteria string (so the data is not duplicated, and
   * the prompt stays exactly as the caller authored it). Otherwise it wraps
   * {@link serializeForAiPrompt} in `--- Beginning/End of content ---`
   * delimiters so the methods reason over the instance's own data by default.
   *
   * @param includeData - `false` to omit the section; any other value (incl.
   *   `undefined`) injects it
   * @param maxLength - Forwarded to {@link serializeForAiPrompt} as the
   *   truncation budget
   * @returns The content-body section (with a trailing newline) or `''`
   */
  private buildAiContentSection(
    includeData: boolean | undefined,
    maxLength?: number,
  ): string {
    if (includeData === false) {
      return '';
    }
    const contentBody = this.serializeForAiPrompt(maxLength);
    return `--- Beginning of content ---\n${contentBody}\n--- End of content ---\n`;
  }

  /**
   * Evaluates whether this object satisfies the given natural-language criteria using AI.
   *
   * Injects the object's own public field data (via {@link toPublicJSON}, so
   * `@field({ sensitive: true })` values are excluded) into the prompt as the
   * "content body", then asks the AI whether that data meets the criteria and
   * to reply with a `{ result: boolean }` JSON response. Uses any AI-callable
   * tools registered on this class (via `@smrt({ ai })`) as part of the
   * function-calling context.
   *
   * @param criteria - Natural-language description of the condition to evaluate
   * @param options - AI message options passed to `ai.message()` (e.g. model
   *   override). Two non-standard control keys are consumed here and not
   *   forwarded to `ai.message()`:
   *   - `includeData: false` — omit the injected object "content body" (for
   *     callers that already curate the relevant fields into `criteria`).
   *   - `maxDataLength` (number of characters) — override the injected
   *     object-data truncation limit.
   * @returns `true` if the object meets the criteria, `false` otherwise
   * @throws Error if the AI returns a non-boolean or malformed JSON response
   *
   * @example
   * ```typescript
   * const article = await articles.get('article-uuid');
   * const isSuitable = await article.is('appropriate for a general audience');
   * if (isSuitable) await article.publish();
   * ```
   *
   * @see {@link do} for open-ended instructions instead of boolean checks
   */
  public async is(criteria: string, options: any = {}) {
    const ai = await this.getAiClient();
    const { maxDataLength, includeData, ...aiOptions } = options ?? {};
    const contentSection = this.buildAiContentSection(
      includeData,
      maxDataLength,
    );
    const prompt = `${contentSection}--- Beginning of criteria ---\n${criteria}\n--- End of criteria ---\nDoes the content meet all the given criteria? Reply with a json object with a single boolean 'result' property`;

    // Get available tools for AI function calling
    const tools = this.getAvailableTools();

    const message = await ai.message(prompt, {
      ...(aiOptions as any),
      responseFormat: { type: 'json_object' },
      tools: tools.length > 0 ? tools : undefined,
    });

    try {
      const { result } = JSON.parse(message);
      if (result === true || result === false) {
        return result;
      }
    } catch (_e) {
      throw new Error(`Unexpected answer: ${message}`);
    }
  }

  /**
   * Performs a freeform operation on this object using AI instructions.
   *
   * Injects the object's own public field data (via {@link toPublicJSON}, so
   * `@field({ sensitive: true })` values are excluded) into the prompt as the
   * "content body" the instructions operate on, then returns the raw text
   * response. Unlike `is()`, this method does not constrain the response
   * format — use it for transformations, summaries, extractions, or any
   * open-ended AI task.
   *
   * Uses any AI-callable tools registered on this class (via `@smrt({ ai })`)
   * as part of the function-calling context.
   *
   * @param instructions - Natural-language instructions for the AI to follow
   * @param options - AI message options passed to `ai.message()` (e.g. model
   *   override). Two non-standard control keys are consumed here and not
   *   forwarded to `ai.message()`:
   *   - `includeData: false` — omit the injected object "content body" (for
   *     callers that already curate the relevant fields into `instructions`).
   *   - `maxDataLength` (number of characters) — override the injected
   *     object-data truncation limit.
   * @returns The raw AI response string
   *
   * @example
   * ```typescript
   * const article = await articles.get('article-uuid');
   * const summary = await article.do('summarize this article in 3 bullet points');
   * const translated = await article.do('translate the title and body to Spanish');
   * ```
   *
   * @see {@link is} for boolean criteria checks
   */
  public async do(instructions: string, options: any = {}) {
    const ai = await this.getAiClient();
    const { maxDataLength, includeData, ...aiOptions } = options ?? {};
    const contentSection = this.buildAiContentSection(
      includeData,
      maxDataLength,
    );
    const prompt = `${contentSection}--- Beginning of instructions ---\n${instructions}\n--- End of instructions ---\nBased on the content body, please follow the instructions and provide a response. Never make use of codeblocks.`;

    // Get available tools for AI function calling
    const tools = this.getAvailableTools();

    const result = await ai.message(prompt, {
      ...aiOptions,
      tools: tools.length > 0 ? tools : undefined,
    });

    return result;
  }

  /**
   * Generates a description of this object using AI (Issue #52)
   *
   * Creates a concise, human-readable description based on the object's content
   * and properties. The object's own public field data (via
   * {@link toPublicJSON}, so `@field({ sensitive: true })` values are excluded)
   * is injected into the prompt as the "content body" the description is built
   * from. Useful for summaries, previews, and documentation.
   *
   * @param options - AI message options (can include style, length, focus,
   *   etc.). Two non-standard control keys are consumed here and not forwarded
   *   to `ai.message()`:
   *   - `includeData: false` — omit the injected object "content body".
   *   - `maxDataLength` (number of characters) — override the injected
   *     object-data truncation limit.
   * @returns Promise resolving to the AI-generated description
   *
   * @example
   * ```typescript
   * const product = await products.get('product-123');
   * const description = await product.describe();
   * // "A high-quality widget for home improvement..."
   *
   * // With custom options
   * const shortDesc = await product.describe({ maxTokens: 50 });
   * // "Premium widget, steel construction"
   * ```
   */
  public async describe(options: any = {}) {
    const ai = await this.getAiClient();
    const { maxDataLength, includeData, ...aiOptions } = options ?? {};
    const contentSection = this.buildAiContentSection(
      includeData,
      maxDataLength,
    );
    const prompt = `${contentSection}Generate a concise, professional description of this object based on its content and properties. The description should be clear, informative, and suitable for display to end users. Focus on the most important and distinctive characteristics.`;

    // Get available tools for AI function calling
    const tools = this.getAvailableTools();

    const result = await ai.message(prompt, {
      ...aiOptions,
      tools: tools.length > 0 ? tools : undefined,
    });

    return result;
  }

  /**
   * Runs a lifecycle hook if it's defined in the object's configuration
   *
   * @param hookName - Name of the hook to run (e.g., 'beforeDelete', 'afterDelete')
   * @returns Promise that resolves when the hook completes
   */
  protected async runHook(hookName: string): Promise<void> {
    const config = ObjectRegistry.getConfig(this.constructor.name);
    const hook = config.hooks?.[hookName as keyof typeof config.hooks];

    if (!hook) {
      return; // No hook defined, nothing to do
    }

    if (typeof hook === 'string') {
      // Hook is a method name to call on this instance
      const method = (this as any)[hook];
      if (typeof method === 'function') {
        await method.call(this);
      } else {
        logger.warn(
          `Hook method '${hook}' not found on ${this.constructor.name}`,
        );
      }
    } else if (typeof hook === 'function') {
      // Hook is a function to call with this instance as parameter
      await hook(this);
    }
  }

  /**
   * Deletes this object from the database.
   *
   * Runs the full lifecycle in order:
   * 1. `beforeDelete` interceptors (e.g. tenant validation)
   * 2. `beforeDelete` lifecycle hook (defined in `@smrt({ hooks })`)
   * 3. Database row deletion
   * 4. `afterDelete` lifecycle hook
   * 5. `afterDelete` interceptors
   *
   * Prefer `collection.delete(id)` from application code — it loads the
   * object first (returning `false` when not found) before calling this method.
   *
   * @returns Promise that resolves when deletion is complete
   *
   * @example
   * ```typescript
   * const product = await products.get('product-uuid');
   * if (product) await product.delete();
   * ```
   */
  public async delete(): Promise<void> {
    // Execute beforeDelete interceptors (e.g., tenant validation)
    const interceptorContext = createInterceptorContext(
      this.constructor.name,
      'delete',
    );
    await GlobalInterceptors.executeBeforeDelete(this, interceptorContext);

    await this.runHook('beforeDelete');

    await this.verifyStorageReady();
    await this.db.delete(this.tableName, { id: this.id });

    // The backing row is gone — a later save() should go through the
    // natural-key insert path again rather than targeting a deleted id.
    this._persisted = false;

    // Bust cached collection reads for this table (issue #1498).
    this.invalidateCollectionReadCache();

    await this.runHook('afterDelete');

    // Execute afterDelete interceptors (e.g., tenant audit logging)
    await GlobalInterceptors.executeAfterDelete(this, interceptorContext);
  }

  /**
   * Invalidate cached collection reads after a successful mutation
   * (issue #1498).
   *
   * Always drops this table's in-process entries — a no-op when nothing
   * opted into caching. When the table is cached cross-process (see
   * {@link shouldBroadcastCacheInvalidation}), the invalidation is also
   * broadcast to peer replicas over the database adapter's notification
   * capability, fire-and-forget. Cache maintenance must never fail the
   * write that triggered it.
   */
  private invalidateCollectionReadCache(): void {
    try {
      const dbKey = resolveDbCacheKey(this.db);
      invalidateCollectionCache(dbKey, this.tableName);

      if (this.shouldBroadcastCacheInvalidation(dbKey)) {
        void broadcastCacheInvalidation(this.db, this.tableName);
      }
    } catch (error) {
      logger.warn('Failed to invalidate collection read cache after write', {
        table: this.tableName,
        error: error instanceof Error ? error.message : error,
      });
    }
  }

  /**
   * Decide whether a mutation should broadcast a cross-process cache
   * invalidation. Invalidation is table-scoped, so the decision must be too:
   *
   * 1. A per-call `crossProcess` cached read in this process registered
   *    interest in the table — broadcast even without model-level config.
   * 2. This class's resolved `@smrt({ cache })` config sets `crossProcess`.
   * 3. Any other STI hierarchy member sharing the table resolves to a
   *    `crossProcess` config — a child that opted out with `cache: false`
   *    still mutates the shared table its base/siblings are caching.
   */
  private shouldBroadcastCacheInvalidation(dbKey: string): boolean {
    if (hasCrossProcessCacheInterest(dbKey, this.tableName)) {
      return true;
    }

    const qualifiedName = this.getResolvedQualifiedName();
    if (
      ObjectRegistry.resolveCollectionCacheConfig(qualifiedName)?.crossProcess
    ) {
      return true;
    }

    for (const member of getSTIHierarchyMembers(qualifiedName)) {
      if (member === qualifiedName) continue;
      if (ObjectRegistry.resolveCollectionCacheConfig(member)?.crossProcess) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if a relationship has been loaded
   *
   * @param fieldName - Name of the relationship field
   * @returns True if the relationship is loaded, false otherwise
   * @example
   * ```typescript
   * if (order.isRelatedLoaded('customer')) {
   *   console.log('Customer already loaded');
   * }
   * ```
   */
  public isRelatedLoaded(fieldName: string): boolean {
    return this._loadedRelationships.has(fieldName);
  }

  /**
   * Lazy-loads a `foreignKey` or `crossPackageRef` relationship and caches the
   * result.
   *
   * Looks up the relationship metadata in the ObjectRegistry, reads the
   * foreign key value on this object, and fetches the related object from
   * the database. Subsequent calls return the cached value without hitting
   * the database again.
   *
   * For STI relationships, the correct subclass is determined by reading
   * `_meta_type` from the database row before instantiation.
   *
   * Enforces tenant isolation: if this object and the loaded target both carry
   * a non-null `tenantId` that differ, a {@link TenantIsolationError} is thrown
   * (unless `opts.allowCrossTenant` is set). The check is a no-op for
   * global/null-tenant models and same-tenant loads, so it only catches genuine
   * cross-tenant leaks (Issue #1321).
   *
   * @param fieldName - Name of the `@foreignKey()` or `@crossPackageRef()`
   *   decorated property
   * @param opts - Optional loader options; see {@link LoadRelatedOptions}
   * @returns The related object, or `null` if the foreign key is empty
   * @throws {RuntimeError} If `fieldName` is not a `foreignKey` or
   *   `crossPackageRef` relationship, or the target class is not found in the
   *   ObjectRegistry
   * @throws {TenantIsolationError} If the target belongs to a different,
   *   non-null tenant and `opts.allowCrossTenant` is not set
   *
   * @example
   * ```typescript
   * // class Order { @foreignKey(Customer) customerId: string = ''; }
   * const customer = await order.loadRelated('customerId');
   * console.log(customer?.name);
   * ```
   *
   * @see {@link getRelated} for a convenience wrapper that auto-detects relationship type
   */
  public async loadRelated(
    fieldName: string,
    opts?: LoadRelatedOptions,
  ): Promise<any> {
    // Check if already loaded
    if (this._loadedRelationships.has(fieldName)) {
      const cached = this._loadedRelationships.get(fieldName);
      // Re-validate cached targets: a cache populated by an eager `include`
      // load (or a prior allowCrossTenant load) must not leak cross-tenant data
      // through a later guarded call (Issue #1321).
      this.assertRelatedTenant(cached, fieldName, opts?.allowCrossTenant);
      return cached;
    }

    // Ensure manifest is loaded for external packages before accessing relationships
    // This is critical for cross-package relationship resolution (Issue #746)
    await ObjectRegistry.ensureManifestLoaded(this.constructor.name);

    // Get relationship metadata from ObjectRegistry
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name,
    );
    const relationship = relationships.find(
      (r) =>
        r.fieldName === fieldName &&
        (r.type === 'foreignKey' || r.type === 'crossPackageRef'),
    );

    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a foreignKey or crossPackageRef relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name },
      );
    }

    // Get the foreign key value
    const foreignKeyValue = this[fieldName as keyof this];
    if (!foreignKeyValue) {
      // No related object (foreign key is null)
      this._loadedRelationships.set(fieldName, null);
      return null;
    }

    // For crossPackageRef, the target is a qualified name and the target package's
    // manifest may not be loaded yet — ensure it's available before lookup.
    if (relationship.type === 'crossPackageRef') {
      await ObjectRegistry.ensureManifestLoaded(relationship.targetClass);
    }

    // Get the target class constructor (try qualified name first for crossPackageRef)
    const targetClassInfo =
      relationship.type === 'crossPackageRef'
        ? (ObjectRegistry.getClassByQualifiedName(relationship.targetClass) ??
          ObjectRegistry.getClass(relationship.targetClass))
        : ObjectRegistry.getClass(relationship.targetClass);
    if (!targetClassInfo) {
      throw RuntimeError.invalidState(
        `Target class ${relationship.targetClass} not found in ObjectRegistry`,
        { targetClass: relationship.targetClass, fieldName },
      );
    }

    // Check if target class uses STI (Single Table Inheritance)
    const tableStrategy = ObjectRegistry.getTableStrategy(
      relationship.targetClass,
    );
    const isSTI = tableStrategy === 'sti';

    // For STI classes, we need to determine the actual subclass from the database row
    let actualClassInfo = targetClassInfo;
    if (isSTI) {
      // First, fetch just the row to get the _meta_type discriminator
      const tempInstance = new targetClassInfo.constructor(this.options);
      await tempInstance.initialize();
      await tempInstance.verifyStorageReady();
      const row = await tempInstance.db.get(tempInstance.tableName, {
        id: foreignKeyValue as string,
      });

      if (row?._meta_type) {
        // Get the actual class from the registry based on _meta_type
        // Support both qualified names (new format: @pkg:Class) and simple names (legacy)
        let actualClass = ObjectRegistry.getClassByQualifiedName(
          row._meta_type,
        );
        if (!actualClass) {
          // Fall back to simple name lookup for legacy data
          actualClass = ObjectRegistry.getClass(row._meta_type);
        }
        if (actualClass) {
          actualClassInfo = actualClass;
        }
      }
    }

    // Create an instance of the correct class and load by ID
    const relatedInstance = new actualClassInfo.constructor(this.options);
    await relatedInstance.initialize();
    relatedInstance.id = foreignKeyValue as string;
    await relatedInstance.loadFromId();

    // Enforce tenant isolation before caching/returning so a blocked
    // cross-tenant target is never cached (Issue #1321).
    this.assertRelatedTenant(
      relatedInstance,
      fieldName,
      opts?.allowCrossTenant,
    );

    // Cache the loaded object
    this._loadedRelationships.set(fieldName, relatedInstance);
    return relatedInstance;
  }

  /**
   * Guards a loaded relationship target against cross-tenant access.
   *
   * Throws {@link TenantIsolationError} when this object and `loaded` both carry
   * a non-null `tenantId` that differ — the genuine cross-tenant leak. It is a
   * no-op when `allowCrossTenant === true`, when `loaded` is `null`, when either
   * side has a `null`/`undefined` tenant (global / non-tenant-scoped models),
   * and when both sides share the same tenant (Issue #1321).
   *
   * `loaded` may be a single related object or an array (oneToMany / manyToMany);
   * arrays are validated per item. This runs on both fresh loads and cache hits,
   * so a cache populated by an eager `include` load — or by a prior
   * `allowCrossTenant` load — cannot leak cross-tenant data through a later
   * guarded call.
   *
   * @param loaded - The loaded related object, or array of objects.
   * @param fieldName - The relationship field name (for error context).
   * @param allowCrossTenant - When exactly `true`, bypasses the guard entirely.
   */
  private assertRelatedTenant(
    loaded: unknown,
    fieldName: string,
    allowCrossTenant?: boolean,
  ): void {
    // Strict `=== true`: only the documented opt-in bypasses the guard, never an
    // incidental truthy value passed from untyped JS callers.
    if (allowCrossTenant === true || loaded == null) {
      return;
    }

    if (Array.isArray(loaded)) {
      for (const item of loaded) {
        this.assertRelatedTenant(item, fieldName, allowCrossTenant);
      }
      return;
    }

    const sourceTenantId = (this as { tenantId?: unknown }).tenantId;
    const targetTenantId = (loaded as { tenantId?: unknown }).tenantId;

    if (
      sourceTenantId != null &&
      targetTenantId != null &&
      sourceTenantId !== targetTenantId
    ) {
      throw TenantIsolationError.crossTenantReference({
        sourceClass: this.constructor.name,
        fieldName,
        sourceTenantId: String(sourceTenantId),
        targetClass: (loaded as { constructor?: { name?: string } })
          ?.constructor?.name,
        targetTenantId: String(targetTenantId),
      });
    }
  }

  /**
   * Load related objects for oneToMany or manyToMany fields (lazy loading)
   *
   * Loads all related objects from the database. For oneToMany, queries by
   * the inverse foreign key. For manyToMany, queries through the join table.
   *
   * Enforces tenant isolation per item: if this object and a loaded target both
   * carry a non-null `tenantId` that differ, a {@link TenantIsolationError} is
   * thrown (unless `opts.allowCrossTenant` is set). The check is a no-op for
   * global/null-tenant models and same-tenant loads, so it only catches genuine
   * cross-tenant leaks (Issue #1321).
   *
   * @param fieldName - Name of the oneToMany or manyToMany field
   * @param opts - Optional loader options; see {@link LoadRelatedOptions}
   * @returns Promise resolving to array of related objects
   * @throws {RuntimeError} If the field is not a relationship or not implemented
   * @throws {TenantIsolationError} If any loaded item belongs to a different,
   *   non-null tenant and `opts.allowCrossTenant` is not set
   * @example
   * ```typescript
   * // Given: class Customer with orders = oneToMany(Order)
   * const orders = await customer.loadRelatedMany('orders');
   * console.log(`${orders.length} orders found`);
   * ```
   */
  public async loadRelatedMany(
    fieldName: string,
    opts?: LoadRelatedOptions,
  ): Promise<any[]> {
    // Check if already loaded
    if (this._loadedRelationships.has(fieldName)) {
      const cached = this._loadedRelationships.get(fieldName);
      // Re-validate cached targets: a cache populated by an eager `include`
      // load (or a prior allowCrossTenant load) must not leak cross-tenant data
      // through a later guarded call (Issue #1321).
      this.assertRelatedTenant(cached, fieldName, opts?.allowCrossTenant);
      return cached;
    }

    // Ensure manifest is loaded for external packages before accessing relationships
    // This is critical for cross-package relationship resolution (Issue #746)
    await ObjectRegistry.ensureManifestLoaded(this.constructor.name);

    // Get relationship metadata from ObjectRegistry
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name,
    );
    const relationship = relationships.find((r) => r.fieldName === fieldName);

    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name },
      );
    }

    if (relationship.type === 'oneToMany') {
      // Find the inverse foreignKey field on the target class. An instance can
      // satisfy an inverse FK that targets its own class OR any (STI) ancestor
      // it inherits the oneToMany from — the FK is declared against the base
      // class name, while `this.constructor.name` may be a subclass (e.g. a
      // Person inheriting Profile.relationshipsFrom).
      const inverseRelationships =
        ObjectRegistry.getInverseRelationshipsForSelf(this.constructor.name);
      const inverseCandidates = inverseRelationships.filter(
        (r) =>
          r.sourceClass === relationship.targetClass && r.type === 'foreignKey',
      );
      // When the target declares multiple foreign keys back to this class
      // (e.g. ProfileRelationship.fromProfileId / toProfileId), honor an
      // explicit `@oneToMany(Target, { foreignKey })` to pick the right side.
      // Otherwise fall back to the first match (legacy behavior).
      const explicitForeignKey = relationship.options?.foreignKey as
        | string
        | undefined;
      const matchedForeignKey = explicitForeignKey
        ? inverseCandidates.find((r) => r.fieldName === explicitForeignKey)
        : undefined;
      if (explicitForeignKey && !matchedForeignKey) {
        // A misspelled / stale `foreignKey` must fail loudly rather than
        // silently resolving the wrong inverse side.
        throw RuntimeError.invalidState(
          `oneToMany ${fieldName} on ${this.constructor.name} specifies foreignKey '${explicitForeignKey}', but ${relationship.targetClass} has no matching inverse foreignKey. Candidates: ${inverseCandidates.map((r) => r.fieldName).join(', ') || '(none)'}`,
          {
            fieldName,
            targetClass: relationship.targetClass,
            foreignKey: explicitForeignKey,
          },
        );
      }
      // Prefer an inverse FK that targets this exact class before falling back
      // to one inherited from an (STI) ancestor — preserves the pre-fallback
      // selection when a target declares FKs to multiple levels of the chain.
      const inverseForeignKey =
        matchedForeignKey ??
        inverseCandidates.find(
          (r) => r.targetClass === this.constructor.name,
        ) ??
        inverseCandidates[0];

      if (!inverseForeignKey) {
        throw RuntimeError.invalidState(
          `Could not find inverse foreignKey on ${relationship.targetClass} for oneToMany relationship ${fieldName}`,
          { fieldName, targetClass: relationship.targetClass },
        );
      }

      // Get or create cached collection instance
      const collection = await ObjectRegistry.getCollection(
        relationship.targetClass,
        this.options,
      );

      // Query using the inverse foreign key
      const relatedObjects = await collection.list({
        where: { [inverseForeignKey.fieldName]: this.id },
      });

      // Enforce tenant isolation per item before caching (Issue #1321).
      this.assertRelatedTenant(
        relatedObjects,
        fieldName,
        opts?.allowCrossTenant,
      );

      // Cache the loaded objects
      this._loadedRelationships.set(fieldName, relatedObjects);
      return relatedObjects;
    }

    if (relationship.type === 'manyToMany') {
      const { through, sourceColumn, targetColumn, targetClassName } =
        await this.resolveManyToManyJoin(fieldName, relationship);

      if (!this.id) {
        // No id yet — there can't be any join rows pointing at this instance.
        this._loadedRelationships.set(fieldName, []);
        return [];
      }

      await this.verifyStorageReady();

      const junctionRows = await this.db.query(
        `SELECT "${targetColumn}" FROM "${through}" WHERE "${sourceColumn}" = ?`,
        [this.id],
      );

      const targetIds = junctionRows.rows
        .map((row: any) => row[targetColumn])
        .filter(
          (id: any): id is string => typeof id === 'string' && id.length > 0,
        );

      if (targetIds.length === 0) {
        this._loadedRelationships.set(fieldName, []);
        return [];
      }

      const targetCollection = await ObjectRegistry.getCollection(
        targetClassName,
        this.options,
      );
      const targetObjects = await targetCollection.list({
        where: { 'id in': targetIds },
      });

      // Enforce tenant isolation per item before caching (Issue #1321).
      this.assertRelatedTenant(
        targetObjects,
        fieldName,
        opts?.allowCrossTenant,
      );

      this._loadedRelationships.set(fieldName, targetObjects);
      return targetObjects;
    }

    throw RuntimeError.invalidState(
      `Field ${fieldName} is not a oneToMany or manyToMany relationship`,
      { fieldName, type: relationship.type },
    );
  }

  /**
   * Resolves the junction-table coordinates for a manyToMany relationship.
   *
   * Discovers `through`, source-side column, and target-side column from the
   * registered field metadata. Falls back to convention (`<class>_id`) when
   * `sourceKey` / `targetKey` are not explicitly set.
   */
  protected async resolveManyToManyJoin(
    fieldName: string,
    relationship: {
      sourceClass: string;
      targetClass: string;
      options?: any;
    },
  ): Promise<{
    through: string;
    sourceColumn: string;
    targetColumn: string;
    targetClassName: string;
  }> {
    const decorator = ObjectRegistry.getFieldDecorator(
      relationship.sourceClass,
      fieldName,
    );
    const opts = relationship.options || {};

    const through = decorator?.through ?? opts.through ?? opts._meta?.through;
    if (!through) {
      throw RuntimeError.invalidState(
        `manyToMany field ${fieldName} on ${relationship.sourceClass} is missing the 'through' join table name`,
        { fieldName, type: 'manyToMany' },
      );
    }

    // For cross-package qualified targets, derive the simple name for column conventions
    const targetSimpleName = relationship.targetClass.includes(':')
      ? relationship.targetClass.split(':').pop()!
      : relationship.targetClass;
    const sourceSimpleName = relationship.sourceClass.includes(':')
      ? relationship.sourceClass.split(':').pop()!
      : relationship.sourceClass;

    const sourceColumn =
      decorator?.sourceKey ??
      opts.sourceKey ??
      opts._meta?.sourceKey ??
      `${toSnakeCase(sourceSimpleName)}_id`;
    const targetColumn =
      decorator?.targetKey ??
      opts.targetKey ??
      opts._meta?.targetKey ??
      `${toSnakeCase(targetSimpleName)}_id`;

    return {
      through: String(through),
      sourceColumn,
      targetColumn,
      targetClassName: relationship.targetClass,
    };
  }

  /**
   * Get a related object, loading it if not already loaded
   *
   * Convenience method that checks if the relationship is loaded and
   * loads it if necessary. Automatically detects foreignKey vs oneToMany/manyToMany.
   *
   * Tenant isolation is enforced by the underlying loaders; see
   * {@link loadRelated} and {@link loadRelatedMany}.
   *
   * @param fieldName - Name of the relationship field
   * @param opts - Optional loader options; see {@link LoadRelatedOptions}
   * @returns Promise resolving to the related object(s)
   * @throws {TenantIsolationError} If a loaded target belongs to a different,
   *   non-null tenant and `opts.allowCrossTenant` is not set
   * @example
   * ```typescript
   * // Loads customer if not already loaded
   * const customer = await order.getRelated('customerId');
   *
   * // Loads orders if not already loaded
   * const orders = await customer.getRelated('orders');
   * ```
   */
  public async getRelated(
    fieldName: string,
    opts?: LoadRelatedOptions,
  ): Promise<any> {
    if (this._loadedRelationships.has(fieldName)) {
      const cached = this._loadedRelationships.get(fieldName);
      // Re-validate cached targets so an eager `include` load cannot leak
      // cross-tenant data through this convenience accessor (Issue #1321).
      this.assertRelatedTenant(cached, fieldName, opts?.allowCrossTenant);
      return cached;
    }

    // Ensure manifest is loaded for external packages before accessing relationships
    // This is critical for cross-package relationship resolution (Issue #746)
    await ObjectRegistry.ensureManifestLoaded(this.constructor.name);

    // Determine relationship type
    const relationships = ObjectRegistry.getRelationships(
      this.constructor.name,
    );
    const relationship = relationships.find((r) => r.fieldName === fieldName);

    if (!relationship) {
      throw RuntimeError.invalidState(
        `Field ${fieldName} is not a relationship on ${this.constructor.name}`,
        { fieldName, className: this.constructor.name },
      );
    }

    // Load based on relationship type
    if (
      relationship.type === 'foreignKey' ||
      relationship.type === 'crossPackageRef'
    ) {
      return this.loadRelated(fieldName, opts);
    }

    return this.loadRelatedMany(fieldName, opts);
  }

  /**
   * Get available AI-callable tools for this object
   *
   * Returns the pre-generated tool definitions from the manifest.
   * Tools are generated at build time based on the @smrt decorator's AI config.
   *
   * @returns Array of AITool definitions for LLM function calling
   * @example
   * ```typescript
   * const tools = document.getAvailableTools();
   * console.log(`${tools.length} AI-callable methods available`);
   * ```
   */
  public getAvailableTools(): AITool[] {
    const classInfo = ObjectRegistry.getClass(this.constructor.name);
    return classInfo?.tools || [];
  }

  /**
   * Execute a tool call from AI on this object instance
   *
   * Validates the tool call against allowed methods and executes it with
   * proper error handling and timing.
   *
   * @param toolCall - Tool call from AI response
   * @returns Promise resolving to the tool call result
   * @example
   * ```typescript
   * const toolCall = {
   *   id: 'call_123',
   *   type: 'function',
   *   function: {
   *     name: 'analyze',
   *     arguments: '{"type": "detailed"}'
   *   }
   * };
   *
   * const result = await document.executeToolCall(toolCall);
   * console.log(result.success ? result.result : result.error);
   * ```
   */
  public async executeToolCall(toolCall: ToolCall): Promise<ToolCallResult> {
    const tools = this.getAvailableTools();
    const allowedMethods = tools.map((tool) => tool.function.name);

    return executeToolCallInternal(this, toolCall, allowedMethods);
  }

  /**
   * Stores a named value in the `_smrt_contexts` system table, scoped to this object.
   *
   * Context entries are keyed by `(owner_class, owner_id, scope, key, version)` and
   * support an optional `confidence` score (0–1, default 1.0) for learned patterns.
   * Calling `remember()` with the same scope+key upserts the existing entry.
   *
   * Requires `initialize()` to have been called (needs `this.systemDb`).
   *
   * @param options.id - Optional explicit ID for the context entry (auto-generated if omitted)
   * @param options.scope - Hierarchical path scoping the context (e.g. `'parser/example.com'`)
   * @param options.key - Lookup key within the scope (e.g. a normalized URL)
   * @param options.value - Any JSON-serializable value to store
   * @param options.metadata - Optional additional JSON metadata
   * @param options.confidence - Confidence score (0–1, default 1.0)
   * @param options.version - Schema version for the stored value (default 1)
   * @param options.expiresAt - Optional expiry date after which `recall()` will ignore this entry
   * @returns Promise that resolves when the context is stored
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * await agent.remember({
   *   scope: 'parser/example.com',
   *   key: normalizedUrl,
   *   value: { patterns: ['regex1', 'regex2'] },
   *   confidence: 0.9,
   * });
   * ```
   *
   * @see {@link recall} to retrieve a single entry
   * @see {@link recallAll} to retrieve all entries in a scope
   * @see {@link forget} to delete a specific entry
   */
  public async remember(options: {
    id?: string;
    scope: string;
    key: string;
    value: any;
    metadata?: any;
    confidence?: number;
    version?: number;
    expiresAt?: Date;
  }): Promise<void> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const id = options.id || crypto.randomUUID();
    const now = new Date();

    // Ensure the object has an ID - generate one if it doesn't exist
    if (!this.id) {
      this._id = crypto.randomUUID();
    }

    await this.systemDb.upsert(
      '_smrt_contexts',
      ['owner_class', 'owner_id', 'scope', 'key', 'version'],
      {
        id,
        owner_class: this._className,
        owner_id: this.id,
        scope: options.scope,
        key: options.key,
        value: JSON.stringify(options.value),
        metadata: options.metadata ? JSON.stringify(options.metadata) : null,
        version: options.version ?? 1,
        confidence: options.confidence ?? 1.0,
        created_at: now,
        updated_at: now,
        last_used_at: now,
        expires_at: options.expiresAt ?? null,
      },
    );
  }

  /**
   * Retrieves a single remembered context value for this object.
   *
   * Looks up the most recent (highest confidence, then highest version) entry
   * matching `(owner_class, owner_id, scope, key)`. Returns the JSON-parsed value
   * or `null` if no matching entry exists.
   *
   * When `includeAncestors: true`, walks up the scope hierarchy by progressively
   * removing the last path segment (e.g. `'a/b/c'` → `'a/b'` → `'a'` → `'global'`)
   * until a match is found.
   *
   * @param options.scope - Scope path to search (e.g. `'parser/example.com/article'`)
   * @param options.key - Lookup key within the scope
   * @param options.includeAncestors - If `true`, fall back to parent scopes (default `false`)
   * @param options.minConfidence - Only return entries at or above this confidence (0–1)
   * @returns The stored value (parsed from JSON), or `null` if not found
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * const strategy = await agent.recall({
   *   scope: 'parser/example.com/article',
   *   key: normalizedUrl,
   *   includeAncestors: true,
   *   minConfidence: 0.6,
   * });
   * ```
   *
   * @see {@link remember} to store a context entry
   * @see {@link recallAll} to retrieve all entries in a scope
   */
  public async recall(options: {
    scope: string;
    key: string;
    includeAncestors?: boolean;
    minConfidence?: number;
  }): Promise<any | null> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    // Use single() with template literals for custom SQL query
    let result: Record<string, any> | null;
    if (options.minConfidence !== undefined) {
      result = await this.systemDb.single`
        SELECT value, confidence
        FROM _smrt_contexts
        WHERE owner_class = ${this._className}
          AND owner_id = ${this.id}
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
        WHERE owner_class = ${this._className}
          AND owner_id = ${this.id}
          AND scope = ${options.scope}
          AND key = ${options.key}
        ORDER BY confidence DESC, version DESC
        LIMIT 1
      `;
    }

    if (result) {
      return JSON.parse(result.value);
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
   * Retrieves all remembered context entries for this object in a scope.
   *
   * Returns a `Map<key, value>` for every entry owned by this object that matches
   * the scope and optional filters. When `includeDescendants: true`, a LIKE query
   * (`scope%`) matches the scope itself and all child scopes.
   *
   * @param options.scope - Optional scope path filter; omit to retrieve all scopes
   * @param options.includeDescendants - If `true`, match `scope` and all child scopes (default `false`)
   * @param options.minConfidence - Only include entries at or above this confidence (0–1)
   * @returns `Map<string, any>` of key → JSON-parsed value pairs
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * const strategies = await agent.recallAll({
   *   scope: 'parser/example.com',
   *   minConfidence: 0.5,
   * });
   * for (const [url, pattern] of strategies) {
   *   console.log(`Cached pattern for ${url}:`, pattern);
   * }
   * ```
   *
   * @see {@link recall} to retrieve a single entry by key
   * @see {@link forgetScope} to delete all entries in a scope
   */
  public async recallAll(
    options: {
      scope?: string;
      includeDescendants?: boolean;
      minConfidence?: number;
    } = {},
  ): Promise<Map<string, any>> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    const results = new Map<string, any>();

    // Build where clause for db.list()
    const where: Record<string, any> = {
      owner_class: this._className,
      owner_id: this.id,
    };

    if (options.scope) {
      if (options.includeDescendants) {
        // Use LIKE pattern to match scope and all descendants
        // Pattern 'scope%' matches both 'scope' and 'scope/child'
        where['scope like'] = `${options.scope}%`;
      } else {
        where.scope = options.scope;
      }
    }

    if (options.minConfidence !== undefined) {
      where['confidence >='] = options.minConfidence;
    }

    const rows = await this.systemDb.list('_smrt_contexts', where);

    for (const row of rows) {
      results.set(row.key, JSON.parse(row.value));
    }

    return results;
  }

  /**
   * Deletes a specific remembered context entry for this object.
   *
   * Removes the entry matching `(owner_class, owner_id, scope, key)`. A no-op
   * if the entry does not exist.
   *
   * @param options.scope - Scope path of the entry to delete
   * @param options.key - Key of the entry to delete
   * @returns Promise that resolves when the entry is deleted
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * await agent.forget({ scope: 'parser/example.com', key: normalizedUrl });
   * ```
   *
   * @see {@link forgetScope} to delete all entries in a scope at once
   * @see {@link remember} to store a context entry
   */
  public async forget(options: { scope: string; key: string }): Promise<void> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    await this.systemDb.delete('_smrt_contexts', {
      owner_class: this._className,
      owner_id: this.id,
      scope: options.scope,
      key: options.key,
    });
  }

  /**
   * Deletes all remembered context entries in a scope for this object.
   *
   * When `includeDescendants: true`, uses a LIKE query (`scope%`) that matches
   * the scope itself and all child scopes (e.g. `'parser/example.com'` also
   * deletes `'parser/example.com/article'`).
   *
   * @param options.scope - Scope path to clear
   * @param options.includeDescendants - If `true`, also delete all child scopes (default `false`)
   * @returns Number of context entries deleted
   * @throws Error if `initialize()` has not been called
   *
   * @example
   * ```typescript
   * const count = await agent.forgetScope({
   *   scope: 'parser/example.com',
   *   includeDescendants: true,
   * });
   * console.log(`Cleared ${count} cached strategies`);
   * ```
   *
   * @see {@link forget} to delete a single entry by key
   * @see {@link recallAll} to bulk-retrieve before clearing
   */
  public async forgetScope(options: {
    scope: string;
    includeDescendants?: boolean;
  }): Promise<number> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    // Build where clause for db.delete()
    const where: Record<string, any> = {
      owner_class: this._className,
      owner_id: this.id,
    };

    if (options.includeDescendants) {
      // Use LIKE pattern to match scope and all descendants
      where['scope like'] = `${options.scope}%`;
    } else {
      where.scope = options.scope;
    }

    const result = await this.systemDb.delete('_smrt_contexts', where);
    return result.affected || 0;
  }

  // ============================================================================
  // Embedding Methods for Semantic Search
  // ============================================================================

  /**
   * Generate embeddings for configured fields
   *
   * Creates embedding vectors for fields configured in the @smrt decorator
   * and stores them in the _smrt_embeddings system table. Uses content hashing
   * to detect changes and avoid regenerating unchanged content.
   *
   * @param options - Generation options
   * @returns Promise that resolves when embeddings are generated
   * @throws Error if no embedding configuration or database not initialized
   *
   * @example
   * ```typescript
   * // Generate embeddings for all configured fields
   * await article.generateEmbeddings();
   *
   * // Generate only for specific fields
   * await article.generateEmbeddings({ fields: ['title'] });
   *
   * // Force regeneration (ignore content hash)
   * await article.generateEmbeddings({ force: true });
   * ```
   */
  public async generateEmbeddings(
    options: GenerateEmbeddingsOptions = {},
  ): Promise<void> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    if (!this.id) {
      throw new Error('Object must have an ID before generating embeddings.');
    }

    // Get embedding configuration for this class
    const config = ObjectRegistry.resolveEmbeddingConfig(this.constructor.name);
    if (!config) {
      throw new Error(
        `No embedding configuration found for ${this.constructor.name}. ` +
          `Add embeddings config to the @smrt() decorator.`,
      );
    }

    // Determine which fields to process
    const fieldsToProcess = options.fields || config.fields;
    const provider = options.provider || config.provider;
    const aiClient = await this.getOptionalAiClient();

    // Create embedding provider
    const embeddingProvider = new EmbeddingProvider(
      {
        dimensions: config.dimensions,
        provider,
        localModel: config.localModel,
        aiModel: config.aiModel,
        fallbackToAI: config.fallbackToAI,
      },
      aiClient,
    );

    // Resolve vector capabilities for native storage
    const projectConfig = ObjectRegistry.getProjectEmbeddingConfig();
    const vector =
      projectConfig?.storage === 'native' ? this.systemDb.vector : undefined;

    // Process each field
    for (const fieldName of fieldsToProcess) {
      const content = this.getPropertyValue(fieldName);
      if (!content || typeof content !== 'string') {
        continue; // Skip empty or non-string fields
      }

      // Check content hash to avoid regenerating unchanged content
      const contentHash = ContentHasher.hash(content);

      if (!options.force) {
        const existing = await EmbeddingStorage.get(
          this.systemDb,
          this.constructor.name,
          this.id,
          fieldName,
          embeddingProvider.getModelName(),
        );

        if (existing && existing.content_hash === contentHash) {
          continue; // Content unchanged, skip regeneration
        }
      }

      // Generate embedding
      const embeddings = await embeddingProvider.embed(content);
      const embedding = embeddings[0];

      // Store embedding (with optional native vector storage)
      await EmbeddingStorage.upsert(
        this.systemDb,
        {
          objectClass: this.constructor.name,
          objectId: this.id,
          fieldName,
          contentHash,
          embedding,
          model: embeddingProvider.getModelName(),
          dimensions: config.dimensions,
          provider,
        },
        vector,
      );
    }

    // Handle combined field if configured
    if (config.combinedField) {
      const { name, template } = config.combinedField;

      // Build combined content from template
      let combinedContent = template;
      for (const fieldName of config.fields) {
        const value = this.getPropertyValue(fieldName) || '';
        combinedContent = combinedContent.replace(
          new RegExp(`\\{${fieldName}\\}`, 'g'),
          String(value),
        );
      }

      if (combinedContent.trim()) {
        const contentHash = ContentHasher.hash(combinedContent);

        if (!options.force) {
          const existing = await EmbeddingStorage.get(
            this.systemDb,
            this.constructor.name,
            this.id,
            name,
            embeddingProvider.getModelName(),
          );

          if (existing && existing.content_hash === contentHash) {
            return; // Combined content unchanged
          }
        }

        const embeddings = await embeddingProvider.embed(combinedContent);
        const embedding = embeddings[0];

        await EmbeddingStorage.upsert(
          this.systemDb,
          {
            objectClass: this.constructor.name,
            objectId: this.id,
            fieldName: name,
            contentHash,
            embedding,
            model: embeddingProvider.getModelName(),
            dimensions: config.dimensions,
            provider,
          },
          vector,
        );
      }
    }
  }

  /**
   * Get stored embedding for a field
   *
   * Retrieves the embedding vector for a specific field from storage.
   * Returns null if no embedding exists for the field.
   *
   * @param fieldName - Name of the field to get embedding for
   * @param model - Optional model name (defaults to configured model)
   * @returns Promise resolving to embedding vector or null
   *
   * @example
   * ```typescript
   * const embedding = await article.getEmbedding('title');
   * if (embedding) {
   *   console.log(`Embedding has ${embedding.length} dimensions`);
   * }
   * ```
   */
  public async getEmbedding(
    fieldName: string,
    model?: string,
  ): Promise<number[] | null> {
    if (!this.systemDb) {
      throw new Error('Database not initialized. Call initialize() first.');
    }

    if (!this.id) {
      return null;
    }

    // Determine model name using EmbeddingProvider for consistency with generateEmbeddings()
    let modelName = model;
    if (!modelName) {
      const config = ObjectRegistry.resolveEmbeddingConfig(
        this.constructor.name,
      );
      if (config) {
        const aiClient = await this.getOptionalAiClient();
        // Create EmbeddingProvider to get consistent model name
        const provider = new EmbeddingProvider(
          {
            dimensions: config.dimensions,
            provider: config.provider,
            localModel: config.localModel,
            aiModel: config.aiModel,
            fallbackToAI: config.fallbackToAI,
          },
          aiClient,
        );
        modelName = provider.getModelName();
      } else {
        // Fallback to default
        modelName = 'Xenova/bge-base-en-v1.5';
      }
    }

    const stored = await EmbeddingStorage.get(
      this.systemDb,
      this.constructor.name,
      this.id,
      fieldName,
      modelName,
    );

    return stored?.embedding || null;
  }

  /**
   * Check if any embeddings are stale (content has changed)
   *
   * Compares content hashes of configured fields with stored embeddings
   * to determine if regeneration is needed.
   *
   * @returns Promise resolving to true if any embeddings are stale
   *
   * @example
   * ```typescript
   * if (await article.hasStaleEmbeddings()) {
   *   await article.generateEmbeddings();
   * }
   * ```
   */
  public async hasStaleEmbeddings(): Promise<boolean> {
    if (!this.systemDb || !this.id) {
      return false;
    }

    const config = ObjectRegistry.resolveEmbeddingConfig(this.constructor.name);
    if (!config) {
      return false;
    }

    const aiClient = await this.getOptionalAiClient();
    const embeddingProvider = new EmbeddingProvider(
      {
        dimensions: config.dimensions,
        provider: config.provider,
        localModel: config.localModel,
        aiModel: config.aiModel,
        fallbackToAI: config.fallbackToAI,
      },
      aiClient,
    );
    const modelName = embeddingProvider.getModelName();

    // Get stored embeddings for this object
    const storedEmbeddings = await EmbeddingStorage.getForObject(
      this.systemDb,
      this.constructor.name,
      this.id,
    );

    // Check each configured field
    for (const fieldName of config.fields) {
      const content = this.getPropertyValue(fieldName);
      if (!content || typeof content !== 'string') {
        continue;
      }

      const currentHash = ContentHasher.hash(content);
      const stored = storedEmbeddings.find(
        (e) => e.field_name === fieldName && e.model === modelName,
      );

      if (!stored) {
        return true; // No embedding exists for the current provider/model
      }

      if (stored.content_hash !== currentHash) {
        return true; // Content has changed
      }
    }

    // Check combined field if configured
    if (config.combinedField) {
      let combinedContent = config.combinedField.template;
      for (const fieldName of config.fields) {
        const value = this.getPropertyValue(fieldName) || '';
        combinedContent = combinedContent.replace(
          new RegExp(`\\{${fieldName}\\}`, 'g'),
          String(value),
        );
      }

      const currentHash = ContentHasher.hash(combinedContent);
      const stored = storedEmbeddings.find(
        (e) =>
          e.field_name === config.combinedField?.name && e.model === modelName,
      );

      if (!stored || stored.content_hash !== currentHash) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clear all embeddings for this object
   *
   * Removes all stored embeddings from the _smrt_embeddings table.
   * Useful when deleting objects or resetting embedding state.
   *
   * @returns Promise that resolves when embeddings are cleared
   *
   * @example
   * ```typescript
   * await article.clearEmbeddings();
   * ```
   */
  public async clearEmbeddings(): Promise<void> {
    if (!this.systemDb || !this.id) {
      return;
    }

    await EmbeddingStorage.deleteForObject(
      this.systemDb,
      this.constructor.name,
      this.id,
    );
  }
}
