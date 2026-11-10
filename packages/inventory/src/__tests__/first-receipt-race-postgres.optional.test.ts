/**
 * Regression for #3204: two transactions that both create the first
 * StockLevel row for one (sku, location, state) lost a quantity on
 * PostgreSQL. The first write was an upsert, so the second overwrote the
 * first's qty with its own delta while the movement ledger kept both.
 *
 * SQLite serializes writers in-process and cannot show the race, so this
 * runs only with SMRT_TEST_POSTGRES_URL.
 */

import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStockService } from '../services/StockService.js';

describe.skipIf(!process.env.SMRT_TEST_POSTGRES_URL)(
  'StockService first receipt race on postgres (#3204)',
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
      for (const name of ['InventoryLocation', 'StockLevel', 'StockMovement']) {
        const ddl = ObjectRegistry.getSchemaDDL(
          `@happyvertical/smrt-inventory:${name}`,
          'postgres',
        );
        if (!ddl) throw new Error(`Missing schema for ${name}`);
        await admin.query(ddl);
        const definition = ObjectRegistry.getSchema(
          `@happyvertical/smrt-inventory:${name}`,
        );
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

    it('never commits a level that disagrees with the movement ledger', async () => {
      const a = await createStockService({ db: dbA });
      const b = await createStockService({ db: dbB });
      const sku = randomUUID();
      const location = randomUUID();

      const results = await Promise.allSettled([
        a.withTransaction(async (tx) => {
          await tx.receive(sku, location, 2);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          await b.withTransaction(async (tx) => {
            await tx.receive(sku, location, 2);
          });
        })(),
      ]);

      const level = await a.levels.getLevel(sku, location);
      const movements = await a.movements.findBySku(sku);
      const ledgerQty = movements.reduce(
        (sum, movement) => sum + Number(movement.qty),
        0,
      );
      expect(Number(level?.qty)).toBe(ledgerQty);
      // The loser rolls back instead of silently overwriting the winner.
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(Number(level?.qty)).toBe(2);
    });
  },
);
