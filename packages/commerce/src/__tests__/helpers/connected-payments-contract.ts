/**
 * Tenant-owned connected payment accounts (#3831), run on SQLite and in the
 * PostgreSQL lane. Fixture tenants are a bakery co-op and a tool library
 * (non-journalism), charging through recorded Stripe Connect fixtures with
 * test keys only.
 */
import { randomUUID } from 'node:crypto';
import { PaymentNotOwnedError } from '@happyvertical/payments';
import { StripeAdapter } from '@happyvertical/payments/stripe';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  AccountCollection,
  type AccountType,
  JournalCollection,
  JournalEntryCollection,
} from '@happyvertical/smrt-ledgers';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentCollection } from '../../collections/PaymentCollection.js';
import { PaymentIntentCollection } from '../../collections/PaymentIntentCollection.js';
import { TenantPaymentAccountCollection } from '../../collections/TenantPaymentAccountCollection.js';
import {
  type ConnectedSettlementAccounts,
  createConnectedCheckout,
  createStripeConnectGateway,
  createTenantOnboardingLink,
  getTenantPaymentAccount,
  handleConnectedPaymentWebhook,
  linkTenantPaymentAccount,
  onboardTenantPaymentAccount,
  refreshTenantPaymentAccount,
  refundConnectedPayment,
  setTenantPaymentAccountDisabled,
} from '../../connected-payments.js';
import { PaymentIntentStatus, PaymentStatus } from '../../types/index.js';
import {
  StripeConnectFixture,
  TEST_SECRET_KEY,
} from './stripe-connect-fixture.js';

const CLASSES = [
  'TenantPaymentAccount',
  'TenantPaymentWebhookEvent',
  'PaymentIntent',
  'Payment',
  'PaymentAllocation',
  'Invoice',
  'Customer',
  'Contract',
  '@happyvertical/smrt-ledgers:Account',
  'Journal',
  'JournalEntry',
];

