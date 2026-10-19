/**
 * Publishing plan versions and pinning subscriptions to them (#4032).
 *
 * Kept out of the model files so `SubscriptionPlan` and `TenantSubscription`
 * share one implementation of the pin rules without importing each other.
 */
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import { SubscriptionPlanCollection } from './collections/SubscriptionPlanCollection.js';
import { SubscriptionPlanVersionCollection } from './collections/SubscriptionPlanVersionCollection.js';
import type { SubscriptionPlan } from './models/SubscriptionPlan.js';
import { SubscriptionPlanVersion } from './models/SubscriptionPlanVersion.js';
import type { TenantSubscription } from './models/TenantSubscription.js';
import {
  extractPlanTerms,
  isEntitlementUpgrade,
  samePlanTerms,
} from './plan-terms.js';
import type { PlanTerms, PlanVersionPinReason } from './types.js';

/** An in-period replacement requested through `replacePlanVersion()`. */
export interface PlanVersionReplacement {
  policy: 'upgrade' | 'authorized';
  reason?: string;
  planVersionId?: string;
}

/**
 * Version 1 for a plan that predates versioning: its current (persisted)
 * terms, effective from the plan's creation. Returns false when the plan
 * already has versions.
 */
export async function snapshotLegacyPlanVersion(
  plan: SubscriptionPlan,
): Promise<boolean> {
  if (!plan.id) return false;
  const versions = await SubscriptionPlanVersionCollection.create({
    db: plan.db,
  });
  const owner = plan.tenantId ?? null;
  const latest = await withSystemContext(() =>
    versions.findLatest(String(plan.id), owner),
  );
  if (latest) return false;
  await createVersion(plan, plan, 1, persistedCreatedAt(plan));
  return true;
}

/**
 * After a plan save, publish its terms as the next version when they differ
 * from the latest one (or when none exists). `prior` is the row the save
 * overwrote: when the plan had no versions yet, its terms become version 1,
 * effective from the plan's creation.
 */
export async function publishPlanVersion(
  plan: SubscriptionPlan,
  effectiveFrom: Date,
  prior?: SubscriptionPlan,
): Promise<SubscriptionPlanVersion> {
  const versions = await SubscriptionPlanVersionCollection.create({
    db: plan.db,
  });
  const owner = plan.tenantId ?? null;
  let latest = await withSystemContext(() =>
    versions.findLatest(String(plan.id), owner),
  );
  if (!latest && prior && String(prior.id) === String(plan.id)) {
    latest = await createVersion(plan, prior, 1, persistedCreatedAt(prior));
  }
  if (latest && samePlanTerms(latest, plan)) return latest;
  return createVersion(plan, plan, (latest?.version ?? 0) + 1, effectiveFrom);
}

async function createVersion(
  plan: SubscriptionPlan,
  terms: PlanTerms,
  version: number,
  effectiveFrom: Date,
): Promise<SubscriptionPlanVersion> {
  const record = new SubscriptionPlanVersion({
    db: plan.db,
    tenantId: plan.tenantId ?? null,
    planId: String(plan.id),
    planKey: plan.planKey,
    name: plan.name,
    version,
    effectiveFrom,
    ...extractPlanTerms(terms),
  });
  await record.initialize();
  await record.save();
  return record;
}

function persistedCreatedAt(plan: SubscriptionPlan): Date {
  const created = plan.created_at ? new Date(plan.created_at) : null;
  return created && !Number.isNaN(created.getTime()) ? created : new Date(0);
}

/**
 * Bind a subscription to the plan version its current period paid for.
 * Called from `TenantSubscription.validateBeforeSave()`.
 *
 * - A new subscription, or a legacy row without a pin, pins the version in
 *   force at its period start (`currentPeriodStart ?? startedAt`).
 * - A renewal re-pins the version in force at the new boundary, for the
 *   (possibly changed) plan. A save is a renewal only when the new period
 *   starts at or after the stored `currentPeriodEnd` (or, without one, after
 *   the stored start); moving the start within a paid period is not.
 * - At creation and renewal the boundary decides the version: a caller may
 *   name only that version, unless the save is an authorized replacement.
 * - Within a paid period, a different plan or version is accepted only when
 *   it is an entitlement upgrade of the frozen terms, when the period no
 *   longer entitles, or through an explicit authorized replacement.
 *
 * A plan without versions (an unmigrated legacy plan) leaves the pin empty;
 * resolution then falls back to the live plan.
 */
