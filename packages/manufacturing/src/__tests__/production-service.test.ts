/**
 * ProductionService — consume / produce stock-mutating operations.
 *
 * Covers the happy paths for both methods, error paths around missing
 * arguments / unknown BOMs, source-attribution invariants on the emitted
 * StockMovements, and tenant isolation through withTenant().
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createStockService,
  InsufficientStockError,
  InventoryLocationCollection,
  StockLevelCollection,
  StockMovementCollection,
  type StockService,
} from '@happyvertical/smrt-inventory';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BillOfMaterialsCollection,
  BomLineCollection,
} from '../collections/index.js';
import { NoActiveBomForProductError } from '../index.js';
import { ProductionService } from '../services/ProductionService.js';

describe('ProductionService', () => {
  let dbPath: string;
  let db: { type: 'sqlite'; url: string };
  let boms: BillOfMaterialsCollection;
  let lines: BomLineCollection;
  let locations: InventoryLocationCollection;
  let levels: StockLevelCollection;
  let movements: StockMovementCollection;
  let stockService: StockService;
  let production: ProductionService;
  let factoryId: string;
  let fabricSkuId: string;
  let buttonSkuId: string;
  let finishedSkuId: string;
  let parentProductId: string;
  let activeBomId: string;

  beforeEach(async () => {
    dbPath = join(
      tmpdir(),
      `smrt-manufacturing-prod-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`,
    );
    db = { type: 'sqlite', url: dbPath };

    boms = await BillOfMaterialsCollection.create({ db });
    lines = await BomLineCollection.create({ db });
    locations = await InventoryLocationCollection.create({ db });
    levels = await StockLevelCollection.create({ db });
    movements = await StockMovementCollection.create({ db });
    stockService = await createStockService({ db });
    production = await ProductionService.create({ stockService });

    parentProductId = 'product-finished-good';

    // ProductionService treats skuIds as opaque strings — it queries
    // StockLevel by skuId but never reads the upstream catalog row.
    fabricSkuId = randomUUID();
    buttonSkuId = randomUUID();
    finishedSkuId = randomUUID();

    const factory = await locations.create({
      code: 'FACTORY-1',
      kind: 'factory',
    });
    await factory.save();
    factoryId = factory.id!;

    const bom = await boms.create({
      productId: parentProductId,
      version: 1,
      status: 'active',
      currency: 'USD',
    });
    await bom.save();
    activeBomId = bom.id!;

    const fabricLine = await lines.create({
      bomId: activeBomId,
      componentSkuId: fabricSkuId,
      qtyPerUnit: 2.0,
      uom: 'yards',
      wastePercent: 10, // 10% waste
    });
    await fabricLine.save();

    const buttonLine = await lines.create({
      bomId: activeBomId,
      componentSkuId: buttonSkuId,
      qtyPerUnit: 4,
      uom: 'each',
      wastePercent: 0,
    });
    await buttonLine.save();
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors.
      }
    }
  });

  describe('consumeMaterials', () => {
    it('deducts materials at the active BOM rate with ProductionOrder attribution', async () => {
      await stockService.receive(fabricSkuId, factoryId, 250);
      await stockService.receive(buttonSkuId, factoryId, 500);

      const order = { id: 'po-1', productId: parentProductId };
      const emitted = await production.consumeMaterials(order, {
        locationId: factoryId,
        qty: 100,
      });

      // Two lines: fabric (220 yards consumed) + buttons (400 each).
      expect(emitted).toHaveLength(2);
      const fabricEmit = emitted.find((e) => e.componentSkuId === fabricSkuId)!;
      expect(fabricEmit.qty).toBeCloseTo(220, 5);
      const buttonEmit = emitted.find((e) => e.componentSkuId === buttonSkuId)!;
      expect(buttonEmit.qty).toBe(400);

      const fabricLevel = await levels.getLevel(
        fabricSkuId,
        factoryId,
        'available',
      );
      expect(Number(fabricLevel?.qty)).toBeCloseTo(30, 5); // 250 - 220
      const buttonLevel = await levels.getLevel(
        buttonSkuId,
        factoryId,
        'available',
      );
      expect(Number(buttonLevel?.qty)).toBe(100); // 500 - 400

      // Audit log: both consumption movements attributed to the production order.
      const byOrder = await movements.findBySource('ProductionOrder', 'po-1');
      expect(byOrder).toHaveLength(2);
      for (const movement of byOrder) {
        expect(movement.reasonCode).toBe('production_consume');
        expect(movement.fromState).toBe('available');
        expect(movement.toState).toBeNull();
      }
    });

    it('uses an explicit order.bomId over the active BOM when both exist', async () => {
      // Create a second draft BOM that consumes only fabric.
      const draftBom = await boms.create({
        productId: parentProductId,
        version: 2,
        status: 'draft',
      });
      await draftBom.save();
      const draftLine = await lines.create({
        bomId: draftBom.id!,
        componentSkuId: fabricSkuId,
        qtyPerUnit: 1,
        uom: 'yards',
        wastePercent: 0,
      });
      await draftLine.save();

      await stockService.receive(fabricSkuId, factoryId, 100);
      await stockService.receive(buttonSkuId, factoryId, 100);

      // Pin the order to the draft BOM. Only fabric should be consumed.
      const order = {
        id: 'po-2',
        productId: parentProductId,
        bomId: draftBom.id!,
      };
      const emitted = await production.consumeMaterials(order, {
        locationId: factoryId,
        qty: 10,
      });
      expect(emitted).toHaveLength(1);
      expect(emitted[0].componentSkuId).toBe(fabricSkuId);
      expect(emitted[0].qty).toBe(10);

      // Buttons untouched.
      const buttonLevel = await levels.getLevel(
        buttonSkuId,
        factoryId,
        'available',
      );
      expect(Number(buttonLevel?.qty)).toBe(100);
    });

    it('throws NoActiveBomForProductError when product has no active BOM', async () => {
      const order = { id: 'po-3', productId: 'unknown-product' };
      await expect(
        production.consumeMaterials(order, {
          locationId: factoryId,
          qty: 1,
        }),
      ).rejects.toBeInstanceOf(NoActiveBomForProductError);
    });

    it('rejects missing order.id (source attribution required)', async () => {
      const order = { productId: parentProductId };
      await expect(
        production.consumeMaterials(order, {
          locationId: factoryId,
          qty: 1,
        }),
      ).rejects.toThrow(/order.id is required/);
    });

    it('rejects missing locationId', async () => {
      const order = { id: 'po-4', productId: parentProductId };
      await expect(
        production.consumeMaterials(order, {
          locationId: '',
          qty: 1,
        }),
      ).rejects.toThrow(/locationId is required/);
    });

    it('rejects non-positive qty', async () => {
      const order = { id: 'po-5', productId: parentProductId };
      await expect(
        production.consumeMaterials(order, {
          locationId: factoryId,
          qty: 0,
        }),
      ).rejects.toThrow(/qty must be a positive finite number/);
      await expect(
        production.consumeMaterials(order, {
          locationId: factoryId,
          qty: -5,
        }),
      ).rejects.toThrow(/qty must be a positive finite number/);
    });

    it('propagates InsufficientStockError when a component is short', async () => {
      // Only 100 fabric on hand but 220 needed.
      await stockService.receive(fabricSkuId, factoryId, 100);
      await stockService.receive(buttonSkuId, factoryId, 500);

      const order = { id: 'po-6', productId: parentProductId };
      await expect(
        production.consumeMaterials(order, {
          locationId: factoryId,
          qty: 100,
        }),
      ).rejects.toBeInstanceOf(InsufficientStockError);
    });

    it('respects an explicit reasonCode override', async () => {
      await stockService.receive(fabricSkuId, factoryId, 250);
      await stockService.receive(buttonSkuId, factoryId, 500);
      const order = { id: 'po-7', productId: parentProductId };

      await production.consumeMaterials(order, {
        locationId: factoryId,
        qty: 10,
        reasonCode: 'sample',
      });
      const byOrder = await movements.findBySource('ProductionOrder', 'po-7');
      for (const movement of byOrder) {
        expect(movement.reasonCode).toBe('sample');
      }
    });
  });

  describe('produceFinishedGoods', () => {
    it('receives finished SKU stock into available with ProductionOrder attribution', async () => {
      const order = { id: 'po-10', productId: parentProductId };
      const result = await production.produceFinishedGoods(order, {
        locationId: factoryId,
        qty: 25,
        finishedSkuId,
      });

      expect(result.finishedSkuId).toBe(finishedSkuId);
      expect(result.qty).toBe(25);
      expect(result.locationId).toBe(factoryId);

      const level = await levels.getLevel(
        finishedSkuId,
        factoryId,
        'available',
      );
      expect(Number(level?.qty)).toBe(25);

      const byOrder = await movements.findBySource('ProductionOrder', 'po-10');
      expect(byOrder).toHaveLength(1);
      expect(byOrder[0].reasonCode).toBe('production_produce');
      expect(byOrder[0].toState).toBe('available');
      expect(byOrder[0].fromState).toBeNull();
    });

    it('accumulates across multiple produce calls', async () => {
      const order = { id: 'po-11', productId: parentProductId };
      await production.produceFinishedGoods(order, {
        locationId: factoryId,
        qty: 10,
        finishedSkuId,
      });
      await production.produceFinishedGoods(order, {
        locationId: factoryId,
        qty: 15,
        finishedSkuId,
      });
      const level = await levels.getLevel(
        finishedSkuId,
        factoryId,
        'available',
      );
      expect(Number(level?.qty)).toBe(25);
    });

    it('rejects missing finishedSkuId', async () => {
      const order = { id: 'po-12', productId: parentProductId };
      await expect(
        production.produceFinishedGoods(order, {
          locationId: factoryId,
          qty: 10,
          finishedSkuId: '',
        }),
      ).rejects.toThrow(/finishedSkuId is required/);
    });

    it('rejects missing order.id', async () => {
      const order = { productId: parentProductId };
      await expect(
        production.produceFinishedGoods(order, {
          locationId: factoryId,
          qty: 10,
          finishedSkuId,
        }),
      ).rejects.toThrow(/order.id is required/);
    });

    it('rejects missing locationId', async () => {
      const order = { id: 'po-13', productId: parentProductId };
      await expect(
        production.produceFinishedGoods(order, {
          locationId: '',
          qty: 10,
          finishedSkuId,
        }),
      ).rejects.toThrow(/locationId is required/);
    });

    it('rejects non-positive qty', async () => {
      const order = { id: 'po-14', productId: parentProductId };
      await expect(
        production.produceFinishedGoods(order, {
          locationId: factoryId,
          qty: 0,
          finishedSkuId,
        }),
      ).rejects.toThrow(/qty must be a positive finite number/);
    });

    it('respects an explicit reasonCode override', async () => {
      const order = { id: 'po-15', productId: parentProductId };
      await production.produceFinishedGoods(order, {
        locationId: factoryId,
        qty: 5,
        finishedSkuId,
        reasonCode: 'sample_run',
      });
      const byOrder = await movements.findBySource('ProductionOrder', 'po-15');
      expect(byOrder[0].reasonCode).toBe('sample_run');
    });
  });

  describe('end-to-end consume + produce', () => {
    it('records balanced movements that reconcile against the same production order', async () => {
      await stockService.receive(fabricSkuId, factoryId, 500);
      await stockService.receive(buttonSkuId, factoryId, 1000);

      const order = { id: 'po-20', productId: parentProductId };
      await production.consumeMaterials(order, {
        locationId: factoryId,
        qty: 50,
      });
      await production.produceFinishedGoods(order, {
        locationId: factoryId,
        qty: 50,
        finishedSkuId,
      });

      const byOrder = await movements.findBySource('ProductionOrder', 'po-20');
      // 2 consume + 1 produce
      expect(byOrder).toHaveLength(3);

      const reasons = byOrder.map((m) => m.reasonCode).sort();
      expect(reasons).toEqual([
        'production_consume',
        'production_consume',
        'production_produce',
      ]);

      // Finished goods landed.
      const finishedLevel = await levels.getLevel(
        finishedSkuId,
        factoryId,
        'available',
      );
      expect(Number(finishedLevel?.qty)).toBe(50);

      // Materials reduced.
      const fabricLevel = await levels.getLevel(
        fabricSkuId,
        factoryId,
        'available',
      );
      expect(Number(fabricLevel?.qty)).toBeCloseTo(390, 5); // 500 - 110
    });
  });

  describe('runProduction', () => {
    it('consumes materials and receives finished goods in one transaction', async () => {
      await stockService.receive(fabricSkuId, factoryId, 500);
      await stockService.receive(buttonSkuId, factoryId, 1000);

      const order = { id: 'po-30', productId: parentProductId };
      const result = await production.runProduction(order, {
        consume: { locationId: factoryId, qty: 50 },
        produce: { locationId: factoryId, qty: 50, finishedSkuId },
      });

      expect(result.consumed.map((c) => c.componentSkuId).sort()).toEqual(
        [buttonSkuId, fabricSkuId].sort(),
      );
      expect(result.produced.finishedSkuId).toBe(finishedSkuId);
      expect(result.produced.qty).toBe(50);

      const finishedLevel = await levels.getLevel(
        finishedSkuId,
        factoryId,
        'available',
      );
      expect(Number(finishedLevel?.qty)).toBe(50);
    });

    it('rolls back the produce leg when a consume line throws', async () => {
      // Only 1 unit of fabric in stock — consume needs 50 * 2.2 = 110.
      await stockService.receive(fabricSkuId, factoryId, 1);
      await stockService.receive(buttonSkuId, factoryId, 1000);

      const order = { id: 'po-31', productId: parentProductId };
      await expect(
        production.runProduction(order, {
          consume: { locationId: factoryId, qty: 50 },
          produce: { locationId: factoryId, qty: 50, finishedSkuId },
        }),
      ).rejects.toThrow();

      // Neither the consume nor the produce leg should have committed.
      const finishedLevel = await levels.getLevel(
        finishedSkuId,
        factoryId,
        'available',
      );
      expect(finishedLevel === null || Number(finishedLevel.qty) === 0).toBe(
        true,
      );
      // Materials untouched (the 1 unit is still there; nothing burned).
      const fabricLevel = await levels.getLevel(
        fabricSkuId,
        factoryId,
        'available',
      );
      expect(Number(fabricLevel?.qty)).toBe(1);
      const buttonLevel = await levels.getLevel(
        buttonSkuId,
        factoryId,
        'available',
      );
      expect(Number(buttonLevel?.qty)).toBe(1000);

      // No movements should be present at all.
      const byOrder = await movements.findBySource('ProductionOrder', 'po-31');
      expect(byOrder).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    beforeEach(() => {
      enableTenancy();
    });

    afterEach(() => {
      disableTenancy();
    });

    it('consumes and produces under a tenant scope without leaking to siblings', async () => {
      const tenantA = 'tenant-a';
      const tenantB = 'tenant-b';

      await withTenant({ tenantId: tenantA }, async () => {
        const tBoms = await BillOfMaterialsCollection.create({ db });
        const tLines = await BomLineCollection.create({ db });
        const tLocations = await InventoryLocationCollection.create({ db });
        const tStock = await createStockService({ db });
        const tProd = await ProductionService.create({ stockService: tStock });

        const fabSkuId = randomUUID();
        const fac = await tLocations.create({
          code: 'A-FAC',
          kind: 'factory',
        });
        await fac.save();

        const bom = await tBoms.create({
          productId: 'prod-A',
          version: 1,
          status: 'active',
        });
        await bom.save();
        const line = await tLines.create({
          bomId: bom.id!,
          componentSkuId: fabSkuId,
          qtyPerUnit: 1,
          uom: 'each',
        });
        await line.save();

        await tStock.receive(fabSkuId, fac.id!, 100);
        const order = { id: 'a-po-1', productId: 'prod-A' };
        await tProd.consumeMaterials(order, {
          locationId: fac.id!,
          qty: 10,
        });
        await tProd.produceFinishedGoods(order, {
          locationId: fac.id!,
          qty: 10,
          finishedSkuId: randomUUID(),
        });
      });

      // Tenant B sees none of tenant A's BOMs, lines, or movements.
      await withTenant({ tenantId: tenantB }, async () => {
        const tBoms = await BillOfMaterialsCollection.create({ db });
        const tMovements = await StockMovementCollection.create({ db });
        const allBoms = await tBoms.findByProduct('prod-A');
        expect(allBoms).toEqual([]);
        const all = await tMovements.findBySource('ProductionOrder', 'a-po-1');
        expect(all).toEqual([]);
      });
    });
  });
});
