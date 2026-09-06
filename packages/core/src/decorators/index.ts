/**
 * Field decorators for SMRT objects
 *
 * Modern decorator-based API for defining SMRT object properties.
 * Properties are typed as primitives with decorator metadata.
 */

import type {
  CustomActionScope,
  ToolEffect,
} from '../generators/custom-action.js';
import type { ApiHttpMethod } from '../registry/types.js';
import { ObjectRegistry } from '../registry.js';
import type { FieldUIHints } from '../scanner/types.js';
import type { SQLDataType } from '../schema/types.js';
import {
  type CompatibleMethodDecorator,
  type CompatibleMethodDecoratorContext,
  type CompatiblePropertyDecorator,
  type CompatiblePropertyDecoratorContext,
  type LegacyPropertyDecoratorTarget,
  registerCompatibleFieldDecorator,
  registerCompatibleMethodDecorator,
} from './compatibility.js';

export type { FieldUIHints } from '../scanner/types.js';

/**
 * Meta type wrapper for STI (Single Table Inheritance) meta fields
 *
 * Fields typed as Meta<T> are stored in the _meta_data JSONB column
 * rather than as direct table columns. Used for child-specific fields
 * in STI hierarchies.
 *
 * @example
 * ```typescript
 * @smrt({ tableStrategy: 'sti' })
 * class Event extends SmrtObject {
 *   title: string = '';
 * }
 *
 * @smrt()
 * class Meeting extends Event {
 *   // Stored in _meta_data JSONB column
 *   roomNumber: Meta<string> = '';
 *   attendees: Meta<string[]> = [];
 * }
 * ```
 */
export type Meta<T> = T;

/**
 * Base field options
 */
export type PrimitiveFieldType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json';

export type FieldType =
  | PrimitiveFieldType
  | 'meta'
  | 'foreignKey'
  | 'crossPackageRef'
  | 'oneToMany'
  | 'manyToMany';

export interface FieldOptions {
  /** Explicit field type for runtime-only registration paths */
  type?: FieldType;
  /** Explicit SQL storage type when runtime and persistence contracts differ */
  sqlType?: SQLDataType;
  /** Whether the field is required */
  required?: boolean;
  /** Default value for the field */
  default?: unknown;
  /** Whether the field is unique */
  unique?: boolean;
  /**
   * When `true`, the schema emits a database index targeting this field.
   *
   * For regular (column-backed) fields the index is a plain column index.
   * For `@meta()` fields stored inside `_meta_data` JSONB, the index targets
   * the JSON path — `json_extract(_meta_data, '$.fieldName')` on SQLite,
   * `(_meta_data->>'fieldName')` on Postgres.
   *
   * Note that `collection.list({ where })` cannot currently reach a JSON-path
   * index: dot-notation keys such as `_meta_data.fieldName` are rejected,
   * because nothing rewrites them into the matching extraction expression
   * (#2276, tracked in #2282). The index is still emitted and still serves
   * hand-written SQL that spells the expression out; it just has no
   * collection-level query to accelerate yet.
   */
  indexed?: boolean;
  /** Whether the field is nullable */
  nullable?: boolean;
  /** Whether the field should be excluded from database */
  transient?: boolean;
  /**
   * Marks the field as sensitive (e.g. API secrets, credentials, tax IDs).
   *
   * Sensitive fields are still persisted to the database, but the framework:
   * - excludes them from `toPublicJSON()` (the serializer used by generated
   *   REST/MCP/SvelteKit routes), so they never appear in API responses; and
   * - rejects them as `where`-clause filter keys, closing the
   *   `?secret[like]=...` value-probing oracle.
   *
   * Use this for any column that holds a secret value that must never be
   * read back over a generated network surface.
   */
  sensitive?: boolean;
  /**
   * Marks the field as read-only over generated write surfaces.
   *
   * Read-only fields are stripped from the request body before
   * `create`/`update` in generated REST/MCP/SvelteKit routes, so callers
   * cannot mass-assign them. Server-side code can still set them directly.
   */
  readonly?: boolean;
  /**
   * Permission slug required to include this field in public/read responses.
   *
   * Fields with a read permission are fail-closed: generated serializers omit
   * them unless the caller's resolved permission set contains this slug.
   * `sensitive: true` still wins and omits the field for every caller.
   */
  readPermission?: string;
  /** Field description */
  description?: string;
  /**
   * Static UI hints for the field-policy rail (#2046, epic #2045).
   *
   * A pure presentation seed — carried in the manifest under the field's
   * `_meta.ui`, readable at runtime via `getAllFields()` at `field._meta.ui`,
   * and emitted to the browser in generated web-collection definitions. Has no
   * schema, persistence, or security effect; `sensitive`/`readPermission`
   * remain the security rail.
   */
  ui?: FieldUIHints;
  /**
   * Controls whether the field is included in JSON exports.
   * - `true`: Always exported (unless site explicitly excludes it)
   * - `false`: Never exported (cannot be overridden by site config)
   * - `undefined`: Uses site's fieldExportDefault setting
   */
  exported?: boolean;
}

