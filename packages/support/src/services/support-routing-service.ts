/**
 * SupportRoutingService — Project-qualified Support Case routing (FR-30).
 *
 * Ranks Support Specialists for a case with an **explainable** score: every
 * hard eligibility check (active status, effective Project Support
 * Qualification, workload cap, availability) is recorded as a factor on the
 * ranked entry, so the queue UI can show *why* someone was or wasn't chosen.
 * Ineligible specialists stay in the returned ranking (`eligible: false`)
 * for that rationale display.
 *
 * `autoAssign` writes the assignment through {@link SupportCaseService} with
 * the ranking rationale in the audit event; `reassign` is the manual
 * override, gated by the `support.reassign-case` permission split and a
 * cross-tenant guard.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import type { SupportCase } from '../models/support-case.js';
import type { SupportAvailability } from '../models/support-specialist.js';
import {
  SupportAvailabilityCollection,
  SupportQualificationCollection,
  type SupportSpecialist,
  SupportSpecialistCollection,
} from '../models/support-specialist.js';
import {
  REASSIGN_CASE_PERMISSION,
  type SupportPrincipal,
} from '../permissions.js';
import type { SupportActorKind, SupportQualificationLevel } from '../types.js';
import { zonedParts } from './coverage-calendar.js';
import { SupportCaseService } from './support-case-service.js';

/**
 * Named scoring weights, so the ranking is auditable against the code.
 * Factors carry the raw signals; the score composes them with these weights.
 */
export const ROUTING_WEIGHTS = {
  /** Case/plan preferred specialist (FR-30) — considered first. */
  PREFERRED_SPECIALIST: 100,
  /** Effective `expert` Project Support Qualification. */
  QUALIFICATION_EXPERT: 30,
  /** Effective `qualified` Project Support Qualification. */
  QUALIFICATION_QUALIFIED: 20,
  /** Effective `trainee` Project Support Qualification. */
  QUALIFICATION_TRAINEE: 5,
  /** An active on-call span at the routing instant. */
  ON_CALL: 25,
  /** A weekly availability window covering the routing instant. */
  WEEKLY_AVAILABLE: 15,
  /** Maximum workload-headroom bonus (scaled by free capacity). */
  WORKLOAD_HEADROOM_MAX: 10,
  /** Case language ∈ specialist languages. */
  LANGUAGE_MATCH: 10,
} as const;

const QUALIFICATION_WEIGHTS: Record<SupportQualificationLevel, number> = {
  expert: ROUTING_WEIGHTS.QUALIFICATION_EXPERT,
  qualified: ROUTING_WEIGHTS.QUALIFICATION_QUALIFIED,
  trainee: ROUTING_WEIGHTS.QUALIFICATION_TRAINEE,
};

/** Strongest-first ordering for picking the effective qualification level. */
const QUALIFICATION_RANK: Record<SupportQualificationLevel, number> = {
  expert: 3,
  qualified: 2,
  trainee: 1,
};

/** One specialist's routing evaluation for a case. */
export interface RankedSpecialist {
  specialistId: string;
  displayName: string;
  score: number;
  /** Whether every hard eligibility filter passed. */
  eligible: boolean;
  /** The raw signals behind the score/eligibility (rationale display). */
  factors: Record<string, number | string | boolean>;
}

/** Result of an {@link SupportRoutingService.autoAssign} attempt. */
export interface AutoAssignResult {
  assigned: boolean;
  specialistId?: string;
  ranking: RankedSpecialist[];
}

/** Thrown when a manual reassignment is refused (permission or tenant). */
export class ReassignDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReassignDeniedError';
  }
}

/** Options for {@link SupportRoutingService.create}. */
export interface SupportRoutingServiceOptions extends SmrtObjectOptions {
  /** Share an existing case service (and its collections) with the router. */
  caseService?: SupportCaseService;
}

/** Compact ranking rows embedded in assignment rationale payloads. */
function compactRanking(
  ranking: RankedSpecialist[],
  limit: number,
): Array<
  Pick<RankedSpecialist, 'specialistId' | 'displayName' | 'score' | 'eligible'>
> {
  return ranking.slice(0, limit).map((entry) => ({
    specialistId: entry.specialistId,
    displayName: entry.displayName,
    score: entry.score,
    eligible: entry.eligible,
  }));
}

/** Whether an absolute availability span covers the instant. */
function spanActiveAt(window: SupportAvailability, at: Date): boolean {
  if (!window.startsAt) {
    return false; // A span without a start never activates.
  }
  if (window.startsAt.getTime() > at.getTime()) {
    return false;
  }
  return window.endsAt === null || at.getTime() < window.endsAt.getTime();
}

/**
 * The routing engine. Construct with {@link SupportRoutingService.create}.
 */
export class SupportRoutingService {
  readonly caseService: SupportCaseService;
  readonly specialists: SupportSpecialistCollection;
  readonly qualifications: SupportQualificationCollection;
  readonly availabilities: SupportAvailabilityCollection;

