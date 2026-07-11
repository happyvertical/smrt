/**
 * AttributionService — turns ReferralTouch evidence into attributed
 * Referral rows (or AttributionExceptions when the policy cannot conclude),
 * and owns the audited manual paths: assignments, exception resolution, and
 * re-attribution overrides.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { AttributionExceptionCollection } from '../collections/AttributionExceptionCollection.js';
import { AttributionPolicyCollection } from '../collections/AttributionPolicyCollection.js';
import { ReferralCollection } from '../collections/ReferralCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTouchCollection } from '../collections/ReferralTouchCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import type { AttributionException } from '../models/AttributionException.js';
import type { AttributionPolicy } from '../models/AttributionPolicy.js';
import type { Referral } from '../models/Referral.js';
import type { ReferralProgram } from '../models/ReferralProgram.js';
import type { ReferralTouch } from '../models/ReferralTouch.js';
import type { AttributionExceptionCandidate } from '../types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Thrown by {@link AttributionService.override} when the target already has
 * a QUALIFIED referral: qualified credit is governed by its term snapshot
 * and commission adjustments downstream — re-attribution would silently
 * orphan agreed terms.
 */
export class QualifiedReferralOverrideError extends Error {
  constructor(referralIds: string[]) {
    super(
      `AttributionService.override: target already has qualified referral(s) ` +
        `[${referralIds.join(', ')}] — qualified credit is governed by term ` +
        'snapshots and commission adjustments downstream, not re-attribution.',
    );
    this.name = 'QualifiedReferralOverrideError';
  }
}

/** Collaborators for {@link AttributionService}. */
export interface AttributionServiceDeps {
  touches: ReferralTouchCollection;
  referrals: ReferralCollection;
  exceptions: AttributionExceptionCollection;
  policies: AttributionPolicyCollection;
  programs: ReferralProgramCollection;
  referrers: ReferrerCollection;
}

/** Why {@link AttributionService.resolve} refused to attribute. */
export type AttributionRefusalReason =
  | 'existing_client_ineligible'
  | 'no_active_policy'
  | 'no_eligible_touches';

/** Input for {@link AttributionService.resolve}. */
export interface ResolveAttributionInput {
  /** Generic qualifying target the referrals will point at. */
  targetKind: string;
  /** Identifier within the `targetKind` namespace. */
  targetId: string;
  /** The program to attribute under. */
  programId: string;
  /** Prospect identity to gather touches by (in addition to the target). */
  subjectKind?: string;
  /** Identifier within the `subjectKind` namespace. */
  subjectId?: string;
  /**
   * The prospect's own profile id, when known — enables the self-referral
   * eligibility check against each candidate referrer's `profileId`.
   */
  subjectProfileId?: string;
  /**
   * Caller's statement that the prospect is already a client. Policies with
   * `allowExistingClients: false` refuse the whole resolution.
   */
  isExistingClient?: boolean;
  /** Overrides the program's `defaultAttributionPolicyKey`. */
  policyKey?: string;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/** Result of {@link AttributionService.resolve}. */
export interface AttributionResolution {
  /**
   * The attributed referral(s): one for sole credit, several siblings for
   * `split` mode. Empty when an exception was raised, the resolution was
   * refused, or nothing was eligible.
   */
  referrals: Referral[];
  /** The conflict parked for review, when the policy could not conclude. */
  exception: AttributionException | null;
  /** Why nothing was attributed, when refused outright. */
  refused?: AttributionRefusalReason;
}

/** Input for {@link AttributionService.recordManualAssignment}. */
export interface RecordManualAssignmentInput {
  referrerId: string;
  programId: string;
  targetKind: string;
  targetId: string;
  /** Prospect identity; defaults to the target pair when omitted. */
  subjectKind?: string;
  subjectId?: string;
  /** Who recorded the assignment (audit). Required. */
  actorProfileId: string;
  /** Free-form rationale recorded in the touch evidence. */
  reason?: string;
  /** When the assignment applies from; defaults to now. */
  occurredAt?: Date;
}

/** One credit award inside a resolution/override. */
export interface AttributionAward {
  referrerId: string;
  /** Credit share (0–1]; awards must sum to 1.0 (±0.0001). */
  creditFraction: number;
}

/** Input for {@link AttributionService.resolveException}. */
export interface ResolveExceptionInput {
  exceptionId: string;
  awards: AttributionAward[];
  /** Non-empty rationale. Required — resolutions are audited. */
  resolutionReason: string;
  /** Who resolved the exception (audit). Required. */
  actorProfileId: string;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/** Input for {@link AttributionService.override}. */
export interface OverrideAttributionInput {
  targetKind: string;
  targetId: string;
  programId: string;
  awards: AttributionAward[];
  /** Non-empty rationale. Required — overrides are audited. */
  resolutionReason: string;
  /** Who performed the override (audit). Required. */
  actorProfileId: string;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/** Result of {@link AttributionService.resolveException} / {@link AttributionService.override}. */
export interface AttributionAwardResult {
  /** The attributed referral(s) the awards created. */
  referrals: Referral[];
  /** The resolved exception row auditing the decision. */
  exception: AttributionException;
}

export class AttributionService {
  constructor(private readonly deps: AttributionServiceDeps) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<AttributionService> {
    return new AttributionService({
      touches: await ReferralTouchCollection.create(classOptions),
      referrals: await ReferralCollection.create(classOptions),
      exceptions: await AttributionExceptionCollection.create(classOptions),
      policies: await AttributionPolicyCollection.create(classOptions),
      programs: await ReferralProgramCollection.create(classOptions),
      referrers: await ReferrerCollection.create(classOptions),
    });
  }

