/**
 * AccountTransactionEntryCollection - Collection manager for AccountTransactionEntry objects
 *
 * Provides entry filtering by transaction, account, currency, and amount.
 */

import { SmrtCollection } from '@smrt/core';
import { AccountTransactionEntry } from '../models/AccountTransactionEntry';
import type { CurrencyCode } from '../types';

export class AccountTransactionEntryCollection extends SmrtCollection<AccountTransactionEntry> {
  static readonly _itemClass = AccountTransactionEntry;

  /**
   * Get entries for a specific transaction
   *
   * @param transactionId - Transaction ID
   * @returns Array of AccountTransactionEntry instances
   */
  async getByTransactionId(
    transactionId: string,
  ): Promise<AccountTransactionEntry[]> {
    return await this.list({ where: { transactionId } });
  }

  /**
   * Get entries for a specific account
   *
   * @param accountId - Account ID
   * @returns Array of AccountTransactionEntry instances
   */
  async getByAccountId(accountId: string): Promise<AccountTransactionEntry[]> {
    return await this.list({ where: { accountId } });
  }

  /**
   * Get entries by currency
   *
   * @param currency - ISO 4217 currency code
   * @returns Array of AccountTransactionEntry instances
   */
  async getByCurrency(
    currency: CurrencyCode,
  ): Promise<AccountTransactionEntry[]> {
    return await this.list({ where: { currency } });
  }

  /**
   * Get debit entries only (positive amounts)
   *
   * @returns Array of debit AccountTransactionEntry instances
   */
  async getDebits(): Promise<AccountTransactionEntry[]> {
    const allEntries = await this.list({});
    return allEntries.filter((entry) => entry.amount > 0);
  }

  /**
   * Get credit entries only (negative amounts)
   *
   * @returns Array of credit AccountTransactionEntry instances
   */
  async getCredits(): Promise<AccountTransactionEntry[]> {
    const allEntries = await this.list({});
    return allEntries.filter((entry) => entry.amount < 0);
  }

  /**
   * Get entries within amount range
   *
   * @param minAmount - Minimum amount (inclusive)
   * @param maxAmount - Maximum amount (inclusive)
   * @returns Array of AccountTransactionEntry instances
   */
  async getByAmountRange(
    minAmount: number,
    maxAmount: number,
  ): Promise<AccountTransactionEntry[]> {
    const allEntries = await this.list({});
    return allEntries.filter(
      (entry) => entry.amount >= minAmount && entry.amount <= maxAmount,
    );
  }

  /**
   * Calculate total for account
   *
   * @param accountId - Account ID
   * @returns Sum of all entry amounts for the account
   */
  async calculateAccountTotal(accountId: string): Promise<number> {
    const entries = await this.getByAccountId(accountId);
    return entries.reduce((sum, entry) => sum + entry.amount, 0);
  }

  /**
   * Calculate total for transaction
   *
   * @param transactionId - Transaction ID
   * @returns Sum of all entry amounts for the transaction
   */
  async calculateTransactionTotal(transactionId: string): Promise<number> {
    const entries = await this.getByTransactionId(transactionId);
    return entries.reduce((sum, entry) => sum + entry.amount, 0);
  }

  /**
   * Get entries grouped by account
   *
   * @returns Map of account IDs to arrays of entries
   */
  async groupByAccount(): Promise<Map<string, AccountTransactionEntry[]>> {
    const allEntries = await this.list({});
    const grouped = new Map<string, AccountTransactionEntry[]>();

    for (const entry of allEntries) {
      if (!grouped.has(entry.accountId)) {
        grouped.set(entry.accountId, []);
      }
      grouped.get(entry.accountId)?.push(entry);
    }

    return grouped;
  }

  /**
   * Get entries grouped by currency
   *
   * @returns Map of currency codes to arrays of entries
   */
  async groupByCurrency(): Promise<Map<string, AccountTransactionEntry[]>> {
    const allEntries = await this.list({});
    const grouped = new Map<string, AccountTransactionEntry[]>();

    for (const entry of allEntries) {
      if (!grouped.has(entry.currency)) {
        grouped.set(entry.currency, []);
      }
      grouped.get(entry.currency)?.push(entry);
    }

    return grouped;
  }
}
