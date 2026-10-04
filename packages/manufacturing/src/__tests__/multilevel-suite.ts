/**
 * Multi-level bills (#3444), shared by the SQLite and PostgreSQL runs
 * (`multilevel.test.ts`, `multilevel.optional.test.ts`).
 *
 * The fixture is a three-level structure:
 *
 * ```
 * Frame (routing 30 min)
 * ├─ Side panel ×2, 5% waste (routing 10 min)
 * │  ├─ Bracket ×2 (routing 5 min)
 * │  │  └─ Plate 0.5 sheet, 20% waste
 * │  ├─ Tube 2 m, 10% waste
 * │  └─ Bolt ×4
 * ├─ Tube 3 m
 * └─ Paint 0.25 l
 * ```
 *
 * For 10 frames: 21 side panels, 84 bolts, 42 brackets, 25.2 sheets of
 * plate, 30 + 46.2 = 76.2 m of tube and 2.5 l of paint.
 */

import { randomUUID } from 'node:crypto';
import {
  createStockService,
  InventoryLocationCollection,
  type StockService,
} from '@happyvertical/smrt-inventory';
import {
  MaterialCollection,
  SkuCollection,
} from '@happyvertical/smrt-products/collections';
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
  type Assembly,
  AssemblyCollection,
  BillOfMaterialsCollection,
  BomCycleError,
  BomExplosionLimitError,
  BomLineCollection,
  BomService,
  BomStructureCycleError,
  type ExplodedLine,
  MAX_EXPLOSION_DEPTH,
  OperationService,
  type PlannedLine,
  RoutingService,
} from '../index.js';

/** Each test runs in its own tenant: PostgreSQL rows persist between tests. */
const it = (name: string, fn: () => Promise<void>, timeout?: number) =>
  vitestIt(name, () => withTenant({ tenantId: randomUUID() }, fn), timeout);

