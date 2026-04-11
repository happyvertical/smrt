/**
 * Journal model tests
 *
 * Tests for:
 * 1. Journal CRUD operations
 * 2. Journal status management
 * 3. Journal entries
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

describe('Journal', () => {
  let dbPath: string;
  let accounts: AccountCollection;
  let journals: JournalCollection;
  let entries: JournalEntryCollection;
  let cashAccount: Account;
  let revenueAccount: Account;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `smrt-journal-test-${Date.now()}.db`);
    accounts = await AccountCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    journals = await JournalCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    entries = await JournalEntryCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });

    // Create test accounts
    cashAccount = await accounts.create({
      number: '1000',
      name: 'Cash',
      type: 'asset',
    });
    await cashAccount.save();

    revenueAccount = await accounts.create({
      number: '4000',
      name: 'Sales Revenue',
      type: 'revenue',
    });
    await revenueAccount.save();
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

  describe('Basic CRUD Operations', () => {
    it('should create a journal', async () => {
      const journal = await journals.create({
        description: 'Test journal',
        sourceModule: 'test',
      });

      expect(journal.id).toBeDefined();
      expect(journal.description).toBe('Test journal');
      expect(journal.status).toBe('draft');
    });

    it('should preserve data through save/load cycle', async () => {
      const journal = await journals.create({
        description: 'Test journal',
        sourceModule: 'manual',
        sourceRef: 'INV-001',
      });
      await journal.save();

      const loaded = await journals.get({ id: journal.id });
      expect(loaded).toBeDefined();
      expect(loaded?.description).toBe('Test journal');
      expect(loaded?.sourceModule).toBe('manual');
      expect(loaded?.sourceRef).toBe('INV-001');
      expect(loaded?.status).toBe('draft');
    });

    it('should generate journal numbers', async () => {
      const j1 = await journals.createWithEntries({
        description: 'First journal',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });

      const j2 = await journals.createWithEntries({
        description: 'Second journal',
        entries: [
          { accountId: cashAccount.id!, debit: 50 },
          { accountId: revenueAccount.id!, credit: 50 },
        ],
      });

      // Journal numbers use timestamp-based format: JNL-{timestamp}-{random}
      expect(j1.number).toMatch(/^JNL-[a-z0-9]+-[a-z0-9]+$/);
      expect(j2.number).toMatch(/^JNL-[a-z0-9]+-[a-z0-9]+$/);
      expect(j1.number).not.toBe(j2.number);
    });
  });

  describe('Journal Status', () => {
    it('should check draft status', async () => {
      const journal = await journals.create({
        description: 'Draft journal',
      });

      expect(journal.isDraft()).toBe(true);
      expect(journal.isPosted()).toBe(false);
      expect(journal.isVoided()).toBe(false);
      expect(journal.isEditable()).toBe(true);
    });

    it('should post a balanced journal', async () => {
      const journal = await journals.createWithEntries({
        description: 'Cash sale',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });

      await journal.post();

      expect(journal.isPosted()).toBe(true);
      expect(journal.isDraft()).toBe(false);
      expect(journal.isEditable()).toBe(false);
      expect(journal.postedAt).toBeDefined();
    });

    it('should void a journal', async () => {
      const journal = await journals.createWithEntries({
        description: 'To be voided',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });
      await journal.post();

      await journal.void('Error in entry');

      expect(journal.isVoided()).toBe(true);
      expect(journal.voidedAt).toBeDefined();
      expect(journal.voidReason).toBe('Error in entry');
    });

    it('should prevent posting unbalanced journal', async () => {
      const journal = await journals.create({
        description: 'Unbalanced',
      });
      await journal.save();

      // Add unbalanced entries
      await journal.addEntry({ accountId: cashAccount.id!, debit: 100 });
      await journal.addEntry({ accountId: revenueAccount.id!, credit: 50 });

      await expect(journal.post()).rejects.toThrow('not balanced');
    });

    it('should prevent posting empty journal', async () => {
      const journal = await journals.create({
        description: 'Empty',
      });
      await journal.save();

      await expect(journal.post()).rejects.toThrow('at least one entry');
    });

    it('should prevent modifying posted journal', async () => {
      const journal = await journals.createWithEntries({
        description: 'Posted',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });
      await journal.post();

      await expect(
        journal.addEntry({ accountId: cashAccount.id!, debit: 50 }),
      ).rejects.toThrow('posted or voided journal');
    });
  });

  describe('Journal Entries', () => {
    it('should add entries to journal', async () => {
      const journal = await journals.create({
        description: 'Test',
      });
      await journal.save();

      await journal.addEntry({ accountId: cashAccount.id!, debit: 100 });
      await journal.addEntry({ accountId: revenueAccount.id!, credit: 100 });

      const journalEntries = await journal.getEntries();
      expect(journalEntries).toHaveLength(2);
    });

    it('should calculate totals', async () => {
      const journal = await journals.createWithEntries({
        description: 'Multi-entry',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: cashAccount.id!, debit: 50 },
          { accountId: revenueAccount.id!, credit: 150 },
        ],
      });

      const debits = await journal.getTotalDebits();
      const credits = await journal.getTotalCredits();

      expect(debits).toBe(150);
      expect(credits).toBe(150);
    });

    it('should check if balanced', async () => {
      const journal = await journals.createWithEntries({
        description: 'Balanced',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });

      expect(await journal.isBalanced()).toBe(true);
    });
  });

  describe('Collection Queries', () => {
    it('should find journal by number', async () => {
      const journal = await journals.createWithEntries({
        description: 'Find me',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });

      const found = await journals.findByNumber(journal.number);
      expect(found).toBeDefined();
      expect(found?.id).toBe(journal.id);
    });

    it('should find journals by status', async () => {
      const draft = await journals.createWithEntries({
        description: 'Draft',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });

      const posted = await journals.createWithEntries({
        description: 'Posted',
        entries: [
          { accountId: cashAccount.id!, debit: 50 },
          { accountId: revenueAccount.id!, credit: 50 },
        ],
      });
      await posted.post();

      const drafts = await journals.findDrafts();
      const postedJournals = await journals.findPosted();

      expect(drafts).toHaveLength(1);
      expect(drafts[0].id).toBe(draft.id);
      expect(postedJournals).toHaveLength(1);
      expect(postedJournals[0].id).toBe(posted.id);
    });

    it('should find journals by source', async () => {
      await journals.createWithEntries({
        description: 'Commerce',
        sourceModule: 'smrt-commerce',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });

      await journals.createWithEntries({
        description: 'Manual',
        sourceModule: 'manual',
        entries: [
          { accountId: cashAccount.id!, debit: 50 },
          { accountId: revenueAccount.id!, credit: 50 },
        ],
      });

      const commerce = await journals.findBySource('smrt-commerce');
      expect(commerce).toHaveLength(1);
      expect(commerce[0].description).toBe('Commerce');
    });

    it('should find journals by date range', async () => {
      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      await journals.createWithEntries({
        description: 'Today',
        date: now,
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });

      const found = await journals.findByDateRange(yesterday, tomorrow);
      expect(found).toHaveLength(1);
    });
  });

  describe('Post and Void via Collection', () => {
    it('should post journal via collection', async () => {
      const journal = await journals.createWithEntries({
        description: 'Post me',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });

      const posted = await journals.post(journal.id!);
      expect(posted.isPosted()).toBe(true);
    });

    it('should void journal via collection', async () => {
      const journal = await journals.createWithEntries({
        description: 'Void me',
        entries: [
          { accountId: cashAccount.id!, debit: 100 },
          { accountId: revenueAccount.id!, credit: 100 },
        ],
      });
      await journal.post();

      const voided = await journals.void(journal.id!, 'Testing void');
      expect(voided.isVoided()).toBe(true);
      expect(voided.voidReason).toBe('Testing void');
    });
  });
});
