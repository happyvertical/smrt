/**
 * Permission model - named capability in the system
 * @packageDocumentation
 */

import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * Parsed permission slug components
 */
export interface ParsedPermissionSlug {
  /** Resource part (e.g., 'articles' from 'articles.create') */
  resource: string;
  /** Action part (e.g., 'create' from 'articles.create') */
  action: string;
  /** Whether the slug follows the valid 'resource.action' pattern */
  isValid: boolean;
}

/**
 * Parse a permission slug into its resource and action components.
 * Valid format: 'resource.action' (e.g., 'articles.create')
 *
 * @param slug - The permission slug to parse
 * @returns Parsed components with validation status
 */
export function parsePermissionSlug(slug: string): ParsedPermissionSlug {
  const parts = slug.split('.');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return {
      resource: parts[0],
      action: parts[1],
      isValid: true,
    };
  }
  return {
    resource: slug,
    action: '',
    isValid: false,
  };
}

/**
 * Validate that a permission slug follows the 'resource.action' pattern.
 *
 * @param slug - The slug to validate
 * @returns true if valid, false otherwise
 */
export function isValidPermissionSlug(slug: string): boolean {
  return parsePermissionSlug(slug).isValid;
}

/**
 * Constructor options for {@link Permission}.
 */
export interface PermissionOptions extends SmrtObjectOptions {
  name?: string;
  description?: string;
  category?: string;
}

/**
 * Permission represents a named capability in the system.
 *
 * Permissions are defined by the application and assigned to roles.
 * Permission slugs follow the pattern: resource.action (e.g., 'articles.create')
 *
 * @example
 * ```typescript
 * const permission = await permissions.create({
 *   slug: 'articles.create',
 *   name: 'Create Articles',
 *   description: 'Allows creating new articles',
 *   category: 'articles'
 * });
 * await permission.save();
 * ```
 */
@smrt({
  // #1400: read-only generated surface — RBAC/identity writes go through
  // permission-gated services, not auth-only generated CRUD.
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Permission extends SmrtObject {
  /**
   * Display name for the permission
   */
  name: string = '';

  /**
   * Description of what this permission allows
   */
  description: string = '';

  /**
   * Category for grouping in UI (e.g., 'articles', 'users', 'settings')
   */
  category: string = '';

  constructor(options: PermissionOptions = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.category !== undefined) this.category = options.category;
  }

  /**
   * Parse the permission slug into resource and action components.
   * @returns Parsed slug with resource, action, and validation status
   */
  parseSlug(): ParsedPermissionSlug {
    return parsePermissionSlug(this.slug ?? '');
  }

  /**
   * Get the resource part of the permission slug
   * e.g., 'articles.create' -> 'articles'
   */
  getResource(): string {
    return this.parseSlug().resource;
  }

  /**
   * Get the action part of the permission slug
   * e.g., 'articles.create' -> 'create'
   */
  getAction(): string {
    return this.parseSlug().action;
  }

  /**
   * Check if the permission slug is valid (follows 'resource.action' pattern)
   */
  isValidSlug(): boolean {
    return this.parseSlug().isValid;
  }
}
