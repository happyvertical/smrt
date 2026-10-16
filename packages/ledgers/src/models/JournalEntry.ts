/**
 * JournalEntry model - Individual ledger line
 *
 * The atomic unit of double-entry accounting - a single debit or credit.
 * Each entry belongs to a Journal and references an Account.
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { JournalEntryOptions } from '../types';
import { Account } from './Account';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get'] }, // Created via Journal, not directly
  mcp: { include: ['list', 'get'] },
  cli: { skipApiCheck: true },
})
export class JournalEntry extends SmrtObject {
  /**
   * Tenant ID for multi-tenancy support (nullable for global entries)
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Parent journal ID (required)
   */
  @field({ description: 'The journal this entry belongs to.' })
  @foreignKey('Journal')
  journalId: string = '';

  /**
   * Account ID (required)
   */
  // Constructor reference, not the simple name `Account` (also declared by
  // smrt-messages, #3098).
  @field({ description: 'The account this entry changes.' })
  @foreignKey(Account)
  accountId: string = '';

  /** Opaque external party dimension, never a product-specific model. */
  @field({ description: 'Generic counterparty type.', nullable: true })
  counterpartyKind: string | null = null;

  @field({ description: 'Generic counterparty identifier.', nullable: true })
  counterpartyId: string | null = null;

  /** Due date for an AR/AP open item. */
  dueDate: Date | null = null;

  /** Source reference of the open item reduced by this settlement line. */
  settlesSourceRef: string | null = null;

  /**
   * Debit amount (left side)
   */
  @field({ description: 'The amount debited. Zero on a credit entry.' })
  debit: number = 0.0;

  /**
   * Credit amount (right side)
   */
  @field({ description: 'The amount credited. Zero on a debit entry.' })
  credit: number = 0.0;

  /**
   * Currency code (e.g., "USD", "CAD", "EUR")
   */
  @field({ description: 'The currency of the amounts.' })
  currency: string = 'USD';

  /**
   * Exchange rate to base currency
   */
  exchangeRate: number = 1.0;

  /**
   * Line memo/description
   */
  @field({ description: 'A note on this entry.' })
  memo: string = '';

  /**
   * Extensible metadata
   */
  metadata: Record<string, unknown> = {};

  constructor(options: JournalEntryOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.journalId !== undefined) this.journalId = options.journalId;
    if (options.accountId !== undefined) this.accountId = options.accountId;
    if (options.counterpartyKind !== undefined)
      this.counterpartyKind = options.counterpartyKind;
    if (options.counterpartyId !== undefined)
      this.counterpartyId = options.counterpartyId;
    if (options.dueDate !== undefined) this.dueDate = options.dueDate;
    if (options.settlesSourceRef !== undefined)
      this.settlesSourceRef = options.settlesSourceRef;
    if (options.debit !== undefined) this.debit = options.debit;
    if (options.credit !== undefined) this.credit = options.credit;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.exchangeRate !== undefined)
      this.exchangeRate = options.exchangeRate;
    if (options.memo !== undefined) this.memo = options.memo;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  override async save(
    options: Parameters<SmrtObject['save']>[0] = {},
  ): Promise<this> {
    return this.withTransaction(async () => {
      const journal = await this.getJournal();
      if (journal?.ledgerId) {
        if (!journal.isDraft() || !journal.updated_at)
          throw new Error('Ledger entries are immutable after posting');
        await journal.claimRevision(journal.updated_at);
      }
      return super.save(options);
    });
  }

  /**
   * Validate entry before save
   */
  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    const journal = await this.getJournal();
    if (journal?.ledgerId && !journal.isDraft())
      throw new Error('Ledger entries are immutable after posting');
    if (this.id) {
      const stored = await this.db.get(this.tableName, { id: this.id });
      if (stored && stored.journal_id !== this.journalId)
        throw new Error('Journal entry cannot be moved to another journal');
    }
    if (!Number.isFinite(this.debit) || !Number.isFinite(this.credit))
      throw new Error('Entry amounts must be finite');
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
    if (!!this.counterpartyKind !== !!this.counterpartyId)
      throw new Error('Counterparty kind and ID must be provided together');
    if (this.dueDate && (!this.counterpartyKind || !this.counterpartyId))
      throw new Error('Due date requires a counterparty');
  }

  async delete(
    options: Parameters<SmrtObject['delete']>[0] = {},
  ): Promise<void> {
    await this.withTransaction(async () => {
      const stored = this.id
        ? await this.db.get(this.tableName, { id: this.id })
        : null;
      if (stored) {
        const { JournalCollection } = await import('../collections/Journals');
        const journal = await (
          await JournalCollection.create({ db: this.db })
        ).get({ id: String(stored.journal_id) });
        if (journal?.ledgerId) {
          if (!journal.isDraft() || !journal.updated_at)
            throw new Error('Ledger entries are immutable after posting');
          await journal.claimRevision(journal.updated_at);
        }
      }
      await super.delete(options);
    });
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
    const collection = await JournalCollection.create(this.options);
    return await collection.get({ id: this.journalId }, { cache: false });
  }

  /**
   * Get the account
   */
  async getAccount(): Promise<import('./Account').Account | null> {
    if (!this.accountId) return null;
    const { AccountCollection } = await import('../collections/Accounts');
    const collection = await AccountCollection.create(this.options);
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
