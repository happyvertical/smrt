/**
 * SupportCaseService — the closed write facade for Support Cases (the
 * `smrt-chat` `ChatService` idiom): case creation, interaction recording,
 * lifecycle transitions, assignment, resolution, reopening, human requests,
 * and work links all flow through here so the audit trail
 * ({@link SupportCaseEvent}) and the lifecycle guard stay coherent. The
 * generated CRUD surface on the case-side models is read-only.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  generateCaseNumber,
  type SupportCase,
  SupportCaseCollection,
} from '../models/support-case.js';
import {
  type SupportCaseEvent,
  SupportCaseEventCollection,
} from '../models/support-case-event.js';
import {
  type SupportInteraction,
  SupportInteractionCollection,
} from '../models/support-interaction.js';
import {
  type SupportPlan,
  SupportPlanCollection,
} from '../models/support-plan.js';
import {
  type SupportWorkLink,
  SupportWorkLinkCollection,
} from '../models/support-work-link.js';
import type {
  SupportActorKind,
  SupportCaseEventType,
  SupportCaseStatus,
  SupportChannelKind,
  SupportInteractionDirection,
  SupportWorkLinkKind,
} from '../types.js';

export interface OpenCaseInput {
  tenantId?: string | null;
  subject: string;
  description?: string;
  priority?: string;
  severity?: string;
  channelKind?: SupportChannelKind | '';
  clientProfileId?: string | null;
  openedByProfileId?: string | null;
  projectId?: string | null;
  bindingId?: string | null;
  threadKey?: string;
  planId?: string | null;
  preferredSpecialistId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RecordInteractionInput {
  direction: SupportInteractionDirection;
  channelKind: SupportChannelKind;
  actorKind: SupportActorKind;
  authorProfileId?: string | null;
  body: string;
  occurredAt?: Date;
  sourceType?: string | null;
  sourceId?: string | null;
  /** Idempotency key; generated (`manual:<uuid>`) when omitted. */
  sourceKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CaseActor {
  actorKind: SupportActorKind;
  actorProfileId?: string | null;
}

export interface CaseTimelineItem {
  kind: 'interaction' | 'event';
  occurredAt: Date;
  interaction?: SupportInteraction;
  event?: SupportCaseEvent;
}

/**
 * The write facade. Construct with {@link SupportCaseService.create}.
 */
export class SupportCaseService {
  readonly cases: SupportCaseCollection;
  readonly interactions: SupportInteractionCollection;
  readonly events: SupportCaseEventCollection;
  readonly workLinks: SupportWorkLinkCollection;
  readonly plans: SupportPlanCollection;

  protected constructor(collections: {
    cases: SupportCaseCollection;
    interactions: SupportInteractionCollection;
    events: SupportCaseEventCollection;
    workLinks: SupportWorkLinkCollection;
    plans: SupportPlanCollection;
  }) {
    this.cases = collections.cases;
    this.interactions = collections.interactions;
    this.events = collections.events;
    this.workLinks = collections.workLinks;
    this.plans = collections.plans;
  }

  static async create(options: SmrtObjectOptions): Promise<SupportCaseService> {
    const [cases, interactions, events, workLinks, plans] = await Promise.all([
      SupportCaseCollection.create(options),
      SupportInteractionCollection.create(options),
      SupportCaseEventCollection.create(options),
      SupportWorkLinkCollection.create(options),
      SupportPlanCollection.create(options),
    ]);
    return new SupportCaseService({
      cases,
      interactions,
      events,
      workLinks,
      plans,
    });
  }

  /** Load a case or throw a descriptive error. */
  async getCase(caseId: string): Promise<SupportCase> {
    const found = await this.cases.get({ id: caseId });
    if (!found) {
      throw new Error(`SupportCase not found: ${caseId}`);
    }
    return found;
  }

  /** The persisted id of a saved case (all facade entry points save first). */
  private caseIdOf(supportCase: SupportCase): string {
    if (!supportCase.id) {
      throw new Error('SupportCase has no id — was it saved?');
    }
    return supportCase.id;
  }

