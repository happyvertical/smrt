/**
 * TimeEntryApprovalService — the approval gate for Service Time Entries and
 * the ONLY writer of their commercial snapshots (FR-36/FR-32/FR-35, issue
 * #1930).
 *
 * Approval paths come from the governing Managed Support Plan's
 * `timeApprovalPolicy`: `automatic` (no principal needed under the
 * thresholds), `threshold` (an over-threshold automatic entry needs an
 * operator), `operator` (the `support.approve-time-entry` split), and
 * `client` (the case's Client, with the operator split as override).
 *
 * On approval two deliberately separate rows derive per entry:
 *
 * - **SupportCharge** — client side, from the Managed Support Plan only:
 *   included time consumes first (per case; period windows arrive with usage
 *   pricing #1925), the remainder meters at the overage (or on-call) rate.
 *   Rate math uses the CASE's `planSnapshot` when present so later plan edits
 *   never change history.
 * - **SupportCompensation** — provider side, from the effective-dated Support
 *   Compensation Plan only.
 *
 * Margin (charge − compensation) stays computable by readers and is NEVER
 * stored; case-visible audit events carry the charge amount only, never the
 * compensation. Approved entries freeze (model-enforced); disputes flow
 * through {@link TimeEntryApprovalService.correct}, which supersedes the
 * original and re-derives fresh snapshots from the correcting entry.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  type ServiceTimeEntry,
  ServiceTimeEntryCollection,
} from '../models/service-time-entry.js';
import type { SupportCase } from '../models/support-case.js';
import {
  type SupportCompensationPlan,
  SupportCompensationPlanCollection,
} from '../models/support-compensation-plan.js';
import type { SupportPlan } from '../models/support-plan.js';
import {
  type SupportCharge,
  SupportChargeCollection,
  type SupportCompensation,
  SupportCompensationCollection,
} from '../models/support-settlement.js';
import {
  APPROVE_TIME_ENTRY_PERMISSION,
  type SupportPrincipal,
} from '../permissions.js';
import type {
  TimeApprovalPolicy,
  TimeEntryApprovalPath,
  TimeEntryEvidence,
} from '../types.js';
import { KeyedMutex } from './keyed-mutex.js';
import { SupportCaseService } from './support-case-service.js';

/** Thrown when an approval-path or tenant gate refuses the acting principal. */
export class TimeEntryApprovalDeniedError extends Error {
  constructor(reason: string) {
    super(`Time entry approval denied: ${reason}`);
    this.name = 'TimeEntryApprovalDeniedError';
  }
}

/** Options for {@link TimeEntryApprovalService.create}. */
export interface TimeEntryApprovalServiceOptions extends SmrtObjectOptions {
  /** Share an existing case facade (otherwise one is created internally). */
  caseService?: SupportCaseService;
}

/**
 * The plan terms governing one entry's approval and pricing, resolved from
 * the case's frozen `planSnapshot` first, then the live plan row, else
 * zero-rate defaults (operator approval, nothing charged).
 */
export interface ResolvedPlanTerms {
  policy: TimeApprovalPolicy;
  currency: string;
  includedMinutes: number;
  overageHourlyRate: number;
  onCallHourlyRate: number;
  planId: string | null;
  planKey: string;
}

/** Input for {@link TimeEntryApprovalService.approve}. */
export interface ApproveTimeEntryInput {
  /** Acting principal; optional only for the `automatic` path. */
  principal?: SupportPrincipal;
  note?: string;
  /** Approval instant (defaults to now); also the derivation timestamp. */
  at?: Date;
}

/** Result of {@link TimeEntryApprovalService.approve}. */
export interface ApproveTimeEntryResult {
  entry: ServiceTimeEntry;
  charge: SupportCharge;
  compensation: SupportCompensation;
  path: TimeEntryApprovalPath;
}

/** Input for {@link TimeEntryApprovalService.reject}. */
export interface RejectTimeEntryInput {
  principal: SupportPrincipal;
  reason: string;
}

/** Input for {@link TimeEntryApprovalService.correct}. */
export interface CorrectTimeEntryInput {
  principal: SupportPrincipal;
  patch: Partial<{
    durationSeconds: number;
    startedAt: Date;
    endedAt: Date;
    description: string;
    evidence: TimeEntryEvidence[];
  }>;
  note?: string;
}

