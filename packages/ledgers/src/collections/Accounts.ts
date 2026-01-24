/**
 * AccountCollection - Collection manager for Account objects
 *
 * Provides querying and tree operations for chart of accounts.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Account } from '../models/Account';
import type { AccountTree, AccountTreeNode, AccountType } from '../types';

export class AccountCollection extends SmrtCollection<Account> {
  static readonly _itemClass = Account;

  /**
   * Find account by number
   *
   * @param number - Account number
   * @returns Account or null
   */
  async findByNumber(number: string): Promise<Account | null> {
    const accounts = await this.list({
      where: { number },
      limit: 1,
    });
    return accounts[0] || null;
  }

  /**
   * Find accounts by type
   *
   * @param type - Account type
   * @returns Array of accounts
   */
  async findByType(type: AccountType): Promise<Account[]> {
    return await this.list({
      where: { type },
      orderBy: 'number ASC',
    });
  }

  /**
   * Find all active accounts
   *
   * @returns Array of active accounts
   */
  async findActive(): Promise<Account[]> {
    return await this.list({
      where: { active: true },
      orderBy: 'number ASC',
    });
  }

  /**
   * Find top-level accounts (no parent)
   *
   * @returns Array of top-level accounts
   */
  async findTopLevel(): Promise<Account[]> {
    return await this.list({
      where: { parentId: null },
      orderBy: 'number ASC',
    });
  }

  /**
   * Find direct children of an account
   *
   * @param parentId - Parent account ID
   * @returns Array of child accounts
   */
  async findChildren(parentId: string): Promise<Account[]> {
    return await this.list({
      where: { parentId },
      orderBy: 'number ASC',
    });
  }

  /**
   * Get the complete account tree
   *
   * @returns AccountTree structure
   */
  async getTree(): Promise<AccountTree> {
    const allAccounts = await this.list({
      orderBy: 'number ASC',
    });

    const accountMap = new Map<string, Account>();
    const childrenMap = new Map<string, Account[]>();

    // Build lookup maps
    for (const account of allAccounts) {
      if (account.id) {
        accountMap.set(account.id, account);
      }
      if (!childrenMap.has(account.parentId || '')) {
        childrenMap.set(account.parentId || '', []);
      }
      childrenMap.get(account.parentId || '')?.push(account);
    }

    // Build tree nodes recursively
    const buildNode = (account: Account): AccountTreeNode => {
      const children = (account.id ? childrenMap.get(account.id) : []) || [];
      return {
        account,
        children: children.map(buildNode),
      };
    };

    // Get root nodes (no parent)
    const roots = childrenMap.get('') || [];

    return {
      roots: roots.map(buildNode),
    };
  }

  /**
   * Get or create an account by number
   *
   * @param number - Account number
   * @param defaults - Default values if creating
   * @returns Account
   */
  async getOrCreateByNumber(
    number: string,
    defaults: Partial<{
      name: string;
      description: string;
      type: AccountType;
      parentId: string | null;
    }> = {},
  ): Promise<Account> {
    const existing = await this.findByNumber(number);
    if (existing) {
      return existing;
    }

    const account = await this.create({
      number,
      name: defaults.name || number,
      description: defaults.description || '',
      type: defaults.type || 'asset',
      parentId: defaults.parentId || null,
    });
    await account.save();
    return account;
  }

  /**
   * Find accounts grouped by type
   *
   * @returns Record of type to accounts array
   */
  async groupByType(): Promise<Record<AccountType, Account[]>> {
    const accounts = await this.findActive();
    const grouped: Record<AccountType, Account[]> = {
      asset: [],
      liability: [],
      equity: [],
      revenue: [],
      expense: [],
    };

    for (const account of accounts) {
      grouped[account.type].push(account);
    }

    return grouped;
  }

  /**
   * Get all descendants of an account recursively
   *
   * @param accountId - Account ID
   * @returns Array of all descendant accounts
   */
  async getDescendants(accountId: string): Promise<Account[]> {
    const descendants: Account[] = [];
    const queue: string[] = [accountId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (!currentId) continue;

      const children = await this.findChildren(currentId);

      for (const child of children) {
        descendants.push(child);
        if (child.id) {
          queue.push(child.id);
        }
      }
    }

    return descendants;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find all accounts belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant's accounts
   */
  async findByTenant(tenantId: string): Promise<Account[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global accounts (no tenant association)
   *
   * @returns Array of global accounts
   */
  async findGlobal(): Promise<Account[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find accounts for a tenant plus all global accounts
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant's accounts and global accounts
   */
  async findWithGlobals(tenantId: string): Promise<Account[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
