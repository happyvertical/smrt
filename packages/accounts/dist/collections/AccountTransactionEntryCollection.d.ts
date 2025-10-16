import { SmrtCollection } from '@smrt/core';
import { AccountTransactionEntry } from '../models/AccountTransactionEntry';
import { CurrencyCode } from '../types';
export declare class AccountTransactionEntryCollection extends SmrtCollection<AccountTransactionEntry> {
    static readonly _itemClass: typeof AccountTransactionEntry;
    /**
     * Get entries for a specific transaction
     *
     * @param transactionId - Transaction ID
     * @returns Array of AccountTransactionEntry instances
     */
    getByTransactionId(transactionId: string): Promise<AccountTransactionEntry[]>;
    /**
     * Get entries for a specific account
     *
     * @param accountId - Account ID
     * @returns Array of AccountTransactionEntry instances
     */
    getByAccountId(accountId: string): Promise<AccountTransactionEntry[]>;
    /**
     * Get entries by currency
     *
     * @param currency - ISO 4217 currency code
     * @returns Array of AccountTransactionEntry instances
     */
    getByCurrency(currency: CurrencyCode): Promise<AccountTransactionEntry[]>;
    /**
     * Get debit entries only (positive amounts)
     *
     * @returns Array of debit AccountTransactionEntry instances
     */
    getDebits(): Promise<AccountTransactionEntry[]>;
    /**
     * Get credit entries only (negative amounts)
     *
     * @returns Array of credit AccountTransactionEntry instances
     */
    getCredits(): Promise<AccountTransactionEntry[]>;
    /**
     * Get entries within amount range
     *
     * @param minAmount - Minimum amount (inclusive)
     * @param maxAmount - Maximum amount (inclusive)
     * @returns Array of AccountTransactionEntry instances
     */
    getByAmountRange(minAmount: number, maxAmount: number): Promise<AccountTransactionEntry[]>;
    /**
     * Calculate total for account
     *
     * @param accountId - Account ID
     * @returns Sum of all entry amounts for the account
     */
    calculateAccountTotal(accountId: string): Promise<number>;
    /**
     * Calculate total for transaction
     *
     * @param transactionId - Transaction ID
     * @returns Sum of all entry amounts for the transaction
     */
    calculateTransactionTotal(transactionId: string): Promise<number>;
    /**
     * Get entries grouped by account
     *
     * @returns Map of account IDs to arrays of entries
     */
    groupByAccount(): Promise<Map<string, AccountTransactionEntry[]>>;
    /**
     * Get entries grouped by currency
     *
     * @returns Map of currency codes to arrays of entries
     */
    groupByCurrency(): Promise<Map<string, AccountTransactionEntry[]>>;
}
//# sourceMappingURL=AccountTransactionEntryCollection.d.ts.map