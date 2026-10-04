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
    if (key === 'durationSeconds' && value !== null) value = Number(value);
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
  /** Integer seconds, or null for an explicit decimal-hours-only source. */
  @field({ type: 'integer', nullable: true })
  durationSeconds: number | null = 0;
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
  /** Original decimal-hours text, without binary floating-point conversion. */
  durationHoursExact(): string | null {
    const evidence = this.getEvidence();
    const quantities = (Array.isArray(evidence) ? evidence : []).filter(
      (item) => item?.kind === SERVICE_DURATION_HOURS_EVIDENCE,
    );
    if (quantities.length === 0) return null;
    if (quantities.length !== 1)
      throw new Error(
        'Service time requires exactly one decimal-hours quantity.',
      );
    return validateDurationHours(quantities[0].hours);
  }

  /** Numeric convenience for display; use durationHoursExact() for exact terms. */
  durationHours(): number {
    if (this.durationSeconds !== null) return this.durationSeconds / 3600;
    const hours = this.durationHoursExact();
    if (hours === null)
      throw new Error('Service time has no supported duration quantity.');
    return Number(hours);
  }

  /** Guard for consumers whose policies require independently supplied seconds. */
  requireDurationSeconds(): number {
    if (this.durationSeconds === null)
      throw new Error(
        'Decimal-hours-only service time has no measured durationSeconds; use durationHoursExact() with an hours-aware policy.',
      );
    return this.durationSeconds;
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
    const hours = this.durationHoursExact();
    if (hours !== null) {
      if (
        this.durationSeconds !== null ||
        this.startedAt ||
        this.endedAt ||
        this.source === 'timer'
      )
        throw new Error(
          'Decimal-hours-only service time cannot also supply seconds or timestamps.',
        );
    } else if (this.durationSeconds === null) {
      throw new Error(
        'Null durationSeconds requires explicit decimal-hours evidence.',
      );
    }
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

/** Reserved evidence kind for a source quantity with no measured elapsed seconds. */
export const SERVICE_DURATION_HOURS_EVIDENCE =
  '@happyvertical/smrt-timesheets:duration-hours';

/** Validate without normalizing the original accepted decimal text. */
export function validateDurationHours(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^\d+(?:\.\d+)?$/.test(value) ||
    !Number.isFinite(Number(value)) ||
    Number(value) <= 0 ||
    Number(value) >= Number.MAX_SAFE_INTEGER
  )
    throw new Error(
      'Service time durationHours must be positive plain decimal text within the supported numeric range.',
    );
  return value;
}
