/**
 * Stripe launch billing on `@happyvertical/accounting` 0.92 (#3139): ISO 4217
 * minor units, idempotent customer creation, taxed credit purchases, card on
 * file, automatically charged invoices, write-offs, and automatic top-ups.
 *
 * Like the period-close suite, every provider call runs through the real SDK
 * against the in-memory Stripe double.
 */
import { JournalCollection } from '@happyvertical/smrt-ledgers';
import {
  CreditGrantCollection,
  SpendingPolicyCollection,
  SpendingPolicyEvaluator,
} from '@happyvertical/smrt-subscriptions';
import {
  disableTenancy,
  enableTenancy,
  TenantIsolationError,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingProvider } from '../billing/provider.js';
import { BillingRuntime } from '../billing/runtime.js';
import {
  type AutoTopUpFailure,
  type AutoTopUpHookOptions,
  applyAutoTopUpOutcome,
} from '../billing/top-up.js';
import {
  currencyMinorUnitExponent,
  majorToMinorUnits,
  minorToMajorUnits,
} from '../billing/units.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { PaymentInstrumentCollection } from '../collections/PaymentInstrumentCollection.js';
import { InvoiceStatus, PaymentStatus } from '../types/index.js';
import {
  type BillingWorld,
  createBillingWorld,
  currentMonth,
  NETWORK,
  PROVIDER,
  SITE,
  SOLO,
  STRANGER,
} from './helpers/billing-fixture.js';
import {
  checkoutEvent,
  type FakeCardBehavior,
  invoiceEvent,
  paymentIntentEvent,
  signedEvent,
} from './helpers/fake-stripe.js';

const system = <T>(fn: () => Promise<T>) => withSystemContext(fn);

async function deliver(
  world: BillingWorld,
  event: Record<string, unknown>,
  runtime = world.provider,
) {
  const { payload, signature } = signedEvent(event);
  const accepted = await runtime.acceptWebhook(payload, signature);
  const processed = await runtime.processEvents();
  return { accepted, processed };
}

async function deliveries(world: BillingWorld) {
  return (
    await world.db.query(
      'SELECT status, last_error FROM _smrt_forge_deliveries ORDER BY created_at',
    )
  ).rows as Array<{ status: string; last_error: string }>;
}

