/**
 * Prepaid credit purchases through provider checkout (#3060). A paid
 * checkout credits the balance policy through smrt-subscriptions'
 * `grantCredit()`, keyed by the checkout session so it is credited once.
 */
import {
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import type { BillingProviderCheckoutSession } from './provider.js';
import type { BillingRuntime } from './runtime.js';
import {
  canonicalTenantId,
  deterministicId,
  normalizeCurrency,
  tenantKey,
} from './units.js';

export const CREDIT_PURCHASE_PURPOSE = 'credit_purchase';

export interface CreateCreditCheckoutInput {
  /** The `period: 'balance'` spending policy to credit. */
  spendingPolicyId: string;
  /** Credit to buy, in integer minor units of the policy currency. */
  amount: number;
  successUrl: string;
  cancelUrl: string;
  /**
   * Caller-owned id for this purchase attempt (for example a cart id). A
   * retried request with the same id returns the same checkout.
   */
  purchaseId: string;
  /** Checkout line description (default `Prepaid credit`). */
  description?: string;
}

/** The checkout metadata a completed purchase is settled from. */
export interface CreditPurchaseMetadata {
  purpose: string;
  sellerTenantId: string;
  payerTenantId: string;
  billingAccountId: string;
  spendingPolicyId: string;
  grantedByTenantId: string;
  amount: number;
  currency: string;
}

function encodeMetadata(
  metadata: CreditPurchaseMetadata,
): Record<string, string> {
  return {
    smrt_purpose: metadata.purpose,
    smrt_seller: metadata.sellerTenantId,
    smrt_payer: metadata.payerTenantId,
    smrt_account: metadata.billingAccountId,
    smrt_policy: metadata.spendingPolicyId,
    smrt_granted_by: metadata.grantedByTenantId,
    smrt_amount: String(metadata.amount),
    smrt_currency: metadata.currency,
  };
}

/** Parse checkout metadata written by {@link createCreditCheckout}. */
export function creditMetadata(
  raw: Record<string, string>,
): CreditPurchaseMetadata | null {
  if (raw.smrt_purpose !== CREDIT_PURCHASE_PURPOSE) return null;
  const amount = Number(raw.smrt_amount);
  if (
    !raw.smrt_seller ||
    !raw.smrt_payer ||
    !raw.smrt_account ||
    !raw.smrt_policy ||
    !raw.smrt_currency ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    throw new Error('Credit purchase metadata is incomplete.');
  }
  return {
    purpose: raw.smrt_purpose,
    sellerTenantId: tenantKey(raw.smrt_seller),
    payerTenantId: tenantKey(raw.smrt_payer),
    billingAccountId: raw.smrt_account,
    spendingPolicyId: raw.smrt_policy,
    grantedByTenantId: tenantKey(raw.smrt_granted_by),
    amount,
    currency: normalizeCurrency(raw.smrt_currency),
  };
}

export async function createCreditCheckout(
  runtime: BillingRuntime,
  input: CreateCreditCheckoutInput,
): Promise<BillingProviderCheckoutSession> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new Error('Credit amount must be positive integer minor units.');
  }
  if (!input.purchaseId) throw new Error('purchaseId is required.');
  const policy = await withSystemContext(() =>
    runtime.policies.get(input.spendingPolicyId),
  );
  if (!policy?.id || policy.period !== 'balance' || !policy.active) {
    throw new Error(
      `Spending policy ${input.spendingPolicyId} is not an active balance policy.`,
    );
  }
  // A delegated balance is funded only by the parent that set it.
  const grantedBy = tenantKey(policy.setByTenantId);
  const payer = canonicalTenantId(
    grantedBy || String(policy.tenantId),
    'payerTenantId',
  );
  if (
    !isSystemContext() &&
    !isSuperAdminBypass() &&
    tenantKey(getTenantId()) !== payer
  ) {
    throw new TenantIsolationError(
      'Only the payer of a balance policy can buy credit for it.',
    );
  }
  const account = await runtime.getAccount(payer);
  if (!account?.id) {
    throw new Error(`No billing account for payer ${payer}.`);
  }
  const currency = normalizeCurrency(policy.currency);
  const metadata = encodeMetadata({
    purpose: CREDIT_PURCHASE_PURPOSE,
    sellerTenantId: runtime.sellerTenantId,
    payerTenantId: payer,
    billingAccountId: String(account.id),
    spendingPolicyId: String(policy.id),
    grantedByTenantId: grantedBy,
    amount: input.amount,
    currency,
  });
  const key = await deterministicId([
    'billing-credit-checkout',
    runtime.sellerTenantId,
    String(policy.id),
    input.purchaseId,
  ]);
  const providerCustomerId =
    account.provider === runtime.provider.name
      ? account.providerCustomerId
      : '';
  return runtime.provider.createCheckout({
    idempotencyKey: `smrt-credit-checkout:${key}`,
    providerCustomerId: providerCustomerId || undefined,
    customerEmail: providerCustomerId ? undefined : account.email || undefined,
    currency,
    amount: input.amount,
    description: input.description || 'Prepaid credit',
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata,
  });
}
