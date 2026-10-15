/**
 * Clean tenants start on money v2 (#4009).
 *
 * A tenant's first TaxSettings row chooses its money model once: `v2` with no
 * stored Invoice or Contract rows, `legacy` otherwise. `ensureCommerceTenant`
 * is the one host bootstrap call. The PostgreSQL parity suite is
 * `tenant-money-default.optional.test.ts`.
 */
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection';
import { InvoiceCollection } from '../collections/InvoiceCollection';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection';
import { TaxCodeCollection } from '../collections/TaxCodeCollection';
import { TaxComponentCollection } from '../collections/TaxComponentCollection';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection';
import { ensureCommerceTenant } from '../index';
import {
  migrateCommerceLineAmounts,
  preflightCommerceLineAmounts,
} from '../migrations/commerceLineAmounts';
import { InvoiceStatus } from '../types';
import { seedLegacyMoneyTenant } from './helpers/legacy-money-tenant';

const COOKBOOK: Pick<Cookbook, 'policies'> = {
  policies: [
    {
      objectRef: '@happyvertical/smrt-commerce:InvoiceLineItem',
      fieldName: 'taxRate',
      scopeType: 'app',
      defaultValue: '0.0825',
    },
    {
      objectRef: '@happyvertical/smrt-commerce:Invoice',
      fieldName: 'lineAmountType',
      scopeType: 'app',
      defaultValue: '"inclusive"',
    },
    {
      objectRef: '@happyvertical/smrt-commerce:Invoice',
      fieldName: 'taxRoundingScope',
      scopeType: 'app',
      defaultValue: '"document"',
    },
  ] as Cookbook['policies'],
};

