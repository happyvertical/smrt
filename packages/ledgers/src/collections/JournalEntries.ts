/**
 * JournalEntryCollection - Collection manager for JournalEntry objects
 *
 * Provides querying and balance calculations for ledger entries.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { JournalEntry } from '../models/JournalEntry';
import { BALANCE_EPSILON, type TrialBalanceRow } from '../types';

export class JournalEntryCollection extends SmrtCollection<JournalEntry> {
  static readonly _itemClass = JournalEntry;

  /**
   * Find entries by journal
   *
   * @param journalId - Journal ID
   * @returns Array of entries
   */
  async findByJournal(journalId: string): Promise<JournalEntry[]> {
    return await this.list({
      where: { journalId },
    });
  }

  /**
   * Find entries by account
   *
   * @param accountId - Account ID
   * @returns Array of entries
   */
  async findByAccount(accountId: string): Promise<JournalEntry[]> {
    return await this.list({
      where: { accountId },
    });
  }

  /**
   * Get account balance
   *
   * For debit-normal accounts (Asset, Expense): balance = debits - credits
   * For credit-normal accounts (Liability, Equity, Revenue): balance = credits - debits
   *
   * @param accountId - Account ID
   * @param asOfDate - Optional date to calculate balance as of
   * @returns Account balance
   */
  async getAccountBalance(accountId: string, asOfDate?: Date): Promise<number> {
    // Get entries for this account from posted journals only
    const { JournalCollection } = await import('./Journals');
    const journalCollection = await (JournalCollection as any).create(
      this.options,
    );
    const { AccountCollection } = await import('./Accounts');
    const accountCollection = await (AccountCollection as any).create(
      this.options,
    );

    // Get the account to determine if it's debit or credit normal
    const account = await accountCollection.get({ id: accountId });
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    // Get all entries for this account
    const allEntries = await this.findByAccount(accountId);

    let totalDebits = 0;
    let totalCredits = 0;

    for (const entry of allEntries) {
      // Get the journal to check status and date
      const journal = await journalCollection.get({ id: entry.journalId });
      if (!journal) continue;

      // Only include posted journals
      if (!journal.isPosted()) continue;

      // Check date if specified
      if (asOfDate && journal.date > asOfDate) continue;

      totalDebits += entry.debit;
      totalCredits += entry.credit;
    }

    // Calculate balance based on account type
    if (account.isDebitNormal()) {
      // Asset, Expense: increases with debits
      return totalDebits - totalCredits;
    } else {
      // Liability, Equity, Revenue: increases with credits
      return totalCredits - totalDebits;
    }
  }

  /**
   * Get trial balance
   *
   * @param asOfDate - Optional date for trial balance
   * @returns Array of trial balance rows
   */
  async getTrialBalance(asOfDate?: Date): Promise<TrialBalanceRow[]> {
    const { AccountCollection } = await import('./Accounts');
    const accountCollection = await (AccountCollection as any).create(
      this.options,
    );

    const accounts = await accountCollection.findActive();
    const rows: TrialBalanceRow[] = [];

    for (const account of accounts) {
      if (!account.id) continue;

      const balance = await this.getAccountBalance(account.id, asOfDate);

      // Skip zero-balance accounts
      if (Math.abs(balance) < BALANCE_EPSILON) continue;

      rows.push({
        accountId: account.id,
        accountNumber: account.number,
        accountName: account.name,
        accountType: account.type,
        debitBalance: account.isDebitNormal() && balance > 0 ? balance : 0,
        creditBalance: account.isCreditNormal() && balance > 0 ? balance : 0,
      });
    }

    // Sort by account number
    rows.sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

    return rows;
  }

  /**
   * Get total debits and credits for a date range
   *
   * @param start - Start date
   * @param end - End date
   * @returns Object with totalDebits and totalCredits
   */
  async getTotalsForDateRange(
    start: Date,
    end: Date,
  ): Promise<{ totalDebits: number; totalCredits: number }> {
    const { JournalCollection } = await import('./Journals');
    const journalCollection = await (JournalCollection as any).create(
      this.options,
    );

    const journals = await journalCollection.findByDateRange(start, end);

    let totalDebits = 0;
    let totalCredits = 0;

    for (const journal of journals) {
      if (!journal.isPosted()) continue;

      const entries = await this.findByJournal(journal.id!);
      for (const entry of entries) {
        totalDebits += entry.debit;
        totalCredits += entry.credit;
      }
    }

    return { totalDebits, totalCredits };
  }

  /**
   * Get entries for multiple accounts
   *
   * @param accountIds - Array of account IDs
   * @returns Array of entries
   */
  async findByAccounts(accountIds: string[]): Promise<JournalEntry[]> {
    if (accountIds.length === 0) {
      return [];
    }

    // Use single query with IN clause to avoid N+1 problem
    return await this.list({
      where: { accountId: accountIds },
    });
  }

  /**
   * Get the running balance for an account (list of entries with running total)
   *
   * @param accountId - Account ID
   * @returns Array of entries with running balance
   */
  async getAccountLedger(
    accountId: string,
  ): Promise<Array<{ entry: JournalEntry; runningBalance: number }>> {
    const { JournalCollection } = await import('./Journals');
    const { AccountCollection } = await import('./Accounts');
    const journalCollection = await (JournalCollection as any).create(
      this.options,
    );
    const accountCollection = await (AccountCollection as any).create(
      this.options,
    );

    const account = await accountCollection.get({ id: accountId });
    if (!account) {
      throw new Error(`Account not found: ${accountId}`);
    }

    const entries = await this.findByAccount(accountId);
    const ledger: Array<{ entry: JournalEntry; runningBalance: number }> = [];
    let runningBalance = 0;

    // Sort entries by journal date
    const entriesWithJournals = await Promise.all(
      entries.map(async (entry) => ({
        entry,
        journal: await journalCollection.get({ id: entry.journalId }),
      })),
    );

    entriesWithJournals.sort((a, b) => {
      if (!a.journal || !b.journal) return 0;
      return a.journal.date.getTime() - b.journal.date.getTime();
    });

    for (const { entry, journal } of entriesWithJournals) {
      if (!journal || !journal.isPosted()) continue;

      if (account.isDebitNormal()) {
        runningBalance += entry.debit - entry.credit;
      } else {
        runningBalance += entry.credit - entry.debit;
      }

      ledger.push({ entry, runningBalance });
    }

    return ledger;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tenant Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find all journal entries belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant's journal entries
   */
  async findByTenant(tenantId: string): Promise<JournalEntry[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global journal entries (no tenant association).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context. (#1600)
   *
   * @returns Array of global journal entries
   */
  async findGlobal(): Promise<JournalEntry[]> {
    return queryGlobal<JournalEntry>(this);
  }

  /**
   * Find journal entries for a tenant plus all global entries.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant's entries and global entries
   */
  async findWithGlobals(tenantId: string): Promise<JournalEntry[]> {
    return queryWithGlobals<JournalEntry>(
      this,
      tenantId,
      'JournalEntry.findWithGlobals',
    );
  }
}
