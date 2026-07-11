import {
  crossPackageRef,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { LeadMergeOptions, LeadMergeSnapshot } from '../types.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'sales_lead_merges',
  api: { include: ['list', 'get', 'create'] },
  cli: true,
  mcp: { include: ['list', 'get', 'create'] },
  conflictColumns: ['tenant_id', 'source_lead_id'],
})
export class LeadMerge extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('Lead') sourceLeadId: string = '';
  @foreignKey('Lead') targetLeadId: string = '';

  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  actorId: string | null = null;

  sourceSnapshot: string = '{}';
  mergedAt: Date = new Date();

  constructor(options: LeadMergeOptions = {}) {
    super(options);
    Object.assign(this, options);
  }

  getSourceSnapshot(): LeadMergeSnapshot | null {
    try {
      return JSON.parse(this.sourceSnapshot) as LeadMergeSnapshot;
    } catch {
      return null;
    }
  }

  setSourceSnapshot(snapshot: LeadMergeSnapshot): void {
    this.sourceSnapshot = JSON.stringify(snapshot);
  }
}
