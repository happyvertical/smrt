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
  // Authorize before anything about the invoice is revealed: a payer may
  // only learn about, and pay, its own invoices.
  const notFound = () =>
    new Error(`Invoice ${input.invoiceId} was not found for this payer.`);
  let invoice: Awaited<ReturnType<BillingRuntime['getInvoice']>>;
  try {
    invoice = await runtime.getInvoice(input.invoiceId);
  } catch {
    throw notFound();
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
  if (!account?.id) throw notFound();
  const payer = tenantKey(account.payerTenantId);
  if (
    !isSystemContext() &&
    !isSuperAdminBypass() &&
    tenantKey(getTenantId()) !== payer
  ) {
    throw new TenantIsolationError('Only the payer of an invoice can pay it.');
  }
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
  const key = await deterministicId([
    'billing-invoice-payment',
    runtime.sellerTenantId,
    rail.name,
    String(invoice.id),
    String(amountDue),
    input.purchaseId,
  ]);
  const orderId = `smrt-invoice-payment:${key}`;
  // One live payment per invoice: a second checkout could be paid too and
  // collect the invoice twice. The payer finishes (or lets expire) the one
  // already open; retrying the same purchase returns it.
  const live = (
    await runtime.listPaymentAttempts({ invoiceId: String(invoice.id) })
  ).filter(
    (row) =>
      (row.status === 'open' || row.status === 'confirming') && !row.settledAt,
  );
  // Rows without an order id (created before it was recorded) are left to
  // the gateway, whose creation is idempotent by order id.
  const busy = live.find((row) => row.orderId && row.orderId !== orderId);
  if (busy) {
    throw new Error(
      `Invoice ${invoice.invoiceNumber} already has a payment in progress on ${busy.provider}.`,
    );
  }
  const metadata: Record<string, string> = {
    smrt_purpose: INVOICE_PAYMENT_PURPOSE,
    smrt_seller: runtime.sellerTenantId,
    smrt_payer: payer,
    smrt_account: String(account.id),
    smrt_invoice: String(invoice.id),
    smrt_amount: String(amountDue),
    smrt_currency: currency,
  };
  const session = await rail.createCheckout({
    idempotencyKey: orderId,
    customerEmail: account.email || undefined,
    currency,
    amount: amountDue,
    description: input.description || `Invoice ${invoice.invoiceNumber}`,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata,
  });
  await runtime.recordPaymentAttemptStart({
    orderId,
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
