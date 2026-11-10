/**
 * Apply verified provider facts to `TenantSubscription` (#4786).
 *
 * Runs inside the idempotency transaction, so every read and write here uses
 * the transaction handle it is given. Provider ids link a subscription to
 * exactly one tenant; an event that disagrees with an existing link is
 * refused (and reported), never merged.
 *
 * Out-of-order delivery converges because each applied event records its
 * provider `created` time on the row and an older event is skipped; a
 * cancellation also wins a same-second tie. A plan change is applied as an
 * authorised plan-version replacement so a downgrade made in the provider is
 * honoured mid-period (the provider, which billed it, is the authority) while
 * the pinning audit trail records why.
 */
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import type { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import type { TenantSubscription } from '../models/TenantSubscription.js';
import type { JsonObject, SubscriptionStatus } from '../types.js';
import { CHECKOUT_COMPLETED, type SubscriptionSnapshot } from './events.js';
import { PlanDirectory } from './plans.js';
import type { BillingLogger } from './types.js';

/** JSON-safe result stored with the idempotency claim and replayed. */
export interface AppliedOutcome {
  action: 'applied' | 'ignored' | 'needs_reconciliation';
  reason?: string;
}

export interface ApplyContext {
  db: DatabaseInterface;
  tenantPlans: 'deny' | 'allow';
  /** PostgreSQL: serialize concurrent events for one subscription or tenant. */
  postgres: boolean;
  prices: Record<string, string> | undefined;
  logger: BillingLogger | undefined;
}

interface EventFacts {
  eventId: string;
  eventType: string;
  /** The provider's own event time (whole seconds). */
  eventCreated: Date;
  /** When the snapshot was read, if it was read rather than delivered. */
  observedAt?: Date;
}

const ENTITLEMENT_CLAIMING = new Set([
  'active',
  'trialing',
  'past_due',
  'unpaid',
]);

/**
 * Serialize applies that touch the same provider subscription or tenant on
 * PostgreSQL, where two transactions can otherwise both read the row before
 * either writes and let an older event overwrite a newer one. Transaction-
 * scoped, taken in sorted order. Embedded engines already have one writer.
 */
export async function lockBillingKeys(
  ctx: Pick<ApplyContext, 'db' | 'postgres'>,
  keys: string[],
): Promise<void> {
  if (!ctx.postgres) return;
  for (const key of [...new Set(keys)].sort()) {
    await ctx.db.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `smrt-subscriptions:billing:${key}`,
    );
  }
}

function ignored(
  ctx: ApplyContext,
  facts: EventFacts,
  reason: string,
  fields: Record<string, unknown> = {},
): AppliedOutcome {
  ctx.logger?.warn?.('billing.event.ignored', {
    eventId: facts.eventId,
    eventType: facts.eventType,
    reason,
    ...fields,
  });
  return { action: 'ignored', reason };
}

interface LastApplied {
  eventId?: string;
  at?: Date;
  terminal: boolean;
}

function readLastApplied(row: TenantSubscription): LastApplied {
  const stripe = row.getMetadata().stripe;
  if (!stripe || typeof stripe !== 'object' || Array.isArray(stripe)) {
    return { terminal: false };
  }
  const block = stripe as JsonObject;
  const at =
    typeof block.lastEventAt === 'string' ? new Date(block.lastEventAt) : null;
  return {
    eventId:
      typeof block.lastEventId === 'string' ? block.lastEventId : undefined,
    at: at && Number.isFinite(at.getTime()) ? at : undefined,
    terminal: block.terminal === true,
  };
}

/** The price the row was last granted for (`metadata.stripe.priceId`). */
function readRecordedPrice(row: TenantSubscription): string | undefined {
  const stripe = row.getMetadata().stripe;
  if (!stripe || typeof stripe !== 'object' || Array.isArray(stripe)) {
    return undefined;
  }
  const price = (stripe as JsonObject).priceId;
  return typeof price === 'string' && price ? price : undefined;
}

/**
 * A row held for an unmapped price still has a live provider subscription
 * (`metadata.stripe.held`): checkout must not sell a second one over it.
 */
export function isHeldSubscription(row: TenantSubscription): boolean {
  const stripe = row.getMetadata().stripe;
  return (
    row.status !== 'canceled' &&
    !!stripe &&
    typeof stripe === 'object' &&
    !Array.isArray(stripe) &&
    (stripe as JsonObject).held === HELD_PRICE_UNMAPPED
  );
}