  /**
   * Open a new Support Case. Applies the plan snapshot when a plan is given
   * and writes the `created` audit event.
   */
  async openCase(input: OpenCaseInput): Promise<SupportCase> {
    const supportCase = await this.cases.create({
      tenantId: input.tenantId ?? null,
      caseNumber: generateCaseNumber(),
      subject: input.subject,
      description: input.description ?? '',
      status: 'new' as SupportCaseStatus,
      priority: input.priority ?? 'normal',
      severity: input.severity ?? '',
      channelKind: input.channelKind ?? '',
      clientProfileId: input.clientProfileId ?? null,
      openedByProfileId: input.openedByProfileId ?? null,
      projectId: input.projectId ?? null,
      bindingId: input.bindingId ?? null,
      threadKey: input.threadKey ?? '',
      planId: input.planId ?? null,
      preferredSpecialistId: input.preferredSpecialistId ?? null,
      metadata: JSON.stringify(input.metadata ?? {}),
    });

    if (input.planId) {
      const plan = await this.plans.get({ id: input.planId });
      if (plan) {
        await this.applyPlan(supportCase, plan);
      }
    }

    await this.recordEvent(supportCase, 'created', {
      actorKind: 'system',
      summary: `Case ${supportCase.caseNumber} opened`,
      payload: {
        channelKind: supportCase.channelKind,
        clientProfileId: supportCase.clientProfileId,
        projectId: supportCase.projectId,
      },
    });

    return supportCase;
  }

  /**
   * Capture the plan terms onto the case (`planSnapshot`) so later plan edits
   * never rewrite what this case was handled under.
   */
  async applyPlan(supportCase: SupportCase, plan: SupportPlan): Promise<void> {
    supportCase.planId = plan.id ?? null;
    supportCase.setPlanSnapshot(plan.snapshotTerms());
    await supportCase.save();
    await this.recordEvent(supportCase, 'plan_applied', {
      actorKind: 'system',
      summary: `Plan '${plan.name || plan.planKey}' applied`,
      payload: { planId: plan.id, planKey: plan.planKey },
    });
  }

  /**
   * Record a channel interaction on a case (idempotent on `sourceKey`).
   * Inbound client activity un-parks `waiting_on_client` cases; the first
   * outbound reply stamps `acknowledgedAt`/`firstRespondedAt`.
   */
  async recordInteraction(
    caseRef: SupportCase | string,
    input: RecordInteractionInput,
  ): Promise<SupportInteraction> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;

    const sourceKey = input.sourceKey ?? `manual:${crypto.randomUUID()}`;
    const existing = await this.interactions.bySourceKey(sourceKey);
    if (existing) {
      return existing;
    }

    const interaction = await this.interactions.create({
      tenantId: supportCase.tenantId,
      caseId: this.caseIdOf(supportCase),
      direction: input.direction,
      channelKind: input.channelKind,
      actorKind: input.actorKind,
      authorProfileId: input.authorProfileId ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      body: input.body,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      sourceKey,
      metadata: JSON.stringify(input.metadata ?? {}),
    });

    let caseDirty = false;
    if (input.direction === 'outbound') {
      if (!supportCase.acknowledgedAt) {
        supportCase.acknowledgedAt = interaction.occurredAt;
        caseDirty = true;
      }
      if (
        !supportCase.firstRespondedAt &&
        (input.actorKind === 'specialist' || input.actorKind === 'agent')
      ) {
        supportCase.firstRespondedAt = interaction.occurredAt;
        caseDirty = true;
      }
    }
    if (
      input.direction === 'inbound' &&
      supportCase.status === 'waiting_on_client'
    ) {
      supportCase.status = 'in_progress';
      caseDirty = true;
    }
    if (caseDirty) {
      await supportCase.save();
    }

    await this.recordEvent(supportCase, 'interaction', {
      actorKind: input.actorKind,
      actorProfileId: input.authorProfileId ?? null,
      summary:
        input.direction === 'inbound'
          ? `Inbound ${input.channelKind} interaction`
          : `${input.direction} ${input.channelKind} interaction`,
      payload: { interactionId: interaction.id, direction: input.direction },
    });

