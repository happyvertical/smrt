import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { AccountCollection } from '../../collections/Accounts.js';
import { JournalEntryCollection } from '../../collections/JournalEntries.js';
import { JournalCollection } from '../../collections/Journals.js';

interface PostedFixture {
  accountId: string;
  entryId: string;
}

async function addJournal(
  db: DatabaseInterface,
  tenantId: string,
  options: {
    date: Date;
    sourceModule: string;
    status: 'posted' | 'draft' | 'voided';
  },
): Promise<PostedFixture> {
  return withTenant({ tenantId }, async () => {
    const accounts = await AccountCollection.create({ db });
    const journals = await JournalCollection.create({ db });
    const entries = await JournalEntryCollection.create({ db });
    const liability = await accounts.create({
      number: `2000-${randomUUID().slice(0, 8)}`,
      name: 'Tax payable',
      type: 'liability',
    });
    await liability.save();
    const clearing = await accounts.create({
      number: `1000-${randomUUID().slice(0, 8)}`,
      name: 'Clearing',
      type: 'asset',
    });
    await clearing.save();
    const journal = await journals.createWithEntries({
      date: options.date,
      description: 'Tax movement fixture',
      sourceModule: options.sourceModule,
      sourceRef: 'fixture',
      entries: [
        { accountId: String(clearing.id), debit: 125 },
        { accountId: String(liability.id), credit: 125 },
      ],
    });
    if (options.status !== 'draft') await journal.post();
    if (options.status === 'voided') await journal.void('fixture correction');
    const entry = (await entries.findByJournal(String(journal.id))).find(
      (item) => item.accountId === liability.id,
    );
    if (!entry?.id || !liability.id)
      throw new Error('expected persisted fixture entry');
    return { accountId: liability.id, entryId: entry.id };
  });
}

/** Contract shared by the SQLite and PostgreSQL reporting-input lanes. */
export function definePostedMovementsSuite(getDb: () => DatabaseInterface) {
  describe('posted journal movements', () => {
    it('returns every posted source including manual journals, never drafts, voids, or another tenant', async () => {
      enableTenancy();
      const db = getDb();
      const tenantId = randomUUID();
      const foreignTenantId = randomUUID();
      const date = new Date('2026-09-15T12:00:00.000Z');
      const manual = await addJournal(db, tenantId, {
        date,
        sourceModule: 'manual',
        status: 'posted',
      });
      const commerce = await addJournal(db, tenantId, {
        date,
        sourceModule: 'smrt-commerce',
        status: 'posted',
      });
      const draft = await addJournal(db, tenantId, {
        date,
        sourceModule: 'manual',
        status: 'draft',
      });
      const voided = await addJournal(db, tenantId, {
        date,
        sourceModule: 'manual',
        status: 'voided',
      });
      const foreign = await addJournal(db, foreignTenantId, {
        date,
        sourceModule: 'manual',
        status: 'posted',
      });
      const entries = await JournalEntryCollection.create({ db });
      const movements = await entries.listPostedMovements({
        tenantId,
        accountIds: [
          manual.accountId,
          commerce.accountId,
          draft.accountId,
          voided.accountId,
          foreign.accountId,
        ],
        currency: 'USD',
        from: new Date('2026-09-01T00:00:00.000Z'),
        to: new Date('2026-09-30T23:59:59.999Z'),
      });
      expect(movements).toHaveLength(2);
      expect(movements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tenantId,
            entryId: manual.entryId,
            accountId: manual.accountId,
            sourceModule: 'manual',
            debit: 0,
            credit: 125,
            creditMinusDebit: 125,
          }),
          expect.objectContaining({
            tenantId,
            entryId: commerce.entryId,
            accountId: commerce.accountId,
            sourceModule: 'smrt-commerce',
            debit: 0,
            credit: 125,
            creditMinusDebit: 125,
          }),
        ]),
      );
    });

    it('bounds account lists and rejects unsafe raw stored units', async () => {
      enableTenancy();
      const db = getDb();
      const tenantId = randomUUID();
      const fixture = await addJournal(db, tenantId, {
        date: new Date('2026-09-15T12:00:00.000Z'),
        sourceModule: 'manual',
        status: 'posted',
      });
      const entries = await JournalEntryCollection.create({ db });
      await expect(
        entries.listPostedMovements({
          tenantId,
          accountIds: Array.from(
            { length: 1_001 },
            (_, index) => `account-${index}`,
          ),
          currency: 'USD',
          from: new Date('2026-09-01T00:00:00.000Z'),
          to: new Date('2026-09-30T23:59:59.999Z'),
        }),
      ).rejects.toThrow(/at most/);
      await db.query(
        'UPDATE journal_entries SET credit = ? WHERE id = ?',
        Number.MAX_SAFE_INTEGER + 1,
        fixture.entryId,
      );
      await expect(
        entries.listPostedMovements({
          tenantId,
          accountIds: [fixture.accountId],
          currency: 'USD',
          from: new Date('2026-09-01T00:00:00.000Z'),
          to: new Date('2026-09-30T23:59:59.999Z'),
        }),
      ).rejects.toThrow(/supported numeric range/);
      disableTenancy();
    });
  });
}
