/**
 * JournalEntry model - Individual ledger line
 *
 * The atomic unit of double-entry accounting - a single debit or credit.
 * Each entry belongs to a Journal and references an Account.
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { JournalEntryOptions } from '../types';

@smrt({
  api: { include: ['list', 'get'] }, // Created via Journal, not directly
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class JournalEntry extends SmrtObject {
  /**
   * Parent journal ID (required)
   */
  journalId: string = '';

  /**
   * Account ID (required)
   */
  accountId: string = '';

  /**
   * Debit amount (left side)
   */
  debit: number = 0.0;

  /**
   * Credit amount (right side)
   */
  credit: number = 0.0;

  /**
   * Currency code (e.g., "USD", "CAD", "EUR")
   */
  currency: string = 'USD';

  /**
   * Exchange rate to base currency
   */
  exchangeRate: number = 1.0;

  /**
   * Line memo/description
   */
  memo: string = '';

  /**
   * Extensible metadata
   */
  metadata: Record<string, unknown> = {};

  constructor(options: JournalEntryOptions = {}) {
    super(options);
    if (options.journalId !== undefined) this.journalId = options.journalId;
    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.debit !== undefined) this.debit = options.debit;
    if (options.credit !== undefined) this.credit = options.credit;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.exchangeRate !== undefined)
      this.exchangeRate = options.exchangeRate;
    if (options.memo !== undefined) this.memo = options.memo;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Validate entry before save
   */
  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    // Validate amounts are non-negative
    if (this.debit < 0) {
      throw new Error('Debit amount cannot be negative');
    }
    if (this.credit < 0) {
      throw new Error('Credit amount cannot be negative');
    }

    // Validate that entry has debit OR credit, not both
    if (this.debit > 0 && this.credit > 0) {
      throw new Error('Entry cannot have both debit and credit amounts');
    }

    // Validate that entry has at least one amount
    if (this.debit === 0 && this.credit === 0) {
      throw new Error('Entry must have either a debit or credit amount');
    }

    // Validate exchange rate is positive
    if (this.exchangeRate <= 0) {
      throw new Error('Exchange rate must be positive');
    }
  }

  /**
   * Check if this is a debit entry
   */
  isDebit(): boolean {
    return this.debit > 0;
  }

  /**
   * Check if this is a credit entry
   */
  isCredit(): boolean {
    return this.credit > 0;
  }

  /**
   * Get the entry amount (positive value regardless of debit/credit)
   */
  getAmount(): number {
    return this.debit > 0 ? this.debit : this.credit;
  }

  /**
   * Get the amount in base currency
   */
  getBaseAmount(): number {
    return this.getAmount() * this.exchangeRate;
  }

  /**
   * Get the parent journal
   */
  async getJournal(): Promise<import('./Journal').Journal | null> {
    if (!this.journalId) return null;
    const { JournalCollection } = await import('../collections/Journals');
    const collection = await (JournalCollection as any).create(this.options);
    return await collection.get({ id: this.journalId });
  }

  /**
   * Get the account
   */
  async getAccount(): Promise<import('./Account').Account | null> {
    if (!this.accountId) return null;
    const { AccountCollection } = await import('../collections/Accounts');
    const collection = await (AccountCollection as any).create(this.options);
    return await collection.get({ id: this.accountId });
  }

  /**
   * Get a formatted description of this entry
   */
  async getDescription(): Promise<string> {
    const account = await this.getAccount();
    const accountName = account?.name || 'Unknown Account';
    const type = this.isDebit() ? 'DR' : 'CR';
    const amount = this.getAmount().toFixed(2);

    return `${type} ${accountName}: $${amount}${this.memo ? ` - ${this.memo}` : ''}`;
  }
}
