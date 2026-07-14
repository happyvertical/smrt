/**
 * CommissionPayoutService — mints and drives {@link CommissionPayout}
 * settlement batches.
 *
 * The service is the ONLY sanctioned creation path for payouts (their
 * generated surface is fully read-only): it gathers the exact payable
 * unsettled Commissions and eligible unsettled Adjustments, refuses
 * below-threshold / non-positive batches, stamps `payoutId` on the exact
 * gathered rows, and later flips the batch's commissions to `paid` when the
 * payout completes.
 *
 * Batch creation is deliberately non-transactional (conditional claims +
 * disjoint scopes — see {@link createPayoutBatch}). Two surfaces layered on
 * top serve per-source consumers:
 *
 * - {@link getSourcePayoutHistory} — the source-scoped, paginated,
 *   membership-verified payout history (#1985), indexed by the derived
 *   single-source stamp each batch/repair pass maintains.
 * - {@link transitionPayoutForSource} — atomic source-authorized lifecycle
 *   transitions (#1987): payout row locked, membership re-verified and
 *   totals recomputed under the lock, transition + member writes committed
 *   together on the same transaction database.
 *
 * @packageDocumentation
 */

import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { CommissionAdjustmentCollection } from '../collections/CommissionAdjustmentCollection.js';
import { CommissionCollection } from '../collections/CommissionCollection.js';
import { CommissionPayoutCollection } from '../collections/CommissionPayoutCollection.js';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import type { Commission } from '../models/Commission.js';
import type { CommissionAdjustment } from '../models/CommissionAdjustment.js';
import type { CommissionPayout } from '../models/CommissionPayout.js';
import {
  ADJUSTMENT_SETTLEABLE_COMMISSION_STATUSES,
  type CommissionPayoutStatus,
  type CommissionStatus,
  type PayoutMethod,
} from '../types.js';

/** The subset of adapter capabilities the transactional transition uses. */
type TransactionCapableDatabase = DatabaseInterface & {
  transaction?: <T>(
    callback: (tx: DatabaseInterface) => Promise<T>,
  ) => Promise<T>;
  acquireSession?: unknown;
};

/**
 * Per-database promise chain serializing transactional transitions on
 * engines that multiplex every transaction over ONE shared connection
 * (SQLite, DuckDB, JSON) — concurrent `BEGIN`/`COMMIT` pairs would
 * interleave there. PostgreSQL (pooled per-transaction connections) skips
 * the chain entirely. WeakMap so the tail GCs with the database instance.
 */
const singleConnectionTransitionTails = new WeakMap<object, Promise<unknown>>();

/**
 * What the transactional transition callback reports back across the
 * commit boundary — ids only, so the public result can rehydrate on the
 * service's own connection.
 */
interface TxTransitionOutcome {
  outcome: 'transitioned' | 'already_applied' | 'refused';
  payoutId: string | null;
  refusal?: { reason: PayoutTransitionRefusalReason; detail: string };
  /** Prevent payout rehydration when source ownership was not proven. */
  authorizationFailed?: true;
  releasedCommissionIds?: string[];
  releasedAdjustmentIds?: string[];
}

/** Collaborators for {@link CommissionPayoutService}. */
export interface CommissionPayoutServiceDeps {
  earners: EarnerCollection;
  commissions: CommissionCollection;
  adjustments: CommissionAdjustmentCollection;
  payouts: CommissionPayoutCollection;
}

/** Input for {@link CommissionPayoutService.createPayoutBatch}. */
export interface CreatePayoutBatchInput {
  earnerId: string;
  currency: string;
  /** Informational period bounds recorded on the payout. */
  periodStart?: Date;
  periodEnd?: Date;
  /**
   * Idempotency natural key. Defaults to
   * `` `${earnerId}:${currency}:${periodEnd ISO date}` ``, or
   * `` `${earnerId}:${currency}:${sourceKind}:${sourceId}:${periodEnd ISO date}` ``
   * when scoped by source (so a per-network batch and the earner-wide batch
   * on the same day don't collide). REQUIRED when {@link commissionIds} is
   * given — an explicit set has no natural default key. Callers running more
   * than one batch per key/day must supply their own key.
   */
  idempotencyKey?: string;
  /**
   * Restrict the batch to commissions from ONE earning source (e.g. a
   * single ad network). Both `sourceKind` and `sourceId` must be set
   * together. Only payable, unsettled commissions matching this source are
   * gathered, and eligible adjustments are narrowed to those whose parent
   * commission shares the source. Mutually exclusive with
   * {@link commissionIds}. Omit both to settle the whole earner+currency
   * (the original behavior).
   */
  sourceKind?: string;
  sourceId?: string;
  /**
   * Restrict the batch to EXACTLY these commissions. Each id is included
   * only when it is payable, unsettled, and belongs to this earner+currency
   * — ineligible ids are ignored (inspect `settledCommissionIds` for what
   * was actually claimed). Adjustments whose parent commission is in this
   * set come along. Mutually exclusive with {@link sourceKind}/
   * {@link sourceId}; requires an explicit {@link idempotencyKey}.
   */
  commissionIds?: string[];
  /** Overrides the earner's `payoutThresholdCents`. */
  minimumThresholdCents?: number;
  /** Overrides the earner's `payoutMethod`. */
  payoutMethod?: PayoutMethod;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/** Result of {@link CommissionPayoutService.createPayoutBatch}. */
export interface CreatePayoutBatchResult {
  /** The created (or, on an idempotent replay, existing) payout — `null` on refusal. */
  payout: CommissionPayout | null;
  /** `true` only when THIS call minted the payout. */
  created: boolean;
  /** Why no payout was created, when refused. */
  reason?: 'below_threshold' | 'nothing_payable';
  /** Ids of the commissions THIS call stamped onto the payout. */
  settledCommissionIds: string[];
  /** Ids of the adjustments THIS call stamped onto the payout. */
  settledAdjustmentIds: string[];
}

/**
 * Why a payout's membership failed source verification. Every reason is
 * fail-closed: the payout is excluded from source-scoped listings and
 * refused source-authorized transitions until repaired.
 *
 * - `membership_empty` — no rows are stamped with the payout's id (nothing
 *   proves ownership; e.g. a raced-away batch artifact or a rejected batch
 *   whose rows were released).
 * - `source_mismatch` — a member commission (or an adjustment's parent
 *   commission) carries a different or empty `(sourceKind, sourceId)`.
 * - `adjustment_parent_missing` — a member adjustment's parent commission
 *   cannot be loaded, so its ownership cannot be proven.
 * - `earner_mismatch` / `currency_mismatch` / `tenant_mismatch` — a member
 *   row disagrees with the payout on that axis.
 */
export type PayoutMembershipRefusalReason =
  | 'membership_empty'
  | 'source_mismatch'
  | 'adjustment_parent_missing'
  | 'earner_mismatch'
  | 'currency_mismatch'
  | 'tenant_mismatch';

/** Why {@link CommissionPayoutService.transitionPayoutForSource} refused. */
export type PayoutTransitionRefusalReason =
  | PayoutMembershipRefusalReason
  | 'payout_not_found'
  | 'status_conflict'
  | 'totals_drift'
  | 'non_positive_total';

/**
 * Source-authorized lifecycle actions. Targets:
 * `approve` (pending → approved), `mark_processing` (approved →
 * processing), `complete` (processing → completed, requires
 * `paymentReference`), `fail` (approved|processing → failed, requires
 * `reason`), `reject` (pending|approved → rejected, requires `reason`;
 * releases the batch's membership).
 */
export type PayoutSourceTransitionAction =
  | 'approve'
  | 'mark_processing'
  | 'complete'
  | 'fail'
  | 'reject';

/** Input for {@link CommissionPayoutService.transitionPayoutForSource}. */
export interface TransitionPayoutForSourceInput {
  payoutId: string;
  /**
   * The earning source this transition is authorized against. EVERY member
   * commission — and every member adjustment through its parent commission
   * — must belong to exactly this source or the call is refused.
   */
  sourceKind: string;
  sourceId: string;
  action: PayoutSourceTransitionAction;
  /**
   * Optimistic concurrency guard: refuse with `status_conflict` when the
   * LOCKED payout's status differs, after source membership is authorized.
   * Omit to let the action's own from-status rule arbitrate (concurrent
   * duplicate calls for actions that retain membership then resolve as one
   * `transitioned` + one `already_applied`; `reject` replays fail
   * `membership_empty` after releasing that evidence).
   */
  expectedStatus?: CommissionPayoutStatus;
  /** Required for `complete`. */
  paymentReference?: string;
  /** Required for `fail` and `reject`; appended to the payout's notes. */
  reason?: string;
  /** Clock override for deterministic tests. */
  now?: Date;
}

/** Result of {@link CommissionPayoutService.transitionPayoutForSource}. */
export interface TransitionPayoutForSourceResult {
  /**
   * `transitioned` — THIS call performed the transition.
   * `already_applied` — the payout was already in the action's target
   * status; nothing was written (terminal completion metadata —
   * `paymentReference`, `providerRef`, `paidAt` — is never overwritten by
   * a replay).
   * `refused` — fail-closed; see {@link refusal}.
   */
  outcome: 'transitioned' | 'already_applied' | 'refused';
  /**
   * The payout re-read AFTER the transaction (bound to the service's own
   * connection). `null` for `payout_not_found` and every membership
   * authorization refusal, so an unverified caller receives no payout
   * lifecycle or settlement data.
   */
  payout: CommissionPayout | null;
  /** Set exactly when {@link outcome} is `refused`. */
  refusal?: { reason: PayoutTransitionRefusalReason; detail: string };
  /** Commissions a `reject` released back to unsettled. */
  releasedCommissionIds?: string[];
  /** Adjustments a `reject` released back to unsettled. */
  releasedAdjustmentIds?: string[];
}

/** Input for {@link CommissionPayoutService.getSourcePayoutHistory}. */
export interface SourcePayoutHistoryInput {
  sourceKind: string;
  sourceId: string;
  /** Page size, 1–100. Default 25. */
  limit?: number;
  /** Rows to skip (offset pagination). Default 0. */
  offset?: number;
}

/** One page of {@link CommissionPayoutService.getSourcePayoutHistory}. */
export interface SourcePayoutHistoryPage {
  /**
   * The page's VERIFIED payouts, newest first (`created_at DESC, id DESC`).
   * May hold fewer than `limit` rows even when {@link nextOffset} is set —
   * rows that failed verification are in {@link excluded} instead.
   */
  payouts: CommissionPayout[];
  /** Stamped rows on this page excluded fail-closed, with reasons. */
  excluded: {
    payoutId: string;
    reason: PayoutMembershipRefusalReason;
    detail: string;
  }[];
  /** Echo of the requested offset. */
  offset: number;
  /** Echo of the effective page size. */
  limit: number;
  /**
   * Offset of the next page (advances by the SCANNED count, so excluded
   * rows never cause skips), or `null` when the history is exhausted.
   */
  nextOffset: number | null;
}

export class CommissionPayoutService {
  /**
   * Canonical UUID shape. Explicit `commissionIds` are filtered against this
   * before hitting the native-`uuid` `id` column so a malformed external id
   * can't abort the batch on Postgres/DuckDB.
   */
  private static readonly UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  constructor(private readonly deps: CommissionPayoutServiceDeps) {}

