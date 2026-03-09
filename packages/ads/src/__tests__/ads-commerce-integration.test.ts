/**
 * Integration test: ads + commerce collections coexist on same database
 *
 * Verifies that when smrt-ads is installed, the commerce tables (customers,
 * contracts, contract_line_items) are available alongside ads tables.
 * This is the scenario that issue #1000 reported as broken.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContractCollection,
  ContractStatus,
  CustomerCollection,
  CustomerStatus,
} from '@happyvertical/smrt-commerce';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdDeliveryTierCollection,
  AdGroupCollection,
  AdGroupStatus,
  PricingModel,
} from '../index.js';

describe('ads + commerce integration', () => {
  let dbPath: string;
  let customers: CustomerCollection;
  let contracts: ContractCollection;
  let tiers: AdDeliveryTierCollection;
  let groups: AdGroupCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-ads-commerce-integration-${Date.now()}.db`);
    const dbOpts = { db: { type: 'sqlite' as const, url: dbPath } };

    customers = await CustomerCollection.create(dbOpts);
    contracts = await ContractCollection.create(dbOpts);
    tiers = await AdDeliveryTierCollection.create(dbOpts);
    groups = await AdGroupCollection.create(dbOpts);
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it('should create commerce and ads tables on the same database', async () => {
    // Create a customer (commerce table)
    const customer = await customers.create({
      profileId: 'profile-integration-test',
      creditLimit: 5000.0,
      paymentTerms: 'Net 30',
      status: CustomerStatus.ACTIVE,
    });
    await customer.save();
    expect(customer.id).toBeDefined();

    // Create a contract (commerce table)
    const contract = await contracts.create({
      customerId: customer.id!,
      totalAmount: 1500.0,
      status: ContractStatus.ACCEPTED,
    });
    await contract.save();
    expect(contract.id).toBeDefined();

    // Create an ad delivery tier (ads table)
    const tier = await tiers.create({
      name: 'Standard',
      priority: 2,
      pricingModel: PricingModel.CPM,
    });
    await tier.save();
    expect(tier.id).toBeDefined();

    // Create an ad group referencing the commerce contract (cross-package FK)
    const adGroup = await groups.create({
      contractId: contract.id!,
      tierId: tier.id!,
      name: 'Integration Test Campaign',
      status: AdGroupStatus.ACTIVE,
      dailyBudget: 50.0,
      totalBudget: 1500.0,
    });
    await adGroup.save();
    expect(adGroup.id).toBeDefined();
    expect(adGroup.contractId).toBe(contract.id);
  });

  it('should query active customers referenced by ad groups', async () => {
    const customer = await customers.create({
      profileId: 'profile-advertiser',
      creditLimit: 10000.0,
      paymentTerms: 'Net 15',
      status: CustomerStatus.ACTIVE,
    });
    await customer.save();

    const contract = await contracts.create({
      customerId: customer.id!,
      totalAmount: 3000.0,
      status: ContractStatus.ACCEPTED,
    });
    await contract.save();

    const tier = await tiers.create({
      name: 'Sponsorship',
      priority: 1,
      pricingModel: PricingModel.FIXED,
    });
    await tier.save();

    const createdGroup = await groups.create({
      contractId: contract.id!,
      tierId: tier.id!,
      name: 'Sponsor Campaign',
      status: AdGroupStatus.ACTIVE,
    });
    await createdGroup.save();

    // Verify we can look up the customer chain from an ad group
    const allGroups = await groups.list({});
    expect(allGroups.length).toBeGreaterThanOrEqual(1);

    const group = allGroups[0];
    const linkedContract = await contracts.get(group.contractId);
    expect(linkedContract).not.toBeNull();
    expect(linkedContract?.customerId).toBe(customer.id);

    const linkedCustomer = await customers.get(linkedContract?.customerId);
    expect(linkedCustomer).toBeDefined();
    expect(linkedCustomer?.isActive()).toBe(true);
  });
});
