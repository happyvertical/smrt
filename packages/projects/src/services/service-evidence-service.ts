import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  ServiceChargeSnapshotCollection,
  ServiceCompensationSnapshotCollection,
  type ServiceTimeEntry,
  ServiceTimeEntryCollection,
} from '../models/service-evidence.js';
import type {
  ServiceEvidence,
  ServiceParticipantKind,
  ServiceTimeEntrySource,
} from '../types.js';

export interface RecordServiceTimeInput {
  tenantId?: string | null;
  caseId?: string | null;
  workRefType?: string | null;
  workRefId?: string | null;
  specialistId?: string | null;
  participantKind: ServiceParticipantKind;
  participantProfileId?: string | null;
  agentRef?: string;
  source: ServiceTimeEntrySource;
  description: string;
  startedAt?: Date | null;
  endedAt?: Date | null;
  durationSeconds?: number;
  evidence?: ServiceEvidence[];
  metadata?: Record<string, unknown>;
}

export interface CommercialSnapshot {
  amount: number;
  currency?: string;
  version: string;
  strategy?: string;
  terms: Record<string, unknown>;
  sourceRef?: string;
}

export interface ServiceCommercialResolver {
  priceClient(entry: ServiceTimeEntry): Promise<CommercialSnapshot>;
  compensateProvider(entry: ServiceTimeEntry): Promise<CommercialSnapshot>;
}

export class ServiceEvidenceService {
  constructor(
    private readonly entries: ServiceTimeEntryCollection,
    private readonly charges: ServiceChargeSnapshotCollection,
    private readonly compensation: ServiceCompensationSnapshotCollection,
    private readonly commercial?: ServiceCommercialResolver,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
    commercial?: ServiceCommercialResolver,
  ): Promise<ServiceEvidenceService> {
    const [entries, charges, compensation] = await Promise.all([
      ServiceTimeEntryCollection.create(options),
      ServiceChargeSnapshotCollection.create(options),
      ServiceCompensationSnapshotCollection.create(options),
    ]);
    return new ServiceEvidenceService(
      entries,
      charges,
      compensation,
      commercial,
    );
  }

  async record(input: RecordServiceTimeInput): Promise<ServiceTimeEntry> {
    if (!input.caseId && !(input.workRefType && input.workRefId))
      throw new Error('Service time requires a case or work reference.');
    if (Boolean(input.workRefType) !== Boolean(input.workRefId))
      throw new Error('workRefType and workRefId must be provided together.');
    if (input.participantKind === 'human' && !input.participantProfileId)
      throw new Error('Human service time requires participantProfileId.');
    if (input.participantKind === 'agent' && !input.agentRef)
      throw new Error('Agent service time requires agentRef.');
    if (input.source === 'timer' && (!input.startedAt || !input.endedAt))
      throw new Error('Timer service time requires startedAt and endedAt.');
    if (input.startedAt && input.endedAt && input.startedAt >= input.endedAt)
      throw new Error('Service time startedAt must be before endedAt.');
    const duration =
      input.durationSeconds ??
      (input.startedAt && input.endedAt
        ? Math.round(
            (input.endedAt.getTime() - input.startedAt.getTime()) / 1000,
          )
        : 0);
    if (!Number.isInteger(duration) || duration <= 0)
      throw new Error(
        'Service time durationSeconds must be a positive integer.',
      );
    const entry = await this.entries.create({
      ...input,
      durationSeconds: duration,
      evidence: JSON.stringify(input.evidence ?? []),
      metadata: JSON.stringify(input.metadata ?? {}),
      status: 'draft',
      submittedAt: null,
      submittedByProfileId: null,
      approvedAt: null,
      approvedByProfileId: null,
      approvalPath: '',
      rejectedAt: null,
      rejectedByProfileId: null,
      rejectionReason: '',
      correctionOfId: null,
    });
    await entry.save();
    return entry;
  }