describe('smrt#3139 Stripe launch billing', () => {
  let world: BillingWorld;
  const period = currentMonth();

  beforeEach(async () => {
    const usage = await SpendingPolicyCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    world = await createBillingWorld(usage.db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function balancePolicy(tenantId: string, setBy?: string) {
    return system(async () =>
      (await SpendingPolicyCollection.create({ db: world.db })).create({
        tenantId,
        name: 'Prepaid',
        period: 'balance',
        currency: 'USD',
        behavior: 'block',
        ...(setBy ? { setByTenantId: setBy } : {}),
      }),
    );
  }

  async function grantsOf(tenantId: string) {
    return system(async () =>
      (await CreditGrantCollection.create({ db: world.db })).list({
        where: { tenantId },
      }),
    );
  }

  async function sellerPayments() {
    return withTenant({ tenantId: PROVIDER }, async () =>
      (await PaymentCollection.create({ db: world.db })).list({
        orderBy: 'created_at ASC',
      }),
    );
  }

  async function sellerJournals() {
    return withTenant({ tenantId: PROVIDER }, async () =>
      (await JournalCollection.create({ db: world.db })).list({
        where: { status: 'posted' },
      }),
    );
  }

  /** Save a card for a payer through the setup checkout and its event. */
  async function saveCard(
    payer: string,
    paymentMethod: string,
    behavior: FakeCardBehavior = 'succeed',
    runtime = world.provider,
  ) {
    world.stripe.cards.set(paymentMethod, behavior);
    const setup = await withTenant({ tenantId: payer }, () =>
      runtime.createCardSetupCheckout({
        payerTenantId: payer,
        currency: 'USD',
        setupId: `setup-${paymentMethod}`,
        successUrl: 'https://a.test/ok',
        cancelUrl: 'https://a.test/cancel',
      }),
    );
    const session = world.stripe.completeSession(setup.sessionId, {
      paymentMethod,
    });
    await deliver(world, checkoutEvent(session), runtime);
    return setup;
  }

  function evaluator(options?: AutoTopUpHookOptions, runtime = world.provider) {
    return SpendingPolicyEvaluator.create({
      db: world.db,
      autoTopUp: runtime.autoTopUpHook(options),
    });
  }

  async function spend(
    evaluatorPromise: ReturnType<typeof evaluator>,
    tenantId: string,
    estimatedAmount: number,
  ) {
    const policyEvaluator = await evaluatorPromise;
    return system(() =>
      policyEvaluator.evaluate({
        tenantId,
        metricKey: 'ai.tokens',
        estimatedAmount,
        currency: 'USD',
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Units
  // -------------------------------------------------------------------------

  describe('ISO 4217 minor units', () => {
    it('uses the ISO exponent, not the runtime display digits', () => {
      const expected: Record<string, number> = {
        USD: 2,
        CAD: 2,
        RSD: 2,
        MGA: 2,
        ALL: 2,
        JPY: 0,
        ISK: 0,
        UGX: 0,
        CLP: 0,
        IQD: 3,
        KWD: 3,
        BHD: 3,
        CLF: 4,
        UYW: 4,
      };
      for (const [code, exponent] of Object.entries(expected)) {
        expect(currencyMinorUnitExponent(code), code).toBe(exponent);
      }
      expect(minorToMajorUnits(1500, 'IQD')).toBe(1.5);
      expect(majorToMinorUnits(1.5, 'IQD')).toBe(1500);
      expect(minorToMajorUnits(15_000, 'MGA')).toBe(150);
      expect(minorToMajorUnits(1999, 'RSD')).toBe(19.99);
    });

    it('does not follow Intl display digits when they change', () => {
      // CLDR/ICU data drifts between Node releases (RSD has shown 0 and 2);
      // the exponent must not.
      const RealNumberFormat = Intl.NumberFormat;
      vi.spyOn(Intl, 'NumberFormat').mockImplementation(((
        locales?: string | string[],
        options?: Intl.NumberFormatOptions,
      ) => {
        const real = new RealNumberFormat(locales, options);
        return new Proxy(real, {
          get(target, key) {
            if (key === 'resolvedOptions') {
              return () => ({
                ...target.resolvedOptions(),
                maximumFractionDigits: 0,
              });
            }
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }) as unknown as typeof Intl.NumberFormat);
      expect(currencyMinorUnitExponent('RSD')).toBe(2);
      expect(currencyMinorUnitExponent('USD')).toBe(2);
      expect(minorToMajorUnits(1999, 'RSD')).toBe(19.99);
    });
  });

  // -------------------------------------------------------------------------
  // Customers
  // -------------------------------------------------------------------------

  describe('provider customers', () => {
    it('creates one provider customer per account across lost responses and edits', async () => {
      const account = await world.provider.getAccount(SOLO);
      if (!account) throw new Error('missing account');
      // Stripe creates the customer, but the response is lost.
      world.stripe.fail('POST', /^\/v1\/customers$/, 'after');
      await expect(
        world.provider.ensureProviderCustomer(account),
      ).rejects.toThrow();
      expect(world.stripe.customers.size).toBe(1);

      // The retry, with the payer's details edited in between, finds it.
      await system(() =>
        world.provider.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo Incorporated',
          billingAddress: { country: 'US', postalCode: '10001' },
        }),
      );
      const fresh = await world.provider.getAccount(SOLO);
      if (!fresh) throw new Error('missing account');
      const synced = await world.provider.ensureProviderCustomer(fresh);
      expect(world.stripe.customers.size).toBe(1);
      const customer = world.stripe.customers.get(synced.providerCustomerId);
      expect(customer).toMatchObject({
        name: 'Solo Incorporated',
        address: { country: 'US', postal_code: '10001' },
        metadata: { local_id: String(account.id) },
      });
      // Found by the account tag, so no second create was sent.
      const keys = world.stripe.requests
        .filter((request) => request.path === '/v1/customers')
        .map((request) => request.key);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^smrt-billing-customer:/);
    });

    it('replays the create by its key while the customer search lags', async () => {
      const account = await world.provider.getAccount(NETWORK);
      if (!account) throw new Error('missing account');
      world.stripe.searchable = false;
      world.stripe.fail('POST', /^\/v1\/customers$/, 'after');
      await expect(
        world.provider.ensureProviderCustomer(account),
      ).rejects.toThrow();
      const synced = await world.provider.ensureProviderCustomer(account);
      expect(world.stripe.customers.size).toBe(1);
      expect(world.stripe.customers.has(synced.providerCustomerId)).toBe(true);
      const keys = world.stripe.requests
        .filter((request) => request.path === '/v1/customers')
        .map((request) => request.key);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });
  });

  // -------------------------------------------------------------------------
  // Credit purchases
  // -------------------------------------------------------------------------

  describe('taxed credit purchases', () => {
    it('grants the credit, books the collected total, and moves tax to tax payable', async () => {
      const policy = await balancePolicy(NETWORK);
      const checkout = await withTenant({ tenantId: NETWORK }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(policy.id),
          amount: 10_000,
          purchaseId: 'cart-tax',
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
        }),
      );
      const session = world.stripe.completeSession(checkout.sessionId, {
        address: { country: 'CA' },
      });
      expect(session).toMatchObject({
        automatic_tax: true,
        amount_subtotal: 10_000,
        amount_tax: 1300,
        amount_total: 11_300,
      });
      await deliver(world, checkoutEvent(session));
      await deliver(world, checkoutEvent(session)); // redelivery with a new id
      expect((await grantsOf(NETWORK)).map((grant) => grant.amount)).toEqual([
        10_000,
      ]);
      const payments = await sellerPayments();
      expect(payments.map((payment) => payment.amount)).toEqual([11_300]);
      const journals = await sellerJournals();
      expect(journals).toHaveLength(2);
      const balances = await withTenant({ tenantId: PROVIDER }, async () => {
        const totals = new Map<string, number>();
        for (const journal of journals) {
          for (const entry of await journal.getEntries()) {
            totals.set(
              entry.accountId,
              (totals.get(entry.accountId) ?? 0) +
                Number(entry.debit ?? 0) -
                Number(entry.credit ?? 0),
            );
          }
        }
        return totals;
      });
      expect(balances.get(world.ledger.cashAccountId)).toBe(11_300);
      expect(balances.get(world.ledger.prepaidCreditAccountId)).toBe(-10_000);
      expect(balances.get(world.ledger.taxAccountId)).toBe(-1300);
    });

    it('does not tax an exempt payer, and honours an explicit override', async () => {
      await system(() =>
        world.provider.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo LLC',
          taxExempt: true,
        }),
      );
      const policy = await balancePolicy(SOLO);
      const exempt = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(policy.id),
          amount: 500,
          purchaseId: 'exempt',
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
        }),
      );
      expect(world.stripe.sessions.get(exempt.sessionId)?.automatic_tax).toBe(
        false,
      );
      const other = await balancePolicy(NETWORK);
      const untaxed = await withTenant({ tenantId: NETWORK }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(other.id),
          amount: 500,
          purchaseId: 'untaxed',
          automaticTax: false,
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
        }),
      );
      expect(world.stripe.sessions.get(untaxed.sessionId)?.automatic_tax).toBe(
        false,
      );
    });

    it('saves the card of a purchase that asked to, as the default', async () => {
      const policy = await balancePolicy(SOLO);
      const checkout = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(policy.id),
          amount: 2000,
          purchaseId: 'save-card',
          savePaymentMethod: true,
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
        }),
      );
      const stored = world.stripe.sessions.get(checkout.sessionId);
      expect(stored).toMatchObject({
        setup_future_usage: 'off_session',
        customer_update_address: true,
      });
      const session = world.stripe.completeSession(checkout.sessionId, {
        paymentMethod: 'pm_saved',
      });
      await deliver(world, checkoutEvent(session));
      const account = await world.provider.getAccount(SOLO);
      expect(
        world.stripe.customers.get(String(account?.providerCustomerId))
          ?.default_payment_method,
      ).toBe('pm_saved');
      expect((await grantsOf(SOLO)).map((grant) => grant.amount)).toEqual([
        2000,
      ]);
    });

    it('adopts the address a card-saving purchase collected as the tax location', async () => {
      await system(() =>
        world.provider.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo LLC',
          billingAddress: {},
        }),
      );
      const policy = await balancePolicy(SOLO);
      const checkout = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCreditCheckout({
          spendingPolicyId: String(policy.id),
          amount: 2000,
          purchaseId: 'save-card-address',
          savePaymentMethod: true,
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
        }),
      );
      const session = world.stripe.completeSession(checkout.sessionId, {
        paymentMethod: 'pm_with_address',
        address: { country: 'CA', postal_code: 'T0L 0A0' },
      });
      await deliver(world, checkoutEvent(session));
      const account = await world.provider.getAccount(SOLO);
      const customer = await withTenant({ tenantId: PROVIDER }, async () =>
        (await CustomerCollection.create({ db: world.db })).get(
          String(account?.customerId),
        ),
      );
      expect(customer?.defaultBillingAddress).toMatchObject({ country: 'CA' });
      // Period close can now tax this payer.
      await world.usage(SOLO);
      const result = await world.provider.closePeriod(period);
      expect(result.groups.every((group) => group.outcome !== 'failed')).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Card on file
  // -------------------------------------------------------------------------

  describe('card on file', () => {
    it('saves the card, makes it the default, and adopts the collected address', async () => {
      await system(() =>
        world.provider.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo LLC',
          billingAddress: {},
        }),
      );
      const setup = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCardSetupCheckout({
          payerTenantId: SOLO,
          currency: 'usd',
          setupId: 'signup',
          successUrl: 'https://a.test/ok',
          cancelUrl: 'https://a.test/cancel',
        }),
      );
      const stored = world.stripe.sessions.get(setup.sessionId);
      expect(stored).toMatchObject({
        mode: 'setup',
        currency: 'usd',
        billing_address_collection: 'required',
        customer_update_address: true,
      });
      const session = world.stripe.completeSession(setup.sessionId, {
        paymentMethod: 'pm_signup',
        address: { country: 'CA', postal_code: 'T0L 0A0', state: 'AB' },
      });
      const event = checkoutEvent(session);
      await deliver(world, event);
      await deliver(world, event); // duplicate delivery: deduplicated
      await deliver(world, checkoutEvent(session)); // redelivery: idempotent

      const account = await world.provider.getAccount(SOLO);
      if (!account) throw new Error('missing account');
      expect(
        world.stripe.customers.get(account.providerCustomerId)
          ?.default_payment_method,
      ).toBe('pm_signup');
      const instruments = await withTenant({ tenantId: PROVIDER }, async () =>
        (await PaymentInstrumentCollection.create({ db: world.db })).list({}),
      );
      expect(instruments).toHaveLength(1);
      expect(instruments[0]).toMatchObject({
        customerId: account.customerId,
        backendId: 'stripe',
        providerCustomerId: account.providerCustomerId,
        providerPaymentMethodId: 'pm_signup',
        isDefault: true,
      });
      const customer = await withTenant({ tenantId: PROVIDER }, async () =>
        (await CustomerCollection.create({ db: world.db })).get(
          account.customerId,
        ),
      );
      expect(customer?.defaultBillingAddress).toMatchObject({
        country: 'CA',
        postalCode: 'T0L 0A0',
      });
      expect(
        (await deliveries(world)).every((row) => row.status === 'completed'),
      ).toBe(true);

      // A second card replaces the default.
      await saveCard(SOLO, 'pm_second');
      const after = await withTenant({ tenantId: PROVIDER }, async () =>
        (await PaymentInstrumentCollection.create({ db: world.db })).list({
          orderBy: 'created_at ASC',
        }),
      );
      expect(
        after.map((row) => [row.providerPaymentMethodId, row.isDefault]),
      ).toEqual([
        ['pm_signup', false],
        ['pm_second', true],
      ]);
    });

    it('keeps the local address when the setup did not collect one', async () => {
      // SOLO has a tax location, so the setup does not collect an address.
      const setup = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCardSetupCheckout({
          payerTenantId: SOLO,
          currency: 'USD',
          setupId: 'keep-address',
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
        }),
      );
      expect(world.stripe.sessions.get(setup.sessionId)).toMatchObject({
        billing_address_collection: null,
        customer_update_address: false,
      });
      const account = await world.provider.getAccount(SOLO);
      if (!account) throw new Error('missing account');
      // The provider's copy differs (for example edited in its dashboard).
      const remote = world.stripe.customers.get(account.providerCustomerId);
      if (remote) remote.address = { country: 'CA' };
      const session = world.stripe.completeSession(setup.sessionId, {
        paymentMethod: 'pm_keep',
      });
      await deliver(world, checkoutEvent(session));
      const customer = await withTenant({ tenantId: PROVIDER }, async () =>
        (await CustomerCollection.create({ db: world.db })).get(
          account.customerId,
        ),
      );
      expect(customer?.defaultBillingAddress).toMatchObject({
        country: 'US',
        postalCode: '94107',
      });
    });

    it('lets only the payer start a card setup', async () => {
      await expect(
        withTenant({ tenantId: STRANGER }, () =>
          world.provider.createCardSetupCheckout({
            payerTenantId: SOLO,
            currency: 'USD',
            setupId: 'x',
            successUrl: 'https://a.test',
            cancelUrl: 'https://a.test',
          }),
        ),
      ).rejects.toBeInstanceOf(TenantIsolationError);
      expect(world.stripe.sessions.size).toBe(0);
    });

    it('ignores forged setups and refuses a card saved for another customer', async () => {
      const account = await world.provider.getAccount(SOLO);
      const forged = signedEvent(
        checkoutEvent({
          id: 'cs_forged_setup',
          mode: 'setup',
          currency: 'usd',
          amount_subtotal: null,
          metadata: {
            smrt_purpose: 'card_setup',
            smrt_seller: PROVIDER,
            smrt_payer: SOLO,
            smrt_account: String(account?.id),
            smrt_sig: 'a'.repeat(64),
          },
        }),
      );
      expect(
        await world.provider.acceptWebhook(forged.payload, forged.signature),
      ).toMatchObject({
        accepted: false,
        type: 'checkout.session.completed:unverified_card_setup',
      });

      const setup = await withTenant({ tenantId: SOLO }, () =>
        world.provider.createCardSetupCheckout({
          payerTenantId: SOLO,
          currency: 'USD',
          setupId: 'moved',
          successUrl: 'https://a.test',
          cancelUrl: 'https://a.test',
        }),
      );
      const session = world.stripe.completeSession(setup.sessionId, {
        paymentMethod: 'pm_elsewhere',
      });
      const network = await world.provider.getAccount(NETWORK);
      if (!network) throw new Error('missing account');
      session.customer = (
        await world.provider.ensureProviderCustomer(network)
      ).providerCustomerId;
      await deliver(world, checkoutEvent(session));
      const [row] = await deliveries(world);
      expect(row?.status).toBe('retry');
      expect(row?.last_error).toContain('not its billing account');
      const instruments = await withTenant({ tenantId: PROVIDER }, async () =>
        (await PaymentInstrumentCollection.create({ db: world.db })).list({}),
      );
      expect(instruments).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Automatically charged invoices
  // -------------------------------------------------------------------------

  describe('automatically charged invoices', () => {
    async function autoRuntime() {
      return BillingRuntime.create({
        db: world.db,
        sellerTenantId: PROVIDER,
        kind: 'provider',
        provider: world.provider.provider,
        billingRelationships: world.relationships,
        ledger: world.ledger,
        autoChargeInvoices: true,
      });
    }

    it('charges payers with a card on file and settles on the paid event, not on send', async () => {
      const runtime = await autoRuntime();
      await saveCard(SOLO, 'pm_auto', 'succeed', runtime);
      await world.usage(SOLO);
      await world.usage(SITE); // NETWORK pays for SITE, with no card on file
      await runtime.closePeriod(period);

      const invoices = [...world.stripe.invoices.values()];
      const soloAccount = await runtime.getAccount(SOLO);
      const networkAccount = await runtime.getAccount(NETWORK);
      const byCustomer = (customer?: string) =>
        invoices.find((invoice) => invoice.customer === customer);
      const auto = byCustomer(soloAccount?.providerCustomerId);
      const manual = byCustomer(networkAccount?.providerCustomerId);
      expect(auto).toMatchObject({
        collection_method: 'charge_automatically',
        due_date: null,
        status: 'open',
        auto_advance: true,
        finalized: 1,
        sent: 0,
      });
      expect(manual).toMatchObject({
        collection_method: 'send_invoice',
        sent: 1,
        finalized: 0,
      });

      // Sent is not paid: the payer is not current until Stripe collects.
      const local = await withTenant({ tenantId: PROVIDER }, async () =>
        (await InvoiceCollection.create({ db: world.db })).findByExternalId(
          String(auto?.id),
        ),
      );
      expect(local?.status).toBe(InvoiceStatus.SENT);
      expect(await sellerPayments()).toEqual([]);

      expect(world.stripe.collect(String(auto?.id))).toBe('paid');
      await deliver(
        world,
        invoiceEvent('invoice.paid', String(auto?.id)),
        runtime,
      );
      const paid = await withTenant({ tenantId: PROVIDER }, async () =>
        (await InvoiceCollection.create({ db: world.db })).findByExternalId(
          String(auto?.id),
        ),
      );
      expect(paid?.status).toBe(InvoiceStatus.PAID);
      expect((await sellerPayments()).map((row) => row.amount)).toEqual([
        auto?.total,
      ]);
    });

    it('marks the payer past due when the automatic charge fails', async () => {
      const runtime = await autoRuntime();
      await saveCard(SOLO, 'pm_declines', 'decline', runtime);
      await world.usage(SOLO);
      await runtime.closePeriod(period);
      const soloAccount = await runtime.getAccount(SOLO);
      const invoice = [...world.stripe.invoices.values()].find(
        (row) => row.customer === soloAccount?.providerCustomerId,
      );
      expect(world.stripe.collect(String(invoice?.id))).toBe('failed');
      await deliver(
        world,
        invoiceEvent('invoice.payment_failed', String(invoice?.id)),
        runtime,
      );
      expect((await runtime.getAccount(SOLO))?.standing).toBe('past_due');
    });

    it('keeps the collection method of an invoice already created when a card is saved before the retry', async () => {
      const runtime = await autoRuntime();
      await world.usage(SOLO);
      // Stripe creates the invoice (send_invoice), but the response is lost.
      world.stripe.fail('POST', /^\/v1\/invoices$/, 'after');
      await expect(runtime.closePeriod(period)).rejects.toThrow();
      await saveCard(SOLO, 'pm_late', 'succeed', runtime);
      await runtime.closePeriod(period);
      const soloAccount = await runtime.getAccount(SOLO);
      const invoices = [...world.stripe.invoices.values()].filter(
        (row) => row.customer === soloAccount?.providerCustomerId,
      );
      // The retry finds the created invoice by its local id instead of
      // reusing the key with other parameters, and sends it for payment.
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({
        collection_method: 'send_invoice',
        sent: 1,
      });
    });

    it('sends invoices when the runtime does not auto-charge, card or not', async () => {
      await saveCard(SOLO, 'pm_ignored');
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      for (const invoice of world.stripe.invoices.values()) {
        expect(invoice.collection_method).toBe('send_invoice');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Write-offs
  // -------------------------------------------------------------------------

  describe('uncollectible invoices', () => {
    it('writes an invoice off, marks the payer uncollectible, and reinstates on payment', async () => {
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      const [local] = await withTenant({ tenantId: PROVIDER }, async () => {
        const account = await world.provider.getAccount(SOLO);
        return (await InvoiceCollection.create({ db: world.db })).list({
          where: { customerId: account?.customerId },
        });
      });
      if (!local?.id) throw new Error('missing invoice');
      await system(() =>
        world.provider.markInvoiceUncollectible(String(local.id)),
      );
      const externalId = String(local.externalId);
      expect(world.stripe.invoices.get(externalId)?.status).toBe(
        'uncollectible',
      );
      expect(
        await world.provider.provider.getInvoice(externalId),
      ).toMatchObject({ status: 'uncollectible' });
      // Any event re-reads the invoice: even a failure notice after the
      // write-off lands on uncollectible.
      await deliver(world, invoiceEvent('invoice.payment_failed', externalId));
      expect((await world.provider.getAccount(SOLO))?.standing).toBe(
        'uncollectible',
      );
      await deliver(
        world,
        invoiceEvent('invoice.marked_uncollectible', externalId),
      );
      expect(world.standingChanges.map((change) => change.standing)).toEqual([
        'uncollectible',
      ]);

      world.stripe.pay(externalId);
      await deliver(world, invoiceEvent('invoice.paid', externalId));
      expect((await world.provider.getAccount(SOLO))?.standing).toBe('current');
    });

    it('writes off an overdue invoice so paying another reinstates the payer', async () => {
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      const account = await world.provider.getAccount(SOLO);
      const listFor = () =>
        withTenant({ tenantId: PROVIDER }, async () =>
          (await InvoiceCollection.create({ db: world.db })).list({
            where: { customerId: account?.customerId },
            orderBy: 'invoiceNumber ASC',
          }),
        );
      const [first] = await listFor();
      const firstId = String(first?.externalId);
      await deliver(world, invoiceEvent('invoice.overdue', firstId));
      expect((await listFor())[0]?.status).toBe(InvoiceStatus.OVERDUE);
      await system(() =>
        world.provider.markInvoiceUncollectible(String(first?.id)),
      );
      await deliver(
        world,
        invoiceEvent('invoice.marked_uncollectible', firstId),
      );
      expect((await listFor())[0]?.status).toBe(InvoiceStatus.WRITTEN_OFF);
      expect((await world.provider.getAccount(SOLO))?.standing).toBe(
        'uncollectible',
      );

      // The next period's invoice is paid: the written-off one no longer
      // counts as overdue.
      const next = {
        periodStart: period.periodEnd,
        periodEnd: new Date(
          Date.UTC(
            period.periodEnd.getUTCFullYear(),
            period.periodEnd.getUTCMonth() + 1,
            1,
          ),
        ),
      };
      await world.provider.closePeriod({
        ...next,
        now: new Date(next.periodEnd.getTime() + 86_400_000),
      });
      const second = (await listFor()).find((row) => row.id !== first?.id);
      world.stripe.pay(String(second?.externalId));
      await deliver(
        world,
        invoiceEvent('invoice.paid', String(second?.externalId)),
      );
      expect((await world.provider.getAccount(SOLO))?.standing).toBe('current');
      // A late event about the written-off invoice does not undo that.
      await deliver(world, invoiceEvent('invoice.payment_failed', firstId));
      await deliver(
        world,
        invoiceEvent('invoice.marked_uncollectible', firstId),
      );
      expect((await world.provider.getAccount(SOLO))?.standing).toBe('current');

      // The written-off invoice paid late records the payment and stays
      // written off.
      world.stripe.pay(firstId);
      await deliver(world, invoiceEvent('invoice.paid', firstId));
      expect(
        (await listFor()).find((row) => row.id === first?.id)?.status,
      ).toBe(InvoiceStatus.WRITTEN_OFF);
      expect((await sellerPayments()).map((row) => row.status)).toEqual([
        PaymentStatus.COMPLETED,
        PaymentStatus.COMPLETED,
      ]);
      expect(
        (await deliveries(world)).every((row) => row.status === 'completed'),
      ).toBe(true);
    });

    it('marks the payer uncollectible when an invoice parked before its send is written off', async () => {
      await world.usage(SOLO);
      // The send reaches Stripe, but its total disagrees with the local
      // invoice, so the close parks with the local invoice still a draft.
      const original = world.provider.provider.getInvoice;
      vi.spyOn(world.provider.provider, 'getInvoice').mockImplementation(
        async (id) => {
          const state = await original.call(world.provider.provider, id);
          return state.status === 'draft'
            ? state
            : { ...state, subtotal: state.subtotal + 1 };
        },
      );
      await expect(world.provider.closePeriod(period)).rejects.toThrow();
      vi.restoreAllMocks();
      const account = await world.provider.getAccount(SOLO);
      const [local] = await withTenant({ tenantId: PROVIDER }, async () =>
        (await InvoiceCollection.create({ db: world.db })).list({
          where: { customerId: account?.customerId },
        }),
      );
      expect(local?.status).toBe(InvoiceStatus.DRAFT);
      const externalId = String(local?.externalId);
      world.stripe.setInvoiceStatus(externalId, 'uncollectible');
      await deliver(
        world,
        invoiceEvent('invoice.marked_uncollectible', externalId),
      );
      expect((await world.provider.getAccount(SOLO))?.standing).toBe(
        'uncollectible',
      );
      const listed = async () =>
        (
          await withTenant({ tenantId: PROVIDER }, async () =>
            (
              await InvoiceCollection.create({ db: world.db })
            ).list({
              where: { customerId: account?.customerId },
            }),
          )
        ).find((row) => row.id === local?.id);
      expect((await listed())?.status).toBe(InvoiceStatus.WRITTEN_OFF);

      // Reinstated by paying the next invoice; a late event about the parked
      // one does not undo it.
      const next = {
        periodStart: period.periodEnd,
        periodEnd: new Date(
          Date.UTC(
            period.periodEnd.getUTCFullYear(),
            period.periodEnd.getUTCMonth() + 1,
            1,
          ),
        ),
      };
      await world.provider.closePeriod({
        ...next,
        now: new Date(next.periodEnd.getTime() + 86_400_000),
      });
      const second = (
        await withTenant({ tenantId: PROVIDER }, async () =>
          (
            await InvoiceCollection.create({ db: world.db })
          ).list({
            where: { customerId: account?.customerId },
          }),
        )
      ).find((row) => row.id !== local?.id);
      world.stripe.pay(String(second?.externalId));
      await deliver(
        world,
        invoiceEvent('invoice.paid', String(second?.externalId)),
      );
      expect((await world.provider.getAccount(SOLO))?.standing).toBe('current');
      await deliver(world, invoiceEvent('invoice.payment_failed', externalId));
      expect((await world.provider.getAccount(SOLO))?.standing).toBe('current');

      // The parked close, its mismatch resolved, still completes.
      const result = await world.provider.closePeriod(period);
      expect(result.groups.every((group) => group.outcome !== 'failed')).toBe(
        true,
      );
      expect((await listed())?.status).toBe(InvoiceStatus.WRITTEN_OFF);
    });

    it('refuses to write off an invoice that is not sent and unpaid', async () => {
      await world.usage(SOLO);
      await world.provider.closePeriod(period);
      const [local] = await withTenant({ tenantId: PROVIDER }, async () => {
        const account = await world.provider.getAccount(SOLO);
        return (await InvoiceCollection.create({ db: world.db })).list({
          where: { customerId: account?.customerId },
        });
      });
      world.stripe.pay(String(local?.externalId));
      await deliver(
        world,
        invoiceEvent('invoice.paid', String(local?.externalId)),
      );
      await expect(
        system(() =>
          world.provider.markInvoiceUncollectible(String(local?.id)),
        ),
      ).rejects.toThrow(/not a sent, unpaid/);
    });
  });

  // -------------------------------------------------------------------------
  // Automatic top-ups
  // -------------------------------------------------------------------------

  describe('automatic top-ups', () => {
    // Taxed accounts are not topped up by default (no tax on an off-session
    // charge); these payers are untaxed unless a test says otherwise.
    beforeEach(async () => {
      await system(async () => {
        await world.provider.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo LLC',
          automaticTax: false,
        });
        await world.provider.upsertAccount({
          payerTenantId: NETWORK,
          name: 'Network Co',
          automaticTax: false,
        });
      });
    });

    it('still settles an attempt charged before the account became taxed', async () => {
      await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_became_taxed', 'processing');
      await spend(evaluator(), SOLO, 500);
      const [intent] = [...world.stripe.paymentIntents.values()];
      world.stripe.settlePaymentIntent(String(intent?.id), 'succeeded');
      await system(() =>
        world.provider.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo LLC',
          automaticTax: true,
        }),
      );
      // The re-drive of the pending attempt is not blocked by the tax skip.
      await spend(evaluator({ recheckAfterMs: 0 }), SOLO, 500);
      expect(world.stripe.paymentIntents.size).toBe(1);
      expect((await grantsOf(SOLO)).map((grant) => grant.amount)).toEqual([
        500,
      ]);
      expect((await sellerPayments())[0]?.status).toBe(PaymentStatus.COMPLETED);
    });

    it('does not top up a taxed payer unless the seller opts in', async () => {
      await system(() =>
        world.provider.upsertAccount({
          payerTenantId: SOLO,
          name: 'Solo LLC',
          automaticTax: true,
        }),
      );
      await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_taxed');
      expect(await spend(evaluator(), SOLO, 500)).toMatchObject({
        allowed: false,
      });
      expect(world.stripe.paymentIntents.size).toBe(0);
      expect(await sellerPayments()).toEqual([]);
      expect(
        await spend(evaluator({ taxedAccounts: 'charge_untaxed' }), SOLO, 500),
      ).toMatchObject({ allowed: true });
      expect(world.stripe.paymentIntents.size).toBe(1);
    });
    it('charges the saved card once and credits the balance exactly once', async () => {
      const policy = await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_topup');
      const decision = await spend(evaluator(), SOLO, 700);
      expect(decision).toMatchObject({ allowed: true, balanceAmount: 700 });

      const intents = [...world.stripe.paymentIntents.values()];
      expect(intents).toHaveLength(1);
      expect(intents[0]).toMatchObject({
        amount: 700,
        currency: 'usd',
        payment_method: 'pm_topup',
        status: 'succeeded',
      });
      const chargeKey = intents[0]?.metadata.hv_charge_key;
      expect(chargeKey).toMatch(/^smrt-auto-top-up:/);
      const grants = await grantsOf(SOLO);
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        amount: 700,
        source: 'stripe-auto-top-up',
        sourceId: chargeKey,
        spendingPolicyId: String(policy.id),
      });
      const [payment] = await sellerPayments();
      expect(payment).toMatchObject({
        amount: 700,
        status: PaymentStatus.COMPLETED,
        externalId: intents[0]?.id,
      });

      // Stripe's own success event arrives afterwards: nothing is added.
      await deliver(
        world,
        paymentIntentEvent('payment_intent.succeeded', intents[0] ?? {}),
      );
      expect(await grantsOf(SOLO)).toHaveLength(1);
      expect(await sellerJournals()).toHaveLength(1);
      expect(
        (await deliveries(world)).every((row) => row.status === 'completed'),
      ).toBe(true);

      // The balance now covers the same spend: no new charge.
      await spend(evaluator(), SOLO, 700);
      expect(world.stripe.paymentIntents.size).toBe(1);
    });

    it('lets only one of several concurrent evaluations charge', async () => {
      await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_race');
      const decisions = await Promise.all(
        Array.from({ length: 5 }, () => spend(evaluator(), SOLO, 300)),
      );
      expect(world.stripe.paymentIntents.size).toBe(1);
      expect((await grantsOf(SOLO)).map((grant) => grant.amount)).toEqual([
        300,
      ]);
      expect((await sellerPayments()).map((row) => row.status)).toEqual([
        PaymentStatus.COMPLETED,
      ]);
      expect(await sellerJournals()).toHaveLength(1);
      expect(decisions.some((decision) => decision.allowed)).toBe(true);
    });

    it('settles concurrent hook and webhook settlements of one charge once', async () => {
      await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_processing', 'processing');
      await spend(evaluator(), SOLO, 400);
      const [attempt] = await sellerPayments();
      if (!attempt?.id) throw new Error('missing attempt');
      const outcome = {
        status: 'succeeded' as const,
        amount: 400,
        currency: 'USD',
      };
      const settle = () =>
        withTenant({ tenantId: PROVIDER }, () =>
          world.db.transaction?.((tx) =>
            applyAutoTopUpOutcome(
              world.provider,
              tx,
              String(attempt.id),
              outcome,
            ).then(() => undefined),
          ),
        );
      await Promise.all([settle(), settle(), settle()]);
      expect((await grantsOf(SOLO)).map((grant) => grant.amount)).toEqual([
        400,
      ]);
      expect(await sellerJournals()).toHaveLength(1);
    });

    it('credits a processing charge from its webhook, once', async () => {
      await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_slow', 'processing');
      const first = await spend(evaluator(), SOLO, 500);
      expect(first).toMatchObject({ allowed: false });
      expect(await grantsOf(SOLO)).toEqual([]);
      const [attempt] = await sellerPayments();
      expect(attempt?.status).toBe(PaymentStatus.PENDING);

      // While it is in flight, no second charge is made.
      await spend(evaluator(), SOLO, 500);
      expect(world.stripe.paymentIntents.size).toBe(1);

      const [intent] = [...world.stripe.paymentIntents.values()];
      await deliver(
        world,
        paymentIntentEvent('payment_intent.processing', intent ?? {}),
      );
      expect(await grantsOf(SOLO)).toEqual([]);
      const settled = world.stripe.settlePaymentIntent(
        String(intent?.id),
        'succeeded',
      );
      const success = paymentIntentEvent('payment_intent.succeeded', settled);
      await deliver(world, success);
      await deliver(world, success);
      expect((await grantsOf(SOLO)).map((grant) => grant.amount)).toEqual([
        500,
      ]);
      expect((await sellerPayments())[0]?.status).toBe(PaymentStatus.COMPLETED);

      // A re-drive now finds the charge settled and adds nothing.
      await spend(evaluator({ recheckAfterMs: 0 }), SOLO, 400);
      expect(world.stripe.paymentIntents.size).toBe(1);
      expect(await grantsOf(SOLO)).toHaveLength(1);
      expect(await sellerJournals()).toHaveLength(1);
    });

    it('closes a declined charge, reports it once, and waits before retrying', async () => {
      const failures: AutoTopUpFailure[] = [];
      const runtime = await BillingRuntime.create({
        db: world.db,
        sellerTenantId: PROVIDER,
        kind: 'provider',
        provider: world.provider.provider,
        billingRelationships: world.relationships,
        ledger: world.ledger,
        onAutoTopUpFailed: (failure) => {
          failures.push(failure);
        },
      });
      await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_declined', 'decline', runtime);
      const decision = await spend(evaluator({}, runtime), SOLO, 500);
      expect(decision).toMatchObject({ allowed: false, state: 'blocked' });
      expect(await grantsOf(SOLO)).toEqual([]);
      expect((await sellerPayments()).map((row) => row.status)).toEqual([
        PaymentStatus.FAILED,
      ]);
      expect(failures).toMatchObject([
        { status: 'failed', failureCode: 'card_declined', amount: 500 },
      ]);

      // The decline event, delivered later, changes nothing.
      const [intent] = [...world.stripe.paymentIntents.values()];
      await deliver(
        world,
        paymentIntentEvent('payment_intent.payment_failed', intent ?? {}),
        runtime,
      );
      expect(failures).toHaveLength(1);

      // Inside the retry window no new charge; after it, a new attempt.
      await spend(evaluator({}, runtime), SOLO, 500);
      expect(world.stripe.paymentIntents.size).toBe(1);
      world.stripe.cards.set('pm_declined', 'succeed');
      await spend(evaluator({ retryAfterMs: 0 }, runtime), SOLO, 500);
      expect(world.stripe.paymentIntents.size).toBe(2);
      expect((await grantsOf(SOLO)).map((grant) => grant.amount)).toEqual([
        500,
      ]);
    });

    it('treats an authentication requirement as no charge', async () => {
      const failures: AutoTopUpFailure[] = [];
      const runtime = await BillingRuntime.create({
        db: world.db,
        sellerTenantId: PROVIDER,
        kind: 'provider',
        provider: world.provider.provider,
        billingRelationships: world.relationships,
        ledger: world.ledger,
        onAutoTopUpFailed: (failure) => {
          failures.push(failure);
        },
      });
      await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_3ds', 'authentication_required', runtime);
      await spend(evaluator({}, runtime), SOLO, 500);
      expect(await grantsOf(SOLO)).toEqual([]);
      expect(failures).toMatchObject([
        { status: 'requires_action', failureCode: 'authentication_required' },
      ]);
    });

    it('fails a processing charge from its webhook', async () => {
      const failures: AutoTopUpFailure[] = [];
      const runtime = await BillingRuntime.create({
        db: world.db,
        sellerTenantId: PROVIDER,
        kind: 'provider',
        provider: world.provider.provider,
        billingRelationships: world.relationships,
        ledger: world.ledger,
        onAutoTopUpFailed: (failure) => {
          failures.push(failure);
        },
      });
      await balancePolicy(SOLO);
      await saveCard(SOLO, 'pm_bank', 'processing', runtime);
      await spend(evaluator({}, runtime), SOLO, 500);
      const [intent] = [...world.stripe.paymentIntents.values()];
      const failed = world.stripe.settlePaymentIntent(
        String(intent?.id),
        'failed',
      );
      await deliver(
        world,
        paymentIntentEvent('payment_intent.payment_failed', failed),
        runtime,
      );
      expect((await sellerPayments()).map((row) => row.status)).toEqual([
        PaymentStatus.FAILED,
      ]);
      expect(failures).toMatchObject([{ status: 'failed' }]);
      expect(await grantsOf(SOLO)).toEqual([]);
    });

    it('charges the parent that set a delegated balance', async () => {
      await balancePolicy(SITE, NETWORK);
      await saveCard(NETWORK, 'pm_parent');
      const decision = await spend(evaluator(), SITE, 250);
      expect(decision).toMatchObject({ allowed: true });
      const network = await world.provider.getAccount(NETWORK);
      expect([...world.stripe.paymentIntents.values()][0]?.customer).toBe(
        network?.providerCustomerId,
      );
      expect(await grantsOf(SITE)).toMatchObject([
        { amount: 250, grantedByTenantId: NETWORK },
      ]);
    });

    it('does nothing without a saved card or a provider that can charge one', async () => {
      await balancePolicy(SOLO);
      // No provider customer: no card to charge.
      expect(await spend(evaluator(), SOLO, 500)).toMatchObject({
        allowed: false,
      });
      expect(world.stripe.paymentIntents.size).toBe(0);

      // A push-payment rail omits the capability.
      const { chargeSavedPaymentMethod: _omit, ...rail } = world.provider
        .provider as BillingProvider;
      const pushOnly = await BillingRuntime.create({
        db: world.db,
        sellerTenantId: PROVIDER,
        kind: 'provider',
        provider: rail,
        billingRelationships: world.relationships,
        ledger: world.ledger,
      });
      await saveCard(SOLO, 'pm_unused');
      expect(await spend(evaluator({}, pushOnly), SOLO, 500)).toMatchObject({
        allowed: false,
      });
      expect(world.stripe.paymentIntents.size).toBe(0);
    });

    it('saves a card and tops up under strict tenancy', async () => {
      await balancePolicy(SOLO);
      // The production host setting: unflagged raw SQL on tenant-scoped
      // classes is refused.
      enableTenancy({ rawQueryPolicy: 'throw' });
      try {
        await saveCard(SOLO, 'pm_strict', 'processing');
        await spend(evaluator(), SOLO, 300);
        const [intent] = [...world.stripe.paymentIntents.values()];
        await deliver(
          world,
          paymentIntentEvent(
            'payment_intent.succeeded',
            world.stripe.settlePaymentIntent(String(intent?.id), 'succeeded'),
          ),
        );
      } finally {
        disableTenancy();
      }
      expect(
        (await deliveries(world)).map((row) => [row.status, row.last_error]),
      ).toEqual([
        ['completed', null],
        ['completed', null],
      ]);
      expect((await grantsOf(SOLO)).map((grant) => grant.amount)).toEqual([
        300,
      ]);
    });

    it('ignores payment events that are not its own top-ups', async () => {
      const foreign = await deliver(
        world,
        paymentIntentEvent('payment_intent.succeeded', {
          id: 'pi_foreign',
          object: 'payment_intent',
          amount: 100,
          currency: 'usd',
          status: 'succeeded',
          metadata: { hv_charge_key: 'someone-else:1' },
        }),
      );
      expect(foreign.accepted).toMatchObject({
        accepted: false,
        kind: 'ignored',
      });
      // Ours by prefix, but no such attempt in this seller's books.
      const stray = await deliver(
        world,
        paymentIntentEvent('payment_intent.succeeded', {
          id: 'pi_stray',
          object: 'payment_intent',
          amount: 100,
          currency: 'usd',
          status: 'succeeded',
          metadata: {
            hv_charge_key: `smrt-auto-top-up:${crypto.randomUUID()}`,
          },
        }),
      );
      expect(stray.accepted).toMatchObject({ accepted: true, kind: 'payment' });
      expect((await deliveries(world))[0]?.status).toBe('completed');
      expect(await grantsOf(SOLO)).toEqual([]);
    });
  });
});
