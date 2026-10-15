/**
 * `ensureCommerceTenant`, the one commerce call a host makes after it creates
 * a tenant (#4009, #4021): standard tax codes, the settings row and the
 * cookbook's tax defaults, idempotently.
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
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { ensureCommerceTenant } from '../index.js';

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

describe('ensureCommerceTenant', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  const settingsRows = (tenantId: string) =>
    withTenant({ tenantId }, async () =>
      (await TaxSettingsCollection.create({ db })).list({
        where: { tenantId },
      }),
    );

  it('seeds the codes, applies the cookbook and converges on retry', async () => {
    await expect(
      ensureCommerceTenant(db, 'cookbook', { cookbook: COOKBOOK }),
    ).resolves.toEqual({ tenantId: 'cookbook' });
    await withTenant({ tenantId: 'cookbook' }, async () => {
      const codes = await TaxCodeCollection.create({ db });
      const defaultCode = await codes.findByCode('default-8_25', 'cookbook');
      expect(defaultCode?.components).toHaveLength(1);
      for (const code of ['exempt', 'zero-rated', 'out-of-scope'])
        expect(await codes.findByCode(code, 'cookbook')).toBeTruthy();
      expect(
        await (await TaxSettingsCollection.create({ db })).getForTenant(
          'cookbook',
        ),
      ).toMatchObject({
        defaultLineAmountType: 'inclusive',
        taxRoundingScope: 'document',
        defaultSalesTaxCodeId: defaultCode?.id,
        defaultPurchaseTaxCodeId: defaultCode?.id,
      });
      const component = await (await TaxComponentCollection.create({ db })).get(
        { id: defaultCode?.components[0].taxComponentId as string },
      );
      expect(component?.percent).toBe('8.25');
    });

    await ensureCommerceTenant(db, 'cookbook', { cookbook: COOKBOOK });
    expect(await settingsRows('cookbook')).toHaveLength(1);
    await withTenant({ tenantId: 'cookbook' }, async () => {
      expect(
        await (await TaxCodeCollection.create({ db })).list({
          where: { code: 'default-8_25' },
        }),
      ).toHaveLength(1);
    });
  });

  it('seeds settings and the standard codes without a cookbook', async () => {
    await expect(ensureCommerceTenant(db, 'plain')).resolves.toEqual({
      tenantId: 'plain',
    });
    await withTenant({ tenantId: 'plain' }, async () => {
      const settings = await (
        await TaxSettingsCollection.create({ db })
      ).getForTenant('plain');
      expect(settings).toMatchObject({
        defaultLineAmountType: 'exclusive',
        taxRoundingScope: 'line',
      });
      expect(settings?.defaultSalesTaxCodeId).toBeFalsy();
      expect(
        await (await TaxCodeCollection.create({ db })).findByCode(
          'exempt',
          'plain',
        ),
      ).toBeTruthy();
    });
  });

  it('taxes a new invoice with the cookbook default code', async () => {
    await ensureCommerceTenant(db, 'taxed', { cookbook: COOKBOOK });
    await withTenant({ tenantId: 'taxed' }, async () => {
      const invoice = await (await InvoiceCollection.create({ db })).create({
        invoiceNumber: 'T-1',
        currency: 'USD',
      });
      await (await InvoiceLineItemCollection.create({ db })).create({
        invoiceId: invoice.id,
        description: 'Taxed line',
        quantity: 1,
        unitPrice: 10825,
      });
      // Prices include tax (cookbook): 108.25 holds 8.25 of tax.
      expect(
        await (await InvoiceCollection.create({ db })).get({ id: invoice.id }),
      ).toMatchObject({ taxAmount: 825, totalAmount: 10825 });
    });
  });

  it('requires a tenant', async () => {
    await expect(ensureCommerceTenant(db, ' ')).rejects.toThrow(
      'requires a tenant',
    );
  });
});
