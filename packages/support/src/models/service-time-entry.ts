/** Compatibility mapping for issue #1955. */
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  smrt,
} from '@happyvertical/smrt-core';
import {
  type ServiceParticipantKind,
  type ServiceTimeEntrySource,
  type ServiceTimeEntryStatus,
  ServiceTimeEntry as SharedServiceTimeEntry,
} from '@happyvertical/smrt-projects';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Source-compatible support subtype over the shared canonical table. The
 * fields are restated because package-isolated manifest scanning deliberately
 * does not inspect dependency source trees. Runtime behavior remains inherited
 * from the shared model and both packages address the same table and rows.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'service_time_entries',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class ServiceTimeEntry extends SharedServiceTimeEntry {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('SupportCase') caseId: string | null = null;
  @field({ type: 'text', nullable: true }) workRefType: string | null = null;
  @field({ type: 'text', nullable: true }) workRefId: string | null = null;
  @foreignKey('SupportSpecialist') specialistId: string | null = null;
  @field({ type: 'text' }) participantKind: ServiceParticipantKind = 'human';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  participantProfileId: string | null = null;
  @field({ type: 'text' }) agentRef: string = '';
  @field({ type: 'text' }) source: ServiceTimeEntrySource = 'manual';
  @field({ type: 'text' }) description: string = '';
  startedAt: Date | null = null;
  endedAt: Date | null = null;
  durationSeconds: number = 0;
  @field({ type: 'text' }) evidence: string = '[]';
  @field({ type: 'text' }) status: ServiceTimeEntryStatus = 'draft';
  submittedAt: Date | null = null;
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  submittedByProfileId: string | null = null;
  approvedAt: Date | null = null;
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  approvedByProfileId: string | null = null;
  @field({ type: 'text' }) approvalPath: string = '';
  rejectedAt: Date | null = null;
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  rejectedByProfileId: string | null = null;
  @field({ type: 'text' }) rejectionReason: string = '';
  @foreignKey('ServiceTimeEntry') correctionOfId: string | null = null;
  @field({ type: 'text' }) metadata: string = '{}';
}

export class ServiceTimeEntryCollection extends SmrtCollection<ServiceTimeEntry> {
  static readonly _itemClass = ServiceTimeEntry;
  async forCase(caseId: string): Promise<ServiceTimeEntry[]> {
    return this.list({ where: { caseId }, orderBy: 'created_at ASC' });
  }
  async forSpecialist(specialistId: string): Promise<ServiceTimeEntry[]> {
    return this.list({ where: { specialistId }, orderBy: 'created_at ASC' });
  }
  async pendingApproval(): Promise<ServiceTimeEntry[]> {
    return this.list({
      where: { status: 'submitted' },
      orderBy: 'submitted_at ASC',
    });
  }
}

export default ServiceTimeEntry;
