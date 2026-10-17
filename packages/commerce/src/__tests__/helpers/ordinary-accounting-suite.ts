import { randomUUID } from 'node:crypto';
import type {
  QuickBooksReceivableReadback,
  QuickBooksReceivableRequest,
} from '@happyvertical/accounting';
import { AccountCollection } from '@happyvertical/smrt-ledgers';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, vi } from 'vitest';
import { CustomerCollection } from '../../collections/CustomerCollection.js';
import { InvoiceCollection } from '../../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../../collections/PaymentCollection.js';
import { withDocumentMoneyTransaction } from '../../document-money-internal.js';
import {
  readFrozenAccountingSyncState,
  syncFrozenInvoiceToAccounting,
} from '../../invoice-accounting-sync.js';
import { Invoice } from '../../models/Invoice.js';
import {
  loadOrdinaryCreditAccountingSnapshot,
  readOrdinaryInvoiceAccountingState,
  reconcileOrdinaryAccountingStep,
  reconcileOrdinaryBaseInvoice,
  reconcileOrdinaryCreditAccounting,
  syncOrdinaryCreditToAccounting,
  syncOrdinaryInvoiceToAccounting,
  syncOrdinaryRefundToAccounting,
  toOrdinaryCreditAccountingInput,
} from '../../ordinary-accounting.js';
import { ensureTenantTaxCodes } from '../../tax/standard-codes.js';
import { InvoiceStatus } from '../../types/index.js';