  protected constructor(collections: {
    caseService: SupportCaseService;
    specialists: SupportSpecialistCollection;
    qualifications: SupportQualificationCollection;
    availabilities: SupportAvailabilityCollection;
  }) {
    this.caseService = collections.caseService;
    this.specialists = collections.specialists;
    this.qualifications = collections.qualifications;
    this.availabilities = collections.availabilities;
  }

  static async create(
    options: SupportRoutingServiceOptions,
  ): Promise<SupportRoutingService> {
    const { caseService, ...smrtOptions } = options;
    const [service, specialists, qualifications, availabilities] =
      await Promise.all([
        caseService ?? SupportCaseService.create(smrtOptions),
        SupportSpecialistCollection.create(smrtOptions),
        SupportQualificationCollection.create(smrtOptions),
        SupportAvailabilityCollection.create(smrtOptions),
      ]);
    return new SupportRoutingService({
      caseService: service,
      specialists,
      qualifications,
      availabilities,
    });
  }

  private async resolveCase(
    caseRef: SupportCase | string,
  ): Promise<SupportCase> {
    return typeof caseRef === 'string'
      ? this.caseService.getCase(caseRef)
      : caseRef;
  }

  /**
   * Rank every Support Specialist for a case at an instant.
   *
   * Hard eligibility filters — each recorded as a factor:
   * - `status` must be `active`;
   * - when the case carries a `projectId`, an *effective* Project Support
   *   Qualification for that project (`projectQualification` is the level,
   *   or `'expired'`/`'none'` on failure);
   * - open assigned cases below `maxConcurrentCases` (`openCases`,
   *   `workloadExceeded`);
   * - available at `at`: a weekly window in the specialist's own timezone or
   *   an active on-call span, and not inside a time-off span
   *   (`weeklyAvailable`, `onCall`, `timeOff`).
   *
   * Ineligible specialists are returned too (`eligible: false`) so the UI
   * can show the failing factor. Sorted by score descending, then display
   * name, then id.
   */
  async rankSpecialists(
    caseRef: SupportCase | string,
    opts: { at?: Date; exclude?: string[] } = {},
  ): Promise<RankedSpecialist[]> {
    const supportCase = await this.resolveCase(caseRef);
    const at = opts.at ?? new Date();
    const excluded = new Set(opts.exclude ?? []);

    const specialists = await this.specialists.list({});
    const ranked: RankedSpecialist[] = [];

    for (const specialist of specialists) {
      ranked.push(
        await this.evaluateSpecialist(supportCase, specialist, at, excluded),
      );
    }

    return ranked.sort(
      (a, b) =>
        b.score - a.score ||
        a.displayName.localeCompare(b.displayName) ||
        a.specialistId.localeCompare(b.specialistId),
    );
  }

  private async evaluateSpecialist(
    supportCase: SupportCase,
    specialist: SupportSpecialist,
    at: Date,
    excluded: Set<string>,
  ): Promise<RankedSpecialist> {
    const specialistId = specialist.id ?? '';
    const factors: Record<string, number | string | boolean> = {};
    let eligible = true;
    let score = 0;

    factors.status = specialist.status;
    if (!specialist.isActive()) {
      eligible = false;
    }

    // Tenant boundary (hard filter): a case never routes to another
    // tenant's specialist, even when ranking runs without an ambient
    // tenant context (system/job paths list across tenants).
    if (
      specialist.tenantId &&
      supportCase.tenantId &&
      specialist.tenantId !== supportCase.tenantId
    ) {
      factors.tenantMismatch = true;
      eligible = false;
    }

    if (excluded.has(specialistId)) {
      factors.excluded = true;
      eligible = false;
    }

    // Project Support Qualification (hard filter when the case has a project).
    if (supportCase.projectId) {
      const qualifications = (
        await this.qualifications.forSpecialist(specialistId)
      ).filter((q) => q.projectId === supportCase.projectId);
      const effective = qualifications.filter((q) => q.isEffectiveAt(at));
      if (effective.length > 0) {
        const level = effective
          .map((q) => q.level)
          .sort((a, b) => QUALIFICATION_RANK[b] - QUALIFICATION_RANK[a])[0];
        factors.projectQualification = level;
        score += QUALIFICATION_WEIGHTS[level];
      } else {
        factors.projectQualification =
          qualifications.length > 0 ? 'expired' : 'none';
        eligible = false;
      }
    }

    // Workload cap.
    const openCases = await this.caseService.cases.findQueue({
      assignedSpecialistId: specialistId,
      openOnly: true,
      limit: 1000,
    });
    factors.openCases = openCases.length;
    factors.maxConcurrentCases = specialist.maxConcurrentCases;
    if (openCases.length >= specialist.maxConcurrentCases) {
      factors.workloadExceeded = true;
      eligible = false;
    } else if (specialist.maxConcurrentCases > 0) {
      score += Math.round(
        (ROUTING_WEIGHTS.WORKLOAD_HEADROOM_MAX *
          (specialist.maxConcurrentCases - openCases.length)) /
          specialist.maxConcurrentCases,
      );
    }

    // Availability at `at`, in the specialist's own timezone.
    const windows = await this.availabilities.forSpecialist(specialistId);
    const wall = zonedParts(at, specialist.timezone || 'UTC');
    const weeklyAvailable = windows.some(
      (window) =>
        window.kind === 'weekly' &&
        window.weekday === wall.weekday &&
        wall.minuteOfDay >= window.startMinute &&
        wall.minuteOfDay < window.endMinute,
    );
    const onCall = windows.some(
      (window) => window.kind === 'on_call' && spanActiveAt(window, at),
    );
    const timeOff = windows.some(
      (window) => window.kind === 'time_off' && spanActiveAt(window, at),
    );
    factors.weeklyAvailable = weeklyAvailable;
    factors.onCall = onCall;
    factors.timeOff = timeOff;
    if (timeOff || (!weeklyAvailable && !onCall)) {
      eligible = false;
    }
    if (onCall) {
      score += ROUTING_WEIGHTS.ON_CALL;
    }
    if (weeklyAvailable) {
      score += ROUTING_WEIGHTS.WEEKLY_AVAILABLE;
    }

    // Soft preferences.
    if (
      supportCase.preferredSpecialistId &&
      supportCase.preferredSpecialistId === specialistId
    ) {
      factors.preferred = true;
      score += ROUTING_WEIGHTS.PREFERRED_SPECIALIST;
    }

    const language = supportCase.getMetadata().language;
    if (
      typeof language === 'string' &&
      language.length > 0 &&
      specialist.getLanguages().includes(language)
    ) {
      factors.languageMatch = true;
      score += ROUTING_WEIGHTS.LANGUAGE_MATCH;
    }

    // Final tie-break: on-call priority added directly.
    if (specialist.onCallPriority !== 0) {
      factors.onCallPriority = specialist.onCallPriority;
      score += specialist.onCallPriority;
    }

    return {
      specialistId,
      displayName: specialist.displayName || specialistId,
      score,
      eligible,
      factors,
    };
  }

