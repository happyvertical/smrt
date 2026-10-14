import { getTestDatabase } from '@happyvertical/smrt-core';
import { AccountCollection } from '@happyvertical/smrt-ledgers';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { PaymentAllocationCollection } from '../collections/PaymentAllocationCollection.js';
import { PaymentCollection } from '../collections/PaymentCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { calculateAvailableRefund } from '../credit-allocation.js';
import {
  getInvoiceMoneyFacts,
  previewInvoiceMoney,
} from '../document-money.js';
import { ensureTenantTaxCodes } from '../tax/legacy.js';
import { InvoiceStatus } from '../types/index.js';

describe('credit note money persistence (#3939)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function activate(tenantId: string): Promise<string> {
    await ensureTenantTaxCodes(db, tenantId);
    return withTenant({ tenantId }, async () => {
      const component = await (
        await TaxComponentCollection.create({ db })
      ).create({
        name: 'GST',
        percent: '5',
      });
      const code = await (await TaxCodeCollection.create({ db })).create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: component.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const row = await settings.getOrCreateForTenant(tenantId);
      row.defaultSalesTaxCodeId = code.id;
      row.defaultLineAmountType = 'exclusive';
      row.taxRoundingScope = 'document';
      await row.save();
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
      return code.id;
    });
  }

  async function activateEpic(tenantId: string): Promise<{
    gstCodeId: string;
    gstPstCodeId: string;
  }> {
    await ensureTenantTaxCodes(db, tenantId);
    return withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({ name: 'GST', percent: '5' });
      const pst = await components.create({ name: 'PST', percent: '7' });
      const codes = await TaxCodeCollection.create({ db });
      const gstCode = await codes.create({
        code: 'gst-epic',
        name: 'GST',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const gstPstCode = await codes.create({
        code: 'gst-pst-epic',
        name: 'GST + PST',
        components: [
          { taxComponentId: gst.id, compound: false },
          { taxComponentId: pst.id, compound: false },
        ],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const row = await settings.getOrCreateForTenant(tenantId);
      row.defaultSalesTaxCodeId = gstCode.id;
      row.defaultLineAmountType = 'exclusive';
      row.taxRoundingScope = 'line';
      await row.save();
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
      return { gstCodeId: gstCode.id, gstPstCodeId: gstPstCode.id };
    });
  }

  async function createEpicSource(
    tenantId: string,
    mode: 'exclusive' | 'inclusive',
    scope: 'line' | 'document',
  ) {
    const { gstCodeId, gstPstCodeId } = await activateEpic(tenantId);
    return withTenant({ tenantId }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      const row = await settings.getOrCreateForTenant(tenantId);
      row.defaultLineAmountType = mode;
      row.taxRoundingScope = scope;
      await row.save();
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: gstCodeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const source = await invoices.create({
        customerId: customer.id,
        invoiceNumber: `EPIC-${mode}-${scope}`,
        currency: 'CAD',
      });
      const specifications = [
        {
          description: 'Design',
          quantity: 10,
          unitPrice: 8_500,
          discountType: 'percent' as const,
          discountRate: '10',
          taxCodeId: gstCodeId,
        },
        {
          description: 'Laptop stand',
          quantity: 2,
          unitPrice: 4_999,
          discountType: 'amount' as const,
          discount: 500,
          taxCodeId: gstPstCodeId,
        },
        {
          description: 'Software licence',
          quantity: 12,
          unitPrice: 2_000,
          taxCodeId: gstPstCodeId,
        },
        {
          description: 'Book',
          quantity: 1,
          unitPrice: 4_500,
          taxCodeId: gstCodeId,
        },
      ];
      const sourceLines = [];
      for (const specification of specifications)
        sourceLines.push(
          await lines.create({
            invoiceId: source.id,
            taxMode: 'override',
            ...specification,
          }),
        );
      const issued = await invoices.get({ id: source.id }, { cache: false });
      if (!issued) throw new Error('Expected epic source invoice');
      issued.status = InvoiceStatus.SENT;
      await issued.save();
      return { customer, issued, sourceLines };
    });
  }

  it('credits frozen snapshots, stores credit-note tax, and updates source balance', async () => {
    const taxCodeId = await activate('credit-a');
    await withTenant({ tenantId: 'credit-a' }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: taxCodeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const source = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'INV-SOURCE',
        currency: 'CAD',
      });
      const sourceLine = await lines.create({
        invoiceId: source.id,
        description: 'Two stands',
        quantity: 2,
        unitPrice: 4_749,
        taxMode: 'override',
        taxCodeId,
        revenueAccountId: 'revenue',
      });
      const issuedSource = await invoices.get(
        { id: source.id },
        { cache: false },
      );
      if (!issuedSource) throw new Error('Expected source invoice');
      issuedSource.status = InvoiceStatus.SENT;
      await issuedSource.save();
      const originalTaxes = await (
        await DocumentTaxCollection.create({ db })
      ).findByDocument('credit-a', 'invoice', issuedSource.id);

      const credit = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: issuedSource.id,
        customerId: customer.id,
        invoiceNumber: 'CN-FULL',
        currency: 'CAD',
      });
      const creditLine = await lines.create({
        invoiceId: credit.id,
        creditedLineId: sourceLine.id,
        description: 'Return stands',
        quantity: 2,
        unitPrice: 0,
      });
      expect(creditLine).toMatchObject({
        amount: sourceLine.amount,
        taxAmount: sourceLine.taxAmount,
        taxCodeId,
      });
      const issuedCredit = await invoices.get(
        { id: credit.id },
        { cache: false },
      );
      if (!issuedCredit) throw new Error('Expected credit note');
      issuedCredit.status = InvoiceStatus.SENT;
      await issuedCredit.save();

      const creditTaxes = await (
        await DocumentTaxCollection.create({ db })
      ).findByDocument('credit-a', 'credit_note', credit.id);
      expect(
        creditTaxes.map((row) => ({
          taxableMinor: row.taxableMinor,
          taxMinor: row.taxMinor,
          taxComponentId: row.taxComponentId,
        })),
      ).toEqual(
        originalTaxes.map((row) => ({
          taxableMinor: row.taxableMinor,
          taxMinor: row.taxMinor,
          taxComponentId: row.taxComponentId,
        })),
      );
      const refreshedSource = await invoices.get(
        { id: issuedSource.id },
        { cache: false },
      );
      expect(refreshedSource?.creditedAmount).toBe(issuedSource.totalAmount);
      expect(refreshedSource?.getBalance()).toBe(0);

      const cancellable = await invoices.get(
        { id: issuedCredit.id },
        { cache: false },
      );
      if (!cancellable) throw new Error('Expected issued credit note');
      cancellable.cancel();
      await cancellable.save();
      const afterCancellation = await invoices.get(
        { id: issuedSource.id },
        { cache: false },
      );
      expect(afterCancellation?.creditedAmount).toBe(0);
      expect(afterCancellation?.getBalance()).toBe(issuedSource.totalAmount);
    });
  });

  it('fully reverses persisted epic A and B snapshots including the document-scope cent', async () => {
    for (const scenario of [
      { tenantId: 'credit-epic-a', mode: 'exclusive', scope: 'line' },
      { tenantId: 'credit-epic-b', mode: 'inclusive', scope: 'document' },
    ] as const) {
      const { customer, issued, sourceLines } = await createEpicSource(
        scenario.tenantId,
        scenario.mode,
        scenario.scope,
      );
      await withTenant({ tenantId: scenario.tenantId }, async () => {
        const invoices = await InvoiceCollection.create({ db });
        const lines = await InvoiceLineItemCollection.create({ db });
        const credit = await invoices.create({
          kind: 'credit_note',
          creditedInvoiceId: issued.id,
          customerId: customer.id,
          invoiceNumber: `CN-${scenario.mode}-${scenario.scope}`,
          currency: 'CAD',
        });
        for (const sourceLine of sourceLines)
          await lines.create({
            invoiceId: credit.id,
            creditedLineId: sourceLine.id,
            description: `Credit ${sourceLine.description}`,
            quantity: sourceLine.quantity,
            unitPrice: 0,
          });
        const issuedCredit = await invoices.get(
          { id: credit.id },
          { cache: false },
        );
        if (!issuedCredit) throw new Error('Expected epic credit note');
        issuedCredit.status = InvoiceStatus.SENT;
        await issuedCredit.save();
        const documents = await DocumentTaxCollection.create({ db });
        const sourceTax = await documents.findByDocument(
          scenario.tenantId,
          'invoice',
          issued.id,
        );
        const creditTax = await documents.findByDocument(
          scenario.tenantId,
          'credit_note',
          credit.id,
        );
        expect(issuedCredit).toMatchObject({
          subtotal: issued.subtotal,
          taxAmount: issued.taxAmount,
          totalAmount: issued.totalAmount,
        });
        expect(
          creditTax.map((row) => [
            row.taxComponentId,
            row.taxableMinor,
            row.taxMinor,
          ]),
        ).toEqual(
          sourceTax.map((row) => [
            row.taxComponentId,
            row.taxableMinor,
            row.taxMinor,
          ]),
        );
        if (scenario.mode === 'inclusive') {
          const credited = await lines.findByInvoice(credit.id);
          const software = credited.find((line) =>
            line.description.includes('Software licence'),
          );
          expect(
            software?.taxComponents.map((component) => component.taxMinor),
          ).toEqual([1_072, 1_500]);
        }
      });
    }
  });

  it('previews drafts without writes and exposes exact stored facts', async () => {
    const taxCodeId = await activate('credit-preview');
    await withTenant({ tenantId: 'credit-preview' }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: taxCodeId,
      });
      const invoice = await (await InvoiceCollection.create({ db })).create({
        customerId: customer.id,
        invoiceNumber: 'PREVIEW',
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        invoiceId: invoice.id,
        description: 'Stored',
        quantity: 1,
        unitPrice: 100,
      });
      const preview = await previewInvoiceMoney({
        db,
        tenantId: 'credit-preview',
        invoiceId: invoice.id,
        draft: { lines: [{ id: line.id, unitPrice: 200 }] },
      });
      expect(preview.header).toMatchObject({
        subtotalMinor: 200,
        taxAmountMinor: 10,
      });
      const stored = await getInvoiceMoneyFacts({
        db,
        tenantId: 'credit-preview',
        invoiceId: invoice.id,
      });
      expect(stored).toMatchObject({
        source: 'stored',
        kind: 'invoice',
        header: { subtotalMinor: 100, taxAmountMinor: 5 },
      });
      expect(stored.taxes).toHaveLength(1);
      await expect(
        previewInvoiceMoney({
          db,
          tenantId: 'credit-preview',
          invoiceId: invoice.id,
          draft: {
            lines: [
              { id: line.id, unitPrice: 200 },
              { id: line.id, unitPrice: 300 },
            ],
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
      await expect(
        previewInvoiceMoney({
          db,
          tenantId: 'credit-preview',
          invoiceId: invoice.id,
          draft: {
            lines: [{ id: crypto.randomUUID(), unitPrice: 200 }],
          },
        }),
      ).rejects.toMatchObject({ code: 'INVALID_MONEY_INPUT' });
      const proposed = await previewInvoiceMoney({
        db,
        tenantId: 'credit-preview',
        invoiceId: invoice.id,
        draft: {
          lines: [{ description: 'New preview line', unitPrice: 50 }],
        },
      });
      expect(proposed.lines).toHaveLength(1);
      expect(proposed.lines[0]?.id).toBeTruthy();
    });
  });

  it('refuses stored facts for legacy and migrating tenants', async () => {
    for (const state of ['legacy', 'migrating'] as const) {
      const tenantId = `facts-${state}`;
      await ensureTenantTaxCodes(db, tenantId);
      await withTenant({ tenantId }, async () => {
        const invoice = await (await InvoiceCollection.create({ db })).create({
          invoiceNumber: `FACTS-${state}`,
          currency: 'CAD',
        });
        if (state === 'migrating')
          await (
            await TaxSettingsCollection.create({ db })
          ).beginMoneyMigration(tenantId);
        await expect(
          getInvoiceMoneyFacts({ db, tenantId, invoiceId: invoice.id }),
        ).rejects.toMatchObject({
          code:
            state === 'migrating' ? 'FROZEN_DOCUMENT' : 'INVALID_MONEY_INPUT',
        });
      });
    }
  });

  it('uses frozen component rates for a partial quantity after a live rate change', async () => {
    const taxCodeId = await activate('credit-rate');
    await withTenant({ tenantId: 'credit-rate' }, async () => {
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: taxCodeId,
      });
      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const source = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'INV-RATE',
        currency: 'CAD',
      });
      const sourceLine = await lines.create({
        invoiceId: source.id,
        description: 'Two units',
        quantity: 2,
        unitPrice: 4_749,
        taxMode: 'override',
        taxCodeId,
      });
      const persistedSource = await invoices.get(
        { id: source.id },
        { cache: false },
      );
      if (!persistedSource) throw new Error('Expected source invoice');
      persistedSource.status = InvoiceStatus.SENT;
      await persistedSource.save();

      const replacement = await (
        await TaxComponentCollection.create({ db })
      ).create({ name: 'GST 8%', percent: '8' });
      const liveCode = await (await TaxCodeCollection.create({ db })).get(
        { id: taxCodeId },
        { cache: false },
      );
      if (!liveCode) throw new Error('Expected tax code');
      liveCode.components = [
        { taxComponentId: replacement.id, compound: false },
      ];
      await liveCode.save();

      const credit = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: persistedSource.id,
        customerId: customer.id,
        invoiceNumber: 'CN-RATE',
        currency: 'CAD',
      });
      const partial = await lines.create({
        invoiceId: credit.id,
        creditedLineId: sourceLine.id,
        description: 'One returned unit',
        quantity: 1,
        unitPrice: 0,
      });
      expect(partial).toMatchObject({ amount: 4_749, taxAmount: 237 });
      expect(partial.taxComponents).toMatchObject([
        { percent: '5', taxMinor: 237 },
      ]);
    });
  });

  it('caps refunds to unapplied credit after source settlement and prior refunds', () => {
    expect(
      calculateAvailableRefund({
        sourceTotalMinor: 122_568,
        sourcePaidMinor: 100_000,
        issuedCreditMinor: 30_000,
        settledRefundMinor: 0,
      }),
    ).toBe(7_432);
    expect(
      calculateAvailableRefund({
        sourceTotalMinor: 122_568,
        sourcePaidMinor: 100_000,
        issuedCreditMinor: 30_000,
        settledRefundMinor: 7_432,
      }),
    ).toBe(0);
    expect(
      calculateAvailableRefund({
        sourceTotalMinor: 122_568,
        sourcePaidMinor: 0,
        issuedCreditMinor: 30_000,
        settledRefundMinor: 0,
      }),
    ).toBe(0);
  });

  it('allocates only unapplied credit to a refund and reopens cancellation after removal', async () => {
    await activate('credit-refund');
    await withTenant({ tenantId: 'credit-refund' }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      const setting = await settings.getOrCreateForTenant('credit-refund');
      setting.defaultLineAmountType = 'none';
      await setting.save();
      const customer = await (await CustomerCollection.create({ db })).create(
        {},
      );
      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const source = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'REFUND-SOURCE',
        currency: 'CAD',
      });
      const sourceLine = await lines.create({
        invoiceId: source.id,
        description: 'Original sale',
        quantity: 1,
        unitPrice: 122_568,
      });
      const issuedSource = await invoices.get(
        { id: source.id },
        { cache: false },
      );
      if (!issuedSource) throw new Error('Expected refund source');
      issuedSource.status = InvoiceStatus.SENT;
      await issuedSource.save();

      const accounts = await AccountCollection.create({ db });
      const cash = await accounts.create({
        number: '1000-refund',
        name: 'Refund cash',
        type: 'asset',
      });
      const receivables = await accounts.create({
        number: '1200-refund',
        name: 'Refund receivables',
        type: 'asset',
      });
      const payments = await PaymentCollection.create({ db });
      const allocations = await PaymentAllocationCollection.create({ db });
      const payment = await payments.create({
        kind: 'payment',
        customerId: customer.id,
        amount: 100_000,
        currency: 'CAD',
      });
      await payment.recordPayment({
        ledgerId: '',
        cashAccountId: cash.id,
        receivablesAccountId: receivables.id,
      });
      await allocations.allocatePayment({
        paymentId: payment.id,
        allocations: [
          {
            id: crypto.randomUUID(),
            invoiceId: issuedSource.id,
            amount: 100_000,
          },
        ],
      });

      setting.defaultLineAmountType = 'exclusive';
      await setting.save();
      const credit = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: issuedSource.id,
        customerId: customer.id,
        invoiceNumber: 'REFUND-CREDIT',
        currency: 'CAD',
      });
      await lines.create({
        invoiceId: credit.id,
        creditedLineId: sourceLine.id,
        description: 'Partial refund credit',
        quantity: 1,
        unitPrice: 0,
        creditCalculationBasis: {
          kind: 'net_amount',
          netMinor: 30_000,
          sourceQuantity: '1',
          sourceUnitPrice: 122_568,
          sourceDiscountType: 'none',
          sourceDiscountRate: '0',
          sourceDiscountMinor: 0,
        },
      });
      const issuedCredit = await invoices.get(
        { id: credit.id },
        { cache: false },
      );
      if (!issuedCredit) throw new Error('Expected refund credit');
      issuedCredit.status = InvoiceStatus.SENT;
      await issuedCredit.save();
      expect(issuedCredit.totalAmount).toBe(30_000);

      const refund = await payments.create({
        kind: 'refund',
        customerId: customer.id,
        amount: 7_432,
        currency: 'CAD',
      });
      await refund.recordRefund({
        ledgerId: '',
        cashAccountId: cash.id,
        receivablesAccountId: receivables.id,
      });
      const refundAllocationId = crypto.randomUUID();
      await allocations.allocatePayment({
        paymentId: refund.id,
        allocations: [
          {
            id: refundAllocationId,
            invoiceId: issuedCredit.id,
            amount: 7_432,
          },
        ],
      });
      const refunded = await invoices.get(
        { id: issuedCredit.id },
        { cache: false },
      );
      expect(refunded?.amountPaid).toBe(7_432);
      if (!refunded) throw new Error('Expected refunded credit');
      expect(() => refunded.cancel()).toThrow('refunded/paid amount 7432');

      const extraRefund = await payments.create({
        kind: 'refund',
        customerId: customer.id,
        amount: 1,
        currency: 'CAD',
      });
      await extraRefund.recordRefund({
        ledgerId: '',
        cashAccountId: cash.id,
        receivablesAccountId: receivables.id,
      });
      await expect(
        allocations.allocatePayment({
          paymentId: extraRefund.id,
          allocations: [
            {
              id: crypto.randomUUID(),
              invoiceId: issuedCredit.id,
              amount: 1,
            },
          ],
        }),
      ).rejects.toThrow('available unapplied credit (0)');

      await allocations.removeAllocation(refundAllocationId);
      const reopened = await invoices.get(
        { id: issuedCredit.id },
        { cache: false },
      );
      expect(reopened?.amountPaid).toBe(0);
      if (!reopened) throw new Error('Expected reopened credit');
      reopened.cancel();
      await reopened.save();
      const refreshedSource = await invoices.get(
        { id: issuedSource.id },
        { cache: false },
      );
      expect(refreshedSource?.creditedAmount).toBe(0);
    });
  });
});
