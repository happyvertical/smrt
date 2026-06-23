/**
 * Extended Account + Message coverage using real in-memory SQLite.
 *
 * Covers DB-backed lifecycle methods (activate/deactivate, markRead/markUnread,
 * toggleFlagged), relationship loaders (getAccount/getThreadMessages/
 * getAttachments), credential fallback to settings, and the send()/retrySend()
 * orchestration (status transitions).
 *
 * Mocking policy: only the external SDK transport getMessageClient() from
 * '@happyvertical/messages' is mocked (used indirectly via SlackSender during
 * Message.send). All models/collections/DB are real.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMock = vi.fn();
vi.mock('@happyvertical/messages', () => ({
  getMessageClient: async () => ({
    connect: async () => undefined,
    disconnect: async () => undefined,
    send: (...args: any[]) => sendMock(...args),
  }),
}));

import { AccountCollection } from '../collections/AccountCollection';
import { MessageCollection } from '../collections/MessageCollection';
import { Account } from '../models/Account';
import { Attachment } from '../models/Attachment';
import { Message } from '../models/Message';
import { SlackAccount } from '../models/SlackAccount';
import { SlackMessage } from '../models/SlackMessage';

let db: DatabaseInterface;

beforeEach(async () => {
  db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
});

afterEach(async () => {
  vi.clearAllMocks();
  if (db && typeof db.close === 'function') {
    await db.close();
  }
});

// ============================================================================
// Account — lifecycle + credentials
// ============================================================================

describe('Account lifecycle', () => {
  it('activate()/deactivate() persist isActive', async () => {
    const account = new Account({
      name: 'Acct',
      providerType: 'generic',
      isActive: true,
      db,
    });
    await account.initialize();
    await account.save();

    await account.deactivate();
    expect(account.isActive).toBe(false);

    const collection = await (AccountCollection as any).create({ db });
    let loaded = await collection.get({ id: account.id });
    expect(loaded.isActive).toBe(false);

    await account.activate();
    expect(account.isActive).toBe(true);
    loaded = await collection.get({ id: account.id });
    expect(loaded.isActive).toBe(true);
  });

  it('setSettings/getSettings round-trip through the database', async () => {
    const account = new Account({ name: 'Acct', db });
    await account.initialize();
    account.setSettings({ host: 'mail.example.com', port: 587 });
    await account.save();

    const collection = await (AccountCollection as any).create({ db });
    const loaded = await collection.get({ id: account.id });
    expect(loaded.getSettings()).toEqual({
      host: 'mail.example.com',
      port: 587,
    });
  });

  it('getCredentials falls back to settings when no credentialSecretId', async () => {
    const account = new Account({ name: 'Acct', db });
    await account.initialize();
    account.setSettings({ apiKey: 'abc', token: 'xyz' });

    const creds = await account.getCredentials();
    expect(creds).toEqual({ apiKey: 'abc', token: 'xyz' });
  });

  it('base Account.createSender throws not-implemented', async () => {
    const account = new Account({ providerType: 'mystery', db });
    await account.initialize();
    await expect(account.createSender()).rejects.toThrow(
      "not implemented for account type 'mystery'",
    );
  });
});

// ============================================================================
// Message — DB-backed lifecycle + relationships
// ============================================================================

describe('Message lifecycle (persisted)', () => {
  it('markRead/markUnread/toggleFlagged persist', async () => {
    const msg = new Message({ subject: 'S', body: 'B', isRead: false, db });
    await msg.initialize();
    await msg.save();

    await msg.markRead();
    expect(msg.isRead).toBe(true);

    const coll = await (MessageCollection as any).create({ db });
    expect((await coll.get({ id: msg.id })).isRead).toBe(true);

    await msg.markUnread();
    expect(msg.isRead).toBe(false);
    expect(msg.isUnread()).toBe(true);

    expect(msg.isFlagged).toBe(false);
    await msg.toggleFlagged();
    expect(msg.isFlagged).toBe(true);
    await msg.toggleFlagged();
    expect(msg.isFlagged).toBe(false);

    expect((await coll.get({ id: msg.id })).isFlagged).toBe(false);
  });

  it('getAccount returns null with no accountId and resolves a saved account', async () => {
    const noAccount = new Message({ subject: 'S', db });
    await noAccount.initialize();
    expect(await noAccount.getAccount()).toBeNull();

    const account = new Account({ name: 'Owner', providerType: 'generic', db });
    await account.initialize();
    await account.save();

    const msg = new Message({ subject: 'S', accountId: account.id!, db });
    await msg.initialize();
    await msg.save();

    const resolved = await msg.getAccount();
    expect(resolved).not.toBeNull();
    expect(resolved.id).toBe(account.id);
    expect(resolved.name).toBe('Owner');
  });

  it('getThreadMessages returns [this] when no threadId, else thread members', async () => {
    const solo = new Message({ subject: 'Solo', db });
    await solo.initialize();
    await solo.save();
    const soloThread = await solo.getThreadMessages();
    expect(soloThread).toHaveLength(1);
    expect(soloThread[0].id).toBe(solo.id);

    const a = new Message({ subject: 'A', threadId: 'thread-x', db });
    await a.initialize();
    await a.save();
    const b = new Message({ subject: 'B', threadId: 'thread-x', db });
    await b.initialize();
    await b.save();

    const members = await a.getThreadMessages();
    expect(members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('getAttachments lists attachments for the message', async () => {
    const msg = new Message({ subject: 'WithAtt', db });
    await msg.initialize();
    await msg.save();

    const att = new Attachment({
      messageId: msg.id!,
      filename: 'doc.pdf',
      contentType: 'application/pdf',
      db,
    });
    await att.initialize();
    await att.save();

    const attachments = await msg.getAttachments();
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe('doc.pdf');
  });
});

// ============================================================================
// Message — send() / retrySend() orchestration
// ============================================================================

describe('Message.send orchestration', () => {
  it('fails and marks status failed when no account is associated', async () => {
    const msg = new Message({ subject: 'Orphan', db });
    await msg.initialize();
    await msg.save();

    const result = await msg.send();
    expect(result.success).toBe(false);
    expect(result.error).toContain('No account associated');
    expect(msg.sendStatus).toBe('failed');
    expect(msg.sendError).toContain('No account associated');
  });

  it('marks status sent on a successful provider send', async () => {
    const account = new SlackAccount({
      name: 'WS',
      botUserId: 'U-BOT',
      isActive: true,
      db,
    });
    await account.initialize();
    account.setSettings({ botToken: 'xoxb-token' });
    await account.save();

    const sentAt = new Date();
    sendMock.mockResolvedValueOnce({
      success: true,
      messageId: 'slack-1',
      providerResponse: { ok: true },
      timestamp: sentAt,
    });

    const msg = new SlackMessage({
      body: 'hi',
      channelId: 'C1',
      accountId: account.id!,
      db,
    });
    await msg.initialize();
    await msg.save();

    const result = await msg.send();
    expect(result.success).toBe(true);
    expect(msg.sendStatus).toBe('sent');
    expect(msg.sentAt).toEqual(sentAt);
    expect(msg.sendError).toBe('');
  });

  it('marks status failed when the provider reports failure, then retrySend re-attempts', async () => {
    const account = new SlackAccount({
      name: 'WS',
      botUserId: 'U-BOT',
      isActive: true,
      db,
    });
    await account.initialize();
    account.setSettings({ botToken: 'xoxb-token' });
    await account.save();

    // First attempt fails at the provider level.
    sendMock.mockResolvedValueOnce({
      success: false,
      messageId: undefined,
      providerResponse: {},
      timestamp: new Date(),
    });

    const msg = new SlackMessage({
      body: 'hi',
      channelId: 'C1',
      accountId: account.id!,
      db,
    });
    await msg.initialize();
    await msg.save();

    const first = await msg.send();
    expect(first.success).toBe(false);
    expect(msg.sendStatus).toBe('failed');

    // Second attempt (retrySend) succeeds; retryCount increments.
    const sentAt = new Date();
    sendMock.mockResolvedValueOnce({
      success: true,
      messageId: 'slack-2',
      providerResponse: { ok: true },
      timestamp: sentAt,
    });

    const retried = await msg.retrySend();
    expect(retried.success).toBe(true);
    expect(msg.retryCount).toBe(1);
    expect(msg.sendStatus).toBe('sent');
  });

  it('does not re-send a message that is already sent (entry guard)', async () => {
    const account = new SlackAccount({
      name: 'WS',
      botUserId: 'U-BOT',
      isActive: true,
      db,
    });
    await account.initialize();
    account.setSettings({ botToken: 'xoxb-token' });
    await account.save();

    sendMock.mockResolvedValueOnce({
      success: true,
      messageId: 'slack-1',
      providerResponse: { ok: true },
      timestamp: new Date(),
    });

    const msg = new SlackMessage({
      body: 'hi',
      channelId: 'C1',
      accountId: account.id!,
      db,
    });
    await msg.initialize();
    await msg.save();

    const first = await msg.send();
    expect(first.success).toBe(true);
    expect(sendMock).toHaveBeenCalledTimes(1);

    // A second send on the already-'sent' instance must be rejected without
    // touching the provider.
    const second = await msg.send();
    expect(second.success).toBe(false);
    expect(second.error).toContain('already');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent send() on two instances of the same row delivers exactly once', async () => {
    const account = new SlackAccount({
      name: 'WS',
      botUserId: 'U-BOT',
      isActive: true,
      db,
    });
    await account.initialize();
    account.setSettings({ botToken: 'xoxb-token' });
    await account.save();

    // The provider send blocks until released, so both senders are in flight
    // simultaneously — only the one that won the compare-and-set claim should
    // reach the provider.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    sendMock.mockImplementation(async () => {
      await gate;
      return {
        success: true,
        messageId: 'slack-1',
        providerResponse: { ok: true },
        timestamp: new Date(),
      };
    });

    const seed = new SlackMessage({
      body: 'hi',
      channelId: 'C1',
      accountId: account.id!,
      db,
    });
    await seed.initialize();
    await seed.save();

    // Two independently hydrated instances pointing at the same row.
    const messages = await (MessageCollection as any).create({ db });
    const a = await messages.get({ id: seed.id });
    const b = await messages.get({ id: seed.id });

    const pending = Promise.all([a.send(), b.send()]);
    release();
    const [ra, rb] = await pending;

    const successes = [ra, rb].filter((r) => r.success);
    expect(successes).toHaveLength(1);
    // Exactly one delivery reached the provider.
    expect(sendMock).toHaveBeenCalledTimes(1);

    // The losing sender was told the message was already in flight.
    const loser = ra.success ? rb : ra;
    expect(loser.error).toContain('already');
  });
});
