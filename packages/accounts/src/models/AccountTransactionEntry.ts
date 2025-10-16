/**
 * AccountTransactionEntry model - Individual entry in a transaction
 *
 * Represents a debit or credit to a specific account
 */

import { SmrtObject, smrt } from '@smrt/core';
import type { AccountTransactionEntryOptions, CurrencyCode } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class AccountTransactionEntry extends SmrtObject {
  // id inherited from SmrtObject
  // Note: slug and name not typically used for transaction entries

  transactionId = ''; // FK to AccountTransaction
  accountId = ''; // FK to Account
  amount = 0; // Integer in smallest currency unit (e.g., cents)
  currency: CurrencyCode = 'USD'; // ISO 4217 currency code
  description = ''; // Optional entry-specific description

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: AccountTransactionEntryOptions = {}) {
    super(options);

    if (options.transactionId !== undefined)
      this.transactionId = options.transactionId;
    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.amount !== undefined) this.amount = options.amount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.description !== undefined)
      this.description = options.description;

    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get the transaction this entry belongs to
   *
   * @returns AccountTransaction instance or null
   */
  async getTransaction() {
    if (!this.transactionId) return null;

    const { AccountTransactionCollection } = await import(
      '../collections/AccountTransactionCollection'
    );
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = new AccountTransactionCollection({
      persistence,
      db,
      ai,
      fs,
      _className,
    });
    await collection.initialize();

    return await collection.get({ id: this.transactionId });
  }

  /**
   * Get the account this entry affects
   *
   * @returns Account instance or null
   */
  async getAccount() {
    if (!this.accountId) return null;

    const { AccountCollection } = await import(
      '../collections/AccountCollection'
    );
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = new AccountCollection({
      persistence,
      db,
      ai,
      fs,
      _className,
    });
    await collection.initialize();

    return await collection.get({ id: this.accountId });
  }

  /**
   * Check if this entry is a debit
   *
   * @returns True if amount is positive
   */
  isDebit(): boolean {
    return this.amount > 0;
  }

  /**
   * Check if this entry is a credit
   *
   * @returns True if amount is negative
   */
  isCredit(): boolean {
    return this.amount < 0;
  }

  /**
   * Get the absolute amount value
   *
   * @returns Absolute value of amount
   */
  getAbsoluteAmount(): number {
    return Math.abs(this.amount);
  }

  /**
   * Format amount as currency string
   * Converts from smallest unit (cents) to standard format
   *
   * @param locale - Optional locale for formatting (default: 'en-US')
   * @returns Formatted currency string
   */
  formatAmount(locale = 'en-US'): string {
    // Convert cents to standard currency units
    const standardAmount = this.amount / 100;

    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: this.currency,
      }).format(standardAmount);
    } catch {
      // Fallback if currency not recognized
      return `${this.currency} ${standardAmount.toFixed(2)}`;
    }
  }

  /**
   * Create a debit entry helper
   * Static factory method for creating debit entries
   *
   * @param options - Entry options with positive amount
   * @returns New AccountTransactionEntry instance
   */
  static createDebit(
    options: Omit<AccountTransactionEntryOptions, 'amount'> & {
      amount: number;
    },
  ): AccountTransactionEntry {
    return new AccountTransactionEntry({
      ...options,
      amount: Math.abs(options.amount), // Ensure positive
    });
  }

  /**
   * Create a credit entry helper
   * Static factory method for creating credit entries
   *
   * @param options - Entry options with amount (will be made negative)
   * @returns New AccountTransactionEntry instance
   */
  static createCredit(
    options: Omit<AccountTransactionEntryOptions, 'amount'> & {
      amount: number;
    },
  ): AccountTransactionEntry {
    return new AccountTransactionEntry({
      ...options,
      amount: -Math.abs(options.amount), // Ensure negative
    });
  }
}