  /**
   * Resolve attribution for one target under one program.
   *
   * IDEMPOTENT: existing non-disqualified `attributed`/`qualified`
   * referrals for the target+program are returned as-is (no new rows), and
   * an already-OPEN exception for the target+program is returned instead of
   * a duplicate.
   *
   * Flow:
   * 1. **Policy** — the program's `defaultAttributionPolicyKey` (or the
   *    `policyKey` override) is resolved via `latestActiveByKey`; no active
   *    version → `refused: 'no_active_policy'`.
   * 2. **Existing-client gate** — `isExistingClient` with a policy that
   *    disallows it → `refused: 'existing_client_ineligible'`.
   * 3. **Candidates** — touches gathered by the subject pair (when given)
   *    and by the target pair, deduplicated, restricted to the program and
   *    to `occurredAt` within `[now - windowDays, now]`.
   * 4. **Eligibility** — self-referrals (candidate referrer's `profileId`
   *    equals `subjectProfileId`) are dropped unless the policy allows
   *    them. Nothing left → `refused: 'no_eligible_touches'`.
   * 5. **Conflicts** — `conflictBehavior: 'review'` with more than one
   *    distinct eligible referrer, exact-timestamp ties between distinct
   *    referrers in `first_touch`/`last_touch`, or competing manual
   *    assignments in `assigned` mode → an OPEN AttributionException
   *    carrying the candidates; NO referral rows.
   * 6. **Credit** — otherwise the mode elects the winner(s):
   *    `first_touch`/`last_touch` (earliest/latest), `assigned` (most
   *    recent manual assignment; assignments beat clicks by definition),
   *    or `split` (every distinct eligible referrer, equal fractions
   *    rounded to 4 dp with the remainder on the last, one shared
   *    `splitGroupId`). Referrals are created `pending → attributed` with
   *    the policy pin, winning touch, `attributedAt = now`, and
   *    `expiresAt = now + windowDays`.
   */
  async resolve(
    input: ResolveAttributionInput,
  ): Promise<AttributionResolution> {
    const now = input.now ?? new Date();

    // Idempotency: live credit already exists → return it untouched.
    const existing = (
      await this.deps.referrals.findByTarget(input.targetKind, input.targetId)
    ).filter(
      (referral) =>
        referral.programId === input.programId &&
        (referral.status === 'attributed' || referral.status === 'qualified'),
    );
    if (existing.length > 0) {
      return { referrals: existing, exception: null };
    }

    // Idempotency: a conflict already parked for review → return it.
    const openException = await this.deps.exceptions.findOpenByTarget(
      input.targetKind,
      input.targetId,
      input.programId,
    );
    if (openException) {
      return { referrals: [], exception: openException };
    }

    const program = await this.requireProgram(input.programId);
    const policy = await this.resolvePolicy(program, input.policyKey, now);
    if (!policy) {
      return { referrals: [], exception: null, refused: 'no_active_policy' };
    }

    // Existing clients are refused outright unless the policy allows them.
    if (input.isExistingClient && !policy.allowExistingClients) {
      return {
        referrals: [],
        exception: null,
        refused: 'existing_client_ineligible',
      };
    }

    const eligible = await this.gatherEligibleTouches(input, policy, now);
    if (eligible.length === 0) {
      return { referrals: [], exception: null, refused: 'no_eligible_touches' };
    }

    const distinctReferrerIds = [
      ...new Set(eligible.map((touch) => touch.referrerId)),
    ];

    // Review-first policies park any multi-referrer contention for humans.
    if (
      policy.conflictBehavior === 'review' &&
      distinctReferrerIds.length > 1
    ) {
      const exception = await this.createOpenException({
        input,
        program,
        policy,
        conflictReason: 'policy_review',
        candidates: eligible,
      });
      return { referrals: [], exception };
    }

    switch (policy.creditMode) {
      case 'first_touch':
      case 'last_touch': {
        const winnerTime =
          policy.creditMode === 'first_touch'
            ? eligible[0].occurredAt.getTime()
            : eligible[eligible.length - 1].occurredAt.getTime();
        const atWinnerTime = eligible.filter(
          (touch) => touch.occurredAt.getTime() === winnerTime,
        );
        const tiedReferrers = new Set(
          atWinnerTime.map((touch) => touch.referrerId),
        );
        if (tiedReferrers.size > 1) {
          const exception = await this.createOpenException({
            input,
            program,
            policy,
            conflictReason: 'tie',
            candidates: eligible,
          });
          return { referrals: [], exception };
        }
        const winner =
          policy.creditMode === 'first_touch'
            ? atWinnerTime[0]
            : atWinnerTime[atWinnerTime.length - 1];
        const referral = await this.createAttributedReferral({
          tenantId: program.tenantId,
          referrerId: winner.referrerId,
          programId: input.programId,
          targetKind: input.targetKind,
          targetId: input.targetId,
          policy,
          creditFraction: 1.0,
          splitGroupId: '',
          primaryTouchId: winner.id ?? '',
          now,
        });
        return { referrals: [referral], exception: null };
      }

      case 'assigned': {
        // Only explicit manual assignments carry credit in assigned mode —
        // clicks and code entries are context, never winners.
        const assignments = eligible.filter(
          (touch) => touch.kind === 'manual_assignment',
        );
        if (assignments.length === 0) {
          return {
            referrals: [],
            exception: null,
            refused: 'no_eligible_touches',
          };
        }
        const assignedReferrers = new Set(
          assignments.map((touch) => touch.referrerId),
        );
        if (assignedReferrers.size > 1) {
          const exception = await this.createOpenException({
            input,
            program,
            policy,
            conflictReason: 'competing_touches',
            candidates: assignments,
          });
          return { referrals: [], exception };
        }
        const winner = assignments[assignments.length - 1]; // most recent
        const referral = await this.createAttributedReferral({
          tenantId: program.tenantId,
          referrerId: winner.referrerId,
          programId: input.programId,
          targetKind: input.targetKind,
          targetId: input.targetId,
          policy,
          creditFraction: 1.0,
          splitGroupId: '',
          primaryTouchId: winner.id ?? '',
          now,
        });
        return { referrals: [referral], exception: null };
      }

      case 'split': {
        const fractions = AttributionService.equalFractions(
          distinctReferrerIds.length,
        );
        const splitGroupId = distinctReferrerIds.length > 1 ? randomUUID() : '';
        const referrals: Referral[] = [];
        for (let i = 0; i < distinctReferrerIds.length; i++) {
          const referrerId = distinctReferrerIds[i];
          // The referrer's earliest eligible touch anchors their credit.
          const primaryTouch = eligible.find(
            (touch) => touch.referrerId === referrerId,
          );
          referrals.push(
            await this.createAttributedReferral({
              tenantId: program.tenantId,
              referrerId,
              programId: input.programId,
              targetKind: input.targetKind,
              targetId: input.targetId,
              policy,
              creditFraction: fractions[i],
              splitGroupId,
              primaryTouchId: primaryTouch?.id ?? '',
              now,
            }),
          );
        }
        return { referrals, exception: null };
      }
    }
  }

