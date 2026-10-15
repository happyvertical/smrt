import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import { ContractCollection } from '../../collections/ContractCollection.js';
import { ContractLineItemCollection } from '../../collections/ContractLineItemCollection.js';
import { TaxCodeCollection } from '../../collections/TaxCodeCollection.js';
import { TaxComponentCollection } from '../../collections/TaxComponentCollection.js';
import { TaxSettingsCollection } from '../../collections/TaxSettingsCollection.js';
import { VendorCollection } from '../../collections/VendorCollection.js';
import { ContractStatus } from '../../types/index.js';

export async function seedReviewedPurchaseContract(
  db: DatabaseInterface,
  tenantId: string,
  input: { reference: string; status?: ContractStatus } = {
    reference: 'PO-REPORT-1',
  },
): Promise<{
  contractId: string;
  vendorId: string;
  gstId: string;
  pstId: string;
}> {
  const components = await TaxComponentCollection.create({ db });
  const gst = await components.create({
    name: `GST ${input.reference}`,
    percent: '5',
    recoverable: true,
  });
  const pst = await components.create({
    name: `PST ${input.reference}`,
    percent: '7',
    recoverable: false,
  });
  if (!gst.id || !pst.id) throw new Error('Expected persisted tax components.');
  const codes = await TaxCodeCollection.create({ db });
  const code = await codes.create({
    code: `purchase-${input.reference}`,
    name: `Purchase ${input.reference}`,
    appliesTo: 'purchases',
    components: [
      { taxComponentId: gst.id, compound: false },
      { taxComponentId: pst.id, compound: false },
    ],
  });
  if (!code.id) throw new Error('Expected persisted purchase tax code.');
  const settings = await TaxSettingsCollection.create({ db });
  const current = await settings.getOrCreateForTenant(tenantId);
  current.defaultPurchaseTaxCodeId = code.id;
  current.defaultLineAmountType = 'exclusive';
  current.taxRoundingScope = 'document';
  await current.save();
  if (current.moneyModel !== 'v2') {
    const migrationId = await settings.beginMoneyMigration(tenantId);
    await settings.activateMoneyV2(tenantId, migrationId);
  }

  const vendors = await VendorCollection.create({ db });
  const vendor = await vendors.create({ id: randomUUID() });
  if (!vendor.id) throw new Error('Expected persisted purchase vendor.');
  const contracts = await ContractCollection.create({ db });
  const contract = await contracts.create({
    _meta_type: 'PurchaseOrder',
    vendorId: vendor.id,
    reference: input.reference,
    currency: 'CAD',
    issueDate: new Date('2026-09-12T00:00:00.000Z'),
  });
  if (!contract.id) throw new Error('Expected persisted purchase contract.');
  const lines = await ContractLineItemCollection.create({ db });
  await lines.create({
    contractId: contract.id,
    description: 'Supplier material',
    quantity: 1,
    unitPrice: 10_000,
    taxMode: 'override',
    taxCodeId: code.id,
  });
  const issued = await contracts.get({ id: contract.id }, { cache: false });
  if (!issued) throw new Error('Expected persisted purchase contract.');
  issued.status = ContractStatus.SENT;
  await issued.save();
  if (input.status === ContractStatus.DECLINED) {
    issued.status = ContractStatus.DECLINED;
    await issued.save();
  } else if (input.status === ContractStatus.CANCELLED) {
    issued.status = ContractStatus.CANCELLED;
    await issued.save();
  }
  return {
    contractId: contract.id,
    vendorId: vendor.id,
    gstId: gst.id,
    pstId: pst.id,
  };
}
