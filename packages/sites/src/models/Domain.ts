/**
 * Domain - One hostname under a DnsZone (e.g. work.happyvertical.com).
 *
 * A domain with no ProjectDomain link is "unassigned".
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { DomainOptions } from '../types';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'domains',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'hostname'],
})
export class Domain extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  /** FK to dns_zones */
  @foreignKey('DnsZone')
  zoneId: string = '';

  /** Fully qualified hostname, e.g. "work.happyvertical.com" */
  hostname: string = '';

  /** Free-form notes */
  notes: string = '';

  createdAt: Date = new Date();
  updatedAt: Date = new Date();

  constructor(options: DomainOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.zoneId !== undefined) this.zoneId = options.zoneId;
    if (options.hostname !== undefined) this.hostname = options.hostname;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }
}
