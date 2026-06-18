/**
 * Unit/integration tests for the EmailAccount model.
 *
 * Boundary strategy
 * -----------------
 * The ONLY external boundary is `createClient()`, which dynamically imports
 * `@happyvertical/email` (an IMAP/email client) and `@happyvertical/smrt-secrets`
 * (SecretService for credentials). We mock that single boundary with
 * `vi.spyOn(account, 'createClient').mockResolvedValue(mockClient)` so the
 * model's own sync/fetch/read LOGIC runs against a controllable fake client.
 * Everything else — the DB-backed reads/writes performed by the collections —
 * runs against a real in-memory SQLite database. We never mock the model under
 * test or its DB.
 *
 * Schema note
 * -----------
 * `getTestDatabase()` builds its schema from the classes registered in
 * `ObjectRegistry`. When this file runs in isolation only the classes it
 * imports get registered, so we import every model the EmailAccount code path
 * touches (Account / Message / Email / EmailFolder) to guarantee the
 * `accounts`, `messages`, and `email_folders` tables exist.
 *
 * Write-path note
 * ---------------
 * This file surfaced (and this PR fixes) a real bug: `EmailAccount.syncFrom()`
 * created child rows with `new EmailFolder(...)` / `new Email(...)` and called
 * `.save()` WITHOUT first calling `.initialize()`, so the inline saves threw
 * "Database accessed before initialization" (caught into `result.errors`) and
 * sync silently persisted nothing. The model now initializes those instances
 * before save, so the tests below assert the working persist path
 * (messagesDownloaded increments, rows are retrievable).
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Importing these registers their schemas so getTestDatabase() creates the tables.
import '../models/Account';
import '../models/Message';
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { EmailFolder } from '../models/EmailFolder';
import { EmailSender } from '../senders/EmailSender';

// ---------------------------------------------------------------------------
// Mock email-client factory (mirrors the EmailClient surface EmailAccount uses)
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  /** Messages returned by `fetch()`. */
  messages?: any[];
  /** Throw from `connect()` to exercise the top-level error path. */
  connectError?: Error;
  /** Throw from `fetch()` to exercise the per-folder error path. */
  fetchError?: Error;
}

function makeMockClient(opts: FakeClientOptions = {}) {
  const calls = {
    connect: 0,
    disconnect: 0,
    fetch: [] as any[],
  };
  const client = {
    isConnected: () => true,
    async connect() {
      calls.connect++;
      if (opts.connectError) throw opts.connectError;
    },
    async disconnect() {
      calls.disconnect++;
    },
    async fetch(fetchOptions: Record<string, any>) {
      calls.fetch.push(fetchOptions);
      if (opts.fetchError) throw opts.fetchError;
      return opts.messages ?? [];
    },
    async send() {
      return {
        messageId: 'sent-1',
        accepted: ['x@y.com'],
        rejected: [],
        response: 'ok',
      };
    },
  };
  return { client, calls };
}

/** Build a server-side message shape consumed by `syncFrom`. */
function makeServerMessage(overrides: Record<string, any> = {}) {
  return {
    messageId: `<msg-${Math.random().toString(36).slice(2)}@example.com>`,
    threadId: 'thread-1',
    from: { address: 'alice@example.com', name: 'Alice' },
    to: [{ address: 'me@example.com', name: 'Me' }],
    subject: 'Hello',
    date: new Date('2025-01-15T10:00:00Z'),
    text: 'Plain text body',
    html: '<p>HTML body</p>',
    ...overrides,
  };
}

/** Initialize then save a model — the supported persistence path. */
async function persist<
  T extends { initialize(): Promise<any>; save(): Promise<any> },
>(model: T): Promise<T> {
  await model.initialize();
  await model.save();
  return model;
}

let accountCounter = 0;

async function makeAccount(
  db: DatabaseInterface,
  overrides: Record<string, any> = {},
): Promise<EmailAccount> {
  // Distinct name per account: the auto-generated slug derives from `name`, and
  // identical slugs upsert over each other (natural-key dedup), silently
  // collapsing multiple accounts into one row.
  const n = ++accountCounter;
  return persist(
    new EmailAccount({
      name: `Test Account ${n}`,
      email: `account${n}@example.com`,
      providerType: 'imap',
      db,
      ...overrides,
    }),
  );
}

let folderCounter = 0;

