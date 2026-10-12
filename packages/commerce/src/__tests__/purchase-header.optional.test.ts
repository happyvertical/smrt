import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import type { PurchaseOrder } from '../models/Contract.js';

async function proveHeader(db: Awaited<ReturnType<typeof getTestDatabase>>) {
  const contracts = await ContractCollection.create({ db });
  const order = await contracts.create({
    _meta_type: 'PurchaseOrder',
    expectedDate: '2026-11-02',
    shipTo: 'Dock 2\nEdmonton',
  });
  await order.save();
  const loaded = (await contracts.get({ id: order.id })) as PurchaseOrder;
  expect(loaded.expectedDate).toBe('2026-11-02');
  expect(loaded.shipTo).toBe('Dock 2\nEdmonton');
  loaded.shipTo = '';
  await loaded.save();
  expect(
    ((await contracts.get({ id: order.id })) as PurchaseOrder).shipTo,
  ).toBe('');
}

describe('purchase header STI metadata', () => {
  it('retains the explicit DuckDB unsupported Contract foreign-key boundary', async () => {
    await expect(
      getTestDatabase({
        type: 'duckdb',
        url: ':memory:',
        classes: ['Contract', 'Customer', 'Vendor'],
      }),
    ).rejects.toThrow('DuckDB cannot preserve SMRT');
  });
  it.skipIf(!isPostgresAvailable())('persists on PostgreSQL', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Contract', 'Customer', 'Vendor'],
    });
    try {
      expect(isolated.config.type).toBe('postgres');
      await proveHeader(isolated.baseDb);
    } finally {
      await isolated.cleanup();
    }
  });
});
