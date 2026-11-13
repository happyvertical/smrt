/**
 * DnsZone - An apex DNS zone (e.g. happyvertical.com).
 *
 * Named DnsZone, not Zone, because `@happyvertical/smrt-properties` already
 * registers an ad/property `Zone` class and registry names are global.
 * One zone hosts many hostnames (see Domain), which may belong to
 * different projects.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { DnsZoneOptions } from '../types';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'dns_zones',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  conflictColumns: ['tenant_id', 'name'],
})
export class DnsZone extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  /** Apex name, e.g. "happyvertical.com" */
  name: string = '';

  /** Free-form notes */
  notes: string = '';

  createdAt: Date = new Date();
  updatedAt: Date = new Date();

  constructor(options: DnsZoneOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }
}
