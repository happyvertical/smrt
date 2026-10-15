import { randomUUID } from 'node:crypto';
import {
  aggregateTaxSummary,
  createTaxSummaryMaterializedReportHost,
  TaxSettingsCollection,
  TaxSummaryReportCollection,
} from '@happyvertical/smrt-commerce';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { enableTenancy } from '@happyvertical/smrt-tenancy';
import { describe, expect, it, vi } from 'vitest';
import { createWorld } from './expense-suite.js';

/** Contract shared by the SQLite and PostgreSQL reporting-input lanes. */
export function defineReviewedTaxFactsSuite(getDb: () => DatabaseInterface) {
  describe('reviewed expense tax facts', () => {
    it('keeps unknown supplier facts visible while excluding duplicates and other tenants', async () => {
      enableTenancy();
      const world = await createWorld(getDb());
      const foreign = await createWorld(getDb());

      await world.inTenant(async () => {
        const reviewer = randomUUID();
        const known = await world.expense({ amount: 11_000 });
        known.setFinancialBreakdown({
          currency: 'USD',
          subtotal: 10_000,
          taxes: [{ code: 'gst', amount: 1_000, recoverableAmount: 1_000 }],
          total: 11_000,
        });
        await known.save();
        await known.review({ reviewerProfileId: reviewer });

        const unknown = await world.expense({ incurredOn: '2026-09-16' });
        await unknown.review({ reviewerProfileId: reviewer });

        const duplicate = await world.expense({ incurredOn: '2026-09-17' });
        await duplicate.markDuplicate({
          reviewerProfileId: reviewer,
          duplicateOfId: known.id,
        });

        const later = await world.expense({ incurredOn: '2026-10-01' });
        await later.review({ reviewerProfileId: reviewer });

        const cad = await world.expense({ currency: 'CAD' });
        await cad.review({ reviewerProfileId: reviewer });

        const facts = await world.expenses.listReviewedTaxFacts({
          tenantId: world.tenantId,
          from: '2026-09-01',
          to: '2026-09-30',
          currency: 'USD',
        });
        expect(facts).toEqual([
          expect.objectContaining({
            id: known.id,
            expenseId: known.id,
            tenantId: world.tenantId,
            incurredOn: '2026-09-15',
            financialBreakdown: {
              currency: 'USD',
              subtotal: 10_000,
              taxes: [{ code: 'gst', amount: 1_000, recoverableAmount: 1_000 }],
              total: 11_000,
            },
          }),
          expect.objectContaining({
            id: unknown.id,
            expenseId: unknown.id,
            tenantId: world.tenantId,
            incurredOn: '2026-09-16',
            financialBreakdown: null,
          }),
        ]);

        const summary = aggregateTaxSummary({
          tenantId: world.tenantId,
          from: '2026-09-01',
          to: '2026-09-30',
          facts: [],
          expenses: facts.filter((fact) => fact.expenseId === known.id),
          expenseComponentMappings: [
            {
              tenantId: world.tenantId,
              expenseCode: 'gst',
              taxComponentId: 'gst',
              componentName: 'GST',
              liabilityAccountId: 'gst-payable',
            },
          ],
          ledgerMovements: [],
        });
        expect(summary.componentRows).toEqual([
          expect.objectContaining({
            taxComponentId: 'gst',
            expenseRecoverableMinor: 1_000,
            inputTaxCreditMinor: 1_000,
          }),
        ]);
      });

      await foreign.inTenant(async () => {
        const expense = await foreign.expense();
        await expense.review({ reviewerProfileId: randomUUID() });
      });

      await world.inTenant(async () => {
        const facts = await world.expenses.listReviewedTaxFacts({
          tenantId: world.tenantId,
          from: '2026-09-01',
          to: '2026-09-30',
        });
        expect(facts.every((fact) => fact.tenantId === world.tenantId)).toBe(
          true,
        );
      });
    });

    it('requires a tenant and ordered calendar dates', async () => {
      enableTenancy();
      const world = await createWorld(getDb());
      await expect(
        world.expenses.listReviewedTaxFacts({
          tenantId: world.tenantId,
          from: '2026-09-31',
          to: '2026-10-01',
        }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
      await expect(
        world.expenses.listReviewedTaxFacts({
          tenantId: world.tenantId,
          from: '2026-10-02',
          to: '2026-10-01',
        }),
      ).rejects.toMatchObject({ code: 'EXPENSE_INVALID' });
    });

    it('bridges the owner source through materialization to an authenticated drilldown', async () => {
      enableTenancy();
      const world = await createWorld(getDb());
      const foreign = await createWorld(getDb());
      const mapping = {
        tenantId: world.tenantId,
        expenseCode: 'gst',
        taxComponentId: 'gst',
        componentName: 'GST',
        liabilityAccountId: 'gst-payable',
      };

      await world.inTenant(async () => {
        const expense = await world.expense({ amount: 11_000 });
        expense.setFinancialBreakdown({
          currency: 'USD',
          subtotal: 10_000,
          taxes: [{ code: 'gst', amount: 1_000, recoverableAmount: 1_000 }],
          total: 11_000,
        });
        await expense.save();
        await expense.review({ reviewerProfileId: randomUUID() });
      });

      const settings = await TaxSettingsCollection.create({ db: world.db });
      await world.inTenant(async () => {
        const migrationId = await settings.beginMoneyMigration(world.tenantId);
        await settings.activateMoneyV2(world.tenantId, migrationId);
      });
      await foreign.inTenant(async () => {
        const migrationId = await settings.beginMoneyMigration(
          foreign.tenantId,
        );
        await settings.activateMoneyV2(foreign.tenantId, migrationId);
      });

      const reports = await TaxSummaryReportCollection.create({ db: world.db });
      await reports.refreshTaxSummary({
        tenantId: world.tenantId,
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-30T23:59:59.999Z'),
        expenseSource: world.expenses,
        ledgerSource: { listPostedMovements: async () => [] },
        expenseComponentMappings: [mapping],
      });
      const component = await world.inTenant(async () =>
        reports.findOne({
          where: {
            tenantId: world.tenantId,
            rowKind: 'component',
            taxComponentId: 'gst',
          },
        }),
      );
      if (!component?.id) throw new Error('expected materialized GST row');

      const sources = vi.fn(async (context: { tenantId: string }) => {
        if (context.tenantId !== world.tenantId)
          throw new Error('owner source must be tenant-bound');
        return {
          expenseSource: world.expenses,
          expenseComponentMappings: [mapping],
        };
      });
      const host = createTaxSummaryMaterializedReportHost(world.db, {
        drilldownSources: sources,
      });
      await expect(
        host.drilldown(
          {
            userId: 'expense-report-reader',
            tenantId: world.tenantId,
            permissions: ['taxsummaryreports.read'],
          },
          { id: component.id, columnId: 'recoverable_minor' },
        ),
      ).resolves.toMatchObject({
        complete: true,
        contributors: [
          expect.objectContaining({
            source: 'expense',
            values: expect.objectContaining({ valueMinor: 1_000 }),
          }),
        ],
      });
      await expect(
        host.drilldown(
          {
            userId: 'foreign-report-reader',
            tenantId: foreign.tenantId,
            permissions: ['taxsummaryreports.read'],
          },
          { id: component.id, columnId: 'recoverable_minor' },
        ),
      ).rejects.toThrow(/unavailable/i);
      expect(sources).toHaveBeenCalledTimes(1);
    });
  });
}
