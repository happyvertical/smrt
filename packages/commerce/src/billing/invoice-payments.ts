/**
 * Paying an issued invoice on another payment rail (#3138).
 *
 * The issuing provider (Stripe) issues, taxes, and emails the invoice. A payer
 * may instead pay it on a payment rail such as a crypto checkout: this opens a
 * rail checkout for the invoice's amount due, and settlement records the
 * payment locally and closes the issuing provider's invoice as paid out of
 * band so it stops collecting.
 */
import {
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { InvoiceStatus } from '../types/index.js';
import {
  type BillingProviderCheckoutSession,
  providerCapabilities,
} from './provider.js';
import type { BillingRuntime } from './runtime.js';
import { deterministicId, normalizeCurrency, tenantKey } from './units.js';

export const INVOICE_PAYMENT_PURPOSE = 'invoice_payment';

/** Invoices a rail payment may be opened for. */
const PAYABLE = new Set<string>([
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.OVERDUE,
]);

export interface CreateInvoicePaymentInput {
  invoiceId: string;
  /** The payment rail (a provider name from `paymentProviders`). */
  provider: string;
  /**
   * Caller-owned id for this attempt; a retry with the same id (and the same
   * amount due) returns the same checkout.
   */
  purchaseId: string;
  successUrl: string;
  cancelUrl: string;
  description?: string;
}

export interface InvoicePaymentMetadata {
  purpose: string;
  sellerTenantId: string;
  payerTenantId: string;
  billingAccountId: string;
  invoiceId: string;
  amount: number;
  currency: string;
}

/** Parse checkout metadata written by {@link createInvoicePayment}. */
export function invoicePaymentMetadata(
  raw: Record<string, string>,
): InvoicePaymentMetadata | null {
  if (raw.smrt_purpose !== INVOICE_PAYMENT_PURPOSE) return null;
  const amount = Number(raw.smrt_amount);
  if (
    !raw.smrt_seller ||
    !raw.smrt_payer ||
    !raw.smrt_account ||
    !raw.smrt_invoice ||
    !raw.smrt_currency ||
    !Number.isSafeInteger(amount) ||
    amount <= 0
  ) {
    throw new Error('Invoice payment metadata is incomplete.');
  }
  return {
    purpose: raw.smrt_purpose,
    sellerTenantId: tenantKey(raw.smrt_seller),
    payerTenantId: tenantKey(raw.smrt_payer),
    billingAccountId: raw.smrt_account,
    invoiceId: raw.smrt_invoice,
    amount,
    currency: normalizeCurrency(raw.smrt_currency),
  };
}

export async function createInvoicePayment(
  runtime: BillingRuntime,
  input: CreateInvoicePaymentInput,
): Promise<BillingProviderCheckoutSession> {
  if (!input.purchaseId) throw new Error('purchaseId is required.');
  const rail = runtime.providerFor(input.provider);
  if (!providerCapabilities(rail).paymentAttempts) {
    throw new Error(
      `Provider ${rail.name} cannot take payments for issued invoices.`,
    );
  }
  const invoice = await runtime.getInvoice(input.invoiceId);
  if (!PAYABLE.has(invoice.status)) {
    throw new Error(
      `Invoice ${invoice.invoiceNumber} is ${invoice.status}; only sent, unpaid invoices can be paid.`,
    );
  }
  if (invoice.externalProvider !== runtime.provider.name) {
    throw new Error(
      `Invoice ${invoice.invoiceNumber} was not issued by ${runtime.provider.name}.`,
    );
  }
  // Fail closed: without it a paid invoice would stay open at the issuer.
  if (!runtime.provider.markInvoicePaidOutOfBand) {
    throw new Error(
      `${runtime.provider.name} cannot close an invoice paid on another rail.`,
    );
  }
  const [close] = await runtime.closes.list({
    where: {
      invoiceId: String(invoice.id),
      sellerTenantId: runtime.sellerTenantId,
    },
    limit: 1,
  });
  const account = close?.billingAccountId
    ? await runtime.accounts.get(close.billingAccountId)
    : null;
  if (!account?.id) {
    throw new Error(
      `Invoice ${invoice.invoiceNumber} has no billing account for this seller.`,
    );
  }
  const payer = tenantKey(account.payerTenantId);
  if (
    !isSystemContext() &&
    !isSuperAdminBypass() &&
    tenantKey(getTenantId()) !== payer
  ) {
    throw new TenantIsolationError('Only the payer of an invoice can pay it.');
  }
  const allocated = await withTenant(
    { tenantId: runtime.sellerTenantId },
    async () =>
      (
        await PaymentAllocationCollection.create({ db: runtime.db })
      ).getTotalAllocatedToInvoice(String(invoice.id)),
  );
  const amountDue = invoice.totalAmount - allocated;
  if (!Number.isSafeInteger(amountDue) || amountDue <= 0) {
    throw new Error(`Invoice ${invoice.invoiceNumber} has nothing due.`);
  }
  const currency = normalizeCurrency(invoice.currency);
  const metadata: Record<string, string> = {
    smrt_purpose: INVOICE_PAYMENT_PURPOSE,
    smrt_seller: runtime.sellerTenantId,
    smrt_payer: payer,
    smrt_account: String(account.id),
    smrt_invoice: String(invoice.id),
    smrt_amount: String(amountDue),
    smrt_currency: currency,
  };
  const key = await deterministicId([
    'billing-invoice-payment',
    runtime.sellerTenantId,
    rail.name,
    String(invoice.id),
    String(amountDue),
    input.purchaseId,
  ]);
  const session = await rail.createCheckout({
    idempotencyKey: `smrt-invoice-payment:${key}`,
    customerEmail: account.email || undefined,
    currency,
    amount: amountDue,
    description: input.description || `Invoice ${invoice.invoiceNumber}`,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata,
  });
  await runtime.recordPaymentAttemptStart({
    provider: rail.name,
    checkoutId: session.sessionId,
    checkoutUrl: session.url ?? '',
    purpose: 'invoice_payment',
    payerTenantId: payer,
    billingAccountId: String(account.id),
    invoiceId: String(invoice.id),
    amount: amountDue,
    currency,
  });
  return session;
}
