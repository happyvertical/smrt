/**
 * Binding a completed Checkout to the session the host created (#4814).
 *
 * The signed metadata alone is copyable: another integration on the same
 * Stripe account can put it on its own session and pay first. So the host
 * records each session id when it creates the session, and a paid session
 * links a tenant only when a pending record for exactly that id names the
 * same tenant and the signed expiry has not passed at the event time.
 * Anything else is never linked and never dropped: the paid session is
 * recorded as `needs_reconciliation` for an operator.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type BillingCheckoutSession,
  BillingCheckoutSessionCollection,
} from '../models/BillingCheckoutSession.js';
import {
  type AppliedOutcome,
  type ApplyContext,
  applyCheckoutCompleted,
  lockBillingKeys,
} from './apply.js';
import { CHECKOUT_COMPLETED, type SubscriptionSnapshot } from './events.js';

/** Signed metadata key holding the expiry, in whole epoch seconds. */
export const METADATA_EXPIRY_KEY = 'smrt_exp';
/**
 * Stripe expires a Checkout session after 24 hours; the host allows an hour
 * more. The expiry is checked against the event time, not the delivery time,
 * so a late webhook retry of an in-time payment still completes.
 */
export const CHECKOUT_SESSION_TTL_MS = 25 * 60 * 60 * 1000;

export type CheckoutRefusal =
  | 'session_record_missing'
  | 'session_record_mismatch'
  | 'session_expired';

type Verdict =
  | { kind: 'bound' }
  | { kind: 'replay'; reason: string }
  | { kind: 'reconcile'; reason: CheckoutRefusal };

/** The binding rules, in order. Pure: no I/O. */
export function checkBinding(
  record: BillingCheckoutSession | null,
  input: { tenantId: string; exp: string | undefined; eventTime: Date },
): Verdict {
  if (!record) return { kind: 'reconcile', reason: 'session_record_missing' };
  if (record.status === 'completed') {
    return { kind: 'replay', reason: 'session_already_completed' };
  }
  if (record.status === 'needs_reconciliation') {
    return { kind: 'replay', reason: 'session_needs_reconciliation' };
  }
  if (record.targetTenantId !== input.tenantId) {
    return { kind: 'reconcile', reason: 'session_record_mismatch' };
  }
  if (!input.exp || !/^\d{1,12}$/.test(input.exp)) {
    return { kind: 'reconcile', reason: 'session_record_mismatch' };
  }
  const at = input.eventTime.getTime();
  if (
    at > Number.parseInt(input.exp, 10) * 1000 ||
    at > new Date(record.expiresAt).getTime()
  ) {
    return { kind: 'reconcile', reason: 'session_expired' };
  }
  return { kind: 'bound' };
}

/** Record a session the host just created. Idempotent per session id. */
export async function recordCheckoutSession(
  db: DatabaseInterface,
  input: { sessionId: string; tenantId: string; expiresAt: Date },
): Promise<void> {
  const sessions = await BillingCheckoutSessionCollection.create({ db });
  if (await sessions.get({ sessionId: input.sessionId })) return;
  try {
    await sessions.create({
      sessionId: input.sessionId,
      targetTenantId: input.tenantId,
      status: 'pending',
      expiresAt: input.expiresAt,
    });
  } catch (error) {
    // A concurrent identical request recorded it first.
    if (!(await sessions.get({ sessionId: input.sessionId }))) throw error;
  }
}

export interface ReconcileContext {
  eventId: string;
  eventCreated: string;
  subscriptionId: string;
  customerId: string;
  planId: string;
  claimedTenantId: string;
}