const HELD_PRICE_UNMAPPED = 'price_unmapped';

/** Entitling statuses become `incomplete` while an unmapped price is held. */
const HELD_STATUS: Partial<Record<SubscriptionStatus, SubscriptionStatus>> = {
  active: 'incomplete',
  trialing: 'incomplete',
  past_due: 'incomplete',
};

function isStale(last: LastApplied, facts: EventFacts): boolean {
  if (last.eventId && last.eventId === facts.eventId) return true;
  if (!last.at) return false;
  const delta = facts.eventCreated.getTime() - last.at.getTime();
  if (delta < 0) return true;
  // Events carry whole-second times; a cancellation wins a same-second tie.
  return delta === 0 && last.terminal && facts.eventType !== CHECKOUT_COMPLETED;
}

function stripeMetadata(
  row: TenantSubscription | null,
  facts: EventFacts,
  snapshot: SubscriptionSnapshot,
  planKey: string,
  resetProvider: boolean,
  held = false,
): JsonObject {
  const base = row ? row.getMetadata() : {};
  // A different provider subscription starts its own event history.
  const prior =
    !resetProvider &&
    base.stripe &&
    typeof base.stripe === 'object' &&
    !Array.isArray(base.stripe)
      ? (base.stripe as JsonObject)
      : {};
  const observed = facts.observedAt
    ? new Date(Math.floor(facts.observedAt.getTime() / 1000) * 1000)
    : undefined;
  const at =
    observed && observed.getTime() > facts.eventCreated.getTime()
      ? observed
      : facts.eventCreated;
  const { held: _previouslyHeld, ...carried } = prior;
  return {
    ...base,
    planKey,
    stripe: {
      ...carried,
      ...(held ? { held: HELD_PRICE_UNMAPPED } : {}),
      lastEventId: facts.eventId,
      lastEventType: facts.eventType,
      lastEventAt: at.toISOString(),
      priceId:
        snapshot.priceId ?? (prior.priceId as string | undefined) ?? null,
      terminal: snapshot.status === 'canceled',
    },
  };
}

async function listRows(
  db: DatabaseInterface,
  where: Record<string, unknown>,
): Promise<TenantSubscription[]> {
  const subscriptions = await TenantSubscriptionCollection.create({ db });
  return subscriptions.list({ where, limit: 3 });
}

function dateOrKeep(
  next: Date | null | undefined,
  current: Date | null | undefined,
): Date | null {
  return next !== undefined ? next : (current ?? null);
}

interface RowWrite {
  tenantId: string;
  existing: TenantSubscription | null;
  plan: SubscriptionPlan;
  snapshot: SubscriptionSnapshot;
  facts: EventFacts;
  checkoutSessionId?: string;
  /** The row is held for an unmapped price (see `isHeldSubscription`). */
  held?: boolean;
}

