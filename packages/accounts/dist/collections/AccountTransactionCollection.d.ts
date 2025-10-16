import { SmrtCollection } from '../../../../core/smrt/src';
import { AccountTransaction } from '../models/AccountTransaction';
export declare class AccountTransactionCollection extends SmrtCollection<AccountTransaction> {
    static readonly _itemClass: typeof AccountTransaction;
    /**
     * Get transactions by date range
     *
     * @param startDate - Start of date range
     * @param endDate - End of date range
     * @returns Array of AccountTransaction instances
     */
    getByDateRange(startDate: Date, endDate: Date): Promise<AccountTransaction[]>;
    /**
     * Get transactions on a specific date
     *
     * @param date - Date to filter by
     * @returns Array of AccountTransaction instances
     */
    getByDate(date: Date): Promise<AccountTransaction[]>;
    /**
     * Search transactions by description (case-insensitive partial match)
     *
     * @param searchTerm - Search term
     * @returns Array of matching AccountTransaction instances
     */
    searchByDescription(searchTerm: string): Promise<AccountTransaction[]>;
    /**
     * Get recent transactions
     *
     * @param limit - Maximum number of transactions to return
     * @returns Array of recent AccountTransaction instances
     */
    getRecent(limit?: number): Promise<AccountTransaction[]>;
    /**
     * Get transactions for current month
     *
     * @returns Array of AccountTransaction instances
     */
    getCurrentMonth(): Promise<AccountTransaction[]>;
    /**
     * Get transactions for current year
     *
     * @returns Array of AccountTransaction instances
     */
    getCurrentYear(): Promise<AccountTransaction[]>;
}
//# sourceMappingURL=AccountTransactionCollection.d.ts.map