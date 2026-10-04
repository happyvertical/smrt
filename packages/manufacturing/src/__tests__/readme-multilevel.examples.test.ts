/**
 * README parity: the "Walk sub-assemblies" and "Record a production run"
 * examples, run as written against the frame / side panel structure.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  createStockService,
  InventoryLocationCollection,
} from '@happyvertical/smrt-inventory';
import {
  MaterialCollection,
  SkuCollection,
} from '@happyvertical/smrt-products/collections';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AssemblyCollection,
  BillOfMaterialsCollection,
  BomLineCollection,
  BomService,
  ProductionRunService,
} from '../index.js';

describe('README multi-level examples', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function frameStructure() {
    const assemblies = await AssemblyCollection.create({ db });
    const materials = await MaterialCollection.create({ db });
    const skus = await SkuCollection.create({ db });
    const boms = await BillOfMaterialsCollection.create({ db });
    const lines = await BomLineCollection.create({ db });

    const tube = await materials.create({ name: 'Steel tube', uom: 'm' });
    const tubeSku = await skus.create({ productId: tube.id!, code: 'TB-1' });
    const panel = await assemblies.create({ name: 'Side panel' });
    const panelSku = await skus.create({
      productId: panel.id!,
      code: 'SP-100',
    });
    const panelBom = await boms.create({
      productId: panel.id!,
      version: 1,
      status: 'active',
    });
    await lines.create({
      bomId: panelBom.id!,
      componentSkuId: tubeSku.id!,
      qtyPerUnit: 2,
      uom: 'm',
      wastePercent: 10,
    });
    const frame = await assemblies.create({ name: 'Frame' });
    const frameSku = await skus.create({
      productId: frame.id!,
      code: 'FR-100',
    });
    const frameBom = await boms.create({
      productId: frame.id!,
      version: 1,
      status: 'active',
    });
    await lines.create({
      bomId: frameBom.id!,
      componentSkuId: panelSku.id!,
      qtyPerUnit: 2,
    });

    const stock = await createStockService({ db });
    const locations = await InventoryLocationCollection.create({ db });
    const factory = await locations.create({
      code: 'FACTORY',
      kind: 'factory',
    });
    await stock.receive(panelSku.id!, factory.id!, 5);
    return { frame, frameBom, frameSku, tubeSku, panelSku, factory, stock };
  }

  it('walks sub-assemblies: explode, plan and the multi-level checks', async () => {
    const { frameBom, tubeSku } = await frameStructure();
    const service = await BomService.create({ db });

    const explosion = await service.explode(frameBom.id!, 10, {
      levels: 'all',
    });
    expect(explosion.lines[0]).toMatchObject({
      level: 1,
      name: 'Side panel',
      totalQty: 20,
      expanded: true,
    });
    expect(explosion.lines[1]).toMatchObject({
      level: 2,
      name: 'Steel tube',
      uom: 'm',
    });
    expect(explosion.lines[1].totalQty).toBeCloseTo(44, 9);
    expect(explosion.totals).toHaveLength(1);
    expect(explosion.totals[0]).toMatchObject({
      componentSkuId: tubeSku.id,
      uom: 'm',
    });

    const plan = await service.planRequirements(frameBom.id!, 10, {
      levels: 'all',
    });
    expect(plan.lines[0]).toMatchObject({
      name: 'Side panel',
      totalQty: 20,
      available: 5,
      short: 15,
      expanded: true,
    });
    expect(plan.shortages).toHaveLength(1);
    expect(plan.shortages[0]).toMatchObject({
      componentSkuId: tubeSku.id,
      available: 0,
      level: 2,
    });
    expect(plan.shortages[0].requested).toBeCloseTo(33, 9);

    expect(
      (await service.canProduce(frameBom.id!, 10, { levels: 'all' })).ok,
    ).toBe(false);
    expect(
      (await service.computeMaterialCost(frameBom.id!, { levels: 'all' }))
        .lineBreakdown[0].subBomId,
    ).toBeDefined();
    expect(
      (await service.computeLabourEstimate(frameBom.id!, { levels: 'all' }))
        .subAssemblies,
    ).toHaveLength(1);
  });

  it('records a production run as work is reported', async () => {
    const { frame, frameSku, panelSku, factory, stock } =
      await frameStructure();
    await stock.receive(panelSku.id!, factory.id!, 100);

    const runs = await ProductionRunService.create({ db });
    const run = await runs.createRun({ productId: frame.id!, targetQty: 25 });
    expect((await runs.recordCompletion(run.id!, { qty: 12 })).run.status).toBe(
      'in_progress',
    );
    const last = await runs.recordCompletion(run.id!, {
      qty: 13,
      consume: { locationId: factory.id! },
      produce: { locationId: factory.id!, finishedSkuId: frameSku.id! },
    });
    expect(last.run.status).toBe('done');
    expect(await stock.levels.totalForSku(frameSku.id!, 'available')).toBe(13);
    expect(await stock.levels.totalForSku(panelSku.id!, 'available')).toBe(
      105 - 26,
    );
  });
});
