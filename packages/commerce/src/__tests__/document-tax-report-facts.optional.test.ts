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
import { seedInvoiceTaxReportFacts } from './helpers/invoice-tax-report-facts.js';

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
          'Customer',
          'DocumentTax',
          'Invoice',
          'InvoiceLineItem',
          'PaymentAllocation',
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
  },
);
