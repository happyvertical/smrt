/**
 * Integration tests for the messages COLLECTION classes (coverage gate #1411).
 *
 * Every test runs against a REAL in-memory SQLite database created from the
 * registered model schemas via `getTestDatabase()`. We never mock the DB,
 * collections, or models — only public query/helper methods are exercised.
 *
 * Schema note
 * -----------
 * `getTestDatabase()` builds its schema from the classes registered in
 * `ObjectRegistry`. We import every model the collections touch (Account /
 * EmailAccount / Message / Email / Attachment) so the `accounts`, `messages`,
 * and `attachments` tables exist when tests run this file in isolation.
 *
 * Dedup note
 * ----------
 * Base Account / Message rows have no name-derived slug, so distinct names are
 * not strictly required — but we still use distinct, meaningful field values so
 * each assertion targets exactly the rows it intends.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AccountCollection,
  AttachmentCollection,
  EmailAccountCollection,
  EmailCollection,
  MessageCollection,
} from '../index.js';
// Importing the models registers their schemas so getTestDatabase() creates
// the underlying tables.
import { Account } from '../models/Account';
import { Attachment } from '../models/Attachment';
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { Message } from '../models/Message';

// ---------------------------------------------------------------------------
// Persistence helper — initialize() then save() is the supported write path.
// ---------------------------------------------------------------------------

async function persist<
  T extends { initialize(): Promise<any>; save(): Promise<any> },
>(model: T): Promise<T> {
  await model.initialize();
  await model.save();
  return model;
}

// ===========================================================================
// MessageCollection
// ===========================================================================

describe('MessageCollection', () => {
  let db: DatabaseInterface;
  let col: MessageCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    col = await MessageCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  /** Seed a representative set of messages (base Message + STI Email rows). */
  async function seed() {
    // Base messages on account A
    await persist(
      new Message({
        db,
        accountId: 'acct-A',
        subject: 'Quarterly report',
        body: 'numbers inside',
        fromAddress: 'boss@corp.com',
        fromName: 'The Boss',
        toAddresses: JSON.stringify([{ address: 'me@corp.com' }]),
        threadId: 'thread-1',
        isRead: false,
        isFlagged: true,
        sendStatus: 'sent',
        date: new Date('2025-03-01'),
      }),
    );
    await persist(
      new Message({
        db,
        accountId: 'acct-A',
        subject: 'Lunch?',
        body: 'wanna grab lunch',
        fromAddress: 'pal@friend.com',
        threadId: 'thread-2',
        isRead: true,
        sendStatus: 'draft',
        date: new Date('2025-03-05'),
      }),
    );
    // STI Email row on account B, also unread/flagged
    await persist(
      new Email({
        db,
        accountId: 'acct-B',
        subject: 'Newsletter',
        body: 'weekly digest',
        fromAddress: 'news@list.com',
        threadId: 'thread-1',
        isRead: false,
        isFlagged: false,
        sendStatus: 'scheduled',
        date: new Date('2025-03-10'),
      }),
    );
  }

  it('search() matches query across subject/body/from and applies filters', async () => {
    await seed();

    expect(await col.search('quarterly')).toHaveLength(1);
    expect(await col.search('boss')).toHaveLength(1); // fromName/fromAddress
    expect(await col.search('')).toHaveLength(3); // empty query => all

    const onAcctA = await col.search('', { accountIds: ['acct-A'] });
    expect(onAcctA).toHaveLength(2);

    const emailsOnly = await col.search('', { messageType: 'Email' });
    expect(emailsOnly).toHaveLength(1);
    expect(emailsOnly[0].subject).toBe('Newsletter');

    const unread = await col.search('', { isRead: false });
    expect(unread).toHaveLength(2);

    const flagged = await col.search('', { isFlagged: true });
    expect(flagged).toHaveLength(1);

    const fromFiltered = await col.search('', { from: 'news@list.com' });
    expect(fromFiltered).toHaveLength(1);

    const toFiltered = await col.search('', { to: 'me@corp.com' });
    expect(toFiltered).toHaveLength(1);

    const sinceFiltered = await col.search('', {
      sinceDate: new Date('2025-03-04'),
    });
    expect(sinceFiltered).toHaveLength(2);

    const beforeFiltered = await col.search('', {
      beforeDate: new Date('2025-03-04'),
    });
    expect(beforeFiltered).toHaveLength(1);

    const innerQuery = await col.search('', { query: 'digest' });
    expect(innerQuery).toHaveLength(1);
  });

  it('getByAccounts() returns messages across the given account ids', async () => {
    await seed();
    expect(await col.getByAccounts(['acct-A'])).toHaveLength(2);
    expect(await col.getByAccounts(['acct-A', 'acct-B'])).toHaveLength(3);
    expect(await col.getByAccounts(['nope'])).toHaveLength(0);
  });

  it('getByType() resolves both short names and full discriminators', async () => {
    await seed();
    const byShort = await col.getByType('Email');
    expect(byShort).toHaveLength(1);

    const byFull = await col.getByType('@happyvertical/smrt-messages:Email');
    expect(byFull).toHaveLength(1);

    expect(await col.getByType('Tweet')).toHaveLength(0);
  });

  it('getUnread() and getFlagged() filter with optional account scope', async () => {
    await seed();
    expect(await col.getUnread()).toHaveLength(2);
    expect(await col.getUnread('acct-A')).toHaveLength(1);
    expect(await col.getFlagged()).toHaveLength(1);
    expect(await col.getFlagged('acct-B')).toHaveLength(0);
  });

  it('getRecent() returns newest-first and honours the limit', async () => {
    await seed();
    const recent = await col.getRecent(2);
    expect(recent).toHaveLength(2);
    // Newest date first: 2025-03-10 (Newsletter) then 2025-03-05 (Lunch?)
    expect(recent[0].subject).toBe('Newsletter');
    expect(recent[1].subject).toBe('Lunch?');

    const recentA = await col.getRecent(20, 'acct-A');
    expect(recentA).toHaveLength(2);
  });

  it('getByThread() groups messages sharing a threadId', async () => {
    await seed();
    expect(await col.getByThread('thread-1')).toHaveLength(2);
    expect(await col.getByThread('thread-2')).toHaveLength(1);
  });

  it('markAllRead() marks each id as read', async () => {
    await seed();
    const unread = await col.getUnread();
    const ids = unread.map((m) => m.id as string);
    await col.markAllRead(ids);
    expect(await col.getUnread()).toHaveLength(0);
  });

  it('markAllRead() ignores ids that do not resolve to a message', async () => {
    await seed();
    await expect(col.markAllRead(['does-not-exist'])).resolves.toBeUndefined();
  });

  it('getAccountStats() tallies totals, unread, flagged, and byType', async () => {
    await seed();
    const stats = await col.getAccountStats('acct-A');
    expect(stats.total).toBe(2);
    expect(stats.unread).toBe(1);
    expect(stats.flagged).toBe(1);
    expect(stats.byType.Message).toBe(2);
  });

  it('send-status queries return the matching rows', async () => {
    await seed();
    expect(await col.getDrafts()).toHaveLength(1);
    expect(await col.getDrafts('acct-A')).toHaveLength(1);
    expect(await col.getSent()).toHaveLength(1);
    expect(await col.getScheduled()).toHaveLength(1);
    expect(await col.getFailedSends()).toHaveLength(0);
  });

  it('getOutbox() returns pending/sending/scheduled messages', async () => {
    await seed();
    // Only the scheduled Email qualifies from the seed set.
    const outbox = await col.getOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].sendStatus).toBe('scheduled');
    expect(await col.getOutbox('acct-A')).toHaveLength(0);
  });

  it('tenant helpers filter by tenant and globals', async () => {
    await persist(
      new Message({
        db,
        accountId: 'acct-T',
        subject: 'tenant',
        tenantId: 't1',
      }),
    );
    await persist(new Message({ db, accountId: 'acct-G', subject: 'global' }));

    expect(await col.findByTenant('t1')).toHaveLength(1);
    expect(await col.findGlobal()).toHaveLength(1);
    const withGlobals = await col.findWithGlobals('t1');
    expect(withGlobals).toHaveLength(2);
  });
});

