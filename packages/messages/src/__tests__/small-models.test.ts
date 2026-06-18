/**
 * Tests for the small / previously-untested models:
 * Whitelist, Blacklist, EmailFolder, EmailAttachment.
 *
 * Uses real in-memory SQLite (getTestDatabase) for persistence so these
 * modules enter the coverage report. External APIs are never mocked here —
 * these models only touch the database and pure logic.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlacklistCollection } from '../collections/BlacklistCollection';
import { EmailFolderCollection } from '../collections/EmailFolderCollection';
import { WhitelistCollection } from '../collections/WhitelistCollection';
import { Blacklist } from '../models/Blacklist';
import { EmailAttachment } from '../models/EmailAttachment';
import { EmailFolder } from '../models/EmailFolder';
import { Whitelist } from '../models/Whitelist';

let db: DatabaseInterface;

beforeEach(async () => {
  db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
});

afterEach(async () => {
  if (db && typeof db.close === 'function') {
    await db.close();
  }
});

// ============================================================================
// Whitelist
// ============================================================================

describe('Whitelist.matches()', () => {
  it('matches an exact email (case-insensitive, trimmed)', () => {
    const entry = new Whitelist({ pattern: 'User@Example.com', type: 'email' });
    expect(entry.matches('  user@example.com  ')).toBe(true);
    expect(entry.matches('other@example.com')).toBe(false);
  });

  it('matches a domain pattern', () => {
    const entry = new Whitelist({ pattern: 'Example.com', type: 'domain' });
    expect(entry.matches('anyone@example.com')).toBe(true);
    expect(entry.matches('anyone@other.com')).toBe(false);
  });

  it('matches a regex pattern (case-insensitive)', () => {
    const entry = new Whitelist({
      pattern: '^vip-.*@corp\\.com$',
      type: 'regex',
    });
    expect(entry.matches('VIP-alice@corp.com')).toBe(true);
    expect(entry.matches('regular@corp.com')).toBe(false);
  });

  it('returns false for an empty regex pattern', () => {
    const entry = new Whitelist({ pattern: '   ', type: 'regex' });
    expect(entry.matches('anyone@corp.com')).toBe(false);
  });

  it('returns false for an invalid regex pattern', () => {
    const entry = new Whitelist({ pattern: '([', type: 'regex' });
    expect(entry.matches('anyone@corp.com')).toBe(false);
  });

  it('persists and round-trips through the collection', async () => {
    const collection = await (WhitelistCollection as any).create({ db });
    const entry = new Whitelist({
      pattern: 'allow@example.com',
      type: 'email',
      db,
    });
    entry.category = 'newsletter';
    entry.description = 'Trusted sender';
    await entry.initialize();
    await entry.save();

    const loaded = await collection.get({ id: entry.id });
    expect(loaded).not.toBeNull();
    expect(loaded.pattern).toBe('allow@example.com');
    expect(loaded.type).toBe('email');
    expect(loaded.category).toBe('newsletter');
    expect(loaded.description).toBe('Trusted sender');
  });

  it('collection.isWhitelisted respects category scoping', async () => {
    const collection = await (WhitelistCollection as any).create({ db });

    const scoped = new Whitelist({
      pattern: 'support@vendor.com',
      type: 'email',
      db,
    });
    scoped.category = 'billing';
    await scoped.initialize();
    await scoped.save();

    expect(await collection.isWhitelisted('support@vendor.com')).toBe(true);
    expect(
      await collection.isWhitelisted('support@vendor.com', 'billing'),
    ).toBe(true);
    expect(await collection.isWhitelisted('support@vendor.com', 'other')).toBe(
      false,
    );
    expect(await collection.isWhitelisted('nobody@vendor.com')).toBe(false);
  });
});

// ============================================================================
// Blacklist
// ============================================================================

describe('Blacklist.matches()', () => {
  it('matches an exact email', () => {
    const entry = new Blacklist({ pattern: 'spam@bad.com', type: 'email' });
    expect(entry.matches('SPAM@bad.com')).toBe(true);
    expect(entry.matches('ok@bad.com')).toBe(false);
  });

  it('matches a domain pattern', () => {
    const entry = new Blacklist({ pattern: 'spam.com', type: 'domain' });
    expect(entry.matches('anything@spam.com')).toBe(true);
    expect(entry.matches('anything@good.com')).toBe(false);
  });

  it('matches a regex pattern', () => {
    const entry = new Blacklist({ pattern: 'phish', type: 'regex' });
    expect(entry.matches('big-PHISH@bad.com')).toBe(true);
    expect(entry.matches('clean@bad.com')).toBe(false);
  });

  it('returns false for an empty or invalid regex', () => {
    expect(
      new Blacklist({ pattern: '', type: 'regex' }).matches('x@y.com'),
    ).toBe(false);
    expect(
      new Blacklist({ pattern: '(', type: 'regex' }).matches('x@y.com'),
    ).toBe(false);
  });

  it('defaults autoArchive to true', () => {
    expect(new Blacklist().autoArchive).toBe(true);
  });

  it('persists and is found via collection.isBlacklisted / getMatchingEntry', async () => {
    const collection = await (BlacklistCollection as any).create({ db });
    const entry = new Blacklist({
      pattern: 'evil.com',
      type: 'domain',
      db,
    });
    entry.reason = 'known spammer';
    await entry.initialize();
    await entry.save();

    expect(await collection.isBlacklisted('hacker@evil.com')).toBe(true);
    expect(await collection.isBlacklisted('friend@nice.com')).toBe(false);

    const match = await collection.getMatchingEntry('hacker@evil.com');
    expect(match).not.toBeNull();
    expect(match.reason).toBe('known spammer');

    const noMatch = await collection.getMatchingEntry('friend@nice.com');
    expect(noMatch).toBeNull();
  });
});

// ============================================================================
// EmailFolder
// ============================================================================

describe('EmailFolder special-folder predicates', () => {
  it('detects inbox by specialUse and by path', () => {
    expect(new EmailFolder({ specialUse: '\\Inbox' }).isInbox()).toBe(true);
    expect(new EmailFolder({ path: 'INBOX' }).isInbox()).toBe(true);
    expect(new EmailFolder({ path: 'Other' }).isInbox()).toBe(false);
  });

  it('detects sent / drafts / trash / spam folders', () => {
    expect(new EmailFolder({ specialUse: '\\Sent' }).isSent()).toBe(true);
    expect(new EmailFolder({ path: 'sent' }).isSent()).toBe(true);

    expect(new EmailFolder({ specialUse: '\\Drafts' }).isDrafts()).toBe(true);
    expect(new EmailFolder({ path: 'drafts' }).isDrafts()).toBe(true);

    expect(new EmailFolder({ specialUse: '\\Trash' }).isTrash()).toBe(true);
    expect(new EmailFolder({ path: 'trash' }).isTrash()).toBe(true);

    expect(new EmailFolder({ specialUse: '\\Junk' }).isSpam()).toBe(true);
    expect(new EmailFolder({ path: 'spam' }).isSpam()).toBe(true);
    expect(new EmailFolder({ path: 'junk' }).isSpam()).toBe(true);
  });

  it('detects system folders only when specialUse is set', () => {
    expect(new EmailFolder({ specialUse: '\\Inbox' }).isSystemFolder()).toBe(
      true,
    );
    expect(new EmailFolder({ name: 'Custom' }).isSystemFolder()).toBe(false);
  });

  it('returns null account when accountId is empty', async () => {
    const folder = new EmailFolder({ db });
    await folder.initialize();
    expect(await folder.getAccount()).toBeNull();
  });

  it('persists folder fields through the collection', async () => {
    const collection = await (EmailFolderCollection as any).create({ db });
    const folder = new EmailFolder({
      accountId: 'acct-1',
      name: 'Projects',
      path: 'Projects',
      delimiter: '/',
      messageCount: 7,
      unreadCount: 2,
      subscribed: true,
      db,
    });
    await folder.initialize();
    await folder.save();

    const loaded = await collection.get({ id: folder.id });
    expect(loaded.name).toBe('Projects');
    expect(loaded.path).toBe('Projects');
    expect(loaded.messageCount).toBe(7);
    expect(loaded.unreadCount).toBe(2);
    expect(loaded.subscribed).toBe(true);
  });

  it('subscribe()/unsubscribe() toggle and persist', async () => {
    const folder = new EmailFolder({
      accountId: 'acct-1',
      name: 'Archive',
      path: 'Archive',
      db,
    });
    await folder.initialize();
    await folder.save();

    await folder.unsubscribe();
    expect(folder.subscribed).toBe(false);

    await folder.subscribe();
    expect(folder.subscribed).toBe(true);

    const collection = await (EmailFolderCollection as any).create({ db });
    const loaded = await collection.get({ id: folder.id });
    expect(loaded.subscribed).toBe(true);
  });
});

describe('EmailFolderCollection queries', () => {
  // Helper: seed folders bound to the test db (createSystemFolders builds
  // folders without injecting the collection's db, so we seed explicitly).
  async function seedFolder(data: Record<string, any>) {
    const folder = new EmailFolder({ ...data, db });
    await folder.initialize();
    await folder.save();
    return folder;
  }

  it('classifies system folders via the special-use getters', async () => {
    const collection = await (EmailFolderCollection as any).create({ db });
    await seedFolder({
      accountId: 'acct-sys',
      name: 'INBOX',
      path: 'INBOX',
      specialUse: '\\Inbox',
    });
    await seedFolder({
      accountId: 'acct-sys',
      name: 'Sent',
      path: 'Sent',
      specialUse: '\\Sent',
    });
    await seedFolder({
      accountId: 'acct-sys',
      name: 'Drafts',
      path: 'Drafts',
      specialUse: '\\Drafts',
    });
    await seedFolder({
      accountId: 'acct-sys',
      name: 'Trash',
      path: 'Trash',
      specialUse: '\\Trash',
    });
    await seedFolder({
      accountId: 'acct-sys',
      name: 'Spam',
      path: 'Spam',
      specialUse: '\\Junk',
    });
    // A user-created (non-system) folder.
    await seedFolder({
      accountId: 'acct-sys',
      name: 'Projects',
      path: 'Projects',
    });

    expect((await collection.getInbox('acct-sys'))?.specialUse).toBe('\\Inbox');
    expect((await collection.getSent('acct-sys'))?.specialUse).toBe('\\Sent');
    expect((await collection.getDrafts('acct-sys'))?.specialUse).toBe(
      '\\Drafts',
    );
    expect((await collection.getTrash('acct-sys'))?.specialUse).toBe('\\Trash');
    expect((await collection.getSpam('acct-sys'))?.specialUse).toBe('\\Junk');

    const systemFolders = await collection.getSystemFolders('acct-sys');
    expect(systemFolders).toHaveLength(5);
    const userFolders = await collection.getUserFolders('acct-sys');
    expect(userFolders).toHaveLength(1);
    expect(userFolders[0].name).toBe('Projects');
  });

  it('getByPath, getStats and unread filtering work', async () => {
    const collection = await (EmailFolderCollection as any).create({ db });
    await seedFolder({
      accountId: 'acct-stats',
      name: 'INBOX',
      path: 'INBOX',
      specialUse: '\\Inbox',
      messageCount: 10,
      unreadCount: 4,
    });
    await seedFolder({
      accountId: 'acct-stats',
      name: 'Sent',
      path: 'Sent',
      specialUse: '\\Sent',
      messageCount: 3,
      unreadCount: 0,
    });

    const byPath = await collection.getByPath('acct-stats', 'INBOX');
    expect(byPath?.name).toBe('INBOX');
    expect(await collection.getByPath('acct-stats', 'Nope')).toBeNull();

    const withUnread = await collection.getWithUnread('acct-stats');
    expect(withUnread).toHaveLength(1);
    expect(withUnread[0].unreadCount).toBe(4);

    const stats = await collection.getAccountStats('acct-stats');
    expect(stats.totalFolders).toBe(2);
    expect(stats.systemFolders).toBe(2);
    expect(stats.userFolders).toBe(0);
    expect(stats.totalUnread).toBe(4);
    expect(stats.totalMessages).toBe(13);
  });

  it('getSubscribed and search filter by account and flags', async () => {
    const collection = await (EmailFolderCollection as any).create({ db });
    await seedFolder({
      accountId: 'acct-sub',
      name: 'Newsletters',
      path: 'Newsletters',
      subscribed: true,
    });
    await seedFolder({
      accountId: 'acct-sub',
      name: 'Muted',
      path: 'Muted',
      subscribed: false,
    });

    const subscribed = await collection.getSubscribed('acct-sub');
    expect(subscribed).toHaveLength(1);
    expect(subscribed[0].name).toBe('Newsletters');

    const byName = await collection.search('news', { accountId: 'acct-sub' });
    expect(byName).toHaveLength(1);
    expect(byName[0].name).toBe('Newsletters');

    const subscribedOnly = await collection.search('', { subscribed: true });
    expect(subscribedOnly.map((f: EmailFolder) => f.name)).toContain(
      'Newsletters',
    );
    expect(subscribedOnly.map((f: EmailFolder) => f.name)).not.toContain(
      'Muted',
    );
  });
});

// ============================================================================
// EmailAttachment (deprecated alias of Attachment with emailId mapping)
// ============================================================================

describe('EmailAttachment legacy emailId mapping', () => {
  it('maps emailId constructor option to messageId', () => {
    const att = new EmailAttachment({ emailId: 'email-42', filename: 'a.txt' });
    expect(att.messageId).toBe('email-42');
    expect(att.emailId).toBe('email-42');
  });

  it('prefers emailId over messageId when both supplied', () => {
    const att = new EmailAttachment({
      emailId: 'from-email',
      messageId: 'from-message',
    });
    expect(att.messageId).toBe('from-email');
  });

  it('falls back to messageId when emailId absent', () => {
    const att = new EmailAttachment({ messageId: 'msg-7' });
    expect(att.emailId).toBe('msg-7');
    expect(att.messageId).toBe('msg-7');
  });

  it('emailId setter writes through to messageId', () => {
    const att = new EmailAttachment();
    att.emailId = 'msg-99';
    expect(att.messageId).toBe('msg-99');
  });

  it('inherits Attachment helper methods', () => {
    const att = new EmailAttachment({
      emailId: 'e1',
      filename: 'photo.PNG',
      contentType: 'image/png',
      size: 2048,
      contentDisposition: 'inline',
    });
    expect(att.isImage()).toBe(true);
    expect(att.isInline()).toBe(true);
    expect(att.getExtension()).toBe('png');
    expect(att.getFormattedSize()).toBe('2.0 KB');
  });

  it('getEmail returns null when no messageId', async () => {
    const att = new EmailAttachment({ db });
    await att.initialize();
    expect(await att.getEmail()).toBeNull();
  });
});
