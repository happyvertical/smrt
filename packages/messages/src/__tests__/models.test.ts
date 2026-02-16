/**
 * Unit tests for Message, Account, and Attachment model helper methods
 *
 * Tests helper/utility methods that don't require database persistence.
 */

import { describe, expect, it } from 'vitest';
import { Account } from '../models/Account';
import { Attachment } from '../models/Attachment';
import { Email } from '../models/Email';
import { Message } from '../models/Message';
import { SlackMessage } from '../models/SlackMessage';
import { Tweet } from '../models/Tweet';

describe('Message model helpers', () => {
  it('should parse toAddresses JSON', () => {
    const msg = new Message({
      toAddresses: JSON.stringify([
        { address: 'a@example.com', name: 'Alice' },
        { address: 'b@example.com' },
      ]),
    });

    const addrs = msg.getToAddresses();
    expect(addrs).toHaveLength(2);
    expect(addrs[0].address).toBe('a@example.com');
    expect(addrs[0].name).toBe('Alice');
    expect(addrs[1].address).toBe('b@example.com');
  });

  it('should return empty array for invalid toAddresses', () => {
    const msg = new Message({ toAddresses: 'not-json' });
    expect(msg.getToAddresses()).toEqual([]);
  });

  it('should set toAddresses from array', () => {
    const msg = new Message();
    msg.setToAddresses([{ address: 'a@example.com' }]);
    expect(msg.getToAddresses()).toEqual([{ address: 'a@example.com' }]);
  });

  it('should parse metadata JSON', () => {
    const msg = new Message({
      metadata: JSON.stringify({ custom: 'value', count: 42 }),
    });

    expect(msg.getMetadata()).toEqual({ custom: 'value', count: 42 });
  });

  it('should handle empty metadata', () => {
    const msg = new Message();
    expect(msg.getMetadata()).toEqual({});
  });

  it('should set metadata from object', () => {
    const msg = new Message();
    msg.setMetadata({ key: 'value' });
    expect(msg.getMetadata()).toEqual({ key: 'value' });
  });

  it('should check unread status', () => {
    const unread = new Message({ isRead: false });
    const read = new Message({ isRead: true });

    expect(unread.isUnread()).toBe(true);
    expect(read.isUnread()).toBe(false);
  });

  it('should generate preview', () => {
    const short = new Message({ body: 'Short' });
    expect(short.getPreview()).toBe('Short');

    const long = new Message({ body: 'A'.repeat(300) });
    const preview = long.getPreview(100);
    expect(preview.length).toBe(103); // 100 + "..."
    expect(preview.endsWith('...')).toBe(true);
  });
});

describe('Email model helpers', () => {
  it('should populate body from textBody', () => {
    const email = new Email({ textBody: 'Hello' });
    expect(email.body).toBe('Hello');
    expect(email.textBody).toBe('Hello');
  });

  it('should not override explicit body with textBody', () => {
    const email = new Email({ body: 'Explicit', textBody: 'TextBody' });
    expect(email.body).toBe('Explicit');
  });

  it('should parse CC addresses', () => {
    const email = new Email({
      ccAddresses: JSON.stringify([{ address: 'cc@example.com', name: 'CC' }]),
    });
    expect(email.getCcAddresses()).toEqual([
      { address: 'cc@example.com', name: 'CC' },
    ]);
  });

  it('should parse BCC addresses', () => {
    const email = new Email({
      bccAddresses: JSON.stringify([{ address: 'bcc@example.com' }]),
    });
    expect(email.getBccAddresses()).toEqual([{ address: 'bcc@example.com' }]);
  });

  it('should manage labels', () => {
    const email = new Email();
    email.setLabels(['inbox', 'important']);
    expect(email.getLabels()).toEqual(['inbox', 'important']);
  });

  it('should manage flags', () => {
    const email = new Email();
    email.setFlags(['\\Seen', '\\Flagged']);
    expect(email.getFlags()).toEqual(['\\Seen', '\\Flagged']);
  });

  it('should manage headers', () => {
    const email = new Email();
    email.setHeaders({ 'X-Custom': 'value', Received: ['hop1', 'hop2'] });
    const headers = email.getHeaders();
    expect(headers['X-Custom']).toBe('value');
    expect(headers.Received).toEqual(['hop1', 'hop2']);
  });

  it('should generate email-specific preview from textBody', () => {
    const email = new Email({ textBody: 'Plain text preview' });
    expect(email.getPreview()).toBe('Plain text preview');
  });

  it('should strip HTML for preview when no textBody', () => {
    const email = new Email({ htmlBody: '<p>HTML <b>content</b></p>' });
    expect(email.getPreview()).toBe('HTML content');
  });
});