  /**
   * Assign the top eligible ranked specialist, recording the rationale
   * (winning factors plus the compact top of the ranking) on the assignment
   * event. When no one is eligible, records an unrouted `note` event with
   * the full ranking and returns `assigned: false`.
   */
  async autoAssign(
    caseRef: SupportCase | string,
    opts: {
      at?: Date;
      exclude?: string[];
      actorKind?: SupportActorKind;
    } = {},
  ): Promise<AutoAssignResult> {
    const supportCase = await this.resolveCase(caseRef);
    const ranking = await this.rankSpecialists(supportCase, {
      at: opts.at,
      exclude: opts.exclude,
    });
    const top = ranking.find((entry) => entry.eligible);

    if (!top) {
      await this.caseService.recordEvent(supportCase, 'note', {
        actorKind: opts.actorKind ?? 'system',
        occurredAt: opts.at,
        summary: 'Routing found no eligible specialist',
        payload: {
          unrouted: true,
          ranking: compactRanking(ranking, ranking.length),
        },
      });
      return { assigned: false, ranking };
    }

    await this.caseService.assign(supportCase, {
      actorKind: opts.actorKind ?? 'system',
      specialistId: top.specialistId,
      rationale: {
        factors: top.factors,
        ranking: compactRanking(ranking, 3),
      },
    });
    return { assigned: true, specialistId: top.specialistId, ranking };
  }

  /**
   * Manual reassignment override (FR-30). Requires the
   * `support.reassign-case` permission split on the acting principal and
   * refuses cross-tenant acts; the assignment event carries
   * `{ manual: true, note }` as its rationale.
   */
  async reassign(
    caseRef: SupportCase | string,
    input: {
      specialistId: string;
      principal: SupportPrincipal;
      note?: string;
    },
  ): Promise<SupportCase> {
    if (!input.principal.can(REASSIGN_CASE_PERMISSION)) {
      throw new ReassignDeniedError(
        `Reassignment denied: principal lacks '${REASSIGN_CASE_PERMISSION}'.`,
      );
    }
    const supportCase = await this.resolveCase(caseRef);
    if (
      input.principal.tenantId &&
      supportCase.tenantId &&
      input.principal.tenantId !== supportCase.tenantId
    ) {
      throw new ReassignDeniedError(
        'Reassignment denied: principal tenant does not match the case tenant.',
      );
    }
    // The target must be a real specialist in the case's tenant — an
    // authorized caller must not be able to assign (and audit) a foreign
    // tenant's specialist onto this case.
    const specialist = await this.specialists.get({ id: input.specialistId });
    if (!specialist) {
      throw new ReassignDeniedError(
        `Reassignment denied: unknown specialist '${input.specialistId}'.`,
      );
    }
    if (
      specialist.tenantId &&
      supportCase.tenantId &&
      specialist.tenantId !== supportCase.tenantId
    ) {
      throw new ReassignDeniedError(
        'Reassignment denied: specialist tenant does not match the case tenant.',
      );
    }
    return this.caseService.assign(supportCase, {
      actorKind: 'specialist',
      actorProfileId: input.principal.id ?? null,
      specialistId: input.specialistId,
      rationale: { manual: true, note: input.note ?? null },
    });
  }
}

export default SupportRoutingService;
