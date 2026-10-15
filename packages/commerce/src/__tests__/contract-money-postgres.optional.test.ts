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
import { PurchaseOrder, SupplierQuote } from '../models/Contract.js';
import { MoneyValidationError } from '../money.js';
import { ContractStatus, ContractType } from '../types/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('contract money aggregate on PostgreSQL (#3933)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Contract',
        'Customer',
        'Invoice',
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

  it.each([
    PurchaseOrder,
    SupplierQuote,
  ])('persists and freezes %s purchase tax snapshots with report eligibility', async (Purchase) => {
    const tenantId = randomUUID();
    await withTenant({ tenantId }, async () => {
      const codeId = await activateV2(tenantId);
      const vendor = await (await VendorCollection.create({ db })).create({
        defaultTaxCodeId: codeId,
      });
      const purchase = new Purchase({
        db,
        vendorId: vendor.id,
        currency: 'CAD',
        issueDate: new Date('2026-09-12T00:00:00.000Z'),
      });
      await purchase.initialize();
      await purchase.save();
      const line = await (
        await ContractLineItemCollection.create({ db })
      ).create({
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
      const contracts = await ContractCollection.create({ db });
      const issued = await contracts.get({ id: purchase.id }, { cache: false });
      if (!issued) throw new Error('Expected persisted purchase contract');
      issued.status = ContractStatus.ACCEPTED;
      await issued.save();
      expect(issued.moneySnapshotId).toBeTruthy();
      // The mutable display scalar does not change the persisted STI identity.
      issued.contractType =
        purchase instanceof SupplierQuote
          ? ContractType.PURCHASE_ORDER
          : ContractType.SUPPLIER_QUOTE;
      await issued.save();
      const reloaded = await contracts.get(
        { id: purchase.id },
        { cache: false },
      );
      expect(reloaded).toBeInstanceOf(Purchase);
      expect(reloaded?.contractType).toBe(issued.contractType);

      line.unitPrice = 101;
      await expect(line.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
      const options = {
        tenantId,
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-30T23:59:59.999Z'),
      };
      const taxes = await DocumentTaxCollection.create({ db });
      expect(
        await taxes.findByDocument(tenantId, 'contract', purchase.id),
      ).toMatchObject([
        { taxableMinor: 200, taxMinor: 10, recoverableMinor: 10 },
      ]);
      const reportIds = (
        await contracts.listSnapshotReportContracts(options)
      ).map((row) => row.id);
      const facts = await taxes.listReportFacts(options);
      if (purchase instanceof SupplierQuote) {
        expect(reportIds).toEqual([]);
        expect(facts).toEqual([]);
      } else {
        expect(reportIds).toEqual([purchase.id]);
        expect(facts).toMatchObject([
          { documentId: purchase.id, recoverableMinor: 10 },
        ]);
      }
    });
  });
});
