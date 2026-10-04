import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  SERVICE_TIME_ENTRY_STATUS_TRANSITIONS,
  type ServiceEvidence,
  type ServiceParticipantKind,
  type ServiceTimeEntrySource,
  type ServiceTimeEntryStatus,
} from '../types.js';
import { parseTimesheetJson } from './json.js';

/**
 * Fields that may not change once an entry is approved (or corrected). A
 * subtype that adds its own work context extends the list through
 * {@link ServiceTimeEntry.frozenFieldNames}.
 */
export const SERVICE_TIME_ENTRY_FROZEN_FIELDS = [
  'tenantId',
  'workRefType',
  'workRefId',
  'participantKind',
  'participantProfileId',
  'agentRef',
  'source',
  'description',
  'startedAt',
  'endedAt',
  'durationSeconds',
  'evidence',
  'correctionOfId',
] as const;

function toColumn(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function frozenView(
  source: Record<string, unknown>,
  fields: readonly string[],
): string {
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    let value = source[key] ?? null;
    if ((key === 'startedAt' || key === 'endedAt') && value) {
      const date = value instanceof Date ? value : new Date(String(value));
      value = Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
    }
    if (key === 'durationSeconds') value = Number(value ?? 0);
    result[key] = value === '' ? null : value;
  }
  return JSON.stringify(result);
}

const loadedStatus = new WeakMap<ServiceTimeEntry, ServiceTimeEntryStatus>();

/**
 * A person or agent worked this long on this thing, and someone approved it.
 *
 * The base entry carries a generic work reference (`workRefType` qualified
 * class name + `workRefId`) and no domain-specific foreign key; a domain adds
 * its own context by subclassing over the same `service_time_entries` table
 * (smrt-support's subtype adds `caseId` / `specialistId`). Entries carry no
 * rate: charge and compensation live on the immutable snapshot models.
 *
 * Status moves `draft → submitted → approved | rejected`; an approved entry
 * never changes, and a correction is a new row whose `correctionOfId` points
 * at the entry it corrects, which flips to `corrected`.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'service_time_entries',
  // Moved from smrt-projects in #3288; stored references keep resolving.
  previousQualifiedNames: ['@happyvertical/smrt-projects:ServiceTimeEntry'],
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class ServiceTimeEntry extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @field({ type: 'text', nullable: true }) workRefType: string | null = null;
  @field({ type: 'text', nullable: true }) workRefId: string | null = null;
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

  getEvidence(): ServiceEvidence[] {
    return parseTimesheetJson(this.evidence, []);
  }
  setEvidence(value: ServiceEvidence[]): void {
    this.evidence = JSON.stringify(value ?? []);
  }
  getMetadata(): Record<string, unknown> {
    return parseTimesheetJson(this.metadata, {});
  }
  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }
  durationHours(): number {
    return this.durationSeconds / 3600;
  }

  /**
   * Fields frozen once the entry is approved. Subtypes that add work context
   * (e.g. a support case) return `[...super.frozenFieldNames(), ...]`.
   */
  protected frozenFieldNames(): readonly string[] {
    return SERVICE_TIME_ENTRY_FROZEN_FIELDS;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) loadedStatus.set(this, this.status);
    return this;
  }

  override async save(): Promise<this> {
    const prior = await this.readPrior();
    if (
      prior &&
      prior.status !== this.status &&
      !SERVICE_TIME_ENTRY_STATUS_TRANSITIONS[prior.status].includes(this.status)
    ) {
      throw new Error(
        `ServiceTimeEntry ${this.id}: illegal status transition '${prior.status}' → '${this.status}'.`,
      );
    }
    if (
      prior &&
      (prior.status === 'approved' || prior.status === 'corrected')
    ) {
      const current = frozenView(
        this as unknown as Record<string, unknown>,
        this.frozenFieldNames(),
      );
      if (current !== prior.frozen) {
        throw new Error(
          'Approved ServiceTimeEntry evidence is immutable; create a correction instead.',
        );
      }
    }
    const result = (await super.save()) as this;
    loadedStatus.set(this, this.status);
    return result;
  }

  private async readPrior(): Promise<{
    status: ServiceTimeEntryStatus;
    frozen: string;
  } | null> {
    if (!this.id) return null;
    const fields = this.frozenFieldNames();
    try {
      const row = await this.db.get(this.tableName, { id: this.id });
      if (!row?.status) return null;
      const values: Record<string, unknown> = {};
      for (const key of fields) {
        values[key] = row[toColumn(key)];
      }
      return {
        status: row.status as ServiceTimeEntryStatus,
        frozen: frozenView(values, fields),
      };
    } catch {
      const status = loadedStatus.get(this);
      return status
        ? {
            status,
            frozen: frozenView(
              this as unknown as Record<string, unknown>,
              fields,
            ),
          }
        : null;
    }
  }
}

/** Collection over `service_time_entries`. */
export class ServiceTimeEntryCollection extends SmrtCollection<ServiceTimeEntry> {
  static readonly _itemClass = ServiceTimeEntry;
  async forWork(
    workRefType: string,
    workRefId: string,
  ): Promise<ServiceTimeEntry[]> {
    return this.list({
      where: { workRefType, workRefId },
      orderBy: 'created_at ASC',
    });
  }
  async pendingApproval(): Promise<ServiceTimeEntry[]> {
    return this.list({
      where: { status: 'submitted' },
      orderBy: 'submitted_at ASC',
    });
  }
}
