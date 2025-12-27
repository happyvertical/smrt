/**
 * Fulfillment model tests
 *
 * Tests for:
 * 1. Fulfillment CRUD operations
 * 2. Fulfillment status transitions
 * 3. FulfillmentLineItem tracking
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContractCollection } from '../collections/ContractCollection.js';
import { CustomerCollection } from '../collections/CustomerCollection.js';
import { FulfillmentCollection } from '../collections/FulfillmentCollection.js';
import { FulfillmentStatus, FulfillmentType } from '../types/index.js';

describe('Fulfillment', () => {
  let dbPath: string;
  let fulfillments: FulfillmentCollection;
  let contracts: ContractCollection;
  let customers: CustomerCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-fulfillment-test-${Date.now()}.db`);
    fulfillments = await FulfillmentCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    contracts = await ContractCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
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
    it('should create a fulfillment', async () => {
      const customer = await customers.create({ profileId: 'test-profile' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
        totalAmount: 500,
      });
      await contract.save();

      const fulfillment = await fulfillments.create({
        contractId: contract.id,
        fulfillmentType: FulfillmentType.SHIPMENT,
        carrier: 'UPS',
        shippingAddress: {
          street1: '123 Main St',
          city: 'Anytown',
          state: 'CA',
          postalCode: '90210',
          country: 'US',
        },
      });

      expect(fulfillment.id).toBeDefined();
      expect(fulfillment.contractId).toBe(contract.id);
      expect(fulfillment.carrier).toBe('UPS');
      expect(fulfillment.status).toBe(FulfillmentStatus.PENDING);
      expect(fulfillment.shippingAddress.city).toBe('Anytown');
    });

    it('should preserve data through save/load cycle', async () => {
      const customer = await customers.create({ profileId: 'test-profile' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const fulfillment = await fulfillments.create({
        contractId: contract.id,
        fulfillmentType: FulfillmentType.DELIVERY,
        trackingNumber: 'TRACK123456',
        carrier: 'FedEx',
        notes: 'Handle with care',
      });
      await fulfillment.save();

      const loaded = await fulfillments.get({ id: fulfillment.id });
      expect(loaded).toBeDefined();
      expect(loaded?.trackingNumber).toBe('TRACK123456');
      expect(loaded?.carrier).toBe('FedEx');
      expect(loaded?.fulfillmentType).toBe(FulfillmentType.DELIVERY);
      expect(loaded?.notes).toBe('Handle with care');
    });
  });

  describe('Status Transitions', () => {
    it('should check status correctly', async () => {
      const customer = await customers.create({ profileId: 'status-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const fulfillment = await fulfillments.create({
        contractId: contract.id,
        status: FulfillmentStatus.PENDING,
      });

      expect(fulfillment.isPending()).toBe(true);
      expect(fulfillment.isInTransit()).toBe(false);
      expect(fulfillment.isDelivered()).toBe(false);
    });

    it('should mark as shipped', async () => {
      const customer = await customers.create({ profileId: 'ship-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const fulfillment = await fulfillments.create({
        contractId: contract.id,
      });

      fulfillment.markShipped('UPS-123', 'UPS');

      expect(fulfillment.status).toBe(FulfillmentStatus.SHIPPED);
      expect(fulfillment.trackingNumber).toBe('UPS-123');
      expect(fulfillment.carrier).toBe('UPS');
      expect(fulfillment.shippedAt).toBeDefined();
    });

    it('should mark as delivered', async () => {
      const customer = await customers.create({ profileId: 'deliver-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const fulfillment = await fulfillments.create({
        contractId: contract.id,
        status: FulfillmentStatus.SHIPPED,
      });

      fulfillment.markDelivered();

      expect(fulfillment.status).toBe(FulfillmentStatus.DELIVERED);
      expect(fulfillment.deliveredAt).toBeDefined();
    });

    it('should cancel fulfillment', async () => {
      const customer = await customers.create({ profileId: 'cancel-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      const fulfillment = await fulfillments.create({
        contractId: contract.id,
      });

      fulfillment.cancel();

      expect(fulfillment.status).toBe(FulfillmentStatus.CANCELLED);
    });
  });

  describe('Collection Queries', () => {
    it('should find fulfillments by contract', async () => {
      const customer = await customers.create({ profileId: 'contract-query' });
      await customer.save();

      const contract1 = await contracts.create({
        customerId: customer.id,
      });
      await contract1.save();

      const contract2 = await contracts.create({
        customerId: customer.id,
      });
      await contract2.save();

      await (
        await fulfillments.create({
          contractId: contract1.id,
        })
      ).save();
      await (
        await fulfillments.create({
          contractId: contract1.id,
        })
      ).save();
      await (
        await fulfillments.create({
          contractId: contract2.id,
        })
      ).save();

      const c1Fulfillments = await fulfillments.findByContract(contract1.id!);
      expect(c1Fulfillments).toHaveLength(2);
    });

    it('should find pending fulfillments', async () => {
      const customer = await customers.create({ profileId: 'pending-query' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      await (
        await fulfillments.create({
          contractId: contract.id,
          status: FulfillmentStatus.PENDING,
        })
      ).save();
      await (
        await fulfillments.create({
          contractId: contract.id,
          status: FulfillmentStatus.PENDING,
        })
      ).save();
      await (
        await fulfillments.create({
          contractId: contract.id,
          status: FulfillmentStatus.SHIPPED,
        })
      ).save();

      const pending = await fulfillments.findPending();
      expect(pending).toHaveLength(2);
    });

    it('should find in-transit fulfillments', async () => {
      const customer = await customers.create({ profileId: 'transit-query' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      await (
        await fulfillments.create({
          contractId: contract.id,
          status: FulfillmentStatus.SHIPPED,
        })
      ).save();
      await (
        await fulfillments.create({
          contractId: contract.id,
          status: FulfillmentStatus.DELIVERED,
        })
      ).save();

      const inTransit = await fulfillments.findInTransit();
      expect(inTransit).toHaveLength(1);
    });

    it('should find by tracking number', async () => {
      const customer = await customers.create({ profileId: 'tracking-query' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      await (
        await fulfillments.create({
          contractId: contract.id,
          trackingNumber: 'UNIQUE-TRACK-123',
        })
      ).save();

      const found = await fulfillments.findByTracking('UNIQUE-TRACK-123');
      expect(found).toBeDefined();
      expect(found?.trackingNumber).toBe('UNIQUE-TRACK-123');

      const notFound = await fulfillments.findByTracking('NONEXISTENT');
      expect(notFound).toBeNull();
    });
  });

  describe('Fulfillment Types', () => {
    it('should support different fulfillment types', async () => {
      const customer = await customers.create({ profileId: 'types-test' });
      await customer.save();

      const contract = await contracts.create({
        customerId: customer.id,
      });
      await contract.save();

      await (
        await fulfillments.create({
          contractId: contract.id,
          fulfillmentType: FulfillmentType.SHIPMENT,
        })
      ).save();
      await (
        await fulfillments.create({
          contractId: contract.id,
          fulfillmentType: FulfillmentType.DIGITAL,
        })
      ).save();
      await (
        await fulfillments.create({
          contractId: contract.id,
          fulfillmentType: FulfillmentType.SERVICE,
        })
      ).save();

      const shipments = await fulfillments.findByType(FulfillmentType.SHIPMENT);
      const digital = await fulfillments.findByType(FulfillmentType.DIGITAL);
      const service = await fulfillments.findByType(FulfillmentType.SERVICE);

      expect(shipments).toHaveLength(1);
      expect(digital).toHaveLength(1);
      expect(service).toHaveLength(1);
    });
  });
});
