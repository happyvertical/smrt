import { randomUUID } from 'node:crypto';
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
  BomService,
  DuplicateOperationCodeError,
  InvalidOperationInputError,
  OperationNotFoundError,
  OperationRetiredError,
  OperationService,
  RoutingService,
  RoutingStepCollection,
} from '../index.js';

/**
 * Each test runs in its own tenant, so rows left behind on a shared PostgreSQL
 * database cannot collide with the next test's operation codes.
 */
const it = (name: string, fn: () => Promise<void>) =>
  vitestIt(name, () => withTenant({ tenantId: randomUUID() }, fn));

/**
 * Operations, routing and the labour rollup, run against SQLite and
 * (optionally) PostgreSQL. Ids are UUIDs so one suite is valid on both.
 */
export function operationsSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let operations: OperationService;
    let routing: RoutingService;
    let boms: BillOfMaterialsCollection;
    let lines: BomLineCollection;

    beforeEach(async () => {
      enableTenancy();
      db = await create();
      operations = await OperationService.create({ db });
      routing = await RoutingService.create({ db });
      boms = await BillOfMaterialsCollection.create({ db });
      lines = await BomLineCollection.create({ db });
    });
    afterEach(async () => {
      disableTenancy();
      await cleanup();
    });

    async function makeBom(currency = 'USD'): Promise<string> {
      const bom = await boms.create({
        productId: randomUUID(),
        version: 1,
        status: 'active',
        currency,
      });
      await bom.save();
      return bom.id as string;
    }

    describe('operations', () => {
      it('defines an operation active, trimmed, with optional fields empty', async () => {
        const cut = await operations.define({
          code: ' CUT ',
          name: ' Cutting ',
        });
        expect(cut).toMatchObject({
          code: 'CUT',
          name: 'Cutting',
          category: '',
          requiredQualificationId: '',
          isActive: true,
        });
        const qualificationId = randomUUID();
        const weld = await operations.define({
          code: 'WELD',
          name: 'Welding',
          category: 'fabrication',
          requiredQualificationId: qualificationId,
        });
        expect(weld.category).toBe('fabrication');
        expect(weld.requiredQualificationId).toBe(qualificationId);
        expect((await operations.get(weld.id as string)).code).toBe('WELD');
      });

      it('requires a code and a name', async () => {
        await expect(
          operations.define({ code: ' ', name: 'x' }),
        ).rejects.toThrow(InvalidOperationInputError);
        await expect(
          operations.define({ code: 'x', name: '' }),
        ).rejects.toThrow(InvalidOperationInputError);
      });

      it('keeps a code unique within a tenant but reusable across tenants', async () => {
        enableTenancy();
        const a = randomUUID();
        const b = randomUUID();
        await withTenant({ tenantId: a }, async () => {
          await operations.define({ code: 'CUT', name: 'Cutting' });
          await expect(
            operations.define({ code: 'CUT', name: 'Another cut' }),
          ).rejects.toThrow(DuplicateOperationCodeError);
          expect(await operations.list()).toHaveLength(1);
        });
        await withTenant({ tenantId: b }, async () => {
          const other = await operations.define({
            code: 'CUT',
            name: 'Cutting B',
          });
          expect(other.tenantId).toBe(b);
          expect(await operations.list()).toHaveLength(1);
        });
      });

      it('keeps a retired operation holding its code', async () => {
        const cut = await operations.define({ code: 'CUT', name: 'Cutting' });
        await operations.retire(cut.id as string);
        await expect(
          operations.define({ code: 'CUT', name: 'Again' }),
        ).rejects.toThrow(DuplicateOperationCodeError);
      });

      it('renames and updates without changing the code', async () => {
        const op = await operations.define({ code: 'CUT', name: 'Cutting' });
        const renamed = await operations.rename(
          op.id as string,
          ' Plasma cutting ',
        );
        expect(renamed).toMatchObject({ code: 'CUT', name: 'Plasma cutting' });
        await operations.update(op.id as string, {
          category: 'fabrication',
          requiredQualificationId: 'qual-x',
        });
        const stored = await operations.get(op.id as string);
        expect(stored).toMatchObject({
          code: 'CUT',
          name: 'Plasma cutting',
          category: 'fabrication',
          requiredQualificationId: 'qual-x',
        });
        await operations.update(op.id as string, {
          requiredQualificationId: '',
        });
        expect(
          (await operations.get(op.id as string)).requiredQualificationId,
        ).toBe('');
        await expect(operations.rename(op.id as string, ' ')).rejects.toThrow(
          InvalidOperationInputError,
        );
        await expect(operations.rename(randomUUID(), 'x')).rejects.toThrow(
          OperationNotFoundError,
        );
      });

      it('retires and reinstates, leaving pickers but not history', async () => {
        const cut = await operations.define({
          code: 'CUT',
          name: 'Cutting',
          category: 'b',
        });
        const weld = await operations.define({
          code: 'WELD',
          name: 'Welding',
          category: 'a',
        });
        expect((await operations.list()).map((o) => o.code)).toEqual([
          'WELD',
          'CUT',
        ]);

        const retired = await operations.retire(cut.id as string);
        expect(retired.isActive).toBe(false);
        // Idempotent.
        expect((await operations.retire(cut.id as string)).isActive).toBe(
          false,
        );
        expect((await operations.list()).map((o) => o.code)).toEqual(['WELD']);
        expect(
          (await operations.list({ includeRetired: true })).map((o) => o.code),
        ).toEqual(['WELD', 'CUT']);
        expect((await operations.get(cut.id as string)).isActive).toBe(false);

        expect((await operations.reinstate(cut.id as string)).isActive).toBe(
          true,
        );
        expect((await operations.list()).map((o) => o.code)).toEqual([
          'WELD',
          'CUT',
        ]);
        expect(weld.isActive).toBe(true);
      });

      it('never deletes an operation', async () => {
        const cut = await operations.define({ code: 'CUT', name: 'Cutting' });
        await expect(cut.delete()).rejects.toThrow(/retire it instead/);
        expect(await operations.get(cut.id as string)).toBeTruthy();
      });
    });

    describe('routing', () => {
      async function ops() {
        const cut = await operations.define({ code: 'CUT', name: 'Cutting' });
        const weld = await operations.define({ code: 'WELD', name: 'Welding' });
        const paint = await operations.define({
          code: 'PAINT',
          name: 'Painting',
        });
        return {
          cut: cut.id as string,
          weld: weld.id as string,
          paint: paint.id as string,
        };
      }

      it('has no routing until one is set', async () => {
        const bomId = await makeBom();
        expect(await routing.list(bomId)).toEqual([]);
      });

      it('numbers steps 1..n in the order given and keeps that order', async () => {
        const { cut, weld, paint } = await ops();
        const bomId = await makeBom();
        const saved = await routing.replaceRouting(bomId, [
          { operationId: weld, estimatedMinutes: 30 },
          { operationId: cut, estimatedMinutes: 12.5, notes: ' first pass ' },
          { operationId: paint, estimatedMinutes: 0 },
        ]);
        expect(saved.map((s) => [s.sequence, s.operationId])).toEqual([
          [1, weld],
          [2, cut],
          [3, paint],
        ]);
        const stored = await routing.list(bomId);
        expect(stored.map((s) => s.operationId)).toEqual([weld, cut, paint]);
        expect(stored[1]).toMatchObject({
          estimatedMinutes: 12.5,
          notes: 'first pass',
        });
      });

      it('reorders, edits and removes by replacing the routing', async () => {
        const { cut, weld, paint } = await ops();
        const bomId = await makeBom();
        await routing.replaceRouting(bomId, [
          { operationId: cut, estimatedMinutes: 10 },
          { operationId: weld, estimatedMinutes: 20 },
        ]);
        await routing.replaceRouting(bomId, [
          { operationId: weld, estimatedMinutes: 25 },
          { operationId: paint, estimatedMinutes: 5 },
          { operationId: cut, estimatedMinutes: 10 },
        ]);
        expect(
          (await routing.list(bomId)).map((s) => [
            s.sequence,
            s.operationId,
            Number(s.estimatedMinutes),
          ]),
        ).toEqual([
          [1, weld, 25],
          [2, paint, 5],
          [3, cut, 10],
        ]);
        await routing.replaceRouting(bomId, []);
        expect(await routing.list(bomId)).toEqual([]);
      });

      it('lets the same operation appear twice on one routing', async () => {
        const { cut } = await ops();
        const bomId = await makeBom();
        await routing.replaceRouting(bomId, [
          { operationId: cut, estimatedMinutes: 5 },
          { operationId: cut, estimatedMinutes: 7 },
        ]);
        expect(await routing.list(bomId)).toHaveLength(2);
      });

      it('keeps one bill routing separate from another', async () => {
        const { cut, weld } = await ops();
        const a = await makeBom();
        const b = await makeBom();
        await routing.replaceRouting(a, [
          { operationId: cut, estimatedMinutes: 1 },
        ]);
        await routing.replaceRouting(b, [
          { operationId: weld, estimatedMinutes: 2 },
        ]);
        await routing.replaceRouting(a, []);
        expect((await routing.list(b)).map((s) => s.operationId)).toEqual([
          weld,
        ]);
      });

      it('rejects a missing bill, unknown operation and bad duration, changing nothing', async () => {
        const { cut } = await ops();
        const bomId = await makeBom();
        await routing.replaceRouting(bomId, [
          { operationId: cut, estimatedMinutes: 9 },
        ]);
        await expect(routing.replaceRouting(randomUUID(), [])).rejects.toThrow(
          BomNotFoundError,
        );
        await expect(
          routing.replaceRouting(bomId, [
            { operationId: randomUUID(), estimatedMinutes: 1 },
          ]),
        ).rejects.toThrow(OperationNotFoundError);
        for (const estimatedMinutes of [
          -1,
          Number.NaN,
          Number.POSITIVE_INFINITY,
        ])
          await expect(
            routing.replaceRouting(bomId, [
              { operationId: cut, estimatedMinutes },
            ]),
          ).rejects.toThrow(InvalidOperationInputError);
        const stored = await routing.list(bomId);
        expect(stored).toHaveLength(1);
        expect(Number(stored[0].estimatedMinutes)).toBe(9);
      });

      it('refuses to newly add a retired operation but keeps one already on the routing', async () => {
        const { cut, weld } = await ops();
        const bomId = await makeBom();
        await routing.replaceRouting(bomId, [
          { operationId: cut, estimatedMinutes: 10 },
        ]);
        await operations.retire(cut);
        await operations.retire(weld);
        await expect(
          routing.replaceRouting(bomId, [
            { operationId: weld, estimatedMinutes: 5 },
          ]),
        ).rejects.toThrow(OperationRetiredError);
        // The retired operation already on the routing may be re-saved.
        await routing.replaceRouting(bomId, [
          { operationId: cut, estimatedMinutes: 12 },
        ]);
        expect(Number((await routing.list(bomId))[0].estimatedMinutes)).toBe(
          12,
        );
        // And another bill cannot newly add it.
        await expect(
          routing.replaceRouting(await makeBom(), [
            { operationId: cut, estimatedMinutes: 1 },
          ]),
        ).rejects.toThrow(OperationRetiredError);
      });

      it('serializes concurrent replacements so the result is one of the requested routings', async () => {
        const { cut, weld, paint } = await ops();
        const bomId = await makeBom();
        const long = [cut, weld, paint].map((operationId) => ({
          operationId,
          estimatedMinutes: 1,
        }));
        const short = [{ operationId: paint, estimatedMinutes: 2 }];
        await Promise.allSettled([
          routing.replaceRouting(bomId, long),
          routing.replaceRouting(bomId, short),
        ]);
        const stored = (await routing.list(bomId)).map((s) => s.operationId);
        expect([[cut, weld, paint], [paint]]).toContainEqual(stored);
      });

      it('tolerates a missing-operation guard even when the steps table is queried directly', async () => {
        const steps = await RoutingStepCollection.create({ db });
        expect(await steps.findByBom(randomUUID())).toEqual([]);
      });
    });

    describe('BomService rollup with and without routing', () => {
      const skuId = randomUUID();
      async function bomWithMaterial(): Promise<string> {
        const bomId = await makeBom('EUR');
        const line = await lines.create({
          bomId,
          componentSkuId: skuId,
          qtyPerUnit: 2,
          uom: 'each',
        });
        await line.save();
        return bomId;
      }

      it('a bill with no routing rolls up as before and reports no labour', async () => {
        const bomId = await bomWithMaterial();
        const service = await BomService.create({
          db,
          costResolver: () => 3,
          rateResolver: () => 60,
        });
        const material = await service.computeMaterialCost(bomId);
        expect(material.totalCost).toBe(6);
        expect(material.hasMissingCosts).toBe(false);
        const labour = await service.computeLabourEstimate(bomId);
        expect(labour).toMatchObject({
          bomId,
          hasRouting: false,
          totalMinutes: 0,
          totalCost: 0,
          currency: 'EUR',
          steps: [],
          hasMissingRates: false,
        });
      });

      it('rolls minutes and cost up the routing in order', async () => {
        const cut = await operations.define({ code: 'CUT', name: 'Cutting' });
        const weld = await operations.define({ code: 'WELD', name: 'Welding' });
        const bomId = await bomWithMaterial();
        await routing.replaceRouting(bomId, [
          { operationId: weld.id as string, estimatedMinutes: 90 },
          { operationId: cut.id as string, estimatedMinutes: 30 },
        ]);
        const seen: string[] = [];
        const service = await BomService.create({
          db,
          costResolver: () => 3,
          rateResolver: (operation) => {
            seen.push(operation.code);
            return operation.code === 'WELD' ? 80 : 60;
          },
        });
        const labour = await service.computeLabourEstimate(bomId);
        expect(labour.hasRouting).toBe(true);
        expect(labour.totalMinutes).toBe(120);
        // 90 min at 80/h = 120; 30 min at 60/h = 30.
        expect(labour.totalCost).toBeCloseTo(150, 5);
        expect(labour.hasMissingRates).toBe(false);
        expect(labour.currency).toBe('EUR');
        expect(
          labour.steps.map((s) => [
            s.sequence,
            s.operationCode,
            s.estimatedMinutes,
            s.stepCost,
          ]),
        ).toEqual([
          [1, 'WELD', 90, 120],
          [2, 'CUT', 30, 30],
        ]);
        expect(seen).toEqual(['WELD', 'CUT']);
        // Material cost is unaffected by the routing.
        expect((await service.computeMaterialCost(bomId)).totalCost).toBe(6);
      });

      it('reports minutes with rates marked unavailable when no resolver is given or it has no answer', async () => {
        const cut = await operations.define({ code: 'CUT', name: 'Cutting' });
        const weld = await operations.define({ code: 'WELD', name: 'Welding' });
        const bomId = await makeBom();
        await routing.replaceRouting(bomId, [
          { operationId: cut.id as string, estimatedMinutes: 15 },
          { operationId: weld.id as string, estimatedMinutes: 45 },
        ]);
        const none = await (
          await BomService.create({ db })
        ).computeLabourEstimate(bomId);
        expect(none.totalMinutes).toBe(60);
        expect(none.totalCost).toBe(0);
        expect(none.hasMissingRates).toBe(true);
        expect(none.steps.every((s) => s.rateUnavailable)).toBe(true);

        const partial = await (
          await BomService.create({
            db,
            rateResolver: (operation) => (operation.code === 'CUT' ? 60 : null),
          })
        ).computeLabourEstimate(bomId);
        expect(partial.totalCost).toBeCloseTo(15, 5);
        expect(partial.hasMissingRates).toBe(true);
        expect(partial.steps.map((s) => s.rateUnavailable)).toEqual([
          false,
          true,
        ]);
      });

      it('still counts a retired operation that the routing names', async () => {
        const cut = await operations.define({ code: 'CUT', name: 'Cutting' });
        const bomId = await makeBom();
        await routing.replaceRouting(bomId, [
          { operationId: cut.id as string, estimatedMinutes: 20 },
        ]);
        await operations.retire(cut.id as string);
        const labour = await (
          await BomService.create({ db })
        ).computeLabourEstimate(bomId);
        expect(labour.totalMinutes).toBe(20);
        expect(labour.steps[0].operationCode).toBe('CUT');
      });

      it('throws for a missing bill', async () => {
        const service = await BomService.create({ db });
        await expect(
          service.computeLabourEstimate(randomUUID()),
        ).rejects.toThrow(BomNotFoundError);
      });
    });
  });
}