export function connectedPaymentsContract(
  postgres = false,
  enabled = true,
): void {
  const suite = enabled ? describe : describe.skip;
  suite(`tenant payment accounts (${postgres ? 'postgres' : 'sqlite'})`, () => {
    let isolated: Pick<IsolatedTestDbResult, 'baseDb' | 'cleanup'>;
    let db: IsolatedTestDbResult['baseDb'];
    let stripe: StripeConnectFixture;
    let bakery: string; // Riverbend Bakery Co-op
    let toolLibrary: string; // Harbor Tool Library
    const ledgers = new Map<string, ConnectedSettlementAccounts>();
    const resolveSettlementAccounts = ({ tenantId }: { tenantId: string }) => {
      const accounts = ledgers.get(tenantId);
      if (!accounts) throw new Error('no ledger for tenant');
      return accounts;
    };

    async function makeLedger(tenantId: string): Promise<void> {
      await withTenant({ tenantId }, async () => {
        const accounts = await AccountCollection.create({ db });
        const make = async (
          number: string,
          name: string,
          type: AccountType,
        ) => {
          const account = await accounts.create({ number, name, type });
          await account.save();
          return account.id!;
        };
        ledgers.set(tenantId, {
          ledgerId: '',
          cashAccountId: await make('1000', 'Stripe balance', 'asset'),
          receivablesAccountId: await make('1200', 'Receivables', 'asset'),
          applicationFeeAccountId: await make(
            '6100',
            'Platform fees',
            'expense',
          ),
        });
      });
    }

    beforeEach(async () => {
      if (!postgres) {
        const sqlite = await getTestDatabase({
          type: 'sqlite',
          url: ':memory:',
          classes: CLASSES,
        });
        isolated = {
          baseDb: sqlite as IsolatedTestDbResult['baseDb'],
          cleanup: async () => {
            await sqlite.close?.();
          },
        };
      } else {
        isolated = await createIsolatedTestDbFromManifest({
          includeObjects: CLASSES,
        });
      }
      db = isolated.baseDb;
      enableTenancy();
      stripe = new StripeConnectFixture();
      bakery = randomUUID();
      toolLibrary = randomUUID();
      await makeLedger(bakery);
      await makeLedger(toolLibrary);
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      disableTenancy();
      ledgers.clear();
      await isolated?.cleanup();
    });

    /** Link an already-onboarded provider account to a tenant. */
    async function connect(tenantId: string, accountId: string) {
      stripe.addAccount(accountId, true, {
        smrt_tenant_id: tenantId,
        smrt_environment: 'test',
      });
      return linkTenantPaymentAccount({
        db,
        gateway: stripe.adapter(),
        tenantId,
        environment: 'test',
        providerAccountId: accountId,
        feePolicyRef: 'agreement:platform-services-2026',
      });
    }

    async function checkout(tenantId: string, key = 'order-1') {
      return createConnectedCheckout({
        db,
        gateway: stripe.adapter(),
        tenantId,
        environment: 'test',
        offeringRef: 'sourdough-share',
        licenseeEmail: 'member@example.org',
        idempotencyKey: key,
        amount: 10_000,
        currency: 'USD',
        applicationFeeAmount: 500,
      });
    }

    async function deliverCompleted(
      sessionId: string,
      account: string,
      gateway = stripe.adapter(),
    ) {
      const event = stripe.event({
        type: 'checkout.session.completed',
        account,
        object: stripe.completeSession(sessionId),
      });
      return {
        event,
        result: await handleConnectedPaymentWebhook({
          db,
          gateway,
          environment: 'test',
          payload: event.payload,
          signature: event.signature,
          resolveSettlementAccounts,
        }),
      };
    }

    it('onboards a Standard account and enables it from account.updated', async () => {
      const gateway = stripe.adapter();
      const account = await onboardTenantPaymentAccount({
        db,
        gateway,
        tenantId: bakery,
        environment: 'test',
        country: 'CA',
        email: 'treasurer@riverbend.example',
      });
      expect(account.status).toBe('pending');
      expect(account.providerAccountId).toMatch(/^acct_/);
      expect(stripe.requestsTo('/accounts')[0]!.stripeAccount).toBeNull();
      // Idempotent: a second call returns the stored account.
      const again = await onboardTenantPaymentAccount({
        db,
        gateway,
        tenantId: bakery,
        environment: 'test',
      });
      expect(again.id).toBe(account.id);
      expect(stripe.requestsTo('/accounts')).toHaveLength(1);

      const link = await createTenantOnboardingLink({
        db,
        gateway,
        tenantId: bakery,
        environment: 'test',
        returnUrl: 'https://riverbend.example/connect/return',
        refreshUrl: 'https://riverbend.example/connect/refresh',
      });
      expect(link.url).toContain(account.providerAccountId);

      const older = Math.floor(Date.now() / 1000) - 60;
      const update = stripe.event({
        type: 'account.updated',
        account: account.providerAccountId,
        object: stripe.enableAccount(account.providerAccountId),
      });
      const applied = await handleConnectedPaymentWebhook({
        db,
        gateway,
        environment: 'test',
        payload: update.payload,
        signature: update.signature,
        resolveSettlementAccounts,
      });
      expect(applied.outcome).toBe('account_updated');
      const enabled = await getTenantPaymentAccount({
        db,
        tenantId: bakery,
        environment: 'test',
      });
      expect(enabled?.status).toBe('enabled');
      expect(enabled?.getCapabilities()?.capabilities.card_payments).toBe(
        'active',
      );

      // An older account.updated delivered late never rolls the state back.
      const stale = stripe.event({
        type: 'account.updated',
        account: account.providerAccountId,
        created: older,
        object: {
          id: account.providerAccountId,
          charges_enabled: false,
          details_submitted: true,
          payouts_enabled: false,
          capabilities: {},
          requirements: {},
        },
      });
      const late = await handleConnectedPaymentWebhook({
        db,
        gateway,
        environment: 'test',
        payload: stale.payload,
        signature: stale.signature,
        resolveSettlementAccounts,
      });
      expect(late.outcome).toBe('stale_account_update');
      expect(
        (
          await getTenantPaymentAccount({
            db,
            tenantId: bakery,
            environment: 'test',
          })
        )?.status,
      ).toBe('enabled');
    });

    it('refuses checkout when the tenant has no enabled account', async () => {
      await expect(checkout(bakery)).rejects.toMatchObject({
        code: 'NO_ENABLED_ACCOUNT',
      });
      await onboardTenantPaymentAccount({
        db,
        gateway: stripe.adapter(),
        tenantId: bakery,
        environment: 'test',
      });
      await expect(checkout(bakery)).rejects.toMatchObject({
        code: 'NO_ENABLED_ACCOUNT',
      });
      // Refused before any provider call: no platform-account fallback.
      expect(stripe.requestsTo('/checkout/sessions')).toHaveLength(0);
    });

    it('charges the tenant account directly with the application fee and books the fee as an expense', async () => {
      await connect(bakery, stripe.accountId('riverbendbakery'));
      const { intent, checkoutUrl, created } = await checkout(bakery);
      expect(created).toBe(true);
      expect(checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      const [request] = stripe.requestsTo('/checkout/sessions');
      expect(request!.stripeAccount).toBe(stripe.accountId('riverbendbakery'));
      expect(
        request!.body.get('payment_intent_data[application_fee_amount]'),
      ).toBe('500');
      expect(request!.body.get('client_reference_id')).toBe(intent.id);
      expect(intent.connectedAccountId).toBe(
        stripe.accountId('riverbendbakery'),
      );
      expect(intent.applicationFeeCents).toBe(500);

      // Retry returns the same intent and checkout, no second session.
      const retry = await checkout(bakery);
      expect(retry.created).toBe(false);
      expect(retry.intent.id).toBe(intent.id);
      expect(stripe.requestsTo('/checkout/sessions')).toHaveLength(1);

      const sessionId = intent.paymentOptions[0]!.memo!;
      const { result } = await deliverCompleted(
        sessionId,
        stripe.accountId('riverbendbakery'),
      );
      expect(result).toMatchObject({
        outcome: 'settled',
        duplicate: false,
        tenantId: bakery,
        paymentIntentId: intent.id,
      });
      // A retry of the paid checkout returns it as paid, never a new session.
      const paidRetry = await checkout(bakery);
      expect(paidRetry).toMatchObject({
        settled: true,
        created: false,
        checkoutUrl: '',
      });
      expect(stripe.requestsTo('/checkout/sessions')).toHaveLength(1);

      await withTenant({ tenantId: bakery }, async () => {
        const payments = await PaymentCollection.create({ db });
        const payment = await payments.get({ id: result.paymentId! });
        expect(payment).toMatchObject({
          status: PaymentStatus.COMPLETED,
          amount: 10_000,
          connectedAccountId: stripe.accountId('riverbendbakery'),
          applicationFeeCents: 500,
          backendTxRef: `pi_${sessionId.slice(3)}`,
        });
        const intents = await PaymentIntentCollection.create({ db });
        expect((await intents.get({ id: intent.id! }))?.status).toBe(
          PaymentIntentStatus.PAID,
        );
        const journal = await (await JournalCollection.create({ db })).get({
          id: payment!.journalId,
        });
        const entries = await (
          await JournalEntryCollection.create({ db })
        ).list({ where: { journalId: journal!.id! } });
        const ledger = ledgers.get(bakery)!;
        const byAccount = Object.fromEntries(
          entries.map((entry) => [
            entry.accountId,
            { debit: Number(entry.debit), credit: Number(entry.credit) },
          ]),
        );
        // Cash arrives net of the fee; the fee is an expense, not a payable.
        expect(byAccount[ledger.cashAccountId]).toEqual({
          debit: 9_500,
          credit: 0,
        });
        expect(byAccount[ledger.applicationFeeAccountId]).toEqual({
          debit: 500,
          credit: 0,
        });
        expect(byAccount[ledger.receivablesAccountId]).toEqual({
          debit: 0,
          credit: 10_000,
        });
        expect(entries).toHaveLength(3);
      });
    });

    it('stores processed events durably: duplicates and out-of-order deliveries settle once', async () => {
      await connect(bakery, stripe.accountId('riverbendbakery'));
      const { intent } = await checkout(bakery);
      const sessionId = intent.paymentOptions[0]!.memo!;

      // A payment_intent event can arrive before the session completes.
      const early = stripe.event({
        type: 'payment_intent.processing',
        account: stripe.accountId('riverbendbakery'),
        object: { id: 'pi_early', metadata: { quoteId: intent.id } },
      });
      const pending = await handleConnectedPaymentWebhook({
        db,
        gateway: stripe.adapter(),
        environment: 'test',
        payload: early.payload,
        signature: early.signature,
        resolveSettlementAccounts,
      });
      expect(pending.outcome).toBe('pending');

      const { event, result } = await deliverCompleted(
        sessionId,
        stripe.accountId('riverbendbakery'),
      );
      expect(result.outcome).toBe('settled');

      // Redelivery to a fresh adapter (a restart or another replica).
      const again = await handleConnectedPaymentWebhook({
        db,
        gateway: stripe.adapter(),
        environment: 'test',
        payload: event.payload,
        signature: event.signature,
        resolveSettlementAccounts,
      });
      expect(again).toMatchObject({ duplicate: true, outcome: 'settled' });

      // A different, older event for the same checkout arriving late.
      const late = stripe.event({
        type: 'checkout.session.async_payment_succeeded',
        account: stripe.accountId('riverbendbakery'),
        object: stripe.session(sessionId),
      });
      const lateResult = await handleConnectedPaymentWebhook({
        db,
        gateway: stripe.adapter(),
        environment: 'test',
        payload: late.payload,
        signature: late.signature,
        resolveSettlementAccounts,
      });
      expect(lateResult.outcome).toBe('already_settled');
      await withTenant({ tenantId: bakery }, async () => {
        const payments = await PaymentCollection.create({ db });
        expect(
          await payments.list({ where: { kind: 'payment' } }),
        ).toHaveLength(1);
      });
    });

    it('verifies the signature before routing and rejects unknown accounts', async () => {
      await connect(bakery, stripe.accountId('riverbendbakery'));
      const gateway = stripe.adapter();
      const spy = vi.spyOn(TenantPaymentAccountCollection.prototype, 'list');
      const forged = stripe.event({
        type: 'account.updated',
        account: stripe.accountId('riverbendbakery'),
        object: stripe.enableAccount(stripe.accountId('riverbendbakery')),
        secret: 'whsec_not_the_connect_secret',
      });
      await expect(
        handleConnectedPaymentWebhook({
          db,
          gateway,
          environment: 'test',
          payload: forged.payload,
          signature: forged.signature,
          resolveSettlementAccounts,
        }),
      ).rejects.toThrow(/signature/i);
      expect(spy).not.toHaveBeenCalled();

      const unknown = stripe.event({
        type: 'checkout.session.completed',
        account: stripe.accountId('strangercoop'),
        object: { id: 'cs_test_x', client_reference_id: randomUUID() },
      });
      await expect(
        handleConnectedPaymentWebhook({
          db,
          gateway,
          environment: 'test',
          payload: unknown.payload,
          signature: unknown.signature,
          resolveSettlementAccounts,
        }),
      ).rejects.toBeInstanceOf(PaymentNotOwnedError);

      const live = stripe.event({
        type: 'account.updated',
        account: stripe.accountId('riverbendbakery'),
        livemode: true,
        object: stripe.enableAccount(stripe.accountId('riverbendbakery')),
      });
      await expect(
        handleConnectedPaymentWebhook({
          db,
          gateway,
          environment: 'test',
          payload: live.payload,
          signature: live.signature,
          resolveSettlementAccounts,
        }),
      ).rejects.toMatchObject({ code: 'ENVIRONMENT_MISMATCH' });
    });

    it("refuses another tenant's quote, also under a system context", async () => {
      await connect(bakery, stripe.accountId('riverbendbakery'));
      await connect(toolLibrary, stripe.accountId('harbortools'));
      const { intent } = await checkout(bakery);
      // The tool library's account claims the bakery's quote id.
      const hostile = stripe.event({
        type: 'checkout.session.completed',
        account: stripe.accountId('harbortools'),
        object: {
          id: 'cs_test_hostile',
          status: 'complete',
          payment_status: 'paid',
          client_reference_id: intent.id,
          metadata: { quoteId: intent.id },
        },
      });
      for (const run of [
        (fn: () => Promise<unknown>) => fn(),
        (fn: () => Promise<unknown>) => withSystemContext(fn),
      ])
        await expect(
          run(() =>
            handleConnectedPaymentWebhook({
              db,
              gateway: stripe.adapter(),
              environment: 'test',
              payload: hostile.payload,
              signature: hostile.signature,
              resolveSettlementAccounts,
            }),
          ),
        ).rejects.toMatchObject({ code: 'QUOTE_NOT_OWNED' });
      await withTenant({ tenantId: bakery }, async () => {
        const intents = await PaymentIntentCollection.create({ db });
        expect((await intents.get({ id: intent.id! }))?.status).toBe(
          PaymentIntentStatus.AWAITING_PAYMENT,
        );
      });
    });

    it('routes application_fee events from the platform endpoint to the tenant', async () => {
      await connect(bakery, stripe.accountId('riverbendbakery'));
      const fee = stripe.event({
        type: 'application_fee.created',
        object: {
          id: 'fee_riverbend1',
          object: 'application_fee',
          account: stripe.accountId('riverbendbakery'),
          amount: 500,
          amount_refunded: 0,
          currency: 'usd',
          refunded: false,
          charge: 'ch_riverbend1',
        },
      });
      const result = await handleConnectedPaymentWebhook({
        db,
        gateway: stripe.adapter(),
        environment: 'test',
        endpoint: 'platform',
        payload: fee.payload,
        signature: fee.signature,
        resolveSettlementAccounts,
      });
      expect(result).toMatchObject({
        outcome: 'application_fee',
        tenantId: bakery,
        applicationFee: { id: 'fee_riverbend1', amount: 500 },
      });
      // A redelivery still returns the fee details.
      expect(
        await handleConnectedPaymentWebhook({
          db,
          gateway: stripe.adapter(),
          environment: 'test',
          endpoint: 'platform',
          payload: fee.payload,
          signature: fee.signature,
          resolveSettlementAccounts,
        }),
      ).toMatchObject({
        duplicate: true,
        applicationFee: { id: 'fee_riverbend1', amount: 500 },
      });
    });

    it('refunds partially then fully on the connected account with an explicit fee flag', async () => {
      await connect(bakery, stripe.accountId('riverbendbakery'));
      const { intent } = await checkout(bakery);
      const { result } = await deliverCompleted(
        intent.paymentOptions[0]!.memo!,
        stripe.accountId('riverbendbakery'),
      );
      const refund = (amount: number | undefined, fee: boolean, key: string) =>
        refundConnectedPayment({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'test',
          paymentId: result.paymentId!,
          amount,
          refundApplicationFee: fee,
          idempotencyKey: key,
          resolveSettlementAccounts,
        });

      const partial = await refund(4_000, true, 'refund-1');
      expect(partial.remaining).toBe(6_000);
      expect(partial.payment.status).toBe(PaymentStatus.COMPLETED);
      expect(partial.refund).toMatchObject({
        kind: 'refund',
        amount: 4_000,
        status: PaymentStatus.COMPLETED,
        connectedAccountId: stripe.accountId('riverbendbakery'),
        refundOfPaymentId: result.paymentId,
      });
      let [call] = stripe.requestsTo('/refunds');
      expect(call!.stripeAccount).toBe(stripe.accountId('riverbendbakery'));
      expect(call!.body.get('refund_application_fee')).toBe('true');
      expect(call!.body.get('metadata[smrt_refund_id]')).toBe(
        partial.refund.id,
      );
      expect(call!.body.get('amount')).toBe('4000');

      const replay = await refund(4_000, true, 'refund-1');
      expect(replay.created).toBe(false);
      expect(stripe.requestsTo('/refunds')).toHaveLength(1);

      await expect(refund(7_000, false, 'refund-2')).rejects.toMatchObject({
        code: 'REFUND_EXCEEDS_PAYMENT',
      });

      const full = await refund(undefined, false, 'refund-3');
      expect(full.remaining).toBe(0);
      expect(full.payment.status).toBe(PaymentStatus.REFUNDED);
      [, call] = stripe.requestsTo('/refunds');
      expect(call!.body.get('refund_application_fee')).toBe('false');
      expect(call!.body.get('amount')).toBe('6000');
      await withTenant({ tenantId: bakery }, async () => {
        const intents = await PaymentIntentCollection.create({ db });
        expect((await intents.get({ id: intent.id! }))?.status).toBe(
          PaymentIntentStatus.RETIRED,
        );
      });

      await expect(
        refundConnectedPayment({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'test',
          paymentId: result.paymentId!,
          refundApplicationFee: undefined as unknown as boolean,
          idempotencyKey: 'refund-4',
          resolveSettlementAccounts,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    });

    it('books a pending refund only when the provider confirms it, and resumes interrupted refunds', async () => {
      const account = stripe.accountId('riverbendbakery');
      await connect(bakery, account);
      const { intent } = await checkout(bakery);
      const { result } = await deliverCompleted(
        intent.paymentOptions[0]!.memo!,
        account,
      );
      const refund = (
        amount: number | undefined,
        key: string,
        resolve = resolveSettlementAccounts,
      ) =>
        refundConnectedPayment({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'test',
          paymentId: result.paymentId!,
          amount,
          refundApplicationFee: false,
          idempotencyKey: key,
          resolveSettlementAccounts: resolve,
        });
      const refundUpdate = (
        refundId: string,
        status: string,
        metadata: Record<string, string> = {},
      ) => {
        const event = stripe.event({
          type: 'charge.refund.updated',
          account,
          object: { id: refundId, object: 'refund', status, metadata },
        });
        return handleConnectedPaymentWebhook({
          db,
          gateway: stripe.adapter(),
          environment: 'test',
          payload: event.payload,
          signature: event.signature,
          resolveSettlementAccounts,
        });
      };

      stripe.refundStatus = 'pending';
      const pending = await refund(3_000, 'pending-1');
      expect(pending.state).toBe('pending');
      expect(pending.refund.status).toBe(PaymentStatus.PENDING);
      expect(pending.refund.journalId).toBe('');
      expect(pending.remaining).toBe(7_000);
      // The pending amount stays reserved.
      await expect(refund(8_000, 'too-much')).rejects.toMatchObject({
        code: 'REFUND_EXCEEDS_PAYMENT',
      });
      const failedLater = await refund(2_000, 'pending-2');
      expect(
        (await refundUpdate(failedLater.refund.backendTxRef, 'failed')).outcome,
      ).toBe('refund_updated');
      // A retry of a refund the provider failed returns that failure; the
      // provider is not asked again.
      const before = stripe.requestsTo('/refunds').length;
      expect(await refund(2_000, 'pending-2')).toMatchObject({
        state: 'failed',
        created: false,
      });
      expect(stripe.requestsTo('/refunds')).toHaveLength(before);
      expect(
        (await refundUpdate(pending.refund.backendTxRef, 'succeeded')).outcome,
      ).toBe('refund_updated');
      // A late 'pending' update never moves a settled refund back.
      await refundUpdate(pending.refund.backendTxRef, 'pending');
      // An update for one of our refunds that is not recorded yet is refused
      // so the provider redelivers; a refund made elsewhere is reported.
      await expect(
        refundUpdate('re_notrecordedyet', 'succeeded', {
          smrt_refund_id: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'REFUND_NOT_RECORDED' });
      expect(
        (await refundUpdate('re_madeindashboard', 'succeeded')).outcome,
      ).toBe('refund_reported');
      await withTenant({ tenantId: bakery }, async () => {
        const payments = await PaymentCollection.create({ db });
        const booked = await payments.get({ id: pending.refund.id! });
        expect(booked?.status).toBe(PaymentStatus.COMPLETED);
        expect(booked?.journalId).not.toBe('');
        expect(
          (await payments.get({ id: failedLater.refund.id! }))?.status,
        ).toBe(PaymentStatus.FAILED);
      });
      // A pending connected refund cannot be edited (for example through a
      // generated update) while it waits for the provider.
      stripe.refundStatus = 'pending';
      const waiting = await refund(1_000, 'pending-3');
      await withTenant({ tenantId: bakery }, async () => {
        const payments = await PaymentCollection.create({ db });
        const row = (await payments.get({ id: waiting.refund.id! }))!;
        row.amount = 1;
        await expect(row.save()).rejects.toThrow(
          /written only by the connected-payments commands/,
        );
        // Nor can its provider state be forged (for example by a CLI
        // `--from-file` update) or the row deleted.
        const forged = (await payments.get({ id: waiting.refund.id! }))!;
        forged.connectedRefundState = 'succeeded';
        forged.backendTxRef = 're_forged';
        await expect(forged.save()).rejects.toThrow(
          /written only by the connected-payments commands/,
        );
        await expect(forged.delete()).rejects.toThrow(/cannot be deleted/);
      });
      await refundUpdate(waiting.refund.backendTxRef, 'succeeded');

      // The provider's answer is lost: the row recorded before the request
      // holds the amount, a same-key retry gets the provider's original
      // refund back, and an old unanswered request is never re-sent.
      stripe.refundStatus = 'succeeded';
      stripe.loseNextRefundResponse = true;
      await expect(refund(500, 'lost')).rejects.toThrow(/fetch failed/);
      const recovered = await refund(500, 'lost');
      expect(recovered).toMatchObject({ state: 'succeeded', created: true });
      expect(recovered.refund.status).toBe(PaymentStatus.COMPLETED);
      stripe.loseNextRefundResponse = true;
      await expect(refund(500, 'stale')).rejects.toThrow(/fetch failed/);
      const sent = stripe.requestsTo('/refunds').length;
      const staleBody = stripe.requestsTo('/refunds').at(-1)!.body;
      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 25 * 60 * 60 * 1000);
      const waitingForUpdate = await refund(500, 'stale');
      vi.restoreAllMocks();
      expect(waitingForUpdate).toMatchObject({
        state: 'requested',
        created: false,
      });
      expect(stripe.requestsTo('/refunds')).toHaveLength(sent);
      const lostRefund = stripe.event({
        type: 'charge.refund.updated',
        account,
        object: {
          id: 're_staleanswer',
          object: 'refund',
          status: 'succeeded',
          amount: 500,
          metadata: {
            smrt_refund_id: staleBody.get('metadata[smrt_refund_id]'),
          },
        },
      });
      expect(
        (
          await handleConnectedPaymentWebhook({
            db,
            gateway: stripe.adapter(),
            environment: 'test',
            payload: lostRefund.payload,
            signature: lostRefund.signature,
            resolveSettlementAccounts,
          })
        ).outcome,
      ).toBe('refund_updated');
      await withTenant({ tenantId: bakery }, async () => {
        const payments = await PaymentCollection.create({ db });
        const row = (await payments.get({ id: waitingForUpdate.refund.id! }))!;
        expect(row.status).toBe(PaymentStatus.COMPLETED);
        expect(row.backendTxRef).toBe('re_staleanswer');
      });

      // A request the SDK refuses before sending made no refund: its amount
      // is released and a retry returns the failure.
      const usdUnsupported = new StripeAdapter({
        secretKey: TEST_SECRET_KEY,
        defaultCurrency: 'cad',
        supportedCurrencies: ['cad'],
        apiBaseUrl: 'https://api.stripe.test/v1',
        fetch: stripe.fetch,
      });
      const refundWith = (gateway: StripeAdapter, key: string) =>
        refundConnectedPayment({
          db,
          gateway,
          tenantId: bakery,
          environment: 'test',
          paymentId: result.paymentId!,
          amount: 700,
          refundApplicationFee: false,
          idempotencyKey: key,
          resolveSettlementAccounts,
        });
      const beforeRefused = stripe.requestsTo('/refunds').length;
      await expect(refundWith(usdUnsupported, 'refused')).rejects.toMatchObject(
        { code: 'REFUND_FAILED' },
      );
      expect(await refundWith(stripe.adapter(), 'refused')).toMatchObject({
        state: 'failed',
        created: false,
      });
      expect(stripe.requestsTo('/refunds')).toHaveLength(beforeRefused);
      // A provider answer that cannot be read may follow a real refund: the
      // row stays requested, and a same-key re-send recovers that refund.
      stripe.garbleNextRefundResponse = true;
      await expect(refund(700, 'garbled')).rejects.toThrow(/invalid JSON/);
      expect(await refund(700, 'garbled')).toMatchObject({
        state: 'succeeded',
      });
      // A re-sent lost request must repeat its original fee choice.
      stripe.loseNextRefundResponse = true;
      await expect(refund(300, 'lost-2')).rejects.toThrow(/fetch failed/);
      await expect(
        refundConnectedPayment({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'test',
          paymentId: result.paymentId!,
          amount: 300,
          refundApplicationFee: true,
          idempotencyKey: 'lost-2',
          resolveSettlementAccounts,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(await refund(300, 'lost-2')).toMatchObject({
        state: 'succeeded',
      });

      // Provider refund succeeds but booking fails: a retry with the same key
      // finishes the booking and the full-refund state without a second
      // provider refund.
      stripe.refundStatus = 'succeeded';
      const calls = stripe.requestsTo('/refunds').length;
      await expect(
        refund(undefined, 'rest', () => {
          throw new Error('ledger offline');
        }),
      ).rejects.toThrow('ledger offline');
      const resumed = await refund(undefined, 'rest');
      expect(resumed).toMatchObject({ created: false, remaining: 0 });
      expect(resumed.refund.status).toBe(PaymentStatus.COMPLETED);
      expect(stripe.requestsTo('/refunds')).toHaveLength(calls + 1);
      await withTenant({ tenantId: bakery }, async () => {
        const payments = await PaymentCollection.create({ db });
        expect((await payments.get({ id: result.paymentId! }))?.status).toBe(
          PaymentStatus.REFUNDED,
        );
        const intents = await PaymentIntentCollection.create({ db });
        expect((await intents.get({ id: intent.id! }))?.status).toBe(
          PaymentIntentStatus.RETIRED,
        );
      });
    });

    it('refuses wrong-tenant refunds and relinks, including privileged callers', async () => {
      await connect(bakery, stripe.accountId('riverbendbakery'));
      await connect(toolLibrary, stripe.accountId('harbortools'));
      const { intent } = await checkout(bakery);
      const { result } = await deliverCompleted(
        intent.paymentOptions[0]!.memo!,
        stripe.accountId('riverbendbakery'),
      );
      const refundAsToolLibrary = () =>
        refundConnectedPayment({
          db,
          gateway: stripe.adapter(),
          tenantId: toolLibrary,
          environment: 'test',
          paymentId: result.paymentId!,
          refundApplicationFee: false,
          idempotencyKey: 'steal',
          resolveSettlementAccounts,
        });
      await expect(refundAsToolLibrary()).rejects.toMatchObject({
        code: 'PAYMENT_NOT_OWNED',
      });
      await expect(
        withSystemContext(refundAsToolLibrary),
      ).rejects.toMatchObject({ code: 'PAYMENT_NOT_OWNED' });
      expect(stripe.requestsTo('/refunds')).toHaveLength(0);

      const relink = () =>
        linkTenantPaymentAccount({
          db,
          gateway: stripe.adapter(),
          tenantId: toolLibrary,
          environment: 'test',
          providerAccountId: stripe.accountId('riverbendbakery'),
          replace: true,
        });
      await expect(relink()).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
      await expect(withSystemContext(relink)).rejects.toMatchObject({
        code: 'ACCOUNT_IN_USE',
      });

      // An account that does not name the tenant needs host-verified
      // ownership; relinking also needs `replace`. Old payments can then no
      // longer be refunded through the new account.
      stripe.addAccount(stripe.accountId('riverbendnew'));
      const linkNew = (extra: {
        replace?: boolean;
        ownershipVerified?: boolean;
      }) =>
        linkTenantPaymentAccount({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'test',
          providerAccountId: stripe.accountId('riverbendnew'),
          ...extra,
        });
      await expect(linkNew({ replace: true })).rejects.toMatchObject({
        code: 'ACCOUNT_NOT_OWNED',
      });
      await expect(linkNew({ ownershipVerified: true })).rejects.toMatchObject({
        code: 'ACCOUNT_ALREADY_LINKED',
      });
      await linkNew({ replace: true, ownershipVerified: true });
      // The bakery's old account is no longer held, but it still names the
      // bakery: nobody else can claim it, even with verified ownership.
      await expect(
        withSystemContext(() =>
          linkTenantPaymentAccount({
            db,
            gateway: stripe.adapter(),
            tenantId: toolLibrary,
            environment: 'test',
            providerAccountId: stripe.accountId('riverbendbakery'),
            replace: true,
            ownershipVerified: true,
          }),
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
      await expect(
        refundConnectedPayment({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'test',
          paymentId: result.paymentId!,
          refundApplicationFee: false,
          idempotencyKey: 'after-relink',
          resolveSettlementAccounts,
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_OWNED' });
    });

    it('guards the account record and enforces one owner per provider account in the database', async () => {
      const account = await connect(
        bakery,
        stripe.accountId('riverbendbakery'),
      );
      await withTenant({ tenantId: bakery }, async () => {
        account.providerAccountId = stripe.accountId('somewhereelse');
        await expect(account.save()).rejects.toThrow(/connected-payments/);
      });
      const accounts = await TenantPaymentAccountCollection.create({ db });
      const duplicate = await withSystemContext(() =>
        db.insert('tenant_payment_accounts', {
          id: randomUUID(),
          tenant_id: toolLibrary,
          backend_id: 'stripe',
          environment: 'test',
          slug: `forged-${randomUUID()}`,
          context: '',
          provider_account_id: stripe.accountId('riverbendbakery'),
          status: 'enabled',
        }),
      ).catch((error: unknown) => error as Error & { cause?: unknown });
      expect(duplicate).toBeInstanceOf(Error);
      // The provider-account index refuses the row, not some other column.
      expect(JSON.stringify(duplicate)).toMatch(/unique|duplicate key/i);
      expect(
        await withSystemContext(() =>
          accounts.list({
            where: { providerAccountId: stripe.accountId('riverbendbakery') },
          }),
        ),
      ).toHaveLength(1);

      const disabled = await setTenantPaymentAccountDisabled({
        db,
        tenantId: bakery,
        environment: 'test',
        disabled: true,
        reason: 'treasurer request',
      });
      expect(disabled.status).toBe('disabled');
      const refreshed = await refreshTenantPaymentAccount({
        db,
        gateway: stripe.adapter(),
        tenantId: bakery,
        environment: 'test',
      });
      expect(refreshed.status).toBe('disabled');
      await expect(checkout(bakery)).rejects.toMatchObject({
        code: 'NO_ENABLED_ACCOUNT',
      });

      // A connected checkout's options cannot be repointed (for example by a
      // generated update) at a session made without the application fee.
      await setTenantPaymentAccountDisabled({
        db,
        tenantId: bakery,
        environment: 'test',
        disabled: false,
      });
      const { intent } = await checkout(bakery, 'freeze');
      await withTenant({ tenantId: bakery }, async () => {
        const intents = await PaymentIntentCollection.create({ db });
        const stored = (await intents.get({ id: intent.id! }))!;
        stored.paymentOptions = [
          { ...stored.paymentOptions[0]!, memo: 'cs_test_withoutfee' },
        ];
        await expect(stored.save()).rejects.toThrow(/frozen/);
      });
    });

    it('recovers a lost checkout response and refuses reuse across environments', async () => {
      const account = stripe.accountId('riverbendbakery');
      await connect(bakery, account);
      stripe.loseNextCheckoutResponse = true;
      await expect(checkout(bakery, 'lost-session')).rejects.toThrow(
        /fetch failed/,
      );
      const recovered = await checkout(bakery, 'lost-session');
      const [first, second] = stripe.requestsTo('/checkout/sessions');
      // The retry replays the recorded request unchanged, so the provider
      // returns the session it already made.
      expect(second!.body.toString()).toBe(first!.body.toString());
      expect(recovered.checkoutUrl).toBe(
        `https://checkout.stripe.com/c/pay/${recovered.intent.paymentOptions[0]!.memo}`,
      );

      // A retry may not change the recorded price, even before the provider's
      // answer is stored.
      stripe.loseNextCheckoutResponse = true;
      await expect(checkout(bakery, 'lost-late')).rejects.toThrow(
        /fetch failed/,
      );
      const beforeChanged = stripe.requestsTo('/checkout/sessions').length;
      await expect(
        createConnectedCheckout({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'test',
          offeringRef: 'sourdough-share',
          licenseeEmail: 'member@example.org',
          idempotencyKey: 'lost-late',
          amount: 1_000,
          currency: 'USD',
          applicationFeeAmount: 500,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(stripe.requestsTo('/checkout/sessions')).toHaveLength(
        beforeChanged,
      );
      // Retried after the recorded expiry is too close to replay: a fresh
      // session is requested with a renewed expiry and a new key.
      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 45 * 60 * 1000);
      try {
        const late = await checkout(bakery, 'lost-late');
        expect(late.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
        const sent = stripe.requestsTo('/checkout/sessions');
        expect(sent.at(-1)!.idempotencyKey).not.toBe(
          sent.at(-2)!.idempotencyKey,
        );
        expect(late.intent.priceLockExpiresAt!.getTime()).toBeGreaterThan(
          realNow + 45 * 60 * 1000,
        );
      } finally {
        vi.restoreAllMocks();
      }

      // An explicit expiry that is now too close cannot be replayed: the
      // caller is told to pass a fresh one, which then succeeds.
      const explicitExpiry = new Date(Date.now() + 60 * 60 * 1000);
      const explicit = (expiresAt: Date) =>
        createConnectedCheckout({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'test',
          offeringRef: 'sourdough-share',
          licenseeEmail: 'member@example.org',
          idempotencyKey: 'lost-explicit',
          amount: 10_000,
          currency: 'USD',
          applicationFeeAmount: 500,
          expiresAt,
        });
      stripe.loseNextCheckoutResponse = true;
      await expect(explicit(explicitExpiry)).rejects.toThrow(/fetch failed/);
      const laterNow = Date.now() + 45 * 60 * 1000;
      vi.spyOn(Date, 'now').mockReturnValue(laterNow);
      try {
        await expect(explicit(explicitExpiry)).rejects.toMatchObject({
          code: 'INVALID_INPUT',
        });
        const renewedExplicit = await explicit(
          new Date(laterNow + 60 * 60 * 1000),
        );
        expect(renewedExplicit.intent.paymentOptions).toHaveLength(1);
      } finally {
        vi.restoreAllMocks();
      }

      // A closed quote never hands out a session again, even when its first
      // answer was lost.
      stripe.loseNextCheckoutResponse = true;
      await expect(checkout(bakery, 'lost-closed')).rejects.toThrow(
        /fetch failed/,
      );
      await withTenant({ tenantId: bakery }, async () => {
        const intents = await PaymentIntentCollection.create({ db });
        const [stale] = await intents.list({
          where: { idempotencyKey: 'lost-closed' },
        });
        stale!.expire();
        await stale!.save();
      });
      const beforeClosed = stripe.requestsTo('/checkout/sessions').length;
      await expect(checkout(bakery, 'lost-closed')).rejects.toMatchObject({
        code: 'QUOTE_CLOSED',
      });
      expect(stripe.requestsTo('/checkout/sessions')).toHaveLength(
        beforeClosed,
      );

      // The same Standard account id in live mode is a different checkout.
      stripe.addAccount(account, true, { smrt_tenant_id: bakery });
      await linkTenantPaymentAccount({
        db,
        gateway: stripe.adapter(),
        tenantId: bakery,
        environment: 'live',
        providerAccountId: account,
      });
      const sessions = stripe.requestsTo('/checkout/sessions').length;
      await expect(
        createConnectedCheckout({
          db,
          gateway: stripe.adapter(),
          tenantId: bakery,
          environment: 'live',
          offeringRef: 'sourdough-share',
          licenseeEmail: 'member@example.org',
          idempotencyKey: 'lost-session',
          amount: 10_000,
          currency: 'USD',
          applicationFeeAmount: 500,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      expect(stripe.requestsTo('/checkout/sessions')).toHaveLength(sessions);
    });

    it('settles a provider-confirmed checkout after the lock and flags payments on closed quotes', async () => {
      const account = stripe.accountId('riverbendbakery');
      await connect(bakery, account);
      const late = await checkout(bakery, 'late-notice');
      const closed = await checkout(bakery, 'closed-quote');
      await withTenant({ tenantId: bakery }, async () => {
        const intents = await PaymentIntentCollection.create({ db });
        const quote = (await intents.get({ id: closed.intent.id! }))!;
        quote.cancel('buyer left');
        await quote.save();
      });
      const realNow = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(realNow + 2 * 60 * 60 * 1000);
      try {
        const { result } = await deliverCompleted(
          late.intent.paymentOptions[0]!.memo!,
          account,
        );
        expect(result.outcome).toBe('settled');
        const { result: flagged } = await deliverCompleted(
          closed.intent.paymentOptions[0]!.memo!,
          account,
        );
        expect(flagged.outcome).toBe('late_payment');
        expect(flagged.paymentId).toBeUndefined();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('serialises account writes: concurrent onboarding, disable and relink', async () => {
      const gateway = stripe.adapter();
      // Both calls check before either stores the account.
      vi.spyOn(TenantPaymentAccountCollection.prototype, 'findForTenant')
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      const [a, b] = await Promise.all([
        onboardTenantPaymentAccount({
          db,
          gateway,
          tenantId: bakery,
          environment: 'test',
        }),
        onboardTenantPaymentAccount({
          db,
          gateway,
          tenantId: bakery,
          environment: 'test',
        }),
      ]);
      expect(a.id).toBe(b.id);
      expect(a.providerAccountId).toBe(b.providerAccountId);
      // Both calls reached the provider, so the second insert hit the unique
      // index and recovered the winning row.
      expect(stripe.requestsTo('/accounts')).toHaveLength(2);
      vi.restoreAllMocks();
      const accountId = a.providerAccountId;

      // An operator disable lands while account.updated is being handled.
      const update = stripe.event({
        type: 'account.updated',
        account: accountId,
        object: stripe.enableAccount(accountId),
      });
      const get = TenantPaymentAccountCollection.prototype.get;
      const spy = vi
        .spyOn(TenantPaymentAccountCollection.prototype, 'get')
        .mockImplementationOnce(async function (this: unknown, ...args) {
          const loaded = await get.apply(
            this as TenantPaymentAccountCollection,
            args as Parameters<typeof get>,
          );
          await setTenantPaymentAccountDisabled({
            db,
            tenantId: bakery,
            environment: 'test',
            disabled: true,
          });
          return loaded;
        });
      await expect(
        handleConnectedPaymentWebhook({
          db,
          gateway,
          environment: 'test',
          payload: update.payload,
          signature: update.signature,
          resolveSettlementAccounts,
        }),
      ).rejects.toThrow(/revision|changed|conflict|stale/i);
      spy.mockRestore();
      expect(
        (
          await getTenantPaymentAccount({
            db,
            tenantId: bakery,
            environment: 'test',
          })
        )?.status,
      ).toBe('disabled');

      // A relink lands between routing and the reload: the old account's
      // snapshot is never applied to the replacement.
      stripe.addAccount(stripe.accountId('riverbendnew'), true, {
        smrt_tenant_id: bakery,
      });
      const stale = stripe.event({
        type: 'account.updated',
        account: accountId,
        object: stripe.enableAccount(accountId),
      });
      vi.spyOn(
        TenantPaymentAccountCollection.prototype,
        'get',
      ).mockImplementationOnce(async function (this: unknown, ...args) {
        await linkTenantPaymentAccount({
          db,
          gateway,
          tenantId: bakery,
          environment: 'test',
          providerAccountId: stripe.accountId('riverbendnew'),
          replace: true,
        });
        return get.apply(
          this as TenantPaymentAccountCollection,
          args as Parameters<typeof get>,
        );
      });
      await expect(
        handleConnectedPaymentWebhook({
          db,
          gateway,
          environment: 'test',
          payload: stale.payload,
          signature: stale.signature,
          resolveSettlementAccounts,
        }),
      ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_OWNED' });
      vi.restoreAllMocks();

      // The ownership record is never deleted.
      const current = (await getTenantPaymentAccount({
        db,
        tenantId: bakery,
        environment: 'test',
      }))!;
      await withTenant({ tenantId: bakery }, async () => {
        await expect(current.delete()).rejects.toThrow(/cannot be deleted/);
      });
    });

    it('builds the platform gateway from smrt-secrets without exposing values', async () => {
      const values: Record<string, string> = {
        'stripe-connect-test-secret-key': TEST_SECRET_KEY,
        'stripe-connect-test-webhook-secret': 'whsec_test_a',
        'stripe-connect-test-connect-webhook-secret': 'whsec_test_b',
        'stripe-connect-live-secret-key': TEST_SECRET_KEY,
      };
      const holder = randomUUID();
      const secrets = {
        retrieveForTenant: async (tenantId: string, name: string) => {
          if (tenantId !== holder || !(name in values))
            throw new Error('not found');
          return { value: values[name]! };
        },
      };
      const gateway = await createStripeConnectGateway({
        secrets,
        secretsTenantId: holder,
        environment: 'test',
      });
      expect(gateway.capabilities.id).toBe('stripe');
      const error = await createStripeConnectGateway({
        secrets,
        secretsTenantId: holder,
        environment: 'live',
      }).catch((caught: unknown) => caught as Error);
      expect(error).toMatchObject({ code: 'CONFIGURATION' });
      expect(String((error as Error).message)).not.toContain(TEST_SECRET_KEY);
    });
  });
}
