/**
 * tenantId Field Helper
 *
 * A specialized field that marks a property as the tenant identifier.
 * This field is automatically managed by the tenancy system.
 *
 * @example
 * ```typescript
 * import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
 *
 * @TenantScoped()
 * class Document extends SmrtObject {
 *   tenantId = tenantId();  // Framework handles filtering/validation
 *   title: string = '';
 * }
 * ```
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 */

/**
 * Options for the tenantId field
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
 * Internal tenantId field definition
 */
export interface TenantIdFieldDefinition {
  /** Field type marker */
  type: 'foreignKey';
  /** Reference to Tenant class (placeholder - actual class resolved at runtime) */
  reference: 'Tenant';
  /** SQL type */
  sqlType: 'TEXT';
  /** Field is required */
  required: boolean;
  /** Field allows null */
  nullable: boolean;
  /** Tenancy-specific options */
  __tenancy: TenantIdFieldOptions & { isTenantIdField: true };
}

/**
 * Define a tenant ID field
 *
 * This creates a TEXT field that references the Tenant table.
 * The tenancy interceptor uses this field for automatic filtering.
 *
 * @param options - Field options
 * @returns Field definition for use in SMRT class
 *
 * @example Basic usage
 * ```typescript
 * class Document extends SmrtObject {
 *   tenantId = tenantId();
 * }
 * ```
 *
 * @example With custom options
 * ```typescript
 * class GlobalConfig extends SmrtObject {
 *   // Nullable tenant ID for global configs
 *   tenantId = tenantId({ nullable: true, required: false });
 * }
 * ```
 */
export function tenantId(
  options: TenantIdFieldOptions = {},
): TenantIdFieldDefinition {
  const opts = {
    autoFilter: true,
    required: true,
    autoPopulate: true,
    nullable: false,
    ...options,
  };

  return {
    type: 'foreignKey',
    reference: 'Tenant',
    sqlType: 'TEXT',
    required: opts.required,
    nullable: opts.nullable,
    __tenancy: {
      ...opts,
      isTenantIdField: true,
    },
  };
}

/**
 * Check if a field definition is a tenantId field
 *
 * @param field - Field definition to check
 * @returns true if the field is a tenantId field
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
 * Get tenancy options from a field definition
 *
 * @param field - Field definition
 * @returns Tenancy options if this is a tenantId field, null otherwise
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