  async submit(
    entry: ServiceTimeEntry,
    profileId?: string,
  ): Promise<ServiceTimeEntry> {
    if (entry.status !== 'draft' && entry.status !== 'rejected')
      throw new Error('Only draft or rejected service time may be submitted.');
    entry.status = 'submitted';
    entry.submittedAt = new Date();
    entry.submittedByProfileId = profileId ?? null;
    return entry.save();
  }

  async approve(
    entry: ServiceTimeEntry,
    options: { actorProfileId?: string; approvalPath: string },
  ): Promise<ServiceTimeEntry> {
    if (entry.status !== 'submitted' && entry.status !== 'approved')
      throw new Error(
        'Only submitted service time or an incomplete approval may be approved.',
      );
    if (!this.commercial)
      throw new Error(
        'A ServiceCommercialResolver is required to approve service time.',
      );
    const timeEntryId = entry.id;
    if (!timeEntryId)
      throw new Error('ServiceTimeEntry must be saved before approval.');
    const existingCharge = (
      await this.charges.list({ where: { timeEntryId }, limit: 1 })
    )[0];
    const existingCompensation = (
      await this.compensation.list({ where: { timeEntryId }, limit: 1 })
    )[0];
    if (entry.status === 'approved' && existingCharge && existingCompensation)
      return entry;

    // Commit approval before either commercial resolver runs. The subscription
    // resolver creates an approved ClientCharge as part of priceClient(), so a
    // failed approval must never leave billable spend behind.
    if (entry.status === 'submitted') {
      entry.status = 'approved';
      entry.approvedAt = new Date();
      entry.approvedByProfileId = options.actorProfileId ?? null;
      entry.approvalPath = options.approvalPath;
      await entry.save();
    }
    const provider = existingCompensation
      ? null
      : await this.commercial.compensateProvider(entry);
    if (provider) {
      const snapshotId = await deterministicSnapshotId(
        'service-compensation-snapshot',
        timeEntryId,
      );
      try {
        await this.compensation.create({
          id: snapshotId,
          tenantId: entry.tenantId,
          timeEntryId,
          amount: provider.amount,
          currency: provider.currency ?? 'USD',
          termsVersion: provider.version,
          rateSnapshot: JSON.stringify(provider.terms),
          _insertOnly: true,
        });
      } catch (error) {
        const concurrent =
          (await this.compensation.get(snapshotId)) ??
          (
            await this.compensation.list({
              where: { timeEntryId },
              limit: 1,
            })
          )[0];
        if (!concurrent) throw error;
      }
    }
    const client = existingCharge
      ? null
      : await this.commercial.priceClient(entry);
    if (client) {
      const snapshotId = await deterministicSnapshotId(
        'service-charge-snapshot',
        timeEntryId,
      );
      try {
        await this.charges.create({
          id: snapshotId,
          tenantId: entry.tenantId,
          timeEntryId,
          amount: client.amount,
          currency: client.currency ?? 'USD',
          pricingVersion: client.version,
          strategy: client.strategy ?? '',
          rateSnapshot: JSON.stringify(client.terms),
          sourceChargeRef: client.sourceRef ?? '',
          _insertOnly: true,
        });
      } catch (error) {
        const concurrent =
          (await this.charges.get(snapshotId)) ??
          (
            await this.charges.list({
              where: { timeEntryId },
              limit: 1,
            })
          )[0];
        if (!concurrent) throw error;
      }
    }
    return entry;
  }

  async correct(
    entry: ServiceTimeEntry,
    input: RecordServiceTimeInput,
  ): Promise<ServiceTimeEntry> {
    if (entry.status !== 'approved')
      throw new Error('Only approved service time may be corrected.');
    if (input.tenantId !== undefined && input.tenantId !== entry.tenantId) {
      throw new Error(
        'Service time corrections must remain in the original tenant.',
      );
    }
    const correction = await this.record({
      ...input,
      tenantId: entry.tenantId,
    });
    correction.correctionOfId = entry.id ?? null;
    await correction.save();
    entry.status = 'corrected';
    await entry.save();
    return correction;
  }
}

async function deterministicSnapshotId(
  kind: string,
  timeEntryId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([kind, timeEntryId]));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const uuid = digest.slice(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x50;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  const hex = Array.from(uuid, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
