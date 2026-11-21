/** Payment sync, invoice readback and batch entry points (#5139). */

import { createHash } from 'node:crypto';
import {
  getAccountingProvider,
  type InvoiceInput,
  type SyncResult,
} from '@happyvertical/accounting';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFrozenInvoiceMapping,
  getAccountingMappingScope,
  setAccountingMapping,
} from '../accounting-mapping.js';
import {
  type AccountingInvoiceEvidence,
  type AccountingPaymentPort,
  type AccountingPaymentRequest,
  readbackDue,
  readbackInvoice,
  reconcileAccountingPaymentSync,
  resolveUnknownPaymentSync,
  syncPaymentToAccounting,
  syncPending,
} from '../accounting-payment-sync.js';
import { paymentPortFromProvider } from '../accounting-provider-adapters.js';
import { AccountingPaymentSyncCollection } from '../collections/AccountingSyncRecordCollections.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { syncFrozenInvoiceToAccounting } from '../invoice-accounting-sync.js';
import {
  connectFixtureTenant,
  FakeSecrets,
  issuedFixtureInvoice,
} from './helpers/accounting-fixtures.js';

const TENANT = '55555555-5555-4555-8555-555555555551';

describe('payment sync and readback (#5139)', () => {
  let db: DatabaseInterface;
  let secrets: FakeSecrets;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
    secrets = new FakeSecrets();
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  const inTenant = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId: TENANT }, fn);

  const invoicePush = vi.fn(
    async (_i: InvoiceInput): Promise<SyncResult> => ({
      action: 'created',
      externalId: 'qb-inv-1',
      syncedAt: new Date('2026-11-01T00:00:00Z'),
    }),
  );
  const provider = () =>
    ({ type: 'quickbooks', invoices: { push: invoicePush } }) as never;

  async function seed(
    options: { syncInvoice?: boolean; mapDeposit?: boolean } = {},
  ) {
    invoicePush.mockClear();
    await connectFixtureTenant(db, TENANT, { secrets });
    const seeded = await issuedFixtureInvoice(db, TENANT);
    const scope = await getAccountingMappingScope({ db }, TENANT);
    const set = (
      kind: Parameters<typeof setAccountingMapping>[2]['kind'],
      localId: string,
      externalId: string,
    ) => setAccountingMapping({ db }, scope, { kind, localId, externalId });
    await set('customer', seeded.customerId, 'qb-cust');
    await set('item', 'default', 'qb-item');
    await set('tax_code', seeded.taxCodeId, 'qb-tax');
    await set('tax_component', seeded.componentId, 'qb-rate');
    if (options.mapDeposit !== false)
      await set('deposit_account', 'default', 'qb-clearing');
    if (options.syncInvoice !== false) {
      const mapping = await buildFrozenInvoiceMapping({
        db,
        tenantId: TENANT,
        invoiceId: seeded.invoice.id,
      });
      await inTenant(() =>
        syncFrozenInvoiceToAccounting({
          db,
          tenantId: TENANT,
          invoiceId: seeded.invoice.id,
          mapping,
          provider: provider(),
        }),
      );
    }
    return { ...seeded, scope };
  }

  /** A completed payment applied in full to the invoice (status set directly: recordPayment posts a ledger journal). */
  async function paidPayment(
    s: {
      invoice: { id?: string | null; totalAmount: number };
      customerId: string;
    },
    amount?: number,
  ) {
    return inTenant(async () => {
      const payment = await (await PaymentCollection.create({ db })).create({
        customerId: s.customerId,
        currency: 'CAD',
        amount: amount ?? s.invoice.totalAmount,
        transactionId: 'ch_test_1',
      });
      await (await PaymentAllocationCollection.create({ db })).allocatePayment({
        paymentId: String(payment.id),
        allocations: [
          {
            id: crypto.randomUUID(),
            invoiceId: String(s.invoice.id),
            amount: amount ?? s.invoice.totalAmount,
          },
        ],
      });
      await db.query(
        "UPDATE payments SET status = 'completed', paid_at = ? WHERE id = ?",
        new Date('2026-11-02T00:00:00Z').toISOString(),
        payment.id,
      );
      return String(payment.id);
    });
  }

  function port(create?: AccountingPaymentPort['create']) {
    const calls: AccountingPaymentRequest[] = [];
    const impl: AccountingPaymentPort = {
      create: vi.fn(async (request) => {
        calls.push(request);
        return create
          ? create(request)
          : {
              externalId: `qb-pay-${calls.length}`,
              syncedAt: new Date('2026-11-03T00:00:00Z'),
            };
      }),
    };
    return { impl, calls };
  }

  const run = (paymentId: string, p: AccountingPaymentPort) =>
    inTenant(() =>
      syncPaymentToAccounting({ db, tenantId: TENANT, paymentId, payments: p }),
    );
  const rowOf = async (paymentId: string) =>
    inTenant(async () =>
      (await AccountingPaymentSyncCollection.create({ db })).findForPayment({
        tenantId: TENANT,
        realmId: 'realm-a',
        environment: 'sandbox',
        paymentId,
      }),
    );

  describe('payment push', () => {
    it('persists the request before the push, pushes once, and is idempotent', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      let seenBefore: unknown;
      const { impl, calls } = port(async (request) => {
        seenBefore = (await rowOf(paymentId))?.toJSON();
        return {
          externalId: 'qb-pay-1',
          syncedAt: new Date('2026-11-03T00:00:00Z'),
        };
      });
      const first = await run(paymentId, impl);
      expect(first).toMatchObject({ status: 'synced', externalId: 'qb-pay-1' });
      expect(seenBefore).toMatchObject({
        status: 'in_flight',
        requestId: calls[0]?.requestId,
      });
      expect(calls[0]).toMatchObject({
        customerExternalId: 'qb-cust',
        depositAccountRef: 'qb-clearing',
        currency: 'CAD',
        amountMinor: s.invoice.totalAmount,
        transactionId: 'ch_test_1',
        applications: [
          {
            invoiceId: s.invoice.id,
            invoiceExternalId: 'qb-inv-1',
            amountMinor: s.invoice.totalAmount,
          },
        ],
      });
      expect(calls[0]?.requestId).toMatch(/^smrt_pay_[a-f0-9]{40}$/);
      const again = await run(paymentId, impl);
      expect(again).toMatchObject({
        status: 'unchanged',
        externalId: 'qb-pay-1',
      });
      expect(calls).toHaveLength(1);
      expect(await rowOf(paymentId)).toMatchObject({
        status: 'synced',
        externalId: 'qb-pay-1',
      });
    });

    it('lets only one of two concurrent pushes reach the provider', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      const { impl, calls } = port(async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { externalId: 'qb-pay-1', syncedAt: new Date() };
      });
      const results = await Promise.allSettled([
        run(paymentId, impl),
        run(paymentId, impl),
      ]);
      expect(calls).toHaveLength(1);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find(
        (r) => r.status === 'rejected',
      ) as PromiseRejectedResult;
      expect(failure.reason).toMatchObject({ code: 'SYNC_IN_PROGRESS' });
    });

    it('stops on an unknown outcome until reconciled; found completes, absent retries with the same request', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      let fail = true;
      const { impl, calls } = port(async () => {
        if (fail) throw new Error('socket hang up');
        return {
          externalId: 'qb-pay-2',
          syncedAt: new Date('2026-11-04T00:00:00Z'),
        };
      });
      await expect(run(paymentId, impl)).rejects.toThrow('socket hang up');
      const unknown = await rowOf(paymentId);
      expect(unknown).toMatchObject({
        status: 'unknown',
        lastError: 'UNKNOWN_OUTCOME',
      });
      await expect(run(paymentId, impl)).rejects.toMatchObject({
        code: 'RECONCILIATION_REQUIRED',
      });
      expect(calls).toHaveLength(1);

      const ids = {
        requestId: String(unknown?.requestId),
        attemptId: String(unknown?.attemptId),
      };
      await expect(
        inTenant(() =>
          reconcileAccountingPaymentSync({
            db,
            tenantId: TENANT,
            paymentId,
            ...ids,
            requestId: 'wrong',
            outcome: { status: 'absent' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
      await inTenant(() =>
        reconcileAccountingPaymentSync({
          db,
          tenantId: TENANT,
          paymentId,
          ...ids,
          outcome: { status: 'absent' },
        }),
      );
      fail = false;
      const retry = await run(paymentId, impl);
      expect(retry.status).toBe('synced');
      expect(calls[1]?.requestId).toBe(calls[0]?.requestId);
    });

    it('lets only one of two racing reconciliations apply', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      const { impl } = port(async () => Promise.reject(new Error('timeout')));
      await run(paymentId, impl).catch(() => undefined);
      const unknown = await rowOf(paymentId);
      const ids = {
        requestId: String(unknown?.requestId),
        attemptId: String(unknown?.attemptId),
      };
      const reconcile = (
        outcome: Parameters<
          typeof reconcileAccountingPaymentSync
        >[0]['outcome'],
      ) =>
        inTenant(() =>
          reconcileAccountingPaymentSync({
            db,
            tenantId: TENANT,
            paymentId,
            ...ids,
            outcome,
          }),
        );
      const results = await Promise.allSettled([
        reconcile({
          status: 'found',
          externalId: 'qb-pay-7',
          syncedAt: new Date('2026-11-05T00:00:00Z'),
        }),
        reconcile({ status: 'absent' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const final = await rowOf(paymentId);
      const winner = results.findIndex((r) => r.status === 'fulfilled');
      expect(final?.status).toBe(winner === 0 ? 'synced' : 'rejected');
      // A late stale reconciliation can never overwrite the outcome.
      await expect(reconcile({ status: 'absent' })).rejects.toMatchObject({
        code: 'RECONCILIATION_REQUIRED',
      });
      expect((await rowOf(paymentId))?.status).toBe(final?.status);
    });

    it('records a found outcome as synced without a second push', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      const { impl, calls } = port(async () =>
        Promise.reject(new Error('timeout')),
      );
      await run(paymentId, impl).catch(() => undefined);
      const unknown = await rowOf(paymentId);
      const done = await inTenant(() =>
        reconcileAccountingPaymentSync({
          db,
          tenantId: TENANT,
          paymentId,
          requestId: String(unknown?.requestId),
          attemptId: String(unknown?.attemptId),
          outcome: {
            status: 'found',
            externalId: 'qb-pay-9',
            syncedAt: new Date('2026-11-05T00:00:00Z'),
          },
        }),
      );
      expect(done).toMatchObject({ status: 'synced', externalId: 'qb-pay-9' });
      expect((await run(paymentId, impl)).status).toBe('unchanged');
      expect(calls).toHaveLength(1);
    });

    it('retries after a definite rejection or a dead grant (nothing was created)', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      let mode: 'rejected' | 'reauth' | 'ok' = 'rejected';
      const { impl, calls } = port(async () => {
        if (mode === 'rejected')
          throw Object.assign(new Error('refused'), { outcome: 'rejected' });
        if (mode === 'reauth')
          throw Object.assign(new Error('x'), { code: 'REAUTH_REQUIRED' });
        return { externalId: 'qb-pay-3', syncedAt: new Date() };
      });
      await expect(run(paymentId, impl)).rejects.toThrow('refused');
      expect(await rowOf(paymentId)).toMatchObject({
        status: 'rejected',
        lastError: 'REJECTED',
      });
      mode = 'reauth';
      await expect(run(paymentId, impl)).rejects.toMatchObject({
        code: 'REAUTH_REQUIRED',
      });
      expect(await rowOf(paymentId)).toMatchObject({
        status: 'rejected',
        lastError: 'REAUTH_REQUIRED',
      });
      mode = 'ok';
      expect((await run(paymentId, impl)).status).toBe('synced');
      expect(calls).toHaveLength(3);
    });

    it('refuses an unsynced invoice, a missing deposit mapping, and a partly applied payment', async () => {
      const unsynced = await seed({ syncInvoice: false });
      const p1 = await paidPayment(unsynced);
      const { impl, calls } = port();
      await expect(run(p1, impl)).rejects.toMatchObject({
        code: 'INVOICE_NOT_SYNCED',
      });

      const mapping = await buildFrozenInvoiceMapping({
        db,
        tenantId: TENANT,
        invoiceId: String(unsynced.invoice.id),
      });
      await inTenant(() =>
        syncFrozenInvoiceToAccounting({
          db,
          tenantId: TENANT,
          invoiceId: String(unsynced.invoice.id),
          mapping,
          provider: provider(),
        }),
      );
      await db.query(
        "DELETE FROM accounting_mappings WHERE kind = 'deposit_account'",
      );
      await expect(run(p1, impl)).rejects.toMatchObject({
        code: 'MAPPING_INCOMPLETE',
        missing: [{ kind: 'deposit_account', localId: 'default' }],
      });
      expect(calls).toHaveLength(0);
    });

    it('refuses a partly applied payment', async () => {
      const s = await seed();
      const partial = await inTenant(async () => {
        const payment = await (await PaymentCollection.create({ db })).create({
          customerId: s.customerId,
          currency: 'CAD',
          amount: s.invoice.totalAmount + 50,
        });
        await (
          await PaymentAllocationCollection.create({ db })
        ).allocatePayment({
          paymentId: String(payment.id),
          allocations: [
            {
              id: crypto.randomUUID(),
              invoiceId: String(s.invoice.id),
              amount: s.invoice.totalAmount,
            },
          ],
        });
        await db.query(
          "UPDATE payments SET status = 'completed' WHERE id = ?",
          payment.id,
        );
        return String(payment.id);
      });
      await expect(run(partial, port().impl)).rejects.toMatchObject({
        code: 'PAYMENT_NOT_SYNCABLE',
      });
    });

    it('is gated in production until live mode is enabled', async () => {
      await connectFixtureTenant(db, TENANT, {
        environment: 'production',
        secrets,
      });
      const { impl, calls } = port();
      await expect(run('any-payment', impl)).rejects.toMatchObject({
        code: 'LIVE_ACCOUNTING_NOT_ENABLED',
      });
      expect(calls).toHaveLength(0);
    });
  });

  describe('readback', () => {
    const evidence = (
      s: {
        invoice: { totalAmount: number; subtotal: number; taxAmount: number };
      },
      over: Partial<AccountingInvoiceEvidence> = {},
    ): AccountingInvoiceEvidence => ({
      tenantId: TENANT,
      realmId: 'realm-a',
      environment: 'sandbox',
      externalId: 'qb-inv-1',
      customerExternalId: 'qb-cust',
      currency: 'CAD',
      subtotalMinor: s.invoice.subtotal,
      discountMinor: 0,
      taxMinor: s.invoice.taxAmount,
      totalMinor: s.invoice.totalAmount,
      dueDate: null,
      balanceMinor: s.invoice.totalAmount,
      voided: false,
      complete: true,
      transactions: [],
      ...over,
    });
    const reader = (e: AccountingInvoiceEvidence | Error) => ({
      readInvoice: vi.fn(async () => {
        if (e instanceof Error) throw e;
        return e;
      }),
    });
    const read = (
      s: { invoice: { id?: string | null } },
      r: ReturnType<typeof reader>,
    ) =>
      inTenant(() =>
        readbackInvoice({
          db,
          tenantId: TENANT,
          invoiceId: String(s.invoice.id),
          reader: r,
        }),
      );

    it('is in_step when provider and local paid amounts agree, and stores the projection', async () => {
      const s = await seed();
      const unpaid = await read(s, reader(evidence(s)));
      expect(unpaid).toMatchObject({
        status: 'in_step',
        localPaidMinor: 0,
        projection: { state: 'unpaid' },
      });

      const paymentId = await paidPayment(s);
      const { impl } = port();
      const synced = await run(paymentId, impl);
      const paid = await read(
        s,
        reader(
          evidence(s, {
            balanceMinor: 0,
            transactions: [
              {
                id: synced.externalId,
                kind: 'payment',
                amountMinor: s.invoice.totalAmount,
              },
            ],
          }),
        ),
      );
      expect(paid).toMatchObject({
        status: 'in_step',
        localPaidMinor: s.invoice.totalAmount,
        projection: { state: 'paid' },
        providerOnlyPayments: [],
      });
      const stored = await db.query(
        'SELECT status, local_paid_minor FROM accounting_invoice_readbacks',
      );
      expect(stored.rows).toHaveLength(1);
      expect(stored.rows[0]).toMatchObject({ status: 'in_step' });
    });

    it('flags a payment recorded only in the provider as drift', async () => {
      const s = await seed();
      const result = await read(
        s,
        reader(
          evidence(s, {
            balanceMinor: 0,
            transactions: [
              {
                id: 'qb-pay-ext',
                kind: 'payment',
                amountMinor: s.invoice.totalAmount,
              },
            ],
          }),
        ),
      );
      expect(result).toMatchObject({
        status: 'drift',
        reason: 'PROVIDER_ONLY_PAYMENT',
        providerOnlyPayments: ['qb-pay-ext'],
        localPaidMinor: 0,
      });
    });

    it('flags a local payment the provider lacks, and a void, as drift', async () => {
      const s = await seed();
      await paidPayment(s);
      expect(await read(s, reader(evidence(s)))).toMatchObject({
        status: 'drift',
        reason: 'PAID_AMOUNT_DIFFERS',
      });
      expect(
        await read(s, reader(evidence(s, { voided: true, balanceMinor: 0 }))),
      ).toMatchObject({ status: 'drift', reason: 'VOIDED_IN_PROVIDER' });
    });

    it('needs reconciliation when evidence is inconsistent, wrong scope, or the read fails', async () => {
      const s = await seed();
      expect(
        await read(s, reader(evidence(s, { balanceMinor: 1 }))),
      ).toMatchObject({
        status: 'needs_reconciliation',
        reason: 'EVIDENCE_INVALID',
      });
      expect(
        await read(s, reader(evidence(s, { realmId: 'realm-z' }))),
      ).toMatchObject({
        status: 'needs_reconciliation',
        reason: 'EVIDENCE_SCOPE_OR_TOTAL_MISMATCH',
      });
      expect(await read(s, reader(new Error('boom')))).toMatchObject({
        status: 'needs_reconciliation',
        reason: 'EVIDENCE_INVALID',
      });
    });

    it('refuses an unsynced invoice', async () => {
      const s = await seed({ syncInvoice: false });
      await expect(read(s, reader(evidence(s)))).rejects.toMatchObject({
        code: 'INVOICE_NOT_SYNCED',
      });
    });
  });

  describe('batches', () => {
    it('syncPending pushes the invoice then its payment, once, and reports skips', async () => {
      const s = await seed({ syncInvoice: false });
      const paymentId = await paidPayment(s);
      const { impl, calls } = port();
      const first = await inTenant(() =>
        syncPending({
          db,
          tenantId: TENANT,
          provider: provider(),
          payments: impl,
        }),
      );
      expect(first.items).toEqual([
        { kind: 'invoice', id: s.invoice.id, outcome: 'synced' },
        { kind: 'payment', id: paymentId, outcome: 'synced' },
      ]);
      expect(first.nextCursor).toBeNull();
      expect(invoicePush).toHaveBeenCalledTimes(1);
      const second = await inTenant(() =>
        syncPending({
          db,
          tenantId: TENANT,
          provider: provider(),
          payments: impl,
        }),
      );
      expect(second.items).toEqual([]);
      expect(invoicePush).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(1);
    });

    it('syncPending skips an invoice with missing mappings and continues', async () => {
      await connectFixtureTenant(db, TENANT, { secrets });
      const s = await issuedFixtureInvoice(db, TENANT);
      const result = await inTenant(() =>
        syncPending({
          db,
          tenantId: TENANT,
          provider: provider(),
          payments: port().impl,
        }),
      );
      expect(result.items).toEqual([
        {
          kind: 'invoice',
          id: s.invoice.id,
          outcome: 'skipped',
          reason: 'MAPPING_INCOMPLETE',
        },
      ]);
    });

    it('syncPending honors its bound and resumes from a keyset cursor', async () => {
      const s = await seed({ syncInvoice: false });
      const paymentId = await paidPayment(s);
      // Historical completed payments that can never sync must not starve the sweep.
      const orphans = await inTenant(async () => {
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const orphan = await (await PaymentCollection.create({ db })).create({
            customerId: s.customerId,
            currency: 'CAD',
            amount: 10 + i,
          });
          await db.query(
            "UPDATE payments SET status = 'completed' WHERE id = ?",
            orphan.id,
          );
          ids.push(String(orphan.id));
        }
        return ids;
      });
      const { impl, calls } = port();
      const run = (cursor?: string, limit = 1) =>
        inTenant(() =>
          syncPending({
            db,
            tenantId: TENANT,
            provider: provider(),
            payments: impl,
            limit,
            cursor,
          }),
        );
      const first = await run();
      expect(first.items).toEqual([
        { kind: 'invoice', id: s.invoice.id, outcome: 'synced' },
      ]);
      expect(first.nextCursor).toMatch(/^invoices:/);
      const second = await run(first.nextCursor ?? undefined);
      // The sweep moved past the (now synced) invoice and examined the payments in id order.
      const pushedPayment = second.items.filter((i) => i.outcome === 'synced');
      expect(pushedPayment).toEqual([
        { kind: 'payment', id: paymentId, outcome: 'synced' },
      ]);
      const skipped = second.items.filter((i) => i.outcome === 'skipped');
      for (const item of skipped) expect(orphans).toContain(item.id);
      expect(calls).toHaveLength(1);
      // Finish the sweep from wherever it stopped: nothing is pushed twice.
      let cursor = second.nextCursor;
      let guard = 0;
      while (cursor && guard++ < 10) cursor = (await run(cursor)).nextCursor;
      expect(cursor).toBeNull();
      expect(calls).toHaveLength(1);
      await expect(run('garbage')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(run(undefined, 0)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    it('syncPending reports pushes stuck in flight or unknown instead of hiding them', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      const { impl } = port(async () => Promise.reject(new Error('timeout')));
      await run(paymentId, impl).catch(() => undefined);
      const result = await inTenant(() =>
        syncPending({
          db,
          tenantId: TENANT,
          provider: provider(),
          payments: impl,
        }),
      );
      expect(result.items).toContainEqual({
        kind: 'payment',
        id: paymentId,
        outcome: 'skipped',
        reason: 'reconciliation',
      });
    });

    it('syncPending stops on a closed live gate instead of failing every item', async () => {
      await connectFixtureTenant(db, TENANT, {
        environment: 'production',
        secrets,
      });
      await expect(
        inTenant(() =>
          syncPending({
            db,
            tenantId: TENANT,
            provider: provider(),
            payments: port().impl,
          }),
        ),
      ).rejects.toMatchObject({ code: 'LIVE_ACCOUNTING_NOT_ENABLED' });
    });

    it('readbackDue reads only never-read or stale invoices, within its bound', async () => {
      const s = await seed();
      const evidence = (): AccountingInvoiceEvidence => ({
        tenantId: TENANT,
        realmId: 'realm-a',
        environment: 'sandbox',
        externalId: 'qb-inv-1',
        customerExternalId: 'qb-cust',
        currency: 'CAD',
        subtotalMinor: s.invoice.subtotal,
        discountMinor: 0,
        taxMinor: s.invoice.taxAmount,
        totalMinor: s.invoice.totalAmount,
        dueDate: null,
        balanceMinor: s.invoice.totalAmount,
        voided: false,
        complete: true,
        transactions: [],
      });
      const reader = { readInvoice: vi.fn(async () => evidence()) };
      const now = new Date('2026-11-10T12:00:00Z');
      const first = await inTenant(() =>
        readbackDue({ db, tenantId: TENANT, reader, now }),
      );
      expect(first.items).toEqual([
        {
          kind: 'readback',
          id: s.invoice.id,
          outcome: 'in_step',
          reason: undefined,
        },
      ]);
      const fresh = await inTenant(() =>
        readbackDue({
          db,
          tenantId: TENANT,
          reader,
          now: new Date(now.getTime() + 60_000),
        }),
      );
      expect(fresh.items).toEqual([]);
      const stale = await inTenant(() =>
        readbackDue({
          db,
          tenantId: TENANT,
          reader,
          now: new Date(now.getTime() + 3_600_000),
        }),
      );
      expect(stale.items).toHaveLength(1);
      expect(reader.readInvoice).toHaveBeenCalledTimes(2);
    });
  });

  // The real SDK payment operations behind commerce's port (#5420): commerce
  // persists the provider's own payload identity, so the SDK's descriptor check
  // passes and the exact bytes that were hashed are the bytes posted.
  describe('against the real QuickBooks payment operations', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    async function realProvider() {
      const real = (await getAccountingProvider({
        type: 'quickbooks',
        clientId: 'test',
        clientSecret: 'test',
        refreshToken: 'test',
        realmId: 'realm-a',
        environment: 'sandbox',
        maxRetries: 0,
      } as never)) as never as {
        ensureAccessToken: () => Promise<string>;
        payments: unknown;
      };
      vi.spyOn(real, 'ensureAccessToken').mockResolvedValue('token');
      return real;
    }

    function stubQuickBooks() {
      const posts: { url: URL; body: string }[] = [];
      let stored: Record<string, unknown> | null = null;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
          if (url.includes('/preferences'))
            return new Response(
              JSON.stringify({
                Preferences: {
                  CurrencyPrefs: { HomeCurrency: { value: 'CAD' } },
                },
              }),
            );
          if (init.method === 'POST') {
            posts.push({ url: new URL(url), body: String(init.body) });
            stored = {
              ...JSON.parse(String(init.body)),
              Id: 'qb-pay-real',
              SyncToken: '0',
              UnappliedAmt: 0,
            };
            return new Response(JSON.stringify({ Payment: stored }));
          }
          return new Response(JSON.stringify({ Payment: stored }));
        }),
      );
      return posts;
    }

    it('pushes a payment end to end: the persisted hash is the hash of the posted payload', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      const posts = stubQuickBooks();
      const port = paymentPortFromProvider(await realProvider());
      const result = await run(paymentId, port);
      expect(result).toMatchObject({
        status: 'synced',
        externalId: 'qb-pay-real',
      });
      expect(posts).toHaveLength(1);
      expect(posts[0]?.url.searchParams.get('requestid')).toBe(
        result.requestId,
      );
      const row = await rowOf(paymentId);
      expect(row?.status).toBe('synced');
      expect(row?.payloadHash).toBe(
        createHash('sha256')
          .update(posts[0]?.body ?? '')
          .digest('hex'),
      );
      // A repeat is a no-op and sends nothing.
      await run(paymentId, port);
      expect(posts).toHaveLength(1);
    });

    it('records a request the provider cannot form as a retryable rejection with its cause, sending nothing', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      await setAccountingMapping({ db }, s.scope, {
        kind: 'deposit_account',
        localId: 'default',
        externalId: 'not a valid ref!',
      });
      const posts = stubQuickBooks();
      const port = paymentPortFromProvider(await realProvider());
      await expect(run(paymentId, port)).rejects.toMatchObject({
        outcome: 'rejected',
        code: 'INVALID_PROVIDER_REQUEST',
      });
      expect(posts).toHaveLength(0);
      expect(await rowOf(paymentId)).toMatchObject({
        status: 'rejected',
        lastError: 'INVALID_PROVIDER_REQUEST',
      });
      // Fixing the mapping makes the same payment pushable, exactly once.
      await setAccountingMapping({ db }, s.scope, {
        kind: 'deposit_account',
        localId: 'default',
        externalId: 'qb-clearing',
      });
      expect(await run(paymentId, port)).toMatchObject({ status: 'synced' });
      expect(posts).toHaveLength(1);
    });

    it('names a provider without payment creation as not sent, not unknown', async () => {
      const s = await seed();
      const paymentId = await paidPayment(s);
      await expect(
        run(paymentId, paymentPortFromProvider({ payments: {} })),
      ).rejects.toMatchObject({
        outcome: 'rejected',
        code: 'PROVIDER_UNSUPPORTED',
      });
      expect(await rowOf(paymentId)).toMatchObject({
        status: 'rejected',
        lastError: 'PROVIDER_UNSUPPORTED',
      });
    });
  });

  describe('resolving an unknown push', () => {
    async function unknownPush() {
      const s = await seed();
      const paymentId = await paidPayment(s);
      const { impl } = port(async () => {
        throw new Error('socket hang up');
      });
      await expect(run(paymentId, impl)).rejects.toThrow('socket hang up');
      expect(await rowOf(paymentId)).toMatchObject({
        status: 'unknown',
        lastError: 'UNKNOWN_OUTCOME',
      });
      return { s, paymentId };
    }
    const readerOf = (
      transactions: AccountingInvoiceEvidence['transactions'],
    ) => ({
      readInvoice: vi.fn(
        async (): Promise<AccountingInvoiceEvidence> => ({
          tenantId: TENANT,
          realmId: 'realm-a',
          environment: 'sandbox',
          externalId: 'qb-inv-1',
          customerExternalId: 'qb-cust',
          currency: 'CAD',
          subtotalMinor: 0,
          discountMinor: 0,
          taxMinor: 0,
          totalMinor: 0,
          dueDate: null,
          balanceMinor: 0,
          voided: false,
          complete: true,
          transactions,
        }),
      ),
    });

    it('releases a push the provider never received, then retries it once', async () => {
      const { paymentId } = await unknownPush();
      const resolved = await inTenant(() =>
        resolveUnknownPaymentSync({
          db,
          tenantId: TENANT,
          paymentId,
          reader: readerOf([]),
        }),
      );
      expect(resolved.status).toBe('retryable');
      expect(await rowOf(paymentId)).toMatchObject({ status: 'rejected' });
      const { impl, calls } = port();
      expect(await run(paymentId, impl)).toMatchObject({ status: 'synced' });
      expect(calls).toHaveLength(1);
      // Resolving again is a no-op once synced.
      expect(
        await inTenant(() =>
          resolveUnknownPaymentSync({
            db,
            tenantId: TENANT,
            paymentId,
            reader: readerOf([]),
          }),
        ),
      ).toEqual({ status: 'not_unknown' });
    });

    it('leaves the push unknown when the provider already holds a payment on the invoice', async () => {
      const { paymentId } = await unknownPush();
      const resolved = await inTenant(() =>
        resolveUnknownPaymentSync({
          db,
          tenantId: TENANT,
          paymentId,
          reader: readerOf([{ id: 'p-1', kind: 'payment', amountMinor: 100 }]),
        }),
      );
      expect(resolved).toEqual({
        status: 'ambiguous',
        providerPaymentIds: ['p-1'],
      });
      expect(await rowOf(paymentId)).toMatchObject({ status: 'unknown' });
    });

    it('proves nothing from a partial read or another company', async () => {
      const { paymentId } = await unknownPush();
      for (const over of [
        { complete: false },
        { realmId: 'realm-other' },
        { externalId: 'qb-inv-other' },
      ]) {
        const reader = readerOf([]);
        const base = reader.readInvoice;
        reader.readInvoice = vi.fn(async () => ({
          ...(await base()),
          ...over,
        })) as never;
        expect(
          await inTenant(() =>
            resolveUnknownPaymentSync({
              db,
              tenantId: TENANT,
              paymentId,
              reader,
            }),
          ),
        ).toEqual({ status: 'inconclusive' });
        expect(await rowOf(paymentId)).toMatchObject({ status: 'unknown' });
      }
    });

    it('does not count a payment this tenant already synced as evidence', async () => {
      const s = await seed();
      const other = await paidPayment(s, 1);
      await run(
        other,
        port(async () => ({ externalId: 'p-earlier', syncedAt: new Date() }))
          .impl,
      );
      const paymentId = await paidPayment(s, s.invoice.totalAmount - 1);
      await expect(
        run(
          paymentId,
          port(async () => {
            throw new Error('socket hang up');
          }).impl,
        ),
      ).rejects.toThrow('socket hang up');
      const resolved = await inTenant(() =>
        resolveUnknownPaymentSync({
          db,
          tenantId: TENANT,
          paymentId,
          reader: readerOf([
            { id: 'p-earlier', kind: 'payment', amountMinor: 1 },
          ]),
        }),
      );
      expect(resolved.status).toBe('retryable');
    });

    it('keeps the request id across a release, and refuses a retry whose facts changed', async () => {
      const { s, paymentId } = await unknownPush();
      const before = await rowOf(paymentId);
      await inTenant(() =>
        resolveUnknownPaymentSync({
          db,
          tenantId: TENANT,
          paymentId,
          reader: readerOf([]),
        }),
      );
      // Unchanged facts: same request id, pushed once.
      const same = port();
      await run(paymentId, same.impl);
      expect(same.calls[0]?.requestId).toBe(before?.requestId);

      // Changed facts after a release: a different request id is never sent.
      const t = await unknownPush();
      await inTenant(() =>
        resolveUnknownPaymentSync({
          db,
          tenantId: TENANT,
          paymentId: t.paymentId,
          reader: readerOf([]),
        }),
      );
      await setAccountingMapping({ db }, t.s.scope, {
        kind: 'deposit_account',
        localId: 'default',
        externalId: 'qb-other-clearing',
      });
      const changed = port();
      await expect(run(t.paymentId, changed.impl)).rejects.toMatchObject({
        code: 'RECONCILIATION_REQUIRED',
      });
      expect(changed.calls).toHaveLength(0);
      void s;
    });

    it('keeps the request id pinned through later rejections', async () => {
      const { s, paymentId } = await unknownPush();
      await inTenant(() =>
        resolveUnknownPaymentSync({
          db,
          tenantId: TENANT,
          paymentId,
          reader: readerOf([]),
        }),
      );
      // The retry is rejected (e.g. a dead grant), which clears the release marker.
      const dead = port(async () => {
        throw Object.assign(new Error('x'), { outcome: 'rejected' });
      });
      await expect(run(paymentId, dead.impl)).rejects.toThrow('x');
      expect(await rowOf(paymentId)).toMatchObject({
        status: 'rejected',
        lastError: 'REJECTED',
      });
      await setAccountingMapping({ db }, s.scope, {
        kind: 'deposit_account',
        localId: 'default',
        externalId: 'qb-other-clearing',
      });
      const changed = port();
      await expect(run(paymentId, changed.impl)).rejects.toMatchObject({
        code: 'RECONCILIATION_REQUIRED',
      });
      expect(changed.calls).toHaveLength(0);
    });

    it('changes nothing when the provider cannot be read', async () => {
      const { paymentId } = await unknownPush();
      await expect(
        inTenant(() =>
          resolveUnknownPaymentSync({
            db,
            tenantId: TENANT,
            paymentId,
            reader: {
              readInvoice: async () => {
                throw new Error('QBO 503');
              },
            },
          }),
        ),
      ).rejects.toThrow('QBO 503');
      expect(await rowOf(paymentId)).toMatchObject({ status: 'unknown' });
    });
  });
});
