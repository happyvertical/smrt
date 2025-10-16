import { SmrtObjectOptions } from '@smrt/core';
/**
 * Account types based on standard accounting classifications
 */
export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
/**
 * ISO 4217 currency code
 * Common examples: USD, EUR, GBP, CAD, JPY, AUD, CHF
 */
export type CurrencyCode = string;
/**
 * Options for creating Account
 */
export interface AccountOptions extends SmrtObjectOptions {
    id?: string;
    name?: string;
    slug?: string;
    type?: AccountType;
    currency?: CurrencyCode;
    parentId?: string;
    description?: string;
    metadata?: Record<string, any> | string;
    createdAt?: Date;
    updatedAt?: Date;
}
/**
 * Options for creating AccountTransaction
 */
export interface AccountTransactionOptions extends SmrtObjectOptions {
    id?: string;
    date?: Date;
    description?: string;
    metadata?: Record<string, any> | string;
    createdAt?: Date;
    updatedAt?: Date;
}
/**
 * Options for creating AccountTransactionEntry
 */
export interface AccountTransactionEntryOptions extends SmrtObjectOptions {
    id?: string;
    transactionId?: string;
    accountId?: string;
    amount?: number;
    currency?: CurrencyCode;
    description?: string;
    createdAt?: Date;
    updatedAt?: Date;
}
/**
 * Search filters for accounts
 */
export interface AccountSearchFilters {
    type?: AccountType | AccountType[];
    currency?: CurrencyCode | CurrencyCode[];
    parentId?: string;
    hasParent?: boolean;
}
/**
 * Search filters for transactions
 */
export interface AccountTransactionSearchFilters {
    startDate?: Date;
    endDate?: Date;
    description?: string;
}
/**
 * Search filters for transaction entries
 */
export interface AccountTransactionEntrySearchFilters {
    transactionId?: string;
    accountId?: string;
    currency?: CurrencyCode | CurrencyCode[];
    minAmount?: number;
    maxAmount?: number;
}
//# sourceMappingURL=types.d.ts.map