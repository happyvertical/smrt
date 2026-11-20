/**
 * Tests for message sending lifecycle, status transitions, reply/forward
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmailCollection } from '../collections/EmailCollection';
import { MessageCollection } from '../collections/MessageCollection';
import { Account } from '../models/Account';
import { Email } from '../models/Email';
import { Message } from '../models/Message';
import type { SendStatus } from '../types';
import { prepareMessageParents } from './fk-fixtures.js';

// ============================================================================
// Message Send Fields
// ============================================================================

describe('Message send fields', () => {
  it('defaults to draft status', () => {
    const msg = new Message();
    expect(msg.sendStatus).toBe('draft');
    expect(msg.sentAt).toBeNull();
    expect(msg.sendError).toBe('');
    expect(msg.retryCount).toBe(0);
    expect(msg.maxRetries).toBe(3);
    expect(msg.scheduledSendAt).toBeNull();
    expect(msg.inReplyToMessageId).toBe('');
  });

  it('accepts send fields in constructor', () => {
    const msg = new Message({
      sendStatus: 'sent',
      sentAt: new Date('2025-01-01'),
      sendError: 'test error',
      retryCount: 2,
      maxRetries: 5,
      scheduledSendAt: new Date('2025-06-01'),
      inReplyToMessageId: 'msg-123',
    });

    expect(msg.sendStatus).toBe('sent');
    expect(msg.sentAt).toEqual(new Date('2025-01-01'));
    expect(msg.sendError).toBe('test error');
    expect(msg.retryCount).toBe(2);
    expect(msg.maxRetries).toBe(5);
    expect(msg.scheduledSendAt).toEqual(new Date('2025-06-01'));
    expect(msg.inReplyToMessageId).toBe('msg-123');
  });

  it('supports all send statuses', () => {
    const statuses: SendStatus[] = [
      'draft',
      'pending',
      'sending',
      'sent',
      'failed',
      'scheduled',
    ];

    for (const status of statuses) {
      const msg = new Message({ sendStatus: status });
      expect(msg.sendStatus).toBe(status);
    }
  });
});

// ============================================================================
// Message.retrySend validation
// ============================================================================

describe('Message.retrySend', () => {
  it('rejects retry when status is not failed', async () => {
    const msg = new Message({ sendStatus: 'sent' });
    const result = await msg.retrySend();
    expect(result.success).toBe(false);
    expect(result.error).toContain("status is 'sent'");
  });

  it('rejects retry when budget exhausted', async () => {
    const msg = new Message({
      sendStatus: 'failed',
      retryCount: 3,
      maxRetries: 3,
    });
    const result = await msg.retrySend();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Retry budget exhausted');
  });
});

// ============================================================================
// Message.createReply
// ============================================================================

describe('Message.createReply', () => {
  it('creates a reply with correct fields', () => {
    const original = new Message({
      id: 'msg-1',
      accountId: 'acct-1',
      threadId: 'thread-1',
      subject: 'Hello',
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      body: 'Hi there!',
      date: new Date('2025-01-15T10:00:00Z'),
    });

    const reply = original.createReply();

    expect(reply.accountId).toBe('acct-1');
    expect(reply.threadId).toBe('thread-1');
    expect(reply.subject).toBe('Re: Hello');
    expect(reply.sendStatus).toBe('draft');
    expect(reply.inReplyToMessageId).toBe('msg-1');
    // SmrtObject initializes id to null when not provided
    expect(reply.id).toBeNull();

    // To addresses should be original sender
    const to = reply.getToAddresses();
    expect(to).toHaveLength(1);
    expect(to[0].address).toBe('alice@example.com');
  });

  it('does not double-prefix Re:', () => {
    const original = new Message({ subject: 'Re: Hello' });
    const reply = original.createReply();
    expect(reply.subject).toBe('Re: Hello');
  });

  it('includes quoted body', () => {
    const original = new Message({
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      body: 'Line 1\nLine 2',
      date: new Date('2025-01-15'),
    });

    const reply = original.createReply();
    expect(reply.body).toContain('> Line 1');
    expect(reply.body).toContain('> Line 2');
    expect(reply.body).toContain('Alice');
  });
});

// ============================================================================
// Message.createForward
// ============================================================================

describe('Message.createForward', () => {
  it('creates a forward with correct fields', () => {
    const original = new Message({
      id: 'msg-1',
      accountId: 'acct-1',
      subject: 'Important',
      body: 'Content here',
      hasAttachments: true,
    });

    const forward = original.createForward();

    expect(forward.subject).toBe('Fwd: Important');
    expect(forward.sendStatus).toBe('draft');
    expect(forward.hasAttachments).toBe(false);
    expect(forward.threadId).toBe('');
    expect(forward.inReplyToMessageId).toBe('');
    expect(forward.getToAddresses()).toEqual([]);
  });

  it('does not double-prefix Fwd:', () => {
    const original = new Message({ subject: 'Fwd: Important' });
    const forward = original.createForward();
    expect(forward.subject).toBe('Fwd: Important');
  });
});

// ============================================================================
// Email.createReply (RFC 822 threading)
// ============================================================================

describe('Email.createReply', () => {
  it('sets RFC 822 inReplyTo from original messageId', () => {
    const original = new Email({
      id: 'email-1',
      messageId: '<abc@example.com>',
      accountId: 'acct-1',
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      subject: 'Test',
      body: 'Hello',
    });

    const reply = original.createReply();

    expect(reply).toBeInstanceOf(Email);
    expect(reply.inReplyTo).toBe('<abc@example.com>');
    expect(reply.isDraft).toBe(true);

    // References should include original messageId
    const headers = reply.getHeaders();
    expect(headers.references).toContain('<abc@example.com>');
  });

  it('replyAll includes CC addresses', () => {
    const original = new Email({
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      toAddresses: JSON.stringify([
        { address: 'bob@example.com', name: 'Bob' },
      ]),
      ccAddresses: JSON.stringify([
        { address: 'carol@example.com', name: 'Carol' },
      ]),
      subject: 'Group chat',
      body: 'Hi all',
    });

    const reply = original.createReply({ replyAll: true }) as Email;

    const cc = reply.getCcAddresses();
    const ccAddrs = cc.map((c: { address: string }) => c.address);
    expect(ccAddrs).toContain('bob@example.com');
    expect(ccAddrs).toContain('carol@example.com');
  });
});

// ============================================================================
// Email.createForward
// ============================================================================

describe('Email.createForward', () => {
  it('includes forwarded message header block', () => {
    const original = new Email({
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      toAddresses: JSON.stringify([
        { address: 'bob@example.com', name: 'Bob' },
      ]),
      subject: 'Important doc',
      body: 'Please see attached',
      date: new Date('2025-03-01'),
      hasAttachments: true,
    });

    const forward = original.createForward();

    expect(forward).toBeInstanceOf(Email);
    expect(forward.body).toContain('---------- Forwarded message ----------');
    expect(forward.body).toContain('Alice');
    expect(forward.body).toContain('Important doc');
    expect(forward.body).toContain('Please see attached');
    expect(forward.hasAttachments).toBe(false);
    expect(forward.isDraft).toBe(true);
  });
});

// ============================================================================
// Account.createSender
// ============================================================================

describe('Account.createSender', () => {
  it('throws not implemented for base Account', async () => {
    const account = new Account({ name: 'Test' });
    await expect(account.createSender()).rejects.toThrow('not implemented');
  });
});

// ============================================================================
// Reply/forward persistence — must not overwrite the original (regression)
//
// When the original is hydrated from the DB, `this.options` carries the row's
// id/slug/context/_skipLoad. A raw `{ ...this.options }` spread made the draft
// inherit the original's natural-key conflict columns (slug/context/_meta_type),
// so `reply.save()` upserted onto — and overwrote — the original row.
// ============================================================================

describe('reply/forward persistence (does not overwrite original)', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await prepareMessageParents(db, ['acct-1']);
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('saving a reply inserts a NEW row and leaves the original intact', async () => {
    const original = new Message({
      subject: 'Hello',
      body: 'Original body',
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      date: new Date('2025-01-15T10:00:00Z'),
      db,
    });
    await original.initialize();
    await original.save();
    const originalId = original.id;

    // Hydrate through the collection so `options` carries slug/context/_skipLoad,
    // reproducing the real reply-from-inbox flow.
    const messages = await (MessageCollection as any).create({ db });
    const hydrated = await messages.get({ id: originalId });
    expect(hydrated).toBeTruthy();

    const reply = hydrated.createReply();
    await reply.initialize();
    await reply.save();

    // The reply is a distinct row.
    expect(reply.id).not.toBe(originalId);

    // The original row still exists and is unchanged.
    const reloaded = await messages.get({ id: originalId });
    expect(reloaded).toBeTruthy();
    expect(reloaded.subject).toBe('Hello');
    expect(reloaded.body).toBe('Original body');

    // Both rows are present.
    const all = await messages.list({});
    expect(all.length).toBe(2);
  });

  it('saving a forward inserts a NEW row and leaves the original intact', async () => {
    const original = new Message({
      subject: 'Quarterly report',
      body: 'See attached',
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      db,
    });
    await original.initialize();
    await original.save();
    const originalId = original.id;

    const messages = await (MessageCollection as any).create({ db });
    const hydrated = await messages.get({ id: originalId });
    const forward = hydrated.createForward();
    await forward.initialize();
    await forward.save();

    expect(forward.id).not.toBe(originalId);

    const reloaded = await messages.get({ id: originalId });
    expect(reloaded).toBeTruthy();
    expect(reloaded.subject).toBe('Quarterly report');

    const all = await messages.list({});
    expect(all.length).toBe(2);
  });

  it('saving an Email reply inserts a NEW row and leaves the original intact', async () => {
    const original = new Email({
      subject: 'Project kickoff',
      textBody: 'Original email body',
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      messageId: '<abc@example.com>',
      date: new Date('2025-02-01T09:00:00Z'),
      db,
    });
    await original.initialize();
    await original.save();
    const originalId = original.id;

    const emails = await (EmailCollection as any).create({ db });
    const hydrated = await emails.get({ id: originalId });
    expect(hydrated).toBeInstanceOf(Email);

    const reply = hydrated.createReply();
    await reply.initialize();
    await reply.save();

    expect(reply.id).not.toBe(originalId);

    const reloaded = await emails.get({ id: originalId });
    expect(reloaded).toBeTruthy();
    expect(reloaded.subject).toBe('Project kickoff');
    expect(reloaded.textBody).toBe('Original email body');

    const all = await emails.list({});
    expect(all.length).toBe(2);
  });
});

// ============================================================================
// Reply/forward drafts never inherit the inbound message's content or identity
// ============================================================================

describe('reply and forward drafts reset inbound-only state', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await prepareMessageParents(db, ['acct-1']);
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function hydratedInbound(): Promise<Email> {
    const inbound = new Email({
      accountId: 'acct-1',
      subject: 'Quote request',
      body: 'plain original',
      textBody: 'plain original',
      htmlBody: '<p>third-party <b>html</b> secret</p>',
      fromAddress: 'alice@example.com',
      fromName: 'Alice',
      toAddresses: JSON.stringify([
        { address: 'me@example.com', name: 'Me' },
        { address: 'bob@example.com', name: 'Bob' },
      ]),
      ccAddresses: JSON.stringify([
        { address: 'carol@example.com', name: 'Carol' },
      ]),
      bccAddresses: JSON.stringify([
        { address: 'hidden@example.com', name: 'Hidden' },
      ]),
      messageId: '<orig-1@example.com>',
      providerMessageId: 'provider-orig-1',
      headers: JSON.stringify({ 'x-origin': 'inbound', references: '<r0@x>' }),
      rawMessage: 'RAW MIME',
      hasAttachments: true,
      size: 4242,
      sendStatus: 'sent',
      sentAt: new Date('2025-01-15T10:00:00Z'),
      date: new Date('2025-01-15T10:00:00Z'),
      db,
    });
    await inbound.initialize();
    await inbound.save();
    const emails = await (EmailCollection as any).create({ db });
    const hydrated = await emails.get({ id: inbound.id });
    expect(hydrated.htmlBody).toContain('secret');
    return hydrated as Email;
  }

  function expectClean(draft: Email, originalId: string) {
    expect(draft.htmlBody).toBe('');
    expect(draft.getBccAddresses()).toEqual([]);
    expect(draft.messageId).toBe('');
    expect(draft.providerMessageId).toBe('');
    expect(draft.rawMessage).toBe('');
    expect(draft.hasAttachments).toBe(false);
    expect(draft.size).toBe(0);
    expect(draft.sentAt).toBeNull();
    expect(draft.sendStatus).toBe('draft');
    expect(draft.isDraft).toBe(true);
    expect(draft.fromAddress).toBe('');
    expect(draft.id).not.toBe(originalId);
    expect(draft.getHeaders()['x-origin']).toBeUndefined();
    expect(draft.body).not.toContain('secret');
    expect(draft.accountId).toBe('acct-1');
  }

  it('reply: plain text only, no cc/bcc, threaded', async () => {
    const original = await hydratedInbound();
    const reply = original.createReply() as Email;
    expectClean(reply, original.id as string);
    expect(reply.getCcAddresses()).toEqual([]);
    expect(reply.getToAddresses().map((a) => a.address)).toEqual([
      'alice@example.com',
    ]);
    expect(reply.subject).toBe('Re: Quote request');
    expect(reply.inReplyTo).toBe('<orig-1@example.com>');
    expect(reply.inReplyToMessageId).toBe(original.id);
    expect(reply.getHeaders().references).toBe('<r0@x> <orig-1@example.com>');
    expect(reply.body).toContain('> plain original');
  });

  it('reply-all: cc is the other To/Cc recipients, still no bcc or html', async () => {
    const original = await hydratedInbound();
    const reply = original.createReply({ replyAll: true }) as Email;
    expectClean(reply, original.id as string);
    expect(
      reply
        .getCcAddresses()
        .map((a) => a.address)
        .sort(),
    ).toEqual(['bob@example.com', 'carol@example.com', 'me@example.com']);
  });

  it('forward: no html, recipients, bcc, ids, attachments or threading', async () => {
    const original = await hydratedInbound();
    const forward = original.createForward() as Email;
    expectClean(forward, original.id as string);
    expect(forward.getToAddresses()).toEqual([]);
    expect(forward.getCcAddresses()).toEqual([]);
    expect(forward.subject).toBe('Fwd: Quote request');
    expect(forward.inReplyTo).toBe('');
    expect(forward.inReplyToMessageId).toBe('');
    expect(forward.threadId).toBe('');
  });

  it('a saved and reloaded reply carries none of the inbound html or bcc', async () => {
    const original = await hydratedInbound();
    const reply = original.createReply() as Email;
    await reply.initialize();
    await reply.save();
    const emails = await (EmailCollection as any).create({ db });
    const stored = await emails.get({ id: reply.id });
    expect(stored.htmlBody).toBe('');
    expect(stored.bccAddresses === '' || stored.bccAddresses === '[]').toBe(
      true,
    );
    expect(stored.messageId).toBe('');
  });
});

describe('provider subclass reply/forward drafts keep their routing', () => {
  it('SlackMessage reply stays in channel and starts/continues the thread', async () => {
    const { SlackMessage } = await import('../models/SlackMessage');
    const top = new SlackMessage({
      channelId: 'C123',
      channelName: 'ops',
      slackTs: '1700000000.000100',
      fromAddress: 'u1',
      body: 'hello',
    });
    const r1 = top.createReply() as InstanceType<typeof SlackMessage>;
    expect(r1.channelId).toBe('C123');
    expect(r1.slackThreadTs).toBe('1700000000.000100');

    const inThread = new SlackMessage({
      channelId: 'C123',
      slackTs: '1700000000.000200',
      slackThreadTs: '1700000000.000100',
      reactions: '[{"name":"x","count":1}]',
      body: 'x',
    });
    const r2 = inThread.createReply() as InstanceType<typeof SlackMessage>;
    expect(r2.channelId).toBe('C123');
    expect(r2.slackThreadTs).toBe('1700000000.000100');
    expect(r2.slackTs).toBe('');
    expect(r2.reactions).toBe('');

    const fwd = inThread.createForward() as InstanceType<typeof SlackMessage>;
    expect(fwd.channelId).toBe('C123');
    expect(fwd.slackThreadTs).toBe('');
  });
});

describe('HTML-only inbound mail', () => {
  it('forward and reply quote a plain-text rendering, never the html', () => {
    const original = new Email({
      fromAddress: 'alice@example.com',
      subject: 'Html only',
      htmlBody: '<style>p{}</style><p>Hello <b>there</b> &amp; welcome</p>',
    });
    const forward = original.createForward() as Email;
    expect(forward.body).toContain('Hello there & welcome');
    expect(forward.htmlBody).toBe('');
    const reply = original.createReply() as Email;
    expect(reply.body).toContain('> Hello there & welcome');
    expect(reply.htmlBody).toBe('');
  });
});