  static async create(
    classOptions: SmrtClassOptions = {},
  ): Promise<CommissionPayoutService> {
    return new CommissionPayoutService({
      earners: await EarnerCollection.create(classOptions),
      commissions: await CommissionCollection.create(classOptions),
      adjustments: await CommissionAdjustmentCollection.create(classOptions),
      payouts: await CommissionPayoutCollection.create(classOptions),
    });
  }

  /**
   * Create a settlement batch for one earner in one currency.
   *
   * Flow:
   * 1. **Idempotency + repair** — an existing payout with the (defaulted)
   *    key is returned as `{ payout, created: false }`. A clean replay
   *    touches nothing (new payable work is never swept into an existing
   *    batch). A PENDING payout whose stored totals disagree with the rows
   *    stamped with its id — the signature of an interrupted claim pass —
   *    is repaired: the claim pass re-runs and the totals are reconciled
   *    from the verified membership. Past `pending` the batch is frozen.
   * 2. **Gather** — payable unsettled commissions for the earner/currency,
   *    plus unsettled adjustments whose parent commission is
   *    earned/approved/payable/paid (same eligibility as the balance
   *    service, so the batch settles exactly what the balance reports). Pass
   *    `sourceKind`/`sourceId` to gather only ONE source's commissions, or
   *    `commissionIds` to gather an explicit set; in both scoped modes the
   *    eligible adjustments are narrowed to the same scope.
   * 3. **Refuse** — `netTotal <= 0` → `'nothing_payable'`;
   *    `netTotal < threshold` (earner default, overridable) →
   *    `'below_threshold'`. Nothing is minted or stamped on refusal.
   * 4. **Mint, claim, reconcile** — create the `pending` payout, then
   *    CLAIM the gathered rows through the collections' conditional
   *    `claimForPayout` (rows grabbed by another batch in the interim are
   *    skipped, never double-claimed), and finally store totals computed
   *    from the rows that were VERIFIABLY claimed — the payout's totals
   *    are always reproducible from its member rows.
   *
   * Concurrency: claims are conditional with post-save verification, which
   * narrows but does not eliminate races, and a batch is NOT wrapped in one
   * DB transaction (the collection layer exposes none). Safe concurrent
   * settlement therefore relies on SCOPING to DISJOINT sets: two batches
   * scoped to different sources (or non-overlapping `commissionIds`) gather
   * disjoint rows and never contend — this is the intended multi-source
   * (e.g. per-ad-network) settlement pattern. Running OVERLAPPING scopes
   * concurrently (a source batch and the earner-wide batch, or intersecting
   * id sets) is the caller's responsibility to serialize: `claimForPayout`
   * still won't double-own a single row, but a shared commission and its
   * negative adjustment could split across the two batches, so neither
   * payout's net would be authoritative. An interrupted claim pass within a
   * single scope is healed by the repair-on-replay above.
   */
  async createPayoutBatch(
    input: CreatePayoutBatchInput,
  ): Promise<CreatePayoutBatchResult> {
    const now = input.now ?? new Date();
    CommissionPayoutService.assertScope(input);
    const earner = await this.deps.earners.get({ id: input.earnerId });
    if (!earner) {
      throw new Error(
        `CommissionPayoutService: earner '${input.earnerId}' not found`,
      );
    }

    const idempotencyKey =
      input.idempotencyKey ??
      CommissionPayoutService.defaultIdempotencyKey(
        input.earnerId,
        input.currency,
        input.periodEnd ?? now,
        input.sourceKind && input.sourceId
          ? { sourceKind: input.sourceKind, sourceId: input.sourceId }
          : undefined,
      );

    // Idempotent replay: same key → same payout. A CLEAN replay (stored
    // totals match the stamped membership) returns without touching rows —
    // new payable work is never swept into an existing batch. A pending
    // payout whose stored totals DISAGREE with its membership is the
    // signature of an interrupted claim pass: repair it (re-claim +
    // reconcile totals) instead of returning totals its rows can't
    // reproduce. Anything past pending is frozen.
    const existingPayout =
      await this.deps.payouts.findByIdempotencyKey(idempotencyKey);
    if (existingPayout) {
      if (
        existingPayout.isPending() &&
        !(await this.membershipConsistent(existingPayout))
      ) {
        const repaired = await this.claimAndReconcile(existingPayout, input);
        return { ...repaired, created: false };
      }
      return {
        payout: existingPayout,
        created: false,
        settledCommissionIds: [],
        settledAdjustmentIds: [],
      };
    }

    // Gather the exact rows this batch would settle (honoring any source /
    // explicit-id scope).
    const commissions = await this.gatherBatchCommissions(input);
    const eligibleAdjustments = await this.findEligibleUnsettledAdjustments(
      input.earnerId,
      input.currency,
      CommissionPayoutService.adjustmentParentPredicate(input),
    );

    const commissionTotalCents = commissions.reduce(
      (sum, c) => sum + c.amountCents,
      0,
    );
    const adjustmentTotalCents = eligibleAdjustments.reduce(
      (sum, a) => sum + a.amountCents,
      0,
    );
    const netTotalCents = commissionTotalCents + adjustmentTotalCents;

    if (netTotalCents <= 0) {
      return {
        payout: null,
        created: false,
        reason: 'nothing_payable',
        settledCommissionIds: [],
        settledAdjustmentIds: [],
      };
    }

    const thresholdCents =
      input.minimumThresholdCents ?? earner.payoutThresholdCents;
    if (netTotalCents < thresholdCents) {
      return {
        payout: null,
        created: false,
        reason: 'below_threshold',
        settledCommissionIds: [],
        settledAdjustmentIds: [],
      };
    }

    const minted = await this.deps.payouts.create({
      // Payouts inherit the earner's tenancy so scheduled batch runs (no
      // active tenant context) still land in the right tenant.
      tenantId: earner.tenantId,
      earnerId: input.earnerId,
      currency: input.currency,
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      payoutMethod: input.payoutMethod ?? earner.payoutMethod,
      status: 'pending',
      commissionTotalCents,
      adjustmentTotalCents,
      totalAmountCents: netTotalCents,
      idempotencyKey,
    });

    // Adopt the PERSISTED row for the idempotency key before claiming
    // anything: two workers racing past the earlier lookup both reach the
    // natural-key upsert, and the loser's in-memory instance carries an id
    // the database no longer holds. Claiming with that orphaned id would
    // stamp rows onto a payout that doesn't exist — so both workers
    // converge on whichever row actually won the key.
    const payout =
      (await this.deps.payouts.findByIdempotencyKey(idempotencyKey)) ?? minted;

    // Claim the gathered rows conditionally and reconcile the stored
    // totals from what was VERIFIABLY claimed — a row grabbed by another
    // batch between gather and claim is skipped, never double-claimed, and
    // never counted.
    const result = await this.claimAndReconcile(payout, input);
    return { ...result, created: true };
  }