describe('clean tenants default to money v2 (#4009)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  const markers = (tenantId: string) =>
    withTenant({ tenantId }, async () =>
      (await TaxSettingsCollection.create({ db })).list({
        where: { tenantId },
      }),
    );

  /** Legacy rows written before the tenant had any marker row. */
  async function documentsWithoutMarker(tenantId: string) {
    await seedLegacyMoneyTenant(db, tenantId);
    const ids = await withTenant({ tenantId }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        invoiceNumber: 'PRE-MARKER',
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        invoiceId: invoice.id,
        description: 'Legacy line',
        quantity: 2,
        unitPrice: 100,
        taxRate: 0.05,
      });
      return { invoiceId: invoice.id as string, lineId: line.id as string };
    });
    await db.query('DELETE FROM tax_settings WHERE tenant_id = ?', tenantId);
    expect(await markers(tenantId)).toEqual([]);
    return ids;
  }

  it('creates a clean tenant marker on v2 through every first-row path', async () => {
    await withTenant({ tenantId: 'seeded' }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      await expect(
        settings.getOrCreateForTenant('seeded'),
      ).resolves.toMatchObject({ moneyModel: 'v2', moneyMigrationId: '' });
    });
    // A generated create carries only writable fields; the first row still
    // decides the model from the tenant's documents.
    await withTenant({ tenantId: 'generated' }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      await expect(
        settings.create({
          tenantId: 'generated',
          taxRoundingScope: 'document',
        }),
      ).resolves.toMatchObject({ moneyModel: 'v2' });
    });
    // A caller that names the model keeps it.
    await withTenant({ tenantId: 'explicit' }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      await expect(
        settings.create({ tenantId: 'explicit', moneyModel: 'legacy' }),
      ).resolves.toMatchObject({ moneyModel: 'legacy' });
    });
  });

  it('puts a tenant on v2 when its first money document is written', async () => {
    await withTenant({ tenantId: 'first-document' }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        invoiceNumber: 'FIRST',
        currency: 'CAD',
      });
      const line = await (
        await InvoiceLineItemCollection.create({ db })
      ).create({
        invoiceId: invoice.id,
        description: 'Service',
        quantity: 2,
        unitPrice: 100,
      });
      // v2 stores tax-exclusive net and recomputes the header atomically.
      expect(line).toMatchObject({ amount: 200, taxAmount: 0 });
      expect(
        await (await InvoiceCollection.create({ db })).get(
          { id: invoice.id },
          { cache: false },
        ),
      ).toMatchObject({ subtotal: 200, totalAmount: 200 });
    });
    expect(await markers('first-document')).toMatchObject([
      { moneyModel: 'v2' },
    ]);
  });

  it('keeps a tenant with documents written before its marker on legacy', async () => {
    await documentsWithoutMarker('pre-existing');
    await withTenant({ tenantId: 'pre-existing' }, async () => {
      await expect(
        (await TaxSettingsCollection.create({ db })).getOrCreateForTenant(
          'pre-existing',
        ),
      ).resolves.toMatchObject({ moneyModel: 'legacy' });
    });
    await expect(ensureCommerceTenant(db, 'pre-existing')).resolves.toEqual({
      tenantId: 'pre-existing',
      moneyModel: 'legacy',
    });
    // The legacy line keeps its legacy semantics and the migration still
    // reaches it, unchanged.
    const report = await preflightCommerceLineAmounts(db, {
      tenantId: 'pre-existing',
    });
    expect(report.documents).toHaveLength(1);
    const migrated = await migrateCommerceLineAmounts(db, {
      tenantId: 'pre-existing',
      acceptDraftChanges: true,
    });
    expect(migrated).toMatchObject({ migrated: 1, activated: true });
    expect(await markers('pre-existing')).toMatchObject([{ moneyModel: 'v2' }]);
  });

  it('gives racing first documents one marker and one model', async () => {
    const tenantId = 'racing';
    const writes = await withTenant({ tenantId }, () =>
      Promise.all(
        [1, 2, 3].map(async (n) => {
          const invoice = await (await InvoiceCollection.create({ db })).create(
            { invoiceNumber: `RACE-${n}`, currency: 'CAD' },
          );
          return (await InvoiceLineItemCollection.create({ db })).create({
            invoiceId: invoice.id,
            description: `Race ${n}`,
            quantity: 1,
            unitPrice: 100 * n,
          });
        }),
      ),
    );
    expect(writes.map((line) => line.amount)).toEqual([100, 200, 300]);
    expect(await markers(tenantId)).toMatchObject([{ moneyModel: 'v2' }]);

    const seeds = await withTenant({ tenantId: 'racing-seed' }, async () =>
      Promise.all(
        [1, 2, 3, 4].map(async () =>
          (await TaxSettingsCollection.create({ db })).getOrCreateForTenant(
            'racing-seed',
          ),
        ),
      ),
    );
    expect(new Set(seeds.map((row) => row.id)).size).toBe(1);
    expect(await markers('racing-seed')).toMatchObject([{ moneyModel: 'v2' }]);
  });

  it('keeps the migration route for an empty tenant it sees first', async () => {
    const result = await migrateCommerceLineAmounts(db, {
      tenantId: 'migrate-empty',
    });
    expect(result).toMatchObject({ migrated: 0, activated: true });
    expect(await markers('migrate-empty')).toMatchObject([
      { moneyModel: 'v2' },
    ]);
  });

  describe('ensureCommerceTenant', () => {
    it('applies the cookbook and starts a clean tenant on v2', async () => {
      await expect(
        ensureCommerceTenant(db, 'cookbook', { cookbook: COOKBOOK }),
      ).resolves.toEqual({ tenantId: 'cookbook', moneyModel: 'v2' });
      await withTenant({ tenantId: 'cookbook' }, async () => {
        const codes = await TaxCodeCollection.create({ db });
        const defaultCode = await codes.findByCode('default-8_25');
        expect(defaultCode?.components).toHaveLength(1);
        for (const code of ['exempt', 'zero-rated', 'out-of-scope'])
          expect(await codes.findByCode(code)).toBeTruthy();
        const settings = await (
          await TaxSettingsCollection.create({ db })
        ).getForTenant('cookbook');
        expect(settings).toMatchObject({
          moneyModel: 'v2',
          defaultLineAmountType: 'inclusive',
          taxRoundingScope: 'document',
          defaultSalesTaxCodeId: defaultCode?.id,
          defaultPurchaseTaxCodeId: defaultCode?.id,
        });
        const component = await (
          await TaxComponentCollection.create({ db })
        ).get({ id: defaultCode?.components[0].taxComponentId as string });
        expect(component?.percent).toBe('8.25');
      });

      // Idempotent: a retry converges on the same rows.
      await ensureCommerceTenant(db, 'cookbook', { cookbook: COOKBOOK });
      expect(await markers('cookbook')).toHaveLength(1);
      await withTenant({ tenantId: 'cookbook' }, async () => {
        const codes = await (await TaxCodeCollection.create({ db })).list({
          where: { code: 'default-8_25' },
        });
        expect(codes).toHaveLength(1);
      });
    });

    it('seeds only the standard codes without a cookbook', async () => {
      await expect(ensureCommerceTenant(db, 'plain')).resolves.toEqual({
        tenantId: 'plain',
        moneyModel: 'v2',
      });
      await withTenant({ tenantId: 'plain' }, async () => {
        const settings = await (
          await TaxSettingsCollection.create({ db })
        ).getForTenant('plain');
        expect(settings).toMatchObject({
          moneyModel: 'v2',
          defaultLineAmountType: 'exclusive',
          taxRoundingScope: 'line',
        });
        expect(settings?.defaultSalesTaxCodeId).toBeFalsy();
        expect(
          await (await TaxCodeCollection.create({ db })).findByCode('exempt'),
        ).toBeTruthy();
      });
    });

    it('moves an empty legacy marker to v2 and refuses a migrating tenant', async () => {
      await seedLegacyMoneyTenant(db, 'empty-legacy', 'migrating');
      await expect(ensureCommerceTenant(db, 'empty-legacy')).resolves.toEqual({
        tenantId: 'empty-legacy',
        moneyModel: 'v2',
      });

      await withTenant({ tenantId: 'migrating' }, async () => {
        await (await TaxSettingsCollection.create({ db })).beginMoneyMigration(
          'migrating',
        );
      });
      await expect(ensureCommerceTenant(db, 'migrating')).rejects.toMatchObject(
        { code: 'FROZEN_DOCUMENT' },
      );
      expect(await markers('migrating')).toMatchObject([
        { moneyModel: 'migrating' },
      ]);
    });

    it('keeps a legacy tenant with documents on legacy', async () => {
      await seedLegacyMoneyTenant(db, 'busy');
      await withTenant({ tenantId: 'busy' }, async () => {
        await (await InvoiceCollection.create({ db })).create({
          invoiceNumber: 'BUSY',
        });
      });
      await expect(
        ensureCommerceTenant(db, 'busy', { cookbook: COOKBOOK }),
      ).resolves.toEqual({ tenantId: 'busy', moneyModel: 'legacy' });
    });

    it('provisions or returns an empty tenant to legacy on request', async () => {
      await expect(
        ensureCommerceTenant(db, 'seller', { moneyModel: 'legacy' }),
      ).resolves.toEqual({ tenantId: 'seller', moneyModel: 'legacy' });
      await ensureCommerceTenant(db, 'seller-later');
      await expect(
        ensureCommerceTenant(db, 'seller-later', { moneyModel: 'legacy' }),
      ).resolves.toEqual({ tenantId: 'seller-later', moneyModel: 'legacy' });
      expect(await markers('seller-later')).toMatchObject([
        { moneyModel: 'legacy' },
      ]);

      // A v2 tenant that already holds v2 documents cannot go back.
      await ensureCommerceTenant(db, 'v2-busy');
      await withTenant({ tenantId: 'v2-busy' }, async () => {
        await (await InvoiceCollection.create({ db })).create({
          invoiceNumber: 'V2-BUSY',
        });
      });
      await expect(
        ensureCommerceTenant(db, 'v2-busy', { moneyModel: 'legacy' }),
      ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
      expect(await markers('v2-busy')).toMatchObject([{ moneyModel: 'v2' }]);
    });

    it('requires a tenant', async () => {
      await expect(ensureCommerceTenant(db, '  ')).rejects.toThrow(
        /requires a tenant/,
      );
    });
  });

  describe('legacy documents imported into a v2 tenant', () => {
    async function v2TenantWithGst(tenantId: string): Promise<string> {
      await ensureCommerceTenant(db, tenantId);
      return withTenant({ tenantId }, async () => {
        const gst = await (await TaxComponentCollection.create({ db })).create({
          name: 'GST',
          percent: '5',
        });
        const code = await (await TaxCodeCollection.create({ db })).create({
          code: 'gst',
          name: 'GST',
          components: [{ taxComponentId: gst.id, compound: false }],
        });
        const settings = await (
          await TaxSettingsCollection.create({ db })
        ).getForTenant(tenantId);
        if (!settings) throw new Error('Expected tenant settings');
        settings.defaultSalesTaxCodeId = code.id as string;
        await settings.save();
        return code.id as string;
      });
    }

    it('converts a draft through the v2 write path and ignores legacy money inputs', async () => {
      const gst = await v2TenantWithGst('import-draft');
      await withTenant({ tenantId: 'import-draft' }, async () => {
        const customer = await (await CustomerCollection.create({ db })).create(
          {},
        );
        const invoice = await (await InvoiceCollection.create({ db })).create({
          customerId: customer.id,
          invoiceNumber: 'IMPORTED-DRAFT',
          currency: 'CAD',
          // Legacy header totals from the source system.
          subtotal: 226,
          taxAmount: 26,
          totalAmount: 226,
        });
        const line = await (
          await InvoiceLineItemCollection.create({ db })
        ).create({
          invoiceId: invoice.id,
          description: 'Imported legacy line',
          quantity: 2,
          unitPrice: 100,
          // A legacy rate and tax-inclusive amount are not v2 inputs.
          taxRate: 0.13,
          amount: 226,
        });
        expect(line).toMatchObject({
          amount: 200,
          taxAmount: 10,
          taxRate: 0.05,
          taxCodeId: gst,
          legacyAmount: null,
        });
        expect(
          await (await InvoiceCollection.create({ db })).get(
            { id: invoice.id },
            { cache: false },
          ),
        ).toMatchObject({ subtotal: 200, taxAmount: 10, totalAmount: 210 });
        const taxes = await (await DocumentTaxCollection.create({ db })).list({
          where: { documentId: invoice.id },
        });
        expect(taxes).toMatchObject([{ taxMinor: 10 }]);
      });
    });

    it('refuses an issued legacy document and the migration refuses the tenant', async () => {
      await v2TenantWithGst('import-issued');
      await withTenant({ tenantId: 'import-issued' }, async () => {
        const invoice = await (await InvoiceCollection.create({ db })).create({
          invoiceNumber: 'IMPORTED-ISSUED',
          currency: 'CAD',
          status: InvoiceStatus.SENT,
        });
        await expect(
          (await InvoiceLineItemCollection.create({ db })).create({
            invoiceId: invoice.id,
            description: 'Issued legacy line',
            quantity: 1,
            unitPrice: 100,
            taxRate: 0.05,
            amount: 105,
          }),
        ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
      });
      await expect(
        migrateCommerceLineAmounts(db, { tenantId: 'import-issued' }),
      ).rejects.toMatchObject({ code: 'FROZEN_DOCUMENT' });
    });
  });
});