// ===========================================================================
// EmailCollection (extends MessageCollection; STI auto-filters to Email)
// ===========================================================================

describe('EmailCollection', () => {
  let db: DatabaseInterface;
  let col: EmailCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    col = await EmailCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  async function seedEmails() {
    await persist(
      new Email({
        db,
        accountId: 'acct-A',
        folderId: 'folder-inbox',
        threadId: 'thr-1',
        messageId: '<a1@x>',
        subject: 'Invoice attached',
        textBody: 'see the pdf',
        fromAddress: 'billing@vendor.com',
        fromName: 'Vendor Billing',
        toAddresses: JSON.stringify([{ address: 'me@corp.com' }]),
        isRead: false,
        isFlagged: true,
        hasAttachments: true,
        date: new Date('2025-02-01'),
      }),
    );
    await persist(
      new Email({
        db,
        accountId: 'acct-A',
        folderId: 'folder-inbox',
        threadId: 'thr-2',
        messageId: '<a2@x>',
        subject: 'Re: Meeting',
        textBody: 'sounds good',
        fromAddress: 'pal@friend.com',
        isRead: true,
        isFlagged: false,
        hasAttachments: false,
        date: new Date('2025-02-10'),
      }),
    );
    await persist(
      new Email({
        db,
        accountId: 'acct-B',
        folderId: 'folder-archive',
        threadId: 'thr-1',
        messageId: '<b1@x>',
        subject: 'Archived note',
        textBody: 'old stuff',
        fromAddress: 'system@corp.com',
        isRead: false,
        isFlagged: false,
        hasAttachments: false,
        date: new Date('2025-01-15'),
      }),
    );
  }

  it('getByMessageId() finds a single email scoped by account', async () => {
    await seedEmails();
    const found = await col.getByMessageId('acct-A', '<a1@x>');
    expect(found?.subject).toBe('Invoice attached');
    expect(await col.getByMessageId('acct-A', '<missing@x>')).toBeNull();
    // Right messageId, wrong account => not found.
    expect(await col.getByMessageId('acct-B', '<a1@x>')).toBeNull();
  });

  it('getByAccount() / getByFolder() / getByThread() scope correctly', async () => {
    await seedEmails();
    expect(await col.getByAccount('acct-A')).toHaveLength(2);
    expect(await col.getByFolder('folder-inbox')).toHaveLength(2);
    expect(await col.getByThread('thr-1')).toHaveLength(2);
  });

  it('getUnread() / getFlagged() / getWithAttachments() filter by flag', async () => {
    await seedEmails();
    expect(await col.getUnread()).toHaveLength(2);
    expect(await col.getUnread('acct-A')).toHaveLength(1);
    expect(await col.getFlagged()).toHaveLength(1);
    expect(await col.getWithAttachments()).toHaveLength(1);
    expect(await col.getWithAttachments('acct-B')).toHaveLength(0);
  });

  it('getRecent() returns newest-first', async () => {
    await seedEmails();
    const recent = await col.getRecent(2);
    expect(recent[0].subject).toBe('Re: Meeting'); // 2025-02-10
    expect(recent).toHaveLength(2);
  });

  it('counts by folder and account', async () => {
    await seedEmails();
    expect(await col.countByFolder('folder-inbox')).toBe(2);
    expect(await col.countUnreadByFolder('folder-inbox')).toBe(1);
    expect(await col.countUnreadByAccount('acct-A')).toBe(1);
  });

  it('searchEmails() applies query plus the full filter surface', async () => {
    await seedEmails();
    expect(await col.searchEmails('invoice')).toHaveLength(1);
    expect(await col.searchEmails('vendor billing')).toHaveLength(1); // fromName

    const filtered = await col.searchEmails('', {
      accountId: 'acct-A',
      isRead: false,
      isFlagged: true,
      hasAttachments: true,
      folderId: 'folder-inbox',
      threadId: 'thr-1',
      from: 'billing@vendor.com',
      to: 'me@corp.com',
      subject: 'invoice',
    });
    expect(filtered).toHaveLength(1);

    const dated = await col.searchEmails('', {
      sincDate: new Date('2025-02-05'),
      beforeDate: new Date('2025-03-01'),
    });
    expect(dated).toHaveLength(1);
    expect(dated[0].subject).toBe('Re: Meeting');
  });

  it('search() aliases searchEmails()', async () => {
    await seedEmails();
    expect(await col.search('archived')).toHaveLength(1);
  });

  it('markFolderRead() marks all unread emails in a folder read', async () => {
    await seedEmails();
    await col.markFolderRead('folder-inbox');
    expect(await col.countUnreadByFolder('folder-inbox')).toBe(0);
    // The archive folder is untouched.
    expect(await col.getByFolder('folder-archive')).toHaveLength(1);
  });

  it('deleteByFolder() removes and counts emails in a folder', async () => {
    await seedEmails();
    const deleted = await col.deleteByFolder('folder-inbox');
    expect(deleted).toBe(2);
    expect(await col.getByFolder('folder-inbox')).toHaveLength(0);
    expect(await col.getByFolder('folder-archive')).toHaveLength(1);
  });

  it('getAccountStats() summarizes the account', async () => {
    await seedEmails();
    const stats = await col.getAccountStats('acct-A');
    expect(stats.total).toBe(2);
    expect(stats.unread).toBe(1);
    expect(stats.flagged).toBe(1);
    expect(stats.withAttachments).toBe(1);
    expect(stats.byType.Email).toBe(2);
  });

  it('tenant helpers filter by tenant and globals', async () => {
    await persist(
      new Email({
        db,
        accountId: 'acct-T',
        messageId: '<t@x>',
        tenantId: 't1',
      }),
    );
    await persist(new Email({ db, accountId: 'acct-G', messageId: '<g@x>' }));
    expect(await col.findByTenant('t1')).toHaveLength(1);
    expect(await col.findGlobal()).toHaveLength(1);
    expect(await col.findWithGlobals('t1')).toHaveLength(2);
  });
});