/**
 * Options for text fields
 */
export interface TextFieldOptions extends FieldOptions {
  /** Minimum length for text fields */
  minLength?: number;
  /** Maximum length for text fields */
  maxLength?: number;
  /** Regex pattern for validation */
  pattern?: RegExp | string;
}

/**
 * Options for numeric fields
 */
export interface NumericFieldOptions extends FieldOptions {
  /** Minimum value */
  min?: number;
  /** Maximum value */
  max?: number;
}

/**
 * Options for relationship fields
 */
export interface RelationshipFieldOptions extends FieldOptions {
  /** Related class name */
  related?: string;
  /** Foreign key field name */
  foreignKey?: string;
  /** Through table for many-to-many */
  through?: string;
  /** Relationship type */
  type?: 'foreignKey' | 'crossPackageRef' | 'oneToMany' | 'manyToMany';
  /**
   * What happens to this row when the referenced object is deleted (#2371).
   *
   * Same-package references emit this DB-level action and `SmrtObject.delete()`
   * enforces the same policy in the application layer:
   *
   * - `'CASCADE'` — this row is deleted with the target.
   * - `'SET NULL'` — this column is set to `NULL`. The field must be nullable;
   *   declaring it on a `required` field throws `ConfigurationError`.
   * - `'RESTRICT'` — deleting the target throws `DatabaseError` while any row
   *   still points at it.
   *
   * When omitted, a column that is part of this class's `conflictColumns`
   * (junction and association rows, which are *identified* by the reference)
   * defaults to `CASCADE`; every other same-package column defaults to
   * immediate `NO ACTION`.
   * `@tenantId()` fields are the one exception: `smrt-tenancy` leads a
   * tenant-scoped class's default `conflictColumns` with the tenant column,
   * but that column scopes ownership rather than identifying the row, so it
   * is never defaulted to `CASCADE` — deleting a `Tenant` must not cascade
   * through every tenant-scoped table.
   *
   * Cascaded rows are removed set-based: their `beforeDelete`/`afterDelete`
   * hooks and interceptors do not run and no change-feed entry is written, the
   * same as a database-level `ON DELETE CASCADE`.
   */
  onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
  /**
   * Set to `false` only for an app-side relationship whose target identifier
   * must deliberately survive without a database parent row (for example an
   * immutable audit/event record retained after its parent is pruned).
   *
   * The field remains a typed `foreignKey` relationship for loading and
   * indexes, but no physical DDL constraint, schema dependency, or app-side
   * delete action is emitted. The stored identifier is deliberately preserved
   * after the parent is deleted. Ordinary same-package relationships must leave
   * this enabled (the default).
   */
  constraint?:
    | boolean
    | {
        /**
         * Database engines on which SMRT emits the physical constraint.
         *
         * Relationship loading, UUID storage, indexes, and application-side
         * delete enforcement remain active on every engine. Use this narrow
         * allowlist only when an engine cannot faithfully enforce a supported
         * relationship shape (for example a DuckDB self-reference).
         */
        engines: Array<'postgres' | 'sqlite' | 'duckdb' | 'json'>;
      };
}

