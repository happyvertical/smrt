import { SmrtObject } from '@smrt/core';
import { AccountOptions, AccountType, CurrencyCode } from '../types';
export declare class Account extends SmrtObject {
    type: AccountType;
    currency: CurrencyCode;
    parentId: string;
    description: string;
    metadata: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: AccountOptions);
    /**
     * Get metadata as parsed object
     *
     * @returns Parsed metadata object or empty object
     */
    getMetadata(): Record<string, unknown>;
    /**
     * Set metadata from object
     *
     * @param data - Metadata object to store
     */
    setMetadata(data: Record<string, unknown>): void;
    /**
     * Update metadata by merging with existing values
     *
     * @param updates - Partial metadata to merge
     */
    updateMetadata(updates: Record<string, unknown>): void;
    /**
     * Get the parent account
     *
     * @returns Parent Account instance or null
     */
    getParent(): Promise<Account | null>;
    /**
     * Get immediate child accounts
     *
     * @returns Array of child Account instances
     */
    getChildren(): Promise<Account[]>;
    /**
     * Get all ancestor accounts (recursive)
     *
     * @returns Array of ancestor accounts from root to immediate parent
     */
    getAncestors(): Promise<Account[]>;
    /**
     * Get all descendant accounts (recursive)
     *
     * @returns Array of all descendant accounts
     */
    getDescendants(): Promise<Account[]>;
    /**
     * Get root account (top-level account with no parent)
     *
     * @returns Root account instance
     */
    getRootAccount(): Promise<Account>;
    /**
     * Get full hierarchy for this account
     *
     * @returns Object with ancestors, current, and descendants
     */
    getHierarchy(): Promise<{
        ancestors: Account[];
        current: Account;
        descendants: Account[];
    }>;
    /**
     * Check if account is a root account (no parent)
     *
     * @returns True if parentId is empty
     */
    isRoot(): boolean;
    /**
     * Get the depth of this account in the hierarchy
     *
     * @returns Number of ancestors (0 for root accounts)
     */
    getDepth(): Promise<number>;
    /**
     * Get all transaction entries for this account
     *
     * @returns Array of AccountTransactionEntry instances
     */
    getTransactionEntries(): Promise<any>;
    /**
     * Calculate the balance for this account
     * Sum of all transaction entries (debits positive, credits negative)
     *
     * @returns Balance in smallest currency unit (e.g., cents)
     */
    getBalance(): Promise<number>;
}
//# sourceMappingURL=Account.d.ts.map