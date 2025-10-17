import { SmrtCollection } from '@smrt/core';
import { Account } from '../models/Account';
import { AccountType, CurrencyCode } from '../types';
export declare class AccountCollection extends SmrtCollection<Account> {
    static readonly _itemClass: typeof Account;
    /**
     * Get accounts by type
     *
     * @param type - Account type (asset, liability, equity, revenue, expense)
     * @returns Array of Account instances
     */
    getByType(type: AccountType): Promise<Account[]>;
    /**
     * Get accounts by currency
     *
     * @param currency - ISO 4217 currency code
     * @returns Array of Account instances
     */
    getByCurrency(currency: CurrencyCode): Promise<Account[]>;
    /**
     * Get root accounts (accounts with no parent)
     *
     * @returns Array of root Account instances
     */
    getRootAccounts(): Promise<Account[]>;
    /**
     * Get child accounts of a parent
     *
     * @param parentId - Parent account ID
     * @returns Array of child Account instances
     */
    getChildren(parentId: string): Promise<Account[]>;
    /**
     * Get all accounts of a specific type and currency
     *
     * @param type - Account type
     * @param currency - Currency code
     * @returns Array of Account instances
     */
    getByTypeAndCurrency(type: AccountType, currency: CurrencyCode): Promise<Account[]>;
    /**
     * Search accounts by name (case-insensitive partial match)
     *
     * @param searchTerm - Search term
     * @returns Array of matching Account instances
     */
    searchByName(searchTerm: string): Promise<Account[]>;
    /**
     * Get account hierarchy tree structure
     * Returns root accounts with nested children
     *
     * @returns Array of root accounts with children property
     */
    getHierarchyTree(): Promise<unknown[]>;
}
//# sourceMappingURL=AccountCollection.d.ts.map