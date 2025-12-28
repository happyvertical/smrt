/**
 * Tenant model - organizational boundary for multi-tenancy
 * @packageDocumentation
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantStatus } from '../types/index.js';

/**
 * Tenant represents an organizational boundary in the multi-tenant system.
 *
 * Users can belong to multiple tenants through Memberships.
 * Each tenant can have custom roles in addition to system defaults.
 *
 * @example
 * ```typescript
 * const tenant = await tenants.create({
 *   name: 'Acme Corporation',
 *   slug: 'acme-corp',
 *   status: TenantStatus.ACTIVE
 * });
 * await tenant.save();
 * ```
 */
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Tenant extends SmrtObject {
  /**
   * Display name for the tenant
   */
  name: string = '';

  /**
   * Tenant status
   */
  status: TenantStatus = TenantStatus.ACTIVE;

  /**
   * Optional description
   */
  description: string = '';

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.status !== undefined) this.status = options.status;
    if (options.description !== undefined)
      this.description = options.description;
  }

  /**
   * Check if tenant is active
   */
  isActive(): boolean {
    return this.status === TenantStatus.ACTIVE;
  }

  /**
   * Check if tenant is suspended
   */
  isSuspended(): boolean {
    return this.status === TenantStatus.SUSPENDED;
  }
}
