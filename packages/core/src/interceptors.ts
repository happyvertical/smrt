/**
 * Global Interceptors System for SMRT Collections and Objects
 *
 * Provides a plugin architecture for intercepting collection and object operations.
 * This enables external packages (like @happyvertical/smrt-tenancy) to register
 * interceptors without creating circular dependencies.
 *
 * Pattern: Static methods on GlobalInterceptors class with globalThis state
 * (matches ObjectRegistry pattern for cross-module state sharing)
 *
 * @example Basic interceptor registration
 * ```typescript
 * import { GlobalInterceptors } from '@happyvertical/smrt-core';
 *
 * // Register a beforeList interceptor
 * GlobalInterceptors.register({
 *   beforeList(className, options) {
 *     console.log(`Listing ${className}`);
 *     return options; // Return modified options
 *   }
 * });
 * ```
 *
 * @example Tenancy interceptor (from smrt-tenancy)
 * ```typescript
 * GlobalInterceptors.register({
 *   beforeList(className, options, context) {
 *     const tenantId = getCurrentTenantId();
 *     if (tenantId && isTenantScoped(className)) {
 *       return {
 *         ...options,
 *         where: { ...options.where, tenantId }
 *       };
 *     }
 *     return options;
 *   },
 *   beforeSave(instance, context) {
 *     // Validate tenant on save
 *   }
 * });
 * ```
 *
 * @see https://github.com/happyvertical/smrt/issues/675
 */

import type { SmrtObject } from './object.js';

/**
 * Context passed to interceptors with operation metadata
 */
export interface InterceptorContext {
  /** Name of the SMRT class being operated on */
  className: string;
  /** Name of the collection (if applicable) */
  collectionName?: string;
  /** Timestamp of the operation */
  timestamp: Date;
  /** Operation type for debugging */
  operation: 'list' | 'get' | 'query' | 'save' | 'delete';
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Options for list operations
 */
export interface ListOptions {
  where?: Record<string, unknown>;
  orderBy?: string | string[];
  limit?: number;
  offset?: number;
  select?: readonly string[];
  include?: string[];
  [key: string]: unknown;
}

/**
 * Options for query operations (raw SQL)
 */
export interface QueryOptions {
  /** The raw SQL query */
  sql: string;
  /** Query parameters */
  params: unknown[];
  /** If true, allow raw SQL on tenant-scoped classes (requires explicit opt-in) */
  allowRawOnTenantScoped?: boolean;
}

/**
 * Result from query interceptor - can modify SQL or throw to block
 */
export interface QueryInterceptResult {
  sql: string;
  params: unknown[];
}

/**
 * Interface for collection/object interceptors
 *
 * All methods are optional. Return void to pass through unchanged,
 * or return modified data to transform the operation.
 */
export interface CollectionInterceptor {
  /** Unique identifier for this interceptor (for debugging/unregistration) */
  name?: string;

  /** Priority for execution order (higher = earlier). Default: 0 */
  priority?: number;

  /**
   * Called before list() operations
   * @param className - Name of the class being listed
   * @param options - List options (where, orderBy, limit, select, etc.)
   * @param context - Operation context
   * @returns Modified options or void to pass through
   */
  beforeList?(
    className: string,
    options: ListOptions,
    context: InterceptorContext,
  ): ListOptions | Promise<ListOptions> | void | Promise<void>;

  /**
   * Called after list() operations with results
   * @param className - Name of the class
   * @param results - Array of hydrated instances
   * @param context - Operation context
   * @returns Modified results or void to pass through
   */
  afterList?<T extends SmrtObject>(
    className: string,
    results: T[],
    context: InterceptorContext,
  ): T[] | Promise<T[]> | void | Promise<void>;

  /**
   * Called before get() operations
   * @param className - Name of the class
   * @param filter - ID, slug, or filter object
   * @param context - Operation context
   * @returns Modified filter or void to pass through
   */
  beforeGet?(
    className: string,
    filter: string | Record<string, unknown>,
    context: InterceptorContext,
  ):
    | string
    | Record<string, unknown>
    | Promise<string | Record<string, unknown>>
    | void
    | Promise<void>;

  /**
   * Called after get() operations with result
   * @param className - Name of the class
   * @param instance - Hydrated instance or null if not found
   * @param context - Operation context
   * @returns Modified instance, null, or void to pass through
   */
  afterGet?<T extends SmrtObject>(
    className: string,
    instance: T | null,
    context: InterceptorContext,
  ): T | null | Promise<T | null> | void | Promise<void>;

  /**
   * Called before query() operations (raw SQL)
   * @param className - Name of the class
   * @param options - Query options with SQL and params
   * @param context - Operation context
   * @returns Modified query options, or throw to block the query
   */
  beforeQuery?(
    className: string,
    options: QueryOptions,
    context: InterceptorContext,
  ):
    | QueryInterceptResult
    | Promise<QueryInterceptResult>
    | void
    | Promise<void>;

