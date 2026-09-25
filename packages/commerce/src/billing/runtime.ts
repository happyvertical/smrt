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
import {
  type BillingAccount,
  BillingAccountCollection,
  type BillingCloseKind,
  BillingLineSourceCollection,
  type BillingPaymentAttempt,
  BillingPaymentAttemptCollection,
  type BillingPaymentAttemptPurpose,
  BillingPeriodCloseCollection,
  type BillingStanding,
} from '../models/billing.js';
import type { Invoice } from '../models/Invoice.js';
import type { Address } from '../types/index.js';
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
  type CreateInvoicePaymentInput,
  createInvoicePayment,
} from './invoice-payments.js';
import {
  type BillingPaymentPolicy,
  type CryptoConversionInput,
  type ManualRefundInput,
  type ManualRefundResult,
  normalizePaymentPolicy,
  recordCryptoConversion,
  recordManualRefund,
} from './payment-attempts.js';
import {
  type ClosePeriodInput,
  closeBillingPeriod,
  type PeriodCloseResult,
} from './period-close.js';
import {
  type BillingProvider,
  type BillingProviderCheckoutSession,
  providerCapabilities,
} from './provider.js';
import { canonicalTenantId, deterministicId, tenantKey } from './units.js';

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
  /**
   * Asset debited when a crypto rail payment settles and the seller holds
   * the crypto (#3138). Defaults to `cashAccountId`.
   */
  cryptoHoldingsAccountId?: string;
  /** Realized gain or loss when held crypto is converted (#3138). */
  fxGainLossAccountId?: string;
  /** Conversion and network fees (#3138). */
  feesAccountId?: string;
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
  /** The issuing provider: it issues, taxes, and sends invoices. */
  provider: BillingProvider;
  /**
   * Additional payment rails (#3138), for example a crypto checkout
   * provider. A payer picks a rail per payment; each rail has its own inbox
   * namespace and webhook route. Names must be unique across all providers.
   */
  paymentProviders?: BillingProvider[];
  /** Per-seller rules for rail payments (#3138). */
  paymentPolicy?: Partial<BillingPaymentPolicy>;
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
  /** The inbox provider namespace for the issuing provider's events. */
  readonly eventProvider: string;
  /** Per-seller rules for rail payments (#3138). */
  readonly paymentPolicy: BillingPaymentPolicy;
  private readonly providersByName = new Map<string, BillingProvider>();
  readonly attempts: BillingPaymentAttemptCollection;

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
    attempts: BillingPaymentAttemptCollection,
  ) {
    this.attempts = attempts;
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
    // One inbox namespace per seller: the delivery claim is cross-tenant, so
    // a runtime must never be able to claim another seller's events.
    this.eventProvider = `${options.provider.name}-billing:${this.sellerTenantId}`;
    if (!providerCapabilities(options.provider).issuesInvoices) {
      throw new Error(
        `Provider ${options.provider.name} does not issue invoices; pass it in paymentProviders.`,
      );
    }
    for (const candidate of [
      options.provider,
      ...(options.paymentProviders ?? []),
    ]) {
      if (!candidate?.name || this.providersByName.has(candidate.name)) {
        throw new Error(
          `Billing provider names must be unique and non-empty (${candidate?.name ?? 'missing'}).`,
        );
      }
      this.providersByName.set(candidate.name, candidate);
    }
    this.paymentPolicy = normalizePaymentPolicy(options.paymentPolicy);
    if (!Number.isFinite(this.leaseMs) || this.leaseMs <= 0) {
      throw new Error('leaseMs must be a positive number.');
    }
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize <= 0) {
      throw new Error('pageSize must be a positive integer.');
    }
    const optionalLedger = new Set([
      'cryptoHoldingsAccountId',
      'fxGainLossAccountId',
      'feesAccountId',
    ]);
    for (const [key, value] of Object.entries(options.ledger ?? {})) {
      if (!value && !(optionalLedger.has(key) && value === undefined)) {
        throw new Error(`Ledger account ${key} is required.`);
      }
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
      paymentProviders: _rails,
      paymentPolicy: _paymentPolicy,
      leaseMs: _leaseMs,
      pageSize: _pageSize,
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
      await BillingPaymentAttemptCollection.create(shared),
    );
  }

  // -------------------------------------------------------------------------
  // Providers and rails (#3138)
  // -------------------------------------------------------------------------

  /** A provider by name; the issuing provider when `name` is omitted. */
  providerFor(name?: string): BillingProvider {
    if (!name) return this.provider;
    const found = this.providersByName.get(name);
    if (!found) {
      throw new Error(`No billing provider named ${name} on this runtime.`);
    }
    return found;
  }

  /** Every provider of this runtime: the issuing one first. */
  get providers(): BillingProvider[] {
    return [...this.providersByName.values()];
  }

  /** A provider's inbox namespace (per provider, per seller). */
  eventProviderFor(name?: string): string {
    return `${this.providerFor(name).name}-billing:${this.sellerTenantId}`;
  }

  /** Every inbox namespace this runtime claims events from. */
  get eventProviders(): string[] {
    return this.providers.map((provider) =>
      this.eventProviderFor(provider.name),
    );
  }

  /** The provider whose inbox namespace this is, or null. */
  providerForNamespace(namespace: string): BillingProvider | null {
    return (
      this.providers.find(
        (provider) => this.eventProviderFor(provider.name) === namespace,
      ) ?? null
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
   * Creating a customer is not idempotent at the provider; an attempt that
   * dies between creation and this save leaves an unused provider customer.
   */
  async ensureProviderCustomer(
    account: BillingAccount,
  ): Promise<SyncedBillingAccount> {
    const customer = await withTenant({ tenantId: this.sellerTenantId }, () =>
      this.customers.get(account.customerId),
    );
    if (!customer) {
      throw new Error(`Billing account ${account.id} has no customer.`);
    }
    const address = customer.defaultBillingAddress ?? {};
    if (account.automaticTax && !customer.taxExempt && !address.country) {
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
    };
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
    options: {
      /** The rail whose webhook this is (default the issuing provider). */
      provider?: string;
      /** Request headers, for rails that sign with their own header. */
      headers?: Headers | Record<string, string | undefined>;
    } = {},
  ): Promise<{
    accepted: boolean;
    eventId: string;
    kind: string;
    type?: string;
  }> {
    const provider = this.providerFor(options.provider);
    const event = await provider.verifyWebhook(
      payload,
      signature,
      options.headers,
    );
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
        provider: this.eventProviderFor(provider.name),
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
  // Rail payments (#3138)
  // -------------------------------------------------------------------------

  /**
   * Pay an issued invoice on a payment rail: opens a rail checkout for the
   * amount due. Settlement records the payment and closes the issuing
   * provider's invoice as paid out of band. Callable by the payer or from a
   * system context.
   */
  createInvoicePayment(
    input: CreateInvoicePaymentInput,
  ): Promise<BillingProviderCheckoutSession> {
    return createInvoicePayment(this, input);
  }

  /** Record a rail checkout just opened (idempotent). */
  async recordPaymentAttemptStart(input: {
    provider: string;
    checkoutId: string;
    checkoutUrl: string;
    purpose: BillingPaymentAttemptPurpose;
    payerTenantId: string;
    billingAccountId: string;
    invoiceId?: string;
    spendingPolicyId?: string;
    amount: number;
    currency: string;
  }): Promise<BillingPaymentAttempt> {
    const id = await this.paymentAttemptId(input.provider, input.checkoutId);
    const existing = await this.attempts.get(id);
    if (existing) return existing;
    try {
      return await this.attempts.create({
        id,
        sellerTenantId: this.sellerTenantId,
        payerTenantId: input.payerTenantId,
        billingAccountId: input.billingAccountId,
        purpose: input.purpose,
        invoiceId: input.invoiceId ?? '',
        spendingPolicyId: input.spendingPolicyId ?? '',
        provider: input.provider,
        checkoutId: input.checkoutId,
        checkoutUrl: input.checkoutUrl,
        amount: input.amount,
        currency: input.currency,
        status: 'open',
        exception: 'none',
        timeline: [
          {
            at: new Date().toISOString(),
            status: 'open',
            exception: 'none',
            source: 'created',
          },
        ],
        _insertOnly: true,
      });
    } catch (error) {
      const concurrent = await this.attempts.get(id);
      if (concurrent) return concurrent;
      throw error;
    }
  }

  /** The deterministic id of a rail checkout's attempt row. */
  paymentAttemptId(provider: string, checkoutId: string): Promise<string> {
    return deterministicId(['billing-payment-attempt', provider, checkoutId]);
  }

  /**
   * This seller's rail payment attempts, newest first — for "payment
   * confirming" displays and operator queues.
   */
  async listPaymentAttempts(
    filter: {
      payerTenantId?: string;
      invoiceId?: string;
      status?: string;
      flagged?: boolean;
      limit?: number;
    } = {},
  ): Promise<BillingPaymentAttempt[]> {
    const where: Record<string, unknown> = {
      sellerTenantId: this.sellerTenantId,
    };
    if (filter.payerTenantId) {
      where.payerTenantId = canonicalTenantId(
        filter.payerTenantId,
        'payerTenantId',
      );
    }
    if (filter.invoiceId) where.invoiceId = filter.invoiceId;
    if (filter.status) where.status = filter.status;
    const rows = await this.attempts.list({
      where,
      orderBy: 'created_at DESC',
      limit: filter.limit ?? 100,
    });
    return filter.flagged === undefined
      ? rows
      : rows.filter((row) => Boolean(row.flag) === filter.flagged);
  }

  /**
   * Queue a re-read of open and confirming attempts (the polling fallback
   * for missed webhooks). Returns how many were queued; apply them with
   * `processEvents()`.
   */
  async refreshPaymentAttempts(limit = 100): Promise<number> {
    const rows = [
      ...(await this.listPaymentAttempts({ status: 'open', limit })),
      ...(await this.listPaymentAttempts({ status: 'confirming', limit })),
    ].slice(0, limit);
    let queued = 0;
    for (const row of rows) {
      if (await this.refreshPaymentAttempt(row.provider, row.checkoutId)) {
        queued += 1;
      }
    }
    return queued;
  }

  /** Queue a re-read of one rail checkout; false if one is already queued. */
  async refreshPaymentAttempt(
    provider: string,
    checkoutId: string,
  ): Promise<boolean> {
    const rail = this.providerFor(provider);
    if (!providerCapabilities(rail).paymentAttempts) {
      throw new Error(`Provider ${rail.name} has no payment attempts.`);
    }
    // One poll per checkout per minute: a burst of refreshes queues once.
    const bucket = Math.floor(Date.now() / 60_000);
    return withTenant({ tenantId: this.sellerTenantId }, async () => {
      const inbox = await ForgeDeliveryCollection.create({ db: this.db });
      const { accepted } = await inbox.accept({
        provider: this.eventProviderFor(rail.name),
        deliveryId: `poll:${checkoutId}:${bucket}`,
        eventName: 'payment_attempt',
        payload: {
          event: {
            kind: 'payment_attempt',
            eventId: `poll:${checkoutId}:${bucket}`,
            checkoutId,
          },
        },
      });
      return accepted;
    });
  }

  /** Close an attempt's flag with an operator note (the flag is kept). */
  async resolvePaymentAttempt(
    attemptId: string,
    resolution: string,
  ): Promise<BillingPaymentAttempt> {
    const attempt = await this.attempts.get(attemptId);
    if (!attempt || tenantKey(attempt.sellerTenantId) !== this.sellerTenantId) {
      throw new Error(`Payment attempt ${attemptId} was not found.`);
    }
    if (!resolution.trim()) throw new Error('A resolution note is required.');
    attempt.resolution = resolution.trim();
    attempt.resolvedAt = new Date();
    await attempt.save();
    return attempt;
  }

  /**
   * Record a refund an operator made outside billing (no provider call):
   * posts a reversing journal and, for a credit purchase, removes the
   * credit. Idempotent by `reference`.
   */
  recordManualRefund(input: ManualRefundInput): Promise<ManualRefundResult> {
    return recordManualRefund(this, input);
  }

  /**
   * Record converting held crypto to fiat: cash and fees against the
   * holdings' carrying value, with the difference to FX gain/loss.
   * Idempotent by `reference`.
   */
  recordCryptoConversion(
    input: CryptoConversionInput,
  ): Promise<{ journalId: string }> {
    return recordCryptoConversion(this, input);
  }

  /** Run in a system context (cross-tenant reads and payer-owned writes). */
  system<T>(operation: () => Promise<T>): Promise<T> {
    return withSystemContext(operation);
  }
}
