/**
 * Account model tests
 *
 * Tests for:
 * 1. Account CRUD operations
 * 2. Account hierarchy
 * 3. Account type behavior
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountCollection } from '../collections/Accounts';

describe('Account', () => {
  let dbPath: string;
  let accounts: AccountCollection;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-account-test-${Date.now()}.db`);
    accounts = await AccountCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(async () => {
    const databases: DatabaseInterface[] = [];

    if (accounts) {
      databases.push(accounts.db);
    }

    for (const db of databases) {
      if (typeof db.close === 'function') {
        try {
          await db.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('Basic CRUD Operations', () => {
    it('should create an account', async () => {
      const account = await accounts.create({
        number: '1000',
        name: 'Cash',
        type: 'asset',
      });

      expect(account.id).toBeDefined();
      expect(account.number).toBe('1000');
      expect(account.name).toBe('Cash');
      expect(account.type).toBe('asset');
      expect(account.active).toBe(true);
    });

    it('should preserve data through save/load cycle', async () => {
      const account = await accounts.create({
        number: '5010',
        name: 'Office Supplies',
        description: 'Office supplies expense',
        type: 'expense',
      });
      await account.save();

      const loaded = await accounts.get({ id: account.id });
      expect(loaded).toBeDefined();
      expect(loaded?.number).toBe('5010');
      expect(loaded?.name).toBe('Office Supplies');
      expect(loaded?.description).toBe('Office supplies expense');
      expect(loaded?.type).toBe('expense');
    });

    it('should update account fields', async () => {
      const account = await accounts.create({
        number: '1000',
        name: 'Original',
      });
      await account.save();

      account.name = 'Updated';
      account.active = false;
      await account.save();

      const loaded = await accounts.get({ id: account.id });
      expect(loaded?.name).toBe('Updated');
      expect(loaded?.active).toBe(false);
    });

    it('should delete an account', async () => {
      const account = await accounts.create({
        number: '9999',
        name: 'Deletable',
      });
      await account.save();

      await account.delete();

      const loaded = await accounts.get({ id: account.id });
      expect(loaded).toBeNull();
    });
  });

  describe('Account Types', () => {
    it('should identify debit-normal accounts', async () => {
      const asset = await accounts.create({
        number: '1000',
        name: 'Cash',
        type: 'asset',
      });
      const expense = await accounts.create({
        number: '5000',
        name: 'Rent',
        type: 'expense',
      });

      expect(asset.isDebitNormal()).toBe(true);
      expect(asset.isCreditNormal()).toBe(false);
      expect(expense.isDebitNormal()).toBe(true);
      expect(expense.isCreditNormal()).toBe(false);
    });

    it('should identify credit-normal accounts', async () => {
      const liability = await accounts.create({
        number: '2000',
        name: 'Accounts Payable',
        type: 'liability',
      });
      const equity = await accounts.create({
        number: '3000',
        name: 'Owner Equity',
        type: 'equity',
      });
      const revenue = await accounts.create({
        number: '4000',
        name: 'Sales',
        type: 'revenue',
      });

      expect(liability.isCreditNormal()).toBe(true);
      expect(equity.isCreditNormal()).toBe(true);
      expect(revenue.isCreditNormal()).toBe(true);
    });

    it('should find accounts by type', async () => {
      await (
        await accounts.create({ number: '1000', name: 'Cash', type: 'asset' })
      ).save();
      await (
        await accounts.create({ number: '1100', name: 'Bank', type: 'asset' })
      ).save();
      await (
        await accounts.create({
          number: '2000',
          name: 'AP',
          type: 'liability',
        })
      ).save();

      const assets = await accounts.findByType('asset');
      expect(assets).toHaveLength(2);
      expect(assets.map((a) => a.number).sort()).toEqual(['1000', '1100']);
    });
  });

  describe('Account Hierarchy', () => {
    it('should create hierarchical accounts', async () => {
      const parent = await accounts.create({
        number: '1000',
        name: 'Current Assets',
        type: 'asset',
      });
      await parent.save();

      const child = await accounts.create({
        number: '1010',
        name: 'Cash',
        type: 'asset',
        parentId: parent.id,
      });
      await child.save();

      expect(child.parentId).toBe(parent.id);
      expect(parent.isTopLevel()).toBe(true);
      expect(child.isTopLevel()).toBe(false);
    });

    it('should find top-level accounts', async () => {
      const parent1 = await accounts.create({
        number: '1000',
        name: 'Assets',
        type: 'asset',
      });
      await parent1.save();

      const parent2 = await accounts.create({
        number: '2000',
        name: 'Liabilities',
        type: 'liability',
      });
      await parent2.save();

      const child = await accounts.create({
        number: '1010',
        name: 'Cash',
        type: 'asset',
        parentId: parent1.id,
      });
      await child.save();

      const topLevel = await accounts.findTopLevel();
      expect(topLevel).toHaveLength(2);
    });

    it('should find children of an account', async () => {
      const parent = await accounts.create({
        number: '1000',
        name: 'Assets',
        type: 'asset',
      });
      await parent.save();

      await (
        await accounts.create({
          number: '1010',
          name: 'Cash',
          parentId: parent.id,
          type: 'asset',
        })
      ).save();
      await (
        await accounts.create({
          number: '1020',
          name: 'Bank',
          parentId: parent.id,
          type: 'asset',
        })
      ).save();

      const children = await accounts.findChildren(parent.id!);
      expect(children).toHaveLength(2);
      expect(children.map((c) => c.name).sort()).toEqual(['Bank', 'Cash']);
    });

    it('should get full path from root', async () => {
      const assets = await accounts.create({
        number: '1000',
        name: 'Assets',
        type: 'asset',
      });
      await assets.save();

      const current = await accounts.create({
        number: '1100',
        name: 'Current Assets',
        type: 'asset',
        parentId: assets.id,
      });
      await current.save();

      const cash = await accounts.create({
        number: '1110',
        name: 'Cash',
        type: 'asset',
        parentId: current.id,
      });
      await cash.save();

      const fullPath = await cash.getFullPath();
      expect(fullPath).toBe('Assets > Current Assets > Cash');
    });
  });

  describe('Collection Queries', () => {
    it('should find account by number', async () => {
      await (
        await accounts.create({
          number: '1000',
          name: 'Cash',
          type: 'asset',
        })
      ).save();

      const found = await accounts.findByNumber('1000');
      expect(found).toBeDefined();
      expect(found?.name).toBe('Cash');

      const notFound = await accounts.findByNumber('9999');
      expect(notFound).toBeNull();
    });

    it('should get or create by number', async () => {
      // First call creates
      const created = await accounts.getOrCreateByNumber('1000', {
        name: 'Cash',
        type: 'asset',
      });
      expect(created.name).toBe('Cash');

      // Second call returns existing
      const existing = await accounts.getOrCreateByNumber('1000', {
        name: 'Different Name',
        type: 'liability',
      });
      expect(existing.id).toBe(created.id);
      expect(existing.name).toBe('Cash'); // Original name preserved
    });

    it('should group accounts by type', async () => {
      await (
        await accounts.create({
          number: '1000',
          name: 'Cash',
          type: 'asset',
        })
      ).save();
      await (
        await accounts.create({
          number: '2000',
          name: 'AP',
          type: 'liability',
        })
      ).save();
      await (
        await accounts.create({
          number: '4000',
          name: 'Sales',
          type: 'revenue',
        })
      ).save();

      const grouped = await accounts.groupByType();

      expect(grouped.asset).toHaveLength(1);
      expect(grouped.liability).toHaveLength(1);
      expect(grouped.revenue).toHaveLength(1);
      expect(grouped.expense).toHaveLength(0);
      expect(grouped.equity).toHaveLength(0);
    });
  });

  describe('Account Tree', () => {
    it('should build account tree', async () => {
      const assets = await accounts.create({
        number: '1000',
        name: 'Assets',
        type: 'asset',
      });
      await assets.save();

      const cash = await accounts.create({
        number: '1010',
        name: 'Cash',
        type: 'asset',
        parentId: assets.id,
      });
      await cash.save();

      const bank = await accounts.create({
        number: '1020',
        name: 'Bank',
        type: 'asset',
        parentId: assets.id,
      });
      await bank.save();

      const tree = await accounts.getTree();

      expect(tree.roots).toHaveLength(1);
      expect(tree.roots[0].account.name).toBe('Assets');
      expect(tree.roots[0].children).toHaveLength(2);
    });
  });

  describe('Metadata', () => {
    it('should store and retrieve metadata', async () => {
      const account = await accounts.create({
        number: '1000',
        name: 'Cash',
        type: 'asset',
        metadata: {
          bankName: 'First National',
          routingNumber: '123456789',
        },
      });
      await account.save();

      const loaded = await accounts.get({ id: account.id });
      expect(loaded?.metadata.bankName).toBe('First National');
      expect(loaded?.metadata.routingNumber).toBe('123456789');
    });
  });
});
