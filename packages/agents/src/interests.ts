import type { SmrtObject } from '@happyvertical/smrt-core';

/**
 * Filter object using SDK SQL operator-in-key pattern (AND-only for now)
 *
 * Supports operators in keys:
 * - `{ 'status': 'active' }` → WHERE status = 'active'
 * - `{ 'price >': 100 }` → WHERE price > 100
 * - `{ 'type in': ['a', 'b'] }` → WHERE type IN ('a', 'b')
 *
 * Supported operators: =, >, <, >=, <=, !=, in, like
 */
export type ObjectFilter = Record<string, any>;

/**
 * Async qualifier function for post-filter processing
 *
 * Receives items after SQL filtering, returns filtered/modified items.
 * Use for filtering that can't be expressed in SQL (e.g., AI-based filtering).
 *
 * @example
 * ```typescript
 * const qualify: AsyncQualifierFn<Meeting> = async (meetings) => {
 *   return meetings.filter(m => m.isPublic);
 * };
 * ```
 */
export type AsyncQualifierFn<T extends SmrtObject = SmrtObject> = (
  items: T[],
) => Promise<T[]>;

/**
 * Configuration for a specific object type's interest
 */
export interface ObjectInterestConfig<T extends SmrtObject = SmrtObject> {
  /**
   * SQL orderBy format: 'priority DESC' or ['priority DESC', 'name ASC']
   */
  sort?: string | string[];

  /**
   * SQL filter object for queries
   * Merged with global filter using AND logic (object spread)
   */
  filter?: ObjectFilter;

  /**
   * Async post-filter function on results
   * Runs after SQL query returns, enables AI-based or complex filtering
   */
  qualify?: AsyncQualifierFn<T>;

  /**
   * Maximum number of items to return for this type
   */
  limit?: number;
}

/**
 * Global interest configuration for an agent
 *
 * @example
 * ```typescript
 * const interests: InterestOptions = {
 *   filter: { status: 'active' },
 *   sort: 'created_at DESC',
 *   objects: {
 *     Meeting: {
 *       sort: 'scheduled_at DESC',
 *       filter: { 'scheduled_at >': new Date() },
 *       limit: 10
 *     },
 *     Document: {
 *       filter: { 'type in': ['agenda', 'minutes'] }
 *     }
 *   }
 * };
 * ```
 */
export interface InterestOptions {
  /**
   * Global sort applied to final combined results
   * If not specified, results are grouped by type with type-specific sorts
   */
  sort?: string | string[];

  /**
   * Global filter applied to all object types
   * Merged with object-specific filters using AND logic
   */
  filter?: ObjectFilter;

  /**
   * Global async qualifier applied after all object-specific qualifiers
   */
  qualify?: AsyncQualifierFn;

  /**
   * Object-specific interest configurations
   * Keys must match ObjectRegistry class names (case-insensitive lookup)
   */
  objects: {
    [className: string]: ObjectInterestConfig;
  };
}

/**
 * Result item from interesting() method
 */
export interface InterestResult<T extends SmrtObject = SmrtObject> {
  /**
   * Object class name from ObjectRegistry
   */
  type: string;

  /**
   * The actual SmrtObject instance
   */
  data: T;
}

/**
 * Extended agent options including interests
 */
export interface AgentWithInterestsOptions {
  /**
   * Interest configuration for this agent
   */
  interests?: InterestOptions;
}

/**
 * Merge global and object-specific filters using AND logic (object spread)
 *
 * @param globalFilter - Global filter applied to all types
 * @param objectFilter - Object-specific filter
 * @returns Merged filter object
 *
 * @example
 * ```typescript
 * mergeFilters({ status: 'active' }, { 'created_at >': date })
 * // Returns: { status: 'active', 'created_at >': date }
 * ```
 */
export function mergeFilters(
  globalFilter?: ObjectFilter,
  objectFilter?: ObjectFilter,
): ObjectFilter {
  if (!globalFilter && !objectFilter) return {};
  if (!globalFilter) return { ...objectFilter };
  if (!objectFilter) return { ...globalFilter };
  return { ...globalFilter, ...objectFilter };
}

/**
 * Normalize sort to array format
 *
 * @param sort - Sort specification (string or array)
 * @returns Array of sort fields
 *
 * @example
 * ```typescript
 * normalizeSort('created_at DESC')
 * // Returns: ['created_at DESC']
 *
 * normalizeSort(['priority DESC', 'name ASC'])
 * // Returns: ['priority DESC', 'name ASC']
 * ```
 */
export function normalizeSort(sort?: string | string[]): string[] {
  if (!sort) return [];
  return Array.isArray(sort) ? sort : [sort];
}