export function multilevelSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let assemblies: AssemblyCollection;
    let materials: MaterialCollection;
    let skus: SkuCollection;
    let boms: BillOfMaterialsCollection;
    let lines: BomLineCollection;
    let stock: StockService;
    let bomService: BomService;

    beforeEach(async () => {
      enableTenancy();
      db = await create();
      [assemblies, materials, skus, boms, lines] = await Promise.all([
        AssemblyCollection.create({ db }),
        MaterialCollection.create({ db }),
        SkuCollection.create({ db }),
        BillOfMaterialsCollection.create({ db }),
        BomLineCollection.create({ db }),
      ]);
      stock = await createStockService({ db });
      bomService = await BomService.create({ stockService: stock });
    });

    afterEach(async () => {
      disableTenancy();
      await cleanup();
    });

    const unique = (label: string) =>
      `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}`;

    async function assembly(name: string) {
      const row = (await assemblies.create({
        name,
        slug: unique(name),
      })) as Assembly;
      const sku = await skus.create({ productId: row.id!, code: unique(name) });
      return { id: row.id!, skuId: sku.id!, name };
    }

    async function material(name: string, uom: string) {
      const row = await materials.create({ name, slug: unique(name), uom });
      const sku = await skus.create({ productId: row.id!, code: unique(name) });
      return { id: row.id!, skuId: sku.id!, name };
    }

    async function bill(
      productId: string,
      components: [string, number, string, number?][],
      status: 'active' | 'draft' = 'active',
    ) {
      // Lines first on a draft bill, then activate: the order an editor uses.
      const bom = await boms.create({ productId, version: 1, status: 'draft' });
      for (const [
        componentSkuId,
        qtyPerUnit,
        uom,
        wastePercent = 0,
      ] of components)
        await lines.create({
          bomId: bom.id!,
          componentSkuId,
          qtyPerUnit,
          uom,
          wastePercent,
        });
      if (status === 'active') {
        bom.status = 'active';
        await bom.save();
      }
      return bom.id!;
    }

    async function frameFixture() {
      const plate = await material('Plate', 'sheet');
      const tube = await material('Tube', 'm');
      const bolt = await material('Bolt', 'each');
      const paint = await material('Paint', 'l');
      const bracket = await assembly('Bracket');
      const panel = await assembly('Side panel');
      const frame = await assembly('Frame');
      const bracketBom = await bill(bracket.id, [
        [plate.skuId, 0.5, 'sheet', 20],
      ]);
      const panelBom = await bill(panel.id, [
        [bracket.skuId, 2, 'each'],
        [tube.skuId, 2, 'm', 10],
        [bolt.skuId, 4, 'each'],
      ]);
      const frameBom = await bill(frame.id, [
        [panel.skuId, 2, 'each', 5],
        [tube.skuId, 3, 'm'],
        [paint.skuId, 0.25, 'l'],
      ]);
      return {
        plate,
        tube,
        bolt,
        paint,
        bracket,
        panel,
        frame,
        bracketBom,
        panelBom,
        frameBom,
      };
    }

    async function warehouse() {
      const locations = await InventoryLocationCollection.create({ db });
      const location = await locations.create({
        code: unique('WH'),
        kind: 'factory',
      });
      return location.id!;
    }

    function totalsBySku(list: { componentSkuId: string; totalQty: number }[]) {
      return Object.fromEntries(
        list.map((entry) => [entry.componentSkuId, entry.totalQty]),
      );
    }

    function lineFor<T extends ExplodedLine>(
      all: T[],
      skuId: string,
      level?: number,
    ): T {
      const found = all.filter(
        (line) =>
          line.componentSkuId === skuId &&
          (level === undefined || line.level === level),
      );
      expect(found).toHaveLength(1);
      return found[0] as T;
    }

    describe('explode', () => {
      it('walks three levels, compounding waste down them', async () => {
        const f = await frameFixture();
        const result = await bomService.explode(f.frameBom, 10, {
          levels: 'all',
        });

        const totals = totalsBySku(result.totals);
        expect(Object.keys(totals).sort()).toEqual(
          [f.plate.skuId, f.tube.skuId, f.bolt.skuId, f.paint.skuId].sort(),
        );
        expect(totals[f.plate.skuId]).toBeCloseTo(25.2, 9);
        expect(totals[f.tube.skuId]).toBeCloseTo(76.2, 9);
        expect(totals[f.bolt.skuId]).toBeCloseTo(84, 9);
        expect(totals[f.paint.skuId]).toBeCloseTo(2.5, 9);
        expect(
          result.totals.find((t) => t.componentSkuId === f.plate.skuId)?.uom,
        ).toBe('sheet');

        const panel = lineFor(result.lines, f.panel.skuId);
        expect(panel).toMatchObject({
          level: 1,
          kind: 'assembly',
          name: 'Side panel',
          buildable: true,
          expanded: true,
          subBomId: f.panelBom,
        });
        expect(panel.totalQty).toBeCloseTo(21, 9);
        const bracket = lineFor(result.lines, f.bracket.skuId);
        expect(bracket.level).toBe(2);
        expect(bracket.totalQty).toBeCloseTo(42, 9);
        expect(bracket.path.map((entry) => entry.name)).toEqual([
          'Frame',
          'Side panel',
        ]);
        const plate = lineFor(result.lines, f.plate.skuId);
        expect(plate).toMatchObject({
          level: 3,
          kind: 'material',
          uom: 'sheet',
        });
        expect(plate.path.map((entry) => entry.bomId)).toEqual([
          f.frameBom,
          f.panelBom,
          f.bracketBom,
        ]);
        // Units stay per line: the tube appears at two levels in metres.
        expect(lineFor(result.lines, f.tube.skuId, 1).totalQty).toBeCloseTo(
          30,
          9,
        );
        expect(lineFor(result.lines, f.tube.skuId, 2).totalQty).toBeCloseTo(
          46.2,
          9,
        );

        // Depth first: every line's parent bill was opened by the line just
        // above its first sibling.
        for (const [index, line] of result.lines.entries()) {
          if (line.level === 1) continue;
          const opener = result.lines
            .slice(0, index)
            .reverse()
            .find((candidate) => candidate.level === line.level - 1);
          expect(opener?.subBomId).toBe(line.bomId);
          expect(opener?.expanded).toBe(true);
        }
      });

      it('walks two levels when asked for two', async () => {
        const f = await frameFixture();
        const result = await bomService.explode(f.frameBom, 10, { levels: 2 });
        const totals = totalsBySku(result.totals);
        expect(totals[f.bracket.skuId]).toBeCloseTo(42, 9);
        expect(totals[f.plate.skuId]).toBeUndefined();
        expect(totals[f.tube.skuId]).toBeCloseTo(76.2, 9);
        expect(lineFor(result.lines, f.bracket.skuId)).toMatchObject({
          buildable: true,
          expanded: false,
        });
        expect(Math.max(...result.lines.map((line) => line.level))).toBe(2);
        expect(
          await bomService.explodeRequirements(f.frameBom, 10, { levels: 2 }),
        ).toEqual(result.totals);
      });

      it('keeps the single-level default and matches it at levels: 1', async () => {
        const f = await frameFixture();
        const legacy = await bomService.explodeRequirements(f.frameBom, 10);
        const one = await bomService.explode(f.frameBom, 10, { levels: 1 });
        expect(totalsBySku(legacy)).toEqual(totalsBySku(one.totals));
        expect(totalsBySku(legacy)[f.panel.skuId]).toBeCloseTo(21, 9);
        expect(one.lines.every((line) => !line.expanded)).toBe(true);
        expect(
          one.lines.find((l) => l.componentSkuId === f.panel.skuId)?.buildable,
        ).toBe(true);
      });

      it('counts a sub-assembly used in two places once per use', async () => {
        const f = await frameFixture();
        const stand = await assembly('Stand');
        // The bracket directly and inside the side panel (two more).
        const standBom = await bill(stand.id, [
          [f.bracket.skuId, 1, 'each'],
          [f.panel.skuId, 1, 'each'],
        ]);
        const result = await bomService.explode(standBom, 1, { levels: 'all' });
        const plates = result.lines.filter(
          (line) => line.componentSkuId === f.plate.skuId,
        );
        expect(plates.map((line) => line.level).sort()).toEqual([2, 3]);
        expect(totalsBySku(result.totals)[f.plate.skuId]).toBeCloseTo(
          (1 + 2) * 0.6,
          9,
        );
      });

      vitestIt(
        "reads only the top bill's tenant, even without a tenant context",
        async () => {
          const tenantA = randomUUID();
          const f = await withTenant({ tenantId: tenantA }, () =>
            frameFixture(),
          );
          // Another tenant writes a line onto tenant A's side-panel bill.
          const intruder = await withTenant({ tenantId: randomUUID() }, () =>
            material('Intruder', 'each'),
          );
          await withTenant({ tenantId: randomUUID() }, () =>
            lines.create({
              bomId: f.panelBom,
              componentSkuId: intruder.skuId,
              qtyPerUnit: 1,
            }),
          );
          const result = await bomService.explode(f.frameBom, 1, {
            levels: 'all',
          });
          expect(
            result.lines.some((line) => line.componentSkuId === intruder.skuId),
          ).toBe(false);
          expect(result.lines).toHaveLength(7);
        },
      );

      it('stops at an assembly with no active bill', async () => {
        const plate = await material('Plate', 'sheet');
        const gusset = await assembly('Gusset');
        await bill(gusset.id, [[plate.skuId, 1, 'sheet']], 'draft');
        const top = await assembly('Top');
        const topBom = await bill(top.id, [[gusset.skuId, 3, 'each']]);
        const result = await bomService.explode(topBom, 2, { levels: 'all' });
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0]).toMatchObject({
          kind: 'assembly',
          buildable: false,
          expanded: false,
          subBomId: null,
        });
        expect(result.totals).toEqual([
          { componentSkuId: gusset.skuId, totalQty: 6, uom: 'each' },
        ]);
      });

      it('fails with the path when stored data already holds a cycle', async () => {
        const left = await assembly('Left');
        const right = await assembly('Right');
        // Each draft line is valid when written; activating both bills
        // outside the models closes the loop the models would refuse.
        const leftBom = await bill(
          left.id,
          [[right.skuId, 1, 'each']],
          'draft',
        );
        const rightBom = await bill(
          right.id,
          [[left.skuId, 1, 'each']],
          'draft',
        );
        await db.query(
          `UPDATE manufacturing_boms SET status = 'active' WHERE id IN ('${leftBom}', '${rightBom}')`,
        );

        const error = await bomService
          .explode(leftBom, 1, { levels: 'all' })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BomStructureCycleError);
        expect(error).toBeInstanceOf(BomCycleError);
        expect(
          (error as BomStructureCycleError).path.map((p) => p.name),
        ).toEqual(['Left', 'Right', 'Left']);
        expect((error as Error).message).toBe(
          'The bill structure contains a cycle: Left → Right → Left',
        );
        // Started one at a time, so no rejection is left unobserved.
        for (const call of [
          () => bomService.canProduce(leftBom, 1, { levels: 'all' }),
          () => bomService.computeMaterialCost(leftBom, { levels: 2 }),
          () => bomService.computeLabourEstimate(leftBom, { levels: 'all' }),
        ])
          await expect(call()).rejects.toBeInstanceOf(BomStructureCycleError);
        // One level never opens the loop.
        expect(await bomService.explodeRequirements(leftBom, 1)).toHaveLength(
          1,
        );
      });

      it('refuses a levels value outside 1..MAX_EXPLOSION_DEPTH', async () => {
        const f = await frameFixture();
        for (const levels of [0, 1.5, MAX_EXPLOSION_DEPTH + 1])
          await expect(
            bomService.explode(f.frameBom, 1, { levels }),
          ).rejects.toThrow(/levels must be a whole number/);
      });

      it("fails rather than walking past the depth limit with levels: 'all'", async () => {
        const plate = await material('Plate', 'sheet');
        let below = plate.skuId;
        let topBom = '';
        for (let depth = 0; depth <= MAX_EXPLOSION_DEPTH; depth++) {
          const next = await assembly(`Level ${depth}`);
          topBom = await bill(next.id, [[below, 1, 'each']]);
          below = next.skuId;
        }
        await expect(
          bomService.explode(topBom, 1, { levels: 'all' }),
        ).rejects.toMatchObject({
          name: 'BomExplosionLimitError',
          limit: 'depth',
        });
        const capped = await bomService.explode(topBom, 1, {
          levels: MAX_EXPLOSION_DEPTH,
        });
        expect(capped.lines).toHaveLength(MAX_EXPLOSION_DEPTH);
      }, 120_000);

      it('fails rather than returning an unbounded number of lines', async () => {
        // Five levels, each bill naming the next assembly through ten SKUs.
        const plate = await material('Plate', 'sheet');
        let below: string[] = [plate.skuId];
        let topBom = '';
        for (let depth = 0; depth < 5; depth++) {
          const next = await assembly(`Fan ${depth}`);
          topBom = await bill(
            next.id,
            below.map(
              (skuId) => [skuId, 1, 'each'] as [string, number, string],
            ),
          );
          const variants: string[] = [];
          for (let i = 0; i < 10; i++)
            variants.push(
              (await skus.create({ productId: next.id, code: unique('V') }))
                .id!,
            );
          below = variants;
        }
        const error = await bomService
          .explode(topBom, 1, { levels: 'all' })
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(BomExplosionLimitError);
        expect((error as BomExplosionLimitError).limit).toBe('lines');
      });
    });

    describe('planRequirements and canProduce', () => {
      it('opens a short sub-assembly for its shortfall and reports shortages where they occur', async () => {
        const f = await frameFixture();
        const at = await warehouse();
        await stock.receive(f.panel.skuId, at, 5);
        await stock.receive(f.bracket.skuId, at, 32);
        await stock.receive(f.bolt.skuId, at, 50);
        await stock.receive(f.tube.skuId, at, 100);

        const plan = await bomService.planRequirements(f.frameBom, 10, {
          levels: 'all',
        });
        const panel = lineFor<PlannedLine>(plan.lines, f.panel.skuId);
        expect(panel).toMatchObject({ available: 5, expanded: true });
        expect(panel.short).toBeCloseTo(16, 9);
        // What building 16 side panels takes:
        const bracket = lineFor<PlannedLine>(plan.lines, f.bracket.skuId);
        expect(bracket.totalQty).toBeCloseTo(32, 9);
        expect(bracket).toMatchObject({
          available: 32,
          short: 0,
          expanded: false,
        });
        expect(plan.lines.some((l) => l.componentSkuId === f.plate.skuId)).toBe(
          false,
        );
        const bolt = lineFor<PlannedLine>(plan.lines, f.bolt.skuId);
        expect(bolt).toMatchObject({ level: 2, available: 50 });
        expect(bolt.short).toBeCloseTo(14, 9);

        expect(plan.ok).toBe(false);
        const byName = Object.fromEntries(
          plan.shortages.map((s) => [s.componentSkuId, s]),
        );
        expect(Object.keys(byName).sort()).toEqual(
          [f.bolt.skuId, f.paint.skuId].sort(),
        );
        expect(byName[f.bolt.skuId]).toMatchObject({
          level: 2,
          available: 50,
          uom: 'each',
          buildable: false,
        });
        expect(byName[f.bolt.skuId].requested).toBeCloseTo(64, 9);
        expect(byName[f.bolt.skuId].path?.map((p) => p.name)).toEqual([
          'Frame',
          'Side panel',
        ]);
        expect(byName[f.paint.skuId]).toMatchObject({ level: 1, available: 0 });

        const check = await bomService.canProduce(f.frameBom, 10, {
          levels: 'all',
        });
        expect(check.ok).toBe(false);
        expect(check.shortages).toEqual(plan.shortages);

        // One level reports the side panel itself as short, as before.
        const single = await bomService.canProduce(f.frameBom, 10);
        expect(single.shortages.map((s) => s.componentSkuId).sort()).toEqual(
          [f.panel.skuId, f.paint.skuId].sort(),
        );
        expect(single.shortages[0]).not.toHaveProperty('level');
      });

      it('does not count stock twice for a component used at two levels', async () => {
        const f = await frameFixture();
        const at = await warehouse();
        for (const skuId of [f.bracket.skuId, f.bolt.skuId, f.paint.skuId])
          await stock.receive(skuId, at, 1000);
        await stock.receive(f.tube.skuId, at, 50);
        const plan = await bomService.planRequirements(f.frameBom, 10, {
          levels: 'all',
        });
        const tubes = plan.lines.filter(
          (l) => l.componentSkuId === f.tube.skuId,
        );
        expect(tubes).toHaveLength(2);
        const short = tubes.reduce((sum, line) => sum + line.short, 0);
        expect(short).toBeCloseTo(76.2 - 50, 9);
        expect(plan.shortages).toHaveLength(1);
      });

      it('is ok when stock and buildable sub-assemblies cover the run', async () => {
        const f = await frameFixture();
        const at = await warehouse();
        for (const skuId of [
          f.plate.skuId,
          f.tube.skuId,
          f.bolt.skuId,
          f.paint.skuId,
        ])
          await stock.receive(skuId, at, 1000);
        const plan = await bomService.planRequirements(f.frameBom, 10, {
          levels: 'all',
        });
        expect(plan.ok).toBe(true);
        expect(lineFor<PlannedLine>(plan.lines, f.plate.skuId).short).toBe(0);
        expect(
          await bomService.canProduce(f.frameBom, 10, { levels: 'all' }),
        ).toEqual({
          ok: true,
          shortages: [],
        });
      });

      vitestIt(
        "counts only the top bill's tenant's stock, even without a tenant context",
        async () => {
          const tenantA = randomUUID();
          const f = await withTenant({ tenantId: tenantA }, () =>
            frameFixture(),
          );
          const at = await withTenant({ tenantId: tenantA }, () => warehouse());
          await withTenant({ tenantId: tenantA }, () =>
            stock.receive(f.paint.skuId, at, 1),
          );
          // Another tenant stocks the same SKU.
          const elsewhere = randomUUID();
          const theirs = await withTenant({ tenantId: elsewhere }, () =>
            warehouse(),
          );
          await withTenant({ tenantId: elsewhere }, () =>
            stock.receive(f.paint.skuId, theirs, 1000),
          );
          const plan = await bomService.planRequirements(f.frameBom, 10, {
            levels: 'all',
          });
          const paint = lineFor<PlannedLine>(plan.lines, f.paint.skuId);
          expect(paint.available).toBe(1);
          expect(paint.short).toBeCloseTo(1.5, 9);
        },
      );

      it('reports a short sub-assembly past the levels limit as buildable', async () => {
        const f = await frameFixture();
        const plan = await bomService.planRequirements(f.frameBom, 10, {
          levels: 2,
        });
        const bracket = plan.shortages.find(
          (s) => s.componentSkuId === f.bracket.skuId,
        );
        expect(bracket).toMatchObject({ level: 2, buildable: true });
      });

      it('reports an assembly with no active bill as short at its own level', async () => {
        const gusset = await assembly('Gusset');
        const top = await assembly('Top');
        const topBom = await bill(top.id, [[gusset.skuId, 3, 'each']]);
        const plan = await bomService.planRequirements(topBom, 2, {
          levels: 'all',
        });
        expect(plan.shortages).toEqual([
          expect.objectContaining({
            componentSkuId: gusset.skuId,
            requested: 6,
            available: 0,
            level: 1,
            buildable: false,
          }),
        ]);
      });
    });

    describe('cost and labour follow the same walk', () => {
      it('rolls material cost up through sub-assembly bills', async () => {
        const f = await frameFixture();
        const prices: Record<string, number> = {
          [f.tube.skuId]: 4,
          [f.bolt.skuId]: 0.5,
          [f.plate.skuId]: 20,
          [f.paint.skuId]: 10,
        };
        const priced = await BomService.create({
          stockService: stock,
          costResolver: (skuId) => prices[skuId] ?? null,
        });
        const rollup = await priced.computeMaterialCost(f.frameBom, {
          levels: 'all',
        });
        // Side panel: 2.2 m × 4 + 4 × 0.5 + 2 brackets × (0.6 × 20) = 34.8.
        const panel = rollup.lineBreakdown.find(
          (line) => line.componentSkuId === f.panel.skuId,
        );
        expect(panel?.unitCost).toBeCloseTo(34.8, 9);
        expect(panel?.subBomId).toBe(f.panelBom);
        expect(panel?.components).toHaveLength(3);
        expect(rollup.totalCost).toBeCloseTo(2.1 * 34.8 + 3 * 4 + 0.25 * 10, 9);
        expect(rollup.hasMissingCosts).toBe(false);

        // A missing price two levels down marks the line and the rollup.
        delete prices[f.plate.skuId];
        const partial = await priced.computeMaterialCost(f.frameBom, {
          levels: 'all',
        });
        expect(partial.hasMissingCosts).toBe(true);
        expect(
          partial.lineBreakdown.find((l) => l.componentSkuId === f.panel.skuId)
            ?.costUnavailable,
        ).toBe(true);

        // The single-level default prices the side panel through the resolver.
        const single = await priced.computeMaterialCost(f.frameBom);
        expect(
          single.lineBreakdown.find((l) => l.componentSkuId === f.panel.skuId),
        ).toMatchObject({ costUnavailable: true });
        expect(single.lineBreakdown[0]).not.toHaveProperty('components');
      });

      it('adds sub-assembly routings, multiplied by the units needed', async () => {
        const f = await frameFixture();
        const operations = await OperationService.create({ db });
        const routing = await RoutingService.create({ db });
        const weld = await operations.define({
          code: unique('WELD'),
          name: 'Weld',
        });
        await routing.replaceRouting(f.frameBom, [
          { operationId: weld.id!, estimatedMinutes: 30 },
        ]);
        await routing.replaceRouting(f.panelBom, [
          { operationId: weld.id!, estimatedMinutes: 10 },
        ]);
        await routing.replaceRouting(f.bracketBom, [
          { operationId: weld.id!, estimatedMinutes: 5 },
        ]);
        const rated = await BomService.create({
          stockService: stock,
          rateResolver: () => 60,
        });
        const estimate = await rated.computeLabourEstimate(f.frameBom, {
          levels: 'all',
        });
        // 30 + 2.1 × (10 + 2 × 5) minutes per frame.
        expect(estimate.totalMinutes).toBeCloseTo(72, 9);
        expect(estimate.totalCost).toBeCloseTo(72, 9);
        expect(estimate.steps).toHaveLength(1);
        const units = Object.fromEntries(
          (estimate.subAssemblies ?? []).map((s) => [s.name, s.unitsPerUnit]),
        );
        expect(units['Side panel']).toBeCloseTo(2.1, 9);
        expect(units.Bracket).toBeCloseTo(4.2, 9);

        const single = await rated.computeLabourEstimate(f.frameBom);
        expect(single.totalMinutes).toBe(30);
        expect(single).not.toHaveProperty('subAssemblies');
      });
    });
  });
}
