/**
 * Journal model - Financial event container
 *
 * Represents a single, discrete financial event.
 * Contains one or more JournalEntry records that must balance (debits = credits).
 */

import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  promptMessageOptions,
  smrtLedgersJournalSummarizePrompt,
} from '../prompts';
import {
  BALANCE_EPSILON,
  type JournalEntryData,
  type JournalOptions,
  type JournalStatus,
} from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create'] }, // No update/delete - immutable after posting
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Journal extends SmrtObject {
  /**
   * Tenant ID for multi-tenancy support (nullable for global journals)
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Journal number (auto-generated sequence, e.g., "JNL-0001")
   */
  number: string = '';

  /**
   * Transaction date
   */
  date: Date = new Date();

  /**
   * Description of the financial event
   */
  description: string = '';

  /**
   * Source module that created this journal (e.g., "smrt-commerce", "manual")
   */
  sourceModule: string = '';

  /**
   * External reference (e.g., order ID, invoice number)
   */
  sourceRef: string | null = null;

  /**
   * Journal status: draft, posted, voided
   */
  status: JournalStatus = 'draft';

  /**
   * When the journal was posted (finalized)
   */
  postedAt: Date | null = null;

  /**
   * When the journal was voided
   */
  voidedAt: Date | null = null;

  /**
   * Reason for voiding (if voided)
   */
  voidReason: string | null = null;

  /**
   * Extensible metadata
   */
  metadata: Record<string, unknown> = {};

  constructor(options: JournalOptions = {}) {
    super(options);
    if (options.number !== undefined) this.number = options.number;
    if (options.date !== undefined) this.date = options.date;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.sourceModule !== undefined)
      this.sourceModule = options.sourceModule;
    if (options.sourceRef !== undefined) this.sourceRef = options.sourceRef;
    if (options.status !== undefined) this.status = options.status;
    if (options.postedAt !== undefined) this.postedAt = options.postedAt;
    if (options.voidedAt !== undefined) this.voidedAt = options.voidedAt;
    if (options.voidReason !== undefined) this.voidReason = options.voidReason;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Check if journal is in draft status
   */
  isDraft(): boolean {
    return this.status === 'draft';
  }

  /**
   * Check if journal has been posted
   */
  isPosted(): boolean {
    return this.status === 'posted';
  }

  /**
   * Check if journal has been voided
   */
  isVoided(): boolean {
    return this.status === 'voided';
  }

  /**
   * Check if journal can be modified
   */
  isEditable(): boolean {
    return this.status === 'draft';
  }

  /**
   * Get all entries for this journal
   */
  async getEntries(): Promise<import('./JournalEntry').JournalEntry[]> {
    if (!this.id) return [];
    const { JournalEntryCollection } = await import(
      '../collections/JournalEntries'
    );
    const collection = await JournalEntryCollection.create(this.options);
    return await collection.findByJournal(this.id);
  }

  /**
   * Calculate total debits
   */
  async getTotalDebits(): Promise<number> {
    const entries = await this.getEntries();
    return entries.reduce((sum, entry) => sum + entry.debit, 0);
  }

  /**
   * Calculate total credits
   */
  async getTotalCredits(): Promise<number> {
    const entries = await this.getEntries();
    return entries.reduce((sum, entry) => sum + entry.credit, 0);
  }

  /**
   * Check if journal entries are balanced (debits = credits)
   */
  async isBalanced(): Promise<boolean> {
    const debits = await this.getTotalDebits();
    const credits = await this.getTotalCredits();
    return Math.abs(debits - credits) < BALANCE_EPSILON;
  }

  /**
   * Add an entry to this journal (only if draft)
   */
  async addEntry(data: JournalEntryData): Promise<void> {
    if (!this.id) {
      throw new Error('Journal must be saved before adding entries');
    }
    if (!this.isEditable()) {
      throw new Error('Cannot add entries to a posted or voided journal');
    }

    const { JournalEntryCollection } = await import(
      '../collections/JournalEntries'
    );
    const collection = await JournalEntryCollection.create(this.options);
    const entry = await collection.create({
      journalId: this.id,
      accountId: data.accountId,
      debit: data.debit || 0,
      credit: data.credit || 0,
      currency: data.currency || 'USD',
      exchangeRate: data.exchangeRate || 1.0,
      memo: data.memo || '',
    });
    await entry.save();
  }

  /**
   * Post the journal (finalize and make immutable)
   */
  async post(): Promise<void> {
    if (!this.isDraft()) {
      throw new Error('Only draft journals can be posted');
    }

    const balanced = await this.isBalanced();
    if (!balanced) {
      const debits = await this.getTotalDebits();
      const credits = await this.getTotalCredits();
      throw new Error(
        `Journal is not balanced. Debits: ${debits}, Credits: ${credits}`,
      );
    }

    const entries = await this.getEntries();
    if (entries.length === 0) {
      throw new Error('Journal must have at least one entry');
    }

    this.status = 'posted';
    this.postedAt = new Date();
    await this.save();
  }

  /**
   * Void the journal (mark as cancelled with reason)
   */
  async void(reason: string): Promise<void> {
    if (this.isVoided()) {
      throw new Error('Journal is already voided');
    }

    this.status = 'voided';
    this.voidedAt = new Date();
    this.voidReason = reason;
    await this.save();
  }

  /**
   * AI-powered: Generate a summary of this journal.
   *
   * Uses the `smrtLedgers.journal.summarize` prompt registered via
   * `@happyvertical/smrt-prompts`, allowing tenant- or instance-level
   * overrides of the template, model, and parameters at runtime.
   *
   * Only non-PII journal fields (number, date, description, status, balanced
   * flag) plus aggregate totals and entry count are sent to the AI provider.
   * Internal foreign-key fields (tenantId, sourceRef, individual entry
   * account IDs) and the extensible `metadata` blob are intentionally
   * excluded.
   *
   * @returns Generated summary text
   */
  async summarize(): Promise<string> {
    const entries = await this.getEntries();
    const debits = await this.getTotalDebits();
    const balanced = await this.isBalanced();

    // Resolve `db` from either the canonical `db` option or its `persistence`
    // alias. SmrtClass maps `persistence → db` lazily during `initialize()`,
    // so on a freshly-constructed Journal that has not yet been initialized,
    // `this.options.db` may be undefined while `this.options.persistence` is
    // set. Falling back here ensures stored app- and tenant-level prompt
    // overrides in `_smrt_prompt_overrides` are honored on the first call —
    // before `getAiClient()` triggers full initialization further below.
    const db = this.options.db ?? this.options.persistence;

    const resolvedPrompt = await resolvePrompt(
      smrtLedgersJournalSummarizePrompt.key,
      {
        db,
        tenantId: this.tenantId,
        variables: {
          journalNumber: this.number || '',
          journalDate: this.date.toISOString().split('T')[0],
          journalDescription: this.description || '',
          journalStatus: this.status || '',
          // Currency prefix folded into the value rather than the template
          // — see the `smrtLedgersJournalSummarizePrompt` comment block.
          journalTotal: `$${debits.toFixed(2)}`,
          entryCount: String(entries.length),
          journalBalanced: balanced ? 'Yes' : 'No',
        },
      },
    );

    const ai = await this.getAiClient();
    const response = await ai.message(
      resolvedPrompt.text,
      promptMessageOptions(resolvedPrompt.ai),
    );

    return response.trim();
  }
}