export function parseReconcileContext(
  record: BillingCheckoutSession,
): ReconcileContext | null {
  try {
    const value = JSON.parse(record.detail) as Record<string, unknown>;
    const text = (key: string) =>
      typeof value[key] === 'string' ? (value[key] as string) : '';
    const parsed = {
      eventId: text('eventId'),
      eventCreated: text('eventCreated'),
      subscriptionId: text('subscriptionId'),
      customerId: text('customerId'),
      planId: text('planId'),
      claimedTenantId: text('claimedTenantId'),
    };
    return parsed.subscriptionId &&
      parsed.customerId &&
      Number.isFinite(Date.parse(parsed.eventCreated))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export interface BoundCompletion {
  sessionId: string;
  /** From the verified signed metadata. */
  tenantId: string;
  planId: string;
  exp: string | undefined;
  eventId: string;
  eventTime: Date;
}

/**
 * Inside the idempotency transaction: bind the paid session to its record,
 * then link the tenant. `ctx.db` is the transaction handle.
 */
export async function completeBoundCheckout(
  ctx: ApplyContext,
  input: BoundCompletion,
  facts: Parameters<typeof applyCheckoutCompleted>[1],
  snapshot: SubscriptionSnapshot,
): Promise<AppliedOutcome> {
  await lockBillingKeys(ctx, [`checkout:${input.sessionId}`]);
  const sessions = await BillingCheckoutSessionCollection.create({
    db: ctx.db,
  });
  const record = await sessions.get({ sessionId: input.sessionId });
  const verdict = checkBinding(record, input);

  if (verdict.kind === 'replay') {
    ctx.logger?.warn?.('billing.checkout.not_relinked', {
      eventId: input.eventId,
      sessionId: input.sessionId,
      reason: verdict.reason,
    });
    return { action: 'ignored', reason: verdict.reason };
  }
  if (verdict.kind === 'reconcile') {
    const context: ReconcileContext = {
      eventId: input.eventId,
      eventCreated: input.eventTime.toISOString(),
      subscriptionId: snapshot.subscriptionId,
      customerId: snapshot.customerId,
      planId: input.planId,
      claimedTenantId: input.tenantId,
    };
    if (record) {
      record.status = 'needs_reconciliation';
      record.reason = verdict.reason;
      record.detail = JSON.stringify(context);
      await record.save();
    } else {
      await sessions.create({
        sessionId: input.sessionId,
        targetTenantId: '',
        status: 'needs_reconciliation',
        expiresAt: input.eventTime,
        reason: verdict.reason,
        detail: JSON.stringify(context),
      });
    }
    // A paid purchase nobody has linked: loud, with codes and ids only.
    ctx.logger?.error?.('billing.checkout.needs_reconciliation', {
      eventId: input.eventId,
      sessionId: input.sessionId,
      reason: verdict.reason,
      claimedTenantId: input.tenantId,
      subscriptionId: snapshot.subscriptionId,
    });
    return { action: 'needs_reconciliation', reason: verdict.reason };
  }

  const outcome = await applyCheckoutCompleted(
    ctx,
    facts,
    {
      tenantId: input.tenantId,
      planId: input.planId,
      checkoutSessionId: input.sessionId,
    },
    snapshot,
  );
  if (outcome.action === 'applied' && record) {
    record.status = 'completed';
    record.completedAt = new Date();
    await record.save();
  }
  return outcome;
}

/** A flagged session and the ids captured when it was flagged. */
export async function loadFlaggedCheckout(
  db: DatabaseInterface,
  sessionId: string,
): Promise<{
  record: BillingCheckoutSession;
  flagged: ReconcileContext;
} | null> {
  const sessions = await BillingCheckoutSessionCollection.create({ db });
  const record = await sessions.get({ sessionId });
  if (record?.status !== 'needs_reconciliation') return null;
  const flagged = parseReconcileContext(record);
  return flagged ? { record, flagged } : null;
}

/**
 * Operator action, inside one transaction (`ctx.db`): link a flagged paid
 * session to `tenantId` on purpose. `snapshot` is the subscription read back
 * from the provider before the transaction; it must still be the one recorded
 * when the session was flagged. The row is re-read under the lock, so a
 * session is reconciled at most once.
 */
export async function reconcileFlaggedCheckout(
  ctx: ApplyContext,
  input: {
    sessionId: string;
    tenantId: string;
    planId?: string;
    operatorId: string;
    snapshot: SubscriptionSnapshot;
  },
): Promise<AppliedOutcome | null> {
  await lockBillingKeys(ctx, [`checkout:${input.sessionId}`]);
  const loaded = await loadFlaggedCheckout(ctx.db, input.sessionId);
  const planId = input.planId ?? loaded?.flagged.planId;
  if (!loaded || !planId) return null;
  const { record, flagged } = loaded;
  if (
    input.snapshot.subscriptionId !== flagged.subscriptionId ||
    input.snapshot.customerId !== flagged.customerId
  ) {
    return { action: 'ignored', reason: 'checkout_subscription_mismatch' };
  }
  const outcome = await applyCheckoutCompleted(
    ctx,
    {
      eventId: `reconcile:${input.sessionId}`,
      eventType: CHECKOUT_COMPLETED,
      eventCreated: new Date(flagged.eventCreated),
      observedAt: new Date(),
    },
    {
      tenantId: input.tenantId,
      planId,
      checkoutSessionId: input.sessionId,
    },
    input.snapshot,
  );
  if (outcome.action === 'applied') {
    record.status = 'completed';
    record.targetTenantId = input.tenantId;
    record.reason = 'reconciled';
    record.completedAt = new Date();
    await record.save();
    ctx.logger?.warn?.('billing.checkout.reconciled', {
      sessionId: input.sessionId,
      tenantId: input.tenantId,
      operatorId: input.operatorId,
      subscriptionId: flagged.subscriptionId,
    });
  }
  return outcome;
}