/** Result of {@link TimeEntryApprovalService.correct}. */
export interface CorrectTimeEntryResult {
  /** The superseded entry, now `corrected` with its snapshot intact. */
  original: ServiceTimeEntry;
  /** The new `draft` entry carrying the patch (flows submit → approve). */
  correction: ServiceTimeEntry;
}

/** Charge math derived from the plan terms before any row is written. */
interface ChargeDerivation {
  billableSeconds: number;
  includedSecondsBefore: number;
  includedSecondsApplied: number;
  /** Minor units per hour — see {@link SupportPlan.overageHourlyRate}. */
  hourlyRate: number;
  rateSource: 'overage' | 'on_call' | 'none';
  /** Integer minor units (#2401). */
  amount: number;
}

/**
 * Round a computed amount to whole minor units.
 *
 * This is the single boundary in the package where a rate meets money: rates
 * are minor units per hour and hours are fractional, so the product is not
 * generally integral. Rounding it here means every stored amount and every
 * threshold comparison downstream is exact integer arithmetic (#2401).
 *
 * Replaces the old two-decimal rounding (`Math.round((v + EPSILON) * 100) /
 * 100`), which existed to keep float drift out of a DECIMAL column that is now
 * integral.
 */
function roundMoney(value: number): number {
  return Math.round(value);
}

/**
 * The approval gate. Construct with {@link TimeEntryApprovalService.create}.
 */
export class TimeEntryApprovalService {
  readonly entries: ServiceTimeEntryCollection;
  readonly charges: SupportChargeCollection;
  readonly compensations: SupportCompensationCollection;
  readonly compensationPlans: SupportCompensationPlanCollection;
  readonly caseService: SupportCaseService;
  private readonly approvalMutex = new KeyedMutex();

  protected constructor(collections: {
    entries: ServiceTimeEntryCollection;
    charges: SupportChargeCollection;
    compensations: SupportCompensationCollection;
    compensationPlans: SupportCompensationPlanCollection;
    caseService: SupportCaseService;
  }) {
    this.entries = collections.entries;
    this.charges = collections.charges;
    this.compensations = collections.compensations;
    this.compensationPlans = collections.compensationPlans;
    this.caseService = collections.caseService;
  }

