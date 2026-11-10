import { randomUUID } from 'node:crypto';
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
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { TaxSummaryReportCollection } from '../collections/TaxSummaryReportCollection.js';
import {
  seedInvoiceTaxReportCredit,
  seedInvoiceTaxReportFacts,
} from './helpers/invoice-tax-report-facts.js';
import { seedReviewedPurchaseContract } from './helpers/purchase-contract-tax-report-facts.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres(
  'DocumentTax invoice report facts on PostgreSQL (#3940)',
  () => {
    let isolated: IsolatedTestDbResult | undefined;
    let db: DatabaseInterface;

    beforeEach(async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'Contract',
          'ContractLineItem',
          'Customer',
          'DocumentTax',
          'Invoice',
          'InvoiceLineItem',
          'PaymentAllocation',
          'TaxCode',
          'TaxComponent',
          'TaxSettings',
          'TaxSummaryReport',
          'Vendor',
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

    it('returns exact issued A/B snapshots without joining a foreign-tenant invoice', async () => {
      const tenantId = randomUUID();
      const fixture = await withTenant({ tenantId }, () =>
        seedInvoiceTaxReportFacts(db, tenantId, randomUUID()),
      );
      const facts = await (
        await DocumentTaxCollection.create({ db })
      ).listReportFacts({
        tenantId,
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
            taxCodeId: 'gst-pst',
            taxComponentId: 'gst',
            taxableMinor: 29_908,
            taxMinor: 1_496,
          }),
        ]),
      );
    });

    it('returns a PostgreSQL credit-note snapshot with positive stored values', async () => {
      const tenantId = randomUUID();
      const fixture = await withTenant({ tenantId }, () =>
        seedInvoiceTaxReportFacts(db, tenantId, randomUUID()),
      );
      const creditId = await withTenant({ tenantId }, () =>
        seedInvoiceTaxReportCredit(db, fixture),
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
            documentId: creditId,
            documentType: 'credit_note',
            documentKind: 'credit_note',
            taxableMinor: 10_000,
            taxMinor: 500,
          }),
        ]),
      );
    });

    it('reads tenant-scoped frozen purchase Contract snapshots with exact recoverability', async () => {
      const tenantId = randomUUID();
      const fixture = await withTenant({ tenantId }, () =>
        seedReviewedPurchaseContract(db, tenantId, {
          reference: 'PG-PO-REPORT',
        }),
      );
      const foreignTenantId = randomUUID();
      const foreign = await withTenant({ tenantId: foreignTenantId }, () =>
        seedReviewedPurchaseContract(db, foreignTenantId, {
          reference: 'PG-PO-FOREIGN',
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
      expect(facts.map((fact) => fact.documentId)).not.toContain(
        foreign.contractId,
      );
      expect(facts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentType: 'contract',
            documentId: fixture.contractId,
            partyId: fixture.vendorId,
            direction: 'purchase',
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
    });

    it('marks PostgreSQL stored purchase and linked expense facts incomplete', async () => {
      const tenantId = randomUUID();
      const fixture = await withTenant({ tenantId }, () =>
        seedReviewedPurchaseContract(db, tenantId, {
          reference: 'PG-PO-LINKED-EXPENSE',
        }),
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
              expenseId: 'pg-linked-expense',
              incurredOn: '2026-09-01',
              currency: 'CAD',
              commitmentId: fixture.contractId,
              commitmentLineId: 'unavailable-line',
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
            warningSourceId: 'pg-linked-expense',
            complete: false,
          }),
        ]),
      );
    });

    it('materializes and drills down the PostgreSQL purchase ITC from its stored Contract snapshot', async () => {
      const tenantId = randomUUID();
      const fixture = await withTenant({ tenantId }, () =>
        seedReviewedPurchaseContract(db, tenantId, {
          reference: 'PG-PO-ITC',
        }),
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
      expect(gst).toMatchObject({ recoverableMinor: 500, netTaxMinor: -500 });
      if (!gst?.id) throw new Error('Expected persisted PostgreSQL GST row.');
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
            fact: expect.objectContaining({ documentId: fixture.contractId }),
          }),
        ],
      });
    });
  },
);
