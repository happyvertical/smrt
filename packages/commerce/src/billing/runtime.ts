/**
 * One seller's billing wiring (#3060): its payment provider, ledger accounts,
 * billing-owner reader, and the collections period close and provider events
 * write through.
 */
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { ForgeDeliveryCollection } from '@happyvertical/smrt-jobs';
import { JournalCollection } from '@happyvertical/smrt-ledgers';
import {
  type AutoTopUpHook,
  BillingAdjustmentCollection,
  type BillingRelationshipReader,
  ClientChargeCollection,
  PriceBookCollection,
  RetailChargeCollection,
  SpendingPolicyCollection,
  SubscriptionPlanCollection,
  TenantSubscriptionCollection,
} from '@happyvertical/smrt-subscriptions';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { PaymentInstrumentCollection } from '../collections/PaymentInstrumentCollection.js';
import {
  type BillingAccount,
  BillingAccountCollection,
  type BillingCloseKind,
  BillingLineSourceCollection,
  BillingPeriodCloseCollection,
  type BillingStanding,
} from '../models/billing.js';
import type { Invoice } from '../models/Invoice.js';
import { type Address, InvoiceStatus } from '../types/index.js';
import {
  type CreateCardSetupCheckoutInput,
  createCardSetupCheckout,
} from './cards.js';
import {
  type CreateCreditCheckoutInput,
  createCreditCheckout,
} from './credits.js';
import {
  billingPeriodContaining,
  type ScheduledBillingPeriod,
} from './cycles.js';
import { processBillingEvents } from './events.js';
import {
  type ClosePeriodInput,
  closeBillingPeriod,
  type PeriodCloseResult,
} from './period-close.js';
import type {
  BillingProvider,
  BillingProviderCheckoutSession,
} from './provider.js';
import {
  type AutoTopUpFailureHook,
  type AutoTopUpHookOptions,
  createAutoTopUpHook,
} from './top-up.js';
import { canonicalTenantId, deterministicId } from './units.js';

/** Ledger accounts billing posts to, in the seller's books. */
export interface BillingLedgerAccounts {
  /** Accounts receivable (debited when an invoice is issued). */
  arAccountId: string;
  /** Revenue (credited with the invoice subtotal). */
  revenueAccountId: string;
  /** Tax payable (credited with provider-calculated tax). */
  taxAccountId: string;
  /** Cash or clearing account payments settle into. */
  cashAccountId: string;
  /** Liability credited when prepaid credit is purchased. */
  prepaidCreditAccountId: string;
}

/** A payer's standing changed after a provider invoice event. */
export interface PayerStandingChange {
  sellerTenantId: string;
  payerTenantId: string;
  billingAccountId: string;
  invoiceId: string;
  previous: BillingStanding;
  standing: BillingStanding;
  /**
   * The event transaction's database handle. Host writes made through it
   * (for example suspending the tenant) commit or roll back with the event.
   */
  db: DatabaseInterface;
}

/**
 * Host hook for suspension or reinstatement. It runs inside the event's
 * transaction and may run again if the event is retried, so it must be
 * idempotent.
 */
export type PayerStandingHook = (
  change: PayerStandingChange,
) => void | Promise<void>;

export interface BillingRuntimeOptions extends SmrtClassOptions {
  /** The tenant that issues invoices. */
  sellerTenantId: string;
  kind: BillingCloseKind;
  provider: BillingProvider;
  /** smrt-tenancy's `BillingRelationshipService` (read access required). */
  billingRelationships: BillingRelationshipReader;
  ledger: BillingLedgerAccounts;
  /** Invoice number prefix (default `INV`). */
  invoiceNumberPrefix?: string;
  onPayerStanding?: PayerStandingHook;
  /** How long one worker may hold a period close (default 10 minutes). */
  leaseMs?: number;
  /** Page size for charge scans (default 500). */
  pageSize?: number;
  /**
   * Bill payers whose default card with this provider is on file (saved by
   * {@link BillingRuntime.createCardSetupCheckout} or a credit purchase with
   * `savePaymentMethod`) with automatically charged invoices (#3139): the
   * provider charges the card after the invoice is sent, and the `paid` or
   * `payment_failed` event settles it. Default false (every invoice is sent
   * for payment). Activate service on the `paid` event (a `current`
   * standing), not on send: collection happens on the provider's schedule.
   */
  autoChargeInvoices?: boolean;
  /**
   * Called when an automatic top-up charge ends without collecting (a
   * decline, or the issuer requiring the payer to authenticate), from the
   * hook or the provider's `payment` event (#3139).
   */
  onAutoTopUpFailed?: AutoTopUpFailureHook;
}

