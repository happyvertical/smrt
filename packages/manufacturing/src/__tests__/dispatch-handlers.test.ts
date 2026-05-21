/**
 * dispatch-handlers — opt-in DispatchBus subscribers.
 *
 * Verifies that installManufacturingDispatchHandlers wires up
 * `production_order:posted` (and optionally `production_order:completed`)
 * so a single bus emit translates into stock movements via the
 * ProductionService. Also covers the per-handler toggles and the
 * dispose() teardown.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDispatchBus, type DispatchBus } from '@happyvertical/smrt-core';
import {
  createStockService,
  InventoryLocationCollection,
  StockLevelCollection,
  StockMovementCollection,
  type StockService,
} from '@happyvertical/smrt-inventory';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BillOfMaterialsCollection,
  BomLineCollection,
} from '../collections/index.js';
import { installManufacturingDispatchHandlers } from '../services/dispatch-handlers.js';

describe('installManufacturingDispatchHandlers', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let bus: DispatchBus;
  let boms: BillOfMaterialsCollection;
  let lines: BomLineCollection;
  let locations: InventoryLocationCollection;
  let levels: StockLevelCollection;
  let movements: StockMovementCollection;
  let stockService: StockService;
  let factoryId: string;
  let fabricSkuId: string;
  let finishedSkuId: string;
  let parentProductId: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-manufacturing-disp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };
    bus = await createDispatchBus({ db });

    boms = await BillOfMaterialsCollection.create({ db });
    lines = await BomLineCollection.create({ db });
    locations = await InventoryLocationCollection.create({ db });
    levels = await StockLevelCollection.create({ db });
    movements = await StockMovementCollection.create({ db });
    stockService = await createStockService({ db });

    parentProductId = 'product-x';

    // Manufacturing operates on skuIds as opaque strings.
    fabricSkuId = randomUUID();
    finishedSkuId = randomUUID();

    const fac = await locations.create({
      code: 'D-FAC',
      kind: 'factory',
    });
    await fac.save();
    factoryId = fac.id!;

    const bom = await boms.create({
      productId: parentProductId,
      version: 1,
      status: 'active',
    });
    await bom.save();
    const line = await lines.create({
      bomId: bom.id!,
      componentSkuId: fabricSkuId,
      qtyPerUnit: 2,
      uom: 'yards',
      wastePercent: 0,
    });
    await line.save();

    // Pre-stock the factory so the consume call has materials to draw on.
    await stockService.receive(fabricSkuId, factoryId, 500);
  });

  afterEach(async () => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  });

  it('consumes materials on production_order:posted', async () => {
    const handlers = await installManufacturingDispatchHandlers({
      dispatchBus: bus,
      stockService,
    });

    await bus.emit(
      'production_order:posted',
      {
        productionOrderId: 'PO-A',
        productId: parentProductId,
        locationId: factoryId,
        qty: 50,
      },
      { source: 'commerce' },
    );

    await waitFor(async () => {
      const level = await levels.getLevel(fabricSkuId, factoryId, 'available');
      return level !== null && Number(level.qty) === 400;
    });

    const level = await levels.getLevel(fabricSkuId, factoryId, 'available');
    expect(Number(level?.qty)).toBe(400); // 500 - 100 yards

    const byOrder = await movements.findBySource('ProductionOrder', 'PO-A');
    expect(byOrder).toHaveLength(1);
    expect(byOrder[0].reasonCode).toBe('production_consume');
    expect(byOrder[0].note).toContain('commerce');

    handlers.dispose();

    // After dispose, further emits should not produce additional movements.
    await bus.emit('production_order:posted', {
      productionOrderId: 'PO-B',
      productId: parentProductId,
      locationId: factoryId,
      qty: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterDispose = await movements.findBySource(
      'ProductionOrder',
      'PO-B',
    );
    expect(afterDispose).toEqual([]);
  });

  it('also produces finished goods when producedOnPosted is enabled', async () => {
    await installManufacturingDispatchHandlers({
      dispatchBus: bus,
      stockService,
      producedOnPosted: true,
    });

    await bus.emit('production_order:posted', {
      productionOrderId: 'PO-C',
      productId: parentProductId,
      locationId: factoryId,
      qty: 25,
      finishedSkuId,
    });

    await waitFor(async () => {
      const fin = await levels.getLevel(finishedSkuId, factoryId, 'available');
      return fin !== null && Number(fin.qty) === 25;
    });

    const fin = await levels.getLevel(finishedSkuId, factoryId, 'available');
    expect(Number(fin?.qty)).toBe(25);
    const byOrder = await movements.findBySource('ProductionOrder', 'PO-C');
    // 1 consume + 1 produce
    expect(byOrder).toHaveLength(2);
    const reasons = byOrder.map((m) => m.reasonCode).sort();
    expect(reasons).toEqual(['production_consume', 'production_produce']);
  });

  it('produces finished goods on a separate production_order:completed when configured', async () => {
    await installManufacturingDispatchHandlers({
      dispatchBus: bus,
      stockService,
      installProductionPosted: false,
      installProductionCompleted: true,
    });

    await bus.emit('production_order:completed', {
      productionOrderId: 'PO-D',
      finishedSkuId,
      locationId: factoryId,
      qty: 12,
    });

    await waitFor(async () => {
      const fin = await levels.getLevel(finishedSkuId, factoryId, 'available');
      return fin !== null && Number(fin.qty) === 12;
    });

    const fin = await levels.getLevel(finishedSkuId, factoryId, 'available');
    expect(Number(fin?.qty)).toBe(12);
    const byOrder = await movements.findBySource('ProductionOrder', 'PO-D');
    expect(byOrder).toHaveLength(1);
    expect(byOrder[0].reasonCode).toBe('production_produce');
  });

  it('does not subscribe when callers opt every handler out', async () => {
    await installManufacturingDispatchHandlers({
      dispatchBus: bus,
      stockService,
      installProductionPosted: false,
      installProductionCompleted: false,
    });

    await bus.emit('production_order:posted', {
      productionOrderId: 'PO-E',
      productId: parentProductId,
      locationId: factoryId,
      qty: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const all = await movements.findBySource('ProductionOrder', 'PO-E');
    expect(all).toEqual([]);
  });

  it('lets a caller pass a pre-built productionService for sharing across subsystems', async () => {
    // Importing here to avoid pulling the service into the default scope.
    const { ProductionService } = await import(
      '../services/ProductionService.js'
    );
    const sharedProduction = await ProductionService.create({ stockService });
    const handlers = await installManufacturingDispatchHandlers({
      dispatchBus: bus,
      productionService: sharedProduction,
    });
    expect(handlers.productionService).toBe(sharedProduction);
    handlers.dispose();
  });
});

/**
 * Spin until `predicate()` returns true or the timeout elapses. Used to
 * synchronize on fire-and-forget DispatchBus handlers without baking in
 * an arbitrary `sleep` that would slow every successful run.
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `waitFor: predicate did not become true within ${timeoutMs}ms`,
  );
}
