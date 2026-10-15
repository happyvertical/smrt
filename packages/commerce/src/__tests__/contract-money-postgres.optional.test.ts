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
import { ContractCollection } from '../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../collections/ContractLineItemCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import { PurchaseOrder } from '../models/Contract.js';
import { MoneyValidationError } from '../money.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('contract money aggregate on PostgreSQL (#3933)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'ContractLineItem',
        'DocumentTax',
        'TaxCode',
        'TaxComponent',
        'TaxSettings',
        'Vendor',
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

  async function activateV2(tenantId: string): Promise<string> {
    const components = await TaxComponentCollection.create({ db });
    const gst = await components.create({
      name: 'GST',
      percent: '5',
      recoverable: true,
    });
    const codes = await TaxCodeCollection.create({ db });
    const code = await codes.create({
      code: 'gst',
      name: 'GST',
      components: [{ taxComponentId: gst.id, compound: false }],
    });
    const settings = await TaxSettingsCollection.create({ db });
    const setting = await settings.getOrCreateForTenant(tenantId);
    setting.defaultSalesTaxCodeId = code.id;
    setting.defaultPurchaseTaxCodeId = code.id;
    setting.defaultLineAmountType = 'exclusive';
    setting.taxRoundingScope = 'document';
    await setting.save();
    const migrationId = await settings.beginMoneyMigration(tenantId);
    await settings.activateMoneyV2(tenantId, migrationId);
    return code.id;
  }

  it('commits one aggregate and rolls back an invalid sibling', async () => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, async () => {
      const codeId = await activateV2(tenantId);
      const contracts = await ContractCollection.create({ db });
      const contract = await contracts.create({ currency: 'CAD' });
      const lines = await ContractLineItemCollection.create({ db });
      await lines.create({
        contractId: contract.id,
        description: 'Valid',
        quantity: 1,
        unitPrice: 100,
        taxMode: 'override',
        taxCodeId: codeId,
      });
      await expect(
        lines.create({
          contractId: contract.id,
          description: 'Invalid',
          quantity: 1,
          unitPrice: 100,
          discountType: 'amount',
          discount: 101,
          taxMode: 'override',
          taxCodeId: codeId,
        }),
      ).rejects.toBeInstanceOf(MoneyValidationError);

      expect(await lines.findByContract(contract.id)).toHaveLength(1);
      expect(
        await contracts.get({ id: contract.id }, { cache: false }),
      ).toMatchObject({ subtotal: 100, taxAmount: 5, totalAmount: 105 });
      expect(
        await (await DocumentTaxCollection.create({ db })).findByDocument(
          tenantId,
          'contract',
          contract.id,
        ),
      ).toMatchObject([
        { taxableMinor: 100, taxMinor: 5, recoverableMinor: 0 },
      ]);
    });
  });

  it('persists a purchase tax recovery snapshot through the STI branch', async () => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, async () => {
      const codeId = await activateV2(tenantId);
      const vendor = await (await VendorCollection.create({ db })).create({
        defaultTaxCodeId: codeId,
      });
      const purchase = new PurchaseOrder({
        db,
        vendorId: vendor.id,
        currency: 'CAD',
      });
      await purchase.initialize();
      await purchase.save();
      await (await ContractLineItemCollection.create({ db })).create({
        contractId: purchase.id,
        description: 'Recoverable parts',
        quantity: 2,
        unitPrice: 100,
      });

      expect(
        await (await ContractCollection.create({ db })).get(
          { id: purchase.id },
          { cache: false },
        ),
      ).toMatchObject({ subtotal: 200, taxAmount: 10, totalAmount: 210 });
      expect(
        await (await DocumentTaxCollection.create({ db })).findByDocument(
          tenantId,
          'contract',
          purchase.id,
        ),
      ).toMatchObject([
        { taxableMinor: 200, taxMinor: 10, recoverableMinor: 10 },
      ]);
    });
  });
});
