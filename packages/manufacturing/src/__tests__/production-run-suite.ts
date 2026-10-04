/**
 * Production runs (#3444), shared by the SQLite and PostgreSQL runs
 * (`production-run.test.ts`, `production-run.optional.test.ts`): the
 * lifecycle, concurrent completions, and optional stock movement in the
 * completion's transaction.
 */

import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  createStockService,
  InsufficientStockError,
  InventoryLocationCollection,
  type StockService,
} from '@happyvertical/smrt-inventory';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it as vitestIt,
} from 'vitest';
import {
  BillOfMaterialsCollection,
  BomLineCollection,
  BomNotFoundError,
  InvalidProductionRunInputError,
  NoActiveBomForProductError,
  ProductionRunNotFoundError,
  ProductionRunOverCompletionError,
  ProductionRunService,
  ProductionRunStateError,
} from '../index.js';

/** Each test runs in its own tenant: PostgreSQL rows persist between tests. */
const it = (name: string, fn: () => Promise<void>) =>
  vitestIt(name, () => withTenant({ tenantId: randomUUID() }, fn));

export function productionRunSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let stock: StockService;
    let service: ProductionRunService;
    let boms: BillOfMaterialsCollection;
    let lines: BomLineCollection;

    beforeEach(async () => {
      enableTenancy();
      db = await create();
      stock = await createStockService({ db });
      service = await ProductionRunService.create({ stockService: stock });
      boms = await BillOfMaterialsCollection.create({ db });
      lines = await BomLineCollection.create({ db });
    });

    afterEach(async () => {
      disableTenancy();
      await cleanup();
    });

    /** An active bill of 2 tube and 4 bolts per unit, with plain component ids. */
    async function makeBill() {
      const productId = randomUUID();
      const tube = randomUUID();
      const bolt = randomUUID();
      const bom = await boms.create({ productId, version: 1, status: 'draft' });
      await lines.create({
        bomId: bom.id!,
        componentSkuId: tube,
        qtyPerUnit: 2,
        uom: 'm',
      });
      await lines.create({
        bomId: bom.id!,
        componentSkuId: bolt,
        qtyPerUnit: 4,
        uom: 'each',
      });
      bom.status = 'active';
      await bom.save();
      return { bomId: bom.id!, productId, tube, bolt };
    }

    async function warehouse() {
      const locations = await InventoryLocationCollection.create({ db });
      const location = await locations.create({
        code: `WH-${randomUUID()}`,
        kind: 'factory',
      });
      return location.id!;
    }

    async function errorOf(run: Promise<unknown>): Promise<unknown> {
      try {
        await run;
      } catch (error) {
        return error;
      }
      throw new Error('Expected the call to fail');
    }

    describe('creating a run', () => {
      it('pins the bill given, or the active bill of a product', async () => {
        const { bomId, productId } = await makeBill();
        const byBill = await service.createRun({ bomId, targetQty: 25 });
        expect(byBill).toMatchObject({
          bomId,
          status: 'planned',
          targetQty: 25,
          completedQty: 0,
        });
        const byProduct = await service.createRun({
          productId,
          targetQty: 2.5,
        });
        expect(byProduct.bomId).toBe(bomId);
        expect((await service.get(byProduct.id!))?.targetQty).toBe(2.5);
      });

      it('refuses a missing bill, a product with no active bill and a bad target', async () => {
        const { bomId } = await makeBill();
        expect(
          await errorOf(
            service.createRun({ bomId: randomUUID(), targetQty: 1 }),
          ),
        ).toBeInstanceOf(BomNotFoundError);
        expect(
          await errorOf(
            service.createRun({ productId: randomUUID(), targetQty: 1 }),
          ),
        ).toBeInstanceOf(NoActiveBomForProductError);
        for (const targetQty of [0, -1, Number.NaN])
          expect(
            await errorOf(service.createRun({ bomId, targetQty })),
          ).toBeInstanceOf(InvalidProductionRunInputError);
        expect(
          await errorOf(service.createRun({ targetQty: 1 })),
        ).toBeInstanceOf(InvalidProductionRunInputError);
        expect(await service.runs.list({})).toHaveLength(0);
      });
    });

    describe('lifecycle', () => {
      it('reports completions as they happen until the target is reached', async () => {
        const { bomId } = await makeBill();
        const run = await service.createRun({ bomId, targetQty: 25 });
        const monday = new Date('2026-09-28T15:00:00.000Z');
        const first = await service.recordCompletion(run.id!, {
          qty: 12,
          completedAt: monday,
        });
        expect(first.run).toMatchObject({
          status: 'in_progress',
          completedQty: 12,
        });
        expect(first.run.remainingQty()).toBe(13);
        expect(first.consumed).toEqual([]);
        expect(first.produced).toBeNull();
        const second = await service.recordCompletion(run.id!, { qty: 13 });
        expect(second.run).toMatchObject({ status: 'done', completedQty: 25 });

        const completions = await service.listCompletions(run.id!);
        expect(completions.map((c) => Number(c.qty))).toEqual([12, 13]);
        expect(new Date(completions[0].completedAt).toISOString()).toBe(
          monday.toISOString(),
        );
        expect(
          await errorOf(service.recordCompletion(run.id!, { qty: 1 })),
        ).toBeInstanceOf(ProductionRunStateError);
      });

      it('sums decimal completions to reach a decimal target', async () => {
        const { bomId } = await makeBill();
        const run = await service.createRun({ bomId, targetQty: 0.3 });
        await service.recordCompletion(run.id!, { qty: 0.1 });
        const last = await service.recordCompletion(run.id!, { qty: 0.2 });
        expect(last.run.status).toBe('done');
      });

      it('keeps the target exact at large quantities', async () => {
        const { bomId } = await makeBill();
        const big = 100_000_000_000_000; // exactly representable
        for (const targetQty of [1_000_000_000, big]) {
          const run = await service.createRun({ bomId, targetQty });
          expect(
            await errorOf(
              service.recordCompletion(run.id!, { qty: targetQty + 1 }),
            ),
          ).toBeInstanceOf(ProductionRunOverCompletionError);
          const almost = await service.recordCompletion(run.id!, {
            qty: targetQty - 1,
          });
          expect(almost.run.status).toBe('in_progress');
          expect(
            await errorOf(service.setTarget(run.id!, targetQty - 2)),
          ).toBeInstanceOf(InvalidProductionRunInputError);
          expect((await service.setTarget(run.id!, targetQty)).status).toBe(
            'in_progress',
          );
          const last = await service.recordCompletion(run.id!, { qty: 1 });
          expect(last.run.status).toBe('done');
          expect(last.run.completedQty).toBe(targetQty);
        }
        // A quantity below the precision (a millionth) is not a quantity.
        const tiny = await service.createRun({ bomId, targetQty: 1 });
        expect(
          await errorOf(service.recordCompletion(tiny.id!, { qty: 0.0000001 })),
        ).toBeInstanceOf(InvalidProductionRunInputError);
      });

      it('refuses more than the run has left, changing nothing', async () => {
        const { bomId } = await makeBill();
        const run = await service.createRun({ bomId, targetQty: 5 });
        await service.recordCompletion(run.id!, { qty: 3 });
        const error = await errorOf(
          service.recordCompletion(run.id!, { qty: 3 }),
        );
        expect(error).toBeInstanceOf(ProductionRunOverCompletionError);
        expect((error as ProductionRunOverCompletionError).remaining).toBe(2);
        expect((await service.get(run.id!))?.completedQty).toBe(3);
        expect(await service.listCompletions(run.id!)).toHaveLength(1);
        for (const qty of [0, -2, Number.POSITIVE_INFINITY])
          expect(
            await errorOf(service.recordCompletion(run.id!, { qty })),
          ).toBeInstanceOf(InvalidProductionRunInputError);
        expect(
          await errorOf(
            service.recordCompletion(run.id!, { qty: 1, completedAt: 'nope' }),
          ),
        ).toBeInstanceOf(InvalidProductionRunInputError);
      });

      it('starts, finishes short and cancels only open runs', async () => {
        const { bomId } = await makeBill();
        const run = await service.createRun({ bomId, targetQty: 10 });
        expect((await service.start(run.id!)).status).toBe('in_progress');
        expect(await errorOf(service.start(run.id!))).toBeInstanceOf(
          ProductionRunStateError,
        );
        await service.recordCompletion(run.id!, { qty: 4 });
        const finished = await service.finish(run.id!);
        expect(finished).toMatchObject({ status: 'done', completedQty: 4 });
        expect(await errorOf(service.cancel(run.id!))).toBeInstanceOf(
          ProductionRunStateError,
        );

        const other = await service.createRun({ bomId, targetQty: 10 });
        await service.recordCompletion(other.id!, { qty: 2 });
        const cancelled = await service.cancel(other.id!);
        expect(cancelled.status).toBe('cancelled');
        expect(await service.listCompletions(other.id!)).toHaveLength(1);
        expect(
          await errorOf(service.recordCompletion(other.id!, { qty: 1 })),
        ).toBeInstanceOf(ProductionRunStateError);
        expect(await errorOf(service.finish(randomUUID()))).toBeInstanceOf(
          ProductionRunNotFoundError,
        );
        expect(await errorOf(service.finish('not-an-id'))).toBeInstanceOf(
          ProductionRunNotFoundError,
        );
      });

      it('changes the target, not below what is done; equal finishes the run', async () => {
        const { bomId } = await makeBill();
        const run = await service.createRun({ bomId, targetQty: 10 });
        await service.recordCompletion(run.id!, { qty: 6 });
        expect(await errorOf(service.setTarget(run.id!, 5))).toBeInstanceOf(
          InvalidProductionRunInputError,
        );
        expect((await service.setTarget(run.id!, 20)).targetQty).toBe(20);
        const done = await service.setTarget(run.id!, 6);
        expect(done).toMatchObject({ status: 'done', targetQty: 6 });
      });
    });

    describe('concurrent completions', () => {
      it('counts every report made at once', async () => {
        const { bomId } = await makeBill();
        const run = await service.createRun({ bomId, targetQty: 5 });
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () =>
            service.recordCompletion(run.id!, { qty: 1 }),
          ),
        );
        expect(results.map((r) => r.status)).toEqual(
          Array(5).fill('fulfilled'),
        );
        const stored = await service.get(run.id!);
        expect(stored).toMatchObject({ status: 'done', completedQty: 5 });
        expect(await service.listCompletions(run.id!)).toHaveLength(5);
      });

      it('never goes past the target when reports race', async () => {
        const { bomId } = await makeBill();
        const run = await service.createRun({ bomId, targetQty: 3 });
        const results = await Promise.allSettled(
          Array.from({ length: 5 }, () =>
            service.recordCompletion(run.id!, { qty: 1 }),
          ),
        );
        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        expect(fulfilled).toHaveLength(3);
        for (const result of results)
          if (result.status === 'rejected')
            expect(
              result.reason instanceof ProductionRunStateError ||
                result.reason instanceof ProductionRunOverCompletionError,
            ).toBe(true);
        expect((await service.get(run.id!))?.completedQty).toBe(3);
        expect(await service.listCompletions(run.id!)).toHaveLength(3);
      });
    });

    describe('stock on completion (optional)', () => {
      it('moves no stock unless asked', async () => {
        const { bomId, tube } = await makeBill();
        const at = await warehouse();
        await stock.receive(tube, at, 100);
        const run = await service.createRun({ bomId, targetQty: 5 });
        await service.recordCompletion(run.id!, { qty: 2 });
        expect(await stock.levels.totalForSku(tube, 'available')).toBe(100);
        expect(
          await stock.movements.list({
            where: { sourceType: 'ProductionRunCompletion' },
          }),
        ).toHaveLength(0);
      });

      it('consumes the bill and receives finished goods with the completion', async () => {
        const { bomId, tube, bolt } = await makeBill();
        const finished = randomUUID();
        const at = await warehouse();
        await stock.receive(tube, at, 100);
        await stock.receive(bolt, at, 100);
        const run = await service.createRun({ bomId, targetQty: 5 });
        const result = await service.recordCompletion(run.id!, {
          qty: 3,
          consume: { locationId: at },
          produce: { locationId: at, finishedSkuId: finished },
        });
        expect(
          result.consumed.map((c) => [c.componentSkuId, c.qty]).sort(),
        ).toEqual(
          [
            [tube, 6],
            [bolt, 12],
          ].sort(),
        );
        expect(result.produced).toMatchObject({
          finishedSkuId: finished,
          qty: 3,
        });
        expect(await stock.levels.totalForSku(tube, 'available')).toBe(94);
        expect(await stock.levels.totalForSku(bolt, 'available')).toBe(88);
        expect(await stock.levels.totalForSku(finished, 'available')).toBe(3);
        const movements = await stock.movements.list({
          where: { sourceType: 'ProductionRunCompletion' },
        });
        expect(movements).toHaveLength(3);
        expect(new Set(movements.map((m) => m.sourceId))).toEqual(
          new Set([result.completion.id]),
        );

        // Either leg alone.
        await service.recordCompletion(run.id!, {
          qty: 1,
          consume: { locationId: at },
        });
        expect(await stock.levels.totalForSku(finished, 'available')).toBe(3);
        expect(await stock.levels.totalForSku(tube, 'available')).toBe(92);
        const produceOnly = await service.recordCompletion(run.id!, {
          qty: 1,
          produce: { locationId: at, finishedSkuId: finished },
        });
        expect(produceOnly.consumed).toEqual([]);
        expect(await stock.levels.totalForSku(finished, 'available')).toBe(4);
        expect(await stock.levels.totalForSku(tube, 'available')).toBe(92);
      });

      it('rolls the completion back when stock runs short', async () => {
        const { bomId, tube, bolt } = await makeBill();
        const finished = randomUUID();
        const at = await warehouse();
        await stock.receive(tube, at, 100);
        await stock.receive(bolt, at, 5); // 2 units need 8
        const run = await service.createRun({ bomId, targetQty: 5 });
        const error = await errorOf(
          service.recordCompletion(run.id!, {
            qty: 2,
            consume: { locationId: at },
            produce: { locationId: at, finishedSkuId: finished },
          }),
        );
        expect(error).toBeInstanceOf(InsufficientStockError);
        const stored = await service.get(run.id!);
        expect(stored).toMatchObject({ status: 'planned', completedQty: 0 });
        expect(await service.listCompletions(run.id!)).toHaveLength(0);
        expect(await stock.levels.totalForSku(tube, 'available')).toBe(100);
        expect(await stock.levels.totalForSku(bolt, 'available')).toBe(5);
        expect(await stock.levels.totalForSku(finished, 'available')).toBe(0);
      });
    });

    it('exposes runs and completions read-only on the generated surfaces', async () => {
      for (const type of [
        '@happyvertical/smrt-manufacturing:ProductionRun',
        '@happyvertical/smrt-manufacturing:ProductionRunCompletion',
      ]) {
        const config = ObjectRegistry.getConfig(type);
        expect(config.api).toEqual({ include: ['list', 'get'] });
        expect(config.mcp).toEqual({ include: ['list', 'get'] });
        expect(config.cli).toEqual({ include: ['list', 'get'] });
      }
    });
  });
}
