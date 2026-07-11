/**
 * ServiceTimeEntry — an auditable duration of Professional Service attributed
 * to its work context and delivering Participant (FR-34/FR-40, issue #1930).
 *
 * Work-context-generic by design: a Support Case is one context
 * (`caseId`), but planning and development work attach through the
 * polymorphic `workRefType`/`workRefId` pair, so this model can graduate to
 * the shared Professional Services boundary without a migration.
 *
 * Timer, manual, imported, and automatic agent entries share this one
 * validation and audit contract. Duration and work evidence stay separate
 * from money: client pricing derives from the Managed Support Plan and
 * provider earnings from the Support Compensation Plan at approval time (see
 * `TimeEntryApprovalService`), each into its own immutable snapshot row.
 *
 * **Immutability**: once a row is `approved`, its work-defining fields
 * (duration, period, description, evidence, context, participant, source)
 * are frozen — enforced at save time via the WeakMap-snapshot idiom
 * (`commerce LicenseSale` precedent). Disputes create explicit corrections
 * (`correctionOfId` chain); the original flips to `corrected` but its
 * snapshot never changes.
 */

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
  parseJsonField,
  SERVICE_TIME_ENTRY_STATUS_TRANSITIONS,
  type ServiceTimeEntrySource,
  type ServiceTimeEntryStatus,
  type SupportParticipantKind,
  type TimeEntryEvidence,
} from '../types.js';

/** Fields frozen once an entry reaches `approved`. */
const FROZEN_FIELDS = [
  'caseId',
  'workRefType',
  'workRefId',
  'specialistId',
  'participantKind',
  'participantProfileId',
  'agentRef',
  'source',
  'description',
  'startedAt',
  'endedAt',
  'durationSeconds',
  'evidence',
] as const;

/** Serialized frozen-field snapshot captured at/after approval. */
const approvedSnapshot = new WeakMap<ServiceTimeEntry, string>();

/** Status each persisted row was loaded with (transition guard). */
const loadedEntryStatus = new WeakMap<
  ServiceTimeEntry,
  ServiceTimeEntryStatus
>();

/**
 * Normalize one frozen-field value so in-memory and raw-DB-row views compare
 * equal across adapters (SQLite returns dates as strings, numbers sometimes
 * as strings; empty string and null both mean "unset" for nullable refs).
 */
