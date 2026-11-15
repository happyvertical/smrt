import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * Where a Checkout session the billing host created stands (#4814).
 *
 * - `pending`: created by the host, not yet completed.
 * - `completed`: the paid session was linked to its tenant (single use).
 * - `needs_reconciliation`: a paid session whose record was missing, expired
 *   or did not match. It is not linked; an operator links it on purpose with
 *   `BillingHost.reconcileCheckout()`.
 */
export type BillingCheckoutSessionStatus =
  | 'pending'
  | 'completed'
  | 'needs_reconciliation'
  | 'dismissed';

/**
 * One Checkout session created by the billing host, recorded when the host
 * creates it and required when the paid session completes, so signed
 * metadata copied onto another integration's session is never trusted.
 * `sessionId` is the provider's unguessable, unique id and doubles as the
 * single-use nonce.
 *
 * A system table managed through `createBillingHost()`, like
 * `_smrt_price_book_assignments`; it has no generated API surface. It is a
 * root export because the published manifest advertises it. `tenantId` is the
 * tenant the host created the session for (`''` on a row opened for a session
 * the host never recorded).
 */
@smrt({
  tableName: '_smrt_billing_checkout_sessions',
  conflictColumns: ['session_id'],
  api: false,
  cli: false,
  mcp: false,
})
export class BillingCheckoutSession extends SmrtObject {
  @field({ required: true, requiredFor: 'idempotency' })
  sessionId: string = '';
  @field({ description: 'The tenant the host created the session for.' })
  targetTenantId: string = '';
  status: BillingCheckoutSessionStatus = 'pending';
  expiresAt: Date = new Date(0);
  completedAt: Date | null = null;
  /** Why the row needs reconciliation (a code, never provider text). */
  reason: string = '';
  /** JSON ids needed to reconcile: event, subscription, customer, plan. */
  detail: string = '{}';
}

export class BillingCheckoutSessionCollection extends SmrtCollection<BillingCheckoutSession> {
  static readonly _itemClass = BillingCheckoutSession;
}
