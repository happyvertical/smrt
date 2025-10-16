import { SmrtObject } from '@smrt/core';
import { AccountTransactionEntryOptions, CurrencyCode } from '../types';
export declare class AccountTransactionEntry extends SmrtObject {
    transactionId: string;
    accountId: string;
    amount: number;
    currency: CurrencyCode;
    description: string;
    createdAt: Date;
    updatedAt: Date;
    constructor(options?: AccountTransactionEntryOptions);
    /**
     * Get the transaction this entry belongs to
     *
     * @returns AccountTransaction instance or null
     */
    getTransaction(): Promise<any>;
    /**
     * Get the account this entry affects
     *
     * @returns Account instance or null
     */
    getAccount(): Promise<any>;
    /**
     * Check if this entry is a debit
     *
     * @returns True if amount is positive
     */
    isDebit(): boolean;
    /**
     * Check if this entry is a credit
     *
     * @returns True if amount is negative
     */
    isCredit(): boolean;
    /**
     * Get the absolute amount value
     *
     * @returns Absolute value of amount
     */
    getAbsoluteAmount(): number;
    /**
     * Format amount as currency string
     * Converts from smallest unit (cents) to standard format
     *
     * @param locale - Optional locale for formatting (default: 'en-US')
     * @returns Formatted currency string
     */
    formatAmount(locale?: string): string;
    /**
     * Create a debit entry helper
     * Static factory method for creating debit entries
     *
     * @param options - Entry options with positive amount
     * @returns New AccountTransactionEntry instance
     */
    static createDebit(options: Omit<AccountTransactionEntryOptions, 'amount'> & {
        amount: number;
    }): AccountTransactionEntry;
    /**
     * Create a credit entry helper
     * Static factory method for creating credit entries
     *
     * @param options - Entry options with amount (will be made negative)
     * @returns New AccountTransactionEntry instance
     */
    static createCredit(options: Omit<AccountTransactionEntryOptions, 'amount'> & {
        amount: number;
    }): AccountTransactionEntry;
}
//# sourceMappingURL=AccountTransactionEntry.d.ts.map