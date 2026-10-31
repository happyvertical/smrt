/**
 * Contract model tests
 *
 * Tests for:
 * 1. Contract CRUD operations
 * 2. STI (Single Table Inheritance) with contract types
 * 3. Contract lifecycle
 * 4. ContractLineItem operations
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { getTestManifestPath } from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { VendorCollection } from '../collections/VendorCollection.js';
import { Order, PurchaseOrder } from '../models/Contract.js';
import { ContractLineItem } from '../models/ContractLineItem.js';
import { ContractStatus, ContractType } from '../types/index.js';
import { seedV2Tenant, tenantIt, V2_TENANT } from './helpers/v2-tenant.js';

const it = tenantIt();

describe('Contract', () => {
  let dbPath: string;
  let contracts: ContractCollection;
  let customers: CustomerCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-contract-test-${Date.now()}.db`);
    contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    customers = await CustomerCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    const vendors = await VendorCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    await vendors.create({ id: 'vendor-header', name: 'Header vendor' });
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

  describe('Purchase order delivery header', () => {
    it('exposes delivery fields as subtype metadata without widening the base schema', () => {
      const manifest = JSON.parse(readFileSync(getTestManifestPath(), 'utf8'));
      const fields =
        manifest.objects['@happyvertical/smrt-commerce:PurchaseOrder'].fields;
      expect(fields.expectedDate).toMatchObject({
        type: 'meta',
        default: '',
        description: expect.stringContaining('YYYY-MM-DD'),
        _meta: { underlyingType: 'text' },
      });
      expect(fields.shipTo).toMatchObject({
        type: 'meta',
        default: '',
        description: expect.stringContaining('delivered'),
        _meta: { underlyingType: 'text' },
      });
      expect(
        manifest.objects['@happyvertical/smrt-commerce:Contract'].fields
          .expectedDate,
      ).toBeUndefined();
    });

    it('defaults missing header metadata to empty strings', () => {
      const order = new PurchaseOrder();
      expect(order.expectedDate).toBe('');
      expect(order.shipTo).toBe('');
    });

    it('round-trips the header without changing contract financial fields', async () => {
      const order = await contracts.create({
        _meta_type: 'PurchaseOrder',
        vendorId: 'vendor-header',
        expectedDate: '2026-11-02',
        shipTo: 'Dock 2\nEdmonton',
        reference: 'PO-7',
        notes: 'Call first',
      });
      await order.save();
      const loaded = (await contracts.get({ id: order.id })) as PurchaseOrder;
      expect(loaded.expectedDate).toBe('2026-11-02');
      expect(loaded.shipTo).toBe('Dock 2\nEdmonton');
      expect(loaded.reference).toBe('PO-7');
      expect(loaded.notes).toBe('Call first');
      // Header totals are derived from lines (#4021); a header-only edit
      // leaves them where they were.
      const totals = {
        subtotal: loaded.subtotal,
        taxAmount: loaded.taxAmount,
        totalAmount: loaded.totalAmount,
      };
      loaded.expectedDate = '';
      loaded.shipTo = '';
      await loaded.save();
      const cleared = (await contracts.get({ id: order.id })) as PurchaseOrder;
      expect(cleared.expectedDate).toBe('');
      expect(cleared.shipTo).toBe('');
      expect(cleared).toMatchObject(totals);
    });
  });

  describe('Basic CRUD Operations', () => {
    it('should create a contract', async () => {
      const customer = await customers.create({ profileId: 'test-profile' });
      await customer.save();

      const contract = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        currency: 'USD',
      });

      expect(contract.id).toBeDefined();
      expect(contract.customerId).toBe(customer.id);
      expect(contract.currency).toBe('USD');
      expect(contract.status).toBe(ContractStatus.DRAFT);
    });

    it('should preserve data through save/load cycle', async () => {
      const customer = await customers.create({ profileId: 'test-profile' });
      await customer.save();

      const contract = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        subtotal: 1000.0,
        taxAmount: 80.0,
        totalAmount: 1080.0,
        reference: 'INV-2024-001',
        notes: 'Test order',
      });
      await contract.save();

      const loaded = await contracts.get({ id: contract.id });
      expect(loaded).toBeDefined();
      // Caller-supplied header totals are ignored: a draft with no lines
      // totals zero (#4021).
      expect(loaded?.subtotal).toBe(0);
      expect(loaded?.taxAmount).toBe(0);
      expect(loaded?.totalAmount).toBe(0);
      expect(loaded?.reference).toBe('INV-2024-001');
      expect(loaded?.notes).toBe('Test order');
    });
  });

  describe('STI - Single Table Inheritance', () => {
    it('should create different contract types', async () => {
      const customer = await customers.create({ profileId: 'sti-test' });
      await customer.save();

      // Create an estimate
      const estimate = await contracts.create({
        _meta_type: 'Estimate',
        customerId: customer.id,
        totalAmount: 5000.0,
      });
      await estimate.save();

      // Create an order
      const order = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        totalAmount: 4500.0,
      });
      await order.save();

      // Verify types
      expect(estimate.contractType).toBe(ContractType.ESTIMATE);
      expect(order.contractType).toBe(ContractType.ORDER);
    });

    it('should find contracts by type', async () => {
      const customer = await customers.create({ profileId: 'type-test' });
      await customer.save();

      await (
        await contracts.create({
          _meta_type: 'Order',
          customerId: customer.id,
          contractType: ContractType.ESTIMATE,
          totalAmount: 1000,
        })
      ).save();
      await (
        await contracts.create({
          _meta_type: 'Order',
          customerId: customer.id,
          contractType: ContractType.ORDER,
          totalAmount: 2000,
        })
      ).save();
      await (
        await contracts.create({
          _meta_type: 'Order',
          customerId: customer.id,
          contractType: ContractType.ORDER,
          totalAmount: 3000,
        })
      ).save();

      const estimates = await contracts.findByType(ContractType.ESTIMATE);
      const orders = await contracts.findByType(ContractType.ORDER);

      expect(estimates).toHaveLength(1);
      expect(orders).toHaveLength(2);
    });
  });

  describe('Contract Lifecycle', () => {
    it('should track status correctly', async () => {
      const customer = await customers.create({ profileId: 'lifecycle-test' });
      await customer.save();

      const contract = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        status: ContractStatus.DRAFT,
      });

      expect(contract.isDraft()).toBe(true);
      expect(contract.isAccepted()).toBe(false);
      expect(contract.isCompleted()).toBe(false);

      contract.status = ContractStatus.ACCEPTED;
      expect(contract.isDraft()).toBe(false);
      expect(contract.isAccepted()).toBe(true);

      contract.status = ContractStatus.COMPLETED;
      expect(contract.isCompleted()).toBe(true);
    });

    it('should detect overdue contracts', async () => {
      const customer = await customers.create({ profileId: 'overdue-test' });
      await customer.save();

      const pastDue = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        status: ContractStatus.ACCEPTED,
        dueDate: new Date(Date.now() - 86400000), // Yesterday
      });

      const notDue = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        status: ContractStatus.ACCEPTED,
        dueDate: new Date(Date.now() + 86400000), // Tomorrow
      });

      const completed = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        status: ContractStatus.COMPLETED,
        dueDate: new Date(Date.now() - 86400000), // Past but completed
      });

      expect(pastDue.isOverdue()).toBe(true);
      expect(notDue.isOverdue()).toBe(false);
      expect(completed.isOverdue()).toBe(false);
    });

    it('should detect expired estimates', async () => {
      const customer = await customers.create({ profileId: 'expiry-test' });
      await customer.save();

      const expired = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        contractType: ContractType.ESTIMATE,
        expiryDate: new Date(Date.now() - 86400000), // Yesterday
      });

      const valid = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        contractType: ContractType.ESTIMATE,
        expiryDate: new Date(Date.now() + 86400000), // Tomorrow
      });

      expect(expired.isExpired()).toBe(true);
      expect(valid.isExpired()).toBe(false);
    });
  });

  describe('Collection Queries', () => {
    it('should find contracts by customer', async () => {
      const customer1 = await customers.create({ profileId: 'c1' });
      await customer1.save();
      const customer2 = await customers.create({ profileId: 'c2' });
      await customer2.save();

      const first = new Order({
        db: contracts.db,
        customerId: customer1.id,
        totalAmount: 100,
      });
      await first.initialize();
      await first.save();
      const second = new Order({
        db: contracts.db,
        customerId: customer1.id,
        totalAmount: 200,
      });
      await second.initialize();
      await second.save();
      const third = new Order({
        db: contracts.db,
        customerId: customer2.id,
        totalAmount: 300,
      });
      await third.initialize();
      await third.save();

      if (!customer1.id || !customer2.id)
        throw new Error('Expected saved customers');

      const c1Contracts = await contracts.findByCustomer(customer1.id);
      expect(c1Contracts).toHaveLength(2);

      const c2Contracts = await contracts.findByCustomer(customer2.id);
      expect(c2Contracts).toHaveLength(1);
    });

    it('should find drafts', async () => {
      const customer = await customers.create({ profileId: 'draft-test' });
      await customer.save();

      await (
        await contracts.create({
          _meta_type: 'Order',
          customerId: customer.id,
          status: ContractStatus.DRAFT,
        })
      ).save();
      await (
        await contracts.create({
          _meta_type: 'Order',
          customerId: customer.id,
          status: ContractStatus.DRAFT,
        })
      ).save();
      await (
        await contracts.create({
          _meta_type: 'Order',
          customerId: customer.id,
          status: ContractStatus.ACCEPTED,
        })
      ).save();

      const drafts = await contracts.findDrafts();
      expect(drafts).toHaveLength(2);
    });
  });
});

describe('ContractLineItem', () => {
  let dbPath: string;
  let contracts: ContractCollection;
  let customers: CustomerCollection;

  // Create a collection class for line items
  class ContractLineItemCollection extends SmrtCollection<ContractLineItem> {
    static readonly _itemClass = ContractLineItem;
  }

  let lineItems: ContractLineItemCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-lineitem-test-${Date.now()}.db`);
    contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    customers = await CustomerCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    lineItems = await ContractLineItemCollection.create({
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

  describe('Line Item Calculations', () => {
    it('derives line tax from the tenant default code and recomputes the contract', async () => {
      await seedV2Tenant(contracts.db, V2_TENANT, { percent: '8' });
      const customer = await customers.create({ profileId: 'calc-test' });
      await customer.save();

      const contract = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
      });
      await contract.save();

      const item = await lineItems.create({
        contractId: contract.id,
        description: 'Widget Pro',
        quantity: 10,
        unitPrice: 4999, // $49.99 in cents
        discount: 1000, // $10.00 in cents
        discountType: 'amount',
      });
      await item.save();

      // Exclusive line amount: 10 * 4999 - 1000 = 48990 net; 8% tax is
      // 3919.2, rounded to a whole minor unit.
      const loaded = await lineItems.get({ id: item.id });
      expect(loaded?.amount).toBe(48990);
      expect(loaded?.taxAmount).toBe(3919);
      const header = await contracts.get({ id: contract.id });
      expect(header).toMatchObject({
        subtotal: 48990,
        taxAmount: 3919,
        totalAmount: 52909,
      });
    });

    it('ignores a caller-supplied line amount and recomputes it on save', async () => {
      await seedV2Tenant(contracts.db, V2_TENANT, { percent: '10' });
      const customer = await customers.create({ profileId: 'autocalc-test' });
      await customer.save();

      const contract = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
      });
      await contract.save();

      const item = await lineItems.create({
        contractId: contract.id,
        quantity: 5,
        unitPrice: 10000, // $100.00 in cents
        amount: 1,
      });
      await item.save();

      const loaded = await lineItems.get({ id: item.id });
      expect(loaded?.amount).toBe(50000);
      expect(loaded?.taxAmount).toBe(5000);
      expect((await contracts.get({ id: contract.id }))?.totalAmount).toBe(
        55000,
      );
    });
  });

  describe('Subscription Items', () => {
    it('should identify recurring items', async () => {
      const customer = await customers.create({ profileId: 'sub-test' });
      await customer.save();

      const contract = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
        contractType: ContractType.LEASE,
      });
      await contract.save();

      const recurring = await lineItems.create({
        contractId: contract.id,
        description: 'Monthly subscription',
        billingPeriod: 'monthly',
        startDate: new Date(),
      });

      const oneTime = await lineItems.create({
        contractId: contract.id,
        description: 'Setup fee',
      });

      expect(recurring.isRecurring()).toBe(true);
      expect(oneTime.isRecurring()).toBe(false);
    });

    it('should check subscription active status', async () => {
      const customer = await customers.create({ profileId: 'active-sub' });
      await customer.save();

      const contract = await contracts.create({
        _meta_type: 'Order',
        customerId: customer.id,
      });
      await contract.save();

      const active = await lineItems.create({
        contractId: contract.id,
        billingPeriod: 'monthly',
        startDate: new Date(Date.now() - 86400000), // Started yesterday
        endDate: new Date(Date.now() + 86400000 * 30), // Ends in 30 days
      });

      const notStarted = await lineItems.create({
        contractId: contract.id,
        billingPeriod: 'monthly',
        startDate: new Date(Date.now() + 86400000), // Starts tomorrow
      });

      const ended = await lineItems.create({
        contractId: contract.id,
        billingPeriod: 'monthly',
        startDate: new Date(Date.now() - 86400000 * 60),
        endDate: new Date(Date.now() - 86400000), // Ended yesterday
      });

      expect(active.isSubscriptionActive()).toBe(true);
      expect(notStarted.isSubscriptionActive()).toBe(false);
      expect(ended.isSubscriptionActive()).toBe(false);
    });
  });
});