function normalizeFrozenValue(key: string, value: unknown): unknown {
  if (value === undefined || value === null || value === '') {
    return key === 'durationSeconds' ? 0 : null;
  }
  if (key === 'startedAt' || key === 'endedAt') {
    const date = value instanceof Date ? value : new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  if (key === 'durationSeconds') {
    return Number(value);
  }
  return value;
}

function serializeFrozenView(view: Record<string, unknown>): string {
  const normalized: Record<string, unknown> = {};
  for (const key of FROZEN_FIELDS) {
    normalized[key] = normalizeFrozenValue(key, view[key]);
  }
  return JSON.stringify(normalized);
}

function serializeFrozenFields(entry: ServiceTimeEntry): string {
  const view: Record<string, unknown> = {};
  for (const key of FROZEN_FIELDS) {
    view[key] = (entry as unknown as Record<string, unknown>)[key];
  }
  return serializeFrozenView(view);
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'service_time_entries',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class ServiceTimeEntry extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** Support Case context, when the work was support (Support Time Entry). */
  @foreignKey('SupportCase')
  caseId: string | null = null;

  /**
   * Polymorphic work context for non-case work (planning sessions,
   * development work items): a qualified class name + id. Either `caseId` or
   * a work ref (or both) should identify the context.
   */
  @field({ type: 'text', nullable: true })
  workRefType: string | null = null;

  @field({ type: 'text', nullable: true })
  workRefId: string | null = null;

  /** Specialist role record, when the deliverer is a Support Specialist. */
  @foreignKey('SupportSpecialist')
  specialistId: string | null = null;

  /** Whether a human or a software agent delivered the work. */
  @field({ type: 'text' })
  participantKind: SupportParticipantKind = 'human';

  /** Delivering human Participant (Person profile), when human. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  participantProfileId: string | null = null;

  /** Delivering agent identity (persona/agent ref), when agent. */
  @field({ type: 'text' })
  agentRef: string = '';

  @field({ type: 'text' })
  source: ServiceTimeEntrySource = 'manual';

  @field({ type: 'text' })
  description: string = '';

  /** Work period bounds (informational; `durationSeconds` is authoritative). */
  startedAt: Date | null = null;

  endedAt: Date | null = null;

  /** Authoritative worked duration in seconds. */
  durationSeconds: number = 0;

  /** Work evidence: JSON array of {@link TimeEntryEvidence}. */
  @field({ type: 'text' })
  evidence: string = '[]';

  @field({ type: 'text' })
  status: ServiceTimeEntryStatus = 'draft';

  submittedAt: Date | null = null;

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  submittedByProfileId: string | null = null;

  approvedAt: Date | null = null;

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  approvedByProfileId: string | null = null;

  /** Which approval path accepted the entry (FR-36). */
  @field({ type: 'text' })
  approvalPath: string = '';

  rejectedAt: Date | null = null;

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  rejectedByProfileId: string | null = null;

  @field({ type: 'text' })
  rejectionReason: string = '';

  /** The approved entry this one explicitly corrects, when a correction. */
  @foreignKey('ServiceTimeEntry')
  correctionOfId: string | null = null;

  @field({ type: 'text' })
  metadata: string = '{}';

  getEvidence(): TimeEntryEvidence[] {
    const parsed = parseJsonField<TimeEntryEvidence[]>(this.evidence, []);
    return Array.isArray(parsed) ? parsed : [];
  }

  setEvidence(items: TimeEntryEvidence[]): void {
    this.evidence = JSON.stringify(items ?? []);
  }

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }

  /** Worked duration in decimal hours (UI convenience). */
  durationHours(): number {
    return this.durationSeconds / 3600;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      loadedEntryStatus.set(this, this.status);
      if (this.status === 'approved' || this.status === 'corrected') {
        approvedSnapshot.set(this, serializeFrozenFields(this));
      }
    }
    return this;
  }

  override async save(): Promise<this> {
    const prior = await this.resolvePriorState();
    this.assertStatusTransition(prior?.status);
    this.assertApprovedImmutable(prior);
    const result = (await super.save()) as this;
    loadedEntryStatus.set(this, this.status);
    if (this.status === 'approved' || this.status === 'corrected') {
      approvedSnapshot.set(this, serializeFrozenFields(this));
    }
    return result;
  }

  protected assertStatusTransition(
    prior: ServiceTimeEntryStatus | undefined,
  ): void {
    if (prior === undefined) return;
    if (prior === this.status) return;
    const allowed = SERVICE_TIME_ENTRY_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `ServiceTimeEntry ${this.id}: illegal status transition ` +
          `'${prior}' → '${this.status}'.`,
      );
    }
  }

  /**
   * Once approved, the work-defining fields are immutable — compare against
   * the authoritative persisted row (not just the WeakMap), so an upsert via
   * `create({ id, _skipLoad: true })` cannot bypass the freeze.
   */
  protected assertApprovedImmutable(
    prior:
      | { status: ServiceTimeEntryStatus; frozen: string | null }
      | undefined,
  ): void {
    if (!prior) return;
    if (prior.status !== 'approved' && prior.status !== 'corrected') return;
    const persisted = prior.frozen ?? approvedSnapshot.get(this) ?? null;
    if (persisted === null) return;
    const current = serializeFrozenFields(this);
    if (current !== persisted) {
      throw new Error(
        `ServiceTimeEntry ${this.id}: approved entries are immutable — ` +
          'create an explicit correction instead of editing the approved record.',
      );
    }
  }

  /** Authoritative prior state read from the DB row (S5 #1390 idiom). */
  protected async resolvePriorState(): Promise<
    { status: ServiceTimeEntryStatus; frozen: string | null } | undefined
  > {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          const status = row.status as ServiceTimeEntryStatus;
          let frozen: string | null = null;
          if (status === 'approved' || status === 'corrected') {
            const view: Record<string, unknown> = {};
            for (const key of FROZEN_FIELDS) {
              const column = key.replace(
                /[A-Z]/g,
                (c) => `_${c.toLowerCase()}`,
              );
              view[key] = row[column];
            }
            frozen = serializeFrozenView(view);
          }
          return { status, frozen };
        }
      } catch {
        // DB not ready / table absent — fall through to in-memory record.
      }
    }
    const status = loadedEntryStatus.get(this);
    if (status === undefined) return undefined;
    return { status, frozen: approvedSnapshot.get(this) ?? null };
  }
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