export interface UpsertBillingAccountInput {
  payerTenantId: string;
  name: string;
  email?: string;
  /** The payer's tax location; required when `automaticTax` is on. */
  billingAddress?: Address;
  taxExempt?: boolean;
  taxId?: string;
  automaticTax?: boolean;
  flatDiscountBasisPoints?: number;
  paymentTermsDays?: number;
  /** Link an existing provider customer (for example from checkout). */
  providerCustomerId?: string;
  /**
   * Billing-cycle anchor (#3116): periods run monthly from this instant
   * (anchor at signup/activation for no partial first period). `null` returns
   * the payer to UTC calendar months; omitted leaves it unchanged. Changing it
   * never bills time twice.
   */
  billingAnchorAt?: Date | null;
  /** Prorate flat plans to the time they were active in a period (#3116). */
  prorateFlatPlans?: boolean;
}

/** A synced account: its provider customer id is always present. */
export interface SyncedBillingAccount {
  account: BillingAccount;
  providerCustomerId: string;
  automaticTax: boolean;
  /** The customer has a billing address country (its tax location). */
  hasTaxLocation: boolean;
}

export interface EnsureProviderCustomerOptions {
  /**
   * Refuse a taxed account without a tax location (default true). Card setup
   * turns it off because the address is collected at checkout.
   */
  requireTaxLocation?: boolean;
}

const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/**
 * Billing for one seller. Construct once per process with
 * {@link BillingRuntime.create}; register it with `registerBillingRuntime()`
 * to drive it from smrt-jobs.
 *
 * Period close and event processing are privileged system operations: they
 * read every payer's charges and write in a system context. Call them only
 * from trusted host code (a job, an operator action), never from a
 * tenant-facing route.
 */
export class BillingRuntime {
  readonly sellerTenantId: string;
  readonly kind: BillingCloseKind;
  readonly provider: BillingProvider;
  readonly billingRelationships: BillingRelationshipReader;
  readonly ledger: BillingLedgerAccounts;
  readonly invoiceNumberPrefix: string;
  readonly onPayerStanding?: PayerStandingHook;
  readonly leaseMs: number;
  readonly pageSize: number;
  readonly autoChargeInvoices: boolean;
  readonly onAutoTopUpFailed?: AutoTopUpFailureHook;
  /** The inbox provider namespace for this runtime's events (per seller). */
  readonly eventProvider: string;

