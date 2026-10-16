/**
 * JournalEntryCollection - Collection manager for JournalEntry objects
 *
 * Provides querying and balance calculations for ledger entries.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  getTenantId,
  queryGlobal,
  queryWithGlobals,
} from '@happyvertical/smrt-tenancy';
import { JournalEntry } from '../models/JournalEntry';
import { BALANCE_EPSILON, type TrialBalanceRow } from '../types';

/** One posted ledger movement in its raw stored unit (ledgers are unit-agnostic). */
export interface PostedJournalMovement {
  /** Requested owner identity; consumers must retain it at their reporting boundary. */
  tenantId: string;
  entryId: string;
  journalId: string;
  accountId: string;
  journalDate: Date;
  journalNumber: string;
  sourceModule: string;
  sourceRef: string | null;
  currency: string;
  debit: number;
  credit: number;
  /** Credit minus debit, suitable for liability-account reconciliation. */
  creditMinusDebit: number;
}

export interface PostedJournalMovementOptions {
  tenantId: string;
  accountIds: readonly string[];
  from: Date;
  to: Date;
  currency: string;
  /** Select credit-normal AP balances; default is debit-normal AR. */
  normalBalance?: 'debit' | 'credit';
}

export interface CounterpartyBalance {
  counterpartyKind: string;
  counterpartyId: string;
  currency: string;
  /** Debit minus credit for asset AR accounts; callers choose the account set. */
  balance: number;
}

export interface CounterpartyAgingRow extends CounterpartyBalance {
  sourceRef: string;
  dueDate: Date;
  current: number;
  days1To30: number;
  days31To60: number;
  days61To90: number;
  daysOver90: number;
}

const MAX_MOVEMENT_ACCOUNTS = 1_000;