async function makeFolder(
  db: DatabaseInterface,
  accountId: string,
  path = 'INBOX',
): Promise<EmailFolder> {
  // The folder slug derives from `name`; identical slugs upsert over each other
  // (natural-key dedup), so give every folder a globally-unique name while
  // keeping `path` semantically meaningful (syncFrom looks folders up by path).
  const n = ++folderCounter;
  return persist(
    new EmailFolder({ db, accountId, name: `${path} ${n}`, path }),
  );
}

// ===========================================================================
// Pure logic — no DB, no mocks
// ===========================================================================

describe('EmailAccount constructor & field defaults', () => {
  it('applies email-specific defaults', () => {
    const account = new EmailAccount();
    expect(account.email).toBe('');
    expect(account.syncIntervalMinutes).toBe(60);
  });

  it('applies constructor options', () => {
    const account = new EmailAccount({
      email: 'user@gmail.com',
      providerType: 'gmail',
      syncIntervalMinutes: 15,
    });
    expect(account.email).toBe('user@gmail.com');
    expect(account.providerType).toBe('gmail');
    expect(account.syncIntervalMinutes).toBe(15);
  });

  it('inherits base Account fields', () => {
    const account = new EmailAccount({
      name: 'Inbox',
      isActive: false,
      credentialSecretId: 'secret-123',
    });
    expect(account.name).toBe('Inbox');
    expect(account.isActive).toBe(false);
    expect(account.credentialSecretId).toBe('secret-123');
  });

  it('leaves providerType empty when not supplied', () => {
    const account = new EmailAccount({ email: 'a@b.com' });
    expect(account.providerType).toBe('');
  });
});

// ===========================================================================
// createSender() — uses the createClient() boundary, returns an EmailSender
// ===========================================================================

describe('EmailAccount.createSender', () => {
  afterEach(() => vi.restoreAllMocks());

  it('connects the client and returns an EmailSender', async () => {
    const account = new EmailAccount({ email: 'me@example.com' });
    const { client, calls } = makeMockClient();
    vi.spyOn(account, 'createClient').mockResolvedValue(client as any);

    const sender = await account.createSender();

    expect(sender).toBeInstanceOf(EmailSender);
    expect(sender.providerType).toBe('email');
    expect(calls.connect).toBe(1);
    expect(sender.isReady()).toBe(true);
  });
});

// ===========================================================================
// DB-backed methods (real in-memory SQLite, createClient mocked where needed)
// ===========================================================================