/**
 * Options specific to cross-package references.
 */
export interface CrossPackageRefOptions
  extends Omit<RelationshipFieldOptions, 'related' | 'type'> {
  /**
   * Storage type for the referenced target id. Defaults to 'uuid'.
   *
   * Use 'text' only when the external target model declares
   * `@smrt({ idType: 'text' })`.
   */
  idType?: 'uuid' | 'text';

  /**
   * When `true`, the framework verifies the referenced object exists at save time.
   * Validation uses the target package's manifest (loaded on demand via
   * `ObjectRegistry.ensureManifestLoaded()`), so this requires the target manifest
   * to be discoverable at runtime.
   *
   * Empty/null values are always allowed (treated as "no reference set").
   *
   * Defaults to `false` — same behavior as a plain string field today.
   */
  validate?: boolean;
}

/**
 * Resolve a relationship decorator's target argument to a class name.
 *
 * Accepted target forms:
 * - `'Target'` — class name string; resolves lazily, immune to import cycles.
 * - `Target` — class constructor.
 * - `() => Target` — thunk (inline or a named `const`), invoked here to read
 *   the name, so its target must already be initialized.
 *
 * A thunk's own `.name` is `''`, so reading `relatedClass.name` used to register
 * `related: ''` (issue #2379): the field kept `type: 'foreignKey'` but lost its
 * target, which silently dropped the relationship edge, `loadRelated()`, and any
 * FK-derived index. Thunks are therefore invoked at decoration time and an
 * unresolvable target throws with the string form as the remedy — an empty
 * `related` is never registered.
 *
 * Resolution runs inside the field-registration callback, which is the latest
 * point in the decorator lifecycle (after the class binding exists for legacy
 * decorators, and at `@smrt()` application time for standard decorators), so a
 * self-referential `() => Self` thunk resolves rather than hitting the TDZ.
 * A thunk pointing at a class declared LATER in the same module is still in
 * that class's temporal dead zone when the decorators of the earlier class run;
 * that now fails loudly, naming the string form, instead of silently
 * registering an empty target.
 */
function resolveRelatedClassName(
  decoratorName: 'foreignKey' | 'oneToMany' | 'manyToMany',
  relatedClass: string | Function,
  className: string,
  propertyKey: string,
): string {
  const where = `@${decoratorName}() on ${className}.${propertyKey}`;
  const remedy =
    `Pass the target class name as a string instead — ` +
    `\`@${decoratorName}('Target')\` resolves lazily and is immune to import cycles.`;

  if (typeof relatedClass === 'string') {
    const name = relatedClass.trim();
    if (!name) {
      throw new Error(
        `${where}: target class name is empty. Pass a class, a class name, or a \`() => Target\` thunk.`,
      );
    }
    return name;
  }

  if (typeof relatedClass !== 'function') {
    throw new Error(
      `${where}: expected a class, a class name, or a \`() => Target\` thunk, received ${relatedClass === null ? 'null' : typeof relatedClass}. ${remedy}`,
    );
  }

  // Class/function reference — the common `@foreignKey(Target)` form. Arrow
  // functions have no `prototype`, so a *named* thunk (`const lazyTarget = () =>
  // Target`) is still routed to the thunk branch below instead of registering
  // the variable name as the target class.
  if (relatedClass.name && relatedClass.prototype !== undefined) {
    return relatedClass.name;
  }

  // Thunk (`() => Target`, named or inline) — invoke it for the target.
  let resolved: unknown;
  try {
    resolved = (relatedClass as () => unknown)();
  } catch (error) {
    throw new Error(
      `${where}: the \`() => Target\` thunk threw while resolving its target (${
        error instanceof Error ? error.message : String(error)
      }). ${remedy}`,
      { cause: error },
    );
  }

  if (typeof resolved === 'function' && resolved.name) {
    return resolved.name;
  }
  if (typeof resolved === 'string' && resolved.trim()) {
    return resolved.trim();
  }

  throw new Error(
    `${where}: the \`() => Target\` thunk resolved to ${
      resolved === null ? 'null' : typeof resolved
    } instead of a named class. ${remedy}`,
  );
}