async function writeRow(
  ctx: ApplyContext,
  write: RowWrite,
): Promise<AppliedOutcome> {
  const { existing, plan, snapshot, facts } = write;
  const planId = String(plan.id);
  const newSubscription =
    !existing || existing.stripeSubscriptionId !== snapshot.subscriptionId;
  const base = newSubscription ? null : existing;

  let periodEnd = dateOrKeep(snapshot.currentPeriodEnd, base?.currentPeriodEnd);
  if (snapshot.status === 'canceled') {
    // Cancellation ends access when it happened, not at the paid-through date
    // of an immediately cancelled subscription, and never later than now (a
    // provider timestamp ahead of this clock must not extend access).
    const endedAt = new Date(
      Math.min(
        (
          snapshot.endedAt ??
          snapshot.canceledAt ??
          facts.eventCreated
        ).getTime(),
        Date.now(),
      ),
    );
    if (!periodEnd || periodEnd.getTime() > endedAt.getTime()) {
      periodEnd = endedAt;
    }
  }
  const fields = {
    status: snapshot.status,
    startedAt: snapshot.startedAt ?? base?.startedAt ?? facts.eventCreated,
    currentPeriodStart: dateOrKeep(
      snapshot.currentPeriodStart,
      base?.currentPeriodStart,
    ),
    currentPeriodEnd: periodEnd,
    trialEndsAt: dateOrKeep(snapshot.trialEndsAt, base?.trialEndsAt),
    cancelAtPeriodEnd:
      snapshot.cancelAtPeriodEnd ?? base?.cancelAtPeriodEnd ?? false,
    canceledAt:
      snapshot.canceledAt !== undefined
        ? snapshot.canceledAt
        : snapshot.status === 'canceled'
          ? (base?.canceledAt ?? facts.eventCreated)
          : (base?.canceledAt ?? null),
    externalProvider: 'stripe',
    stripeCustomerId: snapshot.customerId,
    stripeSubscriptionId: snapshot.subscriptionId,
    stripeCheckoutSessionId:
      write.checkoutSessionId ?? base?.stripeCheckoutSessionId ?? '',
  };

  const subscriptions = await TenantSubscriptionCollection.create({
    db: ctx.db,
  });
  let row: TenantSubscription;
  if (existing) {
    Object.assign(existing, fields);
    existing.setMetadata(
      stripeMetadata(
        existing,
        facts,
        snapshot,
        plan.planKey,
        newSubscription,
        write.held,
      ),
    );
    if (existing.planId !== planId) {
      await existing.replacePlanVersion({
        planId,
        policy: 'authorized',
        reason: `stripe:${facts.eventId}`,
      });
    } else {
      await existing.save();
    }
    row = existing;
  } else {
    row = await subscriptions.create({
      tenantId: write.tenantId,
      subscriberKind: 'tenant',
      subscriberExternalId: '',
      planId,
      ...fields,
      metadata: JSON.stringify(
        stripeMetadata(null, facts, snapshot, plan.planKey, true),
      ),
    });
  }
  ctx.logger?.info?.('billing.subscription.applied', {
    eventId: facts.eventId,
    eventType: facts.eventType,
    tenantId: write.tenantId,
    subscriptionRowId: String(row.id),
    planKey: plan.planKey,
    status: snapshot.status,
  });
  return { action: 'applied' };
}

/** A `customer.subscription.*` event for an already-linked subscription. */
export async function applySubscriptionEvent(
  ctx: ApplyContext,
  facts: EventFacts,
  snapshot: SubscriptionSnapshot,
): Promise<AppliedOutcome> {
  return withSystemContext(async () => {
    await lockBillingKeys(ctx, [`subscription:${snapshot.subscriptionId}`]);
    const linked = await listRows(ctx.db, {
      stripeSubscriptionId: snapshot.subscriptionId,
    });
    if (linked.length === 0) {
      // Not ours (or its checkout has not landed; the checkout event reads
      // the subscription back, so nothing is lost by not guessing here).
      return ignored(ctx, facts, 'unlinked_subscription');
    }
    if (linked.length > 1) return ignored(ctx, facts, 'ambiguous_subscription');
    const tenantId = String((linked[0] as TenantSubscription).tenantId);
    // A checkout for the same tenant locks the tenant too; take it, then read
    // the row again so the staleness decision sees the committed state.
    await lockBillingKeys(ctx, [
      `subscription:${snapshot.subscriptionId}`,
      `tenant:${tenantId}`,
    ]);
    const current = await listRows(ctx.db, {
      stripeSubscriptionId: snapshot.subscriptionId,
    });
    if (current.length !== 1 || current[0]?.tenantId !== tenantId) {
      return ignored(ctx, facts, 'unlinked_subscription');
    }
    const row = current[0] as TenantSubscription;
    if (row.stripeCustomerId && row.stripeCustomerId !== snapshot.customerId) {
      return ignored(ctx, facts, 'customer_mismatch', { tenantId });
    }
    if (isStale(readLastApplied(row), facts)) {
      return ignored(ctx, facts, 'stale_event', { tenantId });
    }

    const directory = new PlanDirectory(ctx.db, ctx.prices, ctx.tenantPlans);
    const priced = snapshot.priceId
      ? await directory.findByPriceId(tenantId, snapshot.priceId)
      : null;
    const plan = priced ?? (await directory.findExisting(tenantId, row.planId));
    if (!plan) throw new Error('The subscription plan could not be resolved.');
    if (!priced && snapshot.priceId) {
      const recorded = readRecordedPrice(row);
      if (snapshot.priceId !== recorded) {
        // The provider bills a price this host cannot map and it is not the
        // one the row was granted for: the previous plan's entitlements must
        // not carry over to an unknown product. Hold (non-entitling status,
        // plan and recorded price untouched) until the mapping is fixed or
        // the price returns, so every later event is held too.
        ctx.logger?.error?.('billing.price.unmapped_held', {
          eventId: facts.eventId,
          tenantId,
          providerStatus: snapshot.status,
        });
        return writeRow(ctx, {
          tenantId,
          existing: row,
          plan,
          snapshot: {
            ...snapshot,
            status: HELD_STATUS[snapshot.status] ?? snapshot.status,
            priceId: recorded,
          },
          facts,
          // A cancelled subscription is not billing: nothing left to protect.
          held: snapshot.status !== 'canceled',
        });
      }
      ctx.logger?.warn?.('billing.price.unmapped', {
        eventId: facts.eventId,
        tenantId,
      });
    }
    return writeRow(ctx, { tenantId, existing: row, plan, snapshot, facts });
  });
}

