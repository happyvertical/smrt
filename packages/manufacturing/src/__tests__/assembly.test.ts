import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { AssemblyService } from '../index.js';
import { assemblySuite } from './assembly-suite.js';

let db: DatabaseInterface;
assemblySuite(
  'assembly (sqlite)',
  async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    return db;
  },
  async () => {
    await db.close?.();
  },
);

describe('AssemblyService with a database config', () => {
  it('shares one connection across its collections', async () => {
    // Each collection created from a `:memory:` config would otherwise open
    // its own empty database, and the SKU's product would never be found.
    const service = await AssemblyService.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const caster = await service.products.create({
      name: 'Caster',
      slug: `caster-${crypto.randomUUID()}`,
    });
    const sku = await service.skus.create({
      productId: caster.id!,
      code: `CASTER-${crypto.randomUUID()}`,
    });
    expect((await service.resolveComponent(sku.id!)).kind).toBe('bought');
  });
});
