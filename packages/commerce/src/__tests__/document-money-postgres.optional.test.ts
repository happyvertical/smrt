import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { MoneyValidationError } from '../money.js';
import { ensureTenantTaxCodes } from '../tax/legacy.js';
import { InvoiceStatus } from '../types/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('invoice money aggregate on PostgreSQL (#3933)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Customer',
        'DocumentTax',
        'Invoice',
        'InvoiceLineItem',
        'PaymentAllocation',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
      ],
    });
    db = isolated.baseDb;
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('commits one reconciled aggregate and rolls back an invalid sibling', async () => {
    const tenantId = randomUUID();
    await ensureTenantTaxCodes(db, tenantId);
    await withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({ name: 'GST', percent: '5' });
      const codes = await TaxCodeCollection.create({ db });
      const code = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const setting = await settings.getOrCreateForTenant(tenantId);
      setting.defaultSalesTaxCodeId = code.id;
      await setting.save();
      // A clean tenant starts on money v2 (#4009); no migration needed.
      if ((await settings.getOrCreateForTenant(tenantId)).moneyModel !== 'v2')
        throw new Error('Expected a clean tenant on money v2');
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({ defaultTaxCodeId: code.id });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'PG-V2',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      await lines.create({
        invoiceId: invoice.id,
        description: 'Valid',
        quantity: 1,
        unitPrice: 100,
      });
      await expect(
        lines.create({
          invoiceId: invoice.id,
          description: 'Invalid',
          quantity: 1,
          unitPrice: 100,
          discountType: 'amount',
          discount: 101,
        }),
      ).rejects.toBeInstanceOf(MoneyValidationError);

      expect(await lines.findByInvoice(invoice.id)).toHaveLength(1);
      expect(
        await invoices.get({ id: invoice.id }, { cache: false }),
      ).toMatchObject({ subtotal: 100, taxAmount: 5, totalAmount: 105 });
      expect(
        await (await DocumentTaxCollection.create({ db })).findByDocument(
          tenantId,
          'invoice',
          invoice.id,
        ),
      ).toMatchObject([{ taxableMinor: 100, taxMinor: 5 }]);
    });
  });

  it('serializes concurrent credit capacity and stores credit-note tax facts', async () => {
    const tenantId = randomUUID();
    await ensureTenantTaxCodes(db, tenantId);
    await withTenant({ tenantId }, async () => {
      const gst = await (await TaxComponentCollection.create({ db })).create({
        name: 'GST',
        percent: '5',
      });
      const code = await (await TaxCodeCollection.create({ db })).create({
        code: 'gst-credit',
        name: 'GST credit',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const setting = await settings.getOrCreateForTenant(tenantId);
      setting.defaultSalesTaxCodeId = code.id;
      setting.taxRoundingScope = 'document';
      await setting.save();
      // A clean tenant starts on money v2 (#4009); no migration needed.
      if ((await settings.getOrCreateForTenant(tenantId)).moneyModel !== 'v2')
        throw new Error('Expected a clean tenant on money v2');
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: code.id,
      });
      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const source = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'PG-CREDIT-SOURCE',
        currency: 'CAD',
      });
      const sourceLine = await lines.create({
        invoiceId: source.id,
        description: 'Two units',
        quantity: 2,
        unitPrice: 100,
      });
      const issuedSource = await invoices.get(
        { id: source.id },
        { cache: false },
      );
      if (!issuedSource) throw new Error('Expected source');
      issuedSource.status = InvoiceStatus.SENT;
      await issuedSource.save();
      const credit = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: issuedSource.id,
        customerId: customer.id,
        invoiceNumber: 'PG-CREDIT',
        currency: 'CAD',
      });
      await lines.create({
        invoiceId: credit.id,
        creditedLineId: sourceLine.id,
        description: 'All units',
        quantity: 2,
        unitPrice: 0,
      });
      const second = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: issuedSource.id,
        customerId: customer.id,
        invoiceNumber: 'PG-CREDIT-2',
        currency: 'CAD',
      });
      await lines.create({
        invoiceId: second.id,
        creditedLineId: sourceLine.id,
        description: 'Competing full credit',
        quantity: 2,
        unitPrice: 0,
      });
      const firstIssue = await invoices.get(
        { id: credit.id },
        { cache: false },
      );
      const secondIssue = await invoices.get(
        { id: second.id },
        { cache: false },
      );
      if (!firstIssue || !secondIssue) throw new Error('Expected credit notes');
      firstIssue.status = InvoiceStatus.SENT;
      secondIssue.status = InvoiceStatus.SENT;
      const results = await Promise.allSettled([
        firstIssue.save(),
        secondIssue.save(),
      ]);
      expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(
        1,
      );
      expect(
        await (await DocumentTaxCollection.create({ db })).findByDocument(
          tenantId,
          'credit_note',
          credit.id,
        ),
      ).toMatchObject([{ taxableMinor: 200, taxMinor: 10 }]);
    });
  });

  it('persists a partial percentage-discount credit from frozen facts', async () => {
    const tenantId = randomUUID();
    await ensureTenantTaxCodes(db, tenantId);
    await withTenant({ tenantId }, async () => {
      const gst = await (await TaxComponentCollection.create({ db })).create({
        name: 'GST percentage credit',
        percent: '5',
      });
      const code = await (await TaxCodeCollection.create({ db })).create({
        code: 'gst-percentage-credit',
        name: 'GST percentage credit',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const setting = await settings.getOrCreateForTenant(tenantId);
      setting.defaultSalesTaxCodeId = code.id;
      setting.defaultLineAmountType = 'exclusive';
      setting.taxRoundingScope = 'line';
      await setting.save();
      // A clean tenant starts on money v2 (#4009); no migration needed.
      if ((await settings.getOrCreateForTenant(tenantId)).moneyModel !== 'v2')
        throw new Error('Expected a clean tenant on money v2');
      const customer = await (await CustomerCollection.create({ db })).create({
        defaultTaxCodeId: code.id,
      });
      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const source = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'PG-PERCENT-SOURCE',
        currency: 'CAD',
      });
      const sourceLine = await lines.create({
        invoiceId: source.id,
        description: 'Ten discounted units',
        quantity: 10,
        unitPrice: 8_500,
        discountType: 'percent',
        discountRate: '10',
        taxMode: 'override',
        taxCodeId: code.id,
      });
      const issuedSource = await invoices.get(
        { id: source.id },
        { cache: false },
      );
      if (!issuedSource) throw new Error('Expected percentage source');
      issuedSource.status = InvoiceStatus.SENT;
      await issuedSource.save();

      const changedDefaults = await settings.getOrCreateForTenant(tenantId);
      changedDefaults.defaultLineAmountType = 'inclusive';
      changedDefaults.taxRoundingScope = 'document';
      await changedDefaults.save();

      const credit = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: issuedSource.id,
        customerId: customer.id,
        invoiceNumber: 'PG-PERCENT-CREDIT',
        currency: 'CAD',
      });
      expect(credit).toMatchObject({
        lineAmountType: 'exclusive',
        taxRoundingScope: 'line',
      });
      const creditLine = await lines.create({
        invoiceId: credit.id,
        creditedLineId: sourceLine.id,
        description: 'One returned unit',
        quantity: 1,
        unitPrice: 0,
      });
      const issuedCredit = await invoices.get(
        { id: credit.id },
        { cache: false },
      );
      if (!issuedCredit) throw new Error('Expected percentage credit');
      issuedCredit.status = InvoiceStatus.SENT;
      await issuedCredit.save();

      expect(
        await lines.get({ id: creditLine.id }, { cache: false }),
      ).toMatchObject({
        discount: 850,
        amount: 7_650,
        taxAmount: 383,
      });
      expect(
        await invoices.get({ id: credit.id }, { cache: false }),
      ).toMatchObject({
        discountTotal: 850,
        subtotal: 7_650,
        taxAmount: 383,
        totalAmount: 8_033,
      });

      const amountCredit = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: issuedSource.id,
        customerId: customer.id,
        invoiceNumber: 'PG-PERCENT-AMOUNT-CREDIT',
        currency: 'CAD',
      });
      await lines.create({
        invoiceId: amountCredit.id,
        creditedLineId: sourceLine.id,
        description: 'Frozen net amount credit',
        quantity: 1,
        unitPrice: 0,
        creditCalculationBasis: {
          kind: 'net_amount',
          netMinor: 68_000,
          sourceQuantity: '10',
          sourceUnitPrice: 8_500,
          sourceDiscountType: 'percent',
          sourceDiscountRate: '10',
          sourceDiscountMinor: 8_500,
        },
      });
      const issuedAmountCredit = await invoices.get(
        { id: amountCredit.id },
        { cache: false },
      );
      if (!issuedAmountCredit) throw new Error('Expected amount credit');
      issuedAmountCredit.status = InvoiceStatus.SENT;
      await issuedAmountCredit.save();

      const excess = await invoices.create({
        kind: 'credit_note',
        creditedInvoiceId: issuedSource.id,
        customerId: customer.id,
        invoiceNumber: 'PG-PERCENT-EXCESS-CREDIT',
        currency: 'CAD',
      });
      await expect(
        lines.create({
          invoiceId: excess.id,
          creditedLineId: sourceLine.id,
          description: 'Quantity exceeds remaining net',
          quantity: 1,
          unitPrice: 0,
        }),
      ).rejects.toMatchObject({ code: 'CREDIT_EXCEEDS_LINE' });
    });
  });

  it('reverses persisted epic A and B snapshots exactly', async () => {
    for (const scenario of [
      { mode: 'exclusive', scope: 'line' },
      { mode: 'inclusive', scope: 'document' },
    ] as const) {
      const tenantId = randomUUID();
      await ensureTenantTaxCodes(db, tenantId);
      await withTenant({ tenantId }, async () => {
        const components = await TaxComponentCollection.create({ db });
        const gst = await components.create({ name: 'GST', percent: '5' });
        const pst = await components.create({ name: 'PST', percent: '7' });
        const codes = await TaxCodeCollection.create({ db });
        const gstCode = await codes.create({
          code: `gst-${scenario.mode}`,
          name: 'GST',
          components: [{ taxComponentId: gst.id, compound: false }],
        });
        const gstPstCode = await codes.create({
          code: `gst-pst-${scenario.mode}`,
          name: 'GST + PST',
          components: [
            { taxComponentId: gst.id, compound: false },
            { taxComponentId: pst.id, compound: false },
          ],
        });
        const settings = await TaxSettingsCollection.create({ db });
        const setting = await settings.getOrCreateForTenant(tenantId);
        setting.defaultSalesTaxCodeId = gstCode.id;
        setting.defaultLineAmountType = scenario.mode;
        setting.taxRoundingScope = scenario.scope;
        await setting.save();
        // A clean tenant starts on money v2 (#4009); no migration needed.
        if ((await settings.getOrCreateForTenant(tenantId)).moneyModel !== 'v2')
          throw new Error('Expected a clean tenant on money v2');
        const customer = await (await CustomerCollection.create({ db })).create(
          { defaultTaxCodeId: gstCode.id },
        );
        const invoices = await InvoiceCollection.create({ db });
        const lines = await InvoiceLineItemCollection.create({ db });
        const source = await invoices.create({
          customerId: customer.id,
          invoiceNumber: `PG-EPIC-${scenario.mode}`,
          currency: 'CAD',
        });
        const sourceLines = [];
        for (const specification of [
          {
            description: 'Design',
            quantity: 10,
            unitPrice: 8_500,
            discountType: 'percent' as const,
            discountRate: '10',
            taxCodeId: gstCode.id,
          },
          {
            description: 'Laptop stand',
            quantity: 2,
            unitPrice: 4_999,
            discountType: 'amount' as const,
            discount: 500,
            taxCodeId: gstPstCode.id,
          },
          {
            description: 'Software licence',
            quantity: 12,
            unitPrice: 2_000,
            taxCodeId: gstPstCode.id,
          },
          {
            description: 'Book',
            quantity: 1,
            unitPrice: 4_500,
            taxCodeId: gstCode.id,
          },
        ])
          sourceLines.push(
            await lines.create({
              invoiceId: source.id,
              taxMode: 'override',
              ...specification,
            }),
          );
        const issuedSource = await invoices.get(
          { id: source.id },
          { cache: false },
        );
        if (!issuedSource) throw new Error('Expected epic source');
        issuedSource.status = InvoiceStatus.SENT;
        await issuedSource.save();
        const credit = await invoices.create({
          kind: 'credit_note',
          creditedInvoiceId: issuedSource.id,
          customerId: customer.id,
          invoiceNumber: `PG-CN-${scenario.mode}`,
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
        if (!issuedCredit) throw new Error('Expected epic credit');
        issuedCredit.status = InvoiceStatus.SENT;
        await issuedCredit.save();
        expect(issuedCredit).toMatchObject({
          subtotal: issuedSource.subtotal,
          taxAmount: issuedSource.taxAmount,
          totalAmount: issuedSource.totalAmount,
        });
        const documents = await DocumentTaxCollection.create({ db });
        const project = (
          rows: Awaited<ReturnType<typeof documents.findByDocument>>,
        ) =>
          rows.map((row) => [
            row.taxComponentId,
            row.taxableMinor,
            row.taxMinor,
          ]);
        expect(
          project(
            await documents.findByDocument(
              tenantId,
              'credit_note',
              issuedCredit.id,
            ),
          ),
        ).toEqual(
          project(
            await documents.findByDocument(
              tenantId,
              'invoice',
              issuedSource.id,
            ),
          ),
        );
        if (scenario.mode === 'inclusive') {
          const software = (await lines.findByInvoice(issuedCredit.id)).find(
            (line) => line.description.includes('Software licence'),
          );
          expect(
            software?.taxComponents.map((component) => component.taxMinor),
          ).toEqual([1_072, 1_500]);
        }
      });
    }
  });
});