    return interaction;
  }

  /** Transition a case's lifecycle status (guarded by the model). */
  async transition(
    caseRef: SupportCase | string,
    to: SupportCaseStatus,
    actor: CaseActor & { reason?: string },
  ): Promise<SupportCase> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;
    const from = supportCase.status;
    if (from === to) {
      return supportCase;
    }
    supportCase.status = to;
    await supportCase.save();
    await this.recordEvent(supportCase, 'transition', {
      actorKind: actor.actorKind,
      actorProfileId: actor.actorProfileId ?? null,
      summary: `Status ${from} → ${to}`,
      payload: { from, to, reason: actor.reason ?? null },
    });
    return supportCase;
  }

  /** Assign (or reassign) a case to a specialist. */
  async assign(
    caseRef: SupportCase | string,
    input: CaseActor & {
      specialistId: string;
      rationale?: Record<string, unknown>;
    },
  ): Promise<SupportCase> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;
    const previousSpecialistId = supportCase.assignedSpecialistId;
    supportCase.assignedSpecialistId = input.specialistId;
    supportCase.assignedAt = new Date();
    if (supportCase.status === 'new' || supportCase.status === 'triaged') {
      supportCase.status = 'assigned';
    }
    await supportCase.save();
    await this.recordEvent(supportCase, 'assignment', {
      actorKind: input.actorKind,
      actorProfileId: input.actorProfileId ?? null,
      summary: previousSpecialistId ? 'Case reassigned' : 'Case assigned',
      payload: {
        specialistId: input.specialistId,
        previousSpecialistId,
        rationale: input.rationale ?? null,
      },
    });
    return supportCase;
  }

  /** Resolve a case with a resolution summary. */
  async resolve(
    caseRef: SupportCase | string,
    input: CaseActor & {
      summary: string;
      resolutionKind?: 'automated' | 'human' | 'delivery';
    },
  ): Promise<SupportCase> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;
    const from = supportCase.status;
    supportCase.status = 'resolved';
    supportCase.resolvedAt = new Date();
    supportCase.resolvedByProfileId = input.actorProfileId ?? null;
    supportCase.resolutionKind = input.resolutionKind ?? 'human';
    supportCase.resolutionSummary = input.summary;
    await supportCase.save();
    await this.recordEvent(supportCase, 'transition', {
      actorKind: input.actorKind,
      actorProfileId: input.actorProfileId ?? null,
      summary: `Status ${from} → resolved`,
      payload: {
        from,
        to: 'resolved',
        resolutionKind: supportCase.resolutionKind,
        resolutionSummary: input.summary,
      },
    });
    return supportCase;
  }

  /** Close a resolved case. */
  async close(
    caseRef: SupportCase | string,
    actor: CaseActor & { reason?: string },
  ): Promise<SupportCase> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;
    supportCase.closedAt = new Date();
    return this.transition(supportCase, 'closed', actor);
  }

  /**
   * Reopen a resolved/closed case, preserving the prior resolution in the
   * reopen event (FR-29b) and bumping `reopenCount`.
   */
  async reopen(
    caseRef: SupportCase | string,
    actor: CaseActor & { reason?: string; to?: SupportCaseStatus },
  ): Promise<SupportCase> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;
    const priorResolution = {
      resolvedAt: supportCase.resolvedAt?.toISOString() ?? null,
      resolvedByProfileId: supportCase.resolvedByProfileId,
      resolutionKind: supportCase.resolutionKind,
      resolutionSummary: supportCase.resolutionSummary,
      closedAt: supportCase.closedAt?.toISOString() ?? null,
      reopenIndex: supportCase.reopenCount + 1,
    };
    const from = supportCase.status;
    supportCase.status = actor.to ?? 'triaged';
    supportCase.reopenCount += 1;
    supportCase.lastReopenedAt = new Date();
    supportCase.resolvedAt = null;
    supportCase.resolvedByProfileId = null;
    supportCase.resolutionKind = '';
    supportCase.resolutionSummary = '';
    supportCase.closedAt = null;
    await supportCase.save();
    await this.recordEvent(supportCase, 'reopened', {
      actorKind: actor.actorKind,
      actorProfileId: actor.actorProfileId ?? null,
      summary: `Case reopened (from ${from})`,
      payload: {
        from,
        to: supportCase.status,
        reason: actor.reason ?? null,
        priorResolution,
      },
    });
    return supportCase;
  }

  /**
   * Record that the Client explicitly requested a human (FR-28b). The actual
   * handoff (routing + context transfer) is performed by the handoff service;
   * this stamps the request and its audit event.
   */
  async requestHuman(
    caseRef: SupportCase | string,
    input: { byProfileId?: string | null; note?: string },
  ): Promise<SupportCase> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;
    if (!supportCase.humanRequestedAt) {
      supportCase.humanRequestedAt = new Date();
      await supportCase.save();
    }
    await this.recordEvent(supportCase, 'human_requested', {
      actorKind: 'client',
      actorProfileId: input.byProfileId ?? null,
      summary: 'Client requested a human',
      payload: { note: input.note ?? null },
    });
    return supportCase;
  }

  /**
   * Link separately tracked work to the case (Support Work Item or a
   * Delivery Handoff's Development Work Item). Support keeps the Case as the
   * canonical client record; the linked item's execution belongs to its
   * owning domain (FR-29a).
   */
  async linkWork(
    caseRef: SupportCase | string,
    input: CaseActor & {
      linkKind: SupportWorkLinkKind;
      targetType: string;
      targetId: string;
      targetLabel?: string;
      externalUrl?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SupportWorkLink> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;
    const link = await this.workLinks.create({
      tenantId: supportCase.tenantId,
      caseId: this.caseIdOf(supportCase),
      linkKind: input.linkKind,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel ?? '',
      externalUrl: input.externalUrl ?? '',
      metadata: JSON.stringify(input.metadata ?? {}),
    });
    await this.recordEvent(supportCase, 'work_linked', {
      actorKind: input.actorKind,
      actorProfileId: input.actorProfileId ?? null,
      summary:
        input.linkKind === 'development_work_item'
          ? `Delivery Handoff → ${input.targetLabel || input.targetId}`
          : `Support work item linked: ${input.targetLabel || input.targetId}`,
      payload: {
        linkId: link.id,
        linkKind: input.linkKind,
        targetType: input.targetType,
        targetId: input.targetId,
      },
    });
    return link;
  }

  /**
   * Record a status echo reported back from the domain owning a linked work
   * item (Delivery Operations reports progress; Support never drives it).
   */
  async recordWorkStatus(
    linkId: string,
    input: { status: string; note?: string },
  ): Promise<SupportWorkLink> {
    const link = await this.workLinks.get({ id: linkId });
    if (!link) {
      throw new Error(`SupportWorkLink not found: ${linkId}`);
    }
    link.status = input.status;
    link.lastStatusAt = new Date();
    await link.save();
    const supportCase = await this.getCase(link.caseId);
    await this.recordEvent(supportCase, 'work_linked', {
      actorKind: 'system',
      summary: `Linked work '${link.targetLabel || link.targetId}' → ${input.status}`,
      payload: {
        linkId: link.id,
        status: input.status,
        note: input.note ?? null,
      },
    });
    return link;
  }

  /** Append an audit event to a case. */
  async recordEvent(
    caseRef: SupportCase | string,
    eventType: SupportCaseEventType,
    input: {
      actorKind: SupportActorKind;
      actorProfileId?: string | null;
      summary: string;
      payload?: Record<string, unknown>;
      occurredAt?: Date;
    },
  ): Promise<SupportCaseEvent> {
    const supportCase =
      typeof caseRef === 'string' ? await this.getCase(caseRef) : caseRef;
    return this.events.create({
      tenantId: supportCase.tenantId,
      caseId: this.caseIdOf(supportCase),
      eventType,
      actorKind: input.actorKind,
      actorProfileId: input.actorProfileId ?? null,
      occurredAt: input.occurredAt ?? new Date(),
      summary: input.summary,
      payload: JSON.stringify(input.payload ?? {}),
    });
  }

  /**
   * The merged case timeline: interactions and audit events in one
   * chronological stream (the queue/detail UI's data shape, and the context
   * package a Human Handoff transfers).
   */
  async getTimeline(caseId: string): Promise<CaseTimelineItem[]> {
    const [interactions, events] = await Promise.all([
      this.interactions.forCase(caseId),
      this.events.forCase(caseId),
    ]);
    const items: CaseTimelineItem[] = [
      ...interactions.map((interaction) => ({
        kind: 'interaction' as const,
        occurredAt: interaction.occurredAt,
        interaction,
      })),
      ...events.map((event) => ({
        kind: 'event' as const,
        occurredAt: event.occurredAt,
        event,
      })),
    ];
    return items.sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
  }
}

export default SupportCaseService;