  /**
   * Record an operator's manual assignment as an immutable
   * `manual_assignment` ReferralTouch (evidence carries the actor, reason,
   * and target) and return it. The caller then runs {@link resolve} — under
   * an `assigned`-mode policy the assignment wins over click evidence.
   */
  async recordManualAssignment(
    input: RecordManualAssignmentInput,
  ): Promise<ReferralTouch> {
    if (!input.actorProfileId) {
      throw new Error(
        'AttributionService.recordManualAssignment requires an actorProfileId',
      );
    }
    const program = await this.requireProgram(input.programId);
    const occurredAt = input.occurredAt ?? new Date();
    const useSubject = Boolean(input.subjectKind && input.subjectId);
    return await this.deps.touches.create({
      tenantId: program.tenantId,
      referrerId: input.referrerId,
      programId: input.programId,
      kind: 'manual_assignment',
      subjectKind: useSubject
        ? (input.subjectKind as string)
        : input.targetKind,
      subjectId: useSubject ? (input.subjectId as string) : input.targetId,
      occurredAt,
      evidence: JSON.stringify({
        actorProfileId: input.actorProfileId,
        reason: input.reason ?? '',
        targetKind: input.targetKind,
        targetId: input.targetId,
      }),
    });
  }

  /**
   * Resolve an OPEN exception by awarding credit explicitly.
   *
   * Requires a non-empty `resolutionReason` (throws otherwise) and awards
   * whose `creditFraction`s sum to 1.0 (±0.0001) across distinct referrers.
   * Creates the attributed referral(s) from the exception's target/program
   * (split semantics — shared `splitGroupId` — when several awards), then
   * marks the exception resolved (`resolutionMode: 'override'`, the award
   * audit fields, `resolvedReferralIds`).
   */
  async resolveException(
    input: ResolveExceptionInput,
  ): Promise<AttributionAwardResult> {
    AttributionService.assertResolutionReason(
      input.resolutionReason,
      'resolveException',
    );
    AttributionService.assertAwards(input.awards);
    const now = input.now ?? new Date();

    const exception = await this.deps.exceptions.get({ id: input.exceptionId });
    if (!exception) {
      throw new Error(
        `AttributionService.resolveException: exception '${input.exceptionId}' not found`,
      );
    }
    if (!exception.isOpen()) {
      throw new Error(
        `AttributionService.resolveException: exception '${input.exceptionId}' is already resolved`,
      );
    }

    const policyPin = await this.resolvePolicyPin(exception);
    const candidates = exception.getCandidates();
    const splitGroupId = input.awards.length > 1 ? randomUUID() : '';
    const referrals: Referral[] = [];
    for (const award of input.awards) {
      const candidate = candidates.find(
        (entry) => entry.referrerId === award.referrerId,
      );
      referrals.push(
        await this.createAttributedReferral({
          tenantId: exception.tenantId,
          referrerId: award.referrerId,
          programId: exception.programId,
          targetKind: exception.targetKind,
          targetId: exception.targetId,
          policy: null,
          policyPin,
          creditFraction: award.creditFraction,
          splitGroupId,
          primaryTouchId: candidate?.touchId ?? '',
          now,
        }),
      );
    }

    exception.markResolved({
      mode: 'override',
      reason: input.resolutionReason,
      resolvedByProfileId: input.actorProfileId,
      referralIds: referrals.map((referral) => referral.id ?? ''),
      at: now,
    });
    await exception.save();

    return { referrals, exception };
  }