  /**
   * Whether a payout's stored totals are reproducible from the rows
   * actually stamped with its id — the invariant an interrupted claim pass
   * breaks. Clean replays short-circuit on this; repair runs only when it
   * fails.
   */
  private async membershipConsistent(
    payout: CommissionPayout,
  ): Promise<boolean> {
    const payoutId = payout.id ?? '';
    const members = await this.deps.commissions.findByPayout(payoutId);
    const memberAdjustments =
      await this.deps.adjustments.findByPayout(payoutId);
    const commissionTotalCents = members.reduce(
      (sum, c) => sum + c.amountCents,
      0,
    );
    const adjustmentTotalCents = memberAdjustments.reduce(
      (sum, a) => sum + a.amountCents,
      0,
    );
    return (
      payout.commissionTotalCents === commissionTotalCents &&
      payout.adjustmentTotalCents === adjustmentTotalCents &&
      payout.totalAmountCents === commissionTotalCents + adjustmentTotalCents
    );
  }

  /**
   * Claim pass + totals reconciliation for a PENDING payout.
   *
   * The claim set is the union of rows already stamped with this payout
   * (an interrupted earlier pass) and the currently gathered eligible
   * rows. Claims go through the collections' conditional `claimForPayout`
   * (rows owned by another batch are skipped); totals are then recomputed
   * from the claimed rows and saved when they drift from what the payout
   * carries. In the pathological all-rows-raced-away case the payout keeps
   * zero totals and a note — auditable, never double-paid.
   *
   * The pass also derives the payout's single-source stamp
   * (`sourceKind`/`sourceId`) from the verified claimed membership — set
   * when every claimed commission and every claimed adjustment's parent
   * shares exactly one non-empty source, empty otherwise — which is what
   * the source-scoped history listing indexes on.
   *
   * A fresh status re-read gates the pass: only a payout that is STILL
   * pending claims rows. This narrows (but, like every claim here, does not
   * transactionally eliminate) the race against a concurrent lifecycle
   * transition of the same payout — replaying a batch while its payout is
   * being approved/rejected is an overlapping concurrent scope the caller
   * must serialize, same as the documented batch-scope contract.
   */
  private async claimAndReconcile(
    stalePayout: CommissionPayout,
    input: CreatePayoutBatchInput,
  ): Promise<Omit<CreatePayoutBatchResult, 'created'>> {
    const payoutId = stalePayout.id ?? '';

    // Authoritative re-read: claims may only land on a payout that is
    // still pending. (The stale instance is the pre-lookup snapshot.)
    const payout = (await this.deps.payouts.get({ id: payoutId })) ?? null;
    if (!payout?.isPending()) {
      return {
        payout: payout ?? stalePayout,
        settledCommissionIds: [],
        settledAdjustmentIds: [],
      };
    }

    const previouslyClaimed =
      await this.deps.commissions.findByPayout(payoutId);
    // Re-gather with the SAME scope as the initial pass so a repair never
    // pulls out-of-scope rows into a scoped batch.
    const gathered = await this.gatherBatchCommissions(input);
    const commissionIds = [
      ...new Set(
        [...previouslyClaimed, ...gathered]
          .map((c) => c.id)
          .filter((id): id is string => !!id),
      ),
    ];
    const claimedCommissions = await this.deps.commissions.claimForPayout(
      commissionIds,
      payoutId,
    );

    const previouslyClaimedAdjustments =
      await this.deps.adjustments.findByPayout(payoutId);
    const gatheredAdjustments = await this.findEligibleUnsettledAdjustments(
      input.earnerId,
      input.currency,
      CommissionPayoutService.adjustmentParentPredicate(input),
    );
    const adjustmentIds = [
      ...new Set(
        [...previouslyClaimedAdjustments, ...gatheredAdjustments]
          .map((a) => a.id)
          .filter((id): id is string => !!id),
      ),
    ];
    const claimedAdjustments = await this.deps.adjustments.claimForPayout(
      adjustmentIds,
      payoutId,
    );

    const commissionTotalCents = claimedCommissions.reduce(
      (sum, c) => sum + c.amountCents,
      0,
    );
    const adjustmentTotalCents = claimedAdjustments.reduce(
      (sum, a) => sum + a.amountCents,
      0,
    );
    const totalAmountCents = commissionTotalCents + adjustmentTotalCents;

    // Derive the single-source stamp from the VERIFIED claimed membership
    // (adjustments prove their source through their parent commission).
    const parentById = await this.loadAdjustmentParents(
      this.deps.commissions,
      claimedCommissions,
      claimedAdjustments,
    );
    const derivedSource = CommissionPayoutService.deriveMembershipSource(
      claimedCommissions,
      claimedAdjustments,
      parentById,
    );

    if (
      payout.commissionTotalCents !== commissionTotalCents ||
      payout.adjustmentTotalCents !== adjustmentTotalCents ||
      payout.totalAmountCents !== totalAmountCents ||
      payout.sourceKind !== derivedSource.sourceKind ||
      payout.sourceId !== derivedSource.sourceId
    ) {
      payout.commissionTotalCents = commissionTotalCents;
      payout.adjustmentTotalCents = adjustmentTotalCents;
      payout.totalAmountCents = totalAmountCents;
      payout.sourceKind = derivedSource.sourceKind;
      payout.sourceId = derivedSource.sourceId;
      if (claimedCommissions.length === 0 && claimedAdjustments.length === 0) {
        payout.notes =
          'no rows claimed (raced by a concurrent batch); nothing will be paid';
      }
      await payout.save();
    }

    return {
      payout,
      settledCommissionIds: claimedCommissions
        .map((c) => c.id)
        .filter((id): id is string => !!id),
      settledAdjustmentIds: claimedAdjustments
        .map((a) => a.id)
        .filter((id): id is string => !!id),
    };
  }

