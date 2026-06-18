/**
 * Extended sender tests — exercises the send() paths of EmailSender,
 * SlackSender, and TweetSender.
 *
 * Mocking policy: only the EXTERNAL transport is mocked.
 *  - EmailSender takes an injected EmailClient — we pass a fake client.
 *  - SlackSender / TweetSender dynamically import getMessageClient() from the
 *    SDK package '@happyvertical/messages'; that single external boundary is
 *    mocked with vi.mock. Accounts/messages are real model instances.
 *
 * Account credentials are provided via `settings` (no secret store): Account
 * .getCredentials() falls back to getSettings() when credentialSecretId is null.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Mock the SDK transport used by SlackSender / TweetSender ────────────────
const sendMock = vi.fn();
const connectMock = vi.fn(async () => undefined);
const disconnectMock = vi.fn(async () => undefined);
const getMessageClientMock = vi.fn(async () => ({
  connect: connectMock,
  disconnect: disconnectMock,
  send: sendMock,
}));

vi.mock('@happyvertical/messages', () => ({
  getMessageClient: (...args: any[]) => getMessageClientMock(...args),
}));

import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { SlackAccount } from '../models/SlackAccount';
import { SlackMessage } from '../models/SlackMessage';
import { Tweet } from '../models/Tweet';
import { TwitterAccount } from '../models/TwitterAccount';
import { EmailSender } from '../senders/EmailSender';
import { SlackSender } from '../senders/SlackSender';
import { TweetSender } from '../senders/TweetSender';

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// EmailSender.send (injected client)
// ============================================================================

describe('EmailSender.send', () => {
  function makeClient(overrides: Record<string, any> = {}) {
    return {
      isConnected: () => true,
      send: vi.fn(async () => ({
        messageId: 'provider-msg-1',
        accepted: ['to@example.com'],
        rejected: [],
        response: '250 OK',
      })),
      ...overrides,
    } as any;
  }

  it('sends a message and maps the success result', async () => {
    const client = makeClient();
    const account = new EmailAccount({
      name: 'Sender Name',
      email: 'sender@example.com',
    });
    const sender = new EmailSender(client, account);

    const email = new Email({
      subject: 'Hi',
      textBody: 'Body text',
      htmlBody: '<p>Body text</p>',
      toAddresses: JSON.stringify([
        { address: 'to@example.com', name: 'Recipient' },
      ]),
    });

    const result = await sender.send(email);

    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBe('provider-msg-1');
    expect(result.accepted).toEqual(['to@example.com']);
    expect(result.providerResponse).toEqual({ response: '250 OK' });
    expect(result.sentAt).toBeInstanceOf(Date);

    // Verify the payload handed to the external client.
    const payload = client.send.mock.calls[0][0];
    expect(payload.from).toEqual({
      name: 'Sender Name',
      address: 'sender@example.com',
    });
    expect(payload.to).toEqual([
      { name: 'Recipient', address: 'to@example.com' },
    ]);
    expect(payload.subject).toBe('Hi');
    expect(payload.text).toBe('Body text');
    expect(payload.html).toBe('<p>Body text</p>');
  });

  it('falls back to account name/email when message lacks from fields', async () => {
    const client = makeClient();
    const account = new EmailAccount({
      name: 'Account Name',
      email: 'account@example.com',
    });
    const sender = new EmailSender(client, account);

    const email = new Email({
      subject: 'No From',
      textBody: 'x',
      toAddresses: JSON.stringify([{ address: 'to@example.com' }]),
    });
    await sender.send(email);

    const payload = client.send.mock.calls[0][0];
    expect(payload.from.name).toBe('Account Name');
    expect(payload.from.address).toBe('account@example.com');
  });

  it('includes cc and bcc only when present', async () => {
    const client = makeClient();
    const account = new EmailAccount({ email: 'a@b.com' });
    const sender = new EmailSender(client, account);

    const withCc = new Email({
      subject: 's',
      textBody: 'x',
      toAddresses: JSON.stringify([{ address: 'to@example.com' }]),
      ccAddresses: JSON.stringify([{ address: 'cc@example.com', name: 'CC' }]),
      bccAddresses: JSON.stringify([{ address: 'bcc@example.com' }]),
    });
    await sender.send(withCc);
    const p1 = client.send.mock.calls[0][0];
    expect(p1.cc).toEqual([{ name: 'CC', address: 'cc@example.com' }]);
    expect(p1.bcc).toEqual([{ name: undefined, address: 'bcc@example.com' }]);

    client.send.mockClear();
    const noCc = new Email({
      subject: 's',
      textBody: 'x',
      toAddresses: JSON.stringify([{ address: 'to@example.com' }]),
    });
    await sender.send(noCc);
    const p2 = client.send.mock.calls[0][0];
    expect(p2.cc).toBeUndefined();
    expect(p2.bcc).toBeUndefined();
  });

  it('uses body when textBody is empty and passes inReplyTo', async () => {
    const client = makeClient();
    const account = new EmailAccount({ email: 'a@b.com' });
    const sender = new EmailSender(client, account);

    const email = new Email({
      subject: 's',
      body: 'plain body',
      inReplyTo: '<parent@example.com>',
      toAddresses: JSON.stringify([{ address: 'to@example.com' }]),
    });
    await sender.send(email);

    const payload = client.send.mock.calls[0][0];
    expect(payload.text).toBe('plain body');
    expect(payload.html).toBeUndefined();
    expect(payload.inReplyTo).toBe('<parent@example.com>');
  });

  it('returns a failure result when the client throws', async () => {
    const client = makeClient({
      send: vi.fn(async () => {
        throw new Error('SMTP down');
      }),
    });
    const account = new EmailAccount({ email: 'a@b.com' });
    const sender = new EmailSender(client, account);

    const email = new Email({
      subject: 's',
      textBody: 'x',
      toAddresses: JSON.stringify([{ address: 'to@example.com' }]),
    });
    const result = await sender.send(email);

    expect(result.success).toBe(false);
    expect(result.error).toBe('SMTP down');
    expect(result.sentAt).toBeInstanceOf(Date);
  });

  it('stringifies non-Error throwables', async () => {
    const client = makeClient({
      send: vi.fn(async () => {
        // biome-ignore lint/complexity/noUselessCatch: intentional non-Error throw
        throw 'string failure';
      }),
    });
    const account = new EmailAccount({ email: 'a@b.com' });
    const sender = new EmailSender(client, account);

    const email = new Email({
      subject: 's',
      textBody: 'x',
      toAddresses: JSON.stringify([{ address: 'to@example.com' }]),
    });
    const result = await sender.send(email);
    expect(result.success).toBe(false);
    expect(result.error).toBe('string failure');
  });
});

// ============================================================================
// SlackSender.send
// ============================================================================

describe('SlackSender.send', () => {
  it('returns failure when no botToken in credentials', async () => {
    const account = new SlackAccount({ name: 'WS', isActive: true });
    // settings double as credentials; no botToken present
    account.setSettings({ workspaceId: 'W1' });

    const sender = new SlackSender(account);
    const result = await sender.send(new SlackMessage({ body: 'hi' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No botToken');
    expect(getMessageClientMock).not.toHaveBeenCalled();
  });

  it('connects, sends, disconnects and maps a successful result', async () => {
    const account = new SlackAccount({
      name: 'WS',
      botUserId: 'U-BOT',
      isActive: true,
    });
    account.setSettings({ botToken: 'xoxb-token' });

    const ts = new Date();
    sendMock.mockResolvedValueOnce({
      success: true,
      messageId: 'slack-123',
      providerResponse: { ok: true },
      timestamp: ts,
    });

    const message = new SlackMessage({
      body: 'hello team',
      channelId: 'C100',
      slackThreadTs: '1700.0001',
    });

    const sender = new SlackSender(account);
    const result = await sender.send(message);

    expect(getMessageClientMock).toHaveBeenCalledWith({
      type: 'slack',
      botToken: 'xoxb-token',
    });
    expect(connectMock).toHaveBeenCalledOnce();
    expect(disconnectMock).toHaveBeenCalledOnce();

    const [payload, opts] = sendMock.mock.calls[0];
    expect(payload.from).toEqual({ id: 'U-BOT', name: 'WS' });
    expect(payload.channelId).toBe('C100');
    expect(payload.content).toBe('hello team');
    expect(opts).toEqual({ replyTo: '1700.0001' });

    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBe('slack-123');
    expect(result.providerResponse).toEqual({ ok: true });
    expect(result.sentAt).toBe(ts);
  });

  it('returns failure when the client send throws', async () => {
    const account = new SlackAccount({ name: 'WS', isActive: true });
    account.setSettings({ botToken: 'xoxb-token' });

    sendMock.mockRejectedValueOnce(new Error('slack api error'));

    const sender = new SlackSender(account);
    const result = await sender.send(
      new SlackMessage({ body: 'x', channelId: 'C1' }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('slack api error');
  });
});

// ============================================================================
// TweetSender.send
// ============================================================================

describe('TweetSender.send', () => {
  const fullCreds = {
    apiKey: 'k',
    apiSecret: 's',
    accessToken: 't',
    accessSecret: 'as',
  };

  it('returns failure when credentials are incomplete', async () => {
    const account = new TwitterAccount({ handle: '@me', isActive: true });
    account.setSettings({ apiKey: 'k' }); // missing the rest

    const sender = new TweetSender(account);
    const result = await sender.send(new Tweet({ body: 'gm' }));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing Twitter API credentials');
    expect(getMessageClientMock).not.toHaveBeenCalled();
  });

  it('sends a tweet and maps the result', async () => {
    const account = new TwitterAccount({
      handle: '@me',
      twitterUserId: 'U-1',
      isActive: true,
    });
    account.setSettings(fullCreds);

    const ts = new Date();
    sendMock.mockResolvedValueOnce({
      success: true,
      messageId: 'tweet-9',
      providerResponse: { id: 'tweet-9' },
      timestamp: ts,
    });

    const sender = new TweetSender(account);
    const result = await sender.send(new Tweet({ body: 'hello world' }));

    expect(getMessageClientMock).toHaveBeenCalledWith({
      type: 'twitter',
      ...fullCreds,
    });
    const [payload, opts] = sendMock.mock.calls[0];
    expect(payload.from).toEqual({ id: 'U-1', name: '@me' });
    expect(payload.content).toBe('hello world');
    // No reply -> options omitted
    expect(opts).toBeUndefined();

    expect(result.success).toBe(true);
    expect(result.providerMessageId).toBe('tweet-9');
    expect(result.sentAt).toBe(ts);
  });

  it('passes replyTo when the tweet is a reply', async () => {
    const account = new TwitterAccount({
      handle: '@me',
      twitterUserId: 'U-1',
      isActive: true,
    });
    account.setSettings(fullCreds);

    sendMock.mockResolvedValueOnce({
      success: true,
      messageId: 'tweet-reply',
      providerResponse: {},
      timestamp: new Date(),
    });

    const tweet = new Tweet({
      body: 'a reply',
      isReply: true,
      inReplyToMessageId: 'orig-tweet-id',
    });

    const sender = new TweetSender(account);
    await sender.send(tweet);

    const opts = sendMock.mock.calls[0][1];
    expect(opts).toEqual({ replyTo: 'orig-tweet-id' });
  });

  it('returns failure when the client send throws', async () => {
    const account = new TwitterAccount({
      handle: '@me',
      twitterUserId: 'U-1',
      isActive: true,
    });
    account.setSettings(fullCreds);

    sendMock.mockRejectedValueOnce(new Error('rate limited'));

    const sender = new TweetSender(account);
    const result = await sender.send(new Tweet({ body: 'x' }));

    expect(result.success).toBe(false);
    expect(result.error).toBe('rate limited');
  });
});