// ===========================================================================
// AccountCollection
// ===========================================================================

describe('AccountCollection', () => {
  let db: DatabaseInterface;
  let col: AccountCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    col = await AccountCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  async function seedAccounts() {
    await persist(
      new Account({
        db,
        name: 'Acme IMAP',
        providerType: 'imap',
        isActive: true,
      }),
    );
    await persist(
      new Account({
        db,
        name: 'Beta SMTP',
        providerType: 'smtp',
        isActive: false,
      }),
    );
    // An EmailAccount STI row to exercise getByType discriminator filtering.
    await persist(
      new EmailAccount({
        db,
        name: 'Gamma Gmail',
        email: 'gamma@gmail.com',
        providerType: 'gmail',
        isActive: true,
      }),
    );
  }

  it('getActive() / getInactive() filter on isActive', async () => {
    await seedAccounts();
    expect(await col.getActive()).toHaveLength(2);
    expect(await col.getInactive()).toHaveLength(1);
  });

  it('getByProviderType() filters on providerType', async () => {
    await seedAccounts();
    expect(await col.getByProviderType('imap')).toHaveLength(1);
    expect(await col.getByProviderType('gmail')).toHaveLength(1);
    expect(await col.getByProviderType('pop3')).toHaveLength(0);
  });

  it('getByType() resolves short names and full discriminators', async () => {
    await seedAccounts();
    expect(await col.getByType('EmailAccount')).toHaveLength(1);
    expect(
      await col.getByType('@happyvertical/smrt-messages:Account'),
    ).toHaveLength(2);
    expect(await col.getByType('Account')).toHaveLength(2);
  });

  it('search() filters by query, providerType, isActive, accountType', async () => {
    await seedAccounts();
    expect(await col.search('acme')).toHaveLength(1);
    expect(await col.search('', { providerType: 'smtp' })).toHaveLength(1);
    expect(await col.search('', { isActive: true })).toHaveLength(2);
    expect(await col.search('', { accountType: 'EmailAccount' })).toHaveLength(
      1,
    );
  });

  it('getStats() tallies totals/active/inactive and byType', async () => {
    await seedAccounts();
    const stats = await col.getStats();
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(2);
    expect(stats.inactive).toBe(1);
    expect(stats.byType.Account).toBe(2);
    expect(stats.byType.EmailAccount).toBe(1);
  });

  it('tenant helpers filter by tenant and globals', async () => {
    await persist(
      new Account({
        db,
        name: 'Tenant Acct',
        providerType: 'imap',
        tenantId: 't1',
      }),
    );
    await persist(
      new Account({ db, name: 'Global Acct', providerType: 'imap' }),
    );
    expect(await col.findByTenant('t1')).toHaveLength(1);
    expect(await col.findGlobal()).toHaveLength(1);
    expect(await col.findWithGlobals('t1')).toHaveLength(2);
  });
});