  private constructor(
    options: BillingRuntimeOptions,
    readonly db: DatabaseInterface,
    readonly accounts: BillingAccountCollection,
    readonly closes: BillingPeriodCloseCollection,
    readonly sources: BillingLineSourceCollection,
    readonly customers: CustomerCollection,
    readonly invoices: InvoiceCollection,
    readonly lineItems: InvoiceLineItemCollection,
    readonly journals: JournalCollection,
    readonly charges: ClientChargeCollection,
    readonly adjustments: BillingAdjustmentCollection,
    readonly retailCharges: RetailChargeCollection,
    readonly books: PriceBookCollection,
    readonly subscriptions: TenantSubscriptionCollection,
    readonly plans: SubscriptionPlanCollection,
    readonly policies: SpendingPolicyCollection,
    readonly instruments: PaymentInstrumentCollection,
  ) {
    this.sellerTenantId = canonicalTenantId(
      options.sellerTenantId,
      'sellerTenantId',
    );
    if (options.kind !== 'provider' && options.kind !== 'reseller') {
      throw new Error('Billing runtime kind must be provider or reseller.');
    }
    this.kind = options.kind;
    this.provider = options.provider;
    this.billingRelationships = options.billingRelationships;
    this.ledger = options.ledger;
    this.invoiceNumberPrefix = options.invoiceNumberPrefix || 'INV';
    this.onPayerStanding = options.onPayerStanding;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pageSize = options.pageSize ?? 500;
    this.autoChargeInvoices = options.autoChargeInvoices ?? false;
    this.onAutoTopUpFailed = options.onAutoTopUpFailed;
    // One inbox namespace per seller: the delivery claim is cross-tenant, so
    // a runtime must never be able to claim another seller's events.
    this.eventProvider = `${options.provider.name}-billing:${this.sellerTenantId}`;
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0) {
      throw new Error('leaseMs must be a positive number.');
    }
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize <= 0) {
      throw new Error('pageSize must be a positive integer.');
    }
    for (const [key, value] of Object.entries(options.ledger ?? {})) {
      if (!value) throw new Error(`Ledger account ${key} is required.`);
    }
  }

  static async create(options: BillingRuntimeOptions): Promise<BillingRuntime> {
    const {
      sellerTenantId: _seller,
      kind: _kind,
      provider: _provider,
      billingRelationships: _relationships,
      ledger: _ledger,
      invoiceNumberPrefix: _prefix,
      onPayerStanding: _hook,
      leaseMs: _leaseMs,
      pageSize: _pageSize,
      autoChargeInvoices: _autoCharge,
      onAutoTopUpFailed: _topUpFailed,
      ...classOptions
    } = options;
    const accounts = await BillingAccountCollection.create(classOptions);
    const shared = { ...classOptions, db: accounts.db };
    return new BillingRuntime(
      options,
      accounts.db,
      accounts,
      await BillingPeriodCloseCollection.create(shared),
      await BillingLineSourceCollection.create(shared),
      await CustomerCollection.create(shared),
      await InvoiceCollection.create(shared),
      await InvoiceLineItemCollection.create(shared),
      await JournalCollection.create(shared),
      await ClientChargeCollection.create(shared),
      await BillingAdjustmentCollection.create(shared),
      await RetailChargeCollection.create(shared),
      await PriceBookCollection.create(shared),
      await TenantSubscriptionCollection.create(shared),
      await SubscriptionPlanCollection.create(shared),
      await SpendingPolicyCollection.create(shared),
      await PaymentInstrumentCollection.create(shared),
    );
  }

  // -------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------

  async getAccount(payerTenantId: string): Promise<BillingAccount | null> {
    return this.accounts.get(await this.accountId(payerTenantId));
  }

  private accountId(payerTenantId: string): Promise<string> {
    return deterministicId([
      'billing-account',
      this.sellerTenantId,
      canonicalTenantId(payerTenantId, 'payerTenantId'),
    ]);
  }

  /**
   * Create or update a payer's account and its commerce `Customer` (in the
   * seller's tenant). The customer's billing address is the payer's tax
   * location for provider-calculated tax.
   */
  async upsertAccount(
    input: UpsertBillingAccountInput,
  ): Promise<BillingAccount> {
    const payerTenantId = canonicalTenantId(
      input.payerTenantId,
      'payerTenantId',
    );
    if (
      input.billingAnchorAt !== undefined &&
      input.billingAnchorAt !== null &&
      !(
        input.billingAnchorAt instanceof Date &&
        Number.isFinite(input.billingAnchorAt.getTime())
      )
    ) {
      throw new Error('billingAnchorAt must be a valid date or null.');
    }
    const id = await this.accountId(payerTenantId);
    const existing = await this.accounts.get(id);
    const customerId = await withTenant(
      { tenantId: this.sellerTenantId },
      async () => {
        const customer = existing?.customerId
          ? await this.customers.get(existing.customerId)
          : null;
        const values = {
          tenantId: this.sellerTenantId,
          ...(input.billingAddress !== undefined
            ? { defaultBillingAddress: input.billingAddress }
            : {}),
          ...(input.taxExempt !== undefined
            ? { taxExempt: input.taxExempt }
            : {}),
          ...(input.taxId !== undefined ? { taxId: input.taxId } : {}),
        };
        if (customer) {
          Object.assign(customer, values);
          await customer.save();
          return String(customer.id);
        }
        const created = await this.customers.create({
          id: await deterministicId(['billing-customer', id]),
          ...values,
        });
        return String(created.id);
      },
    );
    const account =
      existing ??
      (await this.accounts.create({
        id,
        sellerTenantId: this.sellerTenantId,
        payerTenantId,
        customerId,
        name: input.name,
      }));
    account.customerId = customerId;
    account.name = input.name;
    if (input.email !== undefined) account.email = input.email;
    if (input.automaticTax !== undefined)
      account.automaticTax = input.automaticTax;
    if (input.flatDiscountBasisPoints !== undefined)
      account.flatDiscountBasisPoints = input.flatDiscountBasisPoints;
    if (input.paymentTermsDays !== undefined)
      account.paymentTermsDays = input.paymentTermsDays;
    if (input.billingAnchorAt !== undefined)
      account.billingAnchorAt = input.billingAnchorAt;
    if (input.prorateFlatPlans !== undefined)
      account.prorateFlatPlans = input.prorateFlatPlans;
    if (input.providerCustomerId) {
      account.provider = this.provider.name;
      account.providerCustomerId = input.providerCustomerId;
    }
    await account.save();
    return account;
  }

  /**
   * Create or update the provider customer, including its tax location.
   * Creation is idempotent per account at the provider (sdk#1268): an
   * attempt that dies between creation and this save finds the same
   * customer on retry.
   */
  async ensureProviderCustomer(
    account: BillingAccount,
    options: EnsureProviderCustomerOptions = {},
  ): Promise<SyncedBillingAccount> {
    const customer = await withTenant({ tenantId: this.sellerTenantId }, () =>
      this.customers.get(account.customerId),
    );
    if (!customer) {
      throw new Error(`Billing account ${account.id} has no customer.`);
    }
    const address = customer.defaultBillingAddress ?? {};
    if (
      options.requireTaxLocation !== false &&
      account.automaticTax &&
      !customer.taxExempt &&
      !address.country
    ) {
      throw new Error(
        `Billing account ${account.id} has no tax location; set a billing address country.`,
      );
    }
    const providerCustomerId =
      account.provider === this.provider.name ? account.providerCustomerId : '';
    const synced = await this.provider.syncCustomer({
      accountId: String(account.id),
      providerCustomerId: providerCustomerId || undefined,
      name: account.name,
      email: account.email || undefined,
      billingAddress: address,
      taxExempt: customer.taxExempt,
    });
    if (
      account.provider !== this.provider.name ||
      account.providerCustomerId !== synced.providerCustomerId
    ) {
      account.provider = this.provider.name;
      account.providerCustomerId = synced.providerCustomerId;
      await account.save();
    }
    return {
      account,
      providerCustomerId: synced.providerCustomerId,
      automaticTax: account.automaticTax && !customer.taxExempt,
      hasTaxLocation: Boolean(address.country),
    };
  }

  /** Whether provider-calculated tax applies to this account's charges. */
  async accountIsTaxed(account: BillingAccount): Promise<boolean> {
    if (!account.automaticTax) return false;
    const customer = await withTenant({ tenantId: this.sellerTenantId }, () =>
      this.customers.get(account.customerId),
    );
    return !customer?.taxExempt;
  }

  // -------------------------------------------------------------------------
  // Period close
  // -------------------------------------------------------------------------

  /**
   * Close billing periods. Without a period, each payer's last ended period
   * on its own schedule (the previous UTC calendar month unless its account
   * has a `billingAnchorAt`), so running it daily is safe. See
   * {@link ClosePeriodInput}.
   */
  closePeriod(input: ClosePeriodInput = {}): Promise<PeriodCloseResult> {
    return closeBillingPeriod(this, input);
  }

  /**
   * The payer's billing period containing `at` (default now) on its account's
   * schedule — for example to show the next invoice date. A payer without an
   * account is on calendar months.
   */
  async billingPeriodFor(
    payerTenantId: string,
    at: Date = new Date(),
  ): Promise<ScheduledBillingPeriod> {
    const account = await this.getAccount(payerTenantId);
    return billingPeriodContaining(account?.billingAnchorAt ?? null, at);
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    const invoice = await withTenant({ tenantId: this.sellerTenantId }, () =>
      this.invoices.get(invoiceId),
    );
    if (!invoice) throw new Error(`Invoice ${invoiceId} was not found.`);
    return invoice;
  }

  /** Take the close's lease; returns the token, or null if another holds it. */
  async acquireCloseLease(
    closeId: string,
    now = new Date(),
  ): Promise<string | null> {
    const token = crypto.randomUUID();
    const nowIso = now.toISOString();
    const expires = new Date(now.getTime() + this.leaseMs).toISOString();
    const result = await this.db.query(
      `UPDATE _smrt_billing_period_closes
          SET lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
          AND (lease_token IS NULL OR lease_expires_at IS NULL
               OR lease_expires_at < ?)
        RETURNING id`,
      token,
      expires,
      nowIso,
      closeId,
      nowIso,
    );
    return result.rows.length === 1 ? token : null;
  }

  async releaseCloseLease(closeId: string, token: string): Promise<void> {
    await this.db.query(
      `UPDATE _smrt_billing_period_closes
          SET lease_token = NULL, lease_expires_at = NULL
        WHERE id = ? AND lease_token = ?`,
      closeId,
      token,
    );
  }

  // -------------------------------------------------------------------------
  // Provider events
  // -------------------------------------------------------------------------

  /**
   * Verify and durably enqueue a provider webhook. Returns `accepted: false`
   * for a duplicate delivery or an event this package does not act on.
   * Respond 2xx whenever this resolves; a verification failure throws
   * `BillingWebhookVerificationError`. An ignored event's `type` names what
   * was ignored: alert on one ending in `:unverified_credit_purchase` (a
   * paid checkout that claims to be a credit purchase but failed
   * verification, for example after a webhook-secret rotation).
   */
  async acceptWebhook(
    payload: string,
    signature: string,
  ): Promise<{
    accepted: boolean;
    eventId: string;
    kind: string;
    type?: string;
  }> {
    const event = await this.provider.verifyWebhook(payload, signature);
    if (event.kind === 'ignored') {
      return {
        accepted: false,
        eventId: event.eventId,
        kind: event.kind,
        type: event.type,
      };
    }
    return withTenant({ tenantId: this.sellerTenantId }, async () => {
      const inbox = await ForgeDeliveryCollection.create({ db: this.db });
      const { accepted } = await inbox.accept({
        provider: this.eventProvider,
        deliveryId: event.eventId,
        eventName: event.kind,
        payload: { event },
      });
      return { accepted, eventId: event.eventId, kind: event.kind };
    });
  }

  /** Apply up to `limit` queued provider events; returns how many ran. */
  processEvents(limit = 25): Promise<number> {
    return processBillingEvents(this, limit);
  }

  // -------------------------------------------------------------------------
  // Prepaid credit
  // -------------------------------------------------------------------------

  /**
   * Start a provider checkout that credits a prepaid balance policy when
   * paid. The caller pays: the policy's tenant for its own balance, or the
   * parent that set a delegated balance.
   */
  createCreditCheckout(
    input: CreateCreditCheckoutInput,
  ): Promise<BillingProviderCheckoutSession> {
    return createCreditCheckout(this, input);
  }

  // -------------------------------------------------------------------------
  // Card on file and automatic top-ups (#3139)
  // -------------------------------------------------------------------------

  /**
   * Start a provider checkout that saves the payer's card without charging
   * it. When the checkout completes, event processing makes the card the
   * provider customer's default, records it as the payer's default
   * `PaymentInstrument`, and adopts the billing address collected at
   * checkout as its tax location. Callable by the payer or in a system
   * context. Throws when the provider cannot save payment methods.
   */
  createCardSetupCheckout(
    input: CreateCardSetupCheckoutInput,
  ): Promise<BillingProviderCheckoutSession> {
    return createCardSetupCheckout(this, input);
  }

  /**
   * The `autoTopUp` hook for smrt-subscriptions' `SpendingPolicyEvaluator`:
   * charges the payer's saved card off-session and credits the balance once
   * the charge succeeds. Without a provider that can charge a saved card (or
   * without a card) it never tops up. Enable `payment_intent.*` events on
   * the provider webhook: charges that settle later are credited from them.
   */
  autoTopUpHook(options?: AutoTopUpHookOptions): AutoTopUpHook {
    return createAutoTopUpHook(this, options);
  }

  /**
   * Write off a sent, unpaid invoice at the provider (#3139). The provider's
   * `uncollectible` event then moves the payer to `uncollectible` standing.
   * Call only from trusted operator code. Throws when the provider cannot.
   */
  async markInvoiceUncollectible(invoiceId: string): Promise<void> {
    const markUncollectible = this.provider.markInvoiceUncollectible;
    if (!markUncollectible) {
      throw new Error(
        `Billing provider ${this.provider.name} cannot write off invoices.`,
      );
    }
    const invoice = await this.getInvoice(invoiceId);
    if (
      invoice.externalProvider !== this.provider.name ||
      !invoice.externalId ||
      (invoice.status !== InvoiceStatus.SENT &&
        invoice.status !== InvoiceStatus.VIEWED &&
        invoice.status !== InvoiceStatus.OVERDUE)
    ) {
      throw new Error(
        `Invoice ${invoice.invoiceNumber} is not a sent, unpaid ${this.provider.name} invoice.`,
      );
    }
    await markUncollectible.call(this.provider, invoice.externalId);
  }

  /** Run in a system context (cross-tenant reads and payer-owned writes). */
  system<T>(operation: () => Promise<T>): Promise<T> {
    return withSystemContext(operation);
  }
}
