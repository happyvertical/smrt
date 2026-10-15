import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { applyCookbookTaxSettings } from '../tax/cookbook.js';
import { ensureTenantTaxCodes } from '../tax/legacy.js';

/** PostgreSQL regression coverage, run through scripts/run-with-ci-postgres.mjs. */
const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('tax codes on PostgreSQL', () => {
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
    await db?.close?.();
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

  it('converges concurrent tenant seeds and cookbook settings across connections', async () => {
    const second = await getTestDatabase({
      type: 'postgres',
      url: process.env.DATABASE_URL,
    });
    const tenantId = randomUUID();
    try {
      const seeded = await Promise.all([
        ensureTenantTaxCodes(db, tenantId),
        ensureTenantTaxCodes(second, tenantId),
      ]);
      expect(seeded[0].map((row) => row.id).sort()).toEqual(
        seeded[1].map((row) => row.id).sort(),
      );
      await Promise.all([
        applyCookbookTaxSettings(db, tenantId, {
          taxRate: 7.125,
          pricesIncludeTax: false,
          taxRounding: 'document',
        }),
        applyCookbookTaxSettings(second, tenantId, {
          taxRate: 7.125,
          pricesIncludeTax: false,
          taxRounding: 'document',
        }),
      ]);
      await withTenant({ tenantId }, async () => {
        const components = await TaxComponentCollection.create({ db });
        const codes = await TaxCodeCollection.create({ db });
        const settings = await TaxSettingsCollection.create({ db });
        expect(
          await components.list({
            where: { name: 'Legacy unreconciled residual' },
          }),
        ).toHaveLength(1);
        expect(
          await components.list({ where: { name: 'Cookbook 7.125%' } }),
        ).toHaveLength(1);
        for (const code of [
          'exempt',
          'zero-rated',
          'out-of-scope',
          'legacy-unreconciled',
          'default-7_125',
        ]) {
          expect(await codes.list({ where: { code } }), code).toHaveLength(1);
        }
        const rows = await settings.list({ where: { tenantId } });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ taxRoundingScope: 'document' });
      });
    } finally {
      await second.close?.();
    }
  }, 120_000);
});
