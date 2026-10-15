import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import {
  invoiceRecordStoredTotals,
  loadInvoiceRecordScreenData,
} from '../invoice-record-screen.js';
import { InvoiceStatus } from '../types/index.js';

const TENANT_A = 'invoice-record-a';
const TENANT_B = 'invoice-record-b';

async function activateV2(
  db: DatabaseInterface,
  tenantId: string,
): Promise<string> {
  return withTenant({ tenantId }, async () => {
    const components = await TaxComponentCollection.create({ db });
    const gst = await components.create({ name: 'GST', percent: '5' });
    const codes = await TaxCodeCollection.create({ db });
    const code = await codes.create({
      code: 'gst',
      name: 'GST',
      components: [{ taxComponentId: gst.id, compound: false }],
    });
    const settings = await TaxSettingsCollection.create({ db });
    const current = await settings.getOrCreateForTenant(tenantId);
    current.defaultSalesTaxCodeId = code.id;
    current.defaultLineAmountType = 'exclusive';
    current.taxRoundingScope = 'document';
    const migrationId = await settings.beginMoneyMigration(tenantId);
    await settings.activateMoneyV2(tenantId, migrationId);
    return code.id;
  });
}

describe('invoice record-screen composition (#3936, #3939)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('reads stored totals and related credits in the active source tenant only', async () => {
    const taxCodeId = await activateV2(db, TENANT_A);
    const fixture = await withTenant({ tenantId: TENANT_A }, async () => {
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({ defaultTaxCodeId: taxCodeId });
      const invoices = await InvoiceCollection.create({ db });
      const source = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'INV-RECORD',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      await lines.create({
        invoiceId: source.id,
        description: 'Stored service',
        quantity: 1,
        unitPrice: 10_000,
        taxMode: 'override',
        taxCodeId,
      });
      const issued = await invoices.get({ id: source.id }, { cache: false });
      if (!issued) throw new Error('Expected source invoice');
      issued.status = InvoiceStatus.SENT;
      await issued.save();

      const credit = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: issued.id,
        customerId: customer.id,
        invoiceNumber: 'CN-RECORD',
        currency: 'CAD',
      });
      await lines.create({
        invoiceId: credit.id,
        description: 'Stored return',
        quantity: 1,
        unitPrice: 0,
        creditedLineId: (await lines.findByInvoice(issued.id))[0]?.id,
      });
      return { invoiceId: issued.id, creditId: credit.id };
    });

    const data = await withTenant({ tenantId: TENANT_A }, () =>
      loadInvoiceRecordScreenData({
        db,
        tenantId: TENANT_A,
        invoiceId: fixture.invoiceId,
      }),
    );

    expect(data).toMatchObject({
      invoiceId: fixture.invoiceId,
      kind: 'invoice',
      currency: 'CAD',
      storedTotals: {
        subtotal: 10_000,
        tax: 500,
        total: 10_500,
        lineAmountType: 'exclusive',
      },
      creditNotes: [{ id: fixture.creditId, invoiceNumber: 'CN-RECORD' }],
    });
    expect(data.storedTotals.taxes).toEqual([
      expect.objectContaining({
        name: 'GST',
        percent: '5',
        taxable: 10_000,
        tax: 500,
      }),
    ]);

    await withTenant({ tenantId: TENANT_B }, async () => {
      await expect(
        loadInvoiceRecordScreenData({
          db,
          tenantId: TENANT_A,
          invoiceId: fixture.invoiceId,
        }),
      ).rejects.toThrow('active principal tenant');
    });
  });

  it('maps persisted component rows without recalculating their values', () => {
    const stored = invoiceRecordStoredTotals({
      source: 'stored',
      invoiceId: 'invoice',
      moneySnapshotId: 'snapshot',
      kind: 'invoice',
      status: 'SENT',
      header: {
        currency: 'CAD',
        lineAmountType: 'inclusive',
        taxRoundingScope: 'document',
        subtotalMinor: 10_001,
        discountTotalMinor: 5,
        taxAmountMinor: 477,
        providerTaxAmountMinor: 0,
        totalAmountMinor: 10_478,
      },
      lines: [],
      taxes: [
        {
          tenantId: TENANT_A,
          documentType: 'invoice',
          documentId: 'invoice',
          currency: 'CAD',
          taxCodeId: 'historic-rate',
          taxCodeCode: 'OLD',
          kind: 'taxable',
          taxComponentId: 'gst',
          taxComponentName: 'GST',
          percent: '5',
          liabilityAccountId: null,
          taxableMinor: 10_001,
          taxMinor: 477,
          recoverableMinor: null,
        },
      ],
    });

    expect(stored).toMatchObject({
      subtotal: 10_001,
      discount: 5,
      tax: 477,
      total: 10_478,
      roundingScope: 'document',
      taxes: [{ taxComponentId: 'gst', taxable: 10_001, tax: 477 }],
    });
  });
});