  static async create(
    options: TimeEntryApprovalServiceOptions,
  ): Promise<TimeEntryApprovalService> {
    const caseService =
      options.caseService ?? (await SupportCaseService.create(options));
    const [entries, charges, compensations, compensationPlans] =
      await Promise.all([
        ServiceTimeEntryCollection.create(options),
        SupportChargeCollection.create(options),
        SupportCompensationCollection.create(options),
        SupportCompensationPlanCollection.create(options),
      ]);
    return new TimeEntryApprovalService({
      entries,
      charges,
      compensations,
      compensationPlans,
      caseService,
    });
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
   * Resolve the plan terms governing an entry: the case's frozen
   * `planSnapshot` wins field-by-field (history never rewritten by plan
   * edits), the live plan row fills gaps, and with no case or plan at all the
   * terms fall back to zero rates under operator approval.
   */
  async resolvePlanTerms(
    entry: ServiceTimeEntry,
    supportCase?: SupportCase | null,
  ): Promise<ResolvedPlanTerms> {
    const zeroRate: ResolvedPlanTerms = {
      policy: { mode: 'operator' },
      currency: 'USD',
      includedMinutes: 0,
      overageHourlyRate: 0,
      onCallHourlyRate: 0,
      planId: null,
      planKey: '',
    };
    if (!entry.caseId) {
      return zeroRate;
    }
    const owningCase =
      supportCase ?? (await this.caseService.getCase(entry.caseId));
    const snapshot = owningCase.getPlanSnapshot();
    const plan: SupportPlan | null = owningCase.planId
      ? await this.caseService.plans.get({ id: owningCase.planId })
      : null;
    if (Object.keys(snapshot).length === 0 && !plan) {
      return zeroRate;
    }

    const num = (snapshotValue: unknown, planValue: number | undefined) =>
      typeof snapshotValue === 'number' ? snapshotValue : (planValue ?? 0);
    const policySource =
      snapshot.timeApprovalPolicy &&
      typeof snapshot.timeApprovalPolicy === 'object'
        ? (snapshot.timeApprovalPolicy as Partial<TimeApprovalPolicy>)
        : plan?.getTimeApprovalPolicy();

    return {
      policy: { mode: 'operator', ...(policySource ?? {}) },
      currency:
        typeof snapshot.currency === 'string' && snapshot.currency
          ? snapshot.currency
          : (plan?.currency ?? 'USD'),
      includedMinutes: num(snapshot.includedMinutes, plan?.includedMinutes),
      overageHourlyRate: num(
        snapshot.overageHourlyRate,
        plan?.overageHourlyRate,
      ),
      onCallHourlyRate: num(snapshot.onCallHourlyRate, plan?.onCallHourlyRate),
      planId:
        typeof snapshot.planId === 'string' && snapshot.planId
          ? snapshot.planId
          : (plan?.id ?? null),
      planKey:
        typeof snapshot.planKey === 'string'
          ? snapshot.planKey
          : (plan?.planKey ?? ''),
    };
  }

  /**
   * Approve a `submitted` entry: gate the acting principal by the plan's
   * approval policy, freeze the entry, and derive its charge and compensation
   * snapshots. Throws {@link TimeEntryApprovalDeniedError} when the gate
   * refuses.
   */
  async approve(
    entryRef: ServiceTimeEntry | string,
    input: ApproveTimeEntryInput = {},
  ): Promise<ApproveTimeEntryResult> {
    const entry = await this.getEntry(entryRef);
    // Serialize per work context: concurrent approvals against the same case
    // must not each read the same remaining included allowance and both
    // consume it (over-granting included time / under-billing overage).
    const lockKey = entry.caseId ?? `entry:${entry.id ?? ''}`;
    return this.approvalMutex.run(lockKey, () =>
      this.approveExclusive(entry, input),
    );
  }

  private async approveExclusive(
    entry: ServiceTimeEntry,
    input: ApproveTimeEntryInput,
  ): Promise<ApproveTimeEntryResult> {
    if (entry.status !== 'submitted') {
      throw new Error(
        `ServiceTimeEntry ${entry.id}: only 'submitted' entries can be approved (status is '${entry.status}').`,
      );
    }
    const at = input.at ?? new Date();
    const principal = input.principal;
    this.assertTenantMatch(entry, principal);

    const supportCase = entry.caseId
      ? await this.caseService.getCase(entry.caseId)
      : null;
    const terms = await this.resolvePlanTerms(entry, supportCase);
    const derivation = await this.deriveCharge(entry, terms);
    const path = this.determinePath(
      entry,
      terms.policy,
      derivation.amount,
      principal,
      supportCase,
    );

    // Settlement rows are written BEFORE the entry flips to 'approved' so a
    // transient failure leaves the entry 'submitted' and the whole approval
    // retryable (codex P1, PR #1943): both writes are upserts keyed on the
    // entry (one charge/compensation per entry), the consumption query above
    // excludes the entry's own row, and the status flip lands last.
    const charge = await this.upsertChargeRow(entry, {
      tenantId: entry.tenantId,
      timeEntryId: entry.id ?? '',
      caseId: entry.caseId,
      planId: terms.planId,
      amount: derivation.amount,
      currency: terms.currency,
      billableSeconds: derivation.billableSeconds,
      includedSecondsApplied: derivation.includedSecondsApplied,
      rateSnapshot: JSON.stringify({
        hourlyRate: derivation.hourlyRate,
        rateSource: derivation.rateSource,
        planId: terms.planId,
        planKey: terms.planKey,
        includedMinutes: terms.includedMinutes,
        includedSecondsBefore: derivation.includedSecondsBefore,
        includedSecondsApplied: derivation.includedSecondsApplied,
        derivedAt: at.toISOString(),
        scope: 'per-case (period accounting arrives with usage pricing #1925)',
      }),
      status: 'final',
      finalizedAt: at,
    });

    const compensation = await this.deriveCompensation(entry, at);

    // Set every approval field BEFORE the save — the model's freeze engages
    // the moment the row persists as 'approved'.
    entry.approvedAt = at;
    entry.approvedByProfileId = principal?.id ?? null;
    entry.approvalPath = path;
    entry.status = 'approved';
    await entry.save();

    if (supportCase) {
      // Case-visible audit carries the client-side amount ONLY — provider
      // compensation never leaks into a case event; it is queryable through
      // its own read model.
      await this.caseService.recordEvent(supportCase, 'time_recorded', {
        actorKind:
          path === 'client' ? 'client' : principal ? 'specialist' : 'system',
        actorProfileId: principal?.id ?? null,
        summary: `Time entry approved (${path})`,
        payload: {
          approved: true,
          path,
          timeEntryId: entry.id ?? '',
          chargeAmount: charge.amount,
        },
        occurredAt: at,
      });
    }

    return { entry, charge, compensation, path };
  }

  /**
   * Reject a `submitted` entry with a reason (requires the
   * `support.approve-time-entry` split).
   */
  async reject(
    entryRef: ServiceTimeEntry | string,
    input: RejectTimeEntryInput,
  ): Promise<ServiceTimeEntry> {
    const entry = await this.getEntry(entryRef);
    if (entry.status !== 'submitted') {
      throw new Error(
        `ServiceTimeEntry ${entry.id}: only 'submitted' entries can be rejected (status is '${entry.status}').`,
      );
    }
    if (!input.reason?.trim()) {
      throw new Error('ServiceTimeEntry: a rejection reason is required.');
    }
    this.assertTenantMatch(entry, input.principal);
    this.assertOperator(input.principal, 'rejecting a time entry');

    entry.rejectedAt = new Date();
    entry.rejectedByProfileId = input.principal.id ?? null;
    entry.rejectionReason = input.reason;
    entry.status = 'rejected';
    await entry.save();
    return entry;
  }

  /**
   * Correct an `approved` entry (requires the `support.approve-time-entry`
   * split): a NEW `draft` entry copies the original's context, participant,
   * and source with the patch applied and links back via `correctionOfId`;
   * the original flips to `corrected` with its frozen fields and snapshots
   * untouched, and its charge/compensation rows are marked `corrected`. The
   * correction then flows submit → approve normally, deriving fresh
   * snapshots.
   */
  async correct(
    entryRef: ServiceTimeEntry | string,
    input: CorrectTimeEntryInput,
  ): Promise<CorrectTimeEntryResult> {
    const original = await this.getEntry(entryRef);
    if (original.status !== 'approved') {
      throw new Error(
        `ServiceTimeEntry ${original.id}: only 'approved' entries can be corrected (status is '${original.status}').`,
      );
    }
    this.assertTenantMatch(original, input.principal);
    this.assertOperator(input.principal, 'correcting an approved time entry');

    const patch = input.patch ?? {};
    const startedAt =
      patch.startedAt !== undefined ? patch.startedAt : original.startedAt;
    const endedAt =
      patch.endedAt !== undefined ? patch.endedAt : original.endedAt;
    const durationSeconds = patch.durationSeconds ?? original.durationSeconds;
    if (!(durationSeconds > 0)) {
      throw new Error(
        `ServiceTimeEntry: correction durationSeconds must be greater than zero (got ${durationSeconds}).`,
      );
    }
    if (startedAt && endedAt && startedAt.getTime() >= endedAt.getTime()) {
      throw new Error(
        'ServiceTimeEntry: correction startedAt must be before endedAt.',
      );
    }

    const correction = await this.entries.create({
      tenantId: original.tenantId,
      caseId: original.caseId,
      workRefType: original.workRefType,
      workRefId: original.workRefId,
      specialistId: original.specialistId,
      participantKind: original.participantKind,
      participantProfileId: original.participantProfileId,
      agentRef: original.agentRef,
      source: original.source,
      description: patch.description ?? original.description,
      startedAt,
      endedAt,
      durationSeconds,
      evidence:
        patch.evidence !== undefined
          ? JSON.stringify(patch.evidence)
          : original.evidence,
      status: 'draft',
      correctionOfId: original.id,
      metadata: JSON.stringify({
        ...original.getMetadata(),
        correctionNote: input.note ?? null,
      }),
    });

    // Only the status flips — the frozen work-defining fields stay intact
    // (the model allows exactly this approved → corrected exit).
    original.status = 'corrected';
    await original.save();

    const originalId = original.id ?? '';
    const [charge, compensation] = await Promise.all([
      this.charges.forTimeEntry(originalId),
      this.compensations.forTimeEntry(originalId),
    ]);
    if (charge) {
      charge.status = 'corrected';
      await charge.save();
    }
    if (compensation) {
      compensation.status = 'corrected';
      await compensation.save();
    }

    return { original, correction };
  }

  /**
   * Determine the approval path for an entry under a policy, or throw
   * {@link TimeEntryApprovalDeniedError} when the acting principal does not
   * satisfy it.
   */
  protected determinePath(
    entry: ServiceTimeEntry,
    policy: TimeApprovalPolicy,
    /** Integer minor units, same unit as `policy.thresholdAmount` (#2401). */
    chargeAmount: number,
    principal: SupportPrincipal | undefined,
    supportCase: SupportCase | null,
  ): TimeEntryApprovalPath {
    const isOperator = principal?.can(APPROVE_TIME_ENTRY_PERMISSION) ?? false;

    if (policy.mode === 'automatic') {
      const minutes = entry.durationSeconds / 60;
      const overMinutes =
        policy.thresholdMinutes !== undefined &&
        minutes > policy.thresholdMinutes;
      const overAmount =
        policy.thresholdAmount !== undefined &&
        chargeAmount > policy.thresholdAmount;
      if (!overMinutes && !overAmount) {
        return 'automatic';
      }
      if (!isOperator) {
        throw new TimeEntryApprovalDeniedError(
          `the entry exceeds the automatic-approval ${overMinutes ? 'duration' : 'amount'} threshold and requires an operator holding '${APPROVE_TIME_ENTRY_PERMISSION}'.`,
        );
      }
      return 'threshold';
    }

    if (policy.mode === 'client') {
      if (!principal) {
        throw new TimeEntryApprovalDeniedError(
          'client approval requires an acting principal.',
        );
      }
      const clientProfileId = supportCase?.clientProfileId ?? null;
      if (clientProfileId && principal.id === clientProfileId) {
        return 'client';
      }
      if (isOperator) {
        return 'client';
      }
      throw new TimeEntryApprovalDeniedError(
        `client approval requires the case's Client${clientProfileId ? ` (${clientProfileId})` : ''} or an operator holding '${APPROVE_TIME_ENTRY_PERMISSION}'.`,
      );
    }

    // 'operator' — the default mode, including zero-rate fallback terms.
    if (!isOperator) {
      throw new TimeEntryApprovalDeniedError(
        `operator approval requires '${APPROVE_TIME_ENTRY_PERMISSION}'.`,
      );
    }
    return 'operator';
  }

  /**
   * Charge math from the Managed Support Plan terms: remaining included time
   * (per case — period windows are #1925's scope) absorbs first, the
   * remainder meters at the overage (or on-call) hourly rate.
   */
  protected async deriveCharge(
    entry: ServiceTimeEntry,
    terms: ResolvedPlanTerms,
  ): Promise<ChargeDerivation> {
    const billableSeconds = entry.durationSeconds;
    let includedSecondsBefore = 0;
    if (entry.caseId && terms.includedMinutes > 0) {
      const existing = await this.charges.forCase(entry.caseId);
      // Only live charges consume included time: `corrected`/`voided` rows
      // release their allowance back to the case (codex P1, PR #1943), and
      // the entry's own row is excluded so an approval retry after a partial
      // failure never double-counts itself.
      const consumed = existing
        .filter(
          (charge) =>
            (charge.status === 'final' || charge.status === 'pending') &&
            charge.timeEntryId !== entry.id,
        )
        .reduce((sum, charge) => sum + (charge.includedSecondsApplied ?? 0), 0);
      includedSecondsBefore = Math.max(
        0,
        terms.includedMinutes * 60 - consumed,
      );
    }
    const includedSecondsApplied = Math.min(
      includedSecondsBefore,
      billableSeconds,
    );
    const onCall = Boolean(entry.getMetadata().onCall);
    const hourlyRate = onCall
      ? terms.onCallHourlyRate || terms.overageHourlyRate
      : terms.overageHourlyRate;
    const amount = roundMoney(
      ((billableSeconds - includedSecondsApplied) / 3600) * hourlyRate,
    );
    return {
      billableSeconds,
      includedSecondsBefore,
      includedSecondsApplied,
      hourlyRate,
      rateSource: onCall ? 'on_call' : hourlyRate > 0 ? 'overage' : 'none',
      amount,
    };
  }

  /**
   * Provider earning from the Support Compensation Plan effective at the work
   * instant (`endedAt`, falling back to the approval instant). No specialist
   * or no plan resolves to a zero-amount row so the entry still settles.
   */
  protected async deriveCompensation(
    entry: ServiceTimeEntry,
    at: Date,
  ): Promise<SupportCompensation> {
    const plan: SupportCompensationPlan | null = entry.specialistId
      ? await this.compensationPlans.resolveForSpecialist(
          entry.specialistId,
          entry.endedAt ?? at,
          // Scope defaults to the entry's tenant — approval may run without
          // an ambient tenant context, and another tenant's default plan
          // must never price this tenant's work.
          { tenantId: entry.tenantId ?? null },
        )
      : null;
    const payableSeconds = entry.durationSeconds;

    if (!plan) {
      return this.upsertCompensationRow(entry, {
        tenantId: entry.tenantId,
        timeEntryId: entry.id ?? '',
        specialistId: entry.specialistId,
        compensationPlanId: null,
        amount: 0,
        currency: 'USD',
        payableSeconds,
        rateSnapshot: JSON.stringify({
          rateSource: 'none',
          derivedAt: at.toISOString(),
        }),
        status: 'final',
        finalizedAt: at,
      });
    }

    const amount = roundMoney((payableSeconds / 3600) * plan.hourlyRate);
    return this.upsertCompensationRow(entry, {
      tenantId: entry.tenantId,
      timeEntryId: entry.id ?? '',
      specialistId: entry.specialistId,
      compensationPlanId: plan.id,
      amount,
      currency: plan.currency,
      payableSeconds,
      rateSnapshot: JSON.stringify({
        hourlyRate: plan.hourlyRate,
        currency: plan.currency,
        planId: plan.id,
        effectiveFrom: plan.effectiveFrom?.toISOString() ?? null,
        effectiveTo: plan.effectiveTo?.toISOString() ?? null,
        derivedAt: at.toISOString(),
      }),
      status: 'final',
      finalizedAt: at,
    });
  }

  /**
   * Idempotent write of the entry's single charge row: an approval retry
   * after a partial failure refreshes the existing row instead of colliding
   * on the `time_entry_id` unique key.
   */
  protected async upsertChargeRow(
    entry: ServiceTimeEntry,
    fields: Record<string, unknown>,
  ): Promise<SupportCharge> {
    const existing = entry.id
      ? await this.charges.forTimeEntry(entry.id)
      : null;
    if (!existing) {
      return this.charges.create(fields);
    }
    Object.assign(existing, fields);
    await existing.save();
    return existing;
  }

  /** Idempotent write of the entry's single compensation row (see above). */
  protected async upsertCompensationRow(
    entry: ServiceTimeEntry,
    fields: Record<string, unknown>,
  ): Promise<SupportCompensation> {
    const existing = entry.id
      ? await this.compensations.forTimeEntry(entry.id)
      : null;
    if (!existing) {
      return this.compensations.create(fields);
    }
    Object.assign(existing, fields);
    await existing.save();
    return existing;
  }

  /** Cross-tenant acts are refused when both sides carry a tenant. */
  protected assertTenantMatch(
    entry: ServiceTimeEntry,
    principal: SupportPrincipal | undefined,
  ): void {
    if (!principal?.tenantId || !entry.tenantId) {
      return;
    }
    if (principal.tenantId !== entry.tenantId) {
      throw new TimeEntryApprovalDeniedError(
        `principal tenant '${principal.tenantId}' does not match the entry's tenant '${entry.tenantId}'.`,
      );
    }
  }

  /** Require the operator permission split for a privileged act. */
  protected assertOperator(
    principal: SupportPrincipal | undefined,
    act: string,
  ): void {
    if (!principal?.can(APPROVE_TIME_ENTRY_PERMISSION)) {
      throw new TimeEntryApprovalDeniedError(
        `${act} requires '${APPROVE_TIME_ENTRY_PERMISSION}'.`,
      );
    }
  }
}

export default TimeEntryApprovalService;
