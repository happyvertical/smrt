import { SmrtObject } from '@smrt/core';
import { AccountTransactionOptions } from '../types';
export declare class AccountTransaction extends SmrtObject {
    date: Date;
    description: string;
    metadata: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: AccountTransactionOptions);
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
     * Get all entries for this transaction
     *
     * @returns Array of AccountTransactionEntry instances
     */
    getEntries(): Promise<any>;
    /**
     * Calculate the total balance of all entries
     * For balanced transactions, this should be zero
     *
     * @returns Sum of all entry amounts (debits positive, credits negative)
     */
    getBalance(): Promise<number>;
    /**
     * Check if this transaction is balanced
     * In double-entry accounting, balanced means debits = credits (sum = 0)
     *
     * @returns True if sum of all entries equals zero
     */
    isBalanced(): Promise<boolean>;
    /**
     * Get total debits (positive amounts)
     *
     * @returns Sum of all positive entry amounts
     */
    getTotalDebits(): Promise<number>;
    /**
     * Get total credits (negative amounts, returned as positive)
     *
     * @returns Sum of all negative entry amounts (as positive number)
     */
    getTotalCredits(): Promise<number>;
    /**
     * Get entries grouped by currency
     *
     * @returns Map of currency codes to arrays of entries
     */
    getEntriesByCurrency(): Promise<Map<string, unknown[]>>;
}
//# sourceMappingURL=AccountTransaction.d.ts.map