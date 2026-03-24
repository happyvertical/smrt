/**
 * Tenancy Decorators
 *
 * Provides class and property decorators for tenant-scoped SMRT objects.
 *
 * @example
 * ```typescript
 * import { smrt, SmrtObject } from '@happyvertical/smrt-core';
 * import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
 *
 * @smrt()
 * @TenantScoped({ mode: 'optional' })
 * class Document extends SmrtObject {
 *   @tenantId({ nullable: true })
 *   tenantId: string | null = null;  // null = global document
 *
 *   title: string = '';
 * }
 * ```
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 * @see https://github.com/happyvertical/smrt/issues/829
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { TenantIdFieldOptions } from './fields.js';
import {
  registerTenantScopedClass,
  type TenantScopedConfig,
} from './registry.js';

type LegacyPropertyDecoratorTarget = {
  constructor?: {
    name?: string;
  };
};

interface CompatiblePropertyDecorator<This = any, Value = any> {
  (target: object, propertyKey: string | symbol): void;
  (value: undefined, context: ClassFieldDecoratorContext<This, Value>): void;
}

function resolveDecoratorClassName(target: unknown): string | undefined {
  if (typeof target === 'function') {
    return target.name;
  }

  if (target && typeof target === 'object') {
    return (target as LegacyPropertyDecoratorTarget).constructor?.name;
  }

  return undefined;
}

/**
 * Options accepted by the `@TenantScoped()` class decorator.
 *
 * All fields are optional; defaults match the most restrictive safe behaviour
 * (required mode, auto-filter and auto-populate enabled, no super-admin bypass).
 *
 * @see TenantScoped
 * @see TenantScopedConfig
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
 * @example Basic usage (required tenancy)
 * ```typescript
 * @smrt()
 * @TenantScoped()
 * class Document extends SmrtObject {
 *   @tenantId()
 *   tenantId: string = '';
 *
 *   title: string = '';
 * }
 * ```
 *
 * @example With super admin bypass enabled
 * ```typescript
 * @smrt()
 * @TenantScoped({ allowSuperAdminBypass: true })
 * class AuditLog extends SmrtObject {
 *   @tenantId()
 *   tenantId: string = '';
 *
 *   action: string = '';
 * }
 * ```
 *
 * @example Optional tenancy (works with or without context)
 * ```typescript
 * @smrt()
 * @TenantScoped({ mode: 'optional' })
 * class GlobalConfig extends SmrtObject {
 *   @tenantId({ nullable: true })
 *   tenantId: string | null = null;  // null = global, string = tenant-specific
 *
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

// ─────────────────────────────────────────────────────────────────────────────
// Property Decorator: @tenantId
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tenant ID property decorator
 *
 * Marks a property as the tenant identifier field. This decorator registers
 * the field metadata with ObjectRegistry, keeping the property value clean
 * (no descriptor objects that could be accidentally saved to the database).
 *
 * @param options - Field options (nullable, autoFilter, autoPopulate, etc.)
 * @returns Property decorator
 *
 * @example Basic usage (required tenancy)
 * ```typescript
 * @smrt()
 * @TenantScoped()
 * class Document extends SmrtObject {
 *   @tenantId()
 *   tenantId: string = '';
 *
 *   title: string = '';
 * }
 * ```
 *
 * @example Nullable tenant ID (for global resources)
 * ```typescript
 * @smrt()
 * @TenantScoped({ mode: 'optional' })
 * class GlobalConfig extends SmrtObject {
 *   @tenantId({ nullable: true })
 *   tenantId: string | null = null;  // null = global, string = tenant-specific
 *
 *   key: string = '';
 * }
 * ```
 *
 * @see https://github.com/happyvertical/smrt/issues/829 - Why decorators over field helpers
 */
export function tenantId(options: TenantIdFieldOptions = {}) {
  const opts = {
    autoFilter: true,
    required: true,
    autoPopulate: true,
    nullable: false,
    ...options,
  };

  return ((
    targetOrValue: LegacyPropertyDecoratorTarget | undefined,
    propertyKeyOrContext:
      | string
      | symbol
      | ClassFieldDecoratorContext<any, any>,
  ) => {
    const registerTenantId = (className: string, propertyKey: string) => {
      ObjectRegistry.registerFieldDecorator(className, propertyKey, {
        type: 'foreignKey',
        related: 'Tenant',
        sqlType: 'TEXT',
        required: opts.required,
        nullable: opts.nullable,
        __tenancy: {
          ...opts,
          isTenantIdField: true,
        },
      });
    };

    if (
      typeof propertyKeyOrContext === 'string' ||
      typeof propertyKeyOrContext === 'symbol'
    ) {
      const className = resolveDecoratorClassName(targetOrValue);
      if (className) {
        registerTenantId(className, String(propertyKeyOrContext));
      }
      return;
    }

    const context = propertyKeyOrContext;
    context.addInitializer?.(function registerTenantIdDecorator() {
      const className = resolveDecoratorClassName(this);
      if (className) {
        registerTenantId(className, String(context.name));
      }
    });
  }) as CompatiblePropertyDecorator;
}
