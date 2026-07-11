/**
 * HumanHandoffService — the lossless Human Handoff (FR-28b, issue #1928).
 * Whatever pulls the trigger (an explicit client request, low answer
 * confidence, a sensitive classification, high severity, failed automation,
 * a policy cap, or a manual escalation), the handoff transfers the FULL case
 * context — current state, the merged interaction/event timeline, and every
 * prior {@link SupportAiRun} — so the Client never repeats themselves and the
 * Support Specialist starts with the complete history.
 *
 * A no-repeat guarantee keeps at most one handoff active per case
 * (`metadata.activeHandoff`): repeat triggers while one is pending only
 * append a deduped audit event. Routing is a seam — the #1929 routing
 * service plugs in via `assignSpecialist`; without it the case is queued for
 * manual pickup (`new` → `triaged`).
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  type SupportAiRun,
  SupportAiRunCollection,
} from '../models/support-ai-run.js';
import type { SupportCase } from '../models/support-case.js';
import type { HumanHandoffTrigger } from '../types.js';
import {
  type CaseTimelineItem,
  SupportCaseService,
} from './support-case-service.js';

/** One compact timeline entry inside a {@link HandoffContextPackage}. */
export interface HandoffTimelineItem {
  kind: 'interaction' | 'event';
  /** ISO-8601 timestamp (the package is embedded in a JSON event payload). */
  occurredAt: string;
  actorKind: string;
  summary: string;
  /** Interaction body — the Client's own words travel with the handoff. */
  body?: string;
}

/** One compact AI-run entry inside a {@link HandoffContextPackage}. */
export interface HandoffAiRunSummary {
  phase: string;
  outcome: string;
  confidence: number | null;
  classification: Record<string, unknown>;
  error: string | null;
}

/**
 * The lossless context a Human Handoff transfers (FR-28b): the case's current
 * state plus the merged timeline and every prior automated-work audit row.
 * This is what the assigned Support Specialist receives — the Client never
 * repeats themselves.
 */
export interface HandoffContextPackage {
  caseNumber: string;
  subject: string;
  status: string;
  severity: string;
  category: string;
  clientProfileId: string | null;
  projectId: string | null;
  planId: string | null;
  timeline: HandoffTimelineItem[];
  aiRuns: HandoffAiRunSummary[];
}

/**
 * The routing seam (#1929): pick the Support Specialist for a handed-off
 * case. Return `null` to leave the case in the queue for manual assignment.
 */
export type SpecialistRouter = (
  supportCase: SupportCase,
  context: { trigger: HumanHandoffTrigger },
) => Promise<{
  specialistId: string;
  rationale?: Record<string, unknown>;
} | null>;

/** Options for {@link HumanHandoffService.create}. */
export interface HumanHandoffServiceOptions extends SmrtObjectOptions {
  /** Routing seam; omitted → handed-off cases queue for manual assignment. */
  assignSpecialist?: SpecialistRouter;
}

/** Input for one {@link HumanHandoffService.handoff} call. */
export interface HumanHandoffInput {
  trigger: HumanHandoffTrigger;
  /** Free-form context for the audit event (why the trigger fired). */
  note?: string;
  /** The requesting Client profile, for `client_request` triggers. */
  requestedByProfileId?: string | null;
}

/** Result of one {@link HumanHandoffService.handoff} call. */
export interface HumanHandoffResult {
  supportCase: SupportCase;
  /** True when an earlier handoff was still active (no-repeat guarantee). */
  alreadyActive: boolean;
}

/**
 * The Human Handoff engine. Construct with {@link HumanHandoffService.create}.
 */
export class HumanHandoffService {
  readonly caseService: SupportCaseService;
  readonly aiRuns: SupportAiRunCollection;
  private readonly assignSpecialist?: SpecialistRouter;

  protected constructor(deps: {
    caseService: SupportCaseService;
    aiRuns: SupportAiRunCollection;
    assignSpecialist?: SpecialistRouter;
  }) {
    this.caseService = deps.caseService;
    this.aiRuns = deps.aiRuns;
    this.assignSpecialist = deps.assignSpecialist;
  }

  static async create(
    options: HumanHandoffServiceOptions,
  ): Promise<HumanHandoffService> {
    const [caseService, aiRuns] = await Promise.all([
      SupportCaseService.create(options),
      SupportAiRunCollection.create(options),
    ]);
    return new HumanHandoffService({
      caseService,
      aiRuns,
      assignSpecialist: options.assignSpecialist,
    });
  }

  /**
   * Assemble the lossless context package for a case: current state, the
   * merged interaction/event timeline, and every prior AI run (FR-28b).
   */
  async buildContextPackage(caseId: string): Promise<HandoffContextPackage> {
    const supportCase = await this.caseService.getCase(caseId);
    const [timeline, runs] = await Promise.all([
      this.caseService.getTimeline(caseId),
      this.aiRuns.forCase(caseId),
    ]);
    return {
      caseNumber: supportCase.caseNumber,
      subject: supportCase.subject,
      status: supportCase.status,
      severity: supportCase.severity,
      category: supportCase.category,
      clientProfileId: supportCase.clientProfileId,
      projectId: supportCase.projectId,
      planId: supportCase.planId,
      timeline: timeline.map((item) => compactTimelineItem(item)),
      aiRuns: runs.map((run) => compactAiRun(run)),
    };
  }