export async function proveOrdinaryAccounting(db: DatabaseInterface) {
  const tenantId = randomUUID();
  await ensureTenantTaxCodes(db, tenantId);
  await withTenant({ tenantId }, async () => {
    const invoices = await InvoiceCollection.create({ db }),
      lines = await InvoiceLineItemCollection.create({ db }),
      payments = await PaymentCollection.create({ db }),
      allocations = await PaymentAllocationCollection.create({ db });
    const customer = await (await CustomerCollection.create({ db })).create({});
    const original = await invoices.create({
      customerId: customer.id!,
      customerExternalId: 'customer-1',
      currency: 'CAD',
      invoiceNumber: 'ORD-1',
    });
    const line = await lines.create({
      invoiceId: original.id!,
      quantity: 2000,
      unitPrice: 1,
      description: 'Ordinary source',
    });
    const load = async () => {
      const row = await invoices.get({ id: original.id! }, { cache: false });
      if (!row) throw Error('Missing source');
      return row;
    };
    let row = await load();
    row.status = InvoiceStatus.SENT;
    await row.save();
    const mapping = {
      kind: 'ordinary' as const,
      realmId: 'realm-1',
      environment: 'sandbox' as const,
      version: 'v1',
      reviewEvidenceRef: 'review-1',
      accountingBasis: 'accrual' as const,
      taxTiming: 'invoice-tax-point' as const,
      currency: 'CAD',
      customerRef: 'customer-1',
      receivablesAccountRef: 'ar',
      cashAccountRef: 'bank',
    };
    const reads = new Map<string, QuickBooksReceivableReadback>();
    let failKind: string | null = null;
    const execute = vi.fn(async (request: QuickBooksReceivableRequest) => {
      const result: QuickBooksReceivableReadback = {
        externalId: `step-${reads.size}`,
        syncToken: '0',
        kind: request.input.kind,
        customerRef: 'customer-1',
        currency: 'CAD',
        effectiveOn: request.input.effectiveOn,
        amountMinor: request.input.amountMinor,
        nonCashAppliedMinor:
          request.input.kind === 'application' ? request.input.amountMinor : 0,
        recordedCashChangeMinor:
          request.input.kind === 'cash-refund' ? -request.input.amountMinor : 0,
        providerProcessedCashMinor: 0,
        bankSettlementVerified: false,
        source: request.input.source,
        payloadHash: request.payloadHash,
      };
      reads.set(result.externalId, result);
      if (failKind === request.input.kind) {
        failKind = null;
        throw Error('Lost response');
      }
      return result;
    });
    let creditNumber = 0;
    let failCredit = false;
    let failBase = true;
    const creditPush = vi.fn(async () => {
      const result = {
        externalId: `credit-${++creditNumber}`,
        syncedAt: new Date(),
        success: true,
        action: 'created' as const,
      };
      if (failCredit) {
        failCredit = false;
        throw Error('Lost credit response');
      }
      return result;
    });
    const provider = {
      type: 'quickbooks' as const,
      invoices: {
        push: vi.fn(async () => {
          if (failBase) {
            failBase = false;
            throw Error('Lost base response');
          }
          return {
            externalId: 'invoice-1',
            syncedAt: new Date(),
            success: true,
            action: 'created' as const,
          };
        }),
      } as any,
      creditMemos: { push: creditPush, sync: creditPush },
      receivableTransfers: {
        verifyMapping: vi.fn(async () => ({
          mappingHash: 'verified',
          homeCurrency: 'CAD',
        })),
        execute,
        read: vi.fn(
          async (_request: QuickBooksReceivableRequest, id: string) => {
            const found = reads.get(id);
            if (!found) throw Error('Missing remote');
            return found;
          },
        ),
      },
    };
    const scope = { db, tenantId, invoiceId: original.id!, provider };
    const invoiceMapping = {
      realmId: 'realm-1',
      environment: 'sandbox' as const,
      lines: { [line.id!]: { itemRef: 'item-1', taxCodeRef: 'non-tax' } },
      components: {},
    };
    const init = {
      ...scope,
      requestId: 'ordinary-1',
      evidenceRef: 'approved-contract',
      mapping,
      invoiceMapping,
    };
    await expect(
      syncOrdinaryInvoiceToAccounting({ ...init, tenantId: randomUUID() }),
    ).rejects.toThrow('active tenant');
    await expect(
      syncOrdinaryInvoiceToAccounting({
        ...init,
        mapping: { ...mapping, realmId: 'wrong' },
      }),
    ).rejects.toThrow('canonical');
    expect(provider.receivableTransfers.verifyMapping).not.toHaveBeenCalled();
    await expect(syncOrdinaryInvoiceToAccounting(init)).rejects.toThrow(
      'Lost base response',
    );
    const pendingBase = readOrdinaryInvoiceAccountingState(await load())!;
    expect(pendingBase).toMatchObject({
      status: 'pending',
      externalInvoiceId: null,
      invoiceMapping,
    });
    const owner = readFrozenAccountingSyncState(await load())!;
    await expect(
      reconcileOrdinaryBaseInvoice({
        ...scope,
        mapping: { ...invoiceMapping, realmId: 'wrong' },
        requestId: owner.requestId,
        attemptId: owner.attemptId,
        outcome: {
          status: 'found',
          externalId: 'invoice-1',
          syncedAt: new Date(),
        },
      }),
    ).rejects.toThrow('mapping differs');
    await reconcileOrdinaryBaseInvoice({
      ...scope,
      mapping: pendingBase.invoiceMapping,
      requestId: owner.requestId,
      attemptId: owner.attemptId,
      outcome: {
        status: 'found',
        externalId: 'invoice-1',
        syncedAt: new Date(),
      },
    });
    const initialized = await syncOrdinaryInvoiceToAccounting(init);
    expect(provider.invoices.push).toHaveBeenCalledTimes(1);
    expect(initialized).toMatchObject({
      kind: 'ordinary',
      status: 'ready',
      credits: [],
      refunds: [],
    });
    expect((await load()).retentionStateJson).toBe('');
    expect(await syncOrdinaryInvoiceToAccounting(init)).toEqual(initialized);
    await expect(
      syncOrdinaryInvoiceToAccounting({ ...init, evidenceRef: 'changed' }),
    ).rejects.toThrow('changed');
    row = await load();
    row.ordinaryAccountingStateJson = '';
    await expect(row.save()).rejects.toThrow('managed');
    const accounts = await AccountCollection.create({ db });
    const cash = await accounts.create({
        number: '1000-ordinary',
        name: 'Cash',
        type: 'asset',
      }),
      ar = await accounts.create({
        number: '1200-ordinary',
        name: 'AR',
        type: 'asset',
      });
    const received = await payments.create({
      customerId: customer.id!,
      currency: 'CAD',
      amount: 1500,
    });
    await received.recordPayment({
      ledgerId: '',
      cashAccountId: cash.id!,
      receivablesAccountId: ar.id!,
      effectiveOn: '2026-10-18',
    });
    await allocations.allocatePayment({
      paymentId: received.id!,
      allocations: [
        { id: randomUUID(), invoiceId: original.id!, amount: 1500 },
      ],
    });
    const makeCredit = async (amount: number, prefix: string) => {
      const credit = await invoices.create({
        id: `${prefix}${randomUUID().slice(1)}`,
        kind: 'credit_note',
        creditedInvoiceId: original.id!,
        issueDate: new Date('2026-10-18T00:00:00Z'),
        customerId: customer.id!,
        customerExternalId: 'customer-1',
        currency: 'CAD',
        invoiceNumber: `CR-${prefix}`,
      });
      const child = await lines.create({
        invoiceId: credit.id!,
        creditedLineId: line.id!,
        quantity: amount,
        unitPrice: 0,
      });
      const current = (await invoices.get(
        { id: credit.id! },
        { cache: false },
      ))!;
      current.status = InvoiceStatus.SENT;
      await current.save();
      return {
        creditId: credit.id!,
        command: {
          ...scope,
          creditInvoiceId: credit.id!,
          requestId: `credit-${prefix}`,
          evidenceRef: 'credit-reviewed',
          effectiveOn: '2026-10-18',
          creditMapping: {
            ...invoiceMapping,
            lines: {
              [child.id!]: { itemRef: 'item-1', taxCodeRef: 'non-tax' },
            },
          },
        },
      };
    };
    const first = await makeCredit(500, 'f');
    expect(
      (await loadOrdinaryCreditAccountingSnapshot(first.command)).document.kind,
    ).toBe('creditMemo');
    expect(
      (
        await toOrdinaryCreditAccountingInput({
          ...first.command,
          mapping: first.command.creditMapping,
        })
      ).creditedInvoiceExternalId,
    ).toBe('invoice-1');
    await expect(
      syncFrozenInvoiceToAccounting({
        ...scope,
        invoiceId: first.creditId,
        mapping: first.command.creditMapping,
      }),
    ).rejects.toThrow('owning');
    const originalSave = Invoice.prototype.saveDerived;
    let failSave = true;
    const fault = vi
      .spyOn(Invoice.prototype, 'saveDerived')
      .mockImplementation(async function (this: Invoice, ...args) {
        if (
          this.id === original.id &&
          this.ordinaryAccountingStateJson &&
          JSON.parse(this.ordinaryAccountingStateJson).credits.length &&
          failSave
        ) {
          failSave = false;
          throw Error('Reservation fault');
        }
        return originalSave.apply(this, args);
      });
    await expect(syncOrdinaryCreditToAccounting(first.command)).rejects.toThrow(
      'Reservation fault',
    );
    fault.mockRestore();
    expect(
      readOrdinaryInvoiceAccountingState(await load())!.credits,
    ).toHaveLength(0);
    expect(creditPush).not.toHaveBeenCalled();
    failKind = 'application';
    await expect(syncOrdinaryCreditToAccounting(first.command)).rejects.toThrow(
      'Lost response',
    );
    await expect(syncOrdinaryCreditToAccounting(first.command)).rejects.toThrow(
      'unresolved',
    );
    const recover = async () => {
      const state = readOrdinaryInvoiceAccountingState(await load())!;
      const step = state.steps.find((s) => s.status === 'unknown')!;
      const result = [...reads.values()].find(
        (r) => r.payloadHash === step.request.payloadHash,
      )!;
      await expect(
        reconcileOrdinaryAccountingStep({
          ...scope,
          stepKey: step.key,
          requestId: step.request.requestId,
          attemptId: 'wrong',
          outcome: { status: 'found', externalId: result.externalId },
        }),
      ).rejects.toThrow('owner');
      await reconcileOrdinaryAccountingStep({
        ...scope,
        stepKey: step.key,
        requestId: step.request.requestId,
        attemptId: step.attemptId,
        outcome: { status: 'found', externalId: result.externalId },
      });
    };
    await recover();
    const applied = await syncOrdinaryCreditToAccounting(first.command);
    expect(applied.credits[0]).toMatchObject({
      appliedMinor: 500,
      committed: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(creditPush).toHaveBeenCalledTimes(1);
    const second = await makeCredit(200, '0');
    for (let i = 0; i < 3; i++) {
      const c = (await invoices.get(
        { id: second.creditId },
        { cache: false },
      ))!;
      await c.save();
      expect(
        (await invoices.get({ id: first.creditId }, { cache: false }))!
          .creditedAmount,
      ).toBe(500);
      expect((await load()).creditedAmount).toBe(700);
    }
    failCredit = true;
    await expect(
      syncOrdinaryCreditToAccounting(second.command),
    ).rejects.toThrow('Lost credit response');
    const creditOwner = readFrozenAccountingSyncState(
      (await invoices.get({ id: second.creditId }, { cache: false }))!,
    )!;
    await reconcileOrdinaryCreditAccounting({
      ...scope,
      creditInvoiceId: second.creditId,
      requestId: creditOwner.requestId,
      attemptId: creditOwner.attemptId,
      outcome: {
        status: 'found',
        externalId: `credit-${creditNumber}`,
        syncedAt: new Date(),
      },
    });
    const credited = await syncOrdinaryCreditToAccounting(second.command);
    expect(credited.credits[1]).toMatchObject({
      appliedMinor: 0,
      committed: true,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const refund = await payments.create({
      kind: 'refund',
      customerId: customer.id!,
      currency: 'CAD',
      amount: 200,
    });
    await refund.recordRefund({
      ledgerId: '',
      cashAccountId: cash.id!,
      receivablesAccountId: ar.id!,
      effectiveOn: '2026-10-19',
    });
    const [allocation] = await allocations.allocatePayment({
      paymentId: refund.id!,
      allocations: [
        { id: randomUUID(), invoiceId: second.creditId, amount: 200 },
      ],
    });
    const refundCommand = {
      ...scope,
      paymentId: refund.id!,
      creditInvoiceId: second.creditId,
      requestId: 'refund-1',
      evidenceRef: 'bank-statement',
      effectiveOn: '2026-10-19',
    };
    await expect(
      syncOrdinaryRefundToAccounting({
        ...refundCommand,
        paymentId: received.id!,
      }),
    ).rejects.toThrow('cash journal');
    await expect(
      syncOrdinaryRefundToAccounting({
        ...refundCommand,
        creditInvoiceId: first.creditId,
      }),
    ).rejects.toThrow('exact full source-credit allocation');
    await expect(
      syncOrdinaryRefundToAccounting({
        ...refundCommand,
        tenantId: randomUUID(),
      }),
    ).rejects.toThrow('active tenant');
    await expect(
      syncOrdinaryRefundToAccounting({
        ...refundCommand,
        effectiveOn: '2026-10-18',
      }),
    ).rejects.toThrow('cash journal');
    await expect(
      withDocumentMoneyTransaction(db, (tx) =>
        syncOrdinaryRefundToAccounting({ ...refundCommand, db: tx }),
      ),
    ).rejects.toThrow('caller-owned');
    failKind = 'cash-refund';
    const competing = await Promise.allSettled([
      syncOrdinaryRefundToAccounting(refundCommand),
      syncOrdinaryRefundToAccounting(refundCommand),
    ]);
    expect(competing.every((result) => result.status === 'rejected')).toBe(
      true,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    await expect(allocation.delete()).rejects.toThrow('cannot be deleted');
    await expect(refund.delete()).rejects.toThrow('cannot be deleted');
    const pinned = (await payments.get({ id: refund.id! }, { cache: false }))!;
    pinned.reference = 'changed';
    await expect(pinned.save()).rejects.toThrow('immutable');
    await recover();
    failKind = 'application';
    await expect(syncOrdinaryRefundToAccounting(refundCommand)).rejects.toThrow(
      'Lost response',
    );
    await recover();
    const done = await syncOrdinaryRefundToAccounting(refundCommand);
    expect(done.status).toBe('ready');
    expect(done.refunds[0]).toMatchObject({
      amountMinor: 200,
      committed: true,
      effectiveOn: '2026-10-19',
    });
    expect(execute).toHaveBeenCalledTimes(3);
    await syncOrdinaryRefundToAccounting(refundCommand);
    expect(execute).toHaveBeenCalledTimes(3);
    await expect(
      syncOrdinaryRefundToAccounting({
        ...refundCommand,
        evidenceRef: 'changed',
      }),
    ).rejects.toThrow('changed facts');
    const cancel = (await invoices.get(
      { id: first.creditId },
      { cache: false },
    ))!;
    cancel.cancel();
    await expect(cancel.save()).rejects.toThrow('explicit reversal');
    row = await load();
    expect(row.totalAmount).toBe(2000);
    expect(row.creditedAmount).toBe(700);
    expect(row.retentionAccountingStateJson).toBe('');
  });
}
