/**
 * Card on file (#3139): a provider checkout that saves a payment method
 * without charging, and the settlement that makes it the payer's default.
 *
 * A completed setup (or a credit purchase that saved its card) is applied
 * from the provider's checkout event: `observe()` re-reads the session and
 * makes the saved method the provider customer's default; `project()`
 * records it as the payer customer's default commerce `PaymentInstrument`
 * and adopts the billing address collected at checkout as the tax location.
 */
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { PaymentInstrumentCollection } from '../collections/PaymentInstrumentCollection.js';
import type { BillingAccount } from '../models/billing.js';
import { PaymentInstrumentStatus } from '../types/index.js';
import type {
  BillingProviderCheckoutSession,
  BillingProviderCheckoutState,
} from './provider.js';
import type { BillingRuntime } from './runtime.js';
import {
  canonicalTenantId,
  deterministicId,
  normalizeCurrency,
  tenantKey,
} from './units.js';

export const CARD_SETUP_PURPOSE = 'card_setup';
/** Checkout metadata flag: the session saves its payment method. */
export const SAVE_CARD_METADATA = 'smrt_save_card';

export interface CreateCardSetupCheckoutInput {
  payerTenantId: string;
  /** The currency the saved card will be charged in. */
  currency: string;
  successUrl: string;
  cancelUrl: string;
  /**
   * Caller-owned id for this setup attempt. A retried request with the same
   * id returns the same checkout; a new attempt (for example after a declined
   * card) needs a new id.
   */
  setupId: string;
  /**
   * Collect the billing address at checkout and adopt it as the payer's tax
   * location. Default: when the account is taxed and has no tax location.
   */
  collectBillingAddress?: boolean;
}

/** Only the payer (or a system/operator context) manages its card. */
export function assertPayerContext(payerTenantId: string): void {
  if (
    !isSystemContext() &&
    !isSuperAdminBypass() &&
    tenantKey(getTenantId()) !== payerTenantId
  ) {
    throw new TenantIsolationError(
      'Only the payer can manage its payment methods.',
    );
  }
}

export async function createCardSetupCheckout(
  runtime: BillingRuntime,
  input: CreateCardSetupCheckoutInput,
): Promise<BillingProviderCheckoutSession> {
  const createSetupCheckout = runtime.provider.createSetupCheckout;
  if (!createSetupCheckout) {
    throw new Error(
      `Billing provider ${runtime.provider.name} cannot save a payment method.`,
    );
  }
  if (!input.setupId) throw new Error('setupId is required.');
  const payer = canonicalTenantId(input.payerTenantId, 'payerTenantId');
  assertPayerContext(payer);
  const account = await runtime.getAccount(payer);
  if (!account?.id) throw new Error(`No billing account for payer ${payer}.`);
  // The address may be collected at checkout, so the tax location is not
  // required yet; period close still requires one before invoicing.
  const synced = await runtime.ensureProviderCustomer(account, {
    requireTaxLocation: false,
  });
  const key = await deterministicId([
    'billing-card-setup',
    runtime.sellerTenantId,
    String(account.id),
    input.setupId,
  ]);
  return createSetupCheckout.call(runtime.provider, {
    idempotencyKey: `smrt-card-setup:${key}`,
    providerCustomerId: synced.providerCustomerId,
    currency: normalizeCurrency(input.currency),
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    collectBillingAddress:
      input.collectBillingAddress ??
      (synced.automaticTax && !synced.hasTaxLocation),
    metadata: {
      smrt_purpose: CARD_SETUP_PURPOSE,
      smrt_seller: runtime.sellerTenantId,
      smrt_payer: payer,
      smrt_account: String(account.id),
    },
  });
}

/** A saved card the event carries, validated against its account. */
export interface SavedCard {
  account: BillingAccount;
  providerCustomerId: string;
  paymentMethodId: string;
  billingAddress?: BillingProviderCheckoutState['billingAddress'];
}

/**
 * The card a completed checkout saved for one of this seller's accounts, or
 * null when it saved none. Throws when the session and its (verified)
 * metadata disagree, so the event dead-letters visibly.
 */
export async function savedCardFromCheckout(
  runtime: BillingRuntime,
  metadata: Record<string, string>,
  state: BillingProviderCheckoutState,
): Promise<SavedCard | null> {
  if (!state.complete || !state.paymentMethodId) return null;
  if (tenantKey(metadata.smrt_seller) !== runtime.sellerTenantId) return null;
  const account = await runtime.accounts.get(metadata.smrt_account ?? '');
  if (
    !account?.id ||
    tenantKey(account.sellerTenantId) !== runtime.sellerTenantId ||
    tenantKey(account.payerTenantId) !== tenantKey(metadata.smrt_payer) ||
    account.provider !== runtime.provider.name ||
    !account.providerCustomerId ||
    state.providerCustomerId !== account.providerCustomerId
  ) {
    throw new Error(
      `Checkout ${state.sessionId} saved a card for a customer that is not its billing account's.`,
    );
  }
  return {
    account,
    providerCustomerId: account.providerCustomerId,
    paymentMethodId: state.paymentMethodId,
    billingAddress: state.billingAddress,
  };
}

/**
 * Record a saved card as the customer's default instrument, and adopt a
 * collected billing address. Idempotent; runs in the event transaction.
 */
export async function recordSavedCard(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  card: SavedCard,
): Promise<void> {
  await withTenant({ tenantId: runtime.sellerTenantId }, async () => {
    const instruments = await PaymentInstrumentCollection.create({ db });
    const id = await deterministicId([
      'billing-payment-instrument',
      runtime.provider.name,
      runtime.sellerTenantId,
      card.paymentMethodId,
    ]);
    let instrument = await instruments.get(id);
    if (!instrument) {
      instrument = await instruments.create({
        id,
        tenantId: runtime.sellerTenantId,
        customerId: card.account.customerId,
        backendId: runtime.provider.name,
        providerCustomerId: card.providerCustomerId,
        providerPaymentMethodId: card.paymentMethodId,
        type: 'card',
        status: PaymentInstrumentStatus.ACTIVE,
        _insertOnly: true,
      });
    } else if (instrument.customerId !== card.account.customerId) {
      throw new Error(
        `Payment method ${card.paymentMethodId} is already saved for another customer.`,
      );
    } else if (!instrument.isActive()) {
      instrument.status = PaymentInstrumentStatus.ACTIVE;
      await instrument.save();
    }
    await instruments.setDefaultForCustomer(
      card.account.customerId,
      String(instrument.id),
    );

    if (card.billingAddress?.country) {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.get(card.account.customerId);
      if (customer) {
        customer.defaultBillingAddress = card.billingAddress;
        await customer.save();
      }
    }
  });
}

/**
 * Whether the payer's default card is with this runtime's provider customer:
 * what `autoChargeInvoices` bills and automatic top-ups charge.
 */
export async function defaultCardFor(
  runtime: BillingRuntime,
  account: BillingAccount,
  providerCustomerId: string,
): Promise<boolean> {
  const instrument = await withTenant(
    { tenantId: runtime.sellerTenantId },
    () => runtime.instruments.findDefaultForCustomer(account.customerId),
  );
  return Boolean(
    instrument?.isActive() &&
      instrument.backendId === runtime.provider.name &&
      instrument.providerCustomerId === providerCustomerId,
  );
}
