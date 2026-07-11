/**
 * ServiceTimeEntryService — the shared recording contract for Service Time
 * Entries (FR-40, issue #1930): timer, manual, imported, and automatic agent
 * entries all pass ONE validation and audit gate, so no source can smuggle in
 * an incoherent duration, participant, or work context.
 *
 * Recording is deliberately money-free: entries capture the work (duration,
 * period, evidence, participant, context) and land as `draft`; pricing and
 * earnings derive later, at approval time, in `TimeEntryApprovalService`.
 * Case-attached entries append a `time_recorded` audit event so the case
 * timeline shows the work as it happens.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  type ServiceTimeEntry,
  ServiceTimeEntryCollection,
} from '../models/service-time-entry.js';
import type { SupportCase } from '../models/support-case.js';
import type {
  ServiceTimeEntrySource,
  SupportParticipantKind,
  TimeEntryEvidence,
} from '../types.js';
import { SupportCaseService } from './support-case-service.js';

/** Options for {@link ServiceTimeEntryService.create}. */
export interface ServiceTimeEntryServiceOptions extends SmrtObjectOptions {
  /** Share an existing case facade (otherwise one is created internally). */
  caseService?: SupportCaseService;
}

/** Input for {@link ServiceTimeEntryService.record} — all four sources. */
export interface RecordServiceTimeEntryInput {
  tenantId?: string | null;
  /** Support Case context (either this or the work ref pair is required). */
  caseId?: string | null;
  /** Polymorphic work context: qualified class name + id, together. */
  workRefType?: string | null;
  workRefId?: string | null;
  /** Specialist role record, when the deliverer is a Support Specialist. */
  specialistId?: string | null;
  participantKind: SupportParticipantKind;
  /** Delivering human Participant — required when `participantKind: 'human'`. */
  participantProfileId?: string | null;
  /** Delivering agent identity — required when `participantKind: 'agent'`. */
  agentRef?: string;
  source: ServiceTimeEntrySource;
  description?: string;
  startedAt?: Date;
  endedAt?: Date;
  /** Explicit duration; derived from `endedAt − startedAt` when omitted. */
  durationSeconds?: number;
  evidence?: TimeEntryEvidence[];
  metadata?: Record<string, unknown>;
}

/** Input for {@link ServiceTimeEntryService.submit}. */
export interface SubmitServiceTimeEntryInput {
  byProfileId?: string | null;
}

/**
 * The write facade for recording and submitting Service Time Entries.
 * Construct with {@link ServiceTimeEntryService.create}.
 */
export class ServiceTimeEntryService {
  readonly entries: ServiceTimeEntryCollection;
  readonly caseService: SupportCaseService;

  protected constructor(collections: {
    entries: ServiceTimeEntryCollection;
    caseService: SupportCaseService;
  }) {
    this.entries = collections.entries;
    this.caseService = collections.caseService;
  }

  static async create(
    options: ServiceTimeEntryServiceOptions,
  ): Promise<ServiceTimeEntryService> {
    const caseService =
      options.caseService ?? (await SupportCaseService.create(options));
    const entries = await ServiceTimeEntryCollection.create(options);
    return new ServiceTimeEntryService({ entries, caseService });
  }

  /** Load an entry or throw a descriptive error. */
  async getEntry(
    entryRef: ServiceTimeEntry | string,
  ): Promise<ServiceTimeEntry> {
    if (typeof entryRef !== 'string') {
      return entryRef;
    }
    const found = await this.entries.get({ id: entryRef });
    if (!found) {
      throw new Error(`ServiceTimeEntry not found: ${entryRef}`);
    }
    return found;
  }