  /**
   * Called after query() operations with results
   * @param className - Name of the class
   * @param results - Array of hydrated instances
   * @param context - Operation context
   * @returns Modified results or void to pass through
   */
  afterQuery?<T extends SmrtObject>(
    className: string,
    results: T[],
    context: InterceptorContext,
  ): T[] | Promise<T[]> | void | Promise<void>;

  /**
   * Called before save() operations
   * @param instance - The object being saved
   * @param context - Operation context
   * @returns void (modify instance in place) or throw to block
   */
  beforeSave?(
    instance: SmrtObject,
    context: InterceptorContext,
  ): void | Promise<void>;

  /**
   * Called after save() operations
   * @param instance - The saved object
   * @param context - Operation context
   */
  afterSave?(
    instance: SmrtObject,
    context: InterceptorContext,
  ): void | Promise<void>;

  /**
   * Called before delete() operations
   * @param instance - The object being deleted
   * @param context - Operation context
   * @returns void or throw to block
   */
  beforeDelete?(
    instance: SmrtObject,
    context: InterceptorContext,
  ): void | Promise<void>;

  /**
   * Called after delete() operations
   * @param instance - The deleted object
   * @param context - Operation context
   */
  afterDelete?(
    instance: SmrtObject,
    context: InterceptorContext,
  ): void | Promise<void>;
}

/**
 * Extend globalThis to include interceptors state.
 * Using globalThis ensures all module instances share the same interceptors,
 * which is critical in monorepos where the same package can be loaded
 * from different paths.
 *
 * @see ObjectRegistry for similar pattern
 */
declare global {
  // eslint-disable-next-line no-var
  var __smrtInterceptors: unknown[] | undefined;
}

/**
 * Global Interceptors Registry
 *
 * Manages collection/object interceptors for the SMRT framework.
 * External packages can register interceptors to hook into operations
 * without modifying core code.
 */
export class GlobalInterceptors {
  /**
   * Get the global interceptors array (lazy-initialized)
   */
  private static get interceptors(): CollectionInterceptor[] {
    if (!globalThis.__smrtInterceptors) {
      globalThis.__smrtInterceptors = [];
    }
    return globalThis.__smrtInterceptors as CollectionInterceptor[];
  }

  /**
   * Register an interceptor
   *
   * @param interceptor - The interceptor to register
   * @example
   * ```typescript
   * GlobalInterceptors.register({
   *   name: 'tenancy',
   *   priority: 100,
   *   beforeList(className, options) {
   *     // Add tenant filtering
   *     return { ...options, where: { ...options.where, tenantId: 'xxx' } };
   *   }
   * });
   * ```
   */
  static register(interceptor: CollectionInterceptor): void {
    // Check for duplicate by name
    if (interceptor.name) {
      const existing = this.interceptors.findIndex(
        (i) => i.name === interceptor.name,
      );
      if (existing >= 0) {
        // Replace existing interceptor with same name
        this.interceptors[existing] = interceptor;
        this.sortByPriority();
        return;
      }
    }

    this.interceptors.push(interceptor);
    this.sortByPriority();
  }

