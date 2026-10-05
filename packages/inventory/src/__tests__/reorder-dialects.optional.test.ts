import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createStockService,
  type StockService,
} from '../services/StockService.js';

for (const type of ['duckdb', 'postgres'] as const) {
  describe.skipIf(type === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL)(
    `inventory metadata on ${type}`,
    () => {
      let db: Awaited<ReturnType<typeof getDatabase>>;
      let service: StockService;
      const schema = `inventory_${randomUUID().replaceAll('-', '')}`;
      beforeAll(async () => {
        db = await getDatabase({
          type,
          url:
            type === 'postgres'
              ? process.env.SMRT_TEST_POSTGRES_URL
              : ':memory:',
          dbid: schema,
        });
        if (type === 'postgres') {
          await db.query(`CREATE SCHEMA "${schema}"`);
          await db.query(`SET search_path TO "${schema}"`);
        }
        for (const name of [
          'InventoryLocation',
          'StockLevel',
          'StockMovement',
        ]) {
          const ddl = ObjectRegistry.getSchemaDDL(
            `@happyvertical/smrt-inventory:${name}`,
            type,
          );
          if (!ddl) throw new Error(`Missing schema for ${name}`);
          await db.query(ddl);
          const definition = ObjectRegistry.getSchema(
            `@happyvertical/smrt-inventory:${name}`,
          );
          if (!definition) throw new Error(`Missing definition for ${name}`);
          for (const index of getDDLStrategy(type).generateIndexes(definition))
            await db.query(index);
        }
        service = await createStockService({ db });
      });
      afterAll(async () => {
        if (type === 'postgres' && db)
          await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db?.close?.();
      });
      it('round-trips decimal reorder settings and nullable profile actor IDs', async () => {
        const sku = randomUUID();
        const location = randomUUID();
        const actorProfileId = randomUUID();
        await service.setReorderPolicy(sku, location, 3.5, 8.25);
        await service.receive(sku, location, 2.25, { actorProfileId });
        const low = await service.levels.findBelowReorderPoint(location);
        expect(low).toHaveLength(1);
        expect(Number(low[0].reorderPoint)).toBe(3.5);
        expect(Number(low[0].reorderQuantity)).toBe(8.25);
        expect((await service.movements.findBySku(sku))[0].actorProfileId).toBe(
          actorProfileId,
        );
        await service.adjust(sku, location, 1.25);
        expect(
          await service.levels.findBelowReorderPoint(location),
        ).toHaveLength(0);
        expect(
          (await service.movements.findBySku(sku)).some(
            (movement) => movement.actorProfileId === null,
          ),
        ).toBe(true);
        await expect(
          service.withTransaction(async (tx) => {
            await tx.setReorderPolicy(sku, location, 9);
            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
        expect(
          Number((await service.levels.getLevel(sku, location))?.reorderPoint),
        ).toBe(3.5);
      });
    },
  );
}
