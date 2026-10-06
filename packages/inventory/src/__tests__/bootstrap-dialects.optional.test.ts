/** Collection bootstrap must not interleave schema probes on one connection. */
import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createStockService,
  type StockService,
} from '../services/StockService.js';

for (const type of ['sqlite', 'duckdb', 'postgres'] as const) {
  describe.skipIf(type === 'postgres' && !process.env.SMRT_TEST_POSTGRES_URL)(
    `stock service shared-handle initialization on ${type}`,
    () => {
      let db: Awaited<ReturnType<typeof getDatabase>>;
      let service: StockService;
      const schema = `inventory_bootstrap_${randomUUID().replaceAll('-', '')}`;
      const skuId = randomUUID();
      const locationId = randomUUID();
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
        // Provision application schema explicitly; leave framework system tables
        // cold so the public service factory exercises their real bootstrap.
        for (const name of [
          'InventoryLocation',
          'StockLevel',
          'StockMovement',
        ]) {
          const key = `@happyvertical/smrt-inventory:${name}`;
          const ddl = ObjectRegistry.getSchemaDDL(key, type);
          const definition = ObjectRegistry.getSchema(key);
          if (!ddl || !definition)
            throw new Error(`Missing schema for ${name}`);
          await db.query(ddl);
          for (const sql of getDDLStrategy(type).generateIndexes(definition)) {
            await db.query(sql);
          }
        }
        service = await createStockService({ db });
      });
      afterAll(async () => {
        if (type === 'postgres' && db)
          await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await db?.close?.();
      });
      it('initializes a cold service and preserves affinity across repeated rollback/retry', async () => {
        expect(service.levels.db).toBe(service.movements.db);
        expect(service.levels.db).toBe(service.locations.db);
        await service.receive(skuId, locationId, 10);
        for (let attempt = 0; attempt < 20; attempt++) {
          await expect(
            service.withTransaction(async (tx) => {
              expect(tx.levels.db).toBe(tx.movements.db);
              expect(tx.levels.db).toBe(tx.locations.db);
              expect(tx.levels.db).toBe(tx.db);
              await tx.adjust(skuId, locationId, 1);
              expect(
                Number((await tx.levels.getLevel(skuId, locationId))?.qty),
              ).toBe(11);
              throw new Error('intentional rollback');
            }),
          ).rejects.toThrow('intentional rollback');
          expect(
            Number((await service.levels.getLevel(skuId, locationId))?.qty),
          ).toBe(10);
          expect(await service.movements.findBySku(skuId)).toHaveLength(1);
        }
      });
    },
  );
}