  /**
   * Record one Service Time Entry as a `draft`. One validation contract for
   * all four sources (FR-40):
   *
   * - a work context is required: `caseId` and/or the `workRefType`/`workRefId`
   *   pair (a case-attached entry copies the case's tenant unless given);
   * - the participant must be coherent: `human` needs `participantProfileId`,
   *   `agent` needs `agentRef`;
   * - `timer` entries need both period bounds; every entry needs a positive
   *   duration — explicit `durationSeconds` or derived `endedAt − startedAt`.
   *
   * Case-attached entries append a `time_recorded` audit event.
   */
  async record(input: RecordServiceTimeEntryInput): Promise<ServiceTimeEntry> {
    const hasWorkRef = Boolean(input.workRefType) || Boolean(input.workRefId);
    if (hasWorkRef && !(input.workRefType && input.workRefId)) {
      throw new Error(
        'ServiceTimeEntry: workRefType and workRefId must be provided together.',
      );
    }
    if (!input.caseId && !hasWorkRef) {
      throw new Error(
        'ServiceTimeEntry: a work context is required — provide caseId or the workRefType/workRefId pair.',
      );
    }

    if (input.participantKind === 'human' && !input.participantProfileId) {
      throw new Error(
        "ServiceTimeEntry: participantKind 'human' requires participantProfileId (the delivering Participant).",
      );
    }
    if (input.participantKind === 'agent' && !input.agentRef) {
      throw new Error(
        "ServiceTimeEntry: participantKind 'agent' requires agentRef (the delivering agent identity).",
      );
    }

    if (input.source === 'timer' && !(input.startedAt && input.endedAt)) {
      throw new Error(
        "ServiceTimeEntry: source 'timer' requires both startedAt and endedAt.",
      );
    }
    if (
      input.startedAt &&
      input.endedAt &&
      input.startedAt.getTime() >= input.endedAt.getTime()
    ) {
      throw new Error('ServiceTimeEntry: startedAt must be before endedAt.');
    }

    const durationSeconds =
      input.durationSeconds ??
      (input.startedAt && input.endedAt
        ? Math.round(
            (input.endedAt.getTime() - input.startedAt.getTime()) / 1000,
          )
        : undefined);
    if (durationSeconds === undefined) {
      throw new Error(
        'ServiceTimeEntry: a duration is required — provide durationSeconds or both startedAt and endedAt.',
      );
    }
    if (!(durationSeconds > 0)) {
      throw new Error(
        `ServiceTimeEntry: durationSeconds must be greater than zero (got ${durationSeconds}).`,
      );
    }

    let tenantId = input.tenantId ?? null;
    let supportCase: SupportCase | null = null;
    if (input.caseId) {
      supportCase = await this.caseService.getCase(input.caseId);
      if (input.tenantId === undefined) {
        tenantId = supportCase.tenantId;
      } else if ((input.tenantId ?? null) !== supportCase.tenantId) {
        // An explicit tenant must agree with the case — otherwise the entry
        // would be a cross-tenant reference onto another tenant's case.
        throw new Error(
          `ServiceTimeEntry: tenantId '${input.tenantId}' does not match the case's tenant '${supportCase.tenantId}'.`,
        );
      }
    }

    const entry = await this.entries.create({
      tenantId,
      caseId: input.caseId ?? null,
      workRefType: input.workRefType ?? null,
      workRefId: input.workRefId ?? null,
      specialistId: input.specialistId ?? null,
      participantKind: input.participantKind,
      participantProfileId: input.participantProfileId ?? null,
      agentRef: input.agentRef ?? '',
      source: input.source,
      description: input.description ?? '',
      startedAt: input.startedAt ?? null,
      endedAt: input.endedAt ?? null,
      durationSeconds,
      evidence: JSON.stringify(input.evidence ?? []),
      status: 'draft',
      metadata: JSON.stringify(input.metadata ?? {}),
    });

    if (supportCase) {
      await this.caseService.recordEvent(supportCase, 'time_recorded', {
        actorKind: input.participantKind === 'agent' ? 'agent' : 'specialist',
        actorProfileId: input.participantProfileId ?? null,
        summary: `Time recorded: ${(durationSeconds / 3600).toFixed(2)}h (${input.source})`,
        payload: {
          timeEntryId: entry.id,
          durationSeconds,
          source: input.source,
          participantKind: input.participantKind,
        },
      });
    }

    return entry;
  }

  /**
   * Submit a `draft` (or resubmit a `rejected`) entry for approval, stamping
   * the submitter. Approval itself is `TimeEntryApprovalService`'s job.
   */
  async submit(
    entryRef: ServiceTimeEntry | string,
    input: SubmitServiceTimeEntryInput = {},
  ): Promise<ServiceTimeEntry> {
    const entry = await this.getEntry(entryRef);
    if (entry.status !== 'draft' && entry.status !== 'rejected') {
      throw new Error(
        `ServiceTimeEntry ${entry.id}: only 'draft' or 'rejected' entries can be submitted (status is '${entry.status}').`,
      );
    }
    entry.status = 'submitted';
    entry.submittedAt = new Date();
    entry.submittedByProfileId = input.byProfileId ?? null;
    await entry.save();
    return entry;
  }
}

export default ServiceTimeEntryService;