/**
 * Marks a class property with validation constraints and metadata options.
 *
 * Use `@field()` when you need options beyond what plain TypeScript initializers
 * express — required validation, numeric ranges, string length limits, uniqueness,
 * or transient (non-persisted) computed properties.
 *
 * For plain persisted fields with no constraints, no decorator is needed: just
 * declare the property with a TypeScript initializer and the framework will infer
 * the column type from the default value (`0` → INTEGER, `0.0` → DECIMAL, `''` → TEXT).
 *
 * @param options - Field configuration options
 * @param options.required - If `true`, `save()` throws `ValidationError` when empty/null
 * @param options.unique - Enforces a UNIQUE database constraint
 * @param options.nullable - If `true`, the column accepts NULL (default depends on type)
 * @param options.transient - If `true`, the property is not persisted to the database
 * @param options.default - Default value applied at the database level
 * @param options.description - Human-readable description used in generated API docs
 * @param options.exported - Controls JSON export visibility (see `FieldOptions`)
 * @returns A TypeScript property decorator
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   @field({ required: true, maxLength: 100 })
 *   name: string = '';
 *
 *   @field({ min: 0 })
 *   stock: number = 0;
 *
 *   @field({ transient: true })
 *   get displayPrice(): string { return `$${this.price.toFixed(2)}`; }
 * }
 * ```
 *
 * @see {@link meta} for STI child-specific fields stored in `_meta_data` JSON
 * @see {@link foreignKey} for typed relationship fields
 */
export function field(
  options: FieldOptions | NumericFieldOptions | TextFieldOptions = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<unknown, unknown>,
  ) => {
    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, options);
      },
    );
  }) as CompatiblePropertyDecorator;
}

/**
 * Declares a many-to-one (foreign key) relationship to another `SmrtObject` class.
 *
 * The decorated property stores the UUID of the related object. At runtime, call
 * `instance.loadRelated('fieldName')` to lazy-load (and cache) the related object,
 * or pass `include: ['fieldName']` to `collection.list()` for batch eager loading.
 *
 * Cross-package rule: Use `@foreignKey()` only for same-package references.
 * Use `@crossPackageRef()` for cross-package relationships.
 *
 * A named database constraint is emitted on supported engines by default, and
 * the same action is enforced by `SmrtObject.delete()` before the engine sees
 * it. Exceptional archival/audit references that intentionally outlive their
 * parent may declare `{ constraint: false }`; they retain relationship loading
 * and indexing while deliberately preserving the identifier after parent
 * deletion and omitting physical DDL. The
 * decorator also enables `loadRelated()` and eager `include:` loading:
 *
 * ```typescript
 * @foreignKey(Order, { onDelete: 'CASCADE' })   // deleted with the order
 * orderId: string = '';
 *
 * @foreignKey(Customer, { onDelete: 'RESTRICT' }) // blocks the customer delete
 * customerId: string = '';
 * ```
 *
 * Without an `onDelete`, a column that is part of this class's
 * `conflictColumns` defaults to `CASCADE` (this is what cleans up junction
 * rows); any other column defaults to immediate `NO ACTION`.
 *
 * @param relatedClass - The target class constructor, its name as a string, or a
 *   `() => Target` thunk. A thunk is **invoked at decoration time**, so its
 *   target must already be initialized: a class from an already-evaluated module
 *   or the decorated class itself. Use the string form for a class declared
 *   later in the same module or reached through an import cycle — it is never
 *   evaluated, so it cannot hit the temporal dead zone.
 * @param options - Optional field constraints (required, nullable, etc.)
 * @returns A TypeScript property decorator
 * @throws Error when the target cannot be resolved to a class name (an empty
 *   string, a thunk that throws — including on an uninitialized target — or a
 *   thunk returning an anonymous value)
 *
 * @example
 * ```typescript
 * @smrt()
 * class Order extends SmrtObject {
 *   // Same-package FK — enables loadRelated() and eager loading
 *   @foreignKey(Customer)
 *   customerId: string = '';
 *
 *   // Self-reference: the class binding exists when its decorators run
 *   @foreignKey(() => Order)
 *   parentOrderId: string = '';
 *
 *   // Declared later in this module — name string, never evaluated
 *   @foreignKey('Invoice')
 *   invoiceId: string = '';
 *
 *   // Physical constraint only where the engine can enforce this shape;
 *   // relationship loading and app-side delete policy remain cross-engine.
 *   @foreignKey('Order', {
 *     constraint: { engines: ['postgres', 'sqlite'] },
 *   })
 *   hierarchyParentId: string | null = null;
 * }
 *
 * // Cross-package: runtime relationship, index, and loading; no physical FK
 * @smrt()
 * class Post extends SmrtObject {
 *   @crossPackageRef('@happyvertical/smrt-users:User')
 *   authorId: string = '';
 * }
 * ```
 *
 * @see {@link oneToMany} for the inverse (parent) side of the relationship
 * @see SmrtObject.loadRelated for lazy-loading the related object at runtime
 */