// ===========================================================================
// EmailAccountCollection (extends AccountCollection)
// ===========================================================================

describe('EmailAccountCollection', () => {
  let db: DatabaseInterface;
  let col: EmailAccountCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    col = await EmailAccountCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  async function seedEmailAccounts() {
    await persist(
      new EmailAccount({
        db,
        name: 'Work IMAP',
        email: 'work@corp.com',
        providerType: 'imap',
        isActive: true,
        lastSyncAt: new Date('2020-01-01'), // very stale => needs sync
      }),
    );
    await persist(
      new EmailAccount({
        db,
        name: 'Personal Gmail',
        email: 'me@gmail.com',
        providerType: 'gmail',
        isActive: true,
        lastSyncAt: new Date(), // just synced => does not need sync
      }),
    );
    await persist(
      new EmailAccount({
        db,
        name: 'Old SMTP',
        email: 'old@smtp.com',
        providerType: 'smtp',
        isActive: false,
      }),
    );
  }

  it('getByEmail() finds an account by address', async () => {
    await seedEmailAccounts();
    const found = await col.getByEmail('work@corp.com');
    expect(found?.name).toBe('Work IMAP');
    expect(await col.getByEmail('nobody@nowhere.com')).toBeNull();
  });

  it('getByEmailProviderType() / getByProviderType() alias filter on type', async () => {
    await seedEmailAccounts();
    expect(await col.getByEmailProviderType('imap')).toHaveLength(1);
    expect(await col.getByProviderType('gmail')).toHaveLength(1);
  });

  it('getActive() / getInactive() return only email accounts in that state', async () => {
    await seedEmailAccounts();
    expect(await col.getActive()).toHaveLength(2);
    expect(await col.getInactive()).toHaveLength(1);
  });

  it('getNeedingSync() returns active accounts past the cutoff', async () => {
    await seedEmailAccounts();
    const needing = await col.getNeedingSync(60);
    // Work IMAP is stale, Personal Gmail just synced, Old SMTP is inactive.
    expect(needing).toHaveLength(1);
    expect(needing[0].email).toBe('work@corp.com');
  });

  it('searchEmailAccounts() / search() alias filter by query and fields', async () => {
    await seedEmailAccounts();
    expect(await col.search('work')).toHaveLength(1); // name match
    expect(await col.search('gmail')).toHaveLength(1); // email match
    expect(
      await col.searchEmailAccounts('', { providerType: 'imap' }),
    ).toHaveLength(1);
    expect(
      await col.searchEmailAccounts('', { email: 'corp.com' }),
    ).toHaveLength(1);
    expect(await col.searchEmailAccounts('', { isActive: false })).toHaveLength(
      1,
    );
  });

  it('getStats() / getEmailStats() tally totals and per-provider counts', async () => {
    await seedEmailAccounts();
    const emailStats = await col.getEmailStats();
    expect(emailStats.total).toBe(3);
    expect(emailStats.active).toBe(2);
    expect(emailStats.inactive).toBe(1);
    expect(emailStats.byProvider.imap).toBe(1);
    expect(emailStats.byProvider.gmail).toBe(1);
    expect(emailStats.byProvider.smtp).toBe(1);
    expect(emailStats.byProvider.pop3).toBe(0);

    const stats = await col.getStats();
    expect(stats.total).toBe(3);
    expect(stats.active).toBe(2);
    expect(stats.byType).toEqual(emailStats.byProvider as any);
  });

  it('getTotalUnreadCount() sums unread emails across active accounts', async () => {
    const account = await persist(
      new EmailAccount({
        db,
        name: 'Counter IMAP',
        email: 'counter@corp.com',
        providerType: 'imap',
        isActive: true,
      }),
    );
    // Two unread + one read email for this account.
    await persist(
      new Email({
        db,
        accountId: account.id,
        messageId: '<c1@x>',
        isRead: false,
      }),
    );
    await persist(
      new Email({
        db,
        accountId: account.id,
        messageId: '<c2@x>',
        isRead: false,
      }),
    );
    await persist(
      new Email({
        db,
        accountId: account.id,
        messageId: '<c3@x>',
        isRead: true,
      }),
    );

    expect(await col.getTotalUnreadCount()).toBe(2);
  });

  it('syncAll() reports a per-account result map', async () => {
    // Each account's syncFrom() will fail internally (no real IMAP), but
    // EmailAccount.syncFrom swallows its own errors and returns a result, so
    // syncAll records success per active account. We assert the shape/scope.
    await seedEmailAccounts();
    const results = await col.syncAll();
    // Only the two active accounts are synced.
    expect(results.size).toBe(2);
    for (const outcome of results.values()) {
      expect(typeof outcome.success).toBe('boolean');
    }
  });

  it('tenant helpers filter by tenant and globals', async () => {
    await persist(
      new EmailAccount({
        db,
        name: 'Tenant Email',
        email: 'tenant@corp.com',
        providerType: 'imap',
        tenantId: 't1',
      }),
    );
    await persist(
      new EmailAccount({
        db,
        name: 'Global Email',
        email: 'global@corp.com',
        providerType: 'imap',
      }),
    );
    expect(await col.findByTenant('t1')).toHaveLength(1);
    expect(await col.findGlobal()).toHaveLength(1);
    expect(await col.findWithGlobals('t1')).toHaveLength(2);
  });
});

