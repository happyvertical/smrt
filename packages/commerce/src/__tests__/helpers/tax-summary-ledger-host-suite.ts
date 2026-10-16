import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  AccountCollection,
  JournalCollection,
  JournalEntryCollection,
} from '@happyvertical/smrt-ledgers';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { describe, expect, it, vi } from 'vitest';
import { TaxSettingsCollection } from '../../collections/TaxSettingsCollection.js';
import { TaxSummaryReportCollection } from '../../collections/TaxSummaryReportCollection.js';
import { createTaxSummaryMaterializedReportHost } from '../../tax-summary-report-adapter.js';
import { seedInvoiceTaxReportFacts } from './invoice-tax-report-facts.js';

const from = new Date('2026-09-01T00:00:00.000Z');
const to = new Date('2026-09-30T23:59:59.999Z');

async function activateV2(db: DatabaseInterface, tenantId: string) {
  const settings = await TaxSettingsCollection.create({ db });
}

/** Contract shared by the SQLite and PostgreSQL real ledger source lanes. */
export function defineTaxSummaryLedgerHostSuite(
  getDb: () => DatabaseInterface,
) {
  describe('tax summary real ledger host source', () => {
    it('materializes and drills down a posted manual movement from the ledger owner', async () => {
      const db = getDb();
      const tenantId = randomUUID();
      const foreignTenantId = randomUUID();
      const accounts = await AccountCollection.create({ db });
      const journals = await JournalCollection.create({ db });
      const entries = await JournalEntryCollection.create({ db });
      const { gstId, pstId, clearingId } = await withTenant(
        { tenantId },
        async () => {
          const gst = await accounts.create({
            number: '2100',
            name: 'GST payable',
            type: 'liability',
          });
          await gst.save();
          const pst = await accounts.create({
            number: '2110',
            name: 'PST payable',
            type: 'liability',
          });
          await pst.save();
          const clearing = await accounts.create({
            number: '1000',
            name: 'Tax clearing',
            type: 'asset',
          });
          await clearing.save();
          if (!gst.id || !pst.id || !clearing.id)
            throw new Error('expected persisted ledger accounts');
          return { gstId: gst.id, pstId: pst.id, clearingId: clearing.id };
        },
      );
      const fixture = await withTenant({ tenantId }, () =>
        seedInvoiceTaxReportFacts(db, tenantId, foreignTenantId, {
          gst: gstId,
          pst: pstId,
        }),
      );
      const journal = await withTenant({ tenantId }, async () => {
        const journal = await journals.createWithEntries({
          date: from,
          description: 'Manual GST tax remittance',
          sourceModule: 'manual',
          sourceRef: 'tax-summary-fixture',
          entries: [
            { accountId: clearingId, debit: 11_078, currency: 'CAD' },
            { accountId: gstId, credit: 11_078, currency: 'CAD' },
          ],
        });
        await journal.post();
        return journal;
      });
      if (!journal.id) throw new Error('expected a posted journal');

      await withTenant({ tenantId }, () => activateV2(db, tenantId));
      await withTenant({ tenantId: foreignTenantId }, () =>
        activateV2(db, foreignTenantId),
      );
      const reports = await TaxSummaryReportCollection.create({ db });
      await reports.refreshTaxSummary({
        tenantId,
        from,
        to,
        expenseSource: { listReviewedTaxFacts: async () => [] },
        ledgerSource: entries,
        expenseComponentMappings: [],
      });
      const reconciliation = await withTenant({ tenantId }, () =>
        reports.findOne({
          where: {
            tenantId,
            rowKind: 'reconciliation',
            taxComponentId: 'gst',
          },
        }),
      );
      if (!reconciliation?.id)
        throw new Error('expected a GST reconciliation row');
      expect(reconciliation).toMatchObject({
        liabilityAccountId: gstId,
        taxMinor: 11_078,
        ledgerMovementMinor: 11_078,
        differenceMinor: 0,
      });

      const source = vi.fn(async (context: { tenantId: string }) => {
        if (context.tenantId !== tenantId)
          throw new Error('ledger source must be tenant-bound');
        return { ledgerSource: entries };
      });
      const host = createTaxSummaryMaterializedReportHost(db, {
        drilldownSources: source,
      });
      await expect(
        host.drilldown(
          {
            userId: 'ledger-report-reader',
            tenantId,
            permissions: ['taxsummaryreports.read'],
          },
          { id: reconciliation.id, columnId: 'difference_minor' },
        ),
      ).resolves.toMatchObject({
        complete: true,
        contributors: expect.arrayContaining([
          expect.objectContaining({
            source: 'ledger',
            identity: journal.number,
            values: expect.objectContaining({ valueMinor: 11_078 }),
          }),
        ]),
      });
      await expect(
        host.drilldown(
          {
            userId: 'foreign-ledger-report-reader',
            tenantId: foreignTenantId,
            permissions: ['taxsummaryreports.read'],
          },
          { id: reconciliation.id, columnId: 'difference_minor' },
        ),
      ).rejects.toThrow(/unavailable/i);
      expect(source).toHaveBeenCalledTimes(1);
      expect(fixture.tenantId).toBe(tenantId);
    });
  });
}
