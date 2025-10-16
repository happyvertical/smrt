/**
 * Type definitions for @have/accounts
 */

import type { SmrtObjectOptions } from '@have/smrt';

/**
 * Account types based on standard accounting classifications
 */
export type AccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';

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
  parentId?: string; // Nullable - for hierarchical organization
  description?: string;
  metadata?: Record<string, any> | string; // Additional account information
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
  metadata?: Record<string, any> | string; // Additional transaction information
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
  amount?: number; // Integer in smallest currency unit (e.g., cents)
  currency?: CurrencyCode;
  description?: string; // Optional entry-specific description
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Search filters for accounts
 */
export interface AccountSearchFilters {
  type?: AccountType | AccountType[];
  currency?: CurrencyCode | CurrencyCode[];
  parentId?: string; // Filter by parent account
  hasParent?: boolean; // Filter for root accounts (false) or child accounts (true)
}

/**
 * Search filters for transactions
 */
export interface AccountTransactionSearchFilters {
  startDate?: Date;
  endDate?: Date;
  description?: string; // Partial text match
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
