/**
 * CommissionCalculationService — turns one {@link EarningEvent} into
 * Commission rows for one earner, driven by a set of plan components.
 *
 * The service deliberately takes COMPONENTS (plus `planKey`/`planVersion`
 * snapshot refs), not a live plan: callers that calculate from frozen terms
 * — e.g. the referrals module's term snapshots — pass the components they
 * froze, so a later plan amendment can never leak into an already-agreed
 * calculation.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import type { Commission } from '../models/Commission.js';
import { validateCommissionPlanComponents } from '../models/CommissionPlan.js';
import type { EarningEvent } from '../models/EarningEvent.js';
import { calculateCommissionAmountCents, roundCents } from '../money.js';
import type {
  CommissionCalculationTrace,
  CommissionPlanComponent,
} from '../types.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Input for {@link CommissionCalculationService.calculateForEvent}. */
export interface CommissionCalculationInput {
  /** The (persisted) earning event to calculate from. */
  event: EarningEvent;
  /** Snapshot reference recorded on every created Commission. */
  planKey: string;
  /** Snapshot reference recorded on every created Commission. */
  planVersion: number;
  /** The calculation terms to apply (typically from a frozen snapshot). */
  components: CommissionPlanComponent[];
  /** The earner the commissions belong to. */
  earnerId: string;
  /**
   * Split share (0–1) this earner receives; defaults to 1. Callers running
   * a split invoke the service once per earner with the shares and a shared
   * `splitGroupId`.
   */
  shareFraction?: number;
  /** Groups the sibling commissions of one split. */
  splitGroupId?: string;
  /** Generic polymorphic terms-snapshot reference (kind). */
  termsSnapshotKind?: string;
  /** Generic polymorphic terms-snapshot reference (id). */
  termsSnapshotId?: string;
  /**
   * Clearing window in days: created commissions get
   * `clearingEndsAt = event.occurredAt + clearingDays`. Omitted → no
   * clearing (`clearingEndsAt: null`, immediately sweepable).
   */
  clearingDays?: number;
  /**
   * Currency the plan/terms are denominated in. When provided and different
   * from `event.currency`, every matching component skips with reason
   * `'currency_mismatch'` (this module performs no FX). Omitted → the event
   * currency is taken as authoritative and no mismatch is possible.
   */
  currency?: string;
  /**
   * Resolves how many occurrences of a component this earner has already
   * consumed under these terms (commissions from PRIOR events — the current
   * event must not be counted). Drives `one_time` / `maxOccurrences` limits
   * and the `occurrenceIndex` in the dedupe key and trace. Omitted →
   * occurrence count `0`, i.e. recurrence limits are NOT enforced.
   */
  occurrenceCountResolver?: (componentKey: string) => Promise<number>;
  /**
   * Anchor for `windowMonths` recurrence checks (e.g. an agreement's
   * effective date). Omitted → window checks are skipped.
   */
  anchorAt?: Date;
}

/** One component the calculation declined, and why. */
export interface CommissionComponentSkip {
  componentKey: string;
  /**
   * `'net_basis_undefined'` | `'margin_basis_undefined'` |
   * `'fixed_amount_missing'` | `'rate_missing'` | `'custom_basis_missing'`
   * | `'currency_mismatch'` | `'occurrence_limit_reached'` |
   * `'outside_recurrence_window'`
   */
  reason: string;
}

/** Result of {@link CommissionCalculationService.calculateForEvent}. */
export interface CommissionCalculationResult {
  /** Commissions newly created by THIS call. */
  created: Commission[];
  /** Components that produced nothing, with reasons. */
  skipped: CommissionComponentSkip[];
  /**
   * Idempotent replays: commissions that already existed for this
   * (event, terms, component, earner) tuple. Never re-created, never
   * mutated, and never in `created`.
   */
  existing: Commission[];
}

export class CommissionCalculationService {
  constructor(private readonly commissions: CommissionCollection) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<CommissionCalculationService> {
    return new CommissionCalculationService(
      await CommissionCollection.create(classOptions),
    );
  }

