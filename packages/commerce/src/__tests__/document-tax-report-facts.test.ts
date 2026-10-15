import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import '../collections/InvoiceLineItemCollection.js';
import '../collections/PaymentAllocationCollection.js';
import '../collections/TaxSettingsCollection.js';
import { TaxSummaryReportCollection } from '../collections/TaxSummaryReportCollection.js';
import { DOCUMENT_MONEY_WRITE } from '../document-money-internal.js';
import { PurchaseOrder, SupplierQuote } from '../models/Contract.js';
import { ContractStatus, ContractType } from '../types/index.js';
import {
  seedInvoiceTaxReportCredit,
  seedInvoiceTaxReportFacts,
} from './helpers/invoice-tax-report-facts.js';
import { seedReviewedPurchaseContract } from './helpers/purchase-contract-tax-report-facts.js';

describe('DocumentTax invoice report facts (#3940)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('reads exact persisted A/B snapshots from issued invoice rows with tenant joins', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    const taxes = await DocumentTaxCollection.create({ db });
    const facts = await taxes.listReportFacts({
      tenantId: fixture.tenantId,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.999Z'),
      currency: 'CAD',
    });

    expect(facts).toHaveLength(6);
    expect(facts.map((fact) => fact.documentId)).not.toContain(
      fixture.foreignInvoiceId,
    );
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: fixture.invoiceAId,
          documentType: 'invoice',
          documentNumber: 'REPORT-A',
          partyId: fixture.partyAId,
          documentKind: 'invoice',
          status: 'sent',
          taxCodeId: 'gst',
          taxComponentId: 'gst',
          taxableMinor: 81_000,
          taxMinor: 4_050,
        }),
        expect.objectContaining({
          documentId: fixture.invoiceAId,
          taxCodeId: 'gst-pst',
          taxComponentId: 'gst',
          taxableMinor: 33_498,
          taxMinor: 1_675,
        }),
        expect.objectContaining({
          documentId: fixture.invoiceAId,
          taxCodeId: 'gst-pst',
          taxComponentId: 'pst',
          taxableMinor: 33_498,
          taxMinor: 2_345,
        }),
        expect.objectContaining({
          documentId: fixture.invoiceBId,
          documentNumber: 'REPORT-B',
          partyId: fixture.partyBId,
          status: 'written_off',
          taxCodeId: 'gst',
          taxableMinor: 77_143,
          taxMinor: 3_857,
        }),
        expect.objectContaining({
          documentId: fixture.invoiceBId,
          taxCodeId: 'gst-pst',
          taxComponentId: 'gst',
          taxableMinor: 29_908,
          taxMinor: 1_496,
        }),
        expect.objectContaining({
          documentId: fixture.invoiceBId,
          taxCodeId: 'gst-pst',
          taxComponentId: 'pst',
          taxableMinor: 29_908,
          taxMinor: 2_094,
        }),
      ]),
    );
  });

  it('returns a positive credit-note snapshot with its stored credit kind', async () => {
    const fixture = await withTenant({ tenantId: 'tenant-a' }, () =>
      seedInvoiceTaxReportFacts(db),
    );
    const creditId = await withTenant({ tenantId: fixture.tenantId }, () =>
      seedInvoiceTaxReportCredit(db, fixture),
    );
    const facts = await (
      await DocumentTaxCollection.create({ db })
    ).listReportFacts({
      tenantId: fixture.tenantId,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.999Z'),
      currency: 'CAD',
    });

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: creditId,
          documentType: 'credit_note',
          documentKind: 'credit_note',
          documentNumber: 'CN-REPORT-A',
          partyId: fixture.partyAId,
          taxableMinor: 10_000,
          taxMinor: 500,
        }),
      ]),
    );
  });

  it('returns nullable stored kinds as unassigned rather than inferring out-of-scope', async () => {
    const taxes = await DocumentTaxCollection.create({ db });
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const fixture = await seedInvoiceTaxReportFacts(db);
      await taxes.replaceDerivedForDocument(DOCUMENT_MONEY_WRITE, {
        tenantId: fixture.tenantId,
        documentType: 'invoice',
        documentId: fixture.invoiceAId,
        rows: [
          {
            tenantId: fixture.tenantId,
            documentType: 'invoice',
            documentId: fixture.invoiceAId,
            currency: 'CAD',
            taxCodeId: null,
            taxCodeCode: null,
            kind: null,
            taxComponentId: null,
            taxComponentName: null,
            percent: null,
            liabilityAccountId: null,
            taxableMinor: 1,
            taxMinor: 0,
            recoverableMinor: 0,
          },
        ],
      });
      const facts = await taxes.listReportFacts({
        tenantId: fixture.tenantId,
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-30T23:59:59.999Z'),
      });
      expect(facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentId: fixture.invoiceAId,
            taxCodeId: null,
            taxCodeKind: null,
            taxableMinor: 1,
          }),
        ]),
      );
    });
  });

  it('reads frozen purchase-contract snapshots through the descendant classifier, including declined contracts', async () => {
    const tenantId = 'purchase-report-tenant';
    const fixture = await withTenant({ tenantId }, () =>
      seedReviewedPurchaseContract(db, tenantId, {
        reference: 'PO-DECLINED',
        status: ContractStatus.DECLINED,
      }),
    );
    const cancelled = await withTenant({ tenantId }, () =>
      seedReviewedPurchaseContract(db, tenantId, {
        reference: 'PO-CANCELLED',
        status: ContractStatus.CANCELLED,
      }),
    );
    const facts = await (
      await DocumentTaxCollection.create({ db })
    ).listReportFacts({
      tenantId,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.999Z'),
      currency: 'CAD',
    });

    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentType: 'contract',
          documentKind: 'contract',
          documentId: fixture.contractId,
          documentNumber: 'PO-DECLINED',
          partyId: fixture.vendorId,
          direction: 'purchase',
          status: ContractStatus.DECLINED,
          taxComponentId: fixture.gstId,
          taxableMinor: 10_000,
          taxMinor: 500,
          recoverableMinor: 500,
          commitmentId: fixture.contractId,
          commitmentLineId: null,
        }),
        expect.objectContaining({
          documentId: fixture.contractId,
          taxComponentId: fixture.pstId,
          taxableMinor: 10_000,
          taxMinor: 700,
          recoverableMinor: 0,
        }),
      ]),
    );
    expect(facts.map((fact) => fact.documentId)).not.toContain(
      cancelled.contractId,
    );
  });

  it('retains supplier quote snapshots without recognizing purchase tax until a separate order exists', async () => {
    const tenantId = 'supplier-quote-report';
    const quote = await withTenant({ tenantId }, () =>
      seedReviewedPurchaseContract(db, tenantId, {
        reference: 'SQ-RECEIVED',
        metaType: '@happyvertical/smrt-commerce:SupplierQuote',
      }),
    );
    const options = {
      tenantId,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.999Z'),
    };
    const taxes = await DocumentTaxCollection.create({ db });
    await withTenant({ tenantId }, async () => {
      expect(
        await taxes.findByDocument(tenantId, 'contract', quote.contractId),
      ).toHaveLength(2);
      const contracts = await ContractCollection.create({ db });
      expect(await contracts.listSnapshotReportContracts(options)).toEqual([]);
    });
    expect(await taxes.listReportFacts(options)).toEqual([]);
    const order = await withTenant({ tenantId }, () =>
      seedReviewedPurchaseContract(db, tenantId, { reference: 'PO-AWARDED' }),
    );
    expect(
      (await taxes.listReportFacts(options)).map((fact) => fact.documentId),
    ).toEqual([order.contractId, order.contractId]);
  });

  it('classifies persisted purchase report eligibility by subtype despite mutable contractType', async () => {
    const tenantId = 'supplier-quote-scalar-type';
    await withTenant({ tenantId }, async () => {
      const order = await seedReviewedPurchaseContract(db, tenantId, {
        reference: 'PO-SCALAR',
      });
      const quote = await seedReviewedPurchaseContract(db, tenantId, {
        reference: 'SQ-SCALAR',
        metaType: '@happyvertical/smrt-commerce:SupplierQuote',
      });
      const contracts = await ContractCollection.create({ db });
      for (const [fixture, Type, scalar] of [
        [order, PurchaseOrder, ContractType.SUPPLIER_QUOTE],
        [quote, SupplierQuote, ContractType.PURCHASE_ORDER],
      ] as const) {
        const stored = await contracts.get(
          { id: fixture.contractId },
          { cache: false },
        );
        if (!stored) throw new Error('Expected persisted purchase contract');
        expect(stored).toBeInstanceOf(Type);
        stored.contractType = scalar;
        await stored.save();
        const reloaded = await contracts.get(
          { id: fixture.contractId },
          { cache: false },
        );
        expect(reloaded).toBeInstanceOf(Type);
        expect(reloaded?.contractType).toBe(scalar);
      }
      const options = {
        tenantId,
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-30T23:59:59.999Z'),
      };
      expect(
        (await contracts.listSnapshotReportContracts(options)).map(
          (row) => row.id,
        ),
      ).toEqual([order.contractId]);
      expect(
        (
          await (
            await DocumentTaxCollection.create({ db })
          ).listReportFacts(options)
        ).map((fact) => fact.documentId),
      ).toEqual([order.contractId, order.contractId]);
    });
  });

  it('marks a stored purchase contract plus linked expense incomplete instead of double recovering ITC', async () => {
    const tenantId = 'purchase-linked-expense-tenant';
    const fixture = await withTenant({ tenantId }, () =>
      seedReviewedPurchaseContract(db, tenantId, { reference: 'PO-LINKED' }),
    );
    const reports = await TaxSummaryReportCollection.create({ db });
    const refreshed = await reports.refreshTaxSummary({
      tenantId,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.999Z'),
      expenseSource: {
        listReviewedTaxFacts: async () => [
          {
            tenantId,
            expenseId: 'expense-linked-to-purchase',
            incurredOn: '2026-09-12',
            currency: 'CAD',
            commitmentId: fixture.contractId,
            commitmentLineId: 'purchase-line-unavailable',
            financialBreakdown: {
              taxes: [{ code: 'GST', amount: 500, recoverableAmount: 500 }],
            },
          },
        ],
      },
      ledgerSource: { listPostedMovements: async () => [] },
      expenseComponentMappings: [
        {
          tenantId,
          expenseCode: 'GST',
          taxComponentId: fixture.gstId,
          componentName: 'GST',
          liabilityAccountId: null,
        },
      ],
    });
    expect(refreshed.complete).toBe(false);
    const rows = await withTenant({ tenantId }, () =>
      reports.list({ where: { tenantId } }),
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rowKind: 'component',
          taxComponentId: fixture.gstId,
          recoverableMinor: null,
          netTaxMinor: null,
          complete: false,
        }),
        expect.objectContaining({
          rowKind: 'warning',
          warningCode: 'linked-purchase-expense',
          warningSourceType: 'expense',
          warningSourceId: 'expense-linked-to-purchase',
          complete: false,
        }),
      ]),
    );
  });

  it('materializes and drills down a purchase ITC from persisted Contract snapshots', async () => {
    const tenantId = 'purchase-drilldown-tenant';
    const fixture = await withTenant({ tenantId }, () =>
      seedReviewedPurchaseContract(db, tenantId, { reference: 'PO-ITC' }),
    );
    const reports = await TaxSummaryReportCollection.create({ db });
    await reports.refreshTaxSummary({
      tenantId,
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-30T23:59:59.999Z'),
      expenseSource: { listReviewedTaxFacts: async () => [] },
      ledgerSource: { listPostedMovements: async () => [] },
      expenseComponentMappings: [],
    });
    const gst = await withTenant({ tenantId }, async () =>
      (await reports.list({ where: { tenantId } })).find(
        (row) =>
          row.rowKind === 'component' && row.taxComponentId === fixture.gstId,
      ),
    );
    expect(gst).toMatchObject({
      recoverableMinor: 500,
      netTaxMinor: -500,
      documentCount: 1,
      sourceScopes: 'purchase',
    });
    if (!gst?.id) throw new Error('Expected persisted GST report row.');
    await expect(
      reports.drilldownContributors({
        tenantId,
        reportId: gst.id,
        measure: 'recoverable',
      }),
    ).resolves.toMatchObject({
      complete: true,
      pending: [],
      contributors: [
        expect.objectContaining({
          source: 'contract',
          valueMinor: 500,
          fact: expect.objectContaining({
            documentId: fixture.contractId,
            partyId: fixture.vendorId,
          }),
        }),
      ],
    });
    await expect(
      reports.drilldownContributors({
        tenantId,
        reportId: gst.id,
        measure: 'net',
      }),
    ).resolves.toMatchObject({
      complete: true,
      contributors: [
        expect.objectContaining({ source: 'contract', valueMinor: -500 }),
      ],
    });
  });
});