  /**
   * Re-attribute an already-attributed target.
   *
   * Requires a non-empty `resolutionReason` and awards summing to 1.0.
   * REFUSES (throws {@link QualifiedReferralOverrideError}) when the target
   * has a QUALIFIED referral — those are governed by term snapshots and
   * commission adjustments downstream. Otherwise: disqualifies the existing
   * `attributed` referrals for the target+program (stamping the audit
   * exception's id into their metadata), creates the newly awarded
   * attributed referral(s), and writes a RESOLVED AttributionException as
   * the audit record (candidates = the displaced + awarded referrers).
   *
   * The new referrals inherit the POLICY PIN the displaced credit carried
   * (an override re-decides WHO earned the introduction, not which policy
   * version governed it); the program's current default active policy is
   * the fallback when nothing was displaced.
   */
  async override(
    input: OverrideAttributionInput,
  ): Promise<AttributionAwardResult> {
    AttributionService.assertResolutionReason(
      input.resolutionReason,
      'override',
    );
    AttributionService.assertAwards(input.awards);
    const now = input.now ?? new Date();

    const forTarget = (
      await this.deps.referrals.findByTarget(input.targetKind, input.targetId)
    ).filter((referral) => referral.programId === input.programId);

    const qualified = forTarget.filter(
      (referral) => referral.status === 'qualified',
    );
    if (qualified.length > 0) {
      throw new QualifiedReferralOverrideError(
        qualified.map((referral) => referral.id ?? ''),
      );
    }
    const displaced = forTarget.filter(
      (referral) => referral.status === 'attributed',
    );

    const program = await this.requireProgram(input.programId);
    const policyPin = await this.resolveOverridePolicyPin(program, displaced);

    // Audit exception: candidates are the displaced referrers (through
    // their winning touches where known) plus the awarded referrers.
    const candidates: AttributionExceptionCandidate[] = [];
    for (const referral of displaced) {
      const touch = referral.primaryTouchId
        ? await this.deps.touches.get({ id: referral.primaryTouchId })
        : null;
      candidates.push({
        touchId: referral.primaryTouchId,
        referrerId: referral.referrerId,
        kind: touch?.kind ?? 'manual_assignment',
        occurredAt: (
          touch?.occurredAt ??
          referral.attributedAt ??
          now
        ).toISOString(),
      });
    }
    for (const award of input.awards) {
      candidates.push({
        touchId: '',
        referrerId: award.referrerId,
        kind: 'manual_assignment',
        occurredAt: now.toISOString(),
      });
    }

    const exception = await this.deps.exceptions.create({
      tenantId: program.tenantId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      programId: input.programId,
      status: 'open',
      conflictReason: 'override',
      candidates: JSON.stringify(candidates),
      metadata: JSON.stringify(policyPin),
    });

    // Displace the previous credit, pointing each row at its audit record.
    for (const referral of displaced) {
      referral.setMetadata({
        ...referral.getMetadata(),
        overriddenByExceptionId: exception.id ?? '',
        overriddenAt: now.toISOString(),
      });
      referral.disqualify();
      await referral.save();
    }

    const splitGroupId = input.awards.length > 1 ? randomUUID() : '';
    const referrals: Referral[] = [];
    for (const award of input.awards) {
      referrals.push(
        await this.createAttributedReferral({
          tenantId: program.tenantId,
          referrerId: award.referrerId,
          programId: input.programId,
          targetKind: input.targetKind,
          targetId: input.targetId,
          policy: null,
          policyPin,
          creditFraction: award.creditFraction,
          splitGroupId,
          primaryTouchId: '',
          now,
        }),
      );
    }

    exception.markResolved({
      mode: 'override',
      reason: input.resolutionReason,
      resolvedByProfileId: input.actorProfileId,
      referralIds: referrals.map((referral) => referral.id ?? ''),
      at: now,
    });
    await exception.save();

    return { referrals, exception };
  }

