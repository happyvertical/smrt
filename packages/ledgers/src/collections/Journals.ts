/**
 * JournalCollection - Collection manager for Journal objects
 *
 * Provides querying and operations for financial journals.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Journal } from '../models/Journal';
import {
  BALANCE_EPSILON,
  type CreateJournalData,
  type JournalStatus,
} from '../types';

export class JournalCollection extends SmrtCollection<Journal> {
  static readonly _itemClass = Journal;

  /**
   * Generate next journal number
   *
   * Uses timestamp and random component to avoid collisions
   * in concurrent environments without relying on shared state.
   */
  private generateJournalNumber(): string {
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 6);
    return `JNL-${timestamp}-${randomPart}`;
  }

  /**
   * Find journal by number
   *
   * @param number - Journal number
   * @returns Journal or null
   */
  async findByNumber(number: string): Promise<Journal | null> {
    const journals = await this.list({
      where: { number },
      limit: 1,
    });
    return journals[0] || null;
  }

  /**
   * Find journals by date range
   *
   * @param start - Start date
   * @param end - End date
   * @returns Array of journals
   */
  async findByDateRange(start: Date, end: Date): Promise<Journal[]> {
    return await this.list({
      where: {
        'date >=': start.toISOString(),
        'date <=': end.toISOString(),
      },
      orderBy: 'date ASC',
    });
  }

  /**
   * Find journals by source module
   *
   * @param sourceModule - Source module name
   * @returns Array of journals
   */
  async findBySource(sourceModule: string): Promise<Journal[]> {
    return await this.list({
      where: { sourceModule },
      orderBy: 'date DESC',
    });
  }

  /**
   * Find journals by status
   *
   * @param status - Journal status
   * @returns Array of journals
   */
  async findByStatus(status: JournalStatus): Promise<Journal[]> {
    return await this.list({
      where: { status },
      orderBy: 'date DESC',
    });
  }

  /**
   * Find draft journals
   *
   * @returns Array of draft journals
   */
  async findDrafts(): Promise<Journal[]> {
    return await this.findByStatus('draft');
  }

  /**
   * Find posted journals
   *
   * @returns Array of posted journals
   */
  async findPosted(): Promise<Journal[]> {
    return await this.findByStatus('posted');
  }

  /**
   * Create a complete journal with entries
   *
   * @param data - Journal data with entries
   * @returns Created journal
   */
  async createWithEntries(data: CreateJournalData): Promise<Journal> {
    // Validate entries balance
    let totalDebits = 0;
    let totalCredits = 0;

    for (const entry of data.entries) {
      totalDebits += entry.debit || 0;
      totalCredits += entry.credit || 0;
    }

    if (Math.abs(totalDebits - totalCredits) >= BALANCE_EPSILON) {
      throw new Error(
        `Entries are not balanced. Debits: ${totalDebits}, Credits: ${totalCredits}`,
      );
    }

    if (data.entries.length === 0) {
      throw new Error('Journal must have at least one entry');
    }

    // Create journal
    const journalNumber = await this.generateJournalNumber();
    const journal = await this.create({
      number: journalNumber,
      date: data.date || new Date(),
      description: data.description,
      sourceModule: data.sourceModule || 'manual',
      sourceRef: data.sourceRef || null,
      metadata: data.metadata || {},
    });
    await journal.save();

    // Create entries
    for (const entryData of data.entries) {
      await journal.addEntry(entryData);
    }

    return journal;
  }

  /**
   * Post a journal by ID
   *
   * @param journalId - Journal ID
   * @returns Posted journal
   */
  async post(journalId: string): Promise<Journal> {
    const journal = await this.get({ id: journalId });
    if (!journal) {
      throw new Error(`Journal not found: ${journalId}`);
    }
    await journal.post();
    return journal;
  }

  /**
   * Void a journal by ID
   *
   * @param journalId - Journal ID
   * @param reason - Reason for voiding
   * @returns Voided journal
   */
  async void(journalId: string, reason: string): Promise<Journal> {
    const journal = await this.get({ id: journalId });
    if (!journal) {
      throw new Error(`Journal not found: ${journalId}`);
    }
    await journal.void(reason);
    return journal;
  }

  /**
   * Find journals by source reference
   *
   * @param sourceRef - External reference
   * @returns Array of journals
   */
  async findBySourceRef(sourceRef: string): Promise<Journal[]> {
    return await this.list({
      where: { sourceRef },
      orderBy: 'date DESC',
    });
  }

  /**
   * Get journals for a specific month
   *
   * @param year - Year
   * @param month - Month (1-12)
   * @returns Array of journals
   */
  async findByMonth(year: number, month: number): Promise<Journal[]> {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59, 999);
    return await this.findByDateRange(start, end);
  }
}
