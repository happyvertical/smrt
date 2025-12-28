/**
 * Permission model - named capability in the system
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';

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
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
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

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.category !== undefined) this.category = options.category;
  }

  /**
   * Get the resource part of the permission slug
   * e.g., 'articles.create' -> 'articles'
   */
  getResource(): string {
    const slug = this.slug ?? '';
    const parts = slug.split('.');
    return parts.length > 1 ? (parts[0] ?? '') : slug;
  }

  /**
   * Get the action part of the permission slug
   * e.g., 'articles.create' -> 'create'
   */
  getAction(): string {
    const slug = this.slug ?? '';
    const parts = slug.split('.');
    return parts.length > 1 ? (parts[1] ?? '') : '';
  }
}