  /**
   * Calculate commissions for one event × one earner × a component set.
   *
   * For each component whose `trigger` matches `event.eventKind` (or `'*'`
   * — non-matching components are silently filtered, not "skipped"):
   *
   * 1. **Idempotency** — if a Commission already exists for this
   *    (event, terms, component, earner) tuple, it is returned in
   *    `existing` and nothing else runs for the component.
   * 2. **Currency** — `input.currency` (when given) must equal the event's;
   *    otherwise skip `'currency_mismatch'`.
   * 3. **Recurrence** — `one_time` components skip
   *    `'occurrence_limit_reached'` once the resolver reports ≥ 1 prior
   *    occurrence; `recurring` components honor `maxOccurrences` and
   *    `windowMonths` (events after `anchorAt + windowMonths` skip
   *    `'outside_recurrence_window'`).
   * 4. **Basis** — gross → `grossAmountCents`; net → `netAmountCents`
   *    (skip `'net_basis_undefined'` when null — net is explicit, NEVER
   *    derived from gross); margin → `marginCents` (skip
   *    `'margin_basis_undefined'` when null); fixed → `fixedAmountCents`;
   *    custom → `getCustomBases()[customBasisKey]` (skip
   *    `'custom_basis_missing'`).
   * 5. **Amount** — `roundCents(base * rate * shareFraction)`; for `fixed`,
   *    `roundCents(fixedAmountCents * shareFraction)` with `rate` recorded
   *    as `0`. Rounding happens exactly once, on the final product.
   *
   * Every created Commission is persisted `pending`, carries the event's
   * tenant/currency/source, a complete {@link CommissionCalculationTrace},
   * `clearingEndsAt` when `clearingDays` was given, and the dedupe key
   * `` `${event.dedupeKey}:${termsSnapshotId || planKey + '@' + planVersion}:${componentKey}:${earnerId}:${occurrenceIndex}` ``.
   */
  async calculateForEvent(
    input: CommissionCalculationInput,
  ): Promise<CommissionCalculationResult> {
    const { event } = input;
    if (!event.id) {
      throw new Error(
        'CommissionCalculationService.calculateForEvent requires a persisted event (missing id)',
      );
    }
    if (!input.earnerId) {
      throw new Error(
        'CommissionCalculationService.calculateForEvent requires an earnerId',
      );
    }

    const shareFraction = input.shareFraction ?? 1;
    // Money guard: an out-of-range or non-finite fraction would persist
    // overpayment, negative, or NaN commissions — reject before any
    // component calculates.
    if (
      !Number.isFinite(shareFraction) ||
      shareFraction < 0 ||
      shareFraction > 1
    ) {
      throw new Error(
        `CommissionCalculationService.calculateForEvent: shareFraction must be a finite number in [0, 1], got ${String(shareFraction)}`,
      );
    }
    // Money guard: direct callers can hand in arbitrary component arrays
    // (snapshots and plans validate on write, but nothing forces callers
    // through them) — malformed rates/amounts must never reach the math.
    validateCommissionPlanComponents(input.components);
    const termsRef =
      input.termsSnapshotId || `${input.planKey}@${input.planVersion}`;

    const created: Commission[] = [];
    const skipped: CommissionComponentSkip[] = [];
    const existing: Commission[] = [];

    for (const component of input.components) {
      // Trigger filter: only components listening for this event kind (or
      // everything via '*') participate at all.
      if (component.trigger !== '*' && component.trigger !== event.eventKind) {
        continue;
      }

      // Idempotent replay: the same event can only ever earn once per
      // component per earner under the same terms, regardless of what the
      // occurrence resolver would report on a re-run.
      const priorForEvent = await this.commissions.list({
        where: {
          earningEventId: event.id,
          earnerId: input.earnerId,
          componentKey: component.key,
          planKey: input.planKey,
          planVersion: input.planVersion,
          termsSnapshotId: input.termsSnapshotId ?? '',
        },
        limit: 1,
      });
      if (priorForEvent[0]) {
        existing.push(priorForEvent[0]);
        continue;
      }

      // Currency: terms and event must agree — this module performs no FX.
      if (input.currency !== undefined && input.currency !== event.currency) {
        skipped.push({
          componentKey: component.key,
          reason: 'currency_mismatch',
        });
        continue;
      }

      // Recurrence limits.
      const occurrenceCount = input.occurrenceCountResolver
        ? await input.occurrenceCountResolver(component.key)
        : 0;
      const recurrence = component.recurrence;
      if (recurrence) {
        if (recurrence.kind === 'one_time' && occurrenceCount >= 1) {
          skipped.push({
            componentKey: component.key,
            reason: 'occurrence_limit_reached',
          });
          continue;
        }
        if (
          recurrence.kind === 'recurring' &&
          recurrence.maxOccurrences !== undefined &&
          occurrenceCount >= recurrence.maxOccurrences
        ) {
          skipped.push({
            componentKey: component.key,
            reason: 'occurrence_limit_reached',
          });
          continue;
        }
        if (
          recurrence.windowMonths !== undefined &&
          input.anchorAt !== undefined &&
          event.occurredAt.getTime() >
            CommissionCalculationService.addMonths(
              input.anchorAt,
              recurrence.windowMonths,
            ).getTime()
        ) {
          skipped.push({
            componentKey: component.key,
            reason: 'outside_recurrence_window',
          });
          continue;
        }
      }

      // Resolve the base amount for the component's basis.
      let baseAmountCents: number;
      switch (component.basis) {
        case 'gross':
          baseAmountCents = event.grossAmountCents;
          break;
        case 'net':
          if (event.netAmountCents === null) {
            // Net must be explicitly defined by the ingesting system —
            // it is NEVER derived from gross.
            skipped.push({
              componentKey: component.key,
              reason: 'net_basis_undefined',
            });
            continue;
          }
          baseAmountCents = event.netAmountCents;
          break;
        case 'margin':
          if (event.marginCents === null) {
            skipped.push({
              componentKey: component.key,
              reason: 'margin_basis_undefined',
            });
            continue;
          }
          baseAmountCents = event.marginCents;
          break;
        case 'fixed':
          if (typeof component.fixedAmountCents !== 'number') {
            skipped.push({
              componentKey: component.key,
              reason: 'fixed_amount_missing',
            });
            continue;
          }
          baseAmountCents = component.fixedAmountCents;
          break;
        case 'custom': {
          const bases = event.getCustomBases();
          const key = component.customBasisKey ?? '';
          const value = key ? bases[key] : undefined;
          if (typeof value !== 'number') {
            skipped.push({
              componentKey: component.key,
              reason: 'custom_basis_missing',
            });
            continue;
          }
          baseAmountCents = value;
          break;
        }
      }

      // Resolve rate + amount. Fixed components record rate 0 and apply
      // only the share fraction; everything else applies rate × share.
      let rate: number;
      let amountCents: number;
      if (component.basis === 'fixed') {
        rate = 0;
        amountCents = roundCents(baseAmountCents * shareFraction);
      } else {
        if (typeof component.rate !== 'number') {
          skipped.push({
            componentKey: component.key,
            reason: 'rate_missing',
          });
          continue;
        }
        rate = component.rate;
        amountCents = calculateCommissionAmountCents(
          baseAmountCents,
          rate,
          shareFraction,
        );
      }

      const occurrenceIndex = occurrenceCount;
      const dedupeKey = `${event.dedupeKey}:${termsRef}:${component.key}:${input.earnerId}:${occurrenceIndex}`;

      // Second idempotency belt: an exact dedupe-key hit (however it came
      // to exist) is returned rather than re-created — creating through the
      // conflictColumns upsert would otherwise UPDATE the existing row.
      const priorByKey = await this.commissions.findByDedupeKey(dedupeKey);
      if (priorByKey) {
        existing.push(priorByKey);
        continue;
      }

      const trace: CommissionCalculationTrace = {
        planKey: input.planKey,
        planVersion: input.planVersion,
        componentKey: component.key,
        basis: component.basis,
        baseAmountCents,
        rate,
        shareFraction,
        occurrenceIndex,
        earningEventId: event.id,
        roundingMode: 'half_away_from_zero',
      };

      const commission = await this.commissions.create({
        // Commissions inherit the event's tenancy so background calculation
        // (no active tenant context) still lands rows in the right tenant.
        tenantId: event.tenantId,
        earnerId: input.earnerId,
        earningEventId: event.id,
        planKey: input.planKey,
        planVersion: input.planVersion,
        componentKey: component.key,
        termsSnapshotKind: input.termsSnapshotKind ?? '',
        termsSnapshotId: input.termsSnapshotId ?? '',
        basis: component.basis,
        baseAmountCents,
        rate,
        shareFraction,
        splitGroupId: input.splitGroupId ?? '',
        amountCents,
        currency: event.currency,
        status: 'pending',
        clearingEndsAt:
          input.clearingDays !== undefined
            ? new Date(
                event.occurredAt.getTime() + input.clearingDays * MS_PER_DAY,
              )
            : null,
        sourceKind: event.sourceKind,
        sourceId: event.sourceId,
        calculationTrace: JSON.stringify(trace),
        dedupeKey,
      });
      created.push(commission);
    }

    return { created, skipped, existing };
  }

  /**
   * Calendar-month addition (UTC). JS `setUTCMonth` semantics: day-of-month
   * overflow rolls into the next month (Jan 31 + 1 month → Mar 2/3), which
   * is acceptable for coarse recurrence windows.
   */
  private static addMonths(date: Date, months: number): Date {
    const result = new Date(date.getTime());
    result.setUTCMonth(result.getUTCMonth() + months);
    return result;
  }
}

export default CommissionCalculationService;