export function foreignKey(
  relatedClass: string | Function,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<unknown, unknown>,
  ) => {
    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          ...options,
          type: 'foreignKey',
          related: resolveRelatedClassName(
            'foreignKey',
            relatedClass,
            className,
            propertyKey,
          ),
        });
      },
    );
  }) as CompatiblePropertyDecorator;
}

/**
 * Declares a cross-package foreign key reference.
 *
 * Use this for relationships that point to a `SmrtObject` in a *different* package
 * (e.g. `Customer.profileId` pointing at `@happyvertical/smrt-profiles:Profile`).
 *
 * Unlike same-package `@foreignKey()`, this emits **no** DDL `FOREIGN KEY`
 * constraint, keeping package schemas independently installable. The property is a
 * `UUID` column on PostgreSQL/DuckDB and `TEXT` on SQLite, matching the target's
 * id type; pass `{ idType: 'text' }` when the target declares
 * `@smrt({ idType: 'text' })`.
 *
 * What you get over a plain string field:
 * - The relationship is registered with the `ObjectRegistry`, so `loadRelated()`
 *   and `Collection.list({ include })` can resolve it once the target package's
 *   manifest is loaded.
 * - No physical database constraint is emitted; package schemas remain
 *   independently installable.
 * - Optional save-time validation (`validate: true`) confirms the referenced
 *   object exists, catching typos and stale IDs before they hit the database.
 * - `onDelete` is honoured by `SmrtObject.delete()` when the target package's
 *   manifest is loaded in the same runtime.
 *
 * The `qualifiedName` is a fully-qualified class identifier in the form
 * `@package/scope:ClassName` — for example `@happyvertical/smrt-profiles:Profile`.
 *
 * @param qualifiedName - Qualified name of the target class
 * @param options - Optional field constraints and `validate` flag
 * @returns A TypeScript property decorator
 *
 * @example
 * ```typescript
 * @smrt()
 * class Customer extends SmrtObject {
 *   @crossPackageRef('@happyvertical/smrt-profiles:Profile')
 *   profileId: string = '';
 *
 *   // With save-time validation
 *   @crossPackageRef('@happyvertical/smrt-profiles:Profile', { validate: true })
 *   primaryContactId: string = '';
 * }
 * ```
 *
 * @see {@link foreignKey} for same-package relationships
 * @see SmrtObject.loadRelated for runtime resolution
 */
