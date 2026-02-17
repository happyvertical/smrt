/**
 * Tests for message sending lifecycle, status transitions, reply/forward
 */

import { describe, expect, it } from 'vitest';
import { Account } from '../models/Account';
import { Email } from '../models/Email';
import { Message } from '../models/Message';
import type { SendStatus } from '../types';

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
    expect(forward.hasAttachments).toBe(true);
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
    expect(forward.hasAttachments).toBe(true);
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