describePostgres('independent PostgreSQL invoice money writers (#3933)', () => {
  let primaryDb: DatabaseInterface;
  let otherDb: DatabaseInterface;

  beforeEach(async () => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('PostgreSQL tests require DATABASE_URL');
    primaryDb = await getTestDatabase({
      type: 'postgres',
      url,
      classes: [
        'Customer',
        'DocumentTax',
        'Invoice',
        'InvoiceLineItem',
        'PaymentAllocation',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
      ],
    });
    otherDb = await getTestDatabase({
      type: 'postgres',
      url,
      classes: [],
      includeSystemTables: false,
    });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await Promise.all([primaryDb.close?.(), otherDb.close?.()]);
  });

  it('serializes line writers and conserves the document allocation', async () => {
    const tenantId = randomUUID();
    await ensureTenantTaxCodes(primaryDb, tenantId);
    await withTenant({ tenantId }, async () => {
      const gst = await (
        await TaxComponentCollection.create({ db: primaryDb })
      ).create({ name: 'GST', percent: '5' });
      const code = await (
        await TaxCodeCollection.create({ db: primaryDb })
      ).create({
        code: 'gst-concurrent',
        name: 'GST concurrent',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db: primaryDb });
      const setting = await settings.getOrCreateForTenant(tenantId);
      setting.defaultSalesTaxCodeId = code.id;
      setting.taxRoundingScope = 'document';
      await setting.save();
      // A clean tenant starts on money v2 (#4009); no migration needed.
      if ((await settings.getOrCreateForTenant(tenantId)).moneyModel !== 'v2')
        throw new Error('Expected a clean tenant on money v2');
      const customer = await (
        await CustomerCollection.create({ db: primaryDb })
      ).create({ defaultTaxCodeId: code.id });
      const invoices = await InvoiceCollection.create({ db: primaryDb });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'PG-INDEPENDENT-WRITERS',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db: primaryDb });
      await lines.create({
        invoiceId: invoice.id,
        description: 'Existing first',
        unitPrice: 10,
      });
      await lines.create({
        invoiceId: invoice.id,
        description: 'Existing second',
        unitPrice: 10,
      });
      const otherLines = await InvoiceLineItemCollection.create({
        db: otherDb,
      });
      await Promise.all([
        lines.create({
          invoiceId: invoice.id,
          tenantId,
          description: 'Concurrent first',
          unitPrice: 10,
        }),
        withTenant({ tenantId }, () =>
          otherLines.create({
            invoiceId: invoice.id,
            tenantId,
            description: 'Concurrent second',
            unitPrice: 10,
          }),
        ),
      ]);

      expect(await lines.findByInvoice(invoice.id)).toHaveLength(4);
      expect(
        await invoices.get({ id: invoice.id }, { cache: false }),
      ).toMatchObject({ subtotal: 40, taxAmount: 2, totalAmount: 42 });
      expect(
        await (
          await DocumentTaxCollection.create({ db: primaryDb })
        ).findByDocument(tenantId, 'invoice', invoice.id),
      ).toMatchObject([{ taxableMinor: 40, taxMinor: 2 }]);
    });
  });
});