export function crossPackageRef(
  qualifiedName: string,
  options: CrossPackageRefOptions = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<unknown, unknown>,
  ) => {
    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          ...options,
          type: 'crossPackageRef',
          related: qualifiedName,
        });
      },
    );
  }) as CompatiblePropertyDecorator;
}

/**
 * Declares a one-to-many relationship from this object to a collection of related objects.
 *
 * The decorated property is `transient` — it is not persisted as a database column.
 * At runtime, call `instance.loadRelatedMany('fieldName')` to load the related objects,
 * or pass `include: ['fieldName']` to `collection.list()` for batch eager loading (issues
 * a single batched query for all instances instead of N individual queries).
 *
 * The inverse side (`@foreignKey`) must exist on the `relatedClass` pointing back to this
 * class. The framework discovers it automatically via `ObjectRegistry.getInverseRelationships()`.
 *
 * **Generated accessor (R10):** registering the class installs a consistent
 * `get<FieldName>()` instance method (e.g. `items` → `order.getItems()`) that
 * delegates to `loadRelatedMany('items')`. Generation is additive — a
 * hand-rolled method of the same name is never overwritten.
 *
 * **Disambiguation:** when `relatedClass` declares more than one `@foreignKey`
 * back to this class, pass `{ foreignKey: '<inverseFieldName>' }` so both
 * `loadRelatedMany` and the generated accessor resolve the intended inverse
 * side. Without it the first matching foreign key is used.
 *
 * **Delete behaviour is declared on the child, not here.** `@oneToMany` is a
 * transient read-side accessor; to have children removed with their parent,
 * put `onDelete: 'CASCADE'` on the inverse `@foreignKey` (#2371):
 *
 * ```typescript
 * class OrderItem extends SmrtObject {
 *   @foreignKey(Order, { onDelete: 'CASCADE' })
 *   orderId: string = '';
 * }
 * ```
 *
 * @param relatedClass - The class constructor of the child/related objects
 * @param options - Optional relationship options. `foreignKey` selects the
 *   inverse foreign-key field on `relatedClass` when it has more than one.
 * @returns A TypeScript property decorator (sets `transient: true` automatically)
 *
 * @example
 * ```typescript
 * @smrt()
 * class Order extends SmrtObject {
 *   @oneToMany(OrderItem)
 *   items: OrderItem[] = [];
 * }
 *
 * @smrt()
 * class OrderItem extends SmrtObject {
 *   @foreignKey(Order)
 *   orderId: string = '';
 * }
 *
 * const order = await orders.get({ id });
 * const items = await order.getItems(); // generated; === loadRelatedMany('items')
 * ```
 *
 * @example
 * ```typescript
 * // Multiple inverse foreign keys → disambiguate explicitly.
 * @smrt()
 * class Profile extends SmrtObject {
 *   @oneToMany(ProfileRelationship, { foreignKey: 'fromProfileId' })
 *   relationshipsFrom: ProfileRelationship[] = [];
 *   @oneToMany(ProfileRelationship, { foreignKey: 'toProfileId' })
 *   relationshipsTo: ProfileRelationship[] = [];
 * }
 * ```
 *
 * @see {@link foreignKey} for the many-to-one (child) side of the relationship
 * @see SmrtObject.loadRelatedMany for lazy-loading at runtime
 */
export function oneToMany(
  relatedClass: string | Function,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<unknown, unknown>,
  ) => {
    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          ...options,
          type: 'oneToMany',
          related: resolveRelatedClassName(
            'oneToMany',
            relatedClass,
            className,
            propertyKey,
          ),
          transient: true, // Relationship fields are not database columns
        });
      },
    );
  }) as CompatiblePropertyDecorator;
}