  /**
   * Complete a payout: flip the batch's settled commissions
   * `payable → paid` FIRST, then `payout.complete(paymentReference)`
   * (requires status `processing`). Ordering matters for recoverability —
   * if a member save fails mid-loop the payout is still `processing`, so a
   * retry finishes the remaining members (already-paid ones are skipped)
   * and then finalizes; the terminal transition never strands `payable`
   * members behind a `completed` payout. Adjustments carry no status —
   * stamping `payoutId` at batch time already settled them.
   */
  async completePayout(
    payoutId: string,
    paymentReference: string,
    now: Date = new Date(),
  ): Promise<CommissionPayout> {
    const payout = await this.requirePayout(payoutId);
    if (!payout.isProcessing()) {
      throw new Error(
        `CommissionPayout ${payout.id ?? '<new>'}: cannot complete from status '${payout.status}'`,
      );
    }
    if (!paymentReference) {
      throw new Error(
        `CommissionPayout ${payout.id ?? '<new>'}: complete() requires a paymentReference`,
      );
    }

    const members = await this.deps.commissions.findByPayout(payoutId);
    for (const commission of members) {
      if (commission.isPayable()) {
        commission.markPaid(now);
        await commission.save();
      }
    }

    payout.complete(paymentReference, now);
    await payout.save();
    return payout;
  }

  /**
   * Fail a payout (`approved | processing → failed`). The batch's rows stay
   * stamped — after `resetFromFailed()` the SAME payout retries the SAME
   * rows; releasing the rows to a different batch would double-pay them if
   * the failed remittance later settled.
   */
  async failPayout(
    payoutId: string,
    reason: string,
  ): Promise<CommissionPayout> {
    const payout = await this.requirePayout(payoutId);
    payout.fail(reason);
    await payout.save();
    return payout;
  }

  /**
   * One page of the payout history belonging to ONE earning source,
   * newest first (`created_at DESC, id DESC` — deterministic across ties).
   *
   * Candidates come from the indexed single-source stamp
   * (`CommissionPayout.sourceKind`/`sourceId`, maintained from verified
   * claimed membership at batch/repair time), so database work is bounded
   * by the page size — a sparse source never forces a scan of the global
   * payout history. Each page is then RE-VERIFIED against its actual
   * membership in three batched queries (commissions, adjustments,
   * adjustment parents — no per-payout N+1): every member commission and
   * every adjustment's parent must carry exactly the requested source and
   * agree with the payout on earner/currency/tenant. Rows the stamp alone
   * cannot prove are excluded fail-closed and reported in `excluded`
   * (mixed-source membership, missing adjustment parents, memberless
   * artifacts, released/rejected batches).
   *
   * Adjustment-only payouts are first-class: a batch that settled only
   * CommissionAdjustment rows proves its source through each adjustment's
   * parent commission and lists normally.
   *
   * Payouts minted before the stamp existed carry an empty stamp and are
   * invisible here until backfilled — see {@link restampPayoutSource}.
   *
   * Offset pagination contract: `nextOffset` advances by the SCANNED count
   * (verified + excluded), so pages never skip rows; a page may hold fewer
   * than `limit` verified payouts. Newly minted payouts prepend to the
   * history between calls, as with any offset listing. Tenant interception
   * applies to every query (candidates, membership, parents), so a tenant
   * context sees only its own history.
   */
  async getSourcePayoutHistory(
    input: SourcePayoutHistoryInput,
  ): Promise<SourcePayoutHistoryPage> {
    if (!input.sourceKind || !input.sourceId) {
      throw new Error(
        'CommissionPayoutService.getSourcePayoutHistory: sourceKind and sourceId are required',
      );
    }
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));

    // limit + 1 probes for a further page without a COUNT query.
    const probed = await this.deps.payouts.findBySource(
      input.sourceKind,
      input.sourceId,
      { limit: limit + 1, offset },
    );
    const hasMore = probed.length > limit;
    const candidates = hasMore ? probed.slice(0, limit) : probed;

    const payoutIds = candidates
      .map((p) => p.id)
      .filter((id): id is string => !!id);
    const members = await this.deps.commissions.findByPayouts(payoutIds);
    const memberAdjustments =
      await this.deps.adjustments.findByPayouts(payoutIds);
    const parentById = await this.loadAdjustmentParents(
      this.deps.commissions,
      members,
      memberAdjustments,
    );
    // Cardinality guard (see countStampedRows): rows a tenant scope cannot
    // see must still fail the page's membership proof, not silently thin
    // it out.
    const db = this.resolveDatabase();
    const rawCommissionCounts = await CommissionPayoutService.countStampedRows(
      db,
      this.deps.commissions.tableName,
      payoutIds,
    );
    const rawAdjustmentCounts = await CommissionPayoutService.countStampedRows(
      db,
      this.deps.adjustments.tableName,
      payoutIds,
    );

    const membersByPayout = new Map<string, Commission[]>();
    for (const commission of members) {
      const bucket = membersByPayout.get(commission.payoutId);
      if (bucket) bucket.push(commission);
      else membersByPayout.set(commission.payoutId, [commission]);
    }
    const adjustmentsByPayout = new Map<string, CommissionAdjustment[]>();
    for (const adjustment of memberAdjustments) {
      const bucket = adjustmentsByPayout.get(adjustment.payoutId);
      if (bucket) bucket.push(adjustment);
      else adjustmentsByPayout.set(adjustment.payoutId, [adjustment]);
    }