  // -------- Internals --------

  private async requireProgram(programId: string): Promise<ReferralProgram> {
    const program = await this.deps.programs.get({ id: programId });
    if (!program) {
      throw new Error(`AttributionService: program '${programId}' not found`);
    }
    return program;
  }

  /**
   * The active policy governing a resolution: the explicit `policyKey`
   * override when given, else the program's default key; resolved to its
   * latest ACTIVE version. `null` when no key or no active version.
   */
  private async resolvePolicy(
    program: ReferralProgram,
    policyKeyOverride: string | undefined,
    at: Date = new Date(),
  ): Promise<AttributionPolicy | null> {
    const policyKey = policyKeyOverride ?? program.defaultAttributionPolicyKey;
    if (!policyKey) return null;
    // Resolve the version in effect at the resolution clock, scoped to the
    // PROGRAM's tenant (with global fallback) — system/background paths run
    // without ambient tenant context, and another tenant's same-named
    // policy must never govern this program's attributions.
    return await this.deps.policies.latestActiveByKey(
      policyKey,
      at,
      program.tenantId,
    );
  }

  /**
   * Candidate touches for a resolution: gathered by the subject pair (when
   * given) and by the target pair, deduplicated, restricted to the program,
   * to `occurredAt` within `[now - windowDays, now]`, and to referrers that
   * pass the self-referral gate. Sorted by `occurredAt` ascending.
   */
  private async gatherEligibleTouches(
    input: ResolveAttributionInput,
    policy: AttributionPolicy,
    now: Date,
  ): Promise<ReferralTouch[]> {
    const byId = new Map<string, ReferralTouch>();
    if (input.subjectKind && input.subjectId) {
      for (const touch of await this.deps.touches.findBySubject(
        input.subjectKind,
        input.subjectId,
      )) {
        byId.set(touch.id ?? '', touch);
      }
    }
    for (const touch of await this.deps.touches.findBySubject(
      input.targetKind,
      input.targetId,
    )) {
      byId.set(touch.id ?? '', touch);
    }

    const windowStart = now.getTime() - policy.windowDays * MS_PER_DAY;
    const inWindow = [...byId.values()].filter((touch) => {
      if (touch.programId !== input.programId) return false;
      const at = touch.occurredAt.getTime();
      return at >= windowStart && at <= now.getTime();
    });

    // Self-referral gate: drop touches whose referrer IS the prospect,
    // unless the policy explicitly allows self-referrals.
    let eligible = inWindow;
    if (!policy.allowSelfReferral && input.subjectProfileId) {
      const referrerProfiles = new Map<string, string>();
      for (const touch of inWindow) {
        if (referrerProfiles.has(touch.referrerId)) continue;
        const referrer = await this.deps.referrers.get({
          id: touch.referrerId,
        });
        referrerProfiles.set(touch.referrerId, referrer?.profileId ?? '');
      }
      eligible = inWindow.filter(
        (touch) =>
          referrerProfiles.get(touch.referrerId) !== input.subjectProfileId,
      );
    }

    return eligible.sort(
      (a, b) => a.occurredAt.getTime() - b.occurredAt.getTime(),
    );
  }

