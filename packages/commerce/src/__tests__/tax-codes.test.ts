import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection';
import { InvoiceCollection } from '../collections/InvoiceCollection';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection';
import { TaxCodeCollection } from '../collections/TaxCodeCollection';
import { TaxComponentCollection } from '../collections/TaxComponentCollection';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection';
import type { MoneyValidationError } from '../money';
import { applyCookbookTaxSettings } from '../tax/cookbook';
import { ensureTenantTaxCodes, mapLegacyTaxRates } from '../tax/legacy';

describe('tax codes (#3934)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  it('keeps unused component rates editable but rejects a persisted rate rewrite after reference', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const component = await components.create({
        name: 'GST',
        percent: '5.000000',
      });
      expect(component.percent).toBe('5');
      component.percent = '6';
      await component.save();
      const codes = await TaxCodeCollection.create({ db });
      await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: component.id, compound: false }],
      });
      const fresh = await components.get(
        { id: component.id },
        { cache: false },
      );
      if (!fresh) throw new Error('Expected saved component');
      fresh.percent = '7';
      await expect(fresh.save()).rejects.toMatchObject({
        code: 'PERCENT_OUT_OF_RANGE',
      } satisfies Partial<MoneyValidationError>);
      const replacement = await components.create({
        name: 'GST',
        percent: '7',
      });
      expect(replacement.id).not.toBe(component.id);
    });
  });

  it('validates tax-code shapes with stable money error codes', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const codes = await TaxCodeCollection.create({ db });
      await expect(
        codes.create({ code: 'bad', name: 'Bad', kind: 'taxable' }),
      ).rejects.toMatchObject({ code: 'TAX_CODE_TAXABLE_EMPTY' });
      await expect(
        codes.create({
          code: 'bad-duplicate',
          name: 'Bad duplicate',
          components: [
            { taxComponentId: 'one', compound: false },
            { taxComponentId: 'one', compound: false },
          ],
        }),
      ).rejects.toMatchObject({ code: 'TAX_CODE_DUPLICATE_COMPONENT' });
      await expect(
        codes.create({
          code: 'bad-exempt',
          name: 'Bad exempt',
          kind: 'exempt',
          components: [{ taxComponentId: 'one', compound: false }],
        }),
      ).rejects.toMatchObject({ code: 'TAX_CODE_NON_TAXABLE_COMPONENTS' });
      await expect(
        codes.create({
          code: 'bad-compound',
          name: 'Bad compound',
          components: [{ taxComponentId: 'one', compound: true }],
        }),
      ).rejects.toMatchObject({ code: 'COMPOUND_UNSUPPORTED' });
    });
  });

  it('seeds non-taxable codes once per tenant', async () => {
    const first = await ensureTenantTaxCodes(db, 'tenant-a');
    const second = await ensureTenantTaxCodes(db, 'tenant-a');
    expect(first.map((code) => code.code).sort()).toEqual([
      'exempt',
      'legacy-unreconciled',
      'out-of-scope',
      'zero-rated',
    ]);
    expect(second.map((code) => code.id).sort()).toEqual(
      first.map((code) => code.id).sort(),
    );
  });

  it('rejects foreign component and default-code references', async () => {
    let componentId = '';
    let codeId = '';
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const components = await TaxComponentCollection.create({ db });
      componentId = (await components.create({ name: 'A', percent: '5' })).id;
      const codes = await TaxCodeCollection.create({ db });
      codeId = (
        await codes.create({
          code: 'a',
          name: 'A',
          components: [{ taxComponentId: componentId, compound: false }],
        })
      ).id;
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const codes = await TaxCodeCollection.create({ db });
      await expect(
        codes.create({
          code: 'foreign',
          name: 'Foreign',
          components: [{ taxComponentId: componentId, compound: false }],
        }),
      ).rejects.toThrow(/same tenant/);
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant('tenant-b');
      current.defaultSalesTaxCodeId = codeId;
      await expect(current.save()).rejects.toThrow(/belong to its tenant/);
    });
  });

  it('rejects malformed component and registration JSON rather than dropping it', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const codes = await TaxCodeCollection.create({ db });
      const code = await codes.create({
        code: 'bad-json',
        name: 'Bad JSON',
        kind: 'exempt',
      });
      code.componentsJson = '{';
      await expect(code.save()).rejects.toThrow(/valid JSON array/);
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant('tenant-a');
      current.taxRegistrationsJson = '[{"taxComponentId":1}]';
      await expect(current.save()).rejects.toThrow(/valid JSON array/);
    });
  });

  it('materializes cookbook tax settings as an owning component and code', async () => {
    await applyCookbookTaxSettings(db, 'tenant-a', {
      taxRate: 5,
      pricesIncludeTax: true,
      taxRounding: 'document',
    });
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant('tenant-a');
      expect(current.defaultLineAmountType).toBe('inclusive');
      expect(current.taxRoundingScope).toBe('document');
      const codes = await TaxCodeCollection.create({ db });
      expect((await codes.findByCode('default-5'))?.components).toHaveLength(1);
    });
  });

  it('maps legacy zero to out-of-scope unless the party was exempt and retries idempotently', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const customers = await CustomerCollection.create({ db });
      const invoices = await InvoiceCollection.create({ db });
      const lines = await InvoiceLineItemCollection.create({ db });
      const normal = await customers.create({ profileId: 'normal' });
      const exempt = await customers.create({
        profileId: 'exempt',
        taxExempt: true,
      });
      await normal.save();
      await exempt.save();
      const normalInvoice = await invoices.create({ customerId: normal.id });
      const exemptInvoice = await invoices.create({ customerId: exempt.id });
      await normalInvoice.save();
      await exemptInvoice.save();
      const taxed = await lines.create({
        invoiceId: normalInvoice.id,
        taxRate: 0.05,
      });
      const untaxed = await lines.create({
        invoiceId: normalInvoice.id,
        taxRate: 0.0,
      });
      const exemptLine = await lines.create({
        invoiceId: exemptInvoice.id,
        taxRate: 0.0,
      });
      await taxed.save();
      await untaxed.save();
      await exemptLine.save();
    });

    const first = await mapLegacyTaxRates(db, { tenantId: 'tenant-a' });
    const second = await mapLegacyTaxRates(db, { tenantId: 'tenant-a' });
    expect(first).toMatchObject([
      { tenantId: 'tenant-a', createdComponents: 1, createdCodes: 1 },
    ]);
    expect(second).toMatchObject([
      { tenantId: 'tenant-a', createdComponents: 0, createdCodes: 0 },
    ]);
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const codes = await TaxCodeCollection.create({ db });
      expect((await codes.findByCode('legacy-5'))?.components).toHaveLength(1);
      expect((await codes.findByCode('out-of-scope'))?.kind).toBe(
        'out-of-scope',
      );
      expect((await codes.findByCode('exempt'))?.kind).toBe('exempt');
    });
  });
});