function storedUnit(value: unknown, label: string): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER)
    throw new RangeError(
      `Posted journal ${label} is outside the supported numeric range.`,
    );
  return number;
}

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

  /** Posted AR/AP net balances by opaque counterparty for selected accounts. */
  async getCounterpartyBalances(
    options: PostedJournalMovementOptions,
  ): Promise<CounterpartyBalance[]> {
    const movements = await this.listPostedMovements(options);
    const result = new Map<string, CounterpartyBalance>();
    for (const movement of movements) {
      const entry = await this.get({ id: movement.entryId });
      if (!entry?.counterpartyKind || !entry.counterpartyId) continue;
      const key = `${entry.counterpartyKind}\u0000${entry.counterpartyId}\u0000${movement.currency}`;
      const row = result.get(key) ?? {
        counterpartyKind: entry.counterpartyKind,
        counterpartyId: entry.counterpartyId,
        currency: movement.currency,
        balance: 0,
      };
      row.balance = storedUnit(
        row.balance +
          (movement.debit - movement.credit) *
            (options.normalBalance === 'credit' ? -1 : 1),
        'counterparty balance',
      );
      result.set(key, row);
    }
    return [...result.values()].filter((row) => row.balance !== 0);
  }

  /**
   * Open-item aging. An invoice/allocation line needs a dueDate and sourceRef;
   * a settlement line names that source in settlesSourceRef. This avoids
   * pretending that net counterparty movements are aging.
   */
  async getCounterpartyAging(
    options: PostedJournalMovementOptions,
    asOf: Date,
  ): Promise<CounterpartyAgingRow[]> {
    const movements = await this.listPostedMovements({ ...options, to: asOf });
    const rows = new Map<string, CounterpartyAgingRow>();
    const balances = new Map<string, number>();
    for (const movement of movements) {
      const entry = await this.get({ id: movement.entryId });
      const source = entry?.settlesSourceRef ?? movement.sourceRef;
      if (!entry?.counterpartyKind || !entry.counterpartyId || !source)
        continue;
      const key = JSON.stringify([
        entry.counterpartyKind,
        entry.counterpartyId,
        movement.currency,
        source,
      ]);
      balances.set(
        key,
        storedUnit(
          (balances.get(key) ?? 0) +
            (movement.debit - movement.credit) *
              (options.normalBalance === 'credit' ? -1 : 1),
          'open item balance',
        ),
      );
      if (!entry.settlesSourceRef && entry.dueDate) {
        const prior = rows.get(key);
        if (prior && prior.dueDate.getTime() !== entry.dueDate.getTime())
          throw new Error('Open item source has conflicting due dates');
        rows.set(key, {
          counterpartyKind: entry.counterpartyKind,
          counterpartyId: entry.counterpartyId,
          currency: movement.currency,
          sourceRef: source,
          dueDate: entry.dueDate,
          balance: 0,
          current: 0,
          days1To30: 0,
          days31To60: 0,
          days61To90: 0,
          daysOver90: 0,
        });
      }
    }
    for (const [key, row] of rows) row.balance = balances.get(key) ?? 0;
    for (const row of rows.values()) {
      if (row.balance <= 0) continue;
      const days = Math.floor(
        (asOf.getTime() - row.dueDate.getTime()) / 86_400_000,
      );
      if (days <= 0) row.current = row.balance;
      else if (days <= 30) row.days1To30 = row.balance;
      else if (days <= 60) row.days31To60 = row.balance;
      else if (days <= 90) row.days61To90 = row.balance;
      else row.daysOver90 = row.balance;
    }
    return [...rows.values()].filter((row) => row.balance > 0);
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
    const journalCollection = await JournalCollection.create(this.options);
    const { AccountCollection } = await import('./Accounts');
    const accountCollection = await AccountCollection.create(this.options);

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
    const accountCollection = await AccountCollection.create(this.options);

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
    const journalCollection = await JournalCollection.create(this.options);

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
   * Read tenant-owned movements from posted journals only. Amounts deliberately
   * remain raw ledger units; commerce validates its minor-unit convention at
   * the reporting boundary.
   */
  async listPostedMovements(
    options: PostedJournalMovementOptions,
  ): Promise<PostedJournalMovement[]> {
    if (getTenantId() && getTenantId() !== options.tenantId)
      throw new Error('Posted movements tenant differs from active context');
    const accountIds = [...new Set(options.accountIds)];
    if (
      !options.tenantId?.trim() ||
      !options.currency?.trim() ||
      !(options.from instanceof Date) ||
      !(options.to instanceof Date) ||
      !Number.isFinite(options.from.getTime()) ||
      !Number.isFinite(options.to.getTime()) ||
      options.from > options.to
    )
      throw new Error(
        'Posted movements require tenant, currency and ordered dates.',
      );
    if (accountIds.length === 0) return [];
    if (accountIds.length > MAX_MOVEMENT_ACCOUNTS)
      throw new RangeError(
        `Posted movements allow at most ${MAX_MOVEMENT_ACCOUNTS} accounts per query.`,
      );
    if (
      accountIds.some((id) => typeof id !== 'string' || !id || id.trim() !== id)
    )
      throw new Error('Posted movement account IDs must be nonempty.');
    const placeholders = accountIds.map(() => '?').join(', ');
    const result = await this.db.query(
      `SELECT e.id AS entry_id, e.journal_id, e.account_id, e.currency,
              e.debit, e.credit, j.date AS journal_date, j.number AS journal_number,
              j.source_module, j.source_ref
         FROM journal_entries e
         JOIN journals j ON j.id = e.journal_id AND j.tenant_id = e.tenant_id
        WHERE e.tenant_id = ? AND e.account_id IN (${placeholders})
          AND e.currency = ? AND j.status = 'posted'
          AND j.date >= ? AND j.date <= ?
        ORDER BY j.date ASC, j.id ASC, e.id ASC`,
      options.tenantId,
      ...accountIds,
      options.currency,
      options.from.toISOString(),
      options.to.toISOString(),
    );
    return result.rows.map((row) => {
      const debit = storedUnit(row.debit, 'debit');
      const credit = storedUnit(row.credit, 'credit');
      const movement = credit - debit;
      if (
        !Number.isFinite(movement) ||
        Math.abs(movement) > Number.MAX_SAFE_INTEGER
      )
        throw new RangeError(
          'Posted journal movement is outside the supported numeric range.',
        );
      return {
        tenantId: options.tenantId,
        entryId: String(row.entry_id),
        journalId: String(row.journal_id),
        accountId: String(row.account_id),
        journalDate: new Date(String(row.journal_date)),
        journalNumber: String(row.journal_number),
        sourceModule: String(row.source_module),
        sourceRef: row.source_ref == null ? null : String(row.source_ref),
        currency: String(row.currency),
        debit,
        credit,
        creditMinusDebit: movement,
      };
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
    const journalCollection = await JournalCollection.create(this.options);
    const accountCollection = await AccountCollection.create(this.options);

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
      if (!journal?.isPosted()) continue;

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
