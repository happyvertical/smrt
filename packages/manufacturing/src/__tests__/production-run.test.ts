import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { ProductionRunService } from '../index.js';
import { productionRunSuite } from './production-run-suite.js';

let db: DatabaseInterface;
productionRunSuite(
  'production runs (sqlite)',
  async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return db;
  },
  async () => {
    await db.close?.();
  },
);

describe('ProductionRunService.create', () => {
  it('resolves a database config once, so its collections share it', async () => {
    const service = await ProductionRunService.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const bom = await service.boms.create({
      productId: randomUUID(),
      version: 1,
      status: 'active',
    });
    const run = await service.createRun({ bomId: bom.id!, targetQty: 2 });
    await service.recordCompletion(run.id!, { qty: 1 });
    expect((await service.runs.get({ id: run.id! }))?.completedQty).toBe(1);
    expect(service.stockService.db).toBe(service.runs.db);
  });
});