/**
 * Declares a many-to-many relationship between two `SmrtObject` classes via a join table.
 *
 * The decorated property is `transient` — it is not persisted as a database column.
 * The `through` option specifies the junction table name. The join table model must
 * be decorated with `@smrt({ conflictColumns: ['...', '...'] })` to use the natural
 * key columns for upsert operations.
 *
 * Runtime loading: call `instance.loadRelatedMany('field')` to lazy-load, or
 * pass `include: ['field']` to `collection.list()` for batched eager loading.
 *
 * @param relatedClass - The class constructor of the related objects
 * @param options - Relationship options; `through` specifies the junction table name
 * @returns A TypeScript property decorator (sets `transient: true` automatically)
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   @manyToMany(Tag, { through: 'product_tags' })
 *   tags: Tag[] = [];
 * }
 * ```
 *
 * @see {@link oneToMany} for one-to-many relationships
 */
export function manyToMany(
  relatedClass: string | Function,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<unknown, unknown>,
  ) => {
    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          ...options,
          type: 'manyToMany',
          related: resolveRelatedClassName(
            'manyToMany',
            relatedClass,
            className,
            propertyKey,
          ),
          transient: true, // Relationship fields are not database columns
        });
      },
    );
  }) as CompatiblePropertyDecorator;
}

/**
 * Marks a field as a Single Table Inheritance (STI) meta field.
 *
 * Meta fields are stored in the `_meta_data` JSONB column on the shared STI
 * table rather than as dedicated table columns. Use this decorator for fields
 * that are specific to an STI child class and should not pollute the shared
 * table schema with child-specific columns.
 *
 * The `@smrt({ tableStrategy: 'sti' })` decorator must be set on the base class.
 * All child-specific fields should use `@meta()` (or the `Meta<T>` type alias).
 *
 * @param options - Standard field options (required, nullable, description, etc.)
 * @returns A TypeScript property decorator (registers field with `type: 'meta'`)
 *
 * @example
 * ```typescript
 * @smrt({ tableStrategy: 'sti' })
 * class Event extends SmrtObject {
 *   title: string = ''; // shared column on events table
 * }
 *
 * @smrt()
 * class Meeting extends Event {
 *   @meta()
 *   roomNumber: string = ''; // stored in _meta_data JSON, not a column
 *
 *   @meta({ required: true })
 *   durationMinutes: number = 60;
 * }
 * ```
 *
 * @see {@link Meta} for the equivalent type alias approach
 * @see {@link field} for regular (non-STI) field declarations
 */
export function meta(options: FieldOptions = {}) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<unknown, unknown>,
  ) => {
    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          ...options,
          type: 'meta', // Mark this field as a meta field for STI
        });
      },
    );
  }) as CompatiblePropertyDecorator;
}

/**
 * Options for {@link method}.
 *
 * Every option is optional, and an omitted one falls back to the class-level
 * `api.routes[methodName]` entry (or `ai.descriptions[methodName]` for
 * `description`) when one exists. The merge is FIELD BY FIELD, so adding
 * `@method({ description })` to a class that already declares a route verb and
 * path does not reset them (#2686).
 */
export interface MethodOptions {
  /**
   * Override the default routing decision.
   *
   * Public methods are routed by default when they are WIRE-ABLE: every
   * parameter can be built from a JSON request body or query string. Set
   * `false` to withhold a method the heuristic accepted, `true` to expose one
   * it rejected.
   *
   * `true` bypasses the heuristic and NOTHING else. It cannot manufacture a
   * receiver, undo `api: false`, cross an `include`/`exclude` boundary, reach a
   * non-public method, claim a CRUD verb, or hydrate a value the transport
   * cannot build — a model-instance parameter still arrives as whatever JSON
   * the caller sent.
   */
  expose?: boolean;

  /**
   * Why the method is withheld. Recorded in the knowledge artifact so
   * `smrt doctor` and agents read an explanation instead of silence.
   */
  reason?: string;