export async function pinSubscriptionPlanVersion(
  subscription: TenantSubscription,
  persisted: TenantSubscription | null,
  replacement: PlanVersionReplacement | undefined,
  now = new Date(),
): Promise<void> {
  const versions = await SubscriptionPlanVersionCollection.create({
    db: subscription.db,
  });
  const boundary = periodBoundary(subscription);
  const requested =
    subscription.planVersionId &&
    subscription.planVersionId !== (persisted?.planVersionId ?? null)
      ? subscription.planVersionId
      : replacement?.planVersionId;
  const authorizedReason =
    replacement?.policy === 'authorized' ? replacement.reason?.trim() : '';
  if (replacement?.policy === 'authorized' && !authorizedReason) {
    throw new Error('An authorized plan version replacement needs a reason');
  }
  const pin = (
    version: SubscriptionPlanVersion | null,
    reason: PlanVersionPinReason,
    note = '',
  ) => {
    subscription.planVersionId = version?.id ? String(version.id) : null;
    subscription.planVersionPinnedAt = version ? now : null;
    subscription.planVersionPinReason = version ? reason : null;
    subscription.planVersionPinNote = version ? note : '';
  };
  const load = async (id: string) => {
    const version = await loadVersion(versions, id);
    if (!version) throw new Error('Plan version is unavailable');
    if (version.planId !== subscription.planId) {
      throw new Error('Plan version does not belong to the subscription plan');
    }
    return version;
  };
  // Creation and renewal: the version in force at the boundary.
  const atBoundary = async (reason: PlanVersionPinReason) => {
    const inForce = await versions.findInForce(subscription.planId, boundary);
    if (requested && requested !== inForce?.id) {
      const chosen = await load(requested);
      if (!authorizedReason) {
        throw new Error(
          'A period pins the plan version in force at its start; pinning ' +
            "another version needs replacePlanVersion({ policy: 'authorized', reason }).",
        );
      }
      pin(chosen, 'authorized', authorizedReason);
      return;
    }
    if (authorizedReason && inForce) {
      pin(inForce, 'authorized', authorizedReason);
      return;
    }
    pin(inForce, reason);
  };

  if (!persisted) {
    await atBoundary('period_start');
    return;
  }
  if (isRenewal(persisted, boundary)) {
    await atBoundary('renewal');
    // Saved ahead of its start, a renewal must not change what the still
    // running paid period resolves to: allow it only when the pin is
    // unchanged, the change is an upgrade, or it was authorized.
    if (
      boundary.getTime() > now.getTime() &&
      !authorizedReason &&
      persisted.isEntitled(now) &&
      subscription.planVersionId !== persisted.planVersionId
    ) {
      const frozen = await frozenTerms(
        versions,
        persisted,
        periodBoundary(persisted),
      );
      const target: PlanTerms | null = subscription.planVersionId
        ? await loadVersion(versions, subscription.planVersionId)
        : await (
            await SubscriptionPlanCollection.create({ db: subscription.db })
          ).get({ id: subscription.planId }, { cache: false });
      if (frozen && (!target || !isEntitlementUpgrade(frozen, target))) {
        throw new Error(
          'A renewal that changes plan terms can be saved once its period ' +
            'has started; the current paid period keeps its terms until then.',
        );
      }
    }
    return;
  }
  const planChanged = persisted.planId !== subscription.planId;
  if (!planChanged && !requested && !replacement) {
    if (!persisted.planVersionId) {
      // A row written before versioning: pin what its period was sold under.
      pin(
        await versions.findInForce(subscription.planId, boundary),
        'migration',
      );
      return;
    }
    // Nothing moved: keep the pin and its audit trail exactly as stored.
    subscription.planVersionId = persisted.planVersionId;
    subscription.planVersionPinnedAt = persisted.planVersionPinnedAt;
    subscription.planVersionPinReason = persisted.planVersionPinReason;
    subscription.planVersionPinNote = persisted.planVersionPinNote;
    return;
  }

  // An in-period change: the target is the named version, else the version
  // of the (new) plan in force now, else that plan's live terms.
  const next = requested
    ? await load(requested)
    : await versions.findInForce(subscription.planId, now);
  if (authorizedReason) {
    pin(next, 'authorized', authorizedReason);
    return;
  }
  if (!persisted.isEntitled(now)) {
    pin(next, 'period_start');
    return;
  }
  const target: PlanTerms | null =
    next ??
    (await (
      await SubscriptionPlanCollection.create({ db: subscription.db })
    ).get({ id: subscription.planId }, { cache: false }));
  const frozen = await frozenTerms(versions, persisted, boundary);
  if (frozen && (!target || !isEntitlementUpgrade(frozen, target))) {
    throw new Error(
      'This plan change would remove entitlements from a paid period. It ' +
        'takes effect at renewal (a new period starting at or after ' +
        "currentPeriodEnd), or through replacePlanVersion({ policy: 'authorized', reason }).",
    );
  }
  pin(next, 'upgrade', replacement?.reason?.trim() ?? '');
}

/**
 * Whether moving to `boundary` starts a new period: at or after the stored
 * period end, or — for an open-ended row — after the stored start.
 */
function isRenewal(persisted: TenantSubscription, boundary: Date): boolean {
  const previous = periodBoundary(persisted).getTime();
  if (boundary.getTime() === previous) return false;
  const end = persisted.currentPeriodEnd
    ? new Date(persisted.currentPeriodEnd).getTime()
    : null;
  return end === null
    ? boundary.getTime() > previous
    : boundary.getTime() >= end;
}

/** The terms the persisted subscription's current period paid for. */
async function frozenTerms(
  versions: SubscriptionPlanVersionCollection,
  persisted: TenantSubscription,
  boundary: Date,
): Promise<PlanTerms | null> {
  if (persisted.planVersionId) {
    const pinned = await loadVersion(versions, persisted.planVersionId);
    if (pinned) return pinned;
  }
  const inForce = await versions.findInForce(persisted.planId, boundary);
  if (inForce) return inForce;
  const plans = await SubscriptionPlanCollection.create({
    db: persisted.db,
  });
  return plans.get({ id: persisted.planId }, { cache: false });
}

async function loadVersion(
  versions: SubscriptionPlanVersionCollection,
  id: string,
): Promise<SubscriptionPlanVersion | null> {
  return versions.findVisibleById(id);
}

/** Start of a subscription's current period. */
export function periodBoundary(
  subscription: Pick<TenantSubscription, 'currentPeriodStart' | 'startedAt'>,
): Date {
  return new Date(subscription.currentPeriodStart ?? subscription.startedAt);
}
