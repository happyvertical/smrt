import { getTestDatabase } from '@happyvertical/smrt-core';
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
    });
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
});
