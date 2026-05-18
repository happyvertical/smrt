/**
 * Field decorators for SMRT objects
 *
 * Modern decorator-based API for defining SMRT object properties.
 * Properties are typed as primitives with decorator metadata.
 */

import { ObjectRegistry } from '../registry.js';
import type { SQLDataType } from '../schema/types.js';
import {
  type CompatiblePropertyDecorator,
  type CompatiblePropertyDecoratorContext,
  type LegacyPropertyDecoratorTarget,
  registerCompatibleFieldDecorator,
} from './compatibility.js';

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
  default?: any;
  /** Whether the field is unique */
  unique?: boolean;
  /** Whether the field is nullable */
  nullable?: boolean;
  /** Whether the field should be excluded from database */
  transient?: boolean;
  /** Field description */
  description?: string;
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
}

/**
 * Options specific to cross-package references.
 */
export interface CrossPackageRefOptions
  extends Omit<RelationshipFieldOptions, 'related' | 'type'> {
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
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<any, any>,
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
 * For cross-package foreign keys, use a plain `string` property instead to avoid
 * circular dependencies between packages.
 *
 * @param relatedClass - The target class constructor (or class name string)
 * @param options - Optional field constraints (required, nullable, etc.)
 * @returns A TypeScript property decorator
 *
 * @example
 * ```typescript
 * @smrt()
 * class Order extends SmrtObject {
 *   // Same-package FK — enables loadRelated() and eager loading
 *   @foreignKey(Customer)
 *   customerId: string = '';
 * }
 *
 * // Cross-package: use a plain string instead
 * @smrt()
 * class Post extends SmrtObject {
 *   authorId: string = ''; // plain string — no circular dep
 * }
 * ```
 *
 * @see {@link oneToMany} for the inverse (parent) side of the relationship
 * @see SmrtObject.loadRelated for lazy-loading the related object at runtime
 */
export function foreignKey(
  relatedClass: string | Function | any,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<any, any>,
  ) => {
    const relatedClassName =
      typeof relatedClass === 'string' ? relatedClass : relatedClass.name;

    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          ...options,
          type: 'foreignKey',
          related: relatedClassName,
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
 * Unlike `@foreignKey()`, this decorator does **not** emit a DDL `FOREIGN KEY`
 * constraint — cross-package classes are not visible at schema-generation time and
 * adding a constraint would force a circular package dependency. The decorated
 * property remains a plain `TEXT` column at the database level.
 *
 * What you get over a plain string field:
 * - The relationship is registered with the `ObjectRegistry`, so `loadRelated()`
 *   and `Collection.list({ include })` can resolve it once the target package's
 *   manifest is loaded.
 * - Optional save-time validation (`validate: true`) confirms the referenced
 *   object exists, catching typos and stale IDs before they hit the database.
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
 * @see {@link foreignKey} for same-package relationships (emits FK constraint)
 * @see SmrtObject.loadRelated for runtime resolution
 */
export function crossPackageRef(
  qualifiedName: string,
  options: CrossPackageRefOptions = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<any, any>,
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
 * @param relatedClass - The class constructor of the child/related objects
 * @param options - Optional relationship options (foreign key override, etc.)
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
 * ```
 *
 * @see {@link foreignKey} for the many-to-one (child) side of the relationship
 * @see SmrtObject.loadRelatedMany for lazy-loading at runtime
 */
export function oneToMany(
  relatedClass: string | Function | any,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<any, any>,
  ) => {
    const relatedClassName =
      typeof relatedClass === 'string' ? relatedClass : relatedClass.name;

    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          ...options,
          type: 'oneToMany',
          related: relatedClassName,
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
 * Note: Runtime eager loading for `manyToMany` relationships is not yet implemented.
 * Use `collection.query()` with a JOIN for now.
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
  relatedClass: string | Function | any,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<any, any>,
  ) => {
    const relatedClassName =
      typeof relatedClass === 'string' ? relatedClass : relatedClass.name;

    registerCompatibleFieldDecorator(
      targetOrValue,
      propertyKeyOrContext,
      (className, propertyKey) => {
        ObjectRegistry.registerFieldDecorator(className, propertyKey, {
          ...options,
          type: 'manyToMany',
          related: relatedClassName,
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
    propertyKeyOrContext: CompatiblePropertyDecoratorContext<any, any>,
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
