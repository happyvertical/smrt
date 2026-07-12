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

    const [client, provider] = await Promise.all([
      existingCharge ? null : this.commercial.priceClient(entry),
      existingCompensation ? null : this.commercial.compensateProvider(entry),
    ]);
    if (entry.status === 'submitted') {
      entry.status = 'approved';
      entry.approvedAt = new Date();
      entry.approvedByProfileId = options.actorProfileId ?? null;
      entry.approvalPath = options.approvalPath;
      await entry.save();
    }
    if (client)
      await (
        await this.charges.create({
          tenantId: entry.tenantId,
          timeEntryId,
          amount: client.amount,
          currency: client.currency ?? 'USD',
          pricingVersion: client.version,
          strategy: client.strategy ?? '',
          rateSnapshot: JSON.stringify(client.terms),
          sourceChargeRef: client.sourceRef ?? '',
        })
      ).save();
    if (provider)
      await (
        await this.compensation.create({
          tenantId: entry.tenantId,
          timeEntryId,
          amount: provider.amount,
          currency: provider.currency ?? 'USD',
          termsVersion: provider.version,
          rateSnapshot: JSON.stringify(provider.terms),
        })
      ).save();
    return entry;
  }

  async correct(
    entry: ServiceTimeEntry,
    input: RecordServiceTimeInput,
  ): Promise<ServiceTimeEntry> {
    if (entry.status !== 'approved')
      throw new Error('Only approved service time may be corrected.');
    const correction = await this.record(input);
    correction.correctionOfId = entry.id ?? null;
    await correction.save();
    entry.status = 'corrected';
    await entry.save();
    return correction;
  }
}
