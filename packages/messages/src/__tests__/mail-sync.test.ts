/**
 * Cursor-based incremental mailbox sync (#5130).
 *
 * The only mocked boundary is the email client (`createClient`), replaced with
 * a scripted change feed. Everything else runs for real against in-memory
 * SQLite: the account row, the folders, the emails, the cursor, and (for the
 * job tests) the smrt-jobs queue and TaskRunner.
 */

import type {
  ChangeFeedOptions,
  ChangeFeedResult,
  EmailMessage,
  Folder,
} from '@happyvertical/email';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { createTaskRunner } from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../models/Account';
import '../models/Message';
import { EmailAccountCollection } from '../collections/EmailAccountCollection';
import { EmailCollection } from '../collections/EmailCollection';
import { EmailFolderCollection } from '../collections/EmailFolderCollection';
import {
  CHANGE_FEED_PROVIDERS,
  enqueueDueMailSyncs,
  enqueueMailSync,
  MAIL_SYNC_QUEUE,
  mailSyncDedupeKey,
} from '../mail-sync-jobs';
import type { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { EmailFolder } from '../models/EmailFolder';
import { prepareMessageParents } from './fk-fixtures.js';

// ---------------------------------------------------------------------------
// Scripted change feed
// ---------------------------------------------------------------------------

type Step = ChangeFeedResult | Error | (() => Promise<ChangeFeedResult>);

interface Feed {
  /** Options of every getChanges() call, in order. */
  calls: ChangeFeedOptions[];
  client: Record<string, unknown>;
  disconnects: () => number;
}

function makeFeed(steps: Step[]): Feed {
  const calls: ChangeFeedOptions[] = [];
  let disconnected = 0;
  const queue = [...steps];
  const client = {
    async connect() {},
    async disconnect() {
      disconnected++;
    },
    isConnected: () => true,
    async getChanges(options: ChangeFeedOptions) {
      calls.push({ ...options });
      const step = queue.shift();
      if (!step) throw new Error('feed script exhausted');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step() : step;
    },
  };
  return { calls, client, disconnects: () => disconnected };
}

function msg(id: string, extra: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id,
    messageId: `<${id}@example.com>`,
    threadId: `thread-${id}`,
    from: { address: 'alice@example.com', name: 'Alice' },
    to: [{ address: 'me@example.com' }],
    subject: `Subject ${id}`,
    date: new Date('2026-01-01T10:00:00Z'),
    text: `Body ${id}`,
    html: `<p>Body ${id}</p>`,
    folder: 'INBOX',
    folders: ['INBOX'],
    flags: [],
    size: 10,
    ...extra,
  };
}

const INBOX: Folder = {
  id: 'mb-inbox',
  name: 'Inbox',
  path: 'INBOX',
  delimiter: '/',
  specialUse: '\\Inbox',
  subscribed: true,
};

