/**
 * Field decorators for SMRT objects
 *
 * Modern decorator-based API for defining SMRT object properties.
 * Properties are typed as primitives with decorator metadata.
 */

import { ObjectRegistry } from '../registry.js';

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
export interface FieldOptions {
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
  type?: 'foreignKey' | 'oneToMany' | 'manyToMany';
}

/**
 * Generic field decorator for marking properties with constraints
 *
 * @param options - Field options (required, default, min, max, minLength, maxLength, etc.)
 * @returns Property decorator
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   @field({ required: true, maxLength: 100 })
 *   name: string = '';
 *
 *   @field({ min: 0, max: 1000, default: 0 })
 *   stock: number = 0;
 * }
 * ```
 */
export function field(
  options: FieldOptions | NumericFieldOptions | TextFieldOptions = {},
) {
  return (target: any, propertyKey: string) => {
    const className = target.constructor.name;
    ObjectRegistry.registerFieldDecorator(className, propertyKey, options);
  };
}

/**
 * Foreign key relationship decorator
 *
 * @param relatedClass - The class this field references
 * @param options - Relationship options
 * @returns Property decorator
 *
 * @example
 * ```typescript
 * @smrt()
 * class Order extends SmrtObject {
 *   @foreignKey(Customer)
 *   customerId: string = '';
 * }
 * ```
 */
export function foreignKey(
  relatedClass: string | Function | any,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return (target: any, propertyKey: string) => {
    const className = target.constructor.name;
    const relatedClassName =
      typeof relatedClass === 'string' ? relatedClass : relatedClass.name;

    ObjectRegistry.registerFieldDecorator(className, propertyKey, {
      ...options,
      type: 'foreignKey',
      related: relatedClassName,
    });
  };
}

/**
 * One-to-many relationship decorator
 *
 * @param relatedClass - The class of the related collection
 * @param options - Relationship options (foreignKey, etc.)
 * @returns Property decorator
 *
 * @example
 * ```typescript
 * @smrt()
 * class Order extends SmrtObject {
 *   @oneToMany(OrderItem, { foreignKey: 'orderId' })
 *   items: OrderItem[] = [];
 * }
 * ```
 */
export function oneToMany(
  relatedClass: string | Function | any,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return (target: any, propertyKey: string) => {
    const className = target.constructor.name;
    const relatedClassName =
      typeof relatedClass === 'string' ? relatedClass : relatedClass.name;

    ObjectRegistry.registerFieldDecorator(className, propertyKey, {
      ...options,
      type: 'oneToMany',
      related: relatedClassName,
      transient: true, // Relationship fields are not database columns
    });
  };
}

/**
 * Many-to-many relationship decorator
 *
 * @param relatedClass - The class of the related collection
 * @param options - Relationship options (through table, etc.)
 * @returns Property decorator
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   @manyToMany(Tag, { through: 'product_tags' })
 *   tags: Tag[] = [];
 * }
 * ```
 */
export function manyToMany(
  relatedClass: string | Function | any,
  options: Omit<RelationshipFieldOptions, 'related'> = {},
) {
  return (target: any, propertyKey: string) => {
    const className = target.constructor.name;
    const relatedClassName =
      typeof relatedClass === 'string' ? relatedClass : relatedClass.name;

    ObjectRegistry.registerFieldDecorator(className, propertyKey, {
      ...options,
      type: 'manyToMany',
      related: relatedClassName,
      transient: true, // Relationship fields are not database columns
    });
  };
}

/**
 * Meta field decorator for STI (Single Table Inheritance) patterns
 *
 * Marks a field as a "meta field" that should be stored in the _meta_data JSONB column
 * rather than as a direct table column. Used for child-specific fields in STI hierarchies.
 *
 * @param options - Field options
 * @returns Property decorator
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
 *   @meta()
 *   roomNumber: string = '';
 * }
 * ```
 */
export function meta(options: FieldOptions = {}) {
  return (target: any, propertyKey: string) => {
    const className = target.constructor.name;
    ObjectRegistry.registerFieldDecorator(className, propertyKey, {
      ...options,
      type: 'meta', // Mark this field as a meta field for STI
    });
  };
}