  /** Create an OPEN exception carrying the competing candidates. */
  private async createOpenException(params: {
    input: ResolveAttributionInput;
    program: ReferralProgram;
    policy: AttributionPolicy;
    conflictReason: string;
    candidates: ReferralTouch[];
  }): Promise<AttributionException> {
    const { input, program, policy } = params;
    return await this.deps.exceptions.create({
      tenantId: program.tenantId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      programId: input.programId,
      status: 'open',
      conflictReason: params.conflictReason,
      candidates: JSON.stringify(
        params.candidates.map(
          (touch): AttributionExceptionCandidate => ({
            touchId: touch.id ?? '',
            referrerId: touch.referrerId,
            kind: touch.kind,
            occurredAt: touch.occurredAt.toISOString(),
          }),
        ),
      ),
      // Pin the governing policy so a later resolveException() stamps the
      // SAME policy version the conflict arose under.
      metadata: JSON.stringify({
        policyKey: policy.policyKey,
        policyVersion: policy.version,
        windowDays: policy.windowDays,
      }),
    });
  }

  /**
   * The policy pin an exception was raised under (stamped into its
   * metadata at creation); falls back to the program's current default
   * active policy for exceptions created without one.
   */
  private async resolvePolicyPin(exception: AttributionException): Promise<{
    policyKey: string;
    policyVersion: number;
    windowDays: number | null;
  }> {
    const meta = exception.getMetadata();
    if (typeof meta.policyKey === 'string' && meta.policyKey) {
      return {
        policyKey: meta.policyKey,
        policyVersion:
          typeof meta.policyVersion === 'number' ? meta.policyVersion : 0,
        windowDays:
          typeof meta.windowDays === 'number' ? meta.windowDays : null,
      };
    }
    if (exception.programId) {
      const program = await this.deps.programs.get({
        id: exception.programId,
      });
      if (program) {
        const policy = await this.resolvePolicy(program, undefined);
        if (policy) {
          return {
            policyKey: policy.policyKey,
            policyVersion: policy.version,
            windowDays: policy.windowDays,
          };
        }
      }
    }
    return { policyKey: '', policyVersion: 0, windowDays: null };
  }

