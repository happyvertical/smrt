import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';

/** PostgreSQL regression coverage, run through scripts/run-with-ci-postgres.mjs. */
describe('tax codes on PostgreSQL', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    db = await getTestDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('round-trips DECIMAL rates and refuses a foreign tenant component', async () => {
    let componentId = '';
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await withTenant({ tenantId: tenantA }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const component = await components.create({
        name: 'GST',
        percent: '5.125000',
      });
      componentId = component.id;
      expect(component.percent).toBe('5.125');
    });
    await withTenant({ tenantId: tenantB }, async () => {
      const codes = await TaxCodeCollection.create({ db });
      await expect(
        codes.create({
          code: 'foreign',
          name: 'Foreign',
          components: [{ taxComponentId: componentId, compound: false }],
        }),
      ).rejects.toThrow(/same tenant/);
    });
  });
});