  /**
   * Unregister an interceptor by reference or name
   *
   * @param interceptorOrName - The interceptor instance or name to remove
   * @returns true if removed, false if not found
   */
  static unregister(
    interceptorOrName: CollectionInterceptor | string,
  ): boolean {
    const idx =
      typeof interceptorOrName === 'string'
        ? this.interceptors.findIndex((i) => i.name === interceptorOrName)
        : this.interceptors.indexOf(interceptorOrName);

    if (idx >= 0) {
      this.interceptors.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Clear all interceptors (useful for testing)
   */
  static clear(): void {
    globalThis.__smrtInterceptors = [];
  }

  /**
   * Get all registered interceptors (readonly)
   */
  static getAll(): readonly CollectionInterceptor[] {
    return [...this.interceptors];
  }

  /**
   * Check if any interceptors are registered
   */
  static hasInterceptors(): boolean {
    return this.interceptors.length > 0;
  }

  /**
   * Sort interceptors by priority (higher priority first)
   */
  private static sortByPriority(): void {
    this.interceptors.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution methods - called by SmrtCollection and SmrtObject
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute beforeList interceptors
   * @internal Called by SmrtCollection.list()
   */
  static async executeBeforeList(
    className: string,
    options: ListOptions,
    context: InterceptorContext,
  ): Promise<ListOptions> {
    let result = options;

    for (const interceptor of this.interceptors) {
      if (interceptor.beforeList) {
        const modified = await interceptor.beforeList(
          className,
          result,
          context,
        );
        if (modified !== undefined && modified !== null) {
          result = modified;
        }
      }
    }

    return result;
  }

  /**
   * Execute afterList interceptors
   * @internal Called by SmrtCollection.list()
   */
  static async executeAfterList<T extends SmrtObject>(
    className: string,
    results: T[],
    context: InterceptorContext,
  ): Promise<T[]> {
    let result = results;

    for (const interceptor of this.interceptors) {
      if (interceptor.afterList) {
        const modified = await interceptor.afterList(
          className,
          result,
          context,
        );
        if (modified !== undefined && modified !== null) {
          result = modified as T[];
        }
      }
    }

    return result;
  }

  /**
   * Execute beforeGet interceptors
   * @internal Called by SmrtCollection.get()
   */
  static async executeBeforeGet(
    className: string,
    filter: string | Record<string, unknown>,
    context: InterceptorContext,
  ): Promise<string | Record<string, unknown>> {
    let result = filter;

    for (const interceptor of this.interceptors) {
      if (interceptor.beforeGet) {
        const modified = await interceptor.beforeGet(
          className,
          result,
          context,
        );
        if (modified !== undefined && modified !== null) {
          result = modified;
        }
      }
    }

    return result;
  }

  /**
   * Execute afterGet interceptors
   * @internal Called by SmrtCollection.get()
   */
  static async executeAfterGet<T extends SmrtObject>(
    className: string,
    instance: T | null,
    context: InterceptorContext,
  ): Promise<T | null> {
    let result = instance;

    for (const interceptor of this.interceptors) {
      if (interceptor.afterGet) {
        const modified = await interceptor.afterGet(className, result, context);
        if (modified !== undefined) {
          result = modified as T | null;
        }
      }
    }

    return result;
  }

  /**
   * Execute beforeQuery interceptors
   * @internal Called by SmrtCollection.query()
   */
  static async executeBeforeQuery(
    className: string,
    options: QueryOptions,
    context: InterceptorContext,
  ): Promise<QueryInterceptResult> {
    let result: QueryInterceptResult = {
      sql: options.sql,
      params: options.params,
    };

    for (const interceptor of this.interceptors) {
      if (interceptor.beforeQuery) {
        const modified = await interceptor.beforeQuery(
          className,
          { ...options, ...result },
          context,
        );
        if (modified !== undefined && modified !== null) {
          result = modified;
        }
      }
    }

    return result;
  }

  /**
   * Execute afterQuery interceptors
   * @internal Called by SmrtCollection.query()
   */
  static async executeAfterQuery<T extends SmrtObject>(
    className: string,
    results: T[],
    context: InterceptorContext,
  ): Promise<T[]> {
    let result = results;

    for (const interceptor of this.interceptors) {
      if (interceptor.afterQuery) {
        const modified = await interceptor.afterQuery(
          className,
          result,
          context,
        );
        if (modified !== undefined && modified !== null) {
          result = modified as T[];
        }
      }
    }

    return result;
  }

  /**
   * Execute beforeSave interceptors
   * @internal Called by SmrtObject.save()
   */
  static async executeBeforeSave(
    instance: SmrtObject,
    context: InterceptorContext,
  ): Promise<void> {
    for (const interceptor of this.interceptors) {
      if (interceptor.beforeSave) {
        await interceptor.beforeSave(instance, context);
      }
    }
  }

  /**
   * Execute afterSave interceptors
   * @internal Called by SmrtObject.save()
   */
  static async executeAfterSave(
    instance: SmrtObject,
    context: InterceptorContext,
  ): Promise<void> {
    for (const interceptor of this.interceptors) {
      if (interceptor.afterSave) {
        await interceptor.afterSave(instance, context);
      }
    }
  }

  /**
   * Execute beforeDelete interceptors
   * @internal Called by SmrtObject.delete()
   */
  static async executeBeforeDelete(
    instance: SmrtObject,
    context: InterceptorContext,
  ): Promise<void> {
    for (const interceptor of this.interceptors) {
      if (interceptor.beforeDelete) {
        await interceptor.beforeDelete(instance, context);
      }
    }
  }

  /**
   * Execute afterDelete interceptors
   * @internal Called by SmrtObject.delete()
   */
  static async executeAfterDelete(
    instance: SmrtObject,
    context: InterceptorContext,
  ): Promise<void> {
    for (const interceptor of this.interceptors) {
      if (interceptor.afterDelete) {
        await interceptor.afterDelete(instance, context);
      }
    }
  }
}

/**
 * Helper function to create an interceptor context
 * @internal
 */
export function createInterceptorContext(
  className: string,
  operation: InterceptorContext['operation'],
  collectionName?: string,
  metadata?: Record<string, unknown>,
): InterceptorContext {
  return {
    className,
    collectionName,
    operation,
    timestamp: new Date(),
    metadata,
  };
}
