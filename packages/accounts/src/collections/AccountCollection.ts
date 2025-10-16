/**
 * AccountCollection - Collection manager for Account objects
 *
 * Provides account hierarchy traversal, filtering by type and currency.
 */

import { SmrtCollection } from '@smrt/core';
import { Account } from '../models/Account';
import type { AccountType, CurrencyCode } from '../types';

export class AccountCollection extends SmrtCollection<Account> {
  static readonly _itemClass = Account;

  /**
   * Get accounts by type
   *
   * @param type - Account type (asset, liability, equity, revenue, expense)
   * @returns Array of Account instances
   */
  async getByType(type: AccountType): Promise<Account[]> {
    return await this.list({ where: { type } });
  }

  /**
   * Get accounts by currency
   *
   * @param currency - ISO 4217 currency code
   * @returns Array of Account instances
   */
  async getByCurrency(currency: CurrencyCode): Promise<Account[]> {
    return await this.list({ where: { currency } });
  }

  /**
   * Get root accounts (accounts with no parent)
   *
   * @returns Array of root Account instances
   */
  async getRootAccounts(): Promise<Account[]> {
    const allAccounts = await this.list({});
    return allAccounts.filter((account) => !account.parentId);
  }

  /**
   * Get child accounts of a parent
   *
   * @param parentId - Parent account ID
   * @returns Array of child Account instances
   */
  async getChildren(parentId: string): Promise<Account[]> {
    return await this.list({ where: { parentId } });
  }

  /**
   * Get all accounts of a specific type and currency
   *
   * @param type - Account type
   * @param currency - Currency code
   * @returns Array of Account instances
   */
  async getByTypeAndCurrency(
    type: AccountType,
    currency: CurrencyCode,
  ): Promise<Account[]> {
    return await this.list({ where: { type, currency } });
  }

  /**
   * Search accounts by name (case-insensitive partial match)
   *
   * @param searchTerm - Search term
   * @returns Array of matching Account instances
   */
  async searchByName(searchTerm: string): Promise<Account[]> {
    const allAccounts = await this.list({});
    const lowerSearch = searchTerm.toLowerCase();

    return allAccounts.filter((account) =>
      account.name.toLowerCase().includes(lowerSearch),
    );
  }

  /**
   * Get account hierarchy tree structure
   * Returns root accounts with nested children
   *
   * @returns Array of root accounts with children property
   */
  async getHierarchyTree(): Promise<any[]> {
    const allAccounts = await this.list({});
    const accountMap = new Map<string, any>();
    const roots: any[] = [];

    // Create map of accounts with children arrays
    for (const account of allAccounts) {
      accountMap.set(account.id, { ...account, children: [] });
    }

    // Build tree structure
    for (const account of allAccounts) {
      const node = accountMap.get(account.id);
      if (account.parentId && accountMap.has(account.parentId)) {
        accountMap.get(account.parentId)?.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }
}