    const page: SourcePayoutHistoryPage = {
      payouts: [],
      excluded: [],
      offset,
      limit,
      nextOffset: hasMore ? offset + candidates.length : null,
    };
    for (const payout of candidates) {
      const id = payout.id ?? '';
      const visibleMembers = membersByPayout.get(id) ?? [];
      const visibleAdjustments = adjustmentsByPayout.get(id) ?? [];
      const rawCommissionCount = rawCommissionCounts.get(id) ?? 0;
      const rawAdjustmentCount = rawAdjustmentCounts.get(id) ?? 0;
      if (
        rawCommissionCount !== visibleMembers.length ||
        rawAdjustmentCount !== visibleAdjustments.length
      ) {
        page.excluded.push({
          payoutId: id,
          reason: 'tenant_mismatch',
          detail:
            `payout has ${rawCommissionCount} commission and ${rawAdjustmentCount} adjustment rows stamped, ` +
            `but only ${visibleMembers.length} and ${visibleAdjustments.length} are visible in the current tenant scope`,
        });
        continue;
      }
      const verdict = CommissionPayoutService.verifySourceMembership({
        payout,
        commissions: visibleMembers,
        adjustments: visibleAdjustments,
        parentById,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
      });
      if (verdict.ok) {
        page.payouts.push(payout);
      } else {
        page.excluded.push({
          payoutId: id,
          reason: verdict.reason,
          detail: verdict.detail,
        });
      }
    }
    return page;
  }

  /**
   * Backfill/repair the derived single-source stamp of ONE payout from its
   * actual membership — the documented migration path for payouts minted
   * before the stamp existed (they carry `''`/`''` and are invisible to
   * {@link getSourcePayoutHistory} until restamped). Safe on any status:
   * the stamp is derived data, and a payout whose membership is mixed or
   * unprovable derives back to the empty stamp.
   *
   * One-time migration loop: page through `payouts.list({})` and call this
   * per row (idempotent — an already-correct stamp saves nothing).
   */
  async restampPayoutSource(payoutId: string): Promise<{
    payout: CommissionPayout | null;
    sourceKind: string;
    sourceId: string;
    changed: boolean;
  }> {
    const payout = await this.deps.payouts.get({ id: payoutId });
    if (!payout) {
      return { payout: null, sourceKind: '', sourceId: '', changed: false };
    }
    const members = await this.deps.commissions.findByPayout(payoutId);
    const memberAdjustments =
      await this.deps.adjustments.findByPayout(payoutId);
    const parentById = await this.loadAdjustmentParents(
      this.deps.commissions,
      members,
      memberAdjustments,
    );
    const derived = CommissionPayoutService.deriveMembershipSource(
      members,
      memberAdjustments,
      parentById,
    );
    if (
      payout.sourceKind === derived.sourceKind &&
      payout.sourceId === derived.sourceId
    ) {
      return { payout, ...derived, changed: false };
    }
    payout.sourceKind = derived.sourceKind;
    payout.sourceId = derived.sourceId;
    await payout.save();
    return { payout, ...derived, changed: true };
  }

  /**
   * Atomically authorize ONE payout against ONE earning source and perform
   * a lifecycle transition — the multi-replica-safe alternative to loading
   * the payout, querying membership, and calling the model transitions
   * yourself (which leaves a TOCTOU window between authorization and
   * transition).
   *
   * Everything runs on the SAME transaction database: the payout row is
   * locked (PostgreSQL `SELECT … FOR UPDATE`, so concurrent calls across
   * app replicas serialize on the row; single-connection engines get
   * equivalent behavior from the transaction plus an in-process
   * per-database queue), membership is re-read and re-verified under the
   * lock, totals are recomputed under the lock, and the transition + every
   * member write commit or roll back together.
   *
   * Under the lock, in order:
   *
   * 1. **Hydrate** — load the locked payout. A missing/cross-tenant id
   *    refuses `payout_not_found`.
   * 2. **Source authorization** — every member commission, and every
   *    member adjustment through its parent commission, must carry exactly
   *    the requested `(sourceKind, sourceId)` and agree with the payout on
   *    earner/currency/tenant; anything unprovable refuses fail-closed
   *    (`source_mismatch`, `adjustment_parent_missing`, mismatches,
   *    `membership_empty` — note this means memberless raced-away batch
   *    artifacts cannot receive any status-derived outcome through this
   *    source-authorized door).
   * 3. **Status outcome** — after authorization, a payout already in the
   *    action's target status returns `already_applied` WITHOUT writing
   *    (terminal completion metadata — `paymentReference`, `providerRef`,
   *    `paidAt` — is never overwritten by a replay). `expectedStatus`, when
   *    given, must then match the locked status or the call refuses
   *    `status_conflict`; the action's own from-status rule applies last.
   *    Concurrent duplicate calls for actions that RETAIN membership
   *    therefore resolve deterministically: one `transitioned`, the rest
   *    `already_applied` (or `status_conflict` when they raced a DIFFERENT
   *    action). `reject` releases the membership evidence, so a serialized
   *    replay fails closed as `membership_empty` rather than exposing the
   *    rejected status.
   * 4. **Totals recompute** — commission/adjustment/total amounts are
   *    recomputed from the locked membership; drift refuses `totals_drift`
   *    for the money-forward actions (`approve`, `mark_processing`,
   *    `complete` — repair via a `createPayoutBatch` replay while the
   *    payout is pending). The defensive actions (`fail`, `reject`)
   *    proceed despite drift — rejecting a drifted batch IS the remedy. A
   *    non-positive recomputed total refuses `approve` with
   *    `non_positive_total`.
   * 5. **Apply** — `complete` flips the batch's payable commissions to
   *    `paid` and completes the payout in the same transaction (no more
   *    retryable-but-partial completion); `reject` RELEASES the batch's
   *    membership (clears `payoutId` on every member commission and
   *    adjustment, model-layer per row) so the rows settle through a
   *    future batch, then marks the payout rejected — terminal.
   *
   * Replaying a `createPayoutBatch` for the same payout concurrently with
   * a transition is an overlapping concurrent scope (same contract as
   * overlapping batch scopes): the batch side re-checks pending before
   * claiming, which narrows but does not transactionally close that race —
   * serialize those two call sites per payout.
   */
  async transitionPayoutForSource(
    input: TransitionPayoutForSourceInput,
  ): Promise<TransitionPayoutForSourceResult> {
    const now = input.now ?? new Date();
    if (!input.sourceKind || !input.sourceId) {
      throw new Error(
        'CommissionPayoutService.transitionPayoutForSource: sourceKind and sourceId are required',
      );
    }
    const targetStatus =
      CommissionPayoutService.TRANSITION_TARGET[input.action];
    if (!targetStatus) {
      throw new Error(
        `CommissionPayoutService.transitionPayoutForSource: unknown action '${String(input.action)}'`,
      );
    }
    if (input.action === 'complete' && !input.paymentReference) {
      throw new Error(
        "CommissionPayoutService.transitionPayoutForSource: action 'complete' requires a paymentReference",
      );
    }
    if (
      (input.action === 'fail' || input.action === 'reject') &&
      !input.reason
    ) {
      throw new Error(
        `CommissionPayoutService.transitionPayoutForSource: action '${input.action}' requires a reason`,
      );
    }
    // A malformed id can't match a payout, and would abort the whole query
    // as an invalid cast on native-uuid columns — refuse it as not-found.
    if (!CommissionPayoutService.UUID_RE.test(input.payoutId)) {
      return {
        outcome: 'refused',
        payout: null,
        refusal: {
          reason: 'payout_not_found',
          detail: `payout id '${input.payoutId}' is not a valid id`,
        },
      };
    }

    const db = this.resolveDatabase();
    const outcome = await this.runSerializedTransaction<TxTransitionOutcome>(
      db,
      async (txDb): Promise<TxTransitionOutcome> => {
        const tx = {
          payouts: await CommissionPayoutCollection.create(
            CommissionPayoutService.txOptions(txDb),
          ),
          commissions: await CommissionCollection.create(
            CommissionPayoutService.txOptions(txDb),
          ),
          adjustments: await CommissionAdjustmentCollection.create(
            CommissionPayoutService.txOptions(txDb),
          ),
        };

        // Row lock: PostgreSQL serializes concurrent transitions of one
        // payout across replicas here. Single-connection engines (SQLite,
        // DuckDB) don't support FOR UPDATE and don't need it — their whole
        // transaction is serialized by runSerializedTransaction.
        if (
          typeof (db as TransactionCapableDatabase).acquireSession ===
          'function'
        ) {
          await txDb.query(
            `SELECT id FROM ${tx.payouts.tableName} WHERE id = $1 FOR UPDATE`,
            input.payoutId,
          );
        }

        const payout = await tx.payouts.get({ id: input.payoutId });
        if (!payout) {
          return CommissionPayoutService.txRefusal(
            null,
            'payout_not_found',
            `payout '${input.payoutId}' not found`,
          );
        }
        const payoutId = payout.id ?? '';

        const members = await tx.commissions.findByPayout(payoutId);
        const memberAdjustments = await tx.adjustments.findByPayout(payoutId);

        // Cardinality guard: the reads above are tenant-scoped, so a
        // foreign tenant's row stamped onto this payout would be invisible
        // — and verification over the visible subset would authorize
        // incomplete membership. Compare against RAW counts (count-only,
        // no row data crosses the tenant boundary) and fail closed on any
        // excess.
        const rawCommissionCount =
          (
            await CommissionPayoutService.countStampedRows(
              txDb,
              tx.commissions.tableName,
              [input.payoutId],
            )
          ).get(input.payoutId) ?? 0;
        const rawAdjustmentCount =
          (
            await CommissionPayoutService.countStampedRows(
              txDb,
              tx.adjustments.tableName,
              [input.payoutId],
            )
          ).get(input.payoutId) ?? 0;
        if (
          rawCommissionCount !== members.length ||
          rawAdjustmentCount !== memberAdjustments.length
        ) {
          return CommissionPayoutService.txAuthorizationRefusal(
            payoutId,
            'tenant_mismatch',
          );
        }

        const parentById = await this.loadAdjustmentParents(
          tx.commissions,
          members,
          memberAdjustments,
        );
        const verdict = CommissionPayoutService.verifySourceMembership({
          payout,
          commissions: members,
          adjustments: memberAdjustments,
          parentById,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
        });
        if (!verdict.ok) {
          return CommissionPayoutService.txAuthorizationRefusal(
            payoutId,
            verdict.reason,
          );
        }

        if (payout.status === targetStatus) {
          return { outcome: 'already_applied' as const, payoutId };
        }
        if (input.expectedStatus && payout.status !== input.expectedStatus) {
          return CommissionPayoutService.txRefusal(
            payoutId,
            'status_conflict',
            `expected status '${input.expectedStatus}' but payout is '${payout.status}'`,
          );
        }
        const legalFrom = CommissionPayoutService.TRANSITION_FROM[input.action];
        if (!legalFrom.includes(payout.status)) {
          return CommissionPayoutService.txRefusal(
            payoutId,
            'status_conflict',
            `cannot ${input.action} from status '${payout.status}'`,
          );
        }

        const commissionTotalCents = members.reduce(
          (sum, c) => sum + c.amountCents,
          0,
        );
        const adjustmentTotalCents = memberAdjustments.reduce(
          (sum, a) => sum + a.amountCents,
          0,
        );
        const totalAmountCents = commissionTotalCents + adjustmentTotalCents;
        const drifted =
          payout.commissionTotalCents !== commissionTotalCents ||
          payout.adjustmentTotalCents !== adjustmentTotalCents ||
          payout.totalAmountCents !== totalAmountCents;
        const moneyForward =
          input.action === 'approve' ||
          input.action === 'mark_processing' ||
          input.action === 'complete';
        if (drifted && moneyForward) {
          return CommissionPayoutService.txRefusal(
            payoutId,
            'totals_drift',
            `persisted totals (commission=${payout.commissionTotalCents} adjustment=${payout.adjustmentTotalCents} total=${payout.totalAmountCents}) ` +
              `do not match membership (commission=${commissionTotalCents} adjustment=${adjustmentTotalCents} total=${totalAmountCents}) — ` +
              'repair via a createPayoutBatch replay while pending',
          );
        }
        if (input.action === 'approve' && payout.totalAmountCents <= 0) {
          return CommissionPayoutService.txRefusal(
            payoutId,
            'non_positive_total',
            `cannot approve a batch with non-positive total (${payout.totalAmountCents} cents)`,
          );
        }

        const releasedCommissionIds: string[] = [];
        const releasedAdjustmentIds: string[] = [];
        switch (input.action) {
          case 'approve':
            payout.approve();
            break;
          case 'mark_processing':
            payout.markProcessing();
            break;
          case 'fail':
            payout.fail(input.reason ?? '');
            break;
          case 'reject': {
            // Release the membership FIRST (model-layer per row — tenancy-
            // and dialect-safe), then the terminal decline; the transaction
            // makes the pair atomic. Stranded stamped rows would otherwise
            // be unsettleable forever.
            for (const commission of members) {
              commission.payoutId = '';
              await commission.save();
              if (commission.id) releasedCommissionIds.push(commission.id);
            }
            for (const adjustment of memberAdjustments) {
              adjustment.payoutId = '';
              await adjustment.save();
              if (adjustment.id) releasedAdjustmentIds.push(adjustment.id);
            }
            payout.reject(input.reason ?? '');
            break;
          }
          case 'complete': {
            // Members flip to paid in the SAME transaction as the terminal
            // payout write — a mid-loop failure rolls everything back
            // instead of leaving a partially-paid batch.
            for (const commission of members) {
              if (commission.isPayable()) {
                commission.markPaid(now);
                await commission.save();
              }
            }
            payout.complete(input.paymentReference ?? '', now);
            break;
          }
        }
        await payout.save();
        return {
          outcome: 'transitioned' as const,
          payoutId,
          releasedCommissionIds,
          releasedAdjustmentIds,
        };
      },
    );

    // Rehydrate OUTSIDE the transaction so the returned instance is bound
    // to the service's own connection, not the released transaction.
    const payout =
      outcome.payoutId && !outcome.authorizationFailed
        ? await this.deps.payouts.get({ id: outcome.payoutId })
        : null;
    const result: TransitionPayoutForSourceResult = {
      outcome: outcome.outcome,
      payout,
    };
    if (outcome.refusal) result.refusal = outcome.refusal;
    if (outcome.releasedCommissionIds?.length) {
      result.releasedCommissionIds = outcome.releasedCommissionIds;
    }
    if (outcome.releasedAdjustmentIds?.length) {
      result.releasedAdjustmentIds = outcome.releasedAdjustmentIds;
    }
    return result;
  }

  // -------- Source membership verification internals --------

  /** Target status per action — also the `already_applied` echo test. */
  private static readonly TRANSITION_TARGET: Record<
    PayoutSourceTransitionAction,
    CommissionPayoutStatus
  > = {
    approve: 'approved',
    mark_processing: 'processing',
    complete: 'completed',
    fail: 'failed',
    reject: 'rejected',
  };

  /** Legal from-statuses per action (mirrors the model transition guards). */
  private static readonly TRANSITION_FROM: Record<
    PayoutSourceTransitionAction,
    CommissionPayoutStatus[]
  > = {
    approve: ['pending'],
    mark_processing: ['approved'],
    complete: ['processing'],
    fail: ['approved', 'processing'],
    reject: ['pending', 'approved'],
  };

  private static txOptions(txDb: DatabaseInterface): SmrtClassOptions {
    return {
      db: txDb,
      // The transaction database is the SAME initialized database on a
      // pinned connection — skip system-table bootstrap and runtime
      // service setup (signals/AI) for these short-lived bindings.
      _reuseInitializedDb: true,
      _deferRuntimeInitialization: true,
    };
  }

  private static txRefusal(
    payoutId: string | null,
    reason: PayoutTransitionRefusalReason,
    detail: string,
  ): {
    outcome: 'refused';
    payoutId: string | null;
    refusal: { reason: PayoutTransitionRefusalReason; detail: string };
  } {
    return { outcome: 'refused', payoutId, refusal: { reason, detail } };
  }

  /**
   * A membership refusal means the requested source was never authorized.
   * Keep the typed reason for callers while withholding both the payout and
   * member-specific detail (actual source, ids, account, tenant, or money).
   */
  private static txAuthorizationRefusal(
    payoutId: string,
    reason: PayoutMembershipRefusalReason,
  ): TxTransitionOutcome {
    return {
      outcome: 'refused',
      payoutId,
      authorizationFailed: true,
      refusal: {
        reason,
        detail: 'requested source is not authorized for this payout membership',
      },
    };
  }

  /**
   * RAW stamped-row counts per payout id — deliberately UNSCOPED
   * (count-only, reviewed): tenant-scoped reads cannot see a foreign
   * tenant's row stamped onto a payout, so membership verification that
   * trusted only the visible subset would authorize (or list) incomplete
   * membership. No row data crosses the tenant boundary — only per-payout
   * counts, compared against the visible membership; any excess fails
   * closed as `tenant_mismatch`. Ids must be UUID-shaped (callers pass
   * validated payout ids), and the payout-id predicate never touches the
   * empty-FK encoding, so the query is dialect-safe.
   */
  private static async countStampedRows(
    db: DatabaseInterface,
    table: string,
    payoutIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    const ids = payoutIds.filter((id) =>
      CommissionPayoutService.UUID_RE.test(id),
    );
    if (ids.length === 0) return counts;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const res = await db.query(
      `SELECT payout_id, COUNT(*) AS row_count FROM ${table} WHERE payout_id IN (${placeholders}) GROUP BY payout_id`,
      ...ids,
    );
    const rows = Array.isArray(res)
      ? (res as Record<string, unknown>[])
      : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);
    for (const row of rows) {
      counts.set(String(row.payout_id), Number(row.row_count));
    }
    return counts;
  }

  /**
   * Parents of the given adjustments, keyed by commission id — member
   * commissions are reused, only the rest are fetched (one `IN` query).
   */
  private async loadAdjustmentParents(
    commissions: CommissionCollection,
    memberCommissions: Commission[],
    adjustments: CommissionAdjustment[],
  ): Promise<Map<string, Commission>> {
    const parentById = new Map<string, Commission>();
    for (const commission of memberCommissions) {
      if (commission.id) parentById.set(commission.id, commission);
    }
    const missingIds = [
      ...new Set(
        adjustments
          .map((a) => a.commissionId)
          .filter((id) => !!id && !parentById.has(id)),
      ),
    ];
    if (missingIds.length > 0) {
      const fetched = await commissions.listByIds(missingIds);
      for (const parent of fetched) {
        if (parent.id) parentById.set(parent.id, parent);
      }
    }
    return parentById;
  }

  /**
   * The single `(sourceKind, sourceId)` a payout's membership provably
   * belongs to — or the empty stamp when membership is empty, any member's
   * source is missing, an adjustment parent is unloadable, or more than
   * one source appears.
   */
  private static deriveMembershipSource(
    memberCommissions: Commission[],
    adjustments: CommissionAdjustment[],
    parentById: Map<string, Commission>,
  ): { sourceKind: string; sourceId: string } {
    const empty = { sourceKind: '', sourceId: '' };
    if (memberCommissions.length === 0 && adjustments.length === 0) {
      return empty;
    }
    const sources = new Map<string, { sourceKind: string; sourceId: string }>();
    const add = (sourceKind: string, sourceId: string) => {
      sources.set(`${sourceKind.length}:${sourceKind}:${sourceId}`, {
        sourceKind,
        sourceId,
      });
    };
    for (const commission of memberCommissions) {
      if (!commission.sourceKind || !commission.sourceId) return empty;
      add(commission.sourceKind, commission.sourceId);
    }
    for (const adjustment of adjustments) {
      const parent = parentById.get(adjustment.commissionId);
      if (!parent?.sourceKind || !parent.sourceId) return empty;
      add(parent.sourceKind, parent.sourceId);
    }
    if (sources.size !== 1) return empty;
    const [only] = sources.values();
    return only;
  }

  /**
   * Prove that EVERY member of a payout belongs to the requested source
   * and agrees with the payout on earner/currency/tenant. Adjustments
   * prove their source through their parent commission. Fail-closed: the
   * first unprovable member decides the verdict.
   */
  private static verifySourceMembership(input: {
    payout: CommissionPayout;
    commissions: Commission[];
    adjustments: CommissionAdjustment[];
    parentById: Map<string, Commission>;
    sourceKind: string;
    sourceId: string;
  }):
    | { ok: true }
    | { ok: false; reason: PayoutMembershipRefusalReason; detail: string } {
    const { payout } = input;
    // '' and NULL both mean "no tenant" depending on dialect — normalize.
    const tenantOf = (value: string | null | undefined) => value || null;
    if (input.commissions.length === 0 && input.adjustments.length === 0) {
      return {
        ok: false,
        reason: 'membership_empty',
        detail: 'no commissions or adjustments are stamped with this payout',
      };
    }
    for (const commission of input.commissions) {
      if (commission.earnerId !== payout.earnerId) {
        return {
          ok: false,
          reason: 'earner_mismatch',
          detail: `commission ${commission.id} belongs to earner '${commission.earnerId}', payout to '${payout.earnerId}'`,
        };
      }
      if (commission.currency !== payout.currency) {
        return {
          ok: false,
          reason: 'currency_mismatch',
          detail: `commission ${commission.id} is ${commission.currency}, payout is ${payout.currency}`,
        };
      }
      if (tenantOf(commission.tenantId) !== tenantOf(payout.tenantId)) {
        return {
          ok: false,
          reason: 'tenant_mismatch',
          detail: `commission ${commission.id} and the payout disagree on tenant`,
        };
      }
      if (
        commission.sourceKind !== input.sourceKind ||
        commission.sourceId !== input.sourceId
      ) {
        return {
          ok: false,
          reason: 'source_mismatch',
          detail: `commission ${commission.id} belongs to source '${commission.sourceKind}:${commission.sourceId}', not '${input.sourceKind}:${input.sourceId}'`,
        };
      }
    }
    for (const adjustment of input.adjustments) {
      if (adjustment.earnerId !== payout.earnerId) {
        return {
          ok: false,
          reason: 'earner_mismatch',
          detail: `adjustment ${adjustment.id} belongs to earner '${adjustment.earnerId}', payout to '${payout.earnerId}'`,
        };
      }
      if (adjustment.currency !== payout.currency) {
        return {
          ok: false,
          reason: 'currency_mismatch',
          detail: `adjustment ${adjustment.id} is ${adjustment.currency}, payout is ${payout.currency}`,
        };
      }
      if (tenantOf(adjustment.tenantId) !== tenantOf(payout.tenantId)) {
        return {
          ok: false,
          reason: 'tenant_mismatch',
          detail: `adjustment ${adjustment.id} and the payout disagree on tenant`,
        };
      }
      const parent = input.parentById.get(adjustment.commissionId);
      if (!parent) {
        return {
          ok: false,
          reason: 'adjustment_parent_missing',
          detail: `adjustment ${adjustment.id} parent commission '${adjustment.commissionId}' cannot be loaded to prove source ownership`,
        };
      }
      // The PARENT must agree with the payout on account axes too — an
      // adjustment's earner/currency/tenant are denormalized by
      // convention, not enforced, so a coherent-looking adjustment can
      // still hang off another account's commission.
      if (parent.earnerId !== payout.earnerId) {
        return {
          ok: false,
          reason: 'earner_mismatch',
          detail: `adjustment ${adjustment.id} parent commission belongs to earner '${parent.earnerId}', payout to '${payout.earnerId}'`,
        };
      }
      if (parent.currency !== payout.currency) {
        return {
          ok: false,
          reason: 'currency_mismatch',
          detail: `adjustment ${adjustment.id} parent commission is ${parent.currency}, payout is ${payout.currency}`,
        };
      }
      if (tenantOf(parent.tenantId) !== tenantOf(payout.tenantId)) {
        return {
          ok: false,
          reason: 'tenant_mismatch',
          detail: `adjustment ${adjustment.id} parent commission and the payout disagree on tenant`,
        };
      }
      if (
        parent.sourceKind !== input.sourceKind ||
        parent.sourceId !== input.sourceId
      ) {
        return {
          ok: false,
          reason: 'source_mismatch',
          detail: `adjustment ${adjustment.id} parent commission belongs to source '${parent.sourceKind}:${parent.sourceId}', not '${input.sourceKind}:${input.sourceId}'`,
        };
      }
    }
    return { ok: true };
  }

  /** The initialized database behind the payout collection. */
  private resolveDatabase(): DatabaseInterface {
    const db = this.deps.payouts.options.db;
    if (!db || typeof db === 'string' || !('query' in db)) {
      throw new Error(
        'CommissionPayoutService: the payout collection has no initialized database',
      );
    }
    return db as DatabaseInterface;
  }

  /**
   * Run `fn` inside a database transaction. PostgreSQL transactions get
   * their own pooled connection, so they run concurrently (the FOR UPDATE
   * row lock inside `fn` provides the per-payout serialization, replica-
   * safe). Single-connection engines (SQLite, DuckDB, JSON) multiplex
   * every transaction over one connection where concurrent BEGIN/COMMIT
   * pairs would interleave — their transitions chain per database
   * instance, giving equivalent serialized behavior in-process. An engine
   * with no transaction support at all still gets the serialized chain.
   */
  private async runSerializedTransaction<T>(
    db: DatabaseInterface,
    fn: (txDb: DatabaseInterface) => Promise<T>,
  ): Promise<T> {
    const capable = db as TransactionCapableDatabase;
    const runTx = () =>
      typeof capable.transaction === 'function'
        ? capable.transaction(fn)
        : fn(db);
    if (typeof capable.acquireSession === 'function') {
      return await runTx();
    }
    const previous =
      singleConnectionTransitionTails.get(db) ?? Promise.resolve();
    // Chain regardless of the predecessor's outcome — a failed transition
    // must not poison the queue behind it.
    const turn = previous.then(runTx, runTx);
    singleConnectionTransitionTails.set(
      db,
      turn.then(
        () => undefined,
        () => undefined,
      ),
    );
    return await turn;
  }

  /**
   * Unsettled adjustments for the earner/currency whose parent commission
   * is earned/approved/payable/paid — the same eligibility rule the balance
   * service applies, so batches settle exactly what balances report.
   *
   * When `parentPredicate` is given (a scoped batch), an adjustment is also
   * kept only when its parent commission satisfies the predicate — so a
   * source-scoped or explicit-id batch settles only its own adjustments.
   */
  private async findEligibleUnsettledAdjustments(
    earnerId: string,
    currency: string,
    parentPredicate?: (parent: Commission) => boolean,
  ) {
    const unsettled = await this.deps.adjustments.findUnsettledByEarner(
      earnerId,
      currency,
    );
    if (unsettled.length === 0) return unsettled;

    const parentIds = [
      ...new Set(unsettled.map((a) => a.commissionId).filter(Boolean)),
    ];
    const parents = await this.deps.commissions.listByIds(parentIds);
    const parentById = new Map<string, Commission>();
    for (const parent of parents) {
      if (parent.id) parentById.set(parent.id, parent);
    }
    const settleable =
      ADJUSTMENT_SETTLEABLE_COMMISSION_STATUSES as readonly CommissionStatus[];
    return unsettled.filter((adjustment) => {
      const parent = parentById.get(adjustment.commissionId);
      if (parent === undefined) return false;
      if (!settleable.includes(parent.status)) return false;
      if (parentPredicate && !parentPredicate(parent)) return false;
      return true;
    });
  }

  /**
   * The payable, unsettled commissions this batch would settle, honoring
   * the input scope: an explicit `commissionIds` set (each validated
   * payable + unsettled + belonging to this earner/currency), a single
   * `(sourceKind, sourceId)`, or — unscoped — the whole earner/currency.
   */
  private async gatherBatchCommissions(
    input: CreatePayoutBatchInput,
  ): Promise<Commission[]> {
    // A PRESENT `commissionIds` (even `[]`) is an explicit scope — an empty
    // list settles nothing, it must never fall through to the earner-wide
    // gather.
    if (input.commissionIds !== undefined) {
      // Drop empty / non-UUID ids before querying: `id` is a native `uuid`
      // column on Postgres/DuckDB, so a malformed value would abort the
      // whole `listByIds` query there (SQLite silently misses it). Every
      // real smrt id is a UUID, so a non-UUID id can't match a commission
      // anyway — filtering it here is exactly the documented "ineligible
      // ids are ignored" behavior, and stops one bad id failing the batch.
      const validIds = input.commissionIds.filter((id) =>
        CommissionPayoutService.UUID_RE.test(id),
      );
      if (validIds.length === 0) return [];
      const rows = await this.deps.commissions.listByIds(validIds);
      return rows.filter(
        (c) =>
          c.earnerId === input.earnerId &&
          c.currency === input.currency &&
          c.status === 'payable' &&
          !c.payoutId,
      );
    }
    const scope =
      input.sourceKind && input.sourceId
        ? { sourceKind: input.sourceKind, sourceId: input.sourceId }
        : undefined;
    return await this.deps.commissions.findPayableUnsettled(
      input.earnerId,
      input.currency,
      scope,
    );
  }

  /**
   * Parent-commission predicate that narrows eligible adjustments to the
   * batch scope: explicit-id batches keep adjustments whose parent is in
   * the requested id set (even a now-paid parent — a clawback is still
   * owed); source-scoped batches keep adjustments whose parent shares the
   * source; unscoped batches keep all (predicate `undefined`).
   */
  private static adjustmentParentPredicate(
    input: CreatePayoutBatchInput,
  ): ((parent: Commission) => boolean) | undefined {
    // A present `commissionIds` (even `[]`) scopes adjustments to that set;
    // an empty set matches nothing.
    if (input.commissionIds !== undefined) {
      const ids = new Set(input.commissionIds);
      return (parent) => !!parent.id && ids.has(parent.id);
    }
    if (input.sourceKind && input.sourceId) {
      const { sourceKind, sourceId } = input;
      return (parent) =>
        parent.sourceKind === sourceKind && parent.sourceId === sourceId;
    }
    return undefined;
  }

  /**
   * Validate the batch scope: `sourceKind`/`sourceId` are all-or-nothing
   * and mutually exclusive with `commissionIds`; an explicit `commissionIds`
   * batch requires its own `idempotencyKey` (no natural default exists).
   */
  private static assertScope(input: CreatePayoutBatchInput): void {
    // A PRESENT `commissionIds` is an explicit scope regardless of length —
    // an empty list is a valid "settle nothing" request, not an unscoped
    // batch. Guarding on presence (not length) is what makes a
    // dynamically-computed `[]` fail closed instead of settling the whole
    // earner.
    const hasIds = input.commissionIds !== undefined;
    // A source scope is INTENDED when either property is present. Detecting
    // presence (not truthiness) is what stops `{ sourceKind: '', sourceId:
    // '' }` from failing open into an earner-wide settlement — a
    // present-but-empty (or half-set) source is malformed, not "unscoped".
    const hasSource =
      input.sourceKind !== undefined || input.sourceId !== undefined;
    if (hasSource && (!input.sourceKind || !input.sourceId)) {
      throw new Error(
        'CommissionPayoutService.createPayoutBatch: sourceKind and sourceId must both be set and non-empty to scope by source',
      );
    }
    if (hasIds && hasSource) {
      throw new Error(
        'CommissionPayoutService.createPayoutBatch: commissionIds and sourceKind/sourceId are mutually exclusive',
      );
    }
    if (hasIds && !input.idempotencyKey) {
      throw new Error(
        'CommissionPayoutService.createPayoutBatch: an explicit commissionIds batch requires an idempotencyKey',
      );
    }
  }

  private async requirePayout(payoutId: string): Promise<CommissionPayout> {
    const payout = await this.deps.payouts.get({ id: payoutId });
    if (!payout) {
      throw new Error(
        `CommissionPayoutService: payout '${payoutId}' not found`,
      );
    }
    return payout;
  }

  /**
   * `${earnerId}:${currency}:${YYYY-MM-DD}` — or, when scoped by source, a
   * key that folds the source in so a per-network batch and the earner-wide
   * batch on the same day get distinct keys. `sourceKind`/`sourceId` are
   * unconstrained generic strings, so each is LENGTH-PREFIXED (`len:value`)
   * to keep the encoding unambiguous: a literal `:` inside a source string
   * can't make two different `(sourceKind, sourceId)` pairs collide (e.g.
   * `('a:b','c')` → `…:src:3:a:b:1:c:…` vs `('a','b:c')` → `…:src:1:a:3:b:c:…`).
   * See the input doc.
   */
  private static defaultIdempotencyKey(
    earnerId: string,
    currency: string,
    periodEnd: Date,
    scope?: { sourceKind: string; sourceId: string },
  ): string {
    const date = periodEnd.toISOString().slice(0, 10);
    if (scope) {
      const enc = (s: string) => `${s.length}:${s}`;
      return `${earnerId}:${currency}:src:${enc(scope.sourceKind)}:${enc(scope.sourceId)}:${date}`;
    }
    return `${earnerId}:${currency}:${date}`;
  }
}

export default CommissionPayoutService;
