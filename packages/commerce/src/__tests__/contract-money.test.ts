import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../collections/ContractLineItemCollection.js';
import { DocumentTaxCollection } from '../collections/DocumentTaxCollection.js';
import { TaxCodeCollection } from '../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../collections/TaxSettingsCollection.js';
import {
  classifyContractPurchase,
  isContractSnapshotReportEligible,
} from '../contract-money.js';
import { Order, PurchaseOrder } from '../models/Contract.js';
import { ContractStatus } from '../types/index.js';

describe('Contract money persistence (#3933)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    enableTenancy();
  });
  afterEach(async () => {
    disableTenancy();
    await db.close?.();
  });

  async function activateV2(tenantId: string): Promise<string> {
    return withTenant({ tenantId }, async () => {
      const components = await TaxComponentCollection.create({ db });
      const gst = await components.create({ name: 'GST', percent: '5' });
      const codes = await TaxCodeCollection.create({ db });
      const code = await codes.create({
        code: 'gst',
        name: 'GST',
        components: [{ taxComponentId: gst.id, compound: false }],
      });
      const settings = await TaxSettingsCollection.create({ db });
      const current = await settings.getOrCreateForTenant(tenantId);
      current.defaultSalesTaxCodeId = code.id;
      current.defaultLineAmountType = 'exclusive';
      current.taxRoundingScope = 'document';
      await current.save();
      const migrationId = await settings.beginMoneyMigration(tenantId);
      await settings.activateMoneyV2(tenantId, migrationId);
      return code.id;
    });
  }

  it('classifies both STI branches and keeps declined snapshots reportable', () => {
    expect(classifyContractPurchase(new Order())).toBe(false);
    expect(classifyContractPurchase(new PurchaseOrder())).toBe(true);
    expect(
      isContractSnapshotReportEligible(
        new Order({ status: ContractStatus.DECLINED }),
      ),
    ).toBe(true);
    expect(
      isContractSnapshotReportEligible(
        new Order({ status: ContractStatus.DRAFT }),
      ),
    ).toBe(false);
    expect(
      isContractSnapshotReportEligible(
        new Order({ status: ContractStatus.CANCELLED }),
      ),
    ).toBe(false);
  });

  it('persists one draft aggregate and freezes it after sent', async () => {
    const codeId = await activateV2('contract-tenant');
    await withTenant({ tenantId: 'contract-tenant' }, async () => {
      const contracts = await ContractCollection.create({ db });
      const contract = await contracts.create({ currency: 'CAD' });
      const lines = await ContractLineItemCollection.create({ db });
      const line = await lines.create({
        contractId: contract.id,
        description: 'Service',
        quantity: 1,
        unitPrice: 100,
        discountType: 'amount',
        discount: 10,
        taxMode: 'override',
        taxCodeId: codeId,
      });
      expect(line).toMatchObject({ amount: 90, taxAmount: 5, taxRate: 0.05 });
      expect(line.taxComponents).toMatchObject([
        { name: 'GST', percent: '5', taxMinor: 5 },
      ]);
      const stored = await contracts.get({ id: contract.id }, { cache: false });
      expect(stored).toMatchObject({
        subtotal: 90,
        discountTotal: 10,
        taxAmount: 5,
        totalAmount: 95,
      });
      const taxes = await DocumentTaxCollection.create({ db });
      expect(
        await taxes.findByDocument('contract-tenant', 'contract', contract.id),
      ).toMatchObject([{ taxCodeId: codeId, taxableMinor: 90, taxMinor: 5 }]);

      if (!stored) throw new Error('Expected the saved Contract');
      stored.status = ContractStatus.SENT;
      await stored.save();
      const frozen = await contracts.get({ id: contract.id }, { cache: false });
      expect(frozen?.moneySnapshotId).toEqual(expect.any(String));
      line.unitPrice = 101;
      await expect(line.save()).rejects.toMatchObject({
        code: 'FROZEN_DOCUMENT',
      });
    });
  });
});
