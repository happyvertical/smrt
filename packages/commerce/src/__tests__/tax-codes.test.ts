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
import type { MoneyValidationError } from '../money';
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

  it('keeps component rates exact and rejects a rate rewrite', async () => {
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const component = await components.create({
        name: 'GST',
        percent: '5.000000',
      });
      expect(component.percent).toBe('5.000000');
      component.percent = '6';
      await expect(component.save()).rejects.toMatchObject({
        code: 'PERCENT_OUT_OF_RANGE',
      } satisfies Partial<MoneyValidationError>);
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
      'out-of-scope',
      'zero-rated',
    ]);
    expect(second.map((code) => code.id).sort()).toEqual(
      first.map((code) => code.id).sort(),
    );
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