export interface CheckoutLink {
  tenantId: string;
  planId: string;
  checkoutSessionId: string;
}

/**
 * A completed Checkout whose signed metadata names the tenant and plan. The
 * snapshot is the subscription read back from the provider after the event,
 * so the row reflects current state however the events were ordered.
 */
export async function applyCheckoutCompleted(
  ctx: ApplyContext,
  facts: EventFacts,
  link: CheckoutLink,
  snapshot: SubscriptionSnapshot,
): Promise<AppliedOutcome> {
  return withSystemContext(async () => {
    const { tenantId } = link;
    await lockBillingKeys(ctx, [
      `subscription:${snapshot.subscriptionId}`,
      `tenant:${tenantId}`,
    ]);
    const bySubscription = await listRows(ctx.db, {
      stripeSubscriptionId: snapshot.subscriptionId,
    });
    const byCustomer = await listRows(ctx.db, {
      stripeCustomerId: snapshot.customerId,
    });
    const foreign = [...bySubscription, ...byCustomer].some(
      (row) => row.tenantId !== tenantId,
    );
    if (foreign) {
      return ignored(ctx, facts, 'tenant_mismatch', { tenantId });
    }
    if (bySubscription.length > 1) {
      return ignored(ctx, facts, 'ambiguous_subscription', { tenantId });
    }
    const ownRows = await listRows(ctx.db, {
      tenantId,
      subscriberKind: 'tenant',
    });
    const existing = bySubscription[0] ?? ownRows[0] ?? null;
    if (
      existing?.stripeSubscriptionId &&
      existing.stripeSubscriptionId !== snapshot.subscriptionId &&
      (ENTITLEMENT_CLAIMING.has(existing.status) ||
        isHeldSubscription(existing))
    ) {
      // The buyer paid for a second subscription that is not tracked. Cancel
      // or refund it at the provider: this is an operator alert, not noise.
      if (ENTITLEMENT_CLAIMING.has(snapshot.status)) {
        ctx.logger?.error?.('billing.checkout.orphaned_subscription', {
          eventId: facts.eventId,
          tenantId,
          subscriptionId: snapshot.subscriptionId,
        });
      }
      return ignored(ctx, facts, 'already_subscribed', { tenantId });
    }
    if (
      existing &&
      existing.stripeSubscriptionId === snapshot.subscriptionId &&
      isStale(readLastApplied(existing), facts)
    ) {
      return ignored(ctx, facts, 'stale_event', { tenantId });
    }

    const directory = new PlanDirectory(ctx.db, ctx.prices, ctx.tenantPlans);
    const priced = snapshot.priceId
      ? await directory.findByPriceId(tenantId, snapshot.priceId)
      : null;
    const named = await directory.find(tenantId, { planId: link.planId });
    if (priced && named && priced.id !== named.id) {
      ctx.logger?.warn?.('billing.checkout.plan_price_disagree', {
        eventId: facts.eventId,
        tenantId,
      });
    }
    // What the provider bills is what the tenant has; the signed metadata
    // names the intent and covers a price the host never mapped.
    const plan = priced ?? named;
    if (!plan) throw new Error('The checkout plan could not be resolved.');
    return writeRow(ctx, {
      tenantId,
      existing,
      plan,
      snapshot,
      facts,
      checkoutSessionId: link.checkoutSessionId,
    });
  });
}
