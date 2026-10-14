import { CustomerCollection } from '../collections/CustomerCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import { Order } from '../models/Contract.js';

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
  const fixtureCustomerId = '__fixture_customer__';

  const requiredCustomerIds = contractIds.length
    ? [fixtureCustomerId, ...customerIds]
    : customerIds;
  for (const id of new Set(requiredCustomerIds)) {
    await customers.create({ id, name: `Fixture ${id}` });
  }
  for (const id of new Set(vendorIds)) {
    await vendors.create({ id, name: `Fixture ${id}` });
  }
  for (const id of new Set(contractIds)) {
    const order = new Order({
      db,
      id,
      customerId: fixtureCustomerId,
      reference: `Fixture ${id}`,
    });
    await order.initialize();
    await order.save();
  }
}