function batch(
  cursor: string,
  parts: Partial<Extract<ChangeFeedResult, { status: 'ok' }>> = {},
): ChangeFeedResult {
  return {
    status: 'ok',
    cursor,
    hasMore: false,
    initial: false,
    added: [],
    changed: [],
    removed: [],
    ...parts,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let db: DatabaseInterface;
let counter = 0;

async function makeAccount(
  overrides: Record<string, unknown> = {},
): Promise<EmailAccount> {
  const n = ++counter;
  const account = new EmailAccount({
    name: `Sync Account ${n}`,
    email: `sync${n}@example.com`,
    providerType: 'jmap',
    db,
    ...overrides,
  });
  await account.initialize();
  await account.save();
  return account;
}

async function reload(account: EmailAccount): Promise<EmailAccount> {
  const accounts = await EmailAccountCollection.create({ db });
  return (await accounts.get({ id: account.id })) as EmailAccount;
}

async function emailsOf(account: EmailAccount): Promise<Email[]> {
  const emails = await EmailCollection.create({ db });
  const { runWithMailSystemAccess } = await import('../access.js');
  return runWithMailSystemAccess(
    async () =>
      (await emails.list({ where: { accountId: account.id } })) as Email[],
  );
}

async function providerIds(account: EmailAccount): Promise<string[]> {
  return (await emailsOf(account)).map((e) => e.providerMessageId).sort();
}

const feeds = new Map<string, Feed>();

function useFeed(account: EmailAccount, feed: Feed): void {
  // The run builds its client from the reloaded row, so key the feed by id.
  feeds.set(account.id as string, feed);
  vi.spyOn(EmailAccount.prototype, 'createClient').mockImplementation(
    async function (this: EmailAccount) {
      const mine = feeds.get(this.id as string);
      if (!mine) throw new Error('no feed scripted for this account');
      return mine.client as never;
    },
  );
}

beforeEach(async () => {
  feeds.clear();
  db = await getTestDatabase();
  await prepareMessageParents(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (db && typeof db.close === 'function') await db.close();
});

// ---------------------------------------------------------------------------
// Initial and incremental sync
// ---------------------------------------------------------------------------

describe('EmailAccount.syncChanges: initial pass', () => {
  it('pages through the initial pass, stores messages and folders, and keeps the last cursor', async () => {
    const account = await makeAccount();
    const feed = makeFeed([
      batch('c1', {
        initial: true,
        hasMore: true,
        folders: [INBOX],
        added: [msg('m1', { flags: ['\\Seen'] }), msg('m2')],
      }),
      batch('c2', { initial: true, added: [msg('m3')] }),
    ]);
    useFeed(account, feed);

    const result = await account.syncChanges({ limit: 2 });

    expect(result).toMatchObject({
      status: 'synced',
      batches: 2,
      added: 3,
      changed: 0,
      removed: 0,
      resynced: false,
      hasMore: false,
    });
    expect(feed.calls).toEqual([
      { cursor: undefined, limit: 2, includeBodies: true },
      { cursor: 'c1', limit: 2, includeBodies: true },
    ]);
    expect(await providerIds(account)).toEqual(['m1', 'm2', 'm3']);

    const stored = await reload(account);
    expect(stored.syncCursor).toBe('c2');
    expect(stored.lastSyncAt).toBeInstanceOf(Date);
    expect(stored.connectionStatus).toBe('connected');

    const emails = await emailsOf(account);
    const m1 = emails.find((e) => e.providerMessageId === 'm1');
    expect(m1).toMatchObject({
      subject: 'Subject m1',
      textBody: 'Body m1',
      messageId: '<m1@example.com>',
      folderPath: 'INBOX',
      isRead: true,
    });
    expect(emails.find((e) => e.providerMessageId === 'm2')?.isRead).toBe(
      false,
    );

    const folders = await (
      await EmailFolderCollection.create({ db })
    ).getByAccount(account.id as string);
    expect(folders.map((f) => f.path)).toEqual(['INBOX']);
    expect(folders[0]).toMatchObject({
      specialUse: '\\Inbox',
      messageCount: 3,
      unreadCount: 2,
    });
    expect(feed.disconnects()).toBe(1);
  });

  it('reports hasMore when the batch cap stops the run, and resumes from the saved cursor', async () => {
    const account = await makeAccount();
    const first = makeFeed([
      batch('c1', { initial: true, hasMore: true, added: [msg('m1')] }),
    ]);
    useFeed(account, first);
    const partial = await account.syncChanges({ maxBatches: 1 });
    expect(partial.hasMore).toBe(true);
    expect((await reload(account)).syncCursor).toBe('c1');

    vi.restoreAllMocks();
    const second = makeFeed([
      batch('c2', { initial: true, added: [msg('m2')] }),
    ]);
    const resumed = await reload(account);
    useFeed(resumed, second);
    await resumed.syncChanges();
    expect(second.calls[0].cursor).toBe('c1');
    expect(await providerIds(account)).toEqual(['m1', 'm2']);
  });
});

describe('EmailAccount.syncChanges: incremental pass', () => {
  it('applies added, changed and removed messages from the saved cursor', async () => {
    const account = await makeAccount();
    useFeed(
      account,
      makeFeed([
        batch('c1', {
          initial: true,
          folders: [INBOX],
          added: [msg('m1'), msg('m2'), msg('m3')],
        }),
      ]),
    );
    await account.syncChanges();

    const next = await reload(account);
    const feed = makeFeed([
      batch('c2', {
        added: [msg('m4')],
        // Metadata-only change: the server sent flags but no bodies.
        changed: [
          msg('m1', { text: undefined, html: undefined, flags: ['\\Seen'] }),
        ],
        removed: ['m2'],
      }),
    ]);
    useFeed(next, feed);
    const result = await next.syncChanges();

    expect(feed.calls[0].cursor).toBe('c1');
    expect(result).toMatchObject({ added: 1, changed: 1, removed: 1 });
    expect(await providerIds(account)).toEqual(['m1', 'm3', 'm4']);
    const m1 = (await emailsOf(account)).find(
      (e) => e.providerMessageId === 'm1',
    );
    expect(m1?.isRead).toBe(true);
    expect(m1?.textBody).toBe('Body m1');
    expect((await reload(account)).syncCursor).toBe('c2');
  });

  it('moves a message between folders and refreshes both counts', async () => {
    const account = await makeAccount();
    const archive: Folder = {
      ...INBOX,
      id: 'mb-arch',
      name: 'Archive',
      path: 'Archive',
      specialUse: '\\Archive',
    };
    useFeed(
      account,
      makeFeed([
        batch('c1', {
          initial: true,
          folders: [INBOX, archive],
          added: [msg('m1')],
        }),
      ]),
    );
    await account.syncChanges();
    const next = await reload(account);
    useFeed(
      next,
      makeFeed([
        batch('c2', {
          changed: [msg('m1', { folder: 'Archive', folders: ['Archive'] })],
        }),
      ]),
    );
    await next.syncChanges();

    const folders = await (
      await EmailFolderCollection.create({ db })
    ).getByAccount(account.id as string);
    const counts = Object.fromEntries(
      folders.map((f) => [f.path, f.messageCount]),
    );
    expect(counts).toEqual({ INBOX: 0, Archive: 1 });
  });
});

// ---------------------------------------------------------------------------
// resync-required
// ---------------------------------------------------------------------------

describe('EmailAccount.syncChanges: resync-required', () => {
  it('clears the cursor, runs a full pass and drops messages the server no longer has', async () => {
    const account = await makeAccount();
    useFeed(
      account,
      makeFeed([
        batch('c1', {
          initial: true,
          folders: [INBOX],
          added: [msg('m1'), msg('m2')],
        }),
      ]),
    );
    await account.syncChanges();

    const next = await reload(account);
    const feed = makeFeed([
      { status: 'resync-required', reason: 'cursor-expired' },
      batch('c9', {
        initial: true,
        folders: [INBOX],
        added: [msg('m2'), msg('m5')],
      }),
    ]);
    useFeed(next, feed);
    const result = await next.syncChanges();

    expect(feed.calls.map((c) => c.cursor)).toEqual(['c1', undefined]);
    expect(result).toMatchObject({ resynced: true, added: 2, removed: 1 });
    expect(await providerIds(account)).toEqual(['m2', 'm5']);
    expect((await reload(account)).syncCursor).toBe('c9');
  });

  it('leaves the cursor cleared when the full pass fails, so the next run starts over', async () => {
    const account = await makeAccount({ syncCursor: 'stale' });
    useFeed(
      account,
      makeFeed([
        { status: 'resync-required', reason: 'cursor-invalid' },
        new Error('server unreachable'),
      ]),
    );
    await expect(account.syncChanges()).rejects.toThrow('server unreachable');
    expect((await reload(account)).syncCursor).toBeNull();
  });

  it('refuses a second resync request in one run instead of looping', async () => {
    const account = await makeAccount({ syncCursor: 'stale' });
    useFeed(
      account,
      makeFeed([
        { status: 'resync-required', reason: 'cursor-expired' },
        { status: 'resync-required', reason: 'cursor-expired' },
      ]),
    );
    await expect(account.syncChanges()).rejects.toThrow(/second resync/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency and cursor safety
// ---------------------------------------------------------------------------

describe('EmailAccount.syncChanges: idempotent apply', () => {
  it('applying the same batch twice stores each message once', async () => {
    const account = await makeAccount();
    const same = (): ChangeFeedResult =>
      batch('c1', {
        initial: true,
        folders: [INBOX],
        added: [msg('m1'), msg('m2')],
      });
    useFeed(account, makeFeed([same()]));
    await account.syncChanges();

    // A replay: the crash happened before the cursor was saved.
    const replay = await reload(account);
    replay.syncCursor = null;
    await replay.save();
    useFeed(replay, makeFeed([same()]));
    await replay.syncChanges();

    expect(await providerIds(account)).toEqual(['m1', 'm2']);
    const folders = await (
      await EmailFolderCollection.create({ db })
    ).getByAccount(account.id as string);
    expect(folders).toHaveLength(1);
    expect(folders[0].messageCount).toBe(2);
  });
});

describe('EmailAccount.syncChanges: cursor safety', () => {
  it('recovers folder counts when a failed batch that deleted and moved messages is replayed', async () => {
    const account = await makeAccount();
    const archive: Folder = {
      ...INBOX,
      id: 'mb-arch',
      name: 'Archive',
      path: 'Archive',
      specialUse: '\\Archive',
    };
    useFeed(
      account,
      makeFeed([
        batch('c1', {
          initial: true,
          folders: [INBOX, archive],
          added: [msg('m1'), msg('m2')],
        }),
      ]),
    );
    await account.syncChanges();

    const mutating = (): ChangeFeedResult =>
      batch('c2', {
        changed: [msg('m2', { folder: 'Archive', folders: ['Archive'] })],
        removed: ['m1'],
      });
    const failing = await reload(account);
    useFeed(failing, makeFeed([mutating()]));
    // The batch is applied (m1 deleted, m2 moved) but counting fails.
    vi.spyOn(EmailFolder.prototype, 'save').mockRejectedValueOnce(
      new Error('count write failed'),
    );
    await expect(failing.syncChanges()).rejects.toThrow('count write failed');
    expect((await reload(account)).syncCursor).toBe('c1');

    const retry = await reload(account);
    useFeed(retry, makeFeed([mutating()]));
    await retry.syncChanges();

    const folders = await (
      await EmailFolderCollection.create({ db })
    ).getByAccount(account.id as string);
    expect(
      Object.fromEntries(folders.map((f) => [f.path, f.messageCount])),
    ).toEqual({ INBOX: 0, Archive: 1 });
    expect((await reload(account)).syncCursor).toBe('c2');
  });

  it('builds the sync client from the reloaded account, not the stale instance', async () => {
    const account = await makeAccount();
    const stale = await reload(account);
    const fresh = await reload(account);
    fresh.setConfiguration({ url: 'https://new.example.com' });
    await fresh.save();

    const seen: unknown[] = [];
    const feed = makeFeed([batch('c1', { initial: true })]);
    vi.spyOn(EmailAccount.prototype, 'createClient').mockImplementation(
      async function (this: EmailAccount) {
        seen.push(this.getConfiguration().url);
        return feed.client as never;
      },
    );
    await stale.syncChanges();
    expect(seen).toEqual(['https://new.example.com']);
  });

  it('does not save the cursor when applying the batch fails, and the retry succeeds', async () => {
    const account = await makeAccount();
    const bad = msg('m2');
    delete bad.id;
    useFeed(
      account,
      makeFeed([
        batch('c1', {
          initial: true,
          folders: [INBOX],
          added: [msg('m1'), bad],
        }),
      ]),
    );
    await expect(account.syncChanges()).rejects.toThrow(/without an id/);
    expect((await reload(account)).syncCursor).toBeNull();

    const retry = await reload(account);
    const feed = makeFeed([
      batch('c1', { initial: true, added: [msg('m1'), msg('m2')] }),
    ]);
    useFeed(retry, feed);
    await retry.syncChanges();
    expect(feed.calls[0].cursor).toBeUndefined();
    expect(await providerIds(account)).toEqual(['m1', 'm2']);
    expect((await reload(account)).syncCursor).toBe('c1');
  });

  it('keeps the cursor of the last applied batch when a later batch fails', async () => {
    const account = await makeAccount();
    const feed = makeFeed([
      batch('c1', {
        initial: true,
        hasMore: true,
        folders: [INBOX],
        added: [msg('m1')],
      }),
      new Error('connection reset'),
    ]);
    useFeed(account, feed);
    await expect(account.syncChanges()).rejects.toThrow('connection reset');
    expect((await reload(account)).syncCursor).toBe('c1');
    expect(await providerIds(account)).toEqual(['m1']);
    expect(feed.disconnects()).toBe(1);
  });

  it('marks the account for reconnection when the server refuses the sign-in, and the error is not retryable', async () => {
    const account = await makeAccount({ syncCursor: 'c1' });
    const denied = Object.assign(new Error('Authentication failed'), {
      code: 'EAUTH',
    });
    useFeed(account, makeFeed([denied]));
    await expect(account.syncChanges()).rejects.toMatchObject({
      retryable: false,
    });
    const stored = await reload(account);
    expect(stored.connectionStatus).toBe('needs_reconnect');
    expect(stored.syncCursor).toBe('c1');
  });
});

// ---------------------------------------------------------------------------
// Lanes and closed accounts
// ---------------------------------------------------------------------------

describe('EmailAccount.syncChanges: one lane per account', () => {
  it('keeps each account on its own cursor and messages', async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    useFeed(
      a,
      makeFeed([
        batch('a1', { initial: true, folders: [INBOX], added: [msg('a-1')] }),
      ]),
    );
    useFeed(
      b,
      makeFeed([
        batch('b1', {
          initial: true,
          folders: [INBOX],
          added: [msg('b-1'), msg('b-2')],
        }),
      ]),
    );

    await Promise.all([a.syncChanges(), b.syncChanges()]);

    expect(await providerIds(a)).toEqual(['a-1']);
    expect(await providerIds(b)).toEqual(['b-1', 'b-2']);
    expect((await reload(a)).syncCursor).toBe('a1');
    expect((await reload(b)).syncCursor).toBe('b1');
  });

  it('a failing account does not stop another account', async () => {
    const a = await makeAccount();
    const b = await makeAccount();
    useFeed(a, makeFeed([new Error('boom')]));
    useFeed(
      b,
      makeFeed([
        batch('b1', { initial: true, folders: [INBOX], added: [msg('b-1')] }),
      ]),
    );
    const [ra, rb] = await Promise.allSettled([
      a.syncChanges(),
      b.syncChanges(),
    ]);
    expect(ra.status).toBe('rejected');
    expect(rb.status).toBe('fulfilled');
    expect(await providerIds(b)).toEqual(['b-1']);
  });

  it('runs two overlapping syncs of one account one after the other', async () => {
    const account = await makeAccount();
    let running = 0;
    let peak = 0;
    const slow =
      (cursor: string): (() => Promise<ChangeFeedResult>) =>
      async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 25));
        running--;
        return batch(cursor, {
          initial: true,
          folders: [INBOX],
          added: [msg(`m-${cursor}`)],
        });
      };
    // Two instances of the same row, as two job runs would build.
    const first = await reload(account);
    const second = await reload(account);
    // One shared script: both runs resolve to the same stored account.
    useFeed(first, makeFeed([slow('c1'), slow('c2')]));
    // The second run reads the stored cursor c1 once the first has finished.
    await Promise.all([first.syncChanges(), second.syncChanges()]);
    expect(peak).toBe(1);
  });
});

describe('EmailAccount.syncChanges: closed accounts', () => {
  it.each([
    ['inactive', { isActive: false }, 'inactive'],
    [
      'needing reconnection',
      { connectionStatus: 'needs_reconnect' },
      'needs-reconnect',
    ],
  ])('skips an account that is %s without opening a connection', async (_name, overrides, reason) => {
    const account = await makeAccount(overrides);
    const create = vi.spyOn(EmailAccount.prototype, 'createClient');
    const result = await account.syncChanges();
    expect(result).toMatchObject({
      status: 'skipped',
      skipped: reason,
      batches: 0,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('skips a provider without a change feed', async () => {
    const account = await makeAccount({ providerType: 'imap' });
    const client = { connect: async () => {}, disconnect: async () => {} };
    vi.spyOn(EmailAccount.prototype, 'createClient').mockResolvedValue(
      client as never,
    );
    const result = await account.syncChanges();
    expect(result).toMatchObject({ status: 'skipped', skipped: 'unsupported' });
  });

  it('reads the stored account state, not a stale instance', async () => {
    const account = await makeAccount();
    const stale = await reload(account);
    await account.markNeedsReconnect('sign-in refused');
    const create = vi.spyOn(EmailAccount.prototype, 'createClient');
    const result = await stale.syncChanges();
    expect(result.skipped).toBe('needs-reconnect');
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// JMAP wiring
// ---------------------------------------------------------------------------

describe('JMAP account client settings', () => {
  it('builds one `auth` value from the stored sign-in', async () => {
    const { getMessagingProvider, registerMessagingProvider } = await import(
      '../providers.js'
    );
    const definition = getMessagingProvider('jmap');
    expect(definition?.channel).toBe('email');
    const seen: Record<string, unknown>[] = [];
    registerMessagingProvider({
      ...(definition as NonNullable<typeof definition>),
      createEmailClient: async (options: Record<string, unknown>) => {
        seen.push(options);
        return {} as never;
      },
    });
    const account = await makeAccount();
    account.setConfiguration({ url: 'https://mail.example.com' });
    vi.spyOn(account, 'getCredentials').mockResolvedValueOnce({ token: 't-1' });
    await account.createClient();
    vi.spyOn(account, 'getCredentials').mockResolvedValueOnce({
      username: 'me',
      password: 'pw',
    });
    await account.createClient();

    expect(seen[0]).toEqual({
      type: 'jmap',
      url: 'https://mail.example.com',
      auth: { type: 'bearer', token: 't-1' },
    });
    expect(seen[1]).toEqual({
      type: 'jmap',
      url: 'https://mail.example.com',
      auth: { user: 'me', pass: 'pw' },
    });
  });
});

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

describe('mail sync job', () => {
  it('queues one job per account however often it is asked', async () => {
    const account = await makeAccount();
    const other = await makeAccount();
    const first = await enqueueMailSync(account);
    const second = await enqueueMailSync(account);
    const third = await enqueueMailSync(other);

    expect(first?.id).toBeTruthy();
    expect(second?.id).toBe(first?.id);
    expect(third?.id).not.toBe(first?.id);
    expect(first).toMatchObject({
      queue: MAIL_SYNC_QUEUE,
      method: 'syncChanges',
      objectId: account.id,
      dedupeKey: mailSyncDedupeKey(account.id as string),
    });
  });

  it('queues nothing for closed accounts or providers without a change feed', async () => {
    expect(CHANGE_FEED_PROVIDERS).toContain('jmap');
    expect(
      await enqueueMailSync(await makeAccount({ isActive: false })),
    ).toBeNull();
    expect(
      await enqueueMailSync(
        await makeAccount({ connectionStatus: 'needs_reconnect' }),
      ),
    ).toBeNull();
    expect(
      await enqueueMailSync(await makeAccount({ providerType: 'imap' })),
    ).toBeNull();
  });

  it('queues only the accounts that are due', async () => {
    const never = await makeAccount();
    const recent = await makeAccount({
      lastSyncAt: new Date(),
      syncIntervalMinutes: 60,
    });
    const old = await makeAccount({
      lastSyncAt: new Date(Date.now() - 2 * 3600_000),
      syncIntervalMinutes: 60,
    });
    const queued = await enqueueDueMailSyncs([never, recent, old]);
    expect(queued).toHaveLength(2);
  });

  it('runs through the task runner, advances the cursor, and a rerun is harmless', async () => {
    const account = await makeAccount();
    vi.spyOn(EmailAccount.prototype, 'createClient').mockImplementation(
      async () =>
        makeFeed([
          batch('c1', {
            initial: true,
            folders: [INBOX],
            added: [msg('m1'), msg('m2')],
          }),
        ]).client as never,
    );
    const job = await enqueueMailSync(account, { limit: 50 });
    expect(job?.args).toMatchObject({ limit: 50 });

    const runner = createTaskRunner({
      concurrency: 1,
      pollInterval: 10,
      queues: [MAIL_SYNC_QUEUE],
    });
    await runner.initialize(db);
    const done = new Promise<void>((resolve, reject) => {
      runner.once('job:completed', () => resolve());
      runner.once('job:failed', (_job: unknown, error: unknown) =>
        reject(error),
      );
    });
    await runner.start();
    try {
      await done;
    } finally {
      await runner.stop();
    }

    expect(await providerIds(account)).toEqual(['m1', 'm2']);
    expect((await reload(account)).syncCursor).toBe('c1');

    // The same job again (at-least-once delivery) changes nothing.
    const rerun = await reload(account);
    rerun.syncCursor = null;
    await rerun.save();
    await (await reload(account)).syncChanges();
    expect(await providerIds(account)).toEqual(['m1', 'm2']);
  });
});
