import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { InvoiceCollection } from '../collections/InvoiceCollection.js';
import { InvoiceLineItemCollection } from '../collections/InvoiceLineItemCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { MoneyValidationError } from '../money.js';
import { ensureTenantTaxCodes } from '../tax/legacy.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('invoice money aggregate on PostgreSQL (#3933)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Customer',
        'DocumentTax',
        'Invoice',
        'InvoiceLineItem',
        'PaymentAllocation',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
      ],
    });
    db = isolated.baseDb;
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('commits one reconciled aggregate and rolls back an invalid sibling', async () => {
    const tenantId = randomUUID();
    await ensureTenantTaxCodes(db, tenantId);
    await withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({ name: 'GST', percent: '5' });
      const codes = await TaxCodeCollection.create({ db });
      const code = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const setting = await settings.getOrCreateForTenant(tenantId);
      setting.defaultSalesTaxCodeId = code.id;
      await setting.save();
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
      const customers = await CustomerCollection.create({ db });
      const customer = await customers.create({ defaultTaxCodeId: code.id });
      const invoices = await InvoiceCollection.create({ db });
      const invoice = await invoices.create({
        customerId: customer.id,
        invoiceNumber: 'PG-V2',
        currency: 'CAD',
      });
      const lines = await InvoiceLineItemCollection.create({ db });
      await lines.create({
        invoiceId: invoice.id,
        description: 'Valid',
        quantity: 1,
        unitPrice: 100,
      });
      await expect(
        lines.create({
          invoiceId: invoice.id,
          description: 'Invalid',
          quantity: 1,
          unitPrice: 100,
          discountType: 'amount',
          discount: 101,
        }),
      ).rejects.toBeInstanceOf(MoneyValidationError);

      expect(await lines.findByInvoice(invoice.id)).toHaveLength(1);
      expect(
        await invoices.get({ id: invoice.id }, { cache: false }),
      ).toMatchObject({ subtotal: 100, taxAmount: 5, totalAmount: 105 });
      expect(
        await (await DocumentTaxCollection.create({ db })).findByDocument(
          tenantId,
          'invoice',
          invoice.id,
        ),
      ).toMatchObject([{ taxableMinor: 100, taxMinor: 5 }]);
    });
  });
});
