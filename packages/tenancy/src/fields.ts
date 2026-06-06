/**
 * Tenancy Field Types and Utilities
 *
 * This module provides types and utility functions for tenant ID fields.
 * The actual field decorator is in decorators.ts.
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 * @see https://github.com/happyvertical/smrt/issues/829
 */

/**
 * Options for the `@tenantId()` property decorator.
 *
 * Controls how the decorated field interacts with the tenancy interceptor.
 * All options default to the strictest safe values: auto-filter on, required,
 * auto-populate on, not nullable.
 *
 * @see tenantId
 * @see TenantScopedOptions
 */
export interface TenantIdFieldOptions {
  /**
   * Auto-filter queries by this field
   * @default true
   */
  autoFilter?: boolean;

  /**
   * Require this field to have a value on save
   * @default true
   */
  required?: boolean;

  /**
   * Auto-populate from context on create if not set
   * @default true
   */
  autoPopulate?: boolean;

  /**
   * Allow null values (for global resources)
   * @default false
   */
  nullable?: boolean;
}

// Symbol to identify tenantId fields
export const TENANT_ID_SYMBOL = Symbol('tenantId');

/**
 * Internal field descriptor stored in `ObjectRegistry` when `@tenantId()` is
 * applied to a property.
 *
 * Consumers should use `isTenantIdField()` and `getTenantIdFieldOptions()`
 * to inspect these descriptors rather than reading the raw properties directly.
 *
 * @see isTenantIdField
 * @see getTenantIdFieldOptions
 */
export interface TenantIdFieldDefinition {
  /** Field type marker */
  type: 'foreignKey';
  /** Reference to Tenant class (placeholder - actual class resolved at runtime) */
  reference: 'Tenant';
  /** SQL type */
  sqlType: 'UUID';
  /** Field is required */
  required: boolean;
  /** Field allows null */
  nullable: boolean;
  /** Tenancy-specific options */
  __tenancy: TenantIdFieldOptions & { isTenantIdField: true };
}

/**
 * Return `true` if the given field definition was produced by the `@tenantId()`
 * decorator (i.e., it has an `__tenancy.isTenantIdField` marker).
 *
 * Used internally by the interceptor and code generators to locate the tenant
 * ID field on a class without knowing its property name in advance.
 *
 * @param field - A raw field definition object, typically from `ObjectRegistry`.
 * @returns `true` if `field` is a tenant ID field definition, `false` otherwise.
 *
 * @example
 * ```typescript
 * const fields = ObjectRegistry.getFields('Document');
 * const tenantField = Object.entries(fields).find(([, def]) => isTenantIdField(def));
 * ```
 *
 * @see getTenantIdFieldOptions
 * @see TenantIdFieldDefinition
 */
export function isTenantIdField(field: unknown): boolean {
  if (!field || typeof field !== 'object') {
    return false;
  }
  const def = field as Record<string, unknown>;
  const tenancy = def.__tenancy as Record<string, unknown> | undefined;
  return tenancy?.isTenantIdField === true;
}

/**
 * Extract the `TenantIdFieldOptions` from a field definition.
 *
 * Returns the tenancy-specific options (autoFilter, required, autoPopulate,
 * nullable) stored inside the field descriptor's `__tenancy` property.
 * Returns `null` if the field was not produced by `@tenantId()`.
 *
 * @param field - A raw field definition object, typically from `ObjectRegistry`.
 * @returns The `TenantIdFieldOptions` if the field is a tenant ID field,
 *   `null` otherwise.
 *
 * @see isTenantIdField
 * @see TenantIdFieldOptions
 */
export function getTenantIdFieldOptions(
  field: unknown,
): TenantIdFieldOptions | null {
  if (!isTenantIdField(field)) {
    return null;
  }
  const def = field as { __tenancy: TenantIdFieldOptions };
  return def.__tenancy;
}
