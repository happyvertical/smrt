/**
 * Group model - team within a tenant
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';

/**
 * Group represents a team or department within a tenant.
 *
 * Groups can have roles assigned to them via GroupRole.
 * Users in a group inherit permissions from the group's roles.
 *
 * @example
 * ```typescript
 * const editorsGroup = await groups.create({
 *   tenantId: tenant.id,
 *   name: 'Editorial Team',
 *   slug: 'editorial-team',
 *   description: 'Content editors and writers'
 * });
 * await editorsGroup.save();
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Group extends SmrtObject {
  /**
   * Foreign key to Tenant
   */
  @foreignKey('Tenant', { required: true })
  tenantId?: string;

  /**
   * Display name for the group
   */
  name: string = '';

  /**
   * Description of the group
   */
  description: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.description !== undefined)
      this.description = options.description;
  }
}
