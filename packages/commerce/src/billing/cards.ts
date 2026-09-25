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
/**
 * Checkout metadata flag: the session collects the billing address, which is
 * adopted as the payer's tax location when the card is saved.
 */
export const COLLECT_ADDRESS_METADATA = 'smrt_collect_address';

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
  assertCanSaveCards(runtime);
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
  const collectBillingAddress =
    input.collectBillingAddress ??
    (synced.automaticTax && !synced.hasTaxLocation);
  return createSetupCheckout.call(runtime.provider, {
    idempotencyKey: `smrt-card-setup:${key}`,
    providerCustomerId: synced.providerCustomerId,
    currency: normalizeCurrency(input.currency),
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    collectBillingAddress,
    metadata: {
      smrt_purpose: CARD_SETUP_PURPOSE,
      smrt_seller: runtime.sellerTenantId,
      smrt_payer: payer,
      smrt_account: String(account.id),
      ...(collectBillingAddress ? { [COLLECT_ADDRESS_METADATA]: '1' } : {}),
    },
  });
}

/**
 * What a completed checkout saved for one of this seller's accounts: a card
 * (setup, or a purchase with `savePaymentMethod`) and/or a billing address it
 * was asked to collect. Validated against the account.
 */
export interface SavedCard {
  account: BillingAccount;
  providerCustomerId: string;
  paymentMethodId?: string;
  billingAddress?: BillingProviderCheckoutState['billingAddress'];
}

/** Whether the provider can apply a saved card from a checkout event. */
export function assertCanSaveCards(runtime: BillingRuntime): void {
  if (
    !runtime.provider.getCheckout ||
    !runtime.provider.setDefaultPaymentMethod
  ) {
    throw new Error(
      `Billing provider ${runtime.provider.name} cannot apply a saved payment method (getCheckout and setDefaultPaymentMethod are required).`,
    );
  }
}

/**
 * The card and/or collected address a completed checkout saved for one of
 * this seller's accounts, or null when it saved neither. Throws when the
 * session and its (verified) metadata disagree, so the event dead-letters
 * visibly.
 */
export async function savedCardFromCheckout(
  runtime: BillingRuntime,
  metadata: Record<string, string>,
  state: BillingProviderCheckoutState,
  savesCard: boolean,
): Promise<SavedCard | null> {
  if (!state.complete) return null;
  const paymentMethodId = savesCard ? state.paymentMethodId : undefined;
  // Only an address the checkout was asked to collect replaces the local
  // tax location; otherwise the provider's copy is the one synced from it.
  const billingAddress =
    metadata[COLLECT_ADDRESS_METADATA] === '1' && state.billingAddress?.country
      ? state.billingAddress
      : undefined;
  if (!paymentMethodId && !billingAddress) return null;
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
    paymentMethodId,
    billingAddress,
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
    if (card.paymentMethodId) await recordInstrument(runtime, db, card);
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

async function recordInstrument(
  runtime: BillingRuntime,
  db: DatabaseInterface,
  card: SavedCard,
): Promise<void> {
  const paymentMethodId = String(card.paymentMethodId);
  const instruments = await PaymentInstrumentCollection.create({ db });
  const id = await deterministicId([
    'billing-payment-instrument',
    runtime.provider.name,
    runtime.sellerTenantId,
    paymentMethodId,
  ]);
  let instrument = await instruments.get(id);
  if (!instrument) {
    instrument = await instruments.create({
      id,
      tenantId: runtime.sellerTenantId,
      customerId: card.account.customerId,
      backendId: runtime.provider.name,
      providerCustomerId: card.providerCustomerId,
      providerPaymentMethodId: paymentMethodId,
      type: 'card',
      status: PaymentInstrumentStatus.ACTIVE,
      _insertOnly: true,
    });
  } else if (instrument.customerId !== card.account.customerId) {
    throw new Error(
      `Payment method ${paymentMethodId} is already saved for another customer.`,
    );
  } else if (!instrument.isActive()) {
    instrument.status = PaymentInstrumentStatus.ACTIVE;
    await instrument.save();
  }
  await instruments.setDefaultForCustomer(
    card.account.customerId,
    String(instrument.id),
  );
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