describe('EmailAccount DB-backed operations', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  // -------------------------------------------------------------------------
  // syncFrom — orchestration, fetch options, lifecycle, error handling
  // -------------------------------------------------------------------------

  describe('syncFrom', () => {
    it('connects, fetches the default INBOX, and completes cleanly when there are no new messages', async () => {
      const account = await makeAccount(db);
      // Pre-create the INBOX folder so getByPath() returns it (supported path).
      await makeFolder(db, account.id!);

      const { client, calls } = makeMockClient({ messages: [] });
      vi.spyOn(account, 'createClient').mockResolvedValue(client as any);

      const result = await account.syncFrom();

      expect(result.folders).toEqual(['INBOX']);
      expect(result.messagesProcessed).toBe(0);
      expect(result.messagesDownloaded).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.duration).toBeGreaterThanOrEqual(0);

      // Full client lifecycle exercised.
      expect(calls.connect).toBe(1);
      expect(calls.disconnect).toBe(1);
      expect(calls.fetch[0]).toMatchObject({ folder: 'INBOX', limit: 100 });

      // Sync state advanced.
      expect(account.lastSyncAt).toBeInstanceOf(Date);
    });

    it('passes custom folders, batchSize, since and before into the client fetch', async () => {
      const account = await makeAccount(db);
      await makeFolder(db, account.id!, 'INBOX');
      await makeFolder(db, account.id!, 'Sent');

      const { client, calls } = makeMockClient({ messages: [] });
      vi.spyOn(account, 'createClient').mockResolvedValue(client as any);

      const since = new Date('2025-01-01');
      const before = new Date('2025-02-01');
      const result = await account.syncFrom({
        folders: ['INBOX', 'Sent'],
        batchSize: 25,
        since,
        before,
      });

      expect(result.folders).toEqual(['INBOX', 'Sent']);
      expect(calls.fetch).toHaveLength(2);
      expect(calls.fetch[0]).toMatchObject({
        folder: 'INBOX',
        limit: 25,
        since,
        before,
      });
      expect(calls.fetch[1]).toMatchObject({ folder: 'Sent', limit: 25 });
      expect(result.errors).toEqual([]);
    });

    it('reuses an existing folder row instead of creating a duplicate', async () => {
      const account = await makeAccount(db);
      const existing = await makeFolder(db, account.id!);

      const { client } = makeMockClient({ messages: [] });
      vi.spyOn(account, 'createClient').mockResolvedValue(client as any);
      await account.syncFrom();

      const { EmailFolderCollection } = await import(
        '../collections/EmailFolderCollection'
      );
      const folderCollection = await (EmailFolderCollection as any).create({
        db,
      });
      const inboxFolders = (
        await folderCollection.getByAccount(account.id)
      ).filter((f: any) => f.path === 'INBOX');
      expect(inboxFolders).toHaveLength(1);
      expect(inboxFolders[0].id).toBe(existing.id);
    });

    it('records a top-level error and calls onError when connect throws', async () => {
      const account = await makeAccount(db);
      const connectError = new Error('IMAP down');
      const { client, calls } = makeMockClient({ connectError });
      vi.spyOn(account, 'createClient').mockResolvedValue(client as any);

      const errors: Error[] = [];
      const result = await account.syncFrom({ onError: (e) => errors.push(e) });

      expect(result.messagesDownloaded).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('IMAP down');
      expect(errors[0]).toBe(connectError);
      // Never got far enough to fetch.
      expect(calls.fetch).toHaveLength(0);
    });

    it('records a per-folder error and calls onError when fetch throws', async () => {
      const account = await makeAccount(db);
      await makeFolder(db, account.id!);
      const fetchError = new Error('fetch failed');
      const { client, calls } = makeMockClient({ fetchError });
      vi.spyOn(account, 'createClient').mockResolvedValue(client as any);

      const errors: Error[] = [];
      const result = await account.syncFrom({
        folders: ['INBOX'],
        onError: (e) => errors.push(e),
      });

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('fetch failed');
      expect(errors[0].message).toBe('fetch failed');
      // Sync still completed: client disconnected and account saved.
      expect(calls.disconnect).toBe(1);
      expect(account.lastSyncAt).toBeInstanceOf(Date);
    });

    it('coerces non-Error throwables from the client into Error instances', async () => {
      const account = await makeAccount(db);
      const { client } = makeMockClient();
      // connect rejects with a plain string.
      client.connect = async () => {
        throw 'string failure';
      };
      vi.spyOn(account, 'createClient').mockResolvedValue(client as any);

      const result = await account.syncFrom();
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(Error);
      expect(result.errors[0].message).toBe('string failure');
    });

    it('processes and downloads each fetched message, persisting it', async () => {
      // The per-message Email row is now initialized before save() (the init
      // bug is fixed), so a fetched message is processed AND downloaded.
      const account = await makeAccount(db);
      await makeFolder(db, account.id!);
      const serverMsg = makeServerMessage({ messageId: '<x@example.com>' });
      const { client } = makeMockClient({ messages: [serverMsg] });
      vi.spyOn(account, 'createClient').mockResolvedValue(client as any);

      const onError = vi.fn();
      const result = await account.syncFrom({ onError });

      expect(result.messagesProcessed).toBe(1);
      expect(result.messagesDownloaded).toBe(1);
      expect(result.errors).toHaveLength(0);
      expect(onError).not.toHaveBeenCalled();
      // The email was persisted and is retrievable for the account.
      const emails = await account.getEmails();
      expect(emails.some((e: any) => e.messageId === '<x@example.com>')).toBe(
        true,
      );
    });
  });

  // -------------------------------------------------------------------------
  // getFolders — DB-backed read via EmailFolderCollection
  // -------------------------------------------------------------------------

  describe('getFolders', () => {
    it('returns only folders for this account', async () => {
      const account = await makeAccount(db);
      const other = await makeAccount(db, { email: 'other@example.com' });

      await makeFolder(db, account.id!, 'INBOX');
      await makeFolder(db, account.id!, 'Sent');
      await makeFolder(db, other.id!, 'INBOX');

      const folders = await account.getFolders();
      expect(folders).toHaveLength(2);
      expect(folders.every((f: any) => f.accountId === account.id)).toBe(true);
    });

    it('returns an empty list when there are no folders', async () => {
      const account = await makeAccount(db);
      expect(await account.getFolders()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getEmails — DB-backed read with optional limit
  // -------------------------------------------------------------------------

  describe('getEmails', () => {
    it('returns emails for this account and honours the limit', async () => {
      const account = await makeAccount(db);
      await persist(
        new Email({ db, accountId: account.id, messageId: '<e1@x>' }),
      );
      await persist(
        new Email({ db, accountId: account.id, messageId: '<e2@x>' }),
      );
      await persist(
        new Email({ db, accountId: account.id, messageId: '<e3@x>' }),
      );

      expect(await account.getEmails()).toHaveLength(3);
      expect(await account.getEmails(2)).toHaveLength(2);
    });

    it('returns only this account’s emails', async () => {
      const account = await makeAccount(db);
      const other = await makeAccount(db, { email: 'other@example.com' });
      await persist(
        new Email({ db, accountId: account.id, messageId: '<mine@x>' }),
      );
      await persist(
        new Email({ db, accountId: other.id, messageId: '<theirs@x>' }),
      );

      const emails = await account.getEmails();
      expect(emails).toHaveLength(1);
      expect(emails[0].accountId).toBe(account.id);
    });

    it('returns an empty list when there are no emails', async () => {
      const account = await makeAccount(db);
      expect(await account.getEmails()).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getUnreadCount — DB-backed count
  // -------------------------------------------------------------------------

  describe('getUnreadCount', () => {
    it('counts only unread emails for the account', async () => {
      const account = await makeAccount(db);
      await persist(
        new Email({
          db,
          accountId: account.id,
          messageId: '<u1@x>',
          isRead: false,
        }),
      );
      await persist(
        new Email({
          db,
          accountId: account.id,
          messageId: '<u2@x>',
          isRead: false,
        }),
      );
      await persist(
        new Email({
          db,
          accountId: account.id,
          messageId: '<r1@x>',
          isRead: true,
        }),
      );

      expect(await account.getUnreadCount()).toBe(2);
    });

    it('returns 0 when there are no emails', async () => {
      const account = await makeAccount(db);
      expect(await account.getUnreadCount()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // syncAll — class-wide operation routed through the collection
  // -------------------------------------------------------------------------

  describe('syncAll', () => {
    it('syncs all active accounts and reports a per-account result, ignoring inactive ones', async () => {
      await makeAccount(db, { email: 'a1@example.com' });
      await makeAccount(db, { email: 'a2@example.com' });
      // An inactive account that must be excluded from the run.
      await makeAccount(db, {
        email: 'inactive@example.com',
        isActive: false,
      });

      // syncAll re-loads accounts from the collection, so we can't spy on the
      // freshly-loaded instances individually. Spy on the prototype so every
      // loaded instance gets a mock client. (syncFrom swallows its own per-row
      // errors, so each account reports success.)
      const protoSpy = vi
        .spyOn(EmailAccount.prototype, 'createClient')
        .mockImplementation(
          async () => makeMockClient({ messages: [] }).client as any,
        );

      const anchor = await makeAccount(db, { email: 'anchor@example.com' });
      const results = await anchor.syncAll();

      // Three active accounts (a1, a2, anchor); inactive excluded.
      expect(results.size).toBe(3);
      for (const outcome of results.values()) {
        expect(outcome).toEqual({ success: true });
      }

      protoSpy.mockRestore();
    });
  });
});

// ===========================================================================
// migrateToSecrets — branch coverage without entangling SecretService
// ===========================================================================

describe('EmailAccount.migrateToSecrets', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('does nothing when credentialSecretId is already set', async () => {
    const account = await makeAccount(db, {
      credentialSecretId: 'existing-secret',
      settings: JSON.stringify({ host: 'imap.example.com' }),
    });
    const setCredsSpy = vi.spyOn(account, 'setCredentials');

    await account.migrateToSecrets();

    expect(setCredsSpy).not.toHaveBeenCalled();
    expect(account.credentialSecretId).toBe('existing-secret');
  });

  it('does nothing when there are no settings to migrate', async () => {
    const account = await makeAccount(db); // settings = ''
    const setCredsSpy = vi.spyOn(account, 'setCredentials');

    await account.migrateToSecrets();

    expect(setCredsSpy).not.toHaveBeenCalled();
    expect(account.credentialSecretId).toBeNull();
  });

  it('delegates to setCredentials when plain-text settings exist', async () => {
    const account = await makeAccount(db, {
      settings: JSON.stringify({ host: 'imap.example.com', port: 993 }),
    });
    // Stub the SecretService boundary by faking setCredentials itself.
    const setCredsSpy = vi
      .spyOn(account, 'setCredentials')
      .mockResolvedValue(undefined);

    await account.migrateToSecrets();

    expect(setCredsSpy).toHaveBeenCalledTimes(1);
    const [creds, opts] = setCredsSpy.mock.calls[0];
    expect(creds).toEqual({ host: 'imap.example.com', port: 993 });
    expect(opts?.description).toContain('Migrated IMAP credentials');
  });
});
