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
 * - Moving `currentPeriodStart` is a renewal: it re-pins the version in force
 *   at the new boundary, for the (possibly changed) plan.
 * - Within an unchanged period, a different plan or version is accepted only
 *   when it is an entitlement upgrade of the frozen version, when the period
 *   no longer entitles, or through an explicit authorized replacement.
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
  const target = async (at: Date) => {
    const version = requested
      ? await loadVersion(versions, requested)
      : await versions.findInForce(subscription.planId, at);
    if (version && version.planId !== subscription.planId) {
      throw new Error('Plan version does not belong to the subscription plan');
    }
    if (requested && !version) throw new Error('Plan version is unavailable');
    return version;
  };

  if (!persisted) {
    pin(await target(boundary), 'period_start');
    return;
  }
  if (periodBoundary(persisted).getTime() !== boundary.getTime()) {
    pin(await target(boundary), 'renewal');
    return;
  }
  const planChanged = persisted.planId !== subscription.planId;
  if (!planChanged && !requested && !replacement) {
    // A row written before versioning: pin what its period was sold under.
    if (!persisted.planVersionId) {
      pin(await target(boundary), 'migration');
      return;
    }
    // Nothing moved: keep the pin and its audit trail exactly as stored.
    subscription.planVersionId = persisted.planVersionId;
    subscription.planVersionPinnedAt = persisted.planVersionPinnedAt;
    subscription.planVersionPinReason = persisted.planVersionPinReason;
    subscription.planVersionPinNote = persisted.planVersionPinNote;
    return;
  }

  const next = await target(now);
  if (!next) {
    pin(null, 'period_start');
    return;
  }
  if (replacement?.policy === 'authorized') {
    const reason = replacement.reason?.trim() ?? '';
    if (!reason) {
      throw new Error('An authorized plan version replacement needs a reason');
    }
    pin(next, 'authorized', reason);
    return;
  }
  if (!persisted.isEntitled(now)) {
    pin(next, 'period_start');
    return;
  }
  const frozen = await frozenTerms(versions, persisted, boundary);
  if (frozen && !isEntitlementUpgrade(frozen, next)) {
    throw new Error(
      'This plan change would remove entitlements from a paid period. It ' +
        'takes effect at renewal (when currentPeriodStart moves), or through ' +
        "replacePlanVersion({ policy: 'authorized', reason }).",
    );
  }
  pin(next, 'upgrade', replacement?.reason?.trim() ?? '');
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
  const scoped = await versions.get({ id }, { cache: false });
  if (scoped) return scoped;
  return withSystemContext(() =>
    versions.get({ id, tenantId: null }, { cache: false }),
  );
}

/** Start of a subscription's current period. */
export function periodBoundary(
  subscription: Pick<TenantSubscription, 'currentPeriodStart' | 'startedAt'>,
): Date {
  return new Date(subscription.currentPeriodStart ?? subscription.startedAt);
}