  /**
   * HTTP verb for the generated route. Defaults to `POST`.
   *
   * Named `httpMethod`, not `method`: RFC 9110 calls this the request
   * "method", so the protocol word is exactly the one that collides with the
   * decorator's own name, and `@method({ method: 'POST' })` stutters.
   * `httpMethod` is also already this framework's name for it — `ApiHttpMethod`
   * is carried across the whole discovery/invoke path.
   *
   * Migrates from `api.routes[methodName].method`.
   */
  httpMethod?: ApiHttpMethod;

  /**
   * Route path segment(s), used verbatim and split on `/`.
   * Defaults to the method name. Migrates from `api.routes[methodName].path`.
   */
  path?: string;

  /**
   * Declared receiver scope. Migrates from `api.routes[methodName].scope`.
   *
   * A DECLARATION checked against the method's executable receiver, not a
   * relocation: an instance method is item-scoped and a static (or
   * collection-class) method is collection-scoped, and no config can change
   * that. A contradicting value is reported at build time and ignored.
   */
  scope?: CustomActionScope;

  /**
   * Agent-visible effect classification. Omitted actions are treated as
   * `destructive`, so missing metadata can never widen browser capability
   * exposure. Migrates from `api.routes[methodName].effect`.
   */
  effect?: ToolEffect;

  /** Whether repeating the action with the same arguments is safe. */
  idempotent?: boolean;

  /** Whether the action may interact outside the SMRT application. */
  openWorld?: boolean;

  /**
   * Description used by AI/tool surfaces, overriding the method's JSDoc.
   * Migrates from `ai.descriptions[methodName]`.
   */
  description?: string;
}

/**
 * Refines how a method is exposed on generated surfaces.
 *
 * The method counterpart of {@link field}, and symmetric with it: a manifest
 * records exactly two collections per object, `fields` and `methods`. Neither
 * decorator DECLARES its member — a property is a field because it is a
 * property, and a method is a candidate action because it is public — both
 * REFINE what the framework already inferred. `@field()` refines an inferred
 * column type and constraints; `@method()` refines inferred exposure, its
 * route shape, and its tool semantics.
 *
 * The name is `@method()` rather than `@action()` because of the negative
 * case: withholding a method has to read correctly, and
 * `@action({ expose: false })` contradicts itself — declaring something an
 * action in order to say it is not one. "Action" keeps its established meaning
 * in the generators (a non-CRUD method exposed on a surface); this decorator
 * is how a method BECOMES one.
 *
 * Metadata only: the decorated method is not wrapped and keeps its identity,
 * so it stays directly callable.
 *
 * @example Shape the generated route
 * ```typescript
 * @method({ httpMethod: 'POST', path: 'reviews', effect: 'write' })
 * async runReview(options?: RunContentReviewOptions) { … }
 * ```
 *
 * @example Withhold a method the heuristic would have routed
 * ```typescript
 * @method({ expose: false, reason: 'callback registration, not a wire operation' })
 * static registerValidator(validator: ValidatorFunction) { … }
 * ```
 *
 * @example Force a route the heuristic rejected
 * ```typescript
 * // `expose: true` bypasses the heuristic only — this method must still
 * // accept whatever JSON the caller sends for `asset`.
 * @method({ expose: true })
 * async addAsset(asset: Asset) { … }
 * ```
 *
 * @see {@link field} for the property-side refinement decorator
 */
export function method(options: MethodOptions = {}) {
  return ((
    targetOrValue: unknown,
    propertyKeyOrContext: CompatibleMethodDecoratorContext<
      unknown,
      // biome-ignore lint/suspicious/noExplicitAny: mirrors the lib's own `ClassMethodDecoratorContext` constraint; see `AnyMethodOf` in `compatibility.ts`. S4 #1579.
      (this: unknown, ...args: any) => any
    >,
  ) => {
    registerCompatibleMethodDecorator(
      targetOrValue as LegacyPropertyDecoratorTarget | undefined,
      propertyKeyOrContext,
      (ctor, methodName) => {
        ObjectRegistry.registerMethodDecorator(ctor, methodName, options);
      },
    );
  }) as CompatibleMethodDecorator;
}
