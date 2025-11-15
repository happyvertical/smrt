/**
 * Field decorators for SMRT objects
 *
 * Replaces field helper functions with a clean decorator-based API.
 * Properties are typed as primitives, avoiding Field object confusion.
 */

import type {
  FieldOptions,
  NumericFieldOptions,
  RelationshipFieldOptions,
  TextFieldOptions,
} from '../fields/index.js';
import { ObjectRegistry } from '../registry.js';

/**
 * Generic field decorator for marking properties with constraints
 *
 * @param options - Field options (required, default, min, max, etc.)
 * @returns Property decorator
 *
 * @example
 * ```typescript
 * @smrt()
 * class Product extends SmrtObject {
 *   @field({ required: true })
 *   name: string = '';
 *
 *   @field({ min: 0, default: 0 })
 *   stock: number = 0;
 * }
 * ```
 */
export function field(options: FieldOptions = {}) {
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
    });
  };
}

// Re-export types for convenience
export type {
  FieldOptions,
  NumericFieldOptions,
  RelationshipFieldOptions,
  TextFieldOptions,
};
