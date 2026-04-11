/**
 * Double-entry accounting tests
 *
 * Tests for:
 * 1. Balance calculations
 * 2. Trial balance
 * 3. Real-world scenarios
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountCollection } from '../collections/Accounts';
import { JournalEntryCollection } from '../collections/JournalEntries';
import { JournalCollection } from '../collections/Journals';
import type { Account } from '../models/Account';

describe('Double-Entry Accounting', () => {
  let dbPath: string;
  let accounts: AccountCollection;
  let journals: JournalCollection;
  let entries: JournalEntryCollection;

  // Standard chart of accounts
  let cash: Account;
  let ar: Account;
  let inventory: Account;
  let visa: Account;
  let equity: Account;
  let salesRevenue: Account;
  let coffeeExpense: Account;
  let cogsExpense: Account;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-double-entry-test-${Date.now()}.db`);
    accounts = await AccountCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    journals = await JournalCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    entries = await JournalEntryCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    // Create chart of accounts
    cash = await accounts.create({
      number: '1010',
      name: 'Cash',
      type: 'asset',
    });
    await cash.save();

    ar = await accounts.create({
      number: '1100',
      name: 'Accounts Receivable',
      type: 'asset',
    });
    await ar.save();

    inventory = await accounts.create({
      number: '1300',
      name: 'Inventory',
      type: 'asset',
    });
    await inventory.save();

    visa = await accounts.create({
      number: '2010',
      name: 'Visa Credit Card',
      type: 'liability',
    });
    await visa.save();

    equity = await accounts.create({
      number: '3000',
      name: 'Owner Equity',
      type: 'equity',
    });
    await equity.save();

    salesRevenue = await accounts.create({
      number: '4000',
      name: 'Sales Revenue',
      type: 'revenue',
    });
    await salesRevenue.save();

    coffeeExpense = await accounts.create({
      number: '5030',
      name: 'Coffee Expense',
      type: 'expense',
    });
    await coffeeExpense.save();

    cogsExpense = await accounts.create({
      number: '5500',
      name: 'Cost of Goods Sold',
      type: 'expense',
    });
    await cogsExpense.save();
  });

  afterEach(async () => {
    const databases = new Set<DatabaseInterface>();

    if (accounts) {
      databases.add(accounts.db);
    }
    if (journals) {
      databases.add(journals.db);
    }
    if (entries) {
      databases.add(entries.db);
    }

    for (const db of databases) {
      if (typeof db.close === 'function') {
        try {
          await db.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }

    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  describe('JournalEntry Validation', () => {
    it('should reject negative amounts', async () => {
      const journal = await journals.create({ description: 'Test' });
      await journal.save();

      // create() auto-saves, so validation error is thrown there
      // Error is wrapped in RuntimeError.operationFailed()
      const error: any = await entries
        .create({
          journalId: journal.id!,
          accountId: cash.id!,
          debit: -100,
          credit: 0,
        })
        .catch((e) => e);

      expect(error.cause?.message || error.message).toContain(
        'cannot be negative',
      );
    });

    it('should reject both debit and credit', async () => {
      const journal = await journals.create({ description: 'Test' });
      await journal.save();

      // create() auto-saves, so validation error is thrown there
      // Error is wrapped in RuntimeError.operationFailed()
      const error: any = await entries
        .create({
          journalId: journal.id!,
          accountId: cash.id!,
          debit: 100,
          credit: 100,
        })
        .catch((e) => e);

      expect(error.cause?.message || error.message).toContain(
        'cannot have both debit and credit',
      );
    });

    it('should reject zero amounts', async () => {
      const journal = await journals.create({ description: 'Test' });
      await journal.save();

      // create() auto-saves, so validation error is thrown there
      // Error is wrapped in RuntimeError.operationFailed()
      const error: any = await entries
        .create({
          journalId: journal.id!,
          accountId: cash.id!,
          debit: 0,
          credit: 0,
        })
        .catch((e) => e);

      expect(error.cause?.message || error.message).toContain(
        'must have either a debit or credit',
      );
    });
  });

  describe('Balance Calculations', () => {
    it('should calculate asset balance (debit normal)', async () => {
      // Deposit cash: Debit Cash, Credit Equity
      const deposit = await journals.createWithEntries({
        description: 'Initial investment',
        entries: [
          { accountId: cash.id!, debit: 1000 },
          { accountId: equity.id!, credit: 1000 },
        ],
      });
      await deposit.post();

      // Spend cash: Debit Expense, Credit Cash
      const spend = await journals.createWithEntries({
        description: 'Buy coffee',
        entries: [
          { accountId: coffeeExpense.id!, debit: 5 },
          { accountId: cash.id!, credit: 5 },
        ],
      });
      await spend.post();

      const cashBalance = await entries.getAccountBalance(cash.id!);
      expect(cashBalance).toBe(995); // 1000 - 5
    });

    it('should calculate liability balance (credit normal)', async () => {
      // Charge to credit card: Debit Expense, Credit Visa
      const charge = await journals.createWithEntries({
        description: 'Coffee on credit',
        entries: [
          { accountId: coffeeExpense.id!, debit: 5 },
          { accountId: visa.id!, credit: 5 },
        ],
      });
      await charge.post();

      // Pay credit card: Debit Visa, Credit Cash
      const deposit = await journals.createWithEntries({
        description: 'Initial cash',
        entries: [
          { accountId: cash.id!, debit: 100 },
          { accountId: equity.id!, credit: 100 },
        ],
      });
      await deposit.post();

      const pay = await journals.createWithEntries({
        description: 'Pay credit card',
        entries: [
          { accountId: visa.id!, debit: 3 },
          { accountId: cash.id!, credit: 3 },
        ],
      });
      await pay.post();

      const visaBalance = await entries.getAccountBalance(visa.id!);
      expect(visaBalance).toBe(2); // 5 - 3
    });

    it('should calculate revenue balance (credit normal)', async () => {
      // Cash sale: Debit Cash, Credit Revenue
      const sale1 = await journals.createWithEntries({
        description: 'Sale 1',
        entries: [
          { accountId: cash.id!, debit: 100 },
          { accountId: salesRevenue.id!, credit: 100 },
        ],
      });
      await sale1.post();

      const sale2 = await journals.createWithEntries({
        description: 'Sale 2',
        entries: [
          { accountId: cash.id!, debit: 50 },
          { accountId: salesRevenue.id!, credit: 50 },
        ],
      });
      await sale2.post();

      const revenueBalance = await entries.getAccountBalance(salesRevenue.id!);
      expect(revenueBalance).toBe(150);
    });

    it('should only count posted journals', async () => {
      // Posted journal
      const posted = await journals.createWithEntries({
        description: 'Posted',
        entries: [
          { accountId: cash.id!, debit: 100 },
          { accountId: equity.id!, credit: 100 },
        ],
      });
      await posted.post();

      // Draft journal (should not count)
      await journals.createWithEntries({
        description: 'Draft',
        entries: [
          { accountId: cash.id!, debit: 50 },
          { accountId: equity.id!, credit: 50 },
        ],
      });
      // Don't post this one

      const cashBalance = await entries.getAccountBalance(cash.id!);
      expect(cashBalance).toBe(100); // Only posted counts
    });
  });

  describe('Trial Balance', () => {
    it('should generate trial balance', async () => {
      // Initial investment
      const investment = await journals.createWithEntries({
        description: 'Investment',
        entries: [
          { accountId: cash.id!, debit: 1000 },
          { accountId: equity.id!, credit: 1000 },
        ],
      });
      await investment.post();

      // Sale
      const sale = await journals.createWithEntries({
        description: 'Sale',
        entries: [
          { accountId: cash.id!, debit: 100 },
          { accountId: salesRevenue.id!, credit: 100 },
        ],
      });
      await sale.post();

      // Expense
      const expense = await journals.createWithEntries({
        description: 'Coffee',
        entries: [
          { accountId: coffeeExpense.id!, debit: 5 },
          { accountId: cash.id!, credit: 5 },
        ],
      });
      await expense.post();

      const trialBalance = await entries.getTrialBalance();

      // Total debits should equal total credits
      const totalDebits = trialBalance.reduce(
        (sum, row) => sum + row.debitBalance,
        0,
      );
      const totalCredits = trialBalance.reduce(
        (sum, row) => sum + row.creditBalance,
        0,
      );

      expect(totalDebits).toBe(totalCredits);
      expect(totalDebits).toBe(1100); // 1095 (cash) + 5 (coffee expense)
    });
  });

  describe('Real-World Scenarios', () => {
    it('should handle paycheck deposit', async () => {
      const salaryRevenue = await accounts.create({
        number: '4100',
        name: 'Salary Income',
        type: 'revenue',
      });
      await salaryRevenue.save();

      // Paycheck: Debit Cash, Credit Salary
      const paycheck = await journals.createWithEntries({
        description: '$2,000 paycheck deposited',
        sourceModule: 'import',
        entries: [
          { accountId: cash.id!, debit: 2000 },
          { accountId: salaryRevenue.id!, credit: 2000 },
        ],
      });
      await paycheck.post();

      const cashBalance = await entries.getAccountBalance(cash.id!);
      const salaryBalance = await entries.getAccountBalance(salaryRevenue.id!);

      expect(cashBalance).toBe(2000);
      expect(salaryBalance).toBe(2000);
    });

    it('should handle credit card purchase and payment', async () => {
      // Initial cash
      const init = await journals.createWithEntries({
        description: 'Initial cash',
        entries: [
          { accountId: cash.id!, debit: 100 },
          { accountId: equity.id!, credit: 100 },
        ],
      });
      await init.post();

      // Coffee on credit: Debit Expense, Credit Visa
      const coffee = await journals.createWithEntries({
        description: '$5.00 Starbucks charge',
        entries: [
          { accountId: coffeeExpense.id!, debit: 5 },
          { accountId: visa.id!, credit: 5 },
        ],
      });
      await coffee.post();

      // Pay credit card: Debit Visa, Credit Cash
      const pay = await journals.createWithEntries({
        description: 'Pay $5.00 credit card bill',
        entries: [
          { accountId: visa.id!, debit: 5 },
          { accountId: cash.id!, credit: 5 },
        ],
      });
      await pay.post();

      const cashBalance = await entries.getAccountBalance(cash.id!);
      const visaBalance = await entries.getAccountBalance(visa.id!);
      const expenseBalance = await entries.getAccountBalance(coffeeExpense.id!);

      expect(cashBalance).toBe(95); // 100 - 5
      expect(visaBalance).toBe(0); // 5 - 5
      expect(expenseBalance).toBe(5); // Coffee expense recorded
    });

    it('should handle product sale with COGS', async () => {
      // Initial investment
      const init = await journals.createWithEntries({
        description: 'Initial investment',
        entries: [
          { accountId: cash.id!, debit: 1000 },
          { accountId: equity.id!, credit: 1000 },
        ],
      });
      await init.post();

      // Buy inventory
      const buy = await journals.createWithEntries({
        description: 'Buy inventory',
        entries: [
          { accountId: inventory.id!, debit: 100 },
          { accountId: cash.id!, credit: 100 },
        ],
      });
      await buy.post();

      // Sale: Cash received
      const sale = await journals.createWithEntries({
        description: 'T-shirt sale $25',
        entries: [
          { accountId: cash.id!, debit: 25 },
          { accountId: salesRevenue.id!, credit: 25 },
        ],
      });
      await sale.post();

      // Fulfillment: Record COGS
      const cogs = await journals.createWithEntries({
        description: 'T-shirt COGS $10',
        entries: [
          { accountId: cogsExpense.id!, debit: 10 },
          { accountId: inventory.id!, credit: 10 },
        ],
      });
      await cogs.post();

      const cashBalance = await entries.getAccountBalance(cash.id!);
      const inventoryBalance = await entries.getAccountBalance(inventory.id!);
      const revenueBalance = await entries.getAccountBalance(salesRevenue.id!);
      const cogsBalance = await entries.getAccountBalance(cogsExpense.id!);

      expect(cashBalance).toBe(925); // 1000 - 100 + 25
      expect(inventoryBalance).toBe(90); // 100 - 10
      expect(revenueBalance).toBe(25);
      expect(cogsBalance).toBe(10);

      // Gross profit = Revenue - COGS = 25 - 10 = 15
    });
  });

  describe('Account Ledger', () => {
    it('should get running balance for account', async () => {
      // Initial deposit
      const deposit = await journals.createWithEntries({
        description: 'Initial deposit',
        entries: [
          { accountId: cash.id!, debit: 1000 },
          { accountId: equity.id!, credit: 1000 },
        ],
      });
      await deposit.post();

      // Spend
      const spend = await journals.createWithEntries({
        description: 'Buy coffee',
        entries: [
          { accountId: coffeeExpense.id!, debit: 5 },
          { accountId: cash.id!, credit: 5 },
        ],
      });
      await spend.post();

      const ledger = await entries.getAccountLedger(cash.id!);

      expect(ledger).toHaveLength(2);
      expect(ledger[0].runningBalance).toBe(1000);
      expect(ledger[1].runningBalance).toBe(995);
    });
  });
});