describe('Tweet model helpers', () => {
  it('should parse media URLs', () => {
    const tweet = new Tweet({
      mediaUrls: JSON.stringify([
        'https://pic.twitter.com/1',
        'https://pic.twitter.com/2',
      ]),
    });
    expect(tweet.getMediaUrls()).toEqual([
      'https://pic.twitter.com/1',
      'https://pic.twitter.com/2',
    ]);
  });

  it('should parse hashtags', () => {
    const tweet = new Tweet({
      hashtags: JSON.stringify(['coding', 'typescript']),
    });
    expect(tweet.getHashtags()).toEqual(['coding', 'typescript']);
  });

  it('should parse mentions', () => {
    const tweet = new Tweet({
      mentions: JSON.stringify(['@alice', '@bob']),
    });
    expect(tweet.getMentions()).toEqual(['@alice', '@bob']);
  });

  it('should calculate engagement', () => {
    const tweet = new Tweet({
      retweetCount: 10,
      likeCount: 50,
      replyCount: 5,
    });
    expect(tweet.getEngagement()).toBe(65);
  });

  it('should handle empty JSON fields', () => {
    const tweet = new Tweet();
    expect(tweet.getMediaUrls()).toEqual([]);
    expect(tweet.getHashtags()).toEqual([]);
    expect(tweet.getMentions()).toEqual([]);
    expect(tweet.getEngagement()).toBe(0);
  });
});

describe('SlackMessage model helpers', () => {
  it('should parse reactions', () => {
    const slack = new SlackMessage({
      reactions: JSON.stringify([
        { name: 'thumbsup', count: 3, users: ['U1', 'U2', 'U3'] },
        { name: 'heart', count: 1 },
      ]),
    });

    const reactions = slack.getReactions();
    expect(reactions).toHaveLength(2);
    expect(reactions[0].name).toBe('thumbsup');
    expect(reactions[0].count).toBe(3);
  });

  it('should calculate total reactions', () => {
    const slack = new SlackMessage({
      reactions: JSON.stringify([
        { name: 'thumbsup', count: 3 },
        { name: 'heart', count: 2 },
      ]),
    });
    expect(slack.getTotalReactions()).toBe(5);
  });

  it('should detect thread messages', () => {
    const inThread = new SlackMessage({
      slackTs: '1234567890.123456',
      slackThreadTs: '1234567890.100000',
    });
    expect(inThread.isInThread()).toBe(true);

    const notInThread = new SlackMessage({
      slackTs: '1234567890.123456',
    });
    expect(notInThread.isInThread()).toBe(false);

    const threadParent = new SlackMessage({
      slackTs: '1234567890.123456',
      slackThreadTs: '1234567890.123456',
    });
    expect(threadParent.isInThread()).toBe(false);
  });

  it('should parse blocks', () => {
    const slack = new SlackMessage({
      blocks: JSON.stringify([
        { type: 'section', text: { type: 'mrkdwn', text: 'Hello' } },
      ]),
    });
    expect(slack.getBlocks()).toHaveLength(1);
    expect(slack.getBlocks()[0].type).toBe('section');
  });
});

describe('Account model helpers', () => {
  it('should parse settings', () => {
    const account = new Account({
      settings: JSON.stringify({ host: 'example.com', port: 993 }),
    });
    expect(account.getSettings()).toEqual({ host: 'example.com', port: 993 });
  });

  it('should set settings', () => {
    const account = new Account();
    account.setSettings({ host: 'new.com' });
    expect(account.getSettings()).toEqual({ host: 'new.com' });
  });

  it('should handle invalid settings JSON', () => {
    const account = new Account({ settings: 'bad-json' });
    expect(account.getSettings()).toEqual({});
  });
});

describe('Attachment model helpers', () => {
  it('should detect image content type', () => {
    expect(new Attachment({ contentType: 'image/png' }).isImage()).toBe(true);
    expect(new Attachment({ contentType: 'image/jpeg' }).isImage()).toBe(true);
    expect(new Attachment({ contentType: 'application/pdf' }).isImage()).toBe(
      false,
    );
  });

  it('should detect PDF content type', () => {
    expect(new Attachment({ contentType: 'application/pdf' }).isPdf()).toBe(
      true,
    );
    expect(new Attachment({ contentType: 'image/png' }).isPdf()).toBe(false);
  });

  it('should detect inline attachments', () => {
    expect(new Attachment({ contentDisposition: 'inline' }).isInline()).toBe(
      true,
    );
    expect(
      new Attachment({ contentDisposition: 'attachment' }).isInline(),
    ).toBe(false);
  });

  it('should extract file extension', () => {
    expect(new Attachment({ filename: 'photo.jpg' }).getExtension()).toBe(
      'jpg',
    );
    expect(new Attachment({ filename: 'document.PDF' }).getExtension()).toBe(
      'pdf',
    );
    expect(new Attachment({ filename: 'archive.tar.gz' }).getExtension()).toBe(
      'gz',
    );
    expect(new Attachment({ filename: 'noext' }).getExtension()).toBe('');
    expect(new Attachment({ filename: '' }).getExtension()).toBe('');
  });

  it('should format file size', () => {
    expect(new Attachment({ size: 500 }).getFormattedSize()).toBe('500.0 B');
    expect(new Attachment({ size: 1024 }).getFormattedSize()).toBe('1.0 KB');
    expect(new Attachment({ size: 1536 }).getFormattedSize()).toBe('1.5 KB');
    expect(new Attachment({ size: 1048576 }).getFormattedSize()).toBe('1.0 MB');
  });

  it('should check external file', () => {
    expect(
      new Attachment({ filePath: '/path/to/file' }).hasExternalFile(),
    ).toBe(true);
    expect(new Attachment({ filePath: '' }).hasExternalFile()).toBe(false);
    expect(new Attachment().hasExternalFile()).toBe(false);
  });
});