  /**
   * The policy pin an override re-attributes under: the pin the displaced
   * credit carried (looking the exact version's `windowDays` back up for
   * the new expiry), falling back to the program's current default active
   * policy when nothing pinned was displaced.
   */
  private async resolveOverridePolicyPin(
    program: ReferralProgram,
    displaced: Referral[],
  ): Promise<{
    policyKey: string;
    policyVersion: number;
    windowDays: number | null;
  }> {
    const pinned = displaced.find((referral) => referral.policyKey);
    if (pinned) {
      const versions = await this.deps.policies.list({
        where: { policyKey: pinned.policyKey, version: pinned.policyVersion },
        limit: 1,
      });
      return {
        policyKey: pinned.policyKey,
        policyVersion: pinned.policyVersion,
        windowDays: versions[0]?.windowDays ?? null,
      };
    }
    const policy = await this.resolvePolicy(program, undefined);
    return policy
      ? {
          policyKey: policy.policyKey,
          policyVersion: policy.version,
          windowDays: policy.windowDays,
        }
      : { policyKey: '', policyVersion: 0, windowDays: null };
  }

  /**
   * Create one referral as `pending`, transition it `pending → attributed`
   * (stamping `attributedAt`), set the policy pin and expiry, and save.
   */
  private async createAttributedReferral(params: {
    tenantId: string | null;
    referrerId: string;
    programId: string;
    targetKind: string;
    targetId: string;
    /** The live policy (resolve path) … */
    policy: AttributionPolicy | null;
    /** … or an explicit pin (exception/override paths). */
    policyPin?: {
      policyKey: string;
      policyVersion: number;
      windowDays: number | null;
    };
    creditFraction: number;
    splitGroupId: string;
    primaryTouchId: string;
    now: Date;
  }): Promise<Referral> {
    const pin = params.policy
      ? {
          policyKey: params.policy.policyKey,
          policyVersion: params.policy.version,
          windowDays: params.policy.windowDays as number | null,
        }
      : (params.policyPin ?? {
          policyKey: '',
          policyVersion: 0,
          windowDays: null,
        });

    const referral = await this.deps.referrals.create({
      tenantId: params.tenantId,
      referrerId: params.referrerId,
      programId: params.programId,
      targetKind: params.targetKind,
      targetId: params.targetId,
      policyKey: pin.policyKey,
      policyVersion: pin.policyVersion,
      creditFraction: params.creditFraction,
      splitGroupId: params.splitGroupId,
      primaryTouchId: params.primaryTouchId,
      status: 'pending',
    });
    referral.markAttributed(params.now);
    referral.expiresAt =
      pin.windowDays !== null
        ? new Date(params.now.getTime() + pin.windowDays * MS_PER_DAY)
        : null;
    await referral.save();
    return referral;
  }

  /**
   * Equal split fractions for `n` referrers, each rounded to 4 decimal
   * places, with the LAST adjusted so the set sums to exactly 1.0.
   */
  private static equalFractions(n: number): number[] {
    if (n <= 1) return [1.0];
    const base = Math.floor(10000 / n) / 10000;
    const fractions = new Array<number>(n).fill(base);
    fractions[n - 1] = Math.round((1 - base * (n - 1)) * 10000) / 10000;
    return fractions;
  }

  private static assertResolutionReason(reason: string, method: string): void {
    if (!reason?.trim()) {
      throw new Error(
        `AttributionService.${method} requires a non-empty resolutionReason`,
      );
    }
  }

  private static assertAwards(awards: AttributionAward[]): void {
    if (!awards || awards.length === 0) {
      throw new Error('AttributionService: at least one award is required');
    }
    const seen = new Set<string>();
    let sum = 0;
    for (const award of awards) {
      if (!award.referrerId) {
        throw new Error('AttributionService: award.referrerId is required');
      }
      if (seen.has(award.referrerId)) {
        throw new Error(
          `AttributionService: duplicate award for referrer '${award.referrerId}'`,
        );
      }
      seen.add(award.referrerId);
      if (
        !Number.isFinite(award.creditFraction) ||
        award.creditFraction <= 0 ||
        award.creditFraction > 1
      ) {
        throw new Error(
          `AttributionService: award.creditFraction must be in (0, 1] — got ${award.creditFraction}`,
        );
      }
      sum += award.creditFraction;
    }
    if (Math.abs(sum - 1) > 0.0001) {
      throw new Error(
        `AttributionService: award creditFractions must sum to 1.0 (±0.0001) — got ${sum}`,
      );
    }
  }
}

export default AttributionService;
