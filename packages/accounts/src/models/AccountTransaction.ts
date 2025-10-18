/**
 * AccountTransaction model - Financial transaction record
 *
 * Represents a financial event with one or more entries
 */

import { SmrtObject, smrt } from '@smrt/core';
import type { AccountTransactionOptions } from '../types';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class AccountTransaction extends SmrtObject {
  // id inherited from SmrtObject
  // Note: slug and name not typically used for transactions

  date: Date = new Date();
  description = '';
  metadata = ''; // JSON metadata (stored as text)

  // Timestamps
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: AccountTransactionOptions = {}) {
    super(options);

    if (options.date !== undefined) this.date = options.date;
    if (options.description !== undefined)
      this.description = options.description;

    // Handle metadata - can be object or JSON string
    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }

    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
  }

  /**
   * Get metadata as parsed object
   *
   * @returns Parsed metadata object or empty object
   */
  getMetadata(): Record<string, unknown> {
    if (!this.metadata) return {};
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   *
   * @param data - Metadata object to store
   */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Update metadata by merging with existing values
   *
   * @param updates - Partial metadata to merge
   */
  updateMetadata(updates: Record<string, unknown>): void {
    const current = this.getMetadata();
    this.setMetadata({ ...current, ...updates });
  }

  /**
   * Get all entries for this transaction
   *
   * @returns Array of AccountTransactionEntry instances
   */
  async getEntries() {
    const { AccountTransactionEntryCollection } = await import(
      '../collections/AccountTransactionEntryCollection'
    );
    const { persistence, db, ai, fs, _className } = this.options;
    const collection = await (AccountTransactionEntryCollection as any).create({
      persistence,
      db,
      ai,
      fs,
      _className,
    });

    return await collection.list({ where: { transactionId: this.id } });
  }

  /**
   * Calculate the total balance of all entries
   * For balanced transactions, this should be zero
   *
   * @returns Sum of all entry amounts (debits positive, credits negative)
   */
  async getBalance(): Promise<number> {
    const entries = await this.getEntries();
    return entries.reduce((sum: number, entry: any) => sum + entry.amount, 0);
  }

  /**
   * Check if this transaction is balanced
   * In double-entry accounting, balanced means debits = credits (sum = 0)
   *
   * @returns True if sum of all entries equals zero
   */
  async isBalanced(): Promise<boolean> {
    const balance = await this.getBalance();
    return balance === 0;
  }

  /**
   * Get total debits (positive amounts)
   *
   * @returns Sum of all positive entry amounts
   */
  async getTotalDebits(): Promise<number> {
    const entries = await this.getEntries();
    return entries
      .filter((entry: any) => entry.amount > 0)
      .reduce((sum: number, entry: any) => sum + entry.amount, 0);
  }

  /**
   * Get total credits (negative amounts, returned as positive)
   *
   * @returns Sum of all negative entry amounts (as positive number)
   */
  async getTotalCredits(): Promise<number> {
    const entries = await this.getEntries();
    return Math.abs(
      entries
        .filter((entry: any) => entry.amount < 0)
        .reduce((sum: number, entry: any) => sum + entry.amount, 0),
    );
  }

  /**
   * Get entries grouped by currency
   *
   * @returns Map of currency codes to arrays of entries
   */
  async getEntriesByCurrency(): Promise<Map<string, unknown[]>> {
    const entries = await this.getEntries();
    const byCurrency = new Map<string, unknown[]>();

    for (const entry of entries) {
      const currency = entry.currency || 'UNKNOWN';
      if (!byCurrency.has(currency)) {
        byCurrency.set(currency, []);
      }
      byCurrency.get(currency)?.push(entry);
    }

    return byCurrency;
  }
}