// ===========================================================================
// AttachmentCollection
// ===========================================================================

describe('AttachmentCollection', () => {
  let db: DatabaseInterface;
  let col: AttachmentCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    col = await AttachmentCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') await db.close();
  });

  async function seedAttachments() {
    await persist(
      new Attachment({
        db,
        messageId: 'msg-1',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        size: 2048,
        contentDisposition: 'attachment',
        filePath: '/tmp/report.pdf',
      }),
    );
    await persist(
      new Attachment({
        db,
        messageId: 'msg-1',
        filename: 'logo.png',
        contentType: 'image/png',
        size: 512,
        contentDisposition: 'inline',
        contentId: 'logo123',
      }),
    );
    await persist(
      new Attachment({
        db,
        messageId: 'msg-2',
        filename: 'archive.zip',
        contentType: 'application/zip',
        size: 4096,
        contentDisposition: 'attachment',
      }),
    );
  }

  it('getByMessage() / getByContentType() scope correctly', async () => {
    await seedAttachments();
    expect(await col.getByMessage('msg-1')).toHaveLength(2);
    expect(await col.getByMessage('msg-2')).toHaveLength(1);
    expect(await col.getByContentType('image/png')).toHaveLength(1);
  });

  it('type predicates filter images, pdfs, inline, and regular', async () => {
    await seedAttachments();
    expect(await col.getImages()).toHaveLength(1);
    expect(await col.getImages('msg-1')).toHaveLength(1);
    expect(await col.getImages('msg-2')).toHaveLength(0);
    expect(await col.getPdfs()).toHaveLength(1);
    expect(await col.getPdfs('msg-1')).toHaveLength(1);
    expect(await col.getInline('msg-1')).toHaveLength(1);
    expect(await col.getRegular('msg-1')).toHaveLength(1);
  });

  it('getWithExternalFiles() returns attachments with a filePath', async () => {
    await seedAttachments();
    const external = await col.getWithExternalFiles();
    expect(external).toHaveLength(1);
    expect(external[0].filename).toBe('report.pdf');
  });

  it('getTotalSize() sums sizes for a message', async () => {
    await seedAttachments();
    expect(await col.getTotalSize('msg-1')).toBe(2560); // 2048 + 512
    expect(await col.getTotalSize('msg-2')).toBe(4096);
  });

  it('getLargest() returns attachments sorted by size desc', async () => {
    await seedAttachments();
    const largest = await col.getLargest(2);
    expect(largest).toHaveLength(2);
    expect(largest[0].size).toBe(4096);
    expect(largest[1].size).toBe(2048);
  });

  it('searchByFilename() / getByExtension() match filename patterns', async () => {
    await seedAttachments();
    expect(await col.searchByFilename('report')).toHaveLength(1);
    expect(await col.searchByFilename('.png')).toHaveLength(1);
    expect(await col.getByExtension('pdf')).toHaveLength(1);
    expect(await col.getByExtension('.png')).toHaveLength(1); // leading dot stripped
    expect(await col.getByExtension('docx')).toHaveLength(0);
  });

  it('getStats() summarizes count, size, byType, inline/regular', async () => {
    await seedAttachments();
    const stats = await col.getStats();
    expect(stats.total).toBe(3);
    expect(stats.totalSize).toBe(6656); // 2048 + 512 + 4096
    expect(stats.inline).toBe(1);
    expect(stats.regular).toBe(2);
    expect(stats.byType.application).toBe(2); // pdf + zip
    expect(stats.byType.image).toBe(1);
  });

  it('deleteByMessage() removes and counts a message’s attachments', async () => {
    await seedAttachments();
    const deleted = await col.deleteByMessage('msg-1');
    expect(deleted).toBe(2);
    expect(await col.getByMessage('msg-1')).toHaveLength(0);
    expect(await col.getByMessage('msg-2')).toHaveLength(1);
  });

  it('tenant helpers filter by tenant and globals', async () => {
    await persist(
      new Attachment({
        db,
        messageId: 'msg-T',
        filename: 't.txt',
        tenantId: 't1',
      }),
    );
    await persist(
      new Attachment({ db, messageId: 'msg-G', filename: 'g.txt' }),
    );
    expect(await col.findByTenant('t1')).toHaveLength(1);
    expect(await col.findGlobal()).toHaveLength(1);
    expect(await col.findWithGlobals('t1')).toHaveLength(2);
  });
});
