import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../collections/ContractCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import '../collections/InvoiceLineItemCollection.js';
import '../collections/PaymentAllocationCollection.js';
import '../collections/TaxSettingsCollection.js';
import { DOCUMENT_MONEY_WRITE } from '../document-money-internal.js';
import { seedInvoiceTaxReportFacts } from './helpers/invoice-tax-report-facts.js';

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
});
