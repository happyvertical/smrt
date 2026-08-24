import { ContractCollection } from '../collections/ContractCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';

interface CommerceForeignKeyFixtures {
  db: { type: 'sqlite'; url: string };
  customerIds?: string[];
  vendorIds?: string[];
  contractIds?: string[];
}

/** Seed only the real same-package parents referenced by a test scenario. */
export async function seedCommerceForeignKeyFixtures({
  db,
  customerIds = [],
  vendorIds = [],
  contractIds = [],
}: CommerceForeignKeyFixtures): Promise<void> {
  const customers = await CustomerCollection.create({ db });
  const vendors = await VendorCollection.create({ db });
  const contracts = await ContractCollection.create({ db });
  const fixtureCustomerId = '__fixture_customer__';
  const fixtureVendorId = '__fixture_vendor__';

  const requiredCustomerIds = contractIds.length
    ? [fixtureCustomerId, ...customerIds]
    : customerIds;
  const requiredVendorIds = contractIds.length
    ? [fixtureVendorId, ...vendorIds]
    : vendorIds;
  for (const id of new Set(requiredCustomerIds)) {
    await customers.create({ id, name: `Fixture ${id}` });
  }
  for (const id of new Set(requiredVendorIds)) {
    await vendors.create({ id, name: `Fixture ${id}` });
  }
  for (const id of new Set(contractIds)) {
    await contracts.create({
      id,
      customerId: fixtureCustomerId,
      vendorId: fixtureVendorId,
      reference: `Fixture ${id}`,
    });
  }
}
