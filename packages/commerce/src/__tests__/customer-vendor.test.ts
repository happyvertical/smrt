/**
 * Customer and Vendor model tests
 *
 * Tests for:
 * 1. Customer CRUD operations
 * 2. Vendor CRUD operations
 * 3. Profile linking
 * 4. One Profile can have both Customer and Vendor
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import { CustomerStatus, VendorStatus } from '../types/index.js';

describe('Customer', () => {
  let dbPath: string;
  let customers: CustomerCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-customer-test-${Date.now()}.db`);
    customers = await CustomerCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
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

  describe('Basic CRUD Operations', () => {
    it('should create a customer', async () => {
      const customer = await customers.create({
        profileId: 'profile-123',
        creditLimit: 10000,
        paymentTerms: 'Net 30',
      });

      expect(customer.id).toBeDefined();
      expect(customer.profileId).toBe('profile-123');
      expect(customer.creditLimit).toBe(10000);
      expect(customer.paymentTerms).toBe('Net 30');
      expect(customer.status).toBe(CustomerStatus.ACTIVE);
    });

    it('should preserve data through save/load cycle', async () => {
      const customer = await customers.create({
        profileId: 'profile-456',
        creditLimit: 5000,
        paymentTerms: '2/10 Net 30',
        taxExempt: true,
        taxId: 'EIN-12345',
      });
      await customer.save();

      const loaded = await customers.get({ id: customer.id });
      expect(loaded).toBeDefined();
      expect(loaded?.profileId).toBe('profile-456');
      expect(loaded?.creditLimit).toBe(5000);
      expect(loaded?.paymentTerms).toBe('2/10 Net 30');
      expect(loaded?.taxExempt).toBe(true);
      expect(loaded?.taxId).toBe('EIN-12345');
    });

    it('should update customer fields', async () => {
      const customer = await customers.create({
        profileId: 'profile-789',
        creditLimit: 1000,
      });
      await customer.save();

      customer.creditLimit = 5000;
      customer.paymentTerms = 'Net 60';
      await customer.save();

      const loaded = await customers.get({ id: customer.id });
      expect(loaded?.creditLimit).toBe(5000);
      expect(loaded?.paymentTerms).toBe('Net 60');
    });

    it('should delete a customer', async () => {
      const customer = await customers.create({
        profileId: 'profile-delete',
      });
      await customer.save();

      await customer.delete();

      const loaded = await customers.get({ id: customer.id });
      expect(loaded).toBeNull();
    });
  });

  describe('Status Management', () => {
    it('should check if customer is active', async () => {
      const active = await customers.create({
        profileId: 'active-profile',
        status: CustomerStatus.ACTIVE,
      });
      const suspended = await customers.create({
        profileId: 'suspended-profile',
        status: CustomerStatus.SUSPENDED,
      });

      expect(active.isActive()).toBe(true);
      expect(suspended.isActive()).toBe(false);
    });

    it('should find customers by status', async () => {
      await (
        await customers.create({
          profileId: 'p1',
          status: CustomerStatus.ACTIVE,
        })
      ).save();
      await (
        await customers.create({
          profileId: 'p2',
          status: CustomerStatus.ACTIVE,
        })
      ).save();
      await (
        await customers.create({
          profileId: 'p3',
          status: CustomerStatus.SUSPENDED,
        })
      ).save();

      const active = await customers.findActive();
      expect(active).toHaveLength(2);

      const suspended = await customers.findByStatus(CustomerStatus.SUSPENDED);
      expect(suspended).toHaveLength(1);
    });
  });

  describe('Credit Management', () => {
    it('should check available credit', async () => {
      const customer = await customers.create({
        profileId: 'credit-test',
        creditLimit: 1000,
      });

      expect(customer.hasAvailableCredit(500)).toBe(true);
      expect(customer.hasAvailableCredit(1000)).toBe(true);
      expect(customer.hasAvailableCredit(1001)).toBe(false);
    });
  });

  describe('Collection Queries', () => {
    it('should find customers by profile', async () => {
      await (
        await customers.create({
          profileId: 'shared-profile',
        })
      ).save();
      await (
        await customers.create({
          profileId: 'other-profile',
        })
      ).save();

      const found = await customers.findByProfile('shared-profile');
      expect(found).toHaveLength(1);
      expect(found[0].profileId).toBe('shared-profile');
    });

    it('should get or create for profile', async () => {
      // First call creates
      const created = await customers.getOrCreateForProfile('new-profile', {
        creditLimit: 5000,
        paymentTerms: 'Net 30',
      });
      expect(created.creditLimit).toBe(5000);

      // Second call returns existing
      const existing = await customers.getOrCreateForProfile('new-profile', {
        creditLimit: 10000,
      });
      expect(existing.id).toBe(created.id);
      expect(existing.creditLimit).toBe(5000); // Original preserved
    });
  });
});

describe('Vendor', () => {
  let dbPath: string;
  let vendors: VendorCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-vendor-test-${Date.now()}.db`);
    vendors = await VendorCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
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

  describe('Basic CRUD Operations', () => {
    it('should create a vendor', async () => {
      const vendor = await vendors.create({
        profileId: 'vendor-profile-123',
        leadTimeDays: 14,
        minimumOrderAmount: 500,
        paymentTerms: 'Net 60',
      });

      expect(vendor.id).toBeDefined();
      expect(vendor.profileId).toBe('vendor-profile-123');
      expect(vendor.leadTimeDays).toBe(14);
      expect(vendor.minimumOrderAmount).toBe(500);
      expect(vendor.paymentTerms).toBe('Net 60');
      expect(vendor.status).toBe(VendorStatus.ACTIVE);
    });

    it('should preserve data through save/load cycle', async () => {
      const vendor = await vendors.create({
        profileId: 'vendor-456',
        leadTimeDays: 7,
        minimumOrderAmount: 1000,
        currency: 'EUR',
        defaultContactEmail: 'orders@vendor.com',
      });
      await vendor.save();

      const loaded = await vendors.get({ id: vendor.id });
      expect(loaded).toBeDefined();
      expect(loaded?.leadTimeDays).toBe(7);
      expect(loaded?.minimumOrderAmount).toBe(1000);
      expect(loaded?.currency).toBe('EUR');
      expect(loaded?.defaultContactEmail).toBe('orders@vendor.com');
    });
  });

  describe('Order Requirements', () => {
    it('should check minimum order amount', async () => {
      const vendor = await vendors.create({
        profileId: 'min-order-test',
        minimumOrderAmount: 500,
      });

      expect(vendor.meetsMinimumOrder(600)).toBe(true);
      expect(vendor.meetsMinimumOrder(500)).toBe(true);
      expect(vendor.meetsMinimumOrder(499)).toBe(false);
    });
  });
});

describe('Customer and Vendor - Same Profile', () => {
  let dbPath: string;
  let customers: CustomerCollection;
  let vendors: VendorCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-both-test-${Date.now()}.db`);
    customers = await CustomerCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    vendors = await VendorCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
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

  it('should allow one profile to have both customer and vendor records', async () => {
    const sharedProfileId = 'company-abc-profile';

    // Create as customer
    const customer = await customers.create({
      profileId: sharedProfileId,
      creditLimit: 10000,
      paymentTerms: 'Net 30',
    });
    await customer.save();

    // Create as vendor (same profile!)
    const vendor = await vendors.create({
      profileId: sharedProfileId,
      leadTimeDays: 21,
      minimumOrderAmount: 1000,
      paymentTerms: 'Net 60',
    });
    await vendor.save();

    // Both should exist
    const foundCustomers = await customers.findByProfile(sharedProfileId);
    const foundVendors = await vendors.findByProfile(sharedProfileId);

    expect(foundCustomers).toHaveLength(1);
    expect(foundVendors).toHaveLength(1);

    // They are different records with different IDs
    expect(foundCustomers[0].id).not.toBe(foundVendors[0].id);

    // But linked to the same profile
    expect(foundCustomers[0].profileId).toBe(sharedProfileId);
    expect(foundVendors[0].profileId).toBe(sharedProfileId);

    // With their own specific data
    expect(foundCustomers[0].creditLimit).toBe(10000);
    expect(foundVendors[0].leadTimeDays).toBe(21);
  });
});
