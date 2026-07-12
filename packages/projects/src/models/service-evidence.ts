import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ServiceEvidence,
  ServiceParticipantKind,
  ServiceTimeEntrySource,
  ServiceTimeEntryStatus,
} from '../types.js';
import { parseProjectJson } from './delivery-control-plane.js';

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

const STATUS_TRANSITIONS: Record<
  ServiceTimeEntryStatus,
  ServiceTimeEntryStatus[]
> = {
  draft: ['submitted', 'rejected'],
  submitted: ['approved', 'rejected', 'draft'],
  approved: ['corrected'],
  rejected: ['draft', 'submitted'],
  corrected: [],
};

function frozenView(source: Record<string, unknown>): string {
  const result: Record<string, unknown> = {};
  for (const key of FROZEN_FIELDS) {
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
const chargeSnapshot = new WeakMap<ServiceChargeSnapshot, string>();
const compensationSnapshot = new WeakMap<ServiceCompensationSnapshot, string>();

async function immutableCommercialSnapshot(
  object: SmrtObject,
  fields: string[],
): Promise<string | null> {
  if (!object.id) return null;
  try {
    const row = await object.db.get(object.tableName, { id: object.id });
    if (!row) return null;
    return JSON.stringify(
      Object.fromEntries(
        fields.map((key) => [
          key,
          row[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] ?? null,
        ]),
      ),
    );
  } catch {
    return null;
  }
}

function commercialSnapshot(
  object: Record<string, unknown>,
  fields: string[],
): string {
  return JSON.stringify(
    Object.fromEntries(fields.map((key) => [key, object[key] ?? null])),
  );
}

const CHARGE_FIELDS = [
  'timeEntryId',
  'amount',
  'currency',
  'pricingVersion',
  'strategy',
  'rateSnapshot',
  'sourceChargeRef',
];
const COMPENSATION_FIELDS = [
  'timeEntryId',
  'amount',
  'currency',
  'termsVersion',
  'rateSnapshot',
];

/**
 * Canonical Professional Service evidence shared by planning, development,
 * and support. Commercial snapshots are deliberately separate models.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'service_time_entries',
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class ServiceTimeEntry extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @crossPackageRef('@happyvertical/smrt-support:SupportCase', {
    nullable: true,
  })
  caseId: string | null = null;
  @field({ type: 'text', nullable: true }) workRefType: string | null = null;
  @field({ type: 'text', nullable: true }) workRefId: string | null = null;
  @crossPackageRef('@happyvertical/smrt-support:SupportSpecialist', {
    nullable: true,
  })
  specialistId: string | null = null;
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
    return parseProjectJson(this.evidence, []);
  }
  setEvidence(value: ServiceEvidence[]): void {
    this.evidence = JSON.stringify(value ?? []);
  }
  getMetadata(): Record<string, unknown> {
    return parseProjectJson(this.metadata, {});
  }
  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }
  durationHours(): number {
    return this.durationSeconds / 3600;
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
      !STATUS_TRANSITIONS[prior.status].includes(this.status)
    ) {
      throw new Error(
        `ServiceTimeEntry ${this.id}: illegal status transition '${prior.status}' → '${this.status}'.`,
      );
    }
    if (
      prior &&
      (prior.status === 'approved' || prior.status === 'corrected')
    ) {
      const current = frozenView(this as unknown as Record<string, unknown>);
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
    try {
      const row = await this.db.get(this.tableName, { id: this.id });
      if (!row?.status) return null;
      const values: Record<string, unknown> = {};
      for (const key of FROZEN_FIELDS) {
        values[key] = row[key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)];
      }
      return {
        status: row.status as ServiceTimeEntryStatus,
        frozen: frozenView(values),
      };
    } catch {
      const status = loadedStatus.get(this);
      return status
        ? {
            status,
            frozen: frozenView(this as unknown as Record<string, unknown>),
          }
        : null;
    }
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'service_charge_snapshots',
  conflictColumns: ['time_entry_id'],
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class ServiceChargeSnapshot extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('ServiceTimeEntry', { required: true }) timeEntryId: string = '';
  amount: number = 0.0;
  @field({ type: 'text' }) currency: string = 'USD';
  @field({ type: 'text' }) pricingVersion: string = '';
  @field({ type: 'text' }) strategy: string = '';
  @field({ type: 'text' }) rateSnapshot: string = '{}';
  @field({ type: 'text' }) sourceChargeRef: string = '';
  createdAt: Date = new Date();

  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved())
      chargeSnapshot.set(
        this,
        commercialSnapshot(
          this as unknown as Record<string, unknown>,
          CHARGE_FIELDS,
        ),
      );
    return this;
  }

  override async save(): Promise<this> {
    const current = commercialSnapshot(
      this as unknown as Record<string, unknown>,
      CHARGE_FIELDS,
    );
    const prior =
      (await immutableCommercialSnapshot(this, CHARGE_FIELDS)) ??
      chargeSnapshot.get(this) ??
      null;
    if (prior && prior !== current)
      throw new Error(
        'ServiceChargeSnapshot is immutable; append an upstream adjustment instead.',
      );
    const result = (await super.save()) as this;
    chargeSnapshot.set(this, current);
    return result;
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'service_compensation_snapshots',
  conflictColumns: ['time_entry_id'],
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class ServiceCompensationSnapshot extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('ServiceTimeEntry', { required: true }) timeEntryId: string = '';
  amount: number = 0.0;
  @field({ type: 'text' }) currency: string = 'USD';
  @field({ type: 'text' }) termsVersion: string = '';
  @field({ type: 'text' }) rateSnapshot: string = '{}';
  createdAt: Date = new Date();

  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved())
      compensationSnapshot.set(
        this,
        commercialSnapshot(
          this as unknown as Record<string, unknown>,
          COMPENSATION_FIELDS,
        ),
      );
    return this;
  }

  override async save(): Promise<this> {
    const current = commercialSnapshot(
      this as unknown as Record<string, unknown>,
      COMPENSATION_FIELDS,
    );
    const prior =
      (await immutableCommercialSnapshot(this, COMPENSATION_FIELDS)) ??
      compensationSnapshot.get(this) ??
      null;
    if (prior && prior !== current)
      throw new Error(
        'ServiceCompensationSnapshot is immutable; create explicit settlement evidence instead.',
      );
    const result = (await super.save()) as this;
    compensationSnapshot.set(this, current);
    return result;
  }
}

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
export class ServiceChargeSnapshotCollection extends SmrtCollection<ServiceChargeSnapshot> {
  static readonly _itemClass = ServiceChargeSnapshot;
}
export class ServiceCompensationSnapshotCollection extends SmrtCollection<ServiceCompensationSnapshot> {
  static readonly _itemClass = ServiceCompensationSnapshot;
}