  /**
   * Hand the case to a human: enforce the no-repeat guarantee, stamp
   * `metadata.activeHandoff`, record the `handoff` audit event carrying the
   * full context package, then route via the `assignSpecialist` seam (or
   * queue the case as `triaged` when unrouted).
   */
  async handoff(
    caseRef: SupportCase | string,
    input: HumanHandoffInput,
  ): Promise<HumanHandoffResult> {
    const supportCase =
      typeof caseRef === 'string'
        ? await this.caseService.getCase(caseRef)
        : caseRef;
    const caseId = this.caseIdOf(supportCase);

    // No-repeat guarantee: while one handoff is pending, repeat triggers only
    // append a deduped audit event — assignment never runs twice.
    if (this.isHandoffActive(supportCase)) {
      await this.caseService.recordEvent(supportCase, 'handoff', {
        actorKind: 'system',
        summary: `Human handoff (${input.trigger}) deduped — one already active`,
        payload: { trigger: input.trigger, deduped: true },
      });
      return { supportCase, alreadyActive: true };
    }

    supportCase.updateMetadata({
      activeHandoff: { trigger: input.trigger, at: new Date().toISOString() },
    });
    await supportCase.save();

    if (input.trigger === 'client_request') {
      await this.caseService.requestHuman(supportCase, {
        byProfileId: input.requestedByProfileId ?? null,
        note: input.note,
      });
    }

    const contextPackage = await this.buildContextPackage(caseId);
    await this.caseService.recordEvent(supportCase, 'handoff', {
      actorKind: 'system',
      summary: `Human handoff triggered (${input.trigger})`,
      payload: {
        trigger: input.trigger,
        note: input.note ?? null,
        contextPackage,
      },
    });

    let routed: Awaited<ReturnType<SpecialistRouter>> = null;
    if (this.assignSpecialist) {
      routed = await this.assignSpecialist(supportCase, {
        trigger: input.trigger,
      });
    }
    if (routed) {
      await this.caseService.assign(supportCase, {
        actorKind: 'system',
        specialistId: routed.specialistId,
        rationale: routed.rationale,
      });
    } else if (supportCase.status === 'new') {
      await this.caseService.transition(supportCase, 'triaged', {
        actorKind: 'system',
        reason: 'human handoff queued',
      });
    }

    return { supportCase, alreadyActive: false };
  }

  /**
   * Clear the active-handoff flag so a later trigger can hand off again.
   * Apps call this when the handoff concludes (assignment accepted or the
   * case resolves); a resolve-then-reopen also invalidates the flag
   * automatically inside {@link handoff}.
   */
  async releaseHandoff(caseRef: SupportCase | string): Promise<SupportCase> {
    const supportCase =
      typeof caseRef === 'string'
        ? await this.caseService.getCase(caseRef)
        : caseRef;
    if (supportCase.getMetadata().activeHandoff) {
      supportCase.updateMetadata({ activeHandoff: null });
      await supportCase.save();
    }
    return supportCase;
  }

  /**
   * Whether a handoff is still pending on the case. A flag survives only
   * while the case stays open; a resolve-and-reopen since the flag was set
   * makes it stale (the new conversation may hand off afresh).
   */
  private isHandoffActive(supportCase: SupportCase): boolean {
    const active = supportCase.getMetadata().activeHandoff;
    if (!active || typeof active !== 'object') {
      return false;
    }
    if (!supportCase.isOpen()) {
      return false;
    }
    const at = Date.parse(String((active as Record<string, unknown>).at ?? ''));
    if (
      Number.isFinite(at) &&
      supportCase.lastReopenedAt &&
      supportCase.lastReopenedAt.getTime() > at
    ) {
      return false;
    }
    return true;
  }

  /** The persisted id of a saved case. */
  private caseIdOf(supportCase: SupportCase): string {
    if (!supportCase.id) {
      throw new Error('SupportCase has no id — was it saved?');
    }
    return supportCase.id;
  }
}

/** Compact one merged-timeline item for the context package. */
function compactTimelineItem(item: CaseTimelineItem): HandoffTimelineItem {
  if (item.kind === 'interaction' && item.interaction) {
    return {
      kind: 'interaction',
      occurredAt: item.occurredAt.toISOString(),
      actorKind: item.interaction.actorKind,
      summary: `${item.interaction.direction} ${item.interaction.channelKind}`,
      body: item.interaction.body,
    };
  }
  return {
    kind: 'event',
    occurredAt: item.occurredAt.toISOString(),
    actorKind: item.event?.actorKind ?? 'system',
    summary: item.event?.summary ?? '',
  };
}

/** Compact one AI run for the context package. */
function compactAiRun(run: SupportAiRun): HandoffAiRunSummary {
  return {
    phase: run.phase,
    outcome: run.outcome,
    confidence: run.confidence,
    classification: run.getClassification(),
    error: run.error || null,
  };
}

export default HumanHandoffService;
