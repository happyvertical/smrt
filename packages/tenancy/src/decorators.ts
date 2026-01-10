/**
 * @TenantScoped Decorator
 *
 * Marks a SMRT class as tenant-scoped, enabling automatic tenant isolation.
 *
 * @example
 * ```typescript
 * import { smrt, SmrtObject } from '@happyvertical/smrt-core';
 * import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
 *
 * @smrt()
 * @TenantScoped()
 * class Document extends SmrtObject {
 *   tenantId = tenantId();  // Auto-filtered and validated
 *   title: string = '';
 * }
 * ```
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 */

import {
  registerTenantScopedClass,
  type TenantScopedConfig,
} from './registry.js';

/**
 * Options for the @TenantScoped decorator
 */
export interface TenantScopedOptions {
  /**
   * Tenancy mode for this class
   * - 'required': Must have tenant context for all operations (default)
   * - 'optional': Works with or without tenant context
   */
  mode?: 'required' | 'optional';

  /**
   * Field name containing tenant ID
   * @default 'tenantId'
   */
  field?: string;

  /**
   * Auto-filter all queries by tenant
   * @default true
   */
  autoFilter?: boolean;

  /**
   * Auto-populate tenant ID from context on create
   * @default true
   */
  autoPopulate?: boolean;

  /**
   * Allow super admin bypass for this class
   * @default false - must be explicitly enabled
   */
  allowSuperAdminBypass?: boolean;
}

/**
 * Mark a class as tenant-scoped
 *
 * This decorator registers the class with the tenancy system so that:
 * - list()/get() queries are automatically filtered by tenant
 * - save() validates tenant ID matches current context
 * - delete() validates tenant ownership
 * - Raw SQL queries trigger policy enforcement
 *
 * @param options - Configuration options
 *
 * @example Basic usage (all defaults)
 * ```typescript
 * @smrt()
 * @TenantScoped()
 * class Document extends SmrtObject {
 *   tenantId = tenantId();
 *   title: string = '';
 * }
 * ```
 *
 * @example With super admin bypass enabled
 * ```typescript
 * @smrt()
 * @TenantScoped({ allowSuperAdminBypass: true })
 * class AuditLog extends SmrtObject {
 *   tenantId = tenantId();
 *   action: string = '';
 * }
 * ```
 *
 * @example Optional tenancy (works with or without context)
 * ```typescript
 * @smrt()
 * @TenantScoped({ mode: 'optional' })
 * class GlobalConfig extends SmrtObject {
 *   tenantId = tenantId();  // Will be set if context available
 *   key: string = '';
 *   value: string = '';
 * }
 * ```
 */
export function TenantScoped(
  options: TenantScopedOptions = {},
): ClassDecorator {
  return <T extends Function>(target: T): T => {
    const className = target.name;

    // Merge with defaults
    const config: Partial<TenantScopedConfig> = {
      mode: options.mode ?? 'required',
      field: options.field ?? 'tenantId',
      autoFilter: options.autoFilter ?? true,
      autoPopulate: options.autoPopulate ?? true,
      allowSuperAdminBypass: options.allowSuperAdminBypass ?? false,
    };

    // Register with the tenancy system
    registerTenantScopedClass(className, config);

    // Return the class unchanged
    return target;
  };
}
