/**
 * AccountTransactionCollection - Collection manager for AccountTransaction objects
 *
 * Provides transaction filtering by date range and description search.
 */

import { SmrtCollection } from '@have/smrt';
import { AccountTransaction } from '../models/AccountTransaction';

export class AccountTransactionCollection extends SmrtCollection<AccountTransaction> {
  static readonly _itemClass = AccountTransaction;

  /**
   * Get transactions by date range
   *
   * @param startDate - Start of date range
   * @param endDate - End of date range
   * @returns Array of AccountTransaction instances
   */
  async getByDateRange(
    startDate: Date,
    endDate: Date,
  ): Promise<AccountTransaction[]> {
    const allTransactions = await this.list({});

    return allTransactions.filter(
      (transaction) =>
        transaction.date >= startDate && transaction.date <= endDate,
    );
  }

  /**
   * Get transactions on a specific date
   *
   * @param date - Date to filter by
   * @returns Array of AccountTransaction instances
   */
  async getByDate(date: Date): Promise<AccountTransaction[]> {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    return await this.getByDateRange(startOfDay, endOfDay);
  }

  /**
   * Search transactions by description (case-insensitive partial match)
   *
   * @param searchTerm - Search term
   * @returns Array of matching AccountTransaction instances
   */
  async searchByDescription(searchTerm: string): Promise<AccountTransaction[]> {
    const allTransactions = await this.list({});
    const lowerSearch = searchTerm.toLowerCase();

    return allTransactions.filter((transaction) =>
      transaction.description.toLowerCase().includes(lowerSearch),
    );
  }

  /**
   * Get recent transactions
   *
   * @param limit - Maximum number of transactions to return
   * @returns Array of recent AccountTransaction instances
   */
  async getRecent(limit = 10): Promise<AccountTransaction[]> {
    const allTransactions = await this.list({});

    return allTransactions
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, limit);
  }

  /**
   * Get transactions for current month
   *
   * @returns Array of AccountTransaction instances
   */
  async getCurrentMonth(): Promise<AccountTransaction[]> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    endOfMonth.setHours(23, 59, 59, 999);

    return await this.getByDateRange(startOfMonth, endOfMonth);
  }

  /**
   * Get transactions for current year
   *
   * @returns Array of AccountTransaction instances
   */
  async getCurrentYear(): Promise<AccountTransaction[]> {
    const now = new Date();
    const startOfYear = new Date(now.getFullYear(), 0, 1);
    const endOfYear = new Date(now.getFullYear(), 11, 31);
    endOfYear.setHours(23, 59, 59, 999);

    return await this.getByDateRange(startOfYear, endOfYear);
  }
}
