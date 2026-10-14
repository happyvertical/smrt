import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { enableTenancy } from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
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
            tenantId: world.tenantId,
            incurredOn: '2026-09-16',
            financialBreakdown: null,
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
  });
}
