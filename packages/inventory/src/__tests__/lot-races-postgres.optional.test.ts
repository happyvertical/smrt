/**
 * Lot writes racing on PostgreSQL (#3459). A unique violation aborts a
 * PostgreSQL transaction, so `receiveLot` joined to a caller's transaction
 * must lose only a savepoint, and two usages of one exclusive lot must not
 * both land. SQLite serializes writers in-process and cannot show either,
 * so this runs only with SMRT_TEST_POSTGRES_URL.
 */

import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLotService } from '../services/LotService.js';
import { DuplicateLotError } from '../services/lot-errors.js';
import { createStockService } from '../services/StockService.js';

const MODELS = [
  'InventoryLocation',
  'StockLevel',
  'StockMovement',
  'Lot',
  'LotUsage',
  'LotCorrection',
  'LotDocument',
  'LotStockLevel',
];

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!process.env.SMRT_TEST_POSTGRES_URL)(
  'lot races on postgres (#3459)',
  () => {
    const schema = `inventory_${randomUUID().replaceAll('-', '')}`;
    const open = async () => {
      const db = await getDatabase({
        type: 'postgres',
        url: process.env.SMRT_TEST_POSTGRES_URL,
        dbid: `${schema}_${randomUUID().slice(0, 8)}`,
      });
      await db.query(`SET search_path TO "${schema}"`);
      return db;
    };
    let dbA: Awaited<ReturnType<typeof getDatabase>>;
    let dbB: Awaited<ReturnType<typeof getDatabase>>;

    beforeAll(async () => {
      const admin = await getDatabase({
        type: 'postgres',
        url: process.env.SMRT_TEST_POSTGRES_URL,
        dbid: schema,
      });
      await admin.query(`CREATE SCHEMA "${schema}"`);
      await admin.query(`SET search_path TO "${schema}"`);
      for (const name of MODELS) {
        const qualified = `@happyvertical/smrt-inventory:${name}`;
        const ddl = ObjectRegistry.getSchemaDDL(qualified, 'postgres');
        if (!ddl) throw new Error(`Missing schema for ${name}`);
        await admin.query(ddl);
        const definition = ObjectRegistry.getSchema(qualified);
        if (!definition) throw new Error(`Missing definition for ${name}`);
        for (const index of getDDLStrategy('postgres').generateIndexes(
          definition,
        ))
          await admin.query(index);
      }
      await admin.close?.();
      dbA = await open();
      dbB = await open();
    });

    afterAll(async () => {
      await dbA?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await dbA?.close?.();
      await dbB?.close?.();
    });

    it('a joined duplicate serial loses only its savepoint', async () => {
      const stockA = await createStockService({ db: dbA });
      const stockB = await createStockService({ db: dbB });
      const sku = randomUUID();
      const location = randomUUID();
      let caught: unknown;

      const results = await Promise.allSettled([
        stockA.withTransaction(async (tx) => {
          const lots = await createLotService({ db: tx.db });
          await lots.receiveLot({
            lotNumber: 'SN-1',
            kind: 'serial',
            skuId: sku,
          });
          await pause(500);
        }),
        (async () => {
          await pause(100);
          await stockB.withTransaction(async (tx) => {
            const lots = await createLotService({ db: tx.db });
            try {
              await lots.receiveLot({
                lotNumber: 'sn-1',
                kind: 'serial',
                skuId: sku,
              });
            } catch (error) {
              caught = error;
            }
            // The transaction is still usable after the refused insert.
            await tx.receive(sku, location, 3);
          });
        })(),
      ]);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(caught).toBeInstanceOf(DuplicateLotError);
      const lots = await createLotService({ db: dbA });
      expect(await lots.lots.findByLotNumber('SN-1')).toHaveLength(1);
      expect(Number((await stockA.levels.getLevel(sku, location))?.qty)).toBe(
        3,
      );
    });

    it('a joined retry of one idempotency key returns the winner', async () => {
      const stockA = await createStockService({ db: dbA });
      const stockB = await createStockService({ db: dbB });
      const idempotencyKey = randomUUID();
      let first: string | undefined;
      let second: string | undefined;

      await Promise.all([
        stockA.withTransaction(async (tx) => {
          const lots = await createLotService({ db: tx.db });
          first = (await lots.receiveLot({ lotNumber: 'B-7', idempotencyKey }))
            .id as string;
          await pause(500);
        }),
        (async () => {
          await pause(100);
          await stockB.withTransaction(async (tx) => {
            const lots = await createLotService({ db: tx.db });
            second = (
              await lots.receiveLot({ lotNumber: 'B-7', idempotencyKey })
            ).id as string;
          });
        })(),
      ]);

      expect(second).toBe(first);
    });

    it('two consumers of one exclusive lot never both land', async () => {
      const lotsA = await createLotService({ db: dbA });
      const lotsB = await createLotService({ db: dbB });
      const lot = await lotsA.receiveLot({ lotNumber: `X-${randomUUID()}` });
      const lotId = lot.id as string;

      const results = await Promise.allSettled([
        lotsA.withTransaction(async (tx) => {
          await tx.recordUsage(lotId, {
            consumerType: 'Order',
            consumerId: 'one',
            exclusive: true,
          });
          await pause(500);
        }),
        (async () => {
          await pause(100);
          await lotsB.recordUsage(lotId, {
            consumerType: 'Order',
            consumerId: 'two',
            exclusive: true,
          });
        })(),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await lotsA.usages.findActiveForLot(lotId)).toHaveLength(1);
    });
  },
);
